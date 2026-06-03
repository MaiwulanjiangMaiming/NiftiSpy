type Axis = 'axial' | 'coronal' | 'sagittal';

declare const COLORMAPS: Record<string, (t: number) => [number, number, number]>;

interface WebGPUVolumeState {
  texture: GPUTexture;
  bindGroup: GPUBindGroup;
  width: number;
  height: number;
  depth: number;
}

export class WebGPURenderer {
  private device: GPUDevice | null = null;
  private context: GPUCanvasContext | null = null;
  private format: GPUTextureFormat = 'rgba8unorm';
  private pipeline: GPURenderPipeline | null = null;
  private histogramPipeline: GPUComputePipeline | null = null;
  private volumeState: WebGPUVolumeState | null = null;
  private lutTexture: GPUTexture | null = null;
  private lutBindGroup: GPUBindGroup | null = null;
  private sampler: GPUSampler | null = null;
  private posBuffer: GPUBuffer | null = null;
  private texCoordBuffer: GPUBuffer | null = null;
  private ready = false;
  private histogramBuffer: GPUBuffer | null = null;
  private histogramReadBuffer: GPUBuffer | null = null;
  private histogramBindGroupLayout: GPUBindGroupLayout | null = null;
  private sliceUniformBuffer: GPUBuffer | null = null;
  private histUniformBuffer: GPUBuffer | null = null;

  private shaderCode = `
struct VertexOutput {
  @builtin(position) position: vec4f,
  @location(0) texCoord: vec2f,
};

@group(0) @binding(0) var volumeSampler: sampler;
@group(0) @binding(1) var volumeTexture: texture_3d<f32>;
@group(0) @binding(2) var lutTexture: texture_2d<f32>;

struct Uniforms {
  windowLevel: f32,
  windowWidth: f32,
  sliceIndex: f32,
  axis: i32,
  volumeSize: vec3u,
  flipX: u32,
  flipY: u32,
  _pad0: u32,
};

@group(0) @binding(3) var<uniform> uniforms: Uniforms;

@vertex
fn vertexMain(
  @location(0) pos: vec2f,
  @location(1) uv: vec2f,
) -> VertexOutput {
  var output: VertexOutput;
  output.position = vec4f(pos, 0.0, 1.0);
  var finalUv = uv;
  if (uniforms.flipX == 1u) { finalUv.x = 1.0 - finalUv.x; }
  if (uniforms.flipY == 1u) { finalUv.y = 1.0 - finalUv.y; }
  output.texCoord = finalUv;
  return output;
}

@fragment
fn fragmentMain(input: VertexOutput) -> @location(0) vec4f {
  var uvw: vec3f;
  let depth = select(select(f32(uniforms.volumeSize.z), f32(uniforms.volumeSize.y), uniforms.axis == 1), f32(uniforms.volumeSize.x), uniforms.axis == 2);
  let sliceNorm = uniforms.sliceIndex / depth;

  if (uniforms.axis == 0) {
    uvw = vec3f(input.texCoord.x, input.texCoord.y, sliceNorm);
  } else if (uniforms.axis == 1) {
    uvw = vec3f(input.texCoord.x, sliceNorm, input.texCoord.y);
  } else {
    uvw = vec3f(sliceNorm, input.texCoord.x, input.texCoord.y);
  }

  let rawValue = textureSample(volumeTexture, volumeSampler, uvw).r;
  let lo = uniforms.windowLevel - uniforms.windowWidth * 0.5;
  let t = clamp((rawValue - lo) / uniforms.windowWidth, 0.0, 1.0);
  let color = textureSample(lutTexture, volumeSampler, vec2f(t, 0.5));
  return color;
}
`;

  private histogramShaderCode = `
@group(0) @binding(0) var volumeTexture: texture_3d<f32>;
@group(0) @binding(1) var<storage, read_write> histogram: array<atomic<u32>, 256>;

struct HistUniforms {
  volumeSize: vec3u,
  windowLevel: f32,
  windowWidth: f32,
  _pad0: u32,
  _pad1: u32,
};

@group(0) @binding(2) var<uniform> uniforms: HistUniforms;

@compute @workgroup_size(64)
fn computeMain(@builtin(global_invocation_id) gid: vec3u) {
  if (gid.x >= uniforms.volumeSize.x || gid.y >= uniforms.volumeSize.y || gid.z >= uniforms.volumeSize.z) {
    return;
  }
  let val = textureLoad(volumeTexture, gid, 0).r;
  let lo = uniforms.windowLevel - uniforms.windowWidth * 0.5;
  let t = clamp((val - lo) / uniforms.windowWidth, 0.0, 1.0);
  let bin = min(u32(t * 255.0), 255u);
  atomicAdd(&histogram[bin], 1u);
}
`;

  static async isAvailable(): Promise<boolean> {
    if (typeof navigator === 'undefined') return false;
    if (!('gpu' in navigator)) return false;
    try {
      const adapter = await (navigator as any).gpu.requestAdapter();
      return !!adapter;
    } catch {
      return false;
    }
  }

  async init(canvas: HTMLCanvasElement): Promise<boolean> {
    try {
      if (!('gpu' in navigator)) return false;

      const adapter = await (navigator as any).gpu.requestAdapter();
      if (!adapter) return false;

      this.device = await adapter.requestDevice();
      if (!this.device) return false;

      this.context = canvas.getContext('webgpu') as GPUCanvasContext | null;
      if (!this.context) return false;

      this.format = (navigator as any).gpu.getPreferredCanvasFormat();
      this.context.configure({
        device: this.device,
        format: this.format,
        alphaMode: 'premultiplied',
      });

      this.sampler = this.device.createSampler({
        magFilter: 'linear',
        minFilter: 'linear',
        addressModeU: 'clamp-to-edge',
        addressModeV: 'clamp-to-edge',
        addressModeW: 'clamp-to-edge',
      });

      this.createBuffers();
      this.createPipelines();
      this.ready = true;
      return true;
    } catch {
      return false;
    }
  }

  private createBuffers(): void {
    if (!this.device) return;

    const positions = new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]);
    this.posBuffer = this.device.createBuffer({
      size: positions.byteLength,
      usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
    });
    this.device.queue.writeBuffer(this.posBuffer, 0, positions);

    const texCoords = new Float32Array([0, 1, 1, 1, 0, 0, 1, 0]);
    this.texCoordBuffer = this.device.createBuffer({
      size: texCoords.byteLength,
      usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
    });
    this.device.queue.writeBuffer(this.texCoordBuffer, 0, texCoords);
  }

  private createPipelines(): void {
    if (!this.device) return;

    const shaderModule = this.device.createShaderModule({ code: this.shaderCode });

    const bindGroupLayout = this.device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: GPUShaderStage.FRAGMENT, sampler: {} },
        { binding: 1, visibility: GPUShaderStage.FRAGMENT, texture: { viewDimension: '3d' } },
        { binding: 2, visibility: GPUShaderStage.FRAGMENT, texture: { viewDimension: '2d' } },
        { binding: 3, visibility: GPUShaderStage.FRAGMENT | GPUShaderStage.VERTEX, buffer: { type: 'uniform' } },
      ],
    });

    this.pipeline = this.device.createRenderPipeline({
      layout: this.device.createPipelineLayout({ bindGroupLayouts: [bindGroupLayout] }),
      vertex: {
        module: shaderModule,
        entryPoint: 'vertexMain',
        buffers: [
          { arrayStride: 8, attributes: [{ shaderLocation: 0, offset: 0, format: 'float32x2' as GPUVertexFormat }] },
          { arrayStride: 8, attributes: [{ shaderLocation: 1, offset: 0, format: 'float32x2' as GPUVertexFormat }] },
        ],
      },
      fragment: {
        module: shaderModule,
        entryPoint: 'fragmentMain',
        targets: [{ format: this.format }],
      },
      primitive: { topology: 'triangle-strip' },
    });

    const histShaderModule = this.device.createShaderModule({ code: this.histogramShaderCode });

    this.histogramBindGroupLayout = this.device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: GPUShaderStage.COMPUTE, texture: { viewDimension: '3d' } },
        { binding: 1, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } },
        { binding: 2, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'uniform' } },
      ],
    });

    this.histogramPipeline = this.device.createComputePipeline({
      layout: this.device.createPipelineLayout({ bindGroupLayouts: [this.histogramBindGroupLayout] }),
      compute: { module: histShaderModule, entryPoint: 'computeMain' },
    });

    this.histogramBuffer = this.device.createBuffer({
      size: 256 * 4,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC,
    });

    this.histogramReadBuffer = this.device.createBuffer({
      size: 256 * 4,
      usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST,
    });

    // Persistent uniform buffers — updated via writeBuffer each frame
    this.sliceUniformBuffer = this.device.createBuffer({
      size: 40, // 10 × u32 (matches Uniforms struct: 4 f32 + 3 u32 + 2 u32 + 1 u32 = 40 bytes)
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });

    this.histUniformBuffer = this.device.createBuffer({
      size: 32,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
  }

  isReady(): boolean {
    return this.ready;
  }

  uploadVolume3D(data: Float32Array, nx: number, ny: number, nz: number): boolean {
    if (!this.device || !this.pipeline) return false;

    this.volumeState?.texture.destroy();

    const texture = this.device.createTexture({
      size: { width: nx, height: ny, depthOrArrayLayers: nz },
      format: 'r32float',
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.STORAGE_BINDING,
      dimension: '3d',
    });

    this.device.queue.writeTexture(
      { texture },
      data as Float32Array<ArrayBuffer>,
      { bytesPerRow: nx * 4, rowsPerImage: ny },
      { width: nx, height: ny, depthOrArrayLayers: nz }
    );

    const lutView = this.lutTexture ? this.lutTexture.createView() : this.createDefaultLut();

    const bindGroup = this.device.createBindGroup({
      layout: (this.pipeline.getBindGroupLayout(0)),
      entries: [
        { binding: 0, resource: this.sampler! },
        { binding: 1, resource: texture.createView({ dimension: '3d' }) },
        { binding: 2, resource: lutView },
        { binding: 3, resource: { buffer: this.sliceUniformBuffer! } },
      ],
    });

    this.volumeState = { texture, bindGroup, width: nx, height: ny, depth: nz };
    return true;
  }

  private createDefaultLut(): GPUTextureView {
    if (!this.device) throw new Error('No device');
    const lutData = new Uint8Array(256 * 4);
    for (let i = 0; i < 256; i++) {
      lutData[i * 4] = i;
      lutData[i * 4 + 1] = i;
      lutData[i * 4 + 2] = i;
      lutData[i * 4 + 3] = 255;
    }
    const tex = this.device.createTexture({
      size: { width: 256, height: 1 },
      format: 'rgba8unorm',
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    });
    this.device.queue.writeTexture({ texture: tex }, lutData as Uint8Array<ArrayBuffer>, { bytesPerRow: 256 * 4 }, { width: 256, height: 1 });
    this.lutTexture = tex;
    return tex.createView();
  }

  uploadLut(lutData: Uint8Array): void {
    if (!this.device) return;
    this.lutTexture?.destroy();
    const tex = this.device.createTexture({
      size: { width: 256, height: 1 },
      format: 'rgba8unorm',
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUBufferUsage.COPY_DST,
    });
    this.device.queue.writeTexture({ texture: tex }, lutData as Uint8Array<ArrayBuffer>, { bytesPerRow: 256 * 4 }, { width: 256, height: 1 });
    this.lutTexture = tex;
  }

  renderSlice3D(
    axis: number,
    sliceIndex: number,
    nx: number, ny: number, nz: number,
    windowLevel: number,
    windowWidth: number,
    colormap: string,
    flipX: boolean,
    flipY: boolean
  ): boolean {
    if (!this.device || !this.context || !this.pipeline || !this.volumeState || !this.sliceUniformBuffer) return false;

    // Apply colormap LUT if changed
    if (colormap && colormap !== 'gray') {
      this.applyColormapLut(colormap);
    }

    const uniformData = new ArrayBuffer(40);
    const view = new DataView(uniformData);
    view.setFloat32(0, windowLevel, true);
    view.setFloat32(4, windowWidth, true);
    view.setFloat32(8, sliceIndex, true);
    view.setInt32(12, axis, true);
    view.setUint32(16, nx, true);
    view.setUint32(20, ny, true);
    view.setUint32(24, nz, true);
    view.setUint32(28, flipX ? 1 : 0, true);
    view.setUint32(32, flipY ? 1 : 0, true);
    view.setUint32(36, 0, true);

    this.device.queue.writeBuffer(this.sliceUniformBuffer, 0, uniformData);

    const commandEncoder = this.device.createCommandEncoder();
    const textureView = this.context.getCurrentTexture().createView();

    const renderPass = commandEncoder.beginRenderPass({
      colorAttachments: [{
        view: textureView,
        clearValue: { r: 0, g: 0, b: 0, a: 1 },
        loadOp: 'clear',
        storeOp: 'store',
      }],
    });

    renderPass.setPipeline(this.pipeline);
    renderPass.setBindGroup(0, this.volumeState.bindGroup);
    renderPass.setVertexBuffer(0, this.posBuffer!);
    renderPass.setVertexBuffer(1, this.texCoordBuffer!);
    renderPass.draw(4);
    renderPass.end();

    this.device.queue.submit([commandEncoder.finish()]);
    return true;
  }

  private currentColormapName: string = 'gray';

  private applyColormapLut(cmapName: string): void {
    if (cmapName === this.currentColormapName || !this.device) return;
    this.currentColormapName = cmapName;
    const cmapFn = (COLORMAPS as Record<string, (t: number) => [number, number, number]>)[cmapName];
    if (!cmapFn) return;
    this.updateLutFromCmapFn(cmapFn);
  }

  updateLutFromCmapFn(cmapFn: (t: number) => [number, number, number]): void {
    if (!this.device) return;
    const lutData = new Uint8Array(256 * 4);
    for (let i = 0; i < 256; i++) {
      const t = i / 255;
      const [r, g, b] = cmapFn(t);
      lutData[i * 4] = r;
      lutData[i * 4 + 1] = g;
      lutData[i * 4 + 2] = b;
      lutData[i * 4 + 3] = 255;
    }
    this.lutTexture?.destroy();
    const tex = this.device.createTexture({
      size: { width: 256, height: 1 },
      format: 'rgba8unorm',
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUBufferUsage.COPY_DST,
    });
    this.device.queue.writeTexture({ texture: tex }, lutData as Uint8Array<ArrayBuffer>, { bytesPerRow: 256 * 4 }, { width: 256, height: 1 });
    this.lutTexture = tex;
    // Rebuild bind group with new LUT
    if (this.volumeState && this.pipeline) {
      this.volumeState.bindGroup = this.device.createBindGroup({
        layout: this.pipeline.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: this.sampler! },
          { binding: 1, resource: this.volumeState.texture.createView({ dimension: '3d' }) },
          { binding: 2, resource: tex.createView() },
          { binding: 3, resource: { buffer: this.sliceUniformBuffer! } },
        ],
      });
    }
  }

  async computeHistogram(windowLevel: number, windowWidth: number): Promise<Uint32Array | null> {
    if (!this.device || !this.histogramPipeline || !this.volumeState || !this.histogramBuffer || !this.histogramReadBuffer || !this.histUniformBuffer) return null;

    const uniformData = new ArrayBuffer(32);
    const view = new DataView(uniformData);
    view.setUint32(0, this.volumeState.width, true);
    view.setUint32(4, this.volumeState.height, true);
    view.setUint32(8, this.volumeState.depth, true);
    view.setFloat32(12, windowLevel, true);
    view.setFloat32(16, windowWidth, true);
    view.setUint32(20, 0, true);
    view.setUint32(24, 0, true);

    this.device.queue.writeBuffer(this.histUniformBuffer, 0, uniformData);

    const bindGroup = this.device.createBindGroup({
      layout: this.histogramBindGroupLayout!,
      entries: [
        { binding: 0, resource: this.volumeState.texture.createView({ dimension: '3d' }) },
        { binding: 1, resource: { buffer: this.histogramBuffer } },
        { binding: 2, resource: { buffer: this.histUniformBuffer } },
      ],
    });

    this.device.queue.writeBuffer(this.histogramBuffer, 0, new Uint32Array(256));

    const commandEncoder = this.device.createCommandEncoder();
    const pass = commandEncoder.beginComputePass();
    pass.setPipeline(this.histogramPipeline!);
    pass.setBindGroup(0, bindGroup);
    const workgroupsX = Math.ceil(this.volumeState.width / 8);
    const workgroupsY = Math.ceil(this.volumeState.height / 8);
    const workgroupsZ = Math.ceil(this.volumeState.depth / 4);
    pass.dispatchWorkgroups(workgroupsX, workgroupsY, workgroupsZ);
    pass.end();

    commandEncoder.copyBufferToBuffer(this.histogramBuffer, 0, this.histogramReadBuffer, 0, 256 * 4);
    this.device.queue.submit([commandEncoder.finish()]);

    await this.histogramReadBuffer.mapAsync(GPUMapMode.READ);
    const result = new Uint32Array(this.histogramReadBuffer.getMappedRange().slice(0));
    this.histogramReadBuffer.unmap();

    return result;
  }

  clearVolume3D(): void {
    this.volumeState?.texture.destroy();
    this.volumeState = null;
  }

  destroy(): void {
    this.volumeState?.texture.destroy();
    this.lutTexture?.destroy();
    this.posBuffer?.destroy();
    this.texCoordBuffer?.destroy();
    this.histogramBuffer?.destroy();
    this.histogramReadBuffer?.destroy();
    this.sliceUniformBuffer?.destroy();
    this.histUniformBuffer?.destroy();
    this.device?.destroy();
    this.ready = false;
  }
}

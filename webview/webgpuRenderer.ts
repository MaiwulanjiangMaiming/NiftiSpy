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
  // `canvas` is the DISPLAY canvas; `gpuCanvas` is the private canvas that
  // owns the webgpu context. The webgpu context must NEVER be acquired on
  // the display canvas itself: context types are mutually exclusive per
  // canvas — once 'webgpu' is acquired, getContext('2d') returns null
  // forever, which would kill the canvas2d fallback, compare mode, the
  // prefetch blit and the WebGL renderer's blit path. Frames are rendered
  // into `gpuCanvas` and blitted onto the display canvas' 2D context.
  private canvas: HTMLCanvasElement | null = null;
  private gpuCanvas: HTMLCanvasElement | null = null;
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
  slope: f32,
  inter: f32,
  dataMin: f32,
  dataRange: f32,
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
  // windowLevel/windowWidth arrive in NORMALIZED [0,1] space (same
  // convention as the WebGL/CPU painters): apply slope/inter, normalize by
  // the volume range, then window. Windowing raw voxel values against the
  // [0,1] range saturated every nonzero voxel to white.
  let scaledValue = rawValue * uniforms.slope + uniforms.inter;
  let norm = (scaledValue - uniforms.dataMin) / max(uniforms.dataRange, 1e-6);
  let lo = uniforms.windowLevel - uniforms.windowWidth * 0.5;
  let t = clamp((norm - lo) / uniforms.windowWidth, 0.0, 1.0);
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

  async init(displayCanvas: HTMLCanvasElement): Promise<boolean> {
    try {
      if (!('gpu' in navigator)) return false;

      const adapter = await (navigator as any).gpu.requestAdapter();
      if (!adapter) return false;

      this.device = await adapter.requestDevice();
      if (!this.device) return false;

      const gpuCanvas = document.createElement('canvas');
      const context = gpuCanvas.getContext('webgpu') as GPUCanvasContext | null;
      if (!context) return false;

      this.canvas = displayCanvas;
      this.gpuCanvas = gpuCanvas;
      this.context = context;

      this.format = (navigator as any).gpu.getPreferredCanvasFormat();
      this.context.configure({
        device: this.device,
        format: this.format,
        alphaMode: 'premultiplied',
      });

      // Mark the renderer dead on device loss; the next
      // getOrCreateWebGPURenderer() builds a fresh one and re-uploads the
      // 3D volume texture.
      this.device.lost.then((info: GPUDeviceLostInfo) => {
        if (!this.ready) return;
        console.warn('[NiftiSpy] WebGPU device lost:', info.reason || info.message);
        this.destroy();
      });

      // r32float volumes can only be LINEAR-sampled when the adapter
      // exposes the optional 'float32-filterable' feature; without it a
      // linear sampler is a validation error and the draw silently fails.
      const filterable = adapter.features?.has?.('float32-filterable') ?? false;
      this.sampler = this.device.createSampler({
        magFilter: filterable ? 'linear' : 'nearest',
        minFilter: filterable ? 'linear' : 'nearest',
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

    // Vertex order bl,br,tl,tr with texCoords (0,0),(1,0),(0,1),(1,1):
    // texture row 0 lands at the canvas BOTTOM, matching the CPU painter
    // and the WebGL paths (the old layout rendered a vertical flip).
    const texCoords = new Float32Array([0, 0, 1, 0, 0, 1, 1, 1]);
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
      // 16 u32 = 64 bytes: matches the Uniforms struct (4 f32 + vec3u + 2 u32
      // + 4 f32 slope/inter/dataMin/dataRange + pad), 16-byte aligned.
      size: 64,
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

  uploadVolume3D(data: Float32Array | Int16Array | Uint16Array | Int8Array | Uint8Array | Int32Array | Uint32Array, nx: number, ny: number, nz: number): boolean {
    if (!this.device || !this.pipeline) return false;

    // writeTexture requires bytesPerRow to be a multiple of 256. We upload
    // everything as r32float (see below), so rows are nx*4 bytes: only
    // volumes whose nx is a multiple of 64 qualify. Anything else fails
    // fast here — the caller falls back to the WebGL slice renderer.
    const bytesPerRow = nx * 4;
    if (bytesPerRow % 256 !== 0) return false;

    this.volumeState?.texture.destroy();

    // ALWAYS upload as r32float: the WGSL shader declares texture_3d<f32>
    // and samples via textureSample, which cannot read integer formats —
    // the old r16sint/r8sint uploads failed validation and drew nothing.
    // Integer volumes are converted here (slope/inter stay in the shader).
    let f32: Float32Array;
    if (data instanceof Float32Array) {
      f32 = data;
    } else {
      f32 = new Float32Array(data.length);
      for (let i = 0; i < data.length; i++) f32[i] = data[i];
    }

    const texture = this.device.createTexture({
      size: { width: nx, height: ny, depthOrArrayLayers: nz },
      format: 'r32float',
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
      dimension: '3d',
    });

    this.device.queue.writeTexture(
      { texture },
      f32 as ArrayBufferView,
      { bytesPerRow, rowsPerImage: ny },
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
    flipY: boolean,
    slope: number = 1,
    inter: number = 0,
    dataMin: number = 0,
    dataRange: number = 1
  ): boolean {
    if (!this.device || !this.context || !this.pipeline || !this.volumeState || !this.sliceUniformBuffer || !this.gpuCanvas || !this.canvas) return false;

    // Render into the private GPU canvas (sized to the display canvas, whose
    // pixel size is managed by paintSlice/paintSlice3D); the frame is blitted
    // onto the display canvas' 2D context at the end.
    if (this.gpuCanvas.width !== this.canvas.width) this.gpuCanvas.width = this.canvas.width;
    if (this.gpuCanvas.height !== this.canvas.height) this.gpuCanvas.height = this.canvas.height;

    // Apply colormap LUT if changed
    if (colormap && colormap !== 'gray') {
      this.applyColormapLut(colormap);
    }

    const uniformData = new ArrayBuffer(64);
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
    // Offsets follow WGSL uniform layout: vec3u sits at 16..28, so flipX
    // lands at 28 (align 4) and the trailing f32s run 36..52.
    view.setFloat32(36, slope, true);
    view.setFloat32(40, inter, true);
    view.setFloat32(44, dataMin, true);
    view.setFloat32(48, dataRange || 1, true);

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
    return this.blitToDisplay();
  }

  private blitToDisplay(): boolean {
    // Copy the GPU frame onto the display canvas' 2D context (1:1). Reset the
    // transform first: the 2D context is shared with other 2D painters which
    // save/restore transforms, and a leftover transform would skew the blit.
    const display = this.canvas;
    const gpuCanvas = this.gpuCanvas;
    if (!display || !gpuCanvas) return false;
    const ctx = display.getContext('2d');
    if (!ctx) return false;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.drawImage(gpuCanvas, 0, 0);
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

  hasVolume3D(): boolean {
    return !!this.volumeState;
  }

  clearVolume3D(): void {
    this.volumeState?.texture.destroy();
    this.volumeState = null;
  }

  destroy(): void {
    this.volumeState?.texture.destroy();
    this.volumeState = null;
    this.lutTexture?.destroy();
    this.lutTexture = null;
    this.posBuffer?.destroy();
    this.texCoordBuffer?.destroy();
    this.histogramBuffer?.destroy();
    this.histogramReadBuffer?.destroy();
    this.sliceUniformBuffer?.destroy();
    this.histUniformBuffer?.destroy();
    this.context?.unconfigure();
    this.device?.destroy();
    this.context = null;
    this.gpuCanvas = null;
    this.canvas = null;
    this.ready = false;
  }
}

import { computeChunkBands } from './chunkBands';

export type ColormapFn = (t: number) => [number, number, number];
export type TypedArray = Int8Array | Uint8Array | Int16Array | Uint16Array | Int32Array | Uint32Array | Float32Array | Float64Array;

/** Host state the renderer reads live (range changes with the loaded volume). */
export interface RendererDeps {
  getDataRange(): { min: number; max: number };
  colormaps: Record<string, ColormapFn>;
}

function ndcQuad(canvas: HTMLCanvasElement, dst?: { x: number; y: number; w: number; h: number }): Float32Array {
  const W = canvas.width || 1;
  const H = canvas.height || 1;
  const x0 = dst ? dst.x : 0;
  const y0 = dst ? dst.y : 0;
  const w = dst ? dst.w : W;
  const h = dst ? dst.h : H;
  const l = (x0 / W) * 2 - 1;
  const r = ((x0 + w) / W) * 2 - 1;
  const t = 1 - (y0 / H) * 2;
  const b = 1 - ((y0 + h) / H) * 2;
  // Vertex order matches the texCoord strip: (bl, br, tl, tr)
  return new Float32Array([l, b, r, b, l, t, r, t]);
}

export class WebGLRenderer {
  constructor(private readonly deps: RendererDeps) {}

  private gl: WebGL2RenderingContext | WebGLRenderingContext | null = null;
  private program: WebGLProgram | null = null;
  private program3D: WebGLProgram | null = null;
  // Integer-volume shader variants: WebGL2's format/type table forbids
  // uploading SHORT/BYTE client data into an R32F texture (INVALID_OPERATION,
  // silently ignored by the old DEBUG-only error check), so integer volumes
  // use sized integer internal formats (R16I/R16UI/...) which must be sampled
  // via isampler3D/usampler3D — one linked program per sampler type.
  private program3DInt: WebGLProgram | null = null;
  private program3DUint: WebGLProgram | null = null;
  private volume3DKind: 'float' | 'int' | 'uint' = 'float';
  private texture: WebGLTexture | null = null;
  private texture3D: WebGLTexture | null = null;
  private lutTexture: WebGLTexture | null = null;
  private colormapTexture: WebGLTexture | null = null;
  private posBuffer: WebGLBuffer | null = null;
  private texCoordBuffer: WebGLBuffer | null = null;
  private ready = false;
  private currentLut: string = '';
  private currentCmap3D: string = '';
  private supportsFloatTexture = false;
  private isWebGL2 = false;
  private floatLinear = false;
  private volume3DReady = false;
  private volume3DSize = 0;
  // Chunked 3D texture fields
  private texture3DChunks: WebGLTexture[] = [];
  private chunkZSize = 0;
  private chunkCount = 0;
  private chunkNx = 0;
  private chunkNy = 0;
  private chunkNz = 0;
  // Smooth slice transition
  private targetSliceIdx: Record<string, number> = { axial: 0, coronal: 0, sagittal: 0 };
  private animatingSliceIdx: Record<string, number> = { axial: 0, coronal: 0, sagittal: 0 };
  private animationFrameId: number | null = null;
  private static readonly SLICE_LERP_SPEED = 0.25;
  // Cached uniform locations for renderSlice3D
  private u3d_volume: WebGLUniformLocation | null = null;
  private u3d_colormap: WebGLUniformLocation | null = null;
  private u3d_windowLevel: WebGLUniformLocation | null = null;
  private u3d_windowWidth: WebGLUniformLocation | null = null;
  private u3d_sliceIndex: WebGLUniformLocation | null = null;
  private u3d_axis: WebGLUniformLocation | null = null;
  private u3d_volumeSize: WebGLUniformLocation | null = null;
  private u3d_flipX: WebGLUniformLocation | null = null;
  private u3d_flipY: WebGLUniformLocation | null = null;
  private u3d_slope: WebGLUniformLocation | null = null;
  private u3d_inter: WebGLUniformLocation | null = null;
  private u3d_dataMin: WebGLUniformLocation | null = null;
  private u3d_dataRange: WebGLUniformLocation | null = null;
  /** Chunk-local z mapping: zLocal = (globalZ - zStart) / chunkDepth. */
  private u3d_zStart: WebGLUniformLocation | null = null;
  private u3d_chunkDepth: WebGLUniformLocation | null = null;
  private u3d_programCached: WebGLProgram | null = null;
  // Cached LUT data buffer
  private cachedLutData: Uint8Array = new Uint8Array(256 * 4);

  private vertexShaderSource = `#version 100
attribute vec2 a_position;
attribute vec2 a_texCoord;
varying vec2 v_texCoord;
void main() {
  gl_Position = vec4(a_position, 0.0, 1.0);
  v_texCoord = a_texCoord;
}`;

  private fragmentShaderSource = `#version 100
precision highp float;
varying vec2 v_texCoord;
uniform sampler2D u_image;
uniform sampler2D u_lut;
uniform float u_lo;
uniform float u_hi;
uniform float u_range;
void main() {
  float val = texture2D(u_image, v_texCoord).r;
  float t = clamp((val - u_lo) / u_range, 0.0, 1.0);
  vec4 color = texture2D(u_lut, vec2(t, 0.5));
  gl_FragColor = color;
}`;

  private vertexShaderSourceGL2 = `#version 300 es
in vec2 a_position;
in vec2 a_texCoord;
out vec2 v_texCoord;
void main() {
  gl_Position = vec4(a_position, 0.0, 1.0);
  v_texCoord = a_texCoord;
}`;

  private fragmentShaderSourceGL2 = `#version 300 es
precision highp float;
in vec2 v_texCoord;
uniform sampler2D u_image;
uniform sampler2D u_lut;
uniform float u_windowLevel;
uniform float u_windowWidth;
uniform float u_dataMin;
uniform float u_dataRange;
out vec4 fragColor;
void main() {
  float rawValue = texture(u_image, v_texCoord).r;
  // The 2D texture holds slope/inter-applied VOXEL values while
  // windowLevel/windowWidth arrive in normalized [0,1] space (same
  // convention as the CPU painter) — normalize before windowing or
  // every nonzero voxel saturates to white.
  float norm = (rawValue - u_dataMin) / max(u_dataRange, 1e-6);
  float lo = u_windowLevel - u_windowWidth * 0.5;
  float t = clamp((norm - lo) / u_windowWidth, 0.0, 1.0);
  vec4 color = texture(u_lut, vec2(t, 0.5));
  fragColor = color;
}`;

  private vertexShader3D = `#version 300 es
in vec2 a_position;
in vec2 a_texCoord;
out vec2 v_texCoord;
void main() {
  gl_Position = vec4(a_position, 0.0, 1.0);
  v_texCoord = a_texCoord;
}`;

  private fragmentShader3DSource(kind: 'float' | 'int' | 'uint'): string {
    // Integer internal formats (R16I/R16UI/...) are sampled through
    // isampler3D/usampler3D; texture() then returns ivec4/uvec4, so the .r
    // component must be cast to float explicitly.
    const samplerType = kind === 'int' ? 'isampler3D' : kind === 'uint' ? 'usampler3D' : 'sampler3D';
    const fetch = kind === 'float' ? 'texture(u_volume, uvw).r' : 'float(texture(u_volume, uvw).r)';
    return `#version 300 es
precision highp float;
precision highp ${samplerType};
in vec2 v_texCoord;
uniform ${samplerType} u_volume;
uniform sampler2D u_colormap;
uniform float u_windowLevel;
uniform float u_windowWidth;
uniform float u_sliceIndex;
uniform int u_axis;
uniform vec3 u_volumeSize;
uniform int u_flipX;
uniform int u_flipY;
uniform float u_slope;
uniform float u_inter;
uniform float u_dataMin;
uniform float u_dataRange;
uniform float u_zStart;
uniform float u_chunkDepth;
out vec4 fragColor;
void main() {
  float fx = (u_flipX == 1) ? 1.0 - v_texCoord.x : v_texCoord.x;
  float fy = (u_flipY == 1) ? 1.0 - v_texCoord.y : v_texCoord.y;
  // Chunked uploads split the volume along z. Map the global z coordinate
  // (axial slice index, or the screen-vertical axis for coronal/sagittal)
  // into the currently bound chunk's local [0,1] range.
  float globalZ = (u_axis == 0) ? u_sliceIndex : fy * u_volumeSize.z;
  float zLocal = clamp((globalZ - u_zStart) / max(u_chunkDepth, 1.0), 0.0, 1.0);
  vec3 uvw;
  if (u_axis == 0) {
    uvw = vec3(fx, fy, zLocal);
  } else if (u_axis == 1) {
    uvw = vec3(fx, u_sliceIndex / max(u_volumeSize.y, 1.0), zLocal);
  } else {
    uvw = vec3(u_sliceIndex / max(u_volumeSize.x, 1.0), fx, zLocal);
  }
  float rawValue = ${fetch};
  float scaledValue = rawValue * u_slope + u_inter;
  // windowLevel/windowWidth arrive in NORMALIZED [0,1] space (same convention
  // as the CPU painter: norm = (v - globalMin) / (globalMax - globalMin),
  // t = (norm - lo) / width). Windowing raw voxel values against that
  // [0,1] range saturated every nonzero voxel to white.
  float norm = (scaledValue - u_dataMin) / max(u_dataRange, 1e-6);
  float lo = u_windowLevel - u_windowWidth * 0.5;
  float t = clamp((norm - lo) / u_windowWidth, 0.0, 1.0);
  vec4 color = texture(u_colormap, vec2(t, 0.5));
  fragColor = color;
}`;
  }

  private glCanvas: HTMLCanvasElement | null = null;

  init(_canvas: HTMLCanvasElement): boolean {
    // Render into a PRIVATE GL canvas and blit into the display canvas'
    // 2D context (see renderSlice / renderSlice3D). The GL context must
    // NEVER be acquired on the display canvas itself:
    //  - context types are mutually exclusive per canvas: once 'webgl2' is
    //    acquired, canvas.getContext('2d') returns null forever, which would
    //    break the canvas2d fallback, compare mode and the prefetch blit;
    //  - the former transferControlToOffscreen() attempt irreversibly
    //    transferred ownership of the display canvas, after which setting
    //    canvas.width THREW - every render died mid-paint, leaving a blank
    //    canvas while header/slice info panels kept updating normally.
    const glCanvas = document.createElement('canvas');
    const gl2 = glCanvas.getContext('webgl2', { premultipliedAlpha: false, preserveDrawingBuffer: true });
    if (gl2) {
      this.glCanvas = glCanvas;
      this.gl = gl2;
      this.isWebGL2 = true;
      this.supportsFloatTexture = true;
      this.floatLinear = !!gl2.getExtension('OES_texture_float_linear');
      if (this.setupProgram()) {
        this.watchContextLoss();
        return true;
      }
      this.glCanvas = null;
      this.gl = null;
    }
    const gl1 = glCanvas.getContext('webgl', { premultipliedAlpha: false, preserveDrawingBuffer: true });
    if (gl1) {
      this.glCanvas = glCanvas;
      this.gl = gl1;
      this.isWebGL2 = false;
      this.floatLinear = false;
      this.supportsFloatTexture = !!gl1.getExtension('OES_texture_float');
      if (!this.supportsFloatTexture) {
        this.glCanvas = null;
        this.gl = null;
        return false;
      }
      if (this.setupProgram()) {
        this.watchContextLoss();
        return true;
      }
      this.glCanvas = null;
      this.gl = null;
    }
    return false;
  }

  private watchContextLoss(): void {
    const glCanvas = this.glCanvas;
    if (!glCanvas) return;
    glCanvas.addEventListener('webglcontextlost', (e: Event) => {
      e.preventDefault();
      console.warn('[NiftiSpy] WebGL context lost on private render canvas');
      this.destroy();
      // glRenderers entry is discarded via isReady() === false on the next
      // getOrCreateRenderer() call, which builds a fresh renderer and
      // re-uploads the 3D volume texture.
    });
  }

  private setupProgram(): boolean {
    const gl = this.gl!;
    const vsSource = this.isWebGL2 ? this.vertexShaderSourceGL2 : this.vertexShaderSource;
    const fsSource = this.isWebGL2 ? this.fragmentShaderSourceGL2 : this.fragmentShaderSource;
    const vs = this.compileShader(gl.VERTEX_SHADER, vsSource);
    const fs = this.compileShader(gl.FRAGMENT_SHADER, fsSource);
    if (!vs || !fs) return false;

    this.program = gl.createProgram()!;
    gl.attachShader(this.program, vs);
    gl.attachShader(this.program, fs);
    gl.linkProgram(this.program);
    if (!gl.getProgramParameter(this.program, gl.LINK_STATUS)) return false;

    this.texture = gl.createTexture();
    this.lutTexture = gl.createTexture();
    if (this.isWebGL2) {
      this.colormapTexture = gl.createTexture();
    }
    this.posBuffer = gl.createBuffer();
    this.texCoordBuffer = gl.createBuffer();

    gl.bindBuffer(gl.ARRAY_BUFFER, this.texCoordBuffer);
    // Initial fill only — renderSlice/renderSlice3D replace this before
    // every draw. Canonical layout: texcoord y=0 at the bottom vertices
    // (image row 0 at the canvas bottom, matching the CPU painter).
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([0, 0, 1, 0, 0, 1, 1, 1]), gl.STATIC_DRAW);

    this.ready = true;

    if (this.isWebGL2) {
      const vs3d = this.compileShader(gl.VERTEX_SHADER, this.vertexShader3D);
      const link3D = (kind: 'float' | 'int' | 'uint', existing: WebGLProgram | null): WebGLProgram | null => {
        if (!vs3d) return existing;
        const fs3d = this.compileShader(gl.FRAGMENT_SHADER, this.fragmentShader3DSource(kind));
        if (!fs3d) return existing;
        const prog = gl.createProgram()!;
        gl.attachShader(prog, vs3d);
        gl.attachShader(prog, fs3d);
        gl.linkProgram(prog);
        return gl.getProgramParameter(prog, gl.LINK_STATUS) ? prog : null;
      };
      this.program3D = link3D('float', this.program3D);
      this.program3DInt = link3D('int', this.program3DInt);
      this.program3DUint = link3D('uint', this.program3DUint);
    }

    return true;
  }

  private compileShader(type: number, source: string): WebGLShader | null {
    const gl = this.gl!;
    const shader = gl.createShader(type);
    if (!shader) return null;
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
      gl.deleteShader(shader);
      return null;
    }
    return shader;
  }

  renderSlice(canvas: HTMLCanvasElement, sliceData: Float32Array, w: number, h: number,
    lo: number, range: number, cmapName: string, flipX: boolean = false, flipY: boolean = false,
    dst?: { x: number; y: number; w: number; h: number }): boolean {
    if (!this.ready || !this.gl || !this.program || !this.supportsFloatTexture || !this.glCanvas) return false;
    const gl = this.gl;
    const { min: globalMin, max: globalMax } = this.deps.getDataRange();

    // The display canvas keeps its 2D context; GL renders into the private
    // canvas sized to match, then the result is blitted 1:1 (see below).
    if (this.glCanvas.width !== canvas.width) this.glCanvas.width = canvas.width;
    if (this.glCanvas.height !== canvas.height) this.glCanvas.height = canvas.height;
    gl.viewport(0, 0, canvas.width, canvas.height);

    gl.useProgram(this.program);

    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.texture);
    const filter = (this.isWebGL2 && !this.floatLinear) ? gl.NEAREST : gl.LINEAR;
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

    if (this.isWebGL2) {
      const gl2 = gl as WebGL2RenderingContext;
      try {
        gl2.texImage2D(gl2.TEXTURE_2D, 0, gl2.R32F, w, h, 0, gl2.RED, gl2.FLOAT, sliceData);
      } catch {
        return false;
      }
    } else {
      const normalized = new Float32Array(w * h);
      const dataRange = globalMax - globalMin || 1;
      for (let i = 0; i < w * h; i++) {
        normalized[i] = (sliceData[i] - globalMin) / dataRange;
      }
      try {
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.LUMINANCE, w, h, 0, gl.LUMINANCE, gl.FLOAT, normalized);
      } catch {
        return false;
      }
    }
    if (gl.getError() !== gl.NO_ERROR) return false;

    if (this.currentLut !== cmapName) {
      this.updateLUT(cmapName);
      this.currentLut = cmapName;
    }

    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.lutTexture);

    const uImage = gl.getUniformLocation(this.program, 'u_image');
    const uLut = gl.getUniformLocation(this.program, 'u_lut');

    gl.uniform1i(uImage, 0);
    gl.uniform1i(uLut, 1);

    if (this.isWebGL2) {
      const uWindowLevel = gl.getUniformLocation(this.program, 'u_windowLevel');
      const uWindowWidth = gl.getUniformLocation(this.program, 'u_windowWidth');
      const uDataMin = gl.getUniformLocation(this.program, 'u_dataMin');
      const uDataRange = gl.getUniformLocation(this.program, 'u_dataRange');
      gl.uniform1f(uWindowLevel, lo + range * 0.5);
      gl.uniform1f(uWindowWidth, range);
      // The R32F texture holds raw (slope/inter-applied) voxel values; W/L
      // is normalized — pass the volume range for the shader's normalize
      // step (mirrors renderSlice3D and the CPU painter).
      gl.uniform1f(uDataMin, globalMin);
      gl.uniform1f(uDataRange, (globalMax - globalMin) || 1);
    } else {
      const uLo = gl.getUniformLocation(this.program, 'u_lo');
      const uHi = gl.getUniformLocation(this.program, 'u_hi');
      const uRange = gl.getUniformLocation(this.program, 'u_range');
      gl.uniform1f(uLo, lo);
      gl.uniform1f(uHi, lo + range);
      gl.uniform1f(uRange, range);
    }

    const aPos = gl.getAttribLocation(this.program, 'a_position');
    const aTex = gl.getAttribLocation(this.program, 'a_texCoord');

    // Destination quad in NDC: the zoom/pan-aware image rectangle (device px)
    // the CPU painter uses, or the full canvas when no dst is given. The GL
    // canvas is cleared to opaque black first so the area outside the image
    // matches the CPU path's background fill.
    gl.clearColor(0, 0, 0, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
    const quad = ndcQuad(canvas, dst);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.posBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, quad, gl.DYNAMIC_DRAW);
    gl.enableVertexAttribArray(aPos);
    gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 0, 0);

    gl.bindBuffer(gl.ARRAY_BUFFER, this.texCoordBuffer);
    const tx0 = flipX ? 1 : 0, tx1 = flipX ? 0 : 1;
    // ty polarity is INVERTED vs a naive screen-space mapping: the CPU
    // painter's default (flipY=false) draws with a negative Y scale, putting
    // image row 0 at the canvas BOTTOM. ty0/ty1 = 0/1 anchors texcoord y=0
    // (row 0) at the bottom vertices, matching that; flipY=true mirrors it.
    // The previous (flipY ? 0 : 1) polarity rendered every 2D frame
    // vertically flipped relative to the CPU path.
    const ty0 = flipY ? 1 : 0, ty1 = flipY ? 0 : 1;
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([tx0, ty0, tx1, ty0, tx0, ty1, tx1, ty1]), gl.DYNAMIC_DRAW);
    gl.enableVertexAttribArray(aTex);
    gl.vertexAttribPointer(aTex, 2, gl.FLOAT, false, 0, 0);

    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    if (gl.getError() !== gl.NO_ERROR) return false;
    return this.blitToDisplay(canvas);
  }

  private blitToDisplay(canvas: HTMLCanvasElement): boolean {
    // Copy the GL result onto the display canvas' 2D context (1:1). Reset the
    // transform first: the 2D context is shared with other 2D painters which
    // save/restore transforms, and a leftover transform would skew the blit.
    const ctx = canvas.getContext('2d');
    if (!ctx) return false;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.drawImage(this.glCanvas!, 0, 0);
    return true;
  }

  // Map a JS TypedArray to a (internalFormat, clientType, samplerKind) triple.
  // WebGL2's format/type table is strict: R32F only accepts FLOAT client data.
  // The previous code uploaded integer arrays with glType=SHORT/BYTE into
  // R32F, which raises INVALID_OPERATION — the texture stayed incomplete and
  // every slice sampled as 0, painting a uniform wash. Integer volumes now
  // use matching sized integer formats sampled via isampler3D/usampler3D
  // (see fragmentShader3DSource).
  private mapVolumeFormat(data: TypedArray, gl2: WebGL2RenderingContext):
    { internalFormat: number; glType: number; kind: 'float' | 'int' | 'uint' } | null {
    if (data instanceof Uint8Array) return { internalFormat: gl2.R8UI, glType: gl2.UNSIGNED_BYTE, kind: 'uint' };
    if (data instanceof Int8Array) return { internalFormat: gl2.R8I, glType: gl2.BYTE, kind: 'int' };
    if (data instanceof Uint16Array) return { internalFormat: gl2.R16UI, glType: gl2.UNSIGNED_SHORT, kind: 'uint' };
    if (data instanceof Int16Array) return { internalFormat: gl2.R16I, glType: gl2.SHORT, kind: 'int' };
    if (data instanceof Uint32Array) return { internalFormat: gl2.R32UI, glType: gl2.UNSIGNED_INT, kind: 'uint' };
    if (data instanceof Int32Array) return { internalFormat: gl2.R32I, glType: gl2.INT, kind: 'int' };
    if (data instanceof Float32Array) return { internalFormat: gl2.R32F, glType: gl2.FLOAT, kind: 'float' };
    return null; // Unsupported type (e.g. Float64Array)
  }

  uploadVolume3D(data: TypedArray, nx: number, ny: number, nz: number): boolean {
    if (!this.isWebGL2 || !this.program3D) return false;
    const gl2 = this.gl as WebGL2RenderingContext;

    const max3DSize = gl2.getParameter(gl2.MAX_3D_TEXTURE_SIZE);
    if (nx > max3DSize || ny > max3DSize || nz > max3DSize) return false;

    const fmt = this.mapVolumeFormat(data, gl2);
    if (!fmt) return false;
    const { internalFormat, glType, kind } = fmt;
    const bytesPerVoxel = data.BYTES_PER_ELEMENT;
    // Integer textures cannot be LINEAR-filtered; keep LINEAR for float
    // volumes when the extension allows it.
    const filter = (kind === 'float' && this.floatLinear) ? gl2.LINEAR : gl2.NEAREST;

    const estimatedBytes = nx * ny * nz * bytesPerVoxel;
    const maxTextureSize = gl2.getParameter(gl2.MAX_TEXTURE_SIZE);
    const availableMB = (maxTextureSize * maxTextureSize * 4) / (1024 * 1024);
    if (estimatedBytes > availableMB * 1024 * 1024) return false;

    // Clean up any previous chunked textures
    this.deleteChunkedTextures();

    const CHUNK_THRESHOLD = 512 * 1024 * 1024; // 512MB
    const VOLUME_3D_MAX_BYTES = 1 * 1024 * 1024 * 1024; // 1GB

    if (estimatedBytes > VOLUME_3D_MAX_BYTES) {
      return false; // Too large even for chunked
    }

    if (estimatedBytes > CHUNK_THRESHOLD) {
      // Chunked upload for volumes between 512MB and 1GB
      return this.uploadVolume3DChunked(data, nx, ny, nz);
    }

    // Single texture upload for smaller volumes
    if (!this.texture3D) {
      this.texture3D = gl2.createTexture();
    }

    gl2.activeTexture(gl2.TEXTURE0);
    gl2.bindTexture(gl2.TEXTURE_3D, this.texture3D);
    gl2.texParameteri(gl2.TEXTURE_3D, gl2.TEXTURE_MIN_FILTER, filter);
    gl2.texParameteri(gl2.TEXTURE_3D, gl2.TEXTURE_MAG_FILTER, filter);
    gl2.texParameteri(gl2.TEXTURE_3D, gl2.TEXTURE_WRAP_S, gl2.CLAMP_TO_EDGE);
    gl2.texParameteri(gl2.TEXTURE_3D, gl2.TEXTURE_WRAP_T, gl2.CLAMP_TO_EDGE);
    gl2.texParameteri(gl2.TEXTURE_3D, gl2.TEXTURE_WRAP_R, gl2.CLAMP_TO_EDGE);

    // Odd row widths (e.g. int8 volumes with odd nx) must not be padded to
    // the default 4-byte row alignment, or rows shift and the image shears.
    gl2.pixelStorei(gl2.UNPACK_ALIGNMENT, 1);
    try {
      gl2.texImage3D(gl2.TEXTURE_3D, 0, internalFormat, nx, ny, nz, 0, gl2.RED, glType, data);
    } catch {
      gl2.deleteTexture(this.texture3D);
      this.texture3D = null;
      return false;
    }

    // Unconditional: a silent INVALID_OPERATION here leaves an incomplete
    // texture that samples as 0 — the "uniform wash" bug. (Previously
    // DEBUG-only, which is exactly why it went unnoticed.)
    if (gl2.getError() !== gl2.NO_ERROR) {
      gl2.deleteTexture(this.texture3D);
      this.texture3D = null;
      return false;
    }

    this.volume3DReady = true;
    this.volume3DSize = nx * ny * nz;
    this.volume3DKind = kind;
    this.chunkCount = 0;
    return true;
  }

  private uploadVolume3DChunked(data: TypedArray, nx: number, ny: number, nz: number): boolean {
    const gl2 = this.gl as WebGL2RenderingContext;
    const fmt = this.mapVolumeFormat(data, gl2);
    if (!fmt) return false;
    const { internalFormat, glType, kind } = fmt;
    // Determine chunk size: split along Z axis
    const sliceSize = nx * ny;
    const bytesPerVoxel = data.BYTES_PER_ELEMENT;
    const bytesPerSlice = sliceSize * bytesPerVoxel;
    const targetChunkBytes = 256 * 1024 * 1024; // 256MB per chunk
    const slicesPerChunk = Math.max(1, Math.floor(targetChunkBytes / bytesPerSlice));
    const numChunks = Math.ceil(nz / slicesPerChunk);

    this.texture3DChunks = [];
    this.chunkZSize = slicesPerChunk;
    this.chunkCount = numChunks;
    this.chunkNx = nx;
    this.chunkNy = ny;
    this.chunkNz = nz;

    // Integer textures cannot be LINEAR-filtered.
    const filter = (kind === 'float' && this.floatLinear) ? gl2.LINEAR : gl2.NEAREST;
    gl2.pixelStorei(gl2.UNPACK_ALIGNMENT, 1);

    for (let c = 0; c < numChunks; c++) {
      const zStart = c * slicesPerChunk;
      const zEnd = Math.min(zStart + slicesPerChunk, nz);
      const chunkDepth = zEnd - zStart;
      const chunkVoxels = sliceSize * chunkDepth;
      const chunkData = data.slice(zStart * sliceSize, zStart * sliceSize + chunkVoxels);

      const tex = gl2.createTexture()!;
      gl2.activeTexture(gl2.TEXTURE0);
      gl2.bindTexture(gl2.TEXTURE_3D, tex);
      gl2.texParameteri(gl2.TEXTURE_3D, gl2.TEXTURE_MIN_FILTER, filter);
      gl2.texParameteri(gl2.TEXTURE_3D, gl2.TEXTURE_MAG_FILTER, filter);
      gl2.texParameteri(gl2.TEXTURE_3D, gl2.TEXTURE_WRAP_S, gl2.CLAMP_TO_EDGE);
      gl2.texParameteri(gl2.TEXTURE_3D, gl2.TEXTURE_WRAP_T, gl2.CLAMP_TO_EDGE);
      gl2.texParameteri(gl2.TEXTURE_3D, gl2.TEXTURE_WRAP_R, gl2.CLAMP_TO_EDGE);

      try {
        gl2.texImage3D(gl2.TEXTURE_3D, 0, internalFormat, nx, ny, chunkDepth, 0, gl2.RED, glType, chunkData);
      } catch {
        // Clean up already created chunk textures
        for (const t of this.texture3DChunks) { gl2.deleteTexture(t); }
        this.texture3DChunks = [];
        this.chunkCount = 0;
        gl2.deleteTexture(tex);
        return false;
      }

      if (gl2.getError() !== gl2.NO_ERROR) {
        for (const t of this.texture3DChunks) { gl2.deleteTexture(t); }
        this.texture3DChunks = [];
        this.chunkCount = 0;
        gl2.deleteTexture(tex);
        return false;
      }

      this.texture3DChunks.push(tex);
    }

    this.volume3DReady = true;
    this.volume3DSize = nx * ny * nz;
    this.volume3DKind = kind;
    return true;
  }

  private deleteChunkedTextures(): void {
    if (this.texture3DChunks.length > 0 && this.gl) {
      for (const t of this.texture3DChunks) {
        this.gl!.deleteTexture(t);
      }
      this.texture3DChunks = [];
      this.chunkCount = 0;
    }
  }

  renderSlice3D(canvas: HTMLCanvasElement, axis: number, sliceIndex: number,
    nx: number, ny: number, nz: number, lo: number, range: number,
    cmapName: string, flipX: boolean = false, flipY: boolean = false,
    slope: number = 1, inter: number = 0,
    dst?: { x: number; y: number; w: number; h: number }): boolean {
    if (!this.volume3DReady || !this.program3D || !this.isWebGL2 || !this.glCanvas) return false;
    // Pick the program matching the uploaded volume's sampler type
    // (sampler3D / isampler3D / usampler3D — see mapVolumeFormat).
    const program = this.volume3DKind === 'int' ? this.program3DInt
      : this.volume3DKind === 'uint' ? this.program3DUint
        : this.program3D;
    if (!program) return false;
    const gl2 = this.gl as WebGL2RenderingContext;
    const { min: globalMin, max: globalMax } = this.deps.getDataRange();

    // GL renders into the private canvas (sized to the display canvas, whose
    // pixel size is managed by paintSlice/paintSlice3D); result is blitted
    // onto the display canvas' 2D context at the end.
    if (this.glCanvas.width !== canvas.width) this.glCanvas.width = canvas.width;
    if (this.glCanvas.height !== canvas.height) this.glCanvas.height = canvas.height;
    gl2.viewport(0, 0, canvas.width, canvas.height);

    gl2.useProgram(program);

    // Update colormap 1D LUT texture if changed (shared by every chunk).
    if (this.currentCmap3D !== cmapName) {
      this.createColormapTexture(cmapName);
      this.currentCmap3D = cmapName;
    }

    gl2.activeTexture(gl2.TEXTURE1);
    gl2.bindTexture(gl2.TEXTURE_2D, this.colormapTexture);

    // Cache uniform locations (program may change between calls)
    if (this.u3d_programCached !== program) {
      this.u3d_volume = gl2.getUniformLocation(program, 'u_volume');
      this.u3d_colormap = gl2.getUniformLocation(program, 'u_colormap');
      this.u3d_windowLevel = gl2.getUniformLocation(program, 'u_windowLevel');
      this.u3d_windowWidth = gl2.getUniformLocation(program, 'u_windowWidth');
      this.u3d_sliceIndex = gl2.getUniformLocation(program, 'u_sliceIndex');
      this.u3d_axis = gl2.getUniformLocation(program, 'u_axis');
      this.u3d_volumeSize = gl2.getUniformLocation(program, 'u_volumeSize');
      this.u3d_flipX = gl2.getUniformLocation(program, 'u_flipX');
      this.u3d_flipY = gl2.getUniformLocation(program, 'u_flipY');
      this.u3d_slope = gl2.getUniformLocation(program, 'u_slope');
      this.u3d_inter = gl2.getUniformLocation(program, 'u_inter');
      this.u3d_dataMin = gl2.getUniformLocation(program, 'u_dataMin');
      this.u3d_dataRange = gl2.getUniformLocation(program, 'u_dataRange');
      this.u3d_zStart = gl2.getUniformLocation(program, 'u_zStart');
      this.u3d_chunkDepth = gl2.getUniformLocation(program, 'u_chunkDepth');
      this.u3d_programCached = program;
    }
    gl2.uniform1i(this.u3d_volume, 0);
    gl2.uniform1i(this.u3d_colormap, 1);
    gl2.uniform1f(this.u3d_windowLevel, lo + range * 0.5);
    gl2.uniform1f(this.u3d_windowWidth, range);
    gl2.uniform1f(this.u3d_sliceIndex, sliceIndex);
    gl2.uniform1i(this.u3d_axis, axis);
    gl2.uniform3f(this.u3d_volumeSize, nx, ny, nz);
    gl2.uniform1i(this.u3d_flipX, flipX ? 1 : 0);
    gl2.uniform1i(this.u3d_flipY, flipY ? 1 : 0);
    gl2.uniform1f(this.u3d_slope, slope);
    gl2.uniform1f(this.u3d_inter, inter);
    // Data range for normalization: windowLevel/windowWidth are passed in
    // normalized [0,1] space, so raw voxel values must be normalized with
    // the volume's (slope/inter-applied) min/max before windowing — same
    // math as the CPU painter.
    gl2.uniform1f(this.u3d_dataMin, globalMin);
    gl2.uniform1f(this.u3d_dataRange, (globalMax - globalMin) || 1);

    const aPos = gl2.getAttribLocation(program, 'a_position');
    const aTex = gl2.getAttribLocation(program, 'a_texCoord');

    // Destination quad: zoom/pan-aware image rect (device px), like the CPU
    // painter; clear to opaque black so panned-out borders match its
    // background fill.
    gl2.clearColor(0, 0, 0, 1);
    gl2.clear(gl2.COLOR_BUFFER_BIT);
    const fullQuad = ndcQuad(canvas, dst);
    const base = dst ?? { x: 0, y: 0, w: canvas.width, h: canvas.height };

    const drawChunk = (
      texture: WebGLTexture,
      zStart: number,
      chunkDepth: number,
      quad: Float32Array,
      ty0: number,
      ty1: number,
    ): void => {
      gl2.activeTexture(gl2.TEXTURE0);
      gl2.bindTexture(gl2.TEXTURE_3D, texture);
      gl2.uniform1f(this.u3d_zStart, zStart);
      gl2.uniform1f(this.u3d_chunkDepth, chunkDepth);
      gl2.bindBuffer(gl2.ARRAY_BUFFER, this.posBuffer);
      gl2.bufferData(gl2.ARRAY_BUFFER, quad, gl2.DYNAMIC_DRAW);
      gl2.enableVertexAttribArray(aPos);
      gl2.vertexAttribPointer(aPos, 2, gl2.FLOAT, false, 0, 0);
      gl2.bindBuffer(gl2.ARRAY_BUFFER, this.texCoordBuffer);
      // Vertex order bl,br,tl,tr with y=0 at the BOTTOM vertex: texture row 0
      // lands at the canvas bottom, matching the CPU painter.
      gl2.bufferData(gl2.ARRAY_BUFFER, new Float32Array([0, ty0, 1, ty0, 0, ty1, 1, ty1]), gl2.DYNAMIC_DRAW);
      gl2.enableVertexAttribArray(aTex);
      gl2.vertexAttribPointer(aTex, 2, gl2.FLOAT, false, 0, 0);
      gl2.drawArrays(gl2.TRIANGLE_STRIP, 0, 4);
    };

    if (this.chunkCount <= 0) {
      if (!this.texture3D) return false;
      drawChunk(this.texture3D, 0, nz, fullQuad, 0, 1);
    } else if (axis === 0) {
      // Axial: one z plane — bind only the chunk that contains it.
      const chunkIdx = Math.min(Math.floor(sliceIndex / this.chunkZSize), this.chunkCount - 1);
      const texture = this.texture3DChunks[chunkIdx];
      if (!texture) return false;
      const zStart = chunkIdx * this.chunkZSize;
      drawChunk(texture, zStart, Math.min(this.chunkZSize, nz - zStart), fullQuad, 0, 1);
    } else {
      // Coronal/sagittal span the whole z range, so compose the slice from
      // every chunk: each chunk owns the horizontal band whose normalized
      // vertical coordinate falls inside that chunk's z interval.
      const bands = computeChunkBands(nz, this.chunkZSize, flipY);
      for (let c = 0; c < bands.length; c++) {
        const texture = this.texture3DChunks[c];
        if (!texture) return false;
        const band = bands[c];
        const bandY = base.y + base.h * (1 - band.ty1);
        const bandH = base.h * (band.ty1 - band.ty0);
        if (bandH <= 0) continue;
        drawChunk(texture, band.zStart, band.chunkDepth,
          ndcQuad(canvas, { x: base.x, y: bandY, w: base.w, h: bandH }), band.ty0, band.ty1);
      }
    }
    if (gl2.getError() !== gl2.NO_ERROR) return false;
    return this.blitToDisplay(canvas);
  }

  createColormapTexture(cmapName: string): void {
    if (!this.isWebGL2 || !this.gl) return;
    const gl2 = this.gl as WebGL2RenderingContext;
    const cmapFn = this.deps.colormaps[cmapName] || this.deps.colormaps.gray;
    const lutData = this.cachedLutData;
    for (let i = 0; i < 256; i++) {
      const t = i / 255;
      const [r, g, b] = cmapFn(t);
      lutData[i * 4] = r;
      lutData[i * 4 + 1] = g;
      lutData[i * 4 + 2] = b;
      lutData[i * 4 + 3] = 255;
    }
    if (!this.colormapTexture) {
      this.colormapTexture = gl2.createTexture();
    }
    gl2.activeTexture(gl2.TEXTURE1);
    gl2.bindTexture(gl2.TEXTURE_2D, this.colormapTexture);
    gl2.texParameteri(gl2.TEXTURE_2D, gl2.TEXTURE_MIN_FILTER, gl2.LINEAR);
    gl2.texParameteri(gl2.TEXTURE_2D, gl2.TEXTURE_MAG_FILTER, gl2.LINEAR);
    gl2.texParameteri(gl2.TEXTURE_2D, gl2.TEXTURE_WRAP_S, gl2.CLAMP_TO_EDGE);
    gl2.texParameteri(gl2.TEXTURE_2D, gl2.TEXTURE_WRAP_T, gl2.CLAMP_TO_EDGE);
    gl2.texImage2D(gl2.TEXTURE_2D, 0, gl2.RGBA, 256, 1, 0, gl2.RGBA, gl2.UNSIGNED_BYTE, lutData);
  }

  isVolume3DReady(): boolean { return this.volume3DReady; }

  clearVolume3D(): void {
    if (this.texture3D && this.gl) {
      this.gl.deleteTexture(this.texture3D);
      this.texture3D = null;
    }
    this.deleteChunkedTextures();
    this.volume3DReady = false;
    this.volume3DSize = 0;
    this.volume3DKind = 'float';
  }

  private updateLUT(cmapName: string): void {
    const gl = this.gl!;
    const cmapFn = this.deps.colormaps[cmapName] || this.deps.colormaps.gray;
    const lutData = this.cachedLutData;
    for (let i = 0; i < 256; i++) {
      const t = i / 255;
      const [r, g, b] = cmapFn(t);
      lutData[i * 4] = r;
      lutData[i * 4 + 1] = g;
      lutData[i * 4 + 2] = b;
      lutData[i * 4 + 3] = 255;
    }
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.lutTexture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 256, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, lutData);
  }

  isReady(): boolean {
    return this.ready;
  }

  destroy(): void {
    if (!this.gl) return;
    if (this.program) this.gl.deleteProgram(this.program);
    if (this.program3D) this.gl.deleteProgram(this.program3D);
    if (this.program3DInt) this.gl.deleteProgram(this.program3DInt);
    if (this.program3DUint) this.gl.deleteProgram(this.program3DUint);
    if (this.texture) this.gl.deleteTexture(this.texture);
    if (this.lutTexture) this.gl.deleteTexture(this.lutTexture);
    if (this.colormapTexture) this.gl.deleteTexture(this.colormapTexture);
    if (this.texture3D) this.gl.deleteTexture(this.texture3D);
    if (this.posBuffer) this.gl.deleteBuffer(this.posBuffer);
    if (this.texCoordBuffer) this.gl.deleteBuffer(this.texCoordBuffer);
    this.deleteChunkedTextures();
    this.stopSliceAnimation();
    this.ready = false;
    this.volume3DReady = false;
    this.gl = null;
    this.glCanvas = null;
  }

  // Smooth slice transition methods
  setTargetSlice(axis: string, targetIdx: number): void {
    this.targetSliceIdx[axis] = targetIdx;
    if (this.animatingSliceIdx[axis] === undefined) {
      this.animatingSliceIdx[axis] = targetIdx;
    }
    if (this.animationFrameId === null) {
      this.startSliceAnimation();
    }
  }

  getCurrentAnimatedSlice(axis: string): number {
    return this.animatingSliceIdx[axis] ?? this.targetSliceIdx[axis] ?? 0;
  }

  private startSliceAnimation(): void {
    const tick = () => {
      let allSettled = true;
      for (const axis of ['axial', 'coronal', 'sagittal']) {
        const target = this.targetSliceIdx[axis] ?? 0;
        const current = this.animatingSliceIdx[axis] ?? 0;
        if (Math.abs(target - current) > 0.01) {
          this.animatingSliceIdx[axis] = current + (target - current) * WebGLRenderer.SLICE_LERP_SPEED;
          allSettled = false;
        } else {
          this.animatingSliceIdx[axis] = target;
        }
      }
      if (!allSettled) {
        this.animationFrameId = requestAnimationFrame(tick);
      } else {
        this.animationFrameId = null;
      }
    };
    this.animationFrameId = requestAnimationFrame(tick);
  }

  private stopSliceAnimation(): void {
    if (this.animationFrameId !== null) {
      cancelAnimationFrame(this.animationFrameId);
      this.animationFrameId = null;
    }
  }
}


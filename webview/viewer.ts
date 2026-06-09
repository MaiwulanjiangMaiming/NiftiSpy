import { NiiHeader, DATATYPE_NAMES } from './nii-parser';
import { WebGPURenderer } from './webgpuRenderer';
import { VolumeRaycaster, TransferFunctionPoint, RayMarchingConfig } from './volumeRaycaster';
import { deriveFileHash } from './SliceCacheDB';
import { initWasmBindings, getWasmBindings } from './wasmBridge';

declare function acquireVsCodeApi(): any;
const vscode = acquireVsCodeApi();

interface VolumeImage {
  header: NiiHeader;
  data: Int8Array | Uint8Array | Int16Array | Uint16Array | Int32Array | Uint32Array | Float32Array | Float64Array | null;
  min: number;
  max: number;
  name: string;
  url: string;
  slope: number;
  inter: number;
  preview?: {
    axial: Float32Array;
    coronal: Float32Array;
    sagittal: Float32Array;
  };
  state: 'preview' | 'loading' | 'ready' | 'error';
  lastAccess: number;
  loadPromise?: Promise<void>;
}

type Axis = 'axial' | 'coronal' | 'sagittal';

interface SliceFrame {
  data: Float32Array;
  width: number;
  height: number;
  factor: number;
}

interface ViewerConfig {
  previewMode: 'binary' | 'json';
  renderBackend: 'auto' | 'webgl' | 'canvas';
  fullVolumePolicy: 'manual' | 'debounced' | 'eager';
  nativeAcceleration: 'off' | 'auto' | 'force';
}

interface PerformanceProfile {
  tier: 'high' | 'medium' | 'low';
  gpuAvailable: boolean;
  maxTextureSize: number;
  max3DTextureSize: number;
  cores: number;
  memoryMB: number;
}

type RenderBackend = 'webgpu' | 'webgl3d' | 'webgl2d' | 'canvas2d';

const images: VolumeImage[] = [];
let activeImageIdx = 0;
let compareMode = false;

let header: NiiHeader | null = null;
let volumeData: Int8Array | Uint8Array | Int16Array | Uint16Array | Int32Array | Uint32Array | Float32Array | Float64Array | null = null;
let sharedVolumeBuffer: SharedArrayBuffer | null = null;
let sabAvailable = false;

try { sabAvailable = typeof SharedArrayBuffer !== 'undefined'; } catch { sabAvailable = false; }

function verifySABSupport(): boolean {
  try {
    const testBuf = new SharedArrayBuffer(1024);
    // If we got here, SAB is available
    sabAvailable = true;
    return true;
  } catch (err: any) {
    console.warn('[NiftiSpy] SharedArrayBuffer not available:', err?.message || err);
    sabAvailable = false;
    return false;
  }
}

// Verify SAB support on load
verifySABSupport();

function createSharedVolumeBuffer(data: Float32Array): SharedArrayBuffer | null {
  if (!sabAvailable) return null;
  try {
    const sab = new SharedArrayBuffer(data.byteLength);
    const view = new Float32Array(sab);
    view.set(data);
    return sab;
  } catch {
    return null;
  }
}
let dataSlope = 1;
let dataInter = 0;
let globalMin = 0;
let globalMax = 1;
let initialWindowWidth = 1.0;
let initialWindowLevel = 0.5;

// Memory usage tracking
let totalVolumeBytes = 0;
let sharedBufferBytes = 0;
let workerCopyBytes = 0;

const sliceIdx = { axial: 0, coronal: 0, sagittal: 0 };
let windowWidth = 1.0;
let windowLevel = 0.5;
let pendingAddImageIdx = -1;
let overlayOpacity = 0.5;
let overlayColormap = 'hot';
type CompareLayout = 'overlay' | 'sideBySide';
let compareLayout: CompareLayout = 'overlay';
let colormap = 'gray';
let fileUrl = '';
let isGzip = false;
let fileName = '';
let crosshairVisible = true;
let isRemoteSource = false;
let fullVolumeLoaded = false;
let interactionInitialized = false;

// Measurement tools state
let measureMode = false;
type MeasureType = 'line' | 'roi';
interface LineMeasurement { type: 'line'; axis: Axis; x1: number; y1: number; x2: number; y2: number; distance: number; }
interface RoiMeasurement { type: 'roi'; axis: Axis; x1: number; y1: number; x2: number; y2: number; area: number; }
type Measurement = LineMeasurement | RoiMeasurement;
const measurements: Measurement[] = [];
let measureDragStart: { x: number; y: number; axis: Axis } | null = null;
let measureClickPending: { x: number; y: number; axis: Axis } | null = null;

// Accessibility state
let highContrastPreferred = false;
try { highContrastPreferred = window.matchMedia('(prefers-contrast: more)').matches; } catch {}
let focusedCanvas: Axis | null = null;

// LOD (Level of Detail) progressive loading
interface LODSliceData {
  data: Float32Array;
  w: number;
  h: number;
}
interface LODLevelData {
  axial: LODSliceData | null;
  coronal: LODSliceData | null;
  sagittal: LODSliceData | null;
}
const lodData: Record<number, LODLevelData> = {};
const currentLOD: Record<Axis, number> = { axial: 2, coronal: 2, sagittal: 2 };
let enableLOD = true;
let lodUpgradeTimer: number | null = null;
let lastScrollTime = 0;

const MAX_RESIDENT_IMAGE_DATA = 2;
const MAX_PARALLEL_VOLUME_LOADS = 1;
const ACTIVE_FULL_LOAD_DEBOUNCE_MS = 180;
let activeVolumeLoads = 0;
type VolumeLoadPriority = 'active' | 'background';
interface QueuedVolumeLoad {
  key: string;
  priority: VolumeLoadPriority;
  cancelled: boolean;
  run: () => void;
  reject: (reason?: any) => void;
}
const volumeLoadQueue: QueuedVolumeLoad[] = [];
let nextStreamRequestId = 2000;
const workerStreamHandlers = new Map<number, (msg: any) => void>();
let activeVolumeLoadKey: string | null = null;
const volumeWorkers = new Map<string, Worker>();
let activeLoadDebounceTimer: number | null = null;
let scheduledActiveIndex: number | null = null;

// Per-axis AbortController for cancelling stale slice requests
const sliceAbortControllers = new Map<Axis, AbortController>();

const currentSlices: Record<Axis, SliceFrame | null> = {
  axial: null,
  coronal: null,
  sagittal: null,
};

const viewFlips: Record<string, { flipX: boolean, flipY: boolean }> = {
  axial: { flipX: false, flipY: false },
  coronal: { flipX: false, flipY: false },
  sagittal: { flipX: false, flipY: false }
};

const perfMonitor = {
  previewLoads: [] as number[],
  fullLoads: [] as number[],
  failures: 0,
  evictions: 0,
};

// OffscreenCanvas support
const offscreenCanvasSupported = typeof OffscreenCanvas !== 'undefined' &&
  typeof HTMLCanvasElement !== 'undefined' &&
  !!(HTMLCanvasElement.prototype as any).transferControlToOffscreen;

const offscreenCanvasEnabled: Record<Axis, boolean> = { axial: false, coronal: false, sagittal: false };

function tryEnableOffscreenCanvas(axis: Axis): boolean {
  if (!offscreenCanvasSupported) return false;
  const canvas = canvases[axis];
  if (!canvas) return false;
  // Only enable for WebGL2 3D texture path (the most CPU-intensive)
  if (renderBackend !== 'webgl3d') return false;
  try {
    const offscreen = (canvas as any).transferControlToOffscreen() as OffscreenCanvas;
    const worker = sliceWorkers[AXIS_TO_WORKER_IDX[axis]];
    if (worker) {
      worker.postMessage({ type: 'initOffscreenCanvas', axis, canvas: offscreen }, [offscreen]);
      offscreenCanvasEnabled[axis] = true;
      return true;
    }
  } catch {
    // Graceful fallback: some browsers don't support transferControlToOffscreen
    offscreenCanvasEnabled[axis] = false;
  }
  return false;
}

// Render Request Queue
interface RenderRequest {
  axis: Axis;
  sliceIndex: number;
  windowLevel: number;
  windowWidth: number;
  colormap: string;
  flipX: boolean;
  flipY: boolean;
}

const pendingRenderRequests = new Map<Axis, RenderRequest>();

function enqueueRenderRequest(req: RenderRequest): void {
  pendingRenderRequests.set(req.axis, req);
  const worker = sliceWorkers[AXIS_TO_WORKER_IDX[req.axis]];
  if (worker && offscreenCanvasEnabled[req.axis]) {
    worker.postMessage({
      type: 'renderRequest',
      axis: req.axis,
      sliceIndex: req.sliceIndex,
      windowLevel: req.windowLevel,
      windowWidth: req.windowWidth,
      colormap: req.colormap,
      flipX: req.flipX,
      flipY: req.flipY,
    });
  }
}

// FPS Counter
const fpsCounter = {
  frames: [] as number[],
  lastTime: 0,

  recordFrame(): void {
    const now = performance.now();
    this.frames.push(now);
    // Remove entries older than 1 second
    const cutoff = now - 1000;
    while (this.frames.length > 0 && this.frames[0] < cutoff) {
      this.frames.shift();
    }
    this.lastTime = now;
  },

  getFPS(): number {
    return this.frames.length;
  },
};

const viewerConfig: ViewerConfig = {
  previewMode: 'binary',
  renderBackend: 'auto',
  fullVolumePolicy: 'debounced',
  nativeAcceleration: 'auto',
};

const previewRequestCache = new Map<string, Promise<any | null>>();
let thumbnailObserver: IntersectionObserver | null = null;

// Disk cache statistics (updated from worker responses)
const diskCacheStats = {
  cacheHits: 0,
  cacheMisses: 0,
  cacheSize: 0,
  cacheEntries: 0,
};

function requestDiskCacheStats(): void {
  if (slicePool) {
    slicePool.dispatch<any>({ type: 'getCacheStats' }).then((msg: any) => {
      if (msg && msg.type === 'cacheStats') {
        diskCacheStats.cacheHits = msg.cacheHits || 0;
        diskCacheStats.cacheMisses = msg.cacheMisses || 0;
        diskCacheStats.cacheSize = msg.cacheSize || 0;
        diskCacheStats.cacheEntries = msg.cacheEntries || 0;
      }
    }).catch(() => {});
  }
}

function publishPerfMonitor() {
  (window as any).__niftiPerf = {
    previewLoads: [...perfMonitor.previewLoads],
    fullLoads: [...perfMonitor.fullLoads],
    failures: perfMonitor.failures,
    evictions: perfMonitor.evictions,
    queuedLoads: volumeLoadQueue.length,
    activeLoads: activeVolumeLoads,
    residentImages: images.filter(img => !!img.data).length,
    activeVolumeLoadKey,
    scheduledActiveIndex,
    fps: fpsCounter.getFPS(),
    offscreenCanvas: { ...offscreenCanvasEnabled },
    memory: {
      totalVolumeBytes,
      sharedBufferBytes,
      workerCopyBytes,
      sabAvailable,
      savedBytes: workerCopyBytes > 0 ? workerCopyBytes - sharedBufferBytes : 0,
    },
    prefetch: prefetchStats.getStats(),
    diskCache: { ...diskCacheStats },
  };
  // Request fresh stats from workers for next publish
  requestDiskCacheStats();
}

function makeAbortError(): Error {
  const err = new Error('Load superseded by newer selection');
  err.name = 'AbortError';
  return err;
}

let nextWorkerRequestId = 1;
const workerRequests = new Map<number, { resolve: (value: any) => void; reject: (reason?: any) => void }>();
const sliceQualityTimers: Partial<Record<Axis, number>> = {};
let workerStreamListener: ((message: any) => void) | null = null;

const viewState = {
  axial: { zoom: 1, panX: 0, panY: 0 },
  coronal: { zoom: 1, panX: 0, panY: 0 },
  sagittal: { zoom: 1, panX: 0, panY: 0 },
  mip: { rotationX: 0, rotationY: 0 },
};

let maximizedView: string | null = null;
let sidebarCollapsed = false;
let sidebarWidth = 180;

const perfProfile = detectPerformance();
const sliceRenderCache = new Map<string, { canvas: HTMLCanvasElement; timestamp: number }>();
const MAX_SLICE_CACHE = perfProfile.tier === 'high' ? 64 : perfProfile.tier === 'medium' ? 32 : 16;
const PRELOAD_RANGE = perfProfile.tier === 'high' ? 5 : perfProfile.tier === 'medium' ? 3 : 1;

const glRenderers: Partial<Record<Axis | 'mip', WebGLRenderer>> = {};
const webgpuRenderers: Partial<Record<Axis, WebGPURenderer>> = {};
let webgpuAvailable = false;
let webgpuChecked = false;
let renderBackend: RenderBackend = 'canvas2d';

async function detectBestRenderBackend(): Promise<RenderBackend> {
  // 1. Try WebGPU: request adapter
  try {
    if (typeof navigator !== 'undefined' && navigator.gpu) {
      const adapter = await navigator.gpu.requestAdapter();
      if (adapter) return 'webgpu';
    }
  } catch { }

  // 2. Try WebGL2 3D texture
  try {
    const testCanvas = document.createElement('canvas');
    const gl2 = testCanvas.getContext('webgl2') as WebGL2RenderingContext | null;
    if (gl2) {
      const max3D = gl2.getParameter(gl2.MAX_3D_TEXTURE_SIZE) || 0;
      if (max3D >= 256) {
        return 'webgl3d';
      }
      // 3. WebGL2 available but no 3D texture
      return 'webgl2d';
    }
  } catch { }

  // 4. Fallback to Canvas 2D
  return 'canvas2d';
}

function applyRenderBackend(configValue: string): void {
  if (configValue === 'auto') {
    detectBestRenderBackend().then((backend) => {
      renderBackend = backend;
    });
  } else if (configValue === 'webgl') {
    // Manual override: pick best WebGL variant
    try {
      const testCanvas = document.createElement('canvas');
      const gl2 = testCanvas.getContext('webgl2') as WebGL2RenderingContext | null;
      if (gl2) {
        const max3D = gl2.getParameter(gl2.MAX_3D_TEXTURE_SIZE) || 0;
        renderBackend = max3D >= 256 ? 'webgl3d' : 'webgl2d';
      } else {
        renderBackend = 'canvas2d';
      }
    } catch {
      renderBackend = 'canvas2d';
    }
  } else {
    // 'canvas' manual override
    renderBackend = 'canvas2d';
  }
}

applyRenderBackend('auto');

let volumeRaycaster: VolumeRaycaster | null = null;
let renderMode: 'slice' | 'volume' = 'slice';
let volumeRotationMatrix = new Float32Array([1,0,0,0, 0,1,0,0, 0,0,1,0, 0,0,0,1]);
let volumeZoom = 1.0;
let isDraggingVolume = false;
let lastVolumeMouseX = 0;
let lastVolumeMouseY = 0;

class BufferPool {
  private pools: Map<number, ArrayBuffer[]> = new Map();
  private maxSize: number;

  constructor(maxSize: number = 50) {
    this.maxSize = maxSize;
  }

  acquire(size: number): ArrayBuffer {
    const key = this.nearestPowerOf2(size);
    const pool = this.pools.get(key);
    if (pool && pool.length > 0) {
      return pool.pop()!;
    }
    return new ArrayBuffer(key);
  }

  release(buf: ArrayBuffer): void {
    const key = this.nearestPowerOf2(buf.byteLength);
    let pool = this.pools.get(key);
    if (!pool) {
      pool = [];
      this.pools.set(key, pool);
    }
    if (pool.length < this.maxSize) {
      pool.push(buf);
    }
  }

  private nearestPowerOf2(n: number): number {
    let p = 1;
    while (p < n) p <<= 1;
    return p;
  }

  clear(): void {
    this.pools.clear();
  }
}

const bufferPool = new BufferPool();

class Float32Pool {
  private pool: Float32Array[] = [];
  private maxSize: number;

  constructor(maxSize: number = 30) {
    this.maxSize = maxSize;
  }

  acquire(length: number): Float32Array {
    for (let i = 0; i < this.pool.length; i++) {
      if (this.pool[i].length >= length) {
        const arr = this.pool.splice(i, 1)[0];
        return arr.subarray(0, length);
      }
    }
    return new Float32Array(length);
  }

  release(arr: Float32Array): void {
    if (this.pool.length < this.maxSize) {
      this.pool.push(arr);
    }
  }

  clear(): void {
    this.pool = [];
  }
}

const float32Pool = new Float32Pool();

class BandwidthEstimator {
  private samples: { bytes: number; durationMs: number }[] = [];
  private maxSamples = 10;
  private _estimatedBps: number = 10 * 1024 * 1024;

  get estimatedBps(): number {
    return this._estimatedBps;
  }

  addSample(bytes: number, durationMs: number): void {
    if (durationMs <= 0) return;
    this.samples.push({ bytes, durationMs });
    if (this.samples.length > this.maxSamples) {
      this.samples.shift();
    }
    let totalBytes = 0;
    let totalMs = 0;
    for (const s of this.samples) {
      totalBytes += s.bytes;
      totalMs += s.durationMs;
    }
    this._estimatedBps = (totalBytes / totalMs) * 1000 * 8;
  }

  get qualityLevel(): 'high' | 'medium' | 'low' {
    const mbps = this._estimatedBps / (1024 * 1024);
    if (mbps > 50) return 'high';
    if (mbps > 10) return 'medium';
    return 'low';
  }
}

const bandwidthEstimator = new BandwidthEstimator();

class WebGLRenderer {
  private gl: WebGL2RenderingContext | WebGLRenderingContext | null = null;
  private program: WebGLProgram | null = null;
  private program3D: WebGLProgram | null = null;
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
out vec4 fragColor;
void main() {
  float rawValue = texture(u_image, v_texCoord).r;
  float lo = u_windowLevel - u_windowWidth * 0.5;
  float t = clamp((rawValue - lo) / u_windowWidth, 0.0, 1.0);
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

  private fragmentShader3D = `#version 300 es
precision highp float;
in vec2 v_texCoord;
uniform sampler3D u_volume;
uniform sampler2D u_colormap;
uniform float u_windowLevel;
uniform float u_windowWidth;
uniform float u_sliceIndex;
uniform int u_axis;
uniform vec3 u_volumeSize;
uniform int u_flipX;
uniform int u_flipY;
out vec4 fragColor;
void main() {
  float fx = (u_flipX == 1) ? 1.0 - v_texCoord.x : v_texCoord.x;
  float fy = (u_flipY == 1) ? 1.0 - v_texCoord.y : v_texCoord.y;
  vec3 uvw;
  if (u_axis == 0) {
    uvw = vec3(fx, fy, u_sliceIndex / u_volumeSize.z);
  } else if (u_axis == 1) {
    uvw = vec3(fx, u_sliceIndex / u_volumeSize.y, fy);
  } else {
    uvw = vec3(u_sliceIndex / u_volumeSize.x, fx, fy);
  }
  float rawValue = texture(u_volume, uvw).r;
  float lo = u_windowLevel - u_windowWidth * 0.5;
  float t = clamp((rawValue - lo) / u_windowWidth, 0.0, 1.0);
  vec4 color = texture(u_colormap, vec2(t, 0.5));
  fragColor = color;
}`;

  private offscreen: OffscreenCanvas | null = null;
  private offscreenCtx: WebGL2RenderingContext | WebGLRenderingContext | null = null;

  init(canvas: HTMLCanvasElement): boolean {
    const tryOffscreen = !!(canvas as any).transferControlToOffscreen;
    if (tryOffscreen) {
      try {
        const offscreenCanvas = (canvas as any).transferControlToOffscreen() as OffscreenCanvas;
        const gl2 = offscreenCanvas.getContext('webgl2', { premultipliedAlpha: false, preserveDrawingBuffer: true }) as WebGL2RenderingContext | null;
        if (gl2) {
          this.offscreen = offscreenCanvas;
          this.offscreenCtx = gl2;
          this.gl = gl2;
          this.isWebGL2 = true;
          this.supportsFloatTexture = true;
          this.floatLinear = !!gl2.getExtension('OES_texture_float_linear');
          if (this.setupProgram()) return true;
          this.offscreen = null;
          this.offscreenCtx = null;
          this.gl = null;
        }
      } catch {
        this.offscreen = null;
        this.offscreenCtx = null;
        this.gl = null;
      }
    }

    const gl2 = canvas.getContext('webgl2', { premultipliedAlpha: false, preserveDrawingBuffer: true });
    if (gl2) {
      this.gl = gl2;
      this.isWebGL2 = true;
      this.supportsFloatTexture = true;
      this.floatLinear = !!gl2.getExtension('OES_texture_float_linear');
      return this.setupProgram();
    }
    const gl1 = canvas.getContext('webgl', { premultipliedAlpha: false, preserveDrawingBuffer: true });
    if (gl1) {
      this.gl = gl1;
      this.isWebGL2 = false;
      this.floatLinear = false;
      this.supportsFloatTexture = !!gl1.getExtension('OES_texture_float');
      if (!this.supportsFloatTexture) return false;
      return this.setupProgram();
    }
    return false;
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
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([0, 1, 1, 1, 0, 0, 1, 0]), gl.STATIC_DRAW);

    this.ready = true;

    if (this.isWebGL2) {
      const vs3d = this.compileShader(gl.VERTEX_SHADER, this.vertexShader3D);
      const fs3d = this.compileShader(gl.FRAGMENT_SHADER, this.fragmentShader3D);
      if (vs3d && fs3d) {
        this.program3D = gl.createProgram()!;
        gl.attachShader(this.program3D, vs3d);
        gl.attachShader(this.program3D, fs3d);
        gl.linkProgram(this.program3D);
        if (!gl.getProgramParameter(this.program3D, gl.LINK_STATUS)) {
          this.program3D = null;
        }
      }
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
    lo: number, range: number, cmapName: string, flipX: boolean = false, flipY: boolean = false): boolean {
    if (!this.ready || !this.gl || !this.program || !this.supportsFloatTexture) return false;
    const gl = this.gl;

    const dpr = window.devicePixelRatio || 1;
    canvas.width = canvas.clientWidth * dpr;
    canvas.height = canvas.clientHeight * dpr;
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
      gl.uniform1f(uWindowLevel, lo + range * 0.5);
      gl.uniform1f(uWindowWidth, range);
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

    gl.bindBuffer(gl.ARRAY_BUFFER, this.posBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.DYNAMIC_DRAW);
    gl.enableVertexAttribArray(aPos);
    gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 0, 0);

    gl.bindBuffer(gl.ARRAY_BUFFER, this.texCoordBuffer);
    const tx0 = flipX ? 1 : 0, tx1 = flipX ? 0 : 1;
    const ty0 = flipY ? 0 : 1, ty1 = flipY ? 1 : 0;
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([tx0, ty0, tx1, ty0, tx0, ty1, tx1, ty1]), gl.DYNAMIC_DRAW);
    gl.enableVertexAttribArray(aTex);
    gl.vertexAttribPointer(aTex, 2, gl.FLOAT, false, 0, 0);

    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    if (gl.getError() !== gl.NO_ERROR) return false;
    return true;
  }

  uploadVolume3D(data: Float32Array, nx: number, ny: number, nz: number): boolean {
    if (!this.isWebGL2 || !this.program3D) return false;
    const gl2 = this.gl as WebGL2RenderingContext;

    const max3DSize = gl2.getParameter(gl2.MAX_3D_TEXTURE_SIZE);
    if (nx > max3DSize || ny > max3DSize || nz > max3DSize) return false;

    const estimatedBytes = nx * ny * nz * 4;
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
    const filter = this.floatLinear ? gl2.LINEAR : gl2.NEAREST;
    gl2.texParameteri(gl2.TEXTURE_3D, gl2.TEXTURE_MIN_FILTER, filter);
    gl2.texParameteri(gl2.TEXTURE_3D, gl2.TEXTURE_MAG_FILTER, filter);
    gl2.texParameteri(gl2.TEXTURE_3D, gl2.TEXTURE_WRAP_S, gl2.CLAMP_TO_EDGE);
    gl2.texParameteri(gl2.TEXTURE_3D, gl2.TEXTURE_WRAP_T, gl2.CLAMP_TO_EDGE);
    gl2.texParameteri(gl2.TEXTURE_3D, gl2.TEXTURE_WRAP_R, gl2.CLAMP_TO_EDGE);

    try {
      gl2.texImage3D(gl2.TEXTURE_3D, 0, gl2.R32F, nx, ny, nz, 0, gl2.RED, gl2.FLOAT, data);
    } catch {
      gl2.deleteTexture(this.texture3D);
      this.texture3D = null;
      return false;
    }

    if (gl2.getError() !== gl2.NO_ERROR) {
      gl2.deleteTexture(this.texture3D);
      this.texture3D = null;
      return false;
    }

    this.volume3DReady = true;
    this.volume3DSize = nx * ny * nz;
    this.chunkCount = 0;
    return true;
  }

  private uploadVolume3DChunked(data: Float32Array, nx: number, ny: number, nz: number): boolean {
    const gl2 = this.gl as WebGL2RenderingContext;
    // Determine chunk size: split along Z axis
    const sliceSize = nx * ny;
    const bytesPerSlice = sliceSize * 4;
    const targetChunkBytes = 256 * 1024 * 1024; // 256MB per chunk
    const slicesPerChunk = Math.max(1, Math.floor(targetChunkBytes / bytesPerSlice));
    const numChunks = Math.ceil(nz / slicesPerChunk);

    this.texture3DChunks = [];
    this.chunkZSize = slicesPerChunk;
    this.chunkCount = numChunks;
    this.chunkNx = nx;
    this.chunkNy = ny;
    this.chunkNz = nz;

    const filter = this.floatLinear ? gl2.LINEAR : gl2.NEAREST;

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
        gl2.texImage3D(gl2.TEXTURE_3D, 0, gl2.R32F, nx, ny, chunkDepth, 0, gl2.RED, gl2.FLOAT, chunkData);
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
    cmapName: string, flipX: boolean = false, flipY: boolean = false): boolean {
    if (!this.volume3DReady || !this.program3D || !this.isWebGL2) return false;
    const gl2 = this.gl as WebGL2RenderingContext;

    const dpr = window.devicePixelRatio || 1;
    canvas.width = canvas.clientWidth * dpr;
    canvas.height = canvas.clientHeight * dpr;
    gl2.viewport(0, 0, canvas.width, canvas.height);

    gl2.useProgram(this.program3D);

    // Bind the correct 3D texture (single or chunked)
    gl2.activeTexture(gl2.TEXTURE0);
    if (this.chunkCount > 0) {
      // Chunked: select the correct chunk based on slice index
      const effectiveSliceZ = axis === 0 ? sliceIndex : axis === 1 ? sliceIndex : sliceIndex;
      const chunkIdx = Math.min(Math.floor(effectiveSliceZ / this.chunkZSize), this.chunkCount - 1);
      const tex = this.texture3DChunks[chunkIdx];
      if (!tex) return false;
      gl2.bindTexture(gl2.TEXTURE_3D, tex);
    } else {
      if (!this.texture3D) return false;
      gl2.bindTexture(gl2.TEXTURE_3D, this.texture3D);
    }

    // Update colormap 1D LUT texture if changed
    if (this.currentCmap3D !== cmapName) {
      this.createColormapTexture(cmapName);
      this.currentCmap3D = cmapName;
    }

    gl2.activeTexture(gl2.TEXTURE1);
    gl2.bindTexture(gl2.TEXTURE_2D, this.colormapTexture);

    gl2.uniform1i(gl2.getUniformLocation(this.program3D, 'u_volume'), 0);
    gl2.uniform1i(gl2.getUniformLocation(this.program3D, 'u_colormap'), 1);
    gl2.uniform1f(gl2.getUniformLocation(this.program3D, 'u_windowLevel'), lo + range * 0.5);
    gl2.uniform1f(gl2.getUniformLocation(this.program3D, 'u_windowWidth'), range);
    gl2.uniform1f(gl2.getUniformLocation(this.program3D, 'u_sliceIndex'), sliceIndex);
    gl2.uniform1i(gl2.getUniformLocation(this.program3D, 'u_axis'), axis);
    gl2.uniform3f(gl2.getUniformLocation(this.program3D, 'u_volumeSize'), nx, ny, nz);
    gl2.uniform1i(gl2.getUniformLocation(this.program3D, 'u_flipX'), flipX ? 1 : 0);
    gl2.uniform1i(gl2.getUniformLocation(this.program3D, 'u_flipY'), flipY ? 1 : 0);

    const aPos = gl2.getAttribLocation(this.program3D, 'a_position');
    const aTex = gl2.getAttribLocation(this.program3D, 'a_texCoord');

    gl2.bindBuffer(gl2.ARRAY_BUFFER, this.posBuffer);
    gl2.bufferData(gl2.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl2.DYNAMIC_DRAW);
    gl2.enableVertexAttribArray(aPos);
    gl2.vertexAttribPointer(aPos, 2, gl2.FLOAT, false, 0, 0);

    gl2.bindBuffer(gl2.ARRAY_BUFFER, this.texCoordBuffer);
    gl2.bufferData(gl2.ARRAY_BUFFER, new Float32Array([0, 1, 1, 1, 0, 0, 1, 0]), gl2.STATIC_DRAW);
    gl2.enableVertexAttribArray(aTex);
    gl2.vertexAttribPointer(aTex, 2, gl2.FLOAT, false, 0, 0);

    gl2.drawArrays(gl2.TRIANGLE_STRIP, 0, 4);
    return gl2.getError() === gl2.NO_ERROR;
  }

  createColormapTexture(cmapName: string): void {
    if (!this.isWebGL2 || !this.gl) return;
    const gl2 = this.gl as WebGL2RenderingContext;
    const cmapFn = COLORMAPS[cmapName] || COLORMAPS.gray;
    const lutData = new Uint8Array(256 * 4);
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
  }

  private updateLUT(cmapName: string): void {
    const gl = this.gl!;
    const cmapFn = COLORMAPS[cmapName] || COLORMAPS.gray;
    const lutData = new Uint8Array(256 * 4);
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
    if (this.texture) this.gl.deleteTexture(this.texture);
    if (this.lutTexture) this.gl.deleteTexture(this.lutTexture);
    if (this.colormapTexture) this.gl.deleteTexture(this.colormapTexture);
    if (this.posBuffer) this.gl.deleteBuffer(this.posBuffer);
    if (this.texCoordBuffer) this.gl.deleteBuffer(this.texCoordBuffer);
    this.deleteChunkedTextures();
    this.stopSliceAnimation();
    this.ready = false;
    this.gl = null;
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

function detectPerformance(): PerformanceProfile {
  const nav = navigator as any;
  const cores = nav.hardwareConcurrency || 4;
  const memoryMB = nav.deviceMemory ? nav.deviceMemory * 1024 : 4096;

  let gpuAvailable = false;
  let maxTextureSize = 4096;
  let max3DTextureSize = 0;
  try {
    const testCanvas = document.createElement('canvas');
    const gl = testCanvas.getContext('webgl2') || testCanvas.getContext('webgl');
    if (gl) {
      gpuAvailable = true;
      maxTextureSize = gl.getParameter(gl.MAX_TEXTURE_SIZE) || 4096;
      if (gl instanceof WebGL2RenderingContext) {
        max3DTextureSize = gl.getParameter(gl.MAX_3D_TEXTURE_SIZE) || 0;
      }
    }
  } catch { }

  let tier: 'high' | 'medium' | 'low';
  if (cores >= 8 && memoryMB >= 4096 && gpuAvailable) {
    tier = 'high';
  } else if (cores >= 4 && memoryMB >= 2048) {
    tier = 'medium';
  } else {
    tier = 'low';
  }

  return { tier, gpuAvailable, maxTextureSize, max3DTextureSize, cores, memoryMB };
}

function voxelToWorld(h: NiiHeader, vx: number, vy: number, vz: number): [number, number, number] {
  if (h.sform_code !== 0) {
    const wx = h.srow_x[0] * vx + h.srow_x[1] * vy + h.srow_x[2] * vz + h.srow_x[3];
    const wy = h.srow_y[0] * vx + h.srow_y[1] * vy + h.srow_y[2] * vz + h.srow_y[3];
    const wz = h.srow_z[0] * vx + h.srow_z[1] * vy + h.srow_z[2] * vz + h.srow_z[3];
    return [wx, wy, wz];
  }
  if (h.qform_code !== 0) {
    const a = Math.sqrt(1.0 + h.quatern_b * h.quatern_b + h.quatern_c * h.quatern_c + h.quatern_d * h.quatern_d);
    const b = h.quatern_b / a, c = h.quatern_c / a, d = h.quatern_d / a;
    const R = [
      [a * a + b * b - c * c - d * d, 2 * b * c - 2 * a * d, 2 * b * d + 2 * a * c],
      [2 * b * c + 2 * a * d, a * a + c * c - b * b - d * d, 2 * c * d - 2 * a * b],
      [2 * b * d - 2 * a * c, 2 * c * d + 2 * a * b, a * a + d * d - b * b - c * c],
    ];
    const wx = h.dx * (R[0][0] * vx + R[0][1] * vy + R[0][2] * vz) + h.qoffset_x;
    const wy = h.dy * (R[1][0] * vx + R[1][1] * vy + R[1][2] * vz) + h.qoffset_y;
    const wz = h.dz * (R[2][0] * vx + R[2][1] * vy + R[2][2] * vz) + h.qoffset_z;
    return [wx, wy, wz];
  }
  return [vx * h.dx, vy * h.dy, vz * h.dz];
}

function worldToVoxel(h: NiiHeader, wx: number, wy: number, wz: number): [number, number, number] {
  if (h.sform_code !== 0) {
    const m = [
      [h.srow_x[0], h.srow_x[1], h.srow_x[2]],
      [h.srow_y[0], h.srow_y[1], h.srow_y[2]],
      [h.srow_z[0], h.srow_z[1], h.srow_z[2]],
    ];
    const off = [wx - h.srow_x[3], wy - h.srow_y[3], wz - h.srow_z[3]];
    const det = m[0][0] * (m[1][1] * m[2][2] - m[1][2] * m[2][1])
              - m[0][1] * (m[1][0] * m[2][2] - m[1][2] * m[2][0])
              + m[0][2] * (m[1][0] * m[2][1] - m[1][1] * m[2][0]);
    if (Math.abs(det) > 1e-10) {
      const invDet = 1 / det;
      const vx = invDet * ((m[1][1] * m[2][2] - m[1][2] * m[2][1]) * off[0] - (m[0][1] * m[2][2] - m[0][2] * m[2][1]) * off[1] + (m[0][1] * m[1][2] - m[0][2] * m[1][1]) * off[2]);
      const vy = invDet * (-(m[1][0] * m[2][2] - m[1][2] * m[2][0]) * off[0] + (m[0][0] * m[2][2] - m[0][2] * m[2][0]) * off[1] - (m[0][0] * m[1][2] - m[0][2] * m[1][0]) * off[2]);
      const vz = invDet * ((m[1][0] * m[2][1] - m[1][1] * m[2][0]) * off[0] - (m[0][0] * m[2][1] - m[0][1] * m[2][0]) * off[1] + (m[0][0] * m[1][1] - m[0][1] * m[1][0]) * off[2]);
      return [vx, vy, vz];
    }
  }
  if (h.qform_code !== 0) {
    const a = Math.sqrt(1.0 + h.quatern_b * h.quatern_b + h.quatern_c * h.quatern_c + h.quatern_d * h.quatern_d);
    const b = h.quatern_b / a, c = h.quatern_c / a, d = h.quatern_d / a;
    const R = [
      [a * a + b * b - c * c - d * d, 2 * b * c - 2 * a * d, 2 * b * d + 2 * a * c],
      [2 * b * c + 2 * a * d, a * a + c * c - b * b - d * d, 2 * c * d - 2 * a * b],
      [2 * b * d - 2 * a * c, 2 * c * d + 2 * a * b, a * a + d * d - b * b - c * c],
    ];
    const qx = (wx - h.qoffset_x);
    const qy = (wy - h.qoffset_y);
    const qz = (wz - h.qoffset_z);
    const det = R[0][0] * (R[1][1] * R[2][2] - R[1][2] * R[2][1])
              - R[0][1] * (R[1][0] * R[2][2] - R[1][2] * R[2][0])
              + R[0][2] * (R[1][0] * R[2][1] - R[1][1] * R[2][0]);
    if (Math.abs(det) > 1e-10) {
      const invDet = 1 / det;
      const rx = invDet * ((R[1][1] * R[2][2] - R[1][2] * R[2][1]) * qx - (R[0][1] * R[2][2] - R[0][2] * R[2][1]) * qy + (R[0][1] * R[1][2] - R[0][2] * R[1][1]) * qz);
      const ry = invDet * (-(R[1][0] * R[2][2] - R[1][2] * R[2][0]) * qx + (R[0][0] * R[2][2] - R[0][2] * R[2][0]) * qy - (R[0][0] * R[1][2] - R[0][2] * R[1][0]) * qz);
      const rz = invDet * ((R[1][0] * R[2][1] - R[1][1] * R[2][0]) * qx - (R[0][0] * R[2][1] - R[0][1] * R[2][0]) * qy + (R[0][0] * R[1][1] - R[0][1] * R[1][0]) * qz);
      return [rx / h.dx, ry / h.dy, rz / h.dz];
    }
  }
  return [wx / h.dx, wy / h.dy, wz / h.dz];
}

// --- Measurement Tools ---
function canvasToVoxel(axis: Axis, cx: number, cy: number): [number, number, number] | null {
  if (!header) return null;
  const { nx, ny, nz, dx, dy, dz } = header;
  const pixelW = axis === 'sagittal' ? ny * dy : nx * dx;
  const pixelH = axis === 'axial' ? ny * dy : nz * dz;
  const canvas = canvases[axis];
  const container = canvas.parentElement!;
  const dw = container.clientWidth;
  const dh = container.clientHeight;
  const vs = viewState[axis];
  const ar = pixelW / pixelH;
  let cw: number, ch: number;
  if (dw / dh > ar) { ch = dh; cw = ch * ar; }
  else { cw = dw; ch = cw / ar; }
  cw *= vs.zoom; ch *= vs.zoom;
  const imgLeft = (dw - cw) / 2 + vs.panX;
  const imgTop = (dh - ch) / 2 + vs.panY;
  const nx_c = (cx - imgLeft) / cw;
  const ny_c = (cy - imgTop) / ch;
  if (nx_c < 0 || nx_c > 1 || ny_c < 0 || ny_c > 1) return null;
  if (axis === 'axial') return [nx_c * nx, (1 - ny_c) * ny, sliceIdx.axial];
  if (axis === 'coronal') return [nx_c * nx, sliceIdx.coronal, (1 - ny_c) * nz];
  return [sliceIdx.sagittal, nx_c * ny, (1 - ny_c) * nz];
}

function computeLineDistance(axis: Axis, x1: number, y1: number, x2: number, y2: number): number {
  if (!header) return 0;
  const v1 = canvasToVoxel(axis, x1, y1);
  const v2 = canvasToVoxel(axis, x2, y2);
  if (!v1 || !v2) return 0;
  const [wx1, wy1, wz1] = voxelToWorld(header, v1[0], v1[1], v1[2]);
  const [wx2, wy2, wz2] = voxelToWorld(header, v2[0], v2[1], v2[2]);
  return Math.sqrt((wx2 - wx1) ** 2 + (wy2 - wy1) ** 2 + (wz2 - wz1) ** 2);
}

function computeRoiArea(axis: Axis, x1: number, y1: number, x2: number, y2: number): number {
  if (!header) return 0;
  const v1 = canvasToVoxel(axis, x1, y1);
  const v2 = canvasToVoxel(axis, x2, y2);
  if (!v1 || !v2) return 0;
  const [wx1, wy1, wz1] = voxelToWorld(header, v1[0], v1[1], v1[2]);
  const [wx2, wy2, wz2] = voxelToWorld(header, v2[0], v2[1], v2[2]);
  // For ROI, area is computed in the plane of the view
  if (axis === 'axial') return Math.abs(wx2 - wx1) * Math.abs(wy2 - wy1);
  if (axis === 'coronal') return Math.abs(wx2 - wx1) * Math.abs(wz2 - wz1);
  return Math.abs(wy2 - wy1) * Math.abs(wz2 - wz1);
}

function drawMeasurements(): void {
  for (const axis of ['axial', 'coronal', 'sagittal'] as const) {
    const measureCanvas = document.getElementById(`measure-${axis}`) as HTMLCanvasElement;
    if (!measureCanvas) continue;
    const container = measureCanvas.parentElement!;
    const dpr = window.devicePixelRatio || 1;
    measureCanvas.width = container.clientWidth * dpr;
    measureCanvas.height = container.clientHeight * dpr;
    measureCanvas.style.width = container.clientWidth + 'px';
    measureCanvas.style.height = container.clientHeight + 'px';
    const ctx = measureCanvas.getContext('2d');
    if (!ctx) continue;
    ctx.clearRect(0, 0, measureCanvas.width, measureCanvas.height);
    ctx.scale(dpr, dpr);
    const axisMeasurements = measurements.filter(m => m.axis === axis);
    for (const m of axisMeasurements) {
      if (m.type === 'line') {
        ctx.strokeStyle = '#00ff00';
        ctx.lineWidth = highContrastPreferred ? 3 : 2;
        ctx.beginPath();
        ctx.moveTo(m.x1, m.y1);
        ctx.lineTo(m.x2, m.y2);
        ctx.stroke();
        // Distance label at midpoint
        const mx = (m.x1 + m.x2) / 2;
        const my = (m.y1 + m.y2) / 2;
        ctx.font = highContrastPreferred ? 'bold 13px sans-serif' : '11px sans-serif';
        ctx.fillStyle = '#00ff00';
        ctx.textAlign = 'center';
        ctx.fillText(`${m.distance.toFixed(2)} mm`, mx, my - 6);
      } else {
        ctx.strokeStyle = '#ffff00';
        ctx.lineWidth = highContrastPreferred ? 3 : 2;
        ctx.setLineDash([4, 4]);
        ctx.strokeRect(Math.min(m.x1, m.x2), Math.min(m.y1, m.y2), Math.abs(m.x2 - m.x1), Math.abs(m.y2 - m.y1));
        ctx.setLineDash([]);
        const rx = (m.x1 + m.x2) / 2;
        const ry = (m.y1 + m.y2) / 2;
        ctx.font = highContrastPreferred ? 'bold 13px sans-serif' : '11px sans-serif';
        ctx.fillStyle = '#ffff00';
        ctx.textAlign = 'center';
        ctx.fillText(`${m.area.toFixed(2)} mm²`, rx, ry - 6);
      }
    }
  }
}

function clearMeasurements(): void {
  measurements.length = 0;
  drawMeasurements();
}

// --- Accessibility ---
function a11yAnnounce(text: string): void {
  const el = document.getElementById('a11y-announce');
  if (el) el.textContent = text;
}

// --- Input Validation ---
function validateSliceIndex(axis: Axis, idx: number): number {
  if (!header) return 0;
  const max = axis === 'axial' ? header.nz - 1 : axis === 'coronal' ? header.ny - 1 : header.nx - 1;
  return Math.max(0, Math.min(max, Math.round(idx)));
}

function validateWindowLevel(ww: number, wl: number): { windowWidth: number; windowLevel: number } {
  return {
    windowWidth: isFinite(ww) && ww > 0 ? ww : 1,
    windowLevel: isFinite(wl) ? wl : 0.5,
  };
}

function validateVolumeData(hdr: NiiHeader | null, data: Float32Array | null): boolean {
  if (!hdr || !data) return false;
  const expectedLen = hdr.nx * hdr.ny * hdr.nz;
  return data.length >= expectedLen;
}

// --- Error Recovery ---
function handleWebGLContextLoss(canvas: HTMLCanvasElement, axis: Axis): void {
  console.warn(`[NiftiSpy] WebGL context lost for ${axis}, attempting recovery...`);
  const renderer = glRenderers[axis];
  if (renderer) {
    renderer.destroy();
    delete glRenderers[axis];
  }
  // Attempt to reinitialize after a short delay
  setTimeout(() => {
    const newRenderer = new WebGLRenderer();
    if (newRenderer.init(canvas)) {
      glRenderers[axis] = newRenderer;
      if (volumeData && header) {
        tryUploadVolume3D();
      }
      renderAllViews();
    }
  }, 500);
}

function restartCrashedWorker(axis: Axis): void {
  const idx = AXIS_TO_WORKER_IDX[axis];
  const oldWorker = sliceWorkers[idx];
  if (oldWorker) {
    oldWorker.terminate();
    sliceWorkers[idx] = null as any;
  }
  // Worker will be recreated on next use via getSliceWorker
  console.warn(`[NiftiSpy] Restarted worker for ${axis}`);
}

const loading = document.getElementById('loading') as HTMLDivElement;
const loadingText = document.getElementById('loading-text') as HTMLSpanElement;
const loadingDetail = document.getElementById('loading-detail') as HTMLSpanElement;
const progress = document.getElementById('progress-bar') as HTMLDivElement;

const canvases = {
  axial: document.getElementById('axial') as HTMLCanvasElement,
  coronal: document.getElementById('coronal') as HTMLCanvasElement,
  sagittal: document.getElementById('sagittal') as HTMLCanvasElement,
  mip: document.getElementById('mip') as HTMLCanvasElement,
};

const COLORMAPS: Record<string, (t: number) => [number, number, number]> = {
  gray: (t) => [t * 255, t * 255, t * 255],
  hot: (t) => {
    const r = Math.min(1, t * 3) * 255;
    const g = Math.max(0, Math.min(1, t * 3 - 1)) * 255;
    const b = Math.max(0, Math.min(1, t * 3 - 2)) * 255;
    return [r, g, b];
  },
  cool: (t) => [(1 - t) * 255, t * 255, 255],
  jet: (t) => {
    const r = Math.max(0, Math.min(1, 1.5 - Math.abs(t * 4 - 3))) * 255;
    const g = Math.max(0, Math.min(1, 1.5 - Math.abs(t * 4 - 2))) * 255;
    const b = Math.max(0, Math.min(1, 1.5 - Math.abs(t * 4 - 1))) * 255;
    return [r, g, b];
  },
  viridis: (t) => VIRIDIS_LUT[Math.max(0, Math.min(255, Math.floor(t * 255)))],
  inferno: (t) => INFERNO_LUT[Math.max(0, Math.min(255, Math.floor(t * 255)))],
};

function buildLUT(stops: [number, number, number, number][]): [number, number, number][] {
  const lut: [number, number, number][] = [];
  for (let i = 0; i < 256; i++) {
    const t = i / 255;
    let s0 = stops[0], s1 = stops[1];
    for (let j = 0; j < stops.length - 1; j++) {
      if (t >= stops[j][0] && t <= stops[j + 1][0]) { s0 = stops[j]; s1 = stops[j + 1]; break; }
    }
    const f = s0[0] === s1[0] ? 0 : (t - s0[0]) / (s1[0] - s0[0]);
    lut.push([Math.round(s0[1] + (s1[1] - s0[1]) * f), Math.round(s0[2] + (s1[2] - s0[2]) * f), Math.round(s0[3] + (s1[3] - s0[3]) * f)]);
  }
  return lut;
}

const VIRIDIS_LUT = buildLUT([[0,68,1,84],[0.13,72,36,117],[0.25,65,68,135],[0.38,53,95,141],[0.5,42,120,142],[0.63,33,145,140],[0.75,34,168,132],[0.88,68,191,112],[1,253,231,37]]);
const INFERNO_LUT = buildLUT([[0,0,0,4],[0.13,40,11,84],[0.25,101,21,110],[0.38,159,42,99],[0.5,212,72,66],[0.63,245,125,21],[0.75,250,193,39],[0.88,234,247,132],[1,252,255,164]]);

let sliceWorkers: Worker[] = [];
const AXIS_TO_WORKER_IDX: Record<Axis, number> = { axial: 0, coronal: 1, sagittal: 2 };
let cachedBlobUrl: string | null = null;

class SliceWorkerPool {
  private workers: Worker[] = [];
  private idle: Worker[] = [];
  private maxSize: number;
  private blobUrl: string | null = null;
  private queue: Array<{ payload: Record<string, any>; resolve: (v: any) => void; reject: (e: any) => void }> = [];

  constructor(maxSize: number) { this.maxSize = maxSize; }

  async init(): Promise<void> {
    this.blobUrl = await ensureWorkerBlobUrl();
    const initialSize = Math.min(this.maxSize, 3);
    for (let i = 0; i < initialSize; i++) {
      const w = new Worker(this.blobUrl);
      attachWorkerRouter(w);
      this.workers.push(w);
      this.idle.push(w);
    }
  }

  dispatch<T = any>(payload: Record<string, any>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const idleWorker = this.idle.shift();
      if (idleWorker) {
        this.exec(idleWorker, payload, resolve, reject);
      } else if (this.workers.length < this.maxSize) {
        const w = new Worker(this.blobUrl!);
        attachWorkerRouter(w);
        this.workers.push(w);
        this.exec(w, payload, resolve, reject);
      } else {
        this.queue.push({ payload, resolve, reject });
      }
    });
  }

  private exec(worker: Worker, payload: Record<string, any>, resolve: (v: any) => void, reject: (e: any) => void): void {
    const id = nextWorkerRequestId++;
    workerRequests.set(id, {
      resolve: (msg: any) => { resolve(msg); this.release(worker); },
      reject: (err: any) => { reject(err); this.release(worker); },
    });
    worker.postMessage({ ...payload, id });
  }

  private release(worker: Worker): void {
    if (this.queue.length > 0) {
      const next = this.queue.shift()!;
      this.exec(worker, next.payload, next.resolve, next.reject);
    } else {
      this.idle.push(worker);
    }
  }

  broadcast(message: Record<string, any>): void {
    for (const w of this.workers) w.postMessage(message);
  }

  terminate(): void {
    for (const w of this.workers) w.terminate();
    this.workers = [];
    this.idle = [];
    this.queue = [];
  }

  setErrorHandler(handler: (err: ErrorEvent) => void): void {
    for (const w of this.workers) w.onerror = handler;
  }
}

let slicePool: SliceWorkerPool | null = null;

async function ensureWorkerBlobUrl(): Promise<string> {
  if ((window as any).__NII_WORKER_BLOB_URL__) return (window as any).__NII_WORKER_BLOB_URL__;
  if (cachedBlobUrl) return cachedBlobUrl;
  const workerResp = await fetch((window as any).WORKER_URL);
  if (!workerResp.ok) throw new Error(`Worker fetch failed: ${workerResp.status}`);
  const workerSrc = await workerResp.text();
  const blob = new Blob([workerSrc], { type: 'application/javascript' });
  cachedBlobUrl = URL.createObjectURL(blob);
  (window as any).__NII_WORKER_BLOB_URL__ = cachedBlobUrl;
  return cachedBlobUrl;
}

function attachWorkerRouter(worker: Worker) {
  if ((worker as any).__routerAttached) return;
  (worker as any).__routerAttached = true;
  worker.onmessage = (ev) => {
    const msg = ev.data;
    if (msg?.type === 'bandwidthSample') {
      bandwidthEstimator.addSample(msg.bytes || 0, msg.durationMs || 0);
      return;
    }
    if (msg?.type === 'renderComplete') {
      // Worker finished OffscreenCanvas rendering; clear pending request
      const axis = msg.axis as Axis;
      if (axis) pendingRenderRequests.delete(axis);
      return;
    }
    const streamHandler = workerStreamHandlers.get(msg.id);
    if (streamHandler) {
      streamHandler(msg);
      return;
    }
    const pending = workerRequests.get(msg.id);
    if (pending && msg?.type !== 'progress' && msg?.type !== 'preview' && msg?.type !== 'volume') {
      workerRequests.delete(msg.id);
      if (msg.type === 'error') pending.reject(new Error(msg.error || 'Worker error'));
      else pending.resolve(msg);
      return;
    }
    if (msg?.type === 'progress' || msg?.type === 'preview' || msg?.type === 'volume' || msg?.type === 'error') {
      workerStreamListener?.(msg);
    }
  };
  // Worker crash recovery
  worker.onerror = (e: ErrorEvent) => {
    console.error('[NiftiSpy] Worker error:', e.message);
    // Find which axis this worker belongs to and restart it
    const idx = sliceWorkers.indexOf(worker);
    if (idx >= 0) {
      const axis = (['axial', 'coronal', 'sagittal'] as Axis[])[idx];
      if (axis) restartCrashedWorker(axis);
    }
  };
}

async function getSlicePool(): Promise<SliceWorkerPool> {
  if (!slicePool) {
    const maxWorkers = Math.min(navigator.hardwareConcurrency || 4, 6);
    slicePool = new SliceWorkerPool(maxWorkers);
    await slicePool.init();
  }
  return slicePool;
}

async function getSliceWorker(axis: Axis): Promise<Worker> {
  const pool = await getSlicePool();
  const idx = AXIS_TO_WORKER_IDX[axis];
  if (sliceWorkers[idx]) return sliceWorkers[idx];
  const worker = new Worker(await ensureWorkerBlobUrl());
  attachWorkerRouter(worker);
  sliceWorkers[idx] = worker;
  return worker;
}

async function ensureAllSliceWorkers(): Promise<void> {
  await getSlicePool();
}

function broadcastToSliceWorkers(message: Record<string, any>): void {
  if (slicePool) slicePool.broadcast(message);
  for (const worker of sliceWorkers) {
    if (worker) worker.postMessage(message);
  }
}

function sendWorkerRequest<T = any>(worker: Worker, payload: Record<string, any>): Promise<T> {
  const id = nextWorkerRequestId++;
  return new Promise<T>((resolve, reject) => {
    workerRequests.set(id, { resolve, reject });
    worker.postMessage({ ...payload, id });
  });
}

function registerWorkerStream(requestId: number, handler: (msg: any) => void) {
  workerStreamHandlers.set(requestId, handler);
}

function unregisterWorkerStream(requestId: number) {
  workerStreamHandlers.delete(requestId);
}

function cancelVolumeLoadByKey(key: string | null): void {
  if (!key) return;
  const worker = volumeWorkers.get(key);
  if (!worker) return;
  volumeWorkers.delete(key);
  if (activeVolumeLoadKey === key) activeVolumeLoadKey = null;
  worker.terminate();
  publishPerfMonitor();
}

function cancelQueuedVolumeLoads(exceptKey?: string): void {
  for (const entry of volumeLoadQueue) {
    if (exceptKey && entry.key === exceptKey) continue;
    entry.cancelled = true;
    entry.reject(makeAbortError());
  }
  for (let i = volumeLoadQueue.length - 1; i >= 0; i--) {
    if (!exceptKey || volumeLoadQueue[i].key !== exceptKey) volumeLoadQueue.splice(i, 1);
  }
  publishPerfMonitor();
}

async function reprioritizeVolumeLoad(key: string, priority: VolumeLoadPriority): Promise<void> {
  if (priority !== 'active') return;
  cancelQueuedVolumeLoads(key);
  if (activeVolumeLoadKey && activeVolumeLoadKey !== key) {
    cancelVolumeLoadByKey(activeVolumeLoadKey);
  }
}

function queueVolumeLoad<T>(key: string, task: () => Promise<T>, priority: VolumeLoadPriority = 'background'): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const entry: QueuedVolumeLoad = {
      key,
      priority,
      cancelled: false,
      reject,
      run: () => {
        if (entry.cancelled) {
          reject(makeAbortError());
          return;
        }
        activeVolumeLoads++;
        activeVolumeLoadKey = key;
        publishPerfMonitor();
        task().then(resolve, reject).finally(() => {
          activeVolumeLoads = Math.max(0, activeVolumeLoads - 1);
          if (activeVolumeLoadKey === key) activeVolumeLoadKey = null;
          const next = volumeLoadQueue.shift();
          next?.run();
          publishPerfMonitor();
        });
      },
    };
    if (activeVolumeLoads < MAX_PARALLEL_VOLUME_LOADS) entry.run();
    else if (priority === 'active') volumeLoadQueue.unshift(entry);
    else volumeLoadQueue.push(entry);
    publishPerfMonitor();
  });
}

function evictInactiveImageData(preferredIndices: number[] = []) {
  const keep = new Set(preferredIndices);
  if (compareMode && images.length >= 2) {
    keep.add(0);
    keep.add(1);
  }
  const loaded = images
    .map((img, idx) => ({ img, idx }))
    .filter(({ img }) => !!img.data);
  if (loaded.length <= MAX_RESIDENT_IMAGE_DATA) return;
  loaded
    .filter(({ idx }) => !keep.has(idx))
    .sort((a, b) => a.img.lastAccess - b.img.lastAccess)
    .slice(0, Math.max(0, loaded.length - MAX_RESIDENT_IMAGE_DATA))
    .forEach(({ img }) => {
      img.data = null;
      if (img.state === 'ready') img.state = 'preview';
      perfMonitor.evictions++;
    });
  publishPerfMonitor();
}

function tryUploadVolume3D() {
  if (!volumeData || !header) return;
  const { nx, ny, nz } = header;
  const n = nx * ny * nz;
  const estimatedBytes = n * 4; // Float32 = 4 bytes per voxel

  // Skip 3D texture upload if volume exceeds 1GB to prevent GPU OOM
  const VOLUME_3D_MAX_BYTES = 1 * 1024 * 1024 * 1024; // 1GB
  const skipVolume3D = estimatedBytes > VOLUME_3D_MAX_BYTES;
  if (skipVolume3D) {
    console.log(`[NiftiSpy] Skipping 3D texture upload: volume size ${(estimatedBytes / (1024 * 1024)).toFixed(0)}MB exceeds 1GB limit`);
  }

  let float32Data: Float32Array;
  if (volumeData instanceof Float32Array) {
    float32Data = volumeData;
  } else {
    float32Data = new Float32Array(n);
    for (let i = 0; i < n; i++) float32Data[i] = (volumeData as any)[i] * dataSlope + dataInter;
  }

  sharedVolumeBuffer = createSharedVolumeBuffer(float32Data);
  if (sharedVolumeBuffer) {
    broadcastToSliceWorkers({
      type: 'sharedVolume',
      buffer: sharedVolumeBuffer,
      nx, ny, nz,
      slope: dataSlope, inter: dataInter,
    });
  }

  if (!skipVolume3D) {
    for (const axis of ['axial', 'coronal', 'sagittal'] as const) {
      const r = glRenderers[axis];
      if (r) {
        if (!r.isVolume3DReady()) {
          r.uploadVolume3D(float32Data, nx, ny, nz);
        }
        // Try enabling OffscreenCanvas for this axis (only for WebGL2 3D texture path)
        if (r.isVolume3DReady() && !offscreenCanvasEnabled[axis]) {
          tryEnableOffscreenCanvas(axis);
        }
      }
      const wgr = webgpuRenderers[axis];
      if (wgr && wgr.isReady()) {
        wgr.uploadVolume3D(float32Data, nx, ny, nz);
      }
    }
  }

  if (!volumeRaycaster) {
    initVolumeRaycaster();
  }
  if (volumeRaycaster) {
    volumeRaycaster.uploadVolume(float32Data, nx, ny, nz);
  }
}

function applyImageState(img: VolumeImage, preserveSlices = false) {
  header = img.header;
  computeViewFlips();
  volumeData = img.data;
  dataSlope = img.slope;
  dataInter = img.inter;
  globalMin = img.min;
  globalMax = img.max;
  fileName = img.name;
  img.lastAccess = Date.now();
  tryUploadVolume3D();
  if (!preserveSlices && img.preview) {
    setCurrentSlice('axial', new Float32Array(img.preview.axial), img.header.nx, img.header.ny, 1);
    setCurrentSlice('coronal', new Float32Array(img.preview.coronal), img.header.nx, img.header.nz, 1);
    setCurrentSlice('sagittal', new Float32Array(img.preview.sagittal), img.header.ny, img.header.nz, 1);
  }
}

async function loadVolumeViaWorker(loadKey: string, url: string, gz: boolean, progress?: (msg: any) => void): Promise<any> {
  const worker = new Worker(await ensureWorkerBlobUrl());
  const requestId = nextStreamRequestId++;
  return new Promise((resolve, reject) => {
    volumeWorkers.set(loadKey, worker);
    publishPerfMonitor();
    const cleanup = () => {
      if (volumeWorkers.get(loadKey) === worker) volumeWorkers.delete(loadKey);
      worker.terminate();
      publishPerfMonitor();
    };
    worker.onmessage = (ev) => {
      const msg = ev.data;
      if (msg.id !== requestId) return;
      if (msg.type === 'progress' || msg.type === 'preview') {
        progress?.(msg);
        return;
      }
      if (msg.type === 'cancelled') {
        cleanup();
        reject(makeAbortError());
        return;
      }
      if (msg.type === 'error') {
        cleanup();
        reject(new Error(msg.error || 'Load failed'));
        return;
      }
      if (msg.type === 'volume') {
        cleanup();
        resolve(msg);
      }
    };
    worker.onerror = (err) => {
      cleanup();
      reject(new Error(err.message || 'Worker error'));
    };
    worker.postMessage({ id: requestId, type: 'loadVolume', url, isGzip: gz });
  });
}

function scheduleActiveImageLoad(index: number): void {
  if (activeLoadDebounceTimer) {
    window.clearTimeout(activeLoadDebounceTimer);
    activeLoadDebounceTimer = null;
  }
  scheduledActiveIndex = index;
  publishPerfMonitor();
  activeLoadDebounceTimer = window.setTimeout(() => {
    activeLoadDebounceTimer = null;
    if (scheduledActiveIndex !== index || activeImageIdx !== index) return;
    void ensureImageData(index, 'active').catch((err) => {
      if ((err as any)?.name !== 'AbortError') {
        console.error('Failed to activate image:', err);
      }
    });
  }, ACTIVE_FULL_LOAD_DEBOUNCE_MS);
}

async function ensureImageData(index: number, priority: VolumeLoadPriority = 'background'): Promise<void> {
  const img = images[index];
  if (!img) return;
  const loadKey = img.url;
  await reprioritizeVolumeLoad(loadKey, priority);
  if (img.data) {
    img.lastAccess = Date.now();
    evictInactiveImageData([index, activeImageIdx]);
    return;
  }
  if (img.loadPromise) {
    await img.loadPromise;
    return;
  }
  img.state = 'loading';
  img.loadPromise = queueVolumeLoad(loadKey, async () => {
    const startedAt = performance.now();
    let lastError: unknown = null;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const result = await loadVolumeViaWorker(loadKey, img.url, img.url.endsWith('.gz'), (msg) => {
          if (index === activeImageIdx && msg.type === 'progress') {
            updateProgress(0.5 + msg.value * 0.5, undefined, msg.stage ? `${msg.stage}...` : undefined);
          }
        });
        img.header = result.header;
        img.data = result.voxelData;
        img.min = result.globalMin;
        img.max = result.globalMax;
        img.slope = result.slope || 1;
        img.inter = result.inter || 0;
        img.state = 'ready';
        img.lastAccess = Date.now();
        perfMonitor.fullLoads.push(performance.now() - startedAt);
        publishPerfMonitor();
        if (index === activeImageIdx) {
          applyImageState(img, true);
          updateFileInfo();
          updateSliderValues();
          renderAllViews();
          updateImagePicker();
        }
        evictInactiveImageData([index, activeImageIdx]);
        return;
      } catch (err) {
        if ((err as any)?.name === 'AbortError') throw err;
        lastError = err;
      }
    }
    perfMonitor.failures++;
    publishPerfMonitor();
    throw lastError;
  }, priority).catch((err) => {
    img.state = (err as any)?.name === 'AbortError' ? 'preview' : 'error';
    throw err;
  }).finally(() => {
    img.loadPromise = undefined;
  });
  await img.loadPromise;
}

function setCurrentSlice(axis: Axis, data: Float32Array, width: number, height: number, factor = 1) {
  currentSlices[axis] = { data, width, height, factor };
}

function getAxisGeometry(axis: Axis, hdr: NiiHeader = header!): { width: number; height: number; pixelW: number; pixelH: number; maxIndex: number } {
  if (axis === 'axial') {
    return { width: hdr.nx, height: hdr.ny, pixelW: hdr.nx * hdr.dx, pixelH: hdr.ny * hdr.dy, maxIndex: hdr.nz - 1 };
  }
  if (axis === 'coronal') {
    return { width: hdr.nx, height: hdr.nz, pixelW: hdr.nx * hdr.dx, pixelH: hdr.nz * hdr.dz, maxIndex: hdr.ny - 1 };
  }
  return { width: hdr.ny, height: hdr.nz, pixelW: hdr.ny * hdr.dy, pixelH: hdr.nz * hdr.dz, maxIndex: hdr.nx - 1 };
}

function getActiveDownsample(): number {
  const quality = bandwidthEstimator.qualityLevel;
  if (perfProfile.tier === 'low' || quality === 'low') return 4;
  if (perfProfile.tier === 'medium' || quality === 'medium') return 2;
  return 1;
}

async function requestSliceFrame(axis: Axis, factor = 1): Promise<void> {
  if (!header) return;
  // Abort any previous slice request for this axis
  const prevController = sliceAbortControllers.get(axis);
  if (prevController) prevController.abort();
  const controller = new AbortController();
  sliceAbortControllers.set(axis, controller);
  const signal = controller.signal;

  const pool = await getSlicePool();
  const geometry = getAxisGeometry(axis);
  try {
    const response = await pool.dispatch<{
      type: 'slice';
      axis: Axis;
      index: number;
      factor: number;
      width: number;
      height: number;
      data: Float32Array;
    }>({
      type: 'fetchSlice',
      url: fileUrl,
      axis,
      index: sliceIdx[axis],
      factor,
      prefetch: PRELOAD_RANGE,
      maxIndex: geometry.maxIndex,
      signal,
    });
    if (signal.aborted) return;
    if (response.index !== sliceIdx[axis]) return;
    setCurrentSlice(axis, response.data, response.width || geometry.width, response.height || geometry.height, response.factor);
  } catch (err: any) {
    if (err?.name === 'AbortError') return;
    throw err;
  }
}

async function refreshSlices(axes: Axis[], interactive = false) {
  if (!header) return;
  const factor = interactive ? getActiveDownsample() : 1;
  await Promise.all(axes.map((axis) => requestSliceFrame(axis, factor)));
  renderAllViews();
  if (interactive && factor > 1) {
    for (const axis of axes) {
      if (sliceQualityTimers[axis]) window.clearTimeout(sliceQualityTimers[axis]);
      sliceQualityTimers[axis] = window.setTimeout(() => {
        requestSliceFrame(axis, 1).then(() => renderAllViews()).catch(() => {});
      }, 120);
    }
  }
}

function extractSlice(axis: 'axial' | 'coronal' | 'sagittal', idx: number): Float32Array {
  if (!header || !volumeData) return new Float32Array(0);
  const { nx, ny, nz } = header;
  const src = volumeData;
  const s = dataSlope;
  const t = dataInter;
  const needScale = s !== 1 || t !== 0;

  if (axis === 'axial') {
    const slice = float32Pool.acquire(nx * ny);
    const base = idx * ny * nx;
    if (needScale) {
      for (let i = 0; i < nx * ny; i++) slice[i] = src[base + i] * s + t;
    } else {
      for (let i = 0; i < nx * ny; i++) slice[i] = src[base + i];
    }
    return slice;
  } else if (axis === 'coronal') {
    const slice = float32Pool.acquire(nx * nz);
    for (let z = 0; z < nz; z++) {
      const base = z * ny * nx + idx * nx;
      if (needScale) {
        for (let x = 0; x < nx; x++) slice[z * nx + x] = src[base + x] * s + t;
      } else {
        for (let x = 0; x < nx; x++) slice[z * nx + x] = src[base + x];
      }
    }
    return slice;
  } else {
    const slice = float32Pool.acquire(ny * nz);
    for (let z = 0; z < nz; z++) {
      const base = z * ny * nx;
      if (needScale) {
        for (let y = 0; y < ny; y++) slice[z * ny + y] = src[base + y * nx + idx] * s + t;
      } else {
        for (let y = 0; y < ny; y++) slice[z * ny + y] = src[base + y * nx + idx];
      }
    }
    return slice;
  }
}

function computeMIP(rotX: number, rotY: number): Float32Array {
  if (!header || !volumeData) return new Float32Array(0);
  const { nx, ny, nz, dx, dy, dz } = header;
  const outW = nx;
  const outH = ny;
  const mip = new Float32Array(outW * outH);
  mip.fill(-Infinity);

  const cosX = Math.cos(rotX), sinX = Math.sin(rotX);
  const cosY = Math.cos(rotY), sinY = Math.sin(rotY);

  const aspectX = dx, aspectY = dy, aspectZ = dz;
  const maxAspect = Math.max(aspectX, aspectY, aspectZ);
  const sx = aspectX / maxAspect, sy = aspectY / maxAspect, sz = aspectZ / maxAspect;

  const step = Math.max(1, Math.floor(Math.min(nx, ny, nz) / 80));

  for (let z = 0; z < nz; z += step) {
    const zc = (z - nz / 2) * sz;
    for (let y = 0; y < ny; y += step) {
      const yc = (y - ny / 2) * sy;
      for (let x = 0; x < nx; x += step) {
        const xc = (x - nx / 2) * sx;

        const x1 = xc * cosY + zc * sinY;
        const z1 = -xc * sinY + zc * cosY;
        const y1 = yc * cosX - z1 * sinX;

        const px = Math.round(nx / 2 + x1 / sx);
        const py = Math.round(ny / 2 + y1 / sy);

        if (px >= 0 && px < outW && py >= 0 && py < outH) {
          const v = volumeData[z * ny * nx + y * nx + x] * dataSlope + dataInter;
          const idx = py * outW + px;
          if (v > mip[idx]) mip[idx] = v;
        }
      }
    }
  }

  for (let i = 0; i < mip.length; i++) {
    if (mip[i] === -Infinity) mip[i] = globalMin;
  }

  return mip;
}

const sliceImageDataCache: Record<string, ImageData> = {};

function pruneSliceCache(): void {
  if (sliceRenderCache.size <= MAX_SLICE_CACHE) return;
  const entries = [...sliceRenderCache.entries()].sort((a, b) => a[1].timestamp - b[1].timestamp);
  const toRemove = entries.slice(0, entries.length - MAX_SLICE_CACHE);
  for (const [key] of toRemove) {
    sliceRenderCache.delete(key);
  }
}

function getCachedSliceRender(axis: string, idx: number): HTMLCanvasElement | null {
  const key = `${axis}:${idx}:${colormap}:${windowWidth}:${windowLevel}`;
  const cached = sliceRenderCache.get(key);
  if (cached) {
    cached.timestamp = Date.now();
    return cached.canvas;
  }
  return null;
}

function setCachedSliceRender(axis: string, idx: number, canvas: HTMLCanvasElement): void {
  const key = `${axis}:${idx}:${colormap}:${windowWidth}:${windowLevel}`;
  sliceRenderCache.set(key, { canvas, timestamp: Date.now() });
  pruneSliceCache();
}

// ── Prefetch Priority Queue ──────────────────────────────────────────
type PrefetchPriority = 'high' | 'medium' | 'low';

interface PrefetchJob {
  axis: string;
  sliceIdx: number;
  priority: PrefetchPriority;
  priorityValue: number; // numeric for sorting: high=3, medium=2, low=1
  cancelled: boolean;
}

class PrefetchPriorityQueue {
  private queue: PrefetchJob[] = [];
  private activeCount = 0;
  private maxActive = 2;

  enqueue(job: PrefetchJob): void {
    this.queue.push(job);
    this.queue.sort((a, b) => b.priorityValue - a.priorityValue);
    this.processNext();
  }

  cancelByAxisAndDirection(axis: string, behindStart: number, behindEnd: number): void {
    for (const job of this.queue) {
      if (job.axis === axis && job.sliceIdx >= behindStart && job.sliceIdx <= behindEnd) {
        job.cancelled = true;
      }
    }
  }

  promoteHighPriority(axis: string, slices: number[]): void {
    for (const job of this.queue) {
      if (job.axis === axis && slices.includes(job.sliceIdx) && job.priority !== 'high') {
        job.priority = 'high';
        job.priorityValue = 3;
      }
    }
    this.queue.sort((a, b) => b.priorityValue - a.priorityValue);
  }

  clear(): void {
    for (const job of this.queue) job.cancelled = true;
    this.queue.length = 0;
  }

  private processNext(): void {
    while (this.queue.length > 0 && this.activeCount < this.maxActive) {
      const job = this.queue.shift()!;
      if (job.cancelled) continue;
      this.activeCount++;
      this.executeJob(job).finally(() => {
        this.activeCount--;
        this.processNext();
      });
    }
  }

  private async executeJob(job: PrefetchJob): Promise<void> {
    if (job.cancelled || !header || !volumeData) return;
    const cacheKey = `${job.axis}:${job.sliceIdx}:${colormap}:${windowWidth}:${windowLevel}`;
    if (sliceRenderCache.has(cacheKey)) {
      prefetchStats.recordHit();
      return;
    }
    await new Promise<void>(resolve => {
      requestIdleCallback(() => {
        if (job.cancelled || !header || !volumeData) { resolve(); return; }
        const { nx, ny, nz, dx, dy, dz } = header;
        const slice = extractSlice(job.axis as 'axial' | 'coronal' | 'sagittal', job.sliceIdx);
        let w: number, h: number;
        if (job.axis === 'axial') { w = nx; h = ny; }
        else if (job.axis === 'coronal') { w = nx; h = nz; }
        else { w = ny; h = nz; }

        const tc = document.createElement('canvas');
        tc.width = w; tc.height = h;
        const tctx = tc.getContext('2d')!;
        const imgData = tctx.createImageData(w, h);
        const pixels = imgData.data;
        const cmapFn = COLORMAPS[colormap] || COLORMAPS.gray;
        const lo = windowLevel - windowWidth * 0.5;
        const range = windowWidth || 1;
        const dataRange = globalMax - globalMin || 1;
        const n = w * h;

        // Apply window/level normalization to Uint8
        const normalized = new Uint8Array(n);
        const wasm = getWasmBindings();
        if (wasm && slice instanceof Float32Array) {
          normalized.set(wasm.applyWindowLevel(slice, lo, range, globalMin, globalMax));
        } else {
          for (let i = 0; i < n; i++) {
            const norm = (slice[i] - globalMin) / dataRange;
            const t = Math.max(0, Math.min(1, (norm - lo) / range));
            normalized[i] = (t * 255 + 0.5) | 0;
          }
        }

        // Apply colormap to normalized values
        for (let i = 0; i < n; i++) {
          const t = normalized[i] / 255;
          const [r, g, b] = cmapFn(t);
          const idx4 = i * 4;
          pixels[idx4] = r; pixels[idx4 + 1] = g; pixels[idx4 + 2] = b; pixels[idx4 + 3] = 255;
        }
        tctx.putImageData(imgData, 0, 0);
        setCachedSliceRender(job.axis, job.sliceIdx, tc);
        float32Pool.release(slice);
        resolve();
      });
    });
  }
}

// ── Prefetch Statistics ──────────────────────────────────────────────
const prefetchStats = {
  hits: 0,
  misses: 0,
  waste: 0,
  _prefetchedSlices: new Set<string>(),

  recordPrefetch(axis: string, idx: number): void {
    this._prefetchedSlices.add(`${axis}:${idx}`);
  },

  recordHit(): void { this.hits++; },

  recordMiss(axis: string, idx: number): void {
    const key = `${axis}:${idx}`;
    if (!this._prefetchedSlices.has(key)) {
      this.misses++;
    }
  },

  recordWaste(axis: string, idx: number): void {
    const key = `${axis}:${idx}`;
    if (this._prefetchedSlices.has(key)) {
      this.waste++;
      this._prefetchedSlices.delete(key);
    }
  },

  reset(): void {
    this.hits = 0;
    this.misses = 0;
    this.waste = 0;
    this._prefetchedSlices.clear();
  },

  getStats() {
    return { hits: this.hits, misses: this.misses, waste: this.waste };
  },
};

// ── Predictive Prefetcher ────────────────────────────────────────────
class PredictivePrefetcher {
  private lastSlice: Record<string, number> = {};
  private lastTime: Record<string, number> = {};
  private velocity: Record<string, number> = {}; // slices per 100ms (EMA)
  private priorityQueue = new PrefetchPriorityQueue();

  onSliceChange(axis: string, sliceIndex: number): number {
    const now = performance.now();
    const prevSlice = this.lastSlice[axis] ?? sliceIndex;
    const prevTime = this.lastTime[axis] ?? now;
    const dt = now - prevTime; // ms

    if (dt > 0 && prevTime > 0) {
      // velocity in slices per 100ms
      const instantVelocity = (sliceIndex - prevSlice) / (dt / 100);
      // EMA: α = 0.3
      this.velocity[axis] = this.velocity[axis] * 0.7 + instantVelocity * 0.3;
    }

    this.lastSlice[axis] = sliceIndex;
    this.lastTime[axis] = now;

    // Record miss if this slice wasn't prefetched
    const cacheKey = `${axis}:${sliceIndex}:${colormap}:${windowWidth}:${windowLevel}`;
    if (!sliceRenderCache.has(cacheKey)) {
      prefetchStats.recordMiss(axis, sliceIndex);
    } else {
      prefetchStats.recordHit();
    }

    // Cancel prefetches behind the scroll direction
    const direction = this.getDirection(axis);
    const behindStart = direction > 0 ? 0 : sliceIndex + 1;
    const behindEnd = direction > 0 ? sliceIndex - 1 : (axis === 'axial' ? (header?.nz ?? 0) - 1 : axis === 'coronal' ? (header?.ny ?? 0) - 1 : (header?.nx ?? 0) - 1);
    if (behindEnd >= behindStart) {
      this.priorityQueue.cancelByAxisAndDirection(axis, behindStart, behindEnd);
    }

    return this.getPrefetchRange(axis);
  }

  getPrefetchRange(axis: string): number {
    const v = Math.abs(this.velocity[axis] || 0); // slices/100ms
    if (v > 3) return 15; // fast scrolling
    if (v >= 1) return 8;  // medium scrolling
    return 3;              // slow scrolling
  }

  getDirection(axis: string): 1 | -1 {
    return (this.velocity[axis] || 0) >= 0 ? 1 : -1;
  }

  getQueue(): PrefetchPriorityQueue {
    return this.priorityQueue;
  }
}

const prefetcher = new PredictivePrefetcher();

function preloadSlices(axis: 'axial' | 'coronal' | 'sagittal', currentIdx: number): void {
  // No prefetch needed for 3D texture mode (GPU already has all data)
  if (renderBackend === 'webgl3d' || renderBackend === 'webgpu') return;
  if (!header || !volumeData) return;
  const max = axis === 'axial' ? header.nz : axis === 'coronal' ? header.ny : header.nx;
  const prefetchRange = prefetcher.onSliceChange(axis, currentIdx);
  const direction = prefetcher.getDirection(axis);
  const queue = prefetcher.getQueue();

  // Issue prefetch requests with priority
  // High priority: 1-2 slices ahead
  // Medium priority: 3-5 slices ahead
  // Low priority: 6-15 slices ahead
  for (let d = 1; d <= prefetchRange; d++) {
    const idx = currentIdx + d * direction;
    if (idx < 0 || idx >= max) continue;
    const cacheKey = `${axis}:${idx}:${colormap}:${windowWidth}:${windowLevel}`;
    if (sliceRenderCache.has(cacheKey)) continue;

    prefetchStats.recordPrefetch(axis, idx);

    let priority: PrefetchPriority;
    let priorityValue: number;
    if (d <= 2) { priority = 'high'; priorityValue = 3; }
    else if (d <= 5) { priority = 'medium'; priorityValue = 2; }
    else { priority = 'low'; priorityValue = 1; }

    queue.enqueue({ axis, sliceIdx: idx, priority, priorityValue, cancelled: false });
  }

  // Also prefetch a small range behind (1-2 slices) at low priority
  for (let d = 1; d <= 2; d++) {
    const idx = currentIdx - d * direction;
    if (idx < 0 || idx >= max) continue;
    const cacheKey = `${axis}:${idx}:${colormap}:${windowWidth}:${windowLevel}`;
    if (sliceRenderCache.has(cacheKey)) continue;

    prefetchStats.recordPrefetch(axis, idx);
    queue.enqueue({ axis, sliceIdx: idx, priority: 'low', priorityValue: 1, cancelled: false });
  }
}

function getOrCreateRenderer(axis: Axis): WebGLRenderer | null {
  if (viewerConfig.renderBackend !== 'webgl' || !perfProfile.gpuAvailable) return null;
  const existing = glRenderers[axis];
  if (existing?.isReady()) return existing;
  const renderer = new WebGLRenderer();
  if (!renderer.init(canvases[axis])) return null;
  glRenderers[axis] = renderer;
  return renderer;
}

async function getOrCreateWebGPURenderer(axis: Axis): Promise<WebGPURenderer | null> {
  if (!webgpuChecked) {
    webgpuAvailable = await WebGPURenderer.isAvailable();
    webgpuChecked = true;
  }
  if (!webgpuAvailable) return null;

  const existing = webgpuRenderers[axis];
  if (existing?.isReady()) return existing;

  const renderer = new WebGPURenderer();
  const ok = await renderer.init(canvases[axis]);
  if (!ok) return null;
  webgpuRenderers[axis] = renderer;
  return renderer;
}

function initVolumeRaycaster(): boolean {
  if (volumeRaycaster) return volumeRaycaster.isReady();
  const axialCanvas = canvases.axial;
  if (!axialCanvas) return false;
  volumeRaycaster = new VolumeRaycaster();
  return volumeRaycaster.init(axialCanvas);
}

function renderVolume3D(): void {
  if (!volumeRaycaster || !volumeRaycaster.isReady() || !header) return;

  const canvas = canvases.axial;
  if (!canvas) return;
  const dpr = window.devicePixelRatio || 1;
  const container = canvas.parentElement!;
  canvas.width = container.clientWidth * dpr;
  canvas.height = container.clientHeight * dpr;

  const aspect = canvas.width / canvas.height;
  const fov = Math.PI / 4;
  const near = 0.1;
  const far = 10.0;
  const f = 1.0 / Math.tan(fov / 2);

  const projMatrix = new Float32Array(16);
  projMatrix[0] = f / aspect;
  projMatrix[5] = f;
  projMatrix[10] = (far + near) / (near - far);
  projMatrix[11] = -1;
  projMatrix[14] = (2 * far * near) / (near - far);

  // Build view matrix: translate back, then apply arcball rotation
  const viewMatrix = new Float32Array(16);
  // Start with rotation
  for (let i = 0; i < 16; i++) viewMatrix[i] = volumeRotationMatrix[i];
  // Apply translation in column 3
  viewMatrix[12] = 0;
  viewMatrix[13] = 0;
  viewMatrix[14] = -3.0 / volumeZoom;
  viewMatrix[15] = 1;

  volumeRaycaster.render(viewMatrix, projMatrix, windowLevel - windowWidth * 0.5, windowWidth || 1);
}

function setupVolumeInteraction(): void {
  const canvas = canvases.axial;
  if (!canvas) return;

  canvas.addEventListener('mousedown', (e: MouseEvent) => {
    if (renderMode !== 'volume') return;
    isDraggingVolume = true;
    lastVolumeMouseX = e.clientX;
    lastVolumeMouseY = e.clientY;
  });

  window.addEventListener('mousemove', (e: MouseEvent) => {
    if (!isDraggingVolume) return;
    const dx = e.clientX - lastVolumeMouseX;
    const dy = e.clientY - lastVolumeMouseY;
    lastVolumeMouseX = e.clientX;
    lastVolumeMouseY = e.clientY;

    // Arcball rotation: map mouse coords to NDC
    const rect = canvas!.getBoundingClientRect();
    const prevX = (2 * (e.clientX - dx - rect.left)) / rect.width - 1;
    const prevY = 1 - (2 * (e.clientY - dy - rect.top)) / rect.height;
    const currX = (2 * (e.clientX - rect.left)) / rect.width - 1;
    const currY = 1 - (2 * (e.clientY - rect.top)) / rect.height;

    const deltaRot = VolumeRaycaster.arcballRotation(prevX, prevY, currX, currY);
    volumeRotationMatrix = multiply4x4(deltaRot, volumeRotationMatrix);
    renderVolume3D();
  });

  window.addEventListener('mouseup', () => {
    isDraggingVolume = false;
  });

  canvas.addEventListener('wheel', (e: WheelEvent) => {
    if (renderMode !== 'volume') return;
    e.preventDefault();
    volumeZoom *= e.deltaY > 0 ? 0.9 : 1.1;
    volumeZoom = Math.max(0.1, Math.min(10, volumeZoom));
    renderVolume3D();
  }, { passive: false });
}

function multiply4x4(a: Float32Array, b: Float32Array): Float32Array {
  const out = new Float32Array(16);
  for (let i = 0; i < 4; i++) {
    for (let j = 0; j < 4; j++) {
      out[i * 4 + j] = 0;
      for (let k = 0; k < 4; k++) {
        out[i * 4 + j] += a[i * 4 + k] * b[k * 4 + j];
      }
    }
  }
  return out;
}

function paintSlice(axis: string, data: Float32Array, w: number, h: number, pixelW: number, pixelH: number) {
  fpsCounter.recordFrame();

  if (renderMode === 'volume' && axis === 'axial' && volumeRaycaster?.isReady()) {
    renderVolume3D();
    return;
  }
  if (renderMode === 'volume') return;

  const canvas = canvases[axis as keyof typeof canvases];
  if (!canvas || !data || data.length === 0) return;

  const vs = viewState[axis as keyof typeof viewState] as { zoom: number; panX: number; panY: number };
  const zoom = vs.zoom;
  const panX = vs.panX;
  const panY = vs.panY;

  const dpr = window.devicePixelRatio || 1;
  const container = canvas.parentElement!;
  const dw = container.clientWidth;
  const dh = container.clientHeight;
  if (dw === 0 || dh === 0) return;

  const ar = pixelW / pixelH;
  let cw: number, ch: number;
  if (dw / dh > ar) { ch = dh; cw = Math.floor(dh * ar); }
  else { cw = dw; ch = Math.floor(dw / ar); }

  cw = Math.floor(cw * zoom);
  ch = Math.floor(ch * zoom);

  canvas.style.width = dw + 'px';
  canvas.style.height = dh + 'px';
  canvas.width = dw * dpr;
  canvas.height = dh * dpr;

  const renderer = getOrCreateRenderer(axis as Axis);
  const flips = viewFlips[axis] || { flipX: false, flipY: false };

  if (renderBackend === 'webgpu' && !webgpuChecked) {
    getOrCreateWebGPURenderer(axis as Axis).then(() => {});
  }

  // Try 3D texture paths (WebGPU or WebGL2) when volume is uploaded
  if (renderBackend !== 'canvas2d' && renderBackend !== 'webgl2d' && renderer && renderer.isVolume3DReady() && header) {
    const axisIdx = axis === 'axial' ? 0 : axis === 'coronal' ? 1 : 2;

    // OffscreenCanvas path: delegate rendering to worker via render request queue
    if (offscreenCanvasEnabled[axis as Axis]) {
      enqueueRenderRequest({
        axis: axis as Axis,
        sliceIndex: sliceIdx[axis as Axis],
        windowLevel: windowLevel - windowWidth * 0.5,
        windowWidth: windowWidth || 1,
        colormap,
        flipX: flips.flipX,
        flipY: flips.flipY,
      });
      updateDirectionLabels(axis);
      updateCrosshair(axis, w, h, zoom, panX, panY, cw, ch);
      updateScaleBar(axis, pixelW, pixelH, zoom, cw);
      updateMinimap(axis, w, h, zoom, panX, panY, cw, ch);
      return;
    }

    const webgpuRenderer = webgpuRenderers[axis as Axis];
    if (renderBackend === 'webgpu' && webgpuRenderer && webgpuRenderer.isReady() && webgpuRenderer.renderSlice3D(
      axisIdx, sliceIdx[axis as Axis], header.nx, header.ny, header.nz,
      windowLevel - windowWidth * 0.5, windowWidth || 1, colormap, flips.flipX, flips.flipY
    )) {
      updateDirectionLabels(axis);
      updateCrosshair(axis, w, h, zoom, panX, panY, cw, ch);
      updateScaleBar(axis, pixelW, pixelH, zoom, cw);
      updateMinimap(axis, w, h, zoom, panX, panY, cw, ch);
      return;
    }

    if (renderer.renderSlice3D(canvas, axisIdx, sliceIdx[axis as Axis], header.nx, header.ny, header.nz, windowLevel - windowWidth * 0.5, windowWidth || 1, colormap, flips.flipX, flips.flipY)) {
      updateDirectionLabels(axis);
      updateCrosshair(axis, w, h, zoom, panX, panY, cw, ch);
      updateScaleBar(axis, pixelW, pixelH, zoom, cw);
      updateMinimap(axis, w, h, zoom, panX, panY, cw, ch);
      return;
    }
  }

  // Fallback to 2D rendering when volume3D is not ready (still loading) or 3D path failed
  // renderSlice() handles zoom/pan via canvas transform, so no zoom/pan restriction needed
  if (renderBackend !== 'canvas2d' && renderer && data && data.length > 0 && renderer.renderSlice(canvas, data, w, h, windowLevel - windowWidth * 0.5, windowWidth || 1, colormap, flips.flipX, flips.flipY)) {
    updateDirectionLabels(axis);
    updateCrosshair(axis, w, h, zoom, panX, panY, cw, ch);
    updateScaleBar(axis, pixelW, pixelH, zoom, cw);
    updateMinimap(axis, w, h, zoom, panX, panY, cw, ch);
    return;
  }

  const ctx = canvas.getContext('2d')!;
  ctx.imageSmoothingEnabled = false;

  const cacheKey = axis;
  let imgData = sliceImageDataCache[cacheKey];
  if (!imgData || imgData.width !== w || imgData.height !== h) {
    imgData = ctx.createImageData(w, h);
    sliceImageDataCache[cacheKey] = imgData;
  }
  const pixels = imgData.data;
  const cmapFn = COLORMAPS[colormap] || COLORMAPS.gray;
  const lo = windowLevel - windowWidth * 0.5;
  const range = windowWidth || 1;
  const dataRange = globalMax - globalMin || 1;
  const n = w * h;

  // Apply window/level normalization to Uint8
  // Try WASM SIMD path first (4x parallel f32 processing)
  const normalized = new Uint8Array(n);
  const wasm = getWasmBindings();
  if (wasm && data instanceof Float32Array) {
    normalized.set(wasm.applyWindowLevel(data, lo, range, globalMin, globalMax));
  } else {
    for (let i = 0; i < n; i++) {
      const norm = (data[i] - globalMin) / dataRange;
      const t = Math.max(0, Math.min(1, (norm - lo) / range));
      normalized[i] = (t * 255 + 0.5) | 0;
    }
  }

  // Apply colormap to normalized values
  for (let i = 0; i < n; i++) {
    const t = normalized[i] / 255;
    const [r, g, b] = cmapFn(t);
    const idx = i * 4;
    pixels[idx] = r; pixels[idx + 1] = g; pixels[idx + 2] = b; pixels[idx + 3] = 255;
  }

  const tc = document.createElement('canvas');
  tc.width = w; tc.height = h;
  const tctx = tc.getContext('2d')!;
  tctx.putImageData(imgData, 0, 0);

  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  const imgLeft = (dw - cw) / 2 + panX;
  const imgTop = (dh - ch) / 2 + panY;
  const finalScaleX = flips.flipX ? -cw * dpr / w : cw * dpr / w;
  const finalScaleY = flips.flipY ? ch * dpr / h : -ch * dpr / h;
  const finalOffsetX = flips.flipX ? (imgLeft + cw) * dpr : imgLeft * dpr;
  const finalOffsetY = flips.flipY ? imgTop * dpr : (imgTop + ch) * dpr;

  ctx.save();
  ctx.translate(finalOffsetX, finalOffsetY);
  ctx.scale(finalScaleX, finalScaleY);
  ctx.drawImage(tc, 0, 0);
  ctx.restore();

  updateDirectionLabels(axis);
  updateCrosshair(axis, w, h, zoom, panX, panY, cw, ch);
  updateScaleBar(axis, pixelW, pixelH, zoom, cw);
  updateMinimap(axis, w, h, zoom, panX, panY, cw, ch);
}

// ITK-Snap style: Get dominant anatomical axis and direction from a srow vector
// Returns { axis: 0(R/L), 1(A/P), 2(S/I), dir: 1(+), -1(-) }
function getAnatomicalAxisDir(srow: number[]): { axis: number, dir: number } {
  // Find which anatomical axis this direction vector is aligned with
  const abs0 = Math.abs(srow[0]), abs1 = Math.abs(srow[1]), abs2 = Math.abs(srow[2]);
  let domIdx = 0;
  if (abs1 > abs0) domIdx = 1;
  if (abs2 > abs0 && abs2 > abs1) domIdx = 2;

  // The sign: positive is R/A/S, negative is L/P/I
  const dir = srow[domIdx] >= 0 ? 1 : -1;

  // domIdx 0 = R/L axis, 1 = A/P axis, 2 = S/I axis
  return { axis: domIdx, dir };
}

// Compute orientation string from sform matrix (ITK-SNAP approach)
// Analyzes the direction cosines from the sform matrix to determine
// anatomical orientation (L/R, A/P, S/I) for each axis
function computeOrientationFromSform(srow_x: number[], srow_y: number[], srow_z: number[]): string {
  // RAI codes: positive directions are R, A, S; negative are L, P, I
  const raiPositive = ['R', 'A', 'S'];
  const raiNegative = ['L', 'P', 'I'];

  // Build direction matrix (columns are the srow vectors)
  const directionMatrix = [
    [srow_x[0], srow_y[0], srow_z[0]],
    [srow_x[1], srow_y[1], srow_z[1]],
    [srow_x[2], srow_y[2], srow_z[2]],
  ];

  let result = '';
  for (let i = 0; i < 3; i++) {
    // Get the direction of the i-th voxel coordinate (column i)
    const dirI = [directionMatrix[0][i], directionMatrix[1][i], directionMatrix[2][i]];
    const absDir = [Math.abs(dirI[0]), Math.abs(dirI[1]), Math.abs(dirI[2])];
    const maxAbs = Math.max(absDir[0], absDir[1], absDir[2]);

    // ITK-SNAP trick: visit (i,i) first for tie-breaking
    let found = false;
    for (let off = 0; off < 3; off++) {
      const j = (i + off) % 3;
      if (Math.abs(dirI[j]) === maxAbs) {
        result += dirI[j] > 0 ? raiPositive[j] : raiNegative[j];
        found = true;
        break;
      }
    }
    if (!found) result += '?';
  }

  return result;
}

// Compute orientation from qform quaternion (ITK-SNAP/niivue approach)
// Reconstructs the rotation matrix from the quaternion (b, c, d) and
// derives the srow vectors, then uses the same column-based analysis
function computeOrientationFromQform(h: any): string {
  const qb = h.quatern_b || 0;
  const qc = h.quatern_c || 0;
  const qd = h.quatern_d || 0;
  const qa = Math.sqrt(Math.max(0, 1.0 - qb * qb - qc * qc - qd * qd));

  // Quaternion rotation matrix
  const srow_x = [
    qa * qa + qb * qb - qc * qc - qd * qd,
    2 * (qb * qc - qa * qd),
    2 * (qb * qd + qa * qc),
  ];
  const srow_y = [
    2 * (qb * qc + qa * qd),
    qa * qa - qb * qb + qc * qc - qd * qd,
    2 * (qc * qd - qa * qb),
  ];
  const srow_z = [
    2 * (qb * qd - qa * qc),
    2 * (qc * qd + qa * qb),
    qa * qa - qb * qb - qc * qc + qd * qd,
  ];

  // Apply voxel sizes
  const dx = h.dx || 1, dy = h.dy || 1, dz = h.dz || 1;
  const scaled_x = srow_x.map((v, i) => v * [dx, dy, dz][i]);
  const scaled_y = srow_y.map((v, i) => v * [dx, dy, dz][i]);
  const scaled_z = srow_z.map((v, i) => v * [dx, dy, dz][i]);

  return computeOrientationFromSform(scaled_x, scaled_y, scaled_z);
}

function computeViewFlips() {
  if (!header) return;
  const srow_x = header.srow_x;
  const srow_y = header.srow_y;
  const srow_z = header.srow_z;

  const xDir = getAnatomicalAxisDir(srow_x);
  const yDir = getAnatomicalAxisDir(srow_y);
  const zDir = getAnatomicalAxisDir(srow_z);

  viewFlips.axial = {
    flipX: xDir.dir > 0,
    flipY: yDir.dir < 0
  };

  viewFlips.coronal = {
    flipX: xDir.dir > 0,
    flipY: zDir.dir < 0
  };

  viewFlips.sagittal = {
    flipX: yDir.dir > 0,
    flipY: zDir.dir < 0
  };
}

// ITK-Snap style letter mapping: [anatomical axis][direction index]
// direction 0 = negative (L/P/I), direction 1 = positive (R/A/S)
const letters: string[][] = [["L", "R"], ["P", "A"], ["I", "S"]];

// Compute orientation labels from sform matrix (ITK-SNAP approach)
// Analyzes direction cosines to determine anatomical orientation for each view axis
function getCoordLabelX(axis: string): { left: string; right: string } {
  if (!header || !header.srow_x || !header.srow_y || !header.srow_z) {
    // Fallback to hardcoded defaults
    if (axis === 'sagittal') return { left: 'A', right: 'P' };
    return { left: 'R', right: 'L' };
  }

  // Determine which srow vector corresponds to the screen X axis
  let srow: number[];
  if (axis === 'axial') {
    srow = header.srow_x; // X axis on axial = voxel X
  } else if (axis === 'coronal') {
    srow = header.srow_x; // X axis on coronal = voxel X
  } else {
    srow = header.srow_y; // X axis on sagittal = voxel Y
  }

  const dirInfo = getAnatomicalAxisDir(srow);
  const flips = viewFlips[axis] || { flipX: false, flipY: false };

  // The label depends on the dominant anatomical direction and whether we flip
  // dirInfo.dir > 0 means the voxel axis goes in the positive anatomical direction (R/A/S)
  // When flipX is true, we reverse the display, so left/right swap
  const positiveLabel = letters[dirInfo.axis][1]; // R, A, or S
  const negativeLabel = letters[dirInfo.axis][0]; // L, P, or I

  if (dirInfo.dir > 0) {
    // Voxel axis goes positive (R/A/S direction)
    // Without flip: left=negative, right=positive
    // With flip: left=positive, right=negative
    return flips.flipX
      ? { left: positiveLabel, right: negativeLabel }
      : { left: negativeLabel, right: positiveLabel };
  } else {
    // Voxel axis goes negative (L/P/I direction)
    // Without flip: left=positive, right=negative
    // With flip: left=negative, right=positive
    return flips.flipX
      ? { left: negativeLabel, right: positiveLabel }
      : { left: positiveLabel, right: negativeLabel };
  }
}

function getCoordLabelY(axis: string): { top: string; bottom: string } {
  if (!header || !header.srow_x || !header.srow_y || !header.srow_z) {
    // Fallback to hardcoded defaults
    if (axis === 'axial') return { top: 'A', bottom: 'P' };
    return { top: 'S', bottom: 'I' };
  }

  // Determine which srow vector corresponds to the screen Y axis
  let srow: number[];
  if (axis === 'axial') {
    srow = header.srow_y; // Y axis on axial = voxel Y
  } else if (axis === 'coronal') {
    srow = header.srow_z; // Y axis on coronal = voxel Z
  } else {
    srow = header.srow_z; // Y axis on sagittal = voxel Z
  }

  const dirInfo = getAnatomicalAxisDir(srow);
  const flips = viewFlips[axis] || { flipX: false, flipY: false };

  const positiveLabel = letters[dirInfo.axis][1]; // R, A, or S
  const negativeLabel = letters[dirInfo.axis][0]; // L, P, or I

  // Screen Y: top is lower pixel index, bottom is higher
  // dirInfo.dir > 0 means voxel axis goes positive anatomical direction
  // flipY reverses the display vertically
  if (dirInfo.dir > 0) {
    // Voxel axis goes positive (R/A/S)
    // Without flip: top=positive, bottom=negative (image row 0 = top = positive end)
    // With flip: top=negative, bottom=positive
    return flips.flipY
      ? { top: negativeLabel, bottom: positiveLabel }
      : { top: positiveLabel, bottom: negativeLabel };
  } else {
    // Voxel axis goes negative (L/P/I)
    // Without flip: top=negative, bottom=positive
    // With flip: top=positive, bottom=negative
    return flips.flipY
      ? { top: positiveLabel, bottom: negativeLabel }
      : { top: negativeLabel, bottom: positiveLabel };
  }
}

function updateCrosshair(axis: string, w: number, h: number, zoom: number, panX: number, panY: number, cw: number, ch: number) {
  const container = canvases[axis as keyof typeof canvases]?.parentElement;
  if (!container) return;
  const crosshair = container.querySelector('.crosshair') as HTMLDivElement;
  const crosshairH = container.querySelector('.crosshair-h') as HTMLDivElement;
  const crosshairV = container.querySelector('.crosshair-v') as HTMLDivElement;
  if (!crosshair || !crosshairH || !crosshairV) return;

  crosshair.style.display = crosshairVisible ? 'block' : 'none';
  if (!crosshairVisible || !header) return;

  const cursorX = sliceIdx.sagittal;
  const cursorY = sliceIdx.coronal;
  const cursorZ = sliceIdx.axial;

  let sliceX: number, sliceY: number;

  if (axis === 'axial') {
    sliceX = cursorX;
    sliceY = cursorY;
  } else if (axis === 'coronal') {
    sliceX = cursorX;
    sliceY = cursorZ;
  } else {
    sliceX = cursorY;
    sliceY = cursorZ;
  }

  const nx_axis = axis === 'sagittal' ? header.ny : header.nx;
  const ny_axis = axis === 'sagittal' ? header.nz : (axis === 'coronal' ? header.nz : header.ny);
  const cx_norm = sliceX / (nx_axis - 1 || 1);
  const cy_norm = sliceY / (ny_axis - 1 || 1);

  const containerRect = container.getBoundingClientRect();

  const pixelW = axis === 'axial' ? header.nx * header.dx : axis === 'coronal' ? header.nx * header.dx : header.ny * header.dy;
  const pixelH = axis === 'axial' ? header.ny * header.dy : axis === 'coronal' ? header.nz * header.dz : header.nz * header.dz;
  const ar = pixelW / pixelH;
  let imgW: number, imgH: number;
  if (containerRect.width / containerRect.height > ar) { imgH = containerRect.height; imgW = imgH * ar; }
  else { imgW = containerRect.width; imgH = imgW / ar; }
  imgW *= zoom;
  imgH *= zoom;

  const imgLeft = (containerRect.width - imgW) / 2 + panX;
  const imgTop = (containerRect.height - imgH) / 2 + panY;

  const flips = viewFlips[axis] || { flipX: false, flipY: false };
  const screenX = flips.flipX ? imgLeft + (1 - cx_norm) * imgW : imgLeft + cx_norm * imgW;
  const screenY = flips.flipY ? imgTop + cy_norm * imgH : imgTop + (1 - cy_norm) * imgH;

  crosshairH.style.top = screenY + 'px';
  crosshairV.style.left = screenX + 'px';
}

function updateScaleBar(axis: string, pixelW: number, pixelH: number, zoom: number, cw: number) {
  if (!header) return;
  const container = canvases[axis as keyof typeof canvases]?.parentElement;
  if (!container) return;
  const scaleBar = container.querySelector('.scale-bar') as HTMLDivElement;
  if (!scaleBar || cw <= 0) return;

  const mmPerScreenPixel = (pixelW * zoom) / cw;

  const targetWidth = Math.min(50, cw * 0.35);
  const niceValues = [1, 2, 5, 10, 20, 50, 100, 200];

  const maxMm = targetWidth * mmPerScreenPixel;

  let barMm = 1;
  for (const v of niceValues) {
    if (v <= maxMm) barMm = v;
    else break;
  }

  const barPixels = barMm / mmPerScreenPixel;

  scaleBar.style.width = barPixels + 'px';
  const label = scaleBar.querySelector('span');
  if (label) {
    label.textContent = `${barMm}mm`;
  }
}

function updateMinimap(axis: string, w: number, h: number, zoom: number, panX: number, panY: number, cw: number, ch: number) {
  const container = canvases[axis as keyof typeof canvases]?.parentElement;
  if (!container) return;
  const minimap = container.querySelector('.minimap') as HTMLDivElement;
  const minimapCanvas = minimap?.querySelector('.minimap-canvas') as HTMLCanvasElement;
  const rect = minimap?.querySelector('.minimap-rect') as HTMLDivElement;
  if (!minimap || !rect) return;

  if (zoom <= 1.1) {
    minimap.classList.add('hidden');
    return;
  }
  minimap.classList.remove('hidden');

  const mw = minimap.clientWidth;
  const mh = minimap.clientHeight;
  
  if (minimapCanvas && header) {
    const sliceData = extractSlice(axis as 'axial' | 'coronal' | 'sagittal', sliceIdx[axis as keyof typeof sliceIdx]);
    if (sliceData && sliceData.length > 0) {
      const mctx = minimapCanvas.getContext('2d');
      if (mctx) {
        minimapCanvas.width = mw;
        minimapCanvas.height = mh;

        const imgData = mctx.createImageData(mw, mh);
        const pixels = imgData.data;
        const cmapFn = COLORMAPS[colormap] || COLORMAPS.gray;
        const lo = windowLevel - windowWidth * 0.5;
        const hi = windowLevel + windowWidth * 0.5;
        const range = hi - lo || 1;
        const dataRange = globalMax - globalMin || 1;

        const mflips = viewFlips[axis] || { flipX: false, flipY: false };
        for (let my = 0; my < mh; my++) {
          for (let mx = 0; mx < mw; mx++) {
            const sx = mflips.flipX ? w - 1 - Math.floor((mx / mw) * w) : Math.floor((mx / mw) * w);
            const sy = mflips.flipY ? Math.floor((my / mh) * h) : h - 1 - Math.floor((my / mh) * h);
            const v = sliceData[sy * w + sx];
            const norm = (v - globalMin) / dataRange;
            const t = Math.max(0, Math.min(1, (norm - lo) / range));
            const [r, g, b] = cmapFn(t);
            const idx = (my * mw + mx) * 4;
            pixels[idx] = r; pixels[idx + 1] = g; pixels[idx + 2] = b; pixels[idx + 3] = 255;
          }
        }
        mctx.putImageData(imgData, 0, 0);
      }
      float32Pool.release(sliceData);
    }
  }

  const rw = mw / zoom;
  const rh = mh / zoom;

  const dw = container.clientWidth;
  const dh = container.clientHeight;
  const maxPanX = Math.max(0, (cw - dw) / 2);
  const maxPanY = Math.max(0, (ch - dh) / 2);

  const rawNormPanX = maxPanX > 0 ? (panX + maxPanX) / (2 * maxPanX) : 0.5;
  const rawNormPanY = maxPanY > 0 ? (panY + maxPanY) / (2 * maxPanY) : 0.5;
  const normPanX = 1 - rawNormPanX;
  const normPanY = 1 - rawNormPanY;

  const rx = Math.max(0, Math.min(mw - rw, normPanX * mw - rw / 2));
  const ry = Math.max(0, Math.min(mh - rh, normPanY * mh - rh / 2));

  rect.style.width = rw + 'px';
  rect.style.height = rh + 'px';
  rect.style.left = rx + 'px';
  rect.style.top = ry + 'px';
}

function updateDirectionLabels(axis: string) {
  const container = canvases[axis as keyof typeof canvases]?.parentElement;
  if (!container) return;

  const labels = container.querySelectorAll('.dir-label');
  const labelsX = getCoordLabelX(axis);
  const labelsY = getCoordLabelY(axis);

  labels.forEach(label => {
    const el = label as HTMLElement;
    const pos = el.className.split(' ').find(c => c.startsWith('dir-'));
    if (pos === 'dir-l') el.textContent = labelsX.left;
    else if (pos === 'dir-r') el.textContent = labelsX.right;
    else if (pos === 'dir-a') el.textContent = labelsY.top;
    else if (pos === 'dir-p') el.textContent = labelsY.bottom;
  });
}

function updateAllDirectionLabels() {
  updateDirectionLabels('axial');
  updateDirectionLabels('coronal');
  updateDirectionLabels('sagittal');
}

function renderAllViews() {
  if (!header) return;
  const { nx, ny, nz, dx, dy, dz } = header;

  if (!compareMode) {
    ['axial', 'coronal', 'sagittal'].forEach(axis => {
      const label = document.getElementById(`overlay-label-${axis}`);
      if (label) label.style.display = 'none';
      const sbsL = document.getElementById(`sbs-l-${axis}`);
      const sbsR = document.getElementById(`sbs-r-${axis}`);
      if (sbsL) sbsL.style.display = 'none';
      if (sbsR) sbsR.style.display = 'none';
    });
  }

  if (compareMode && images.length >= 2 && volumeData) {
    renderCompareViews();
    return;
  }

  if (volumeData) {
    paintSlice('axial', extractSlice('axial', sliceIdx.axial), nx, ny, nx * dx, ny * dy);
    paintSlice('coronal', extractSlice('coronal', sliceIdx.coronal), nx, nz, nx * dx, nz * dz);
    paintSlice('sagittal', extractSlice('sagittal', sliceIdx.sagittal), ny, nz, ny * dy, nz * dz);
    paintMIP();
  } else {
    // LOD-aware rendering: use best available LOD level
    for (const axis of ['axial', 'coronal', 'sagittal'] as const) {
      const lodLevel = currentLOD[axis];
      const lod = lodData[lodLevel];
      const lodSlice = lod?.[axis];
      const fallback = currentSlices[axis];

      if (enableLOD && lodSlice) {
        const pixelW = axis === 'sagittal' ? ny * dy : nx * dx;
        const pixelH = axis === 'axial' ? ny * dy : nz * dz;
        paintSlice(axis, lodSlice.data, lodSlice.w, lodSlice.h, pixelW, pixelH);
      } else if (fallback) {
        const pixelW = axis === 'sagittal' ? ny * dy : nx * dx;
        const pixelH = axis === 'axial' ? ny * dy : nz * dz;
        paintSlice(axis, fallback.data, fallback.width, fallback.height, pixelW, pixelH);
      }
    }
  }

  updateAllInfo();
  if (crosshairVisible) updateCoordInfoFromCenter();
  drawMeasurements();

  if (volumeData) {
    preloadSlices('axial', sliceIdx.axial);
    preloadSlices('coronal', sliceIdx.coronal);
    preloadSlices('sagittal', sliceIdx.sagittal);
  }
}

function updateCoordInfoFromCenter() {
  const coordEl = document.getElementById('coord-info');
  if (!coordEl || !header) return;

  const cx = sliceIdx.sagittal;
  const cy = sliceIdx.coronal;
  const cz = sliceIdx.axial;

  if (compareMode && images.length >= 2) {
    const img0 = images[0];
    const img1 = images[1];
    if (!img0.data || !img1.data) {
      coordEl.textContent = '';
      return;
    }
    const h0 = img0.header;
    const h1 = img1.header;
    if (cx < 0 || cx >= h0.nx || cy < 0 || cy >= h0.ny || cz < 0 || cz >= h0.nz) {
      coordEl.textContent = '';
      return;
    }
    const v0 = img0.data[cz * h0.ny * h0.nx + cy * h0.nx + cx] * img0.slope + img0.inter;
    const [wx, wy, wz] = voxelToWorld(h0, cx, cy, cz);
    const [vx1, vy1, vz1] = worldToVoxel(h1, wx, wy, wz);
    const ix1 = Math.round(vx1), iy1 = Math.round(vy1), iz1 = Math.round(vz1);
    let v1 = '---';
    if (ix1 >= 0 && ix1 < h1.nx && iy1 >= 0 && iy1 < h1.ny && iz1 >= 0 && iz1 < h1.nz) {
      v1 = (img1.data[iz1 * h1.ny * h1.nx + iy1 * h1.nx + ix1] * img1.slope + img1.inter).toFixed(4);
    }
    coordEl.textContent = `x=${cx} y=${cy} z=${cz}\n${img0.name}: ${v0.toFixed(4)}\n${img1.name}: ${v1}`;
    return;
  }

  if (cx < 0 || cx >= header.nx || cy < 0 || cy >= header.ny || cz < 0 || cz >= header.nz) {
    coordEl.textContent = '';
    return;
  }
  let val: number;
  if (volumeData) {
    val = volumeData[cz * header.ny * header.nx + cy * header.nx + cx] * dataSlope + dataInter;
  } else if (currentSlices.axial) {
    val = currentSlices.axial.data[cy * currentSlices.axial.width + cx];
  } else {
    coordEl.textContent = '';
    return;
  }
  coordEl.textContent = `x=${cx} y=${cy} z=${cz}\nValue: ${val.toFixed(4)}`;
}

function extractSliceFromImage(img: VolumeImage, axis: 'axial' | 'coronal' | 'sagittal', idx: number): Float32Array {
  const savedHeader = header;
  const savedData = volumeData;
  const savedSlope = dataSlope;
  const savedInter = dataInter;
  header = img.header;
  volumeData = img.data;
  dataSlope = img.slope;
  dataInter = img.inter;
  const maxIdx = axis === 'axial' ? img.header.nz - 1 : axis === 'coronal' ? img.header.ny - 1 : img.header.nx - 1;
  const slice = extractSlice(axis, Math.max(0, Math.min(maxIdx, idx)));
  header = savedHeader;
  volumeData = savedData;
  dataSlope = savedSlope;
  dataInter = savedInter;
  return slice;
}

function renderCompareViews(changedAxis?: 'axial' | 'coronal' | 'sagittal') {
  if (images.length < 2) return;
  const img0 = images[0];
  const img1 = images[1];
  const h0 = img0.header;
  const h1 = img1.header;

  const [wx, wy, wz] = voxelToWorld(h0, sliceIdx.sagittal, sliceIdx.coronal, sliceIdx.axial);
  const [vx1, vy1, vz1] = worldToVoxel(h1, wx, wy, wz);
  const img1Idx = {
    axial: Math.max(0, Math.min(h1.nz - 1, Math.round(vz1))),
    coronal: Math.max(0, Math.min(h1.ny - 1, Math.round(vy1))),
    sagittal: Math.max(0, Math.min(h1.nx - 1, Math.round(vx1))),
  };

  const axes: ('axial' | 'coronal' | 'sagittal')[] = changedAxis ? [changedAxis] : ['axial', 'coronal', 'sagittal'];
  for (const axis of axes) {
    const idx0 = axis === 'axial' ? sliceIdx.axial : axis === 'coronal' ? sliceIdx.coronal : sliceIdx.sagittal;
    const slice0 = extractSliceFromImage(img0, axis, idx0);
    const slice1 = extractSliceFromImage(img1, axis, img1Idx[axis]);
    const w0 = axis === 'sagittal' ? h0.ny : h0.nx;
    const h0_ = axis === 'axial' ? h0.ny : h0.nz;
    const pw0 = axis === 'sagittal' ? h0.ny * h0.dy : h0.nx * h0.dx;
    const ph0 = axis === 'axial' ? h0.ny * h0.dy : h0.nz * h0.dz;
    const w1 = axis === 'sagittal' ? h1.ny : h1.nx;
    const h1_ = axis === 'axial' ? h1.ny : h1.nz;
    const pw1 = axis === 'sagittal' ? h1.ny * h1.dy : h1.nx * h1.dx;
    const ph1 = axis === 'axial' ? h1.ny * h1.dy : h1.nz * h1.dz;

    if (compareLayout === 'sideBySide') {
      paintSideBySideSlice(axis, slice0, slice1, w0, h0_, w1, h1_, pw0, ph0, pw1, ph1, img0, img1);
    } else {
      paintOverlaySlice(axis, slice0, slice1, w0, h0_, w1, h1_, pw0, ph0, pw1, ph1, img0, img1);
    }

    const overlayLabel = document.getElementById(`overlay-label-${axis}`);
    if (overlayLabel) {
      overlayLabel.textContent = img1.name;
      overlayLabel.style.display = compareLayout === 'overlay' ? '' : 'none';
    }
    const sbsL = document.getElementById(`sbs-l-${axis}`);
    const sbsR = document.getElementById(`sbs-r-${axis}`);
    if (sbsL) { sbsL.textContent = img0.name; sbsL.style.display = compareLayout === 'sideBySide' ? '' : 'none'; }
    if (sbsR) { sbsR.textContent = img1.name; sbsR.style.display = compareLayout === 'sideBySide' ? '' : 'none'; }
  }
  if (!changedAxis) {
    paintMIP();
    updateAllInfo();
  }
}

function renderSliceToTempCanvas(data: Float32Array, w: number, h: number, imgMin: number, imgMax: number, cmapName: string, useGlobalWindow?: boolean): HTMLCanvasElement {
  const tc = document.createElement('canvas');
  tc.width = w; tc.height = h;
  const tctx = tc.getContext('2d')!;
  const imgData = tctx.createImageData(w, h);
  const pixels = imgData.data;
  const cmapFn = COLORMAPS[cmapName] || COLORMAPS.gray;
  const dataRange = imgMax - imgMin || 1;
  const n = w * h;

  if (useGlobalWindow) {
    const lo = windowLevel - windowWidth * 0.5;
    const hi = windowLevel + windowWidth * 0.5;
    const range = hi - lo || 1;
    for (let i = 0; i < n; i++) {
      const norm = (data[i] - imgMin) / dataRange;
      const t = Math.max(0, Math.min(1, (norm - lo) / range));
      const [r, g, b] = cmapFn(t);
      const idx = i * 4;
      pixels[idx] = r; pixels[idx + 1] = g; pixels[idx + 2] = b; pixels[idx + 3] = 255;
    }
  } else {
    for (let i = 0; i < n; i++) {
      const norm = (data[i] - imgMin) / dataRange;
      const t = Math.max(0, Math.min(1, norm));
      const [r, g, b] = cmapFn(t);
      const idx = i * 4;
      pixels[idx] = r; pixels[idx + 1] = g; pixels[idx + 2] = b; pixels[idx + 3] = 255;
    }
  }
  tctx.putImageData(imgData, 0, 0);
  return tc;
}

function resampleOverlaySlice(
  img0: VolumeImage, img1: VolumeImage,
  axis: 'axial' | 'coronal' | 'sagittal',
  sliceIdx0: number
): Float32Array {
  const h0 = img0.header;
  const h1 = img1.header;
  const d0 = img0.data;
  const d1 = img1.data;

  let outW: number, outH: number;
  if (axis === 'axial') { outW = h0.nx; outH = h0.ny; }
  else if (axis === 'coronal') { outW = h0.nx; outH = h0.nz; }
  else { outW = h0.ny; outH = h0.nz; }

  const result = new Float32Array(outW * outH);
  if (!d0 || !d1) return result;

  const n1x = h1.nx, n1y = h1.ny, n1z = h1.nz;
  const elem1 = h1.datatype === 64 ? 8 : h1.datatype === 8 || h1.datatype === 16 || h1.datatype === 768 ? 4 : h1.datatype === 4 || h1.datatype === 512 ? 2 : 1;
  const slope1 = img1.slope || 1;
  const inter1 = img1.inter || 0;

  const getVoxel1 = (vx: number, vy: number, vz: number): number => {
    const ix = Math.round(vx), iy = Math.round(vy), iz = Math.round(vz);
    if (ix < 0 || ix >= n1x || iy < 0 || iy >= n1y || iz < 0 || iz >= n1z) return NaN;
    const idx = iz * n1y * n1x + iy * n1x + ix;
    return (d1 as any)[idx] * slope1 + inter1;
  };

  const getVoxel1Lerp = (vx: number, vy: number, vz: number): number => {
    if (vx < -0.5 || vx > n1x - 0.5 || vy < -0.5 || vy > n1y - 0.5 || vz < -0.5 || vz > n1z - 0.5) return NaN;
    const x0 = Math.floor(vx), y0 = Math.floor(vy), z0 = Math.floor(vz);
    const x1 = Math.min(x0 + 1, n1x - 1), y1 = Math.min(y0 + 1, n1y - 1), z1 = Math.min(z0 + 1, n1z - 1);
    const fx = vx - x0, fy = vy - y0, fz = vz - z0;
    const cx0 = Math.max(0, x0), cy0 = Math.max(0, y0), cz0 = Math.max(0, z0);

    const v000 = (d1 as any)[cz0 * n1y * n1x + cy0 * n1x + cx0] * slope1 + inter1;
    const v100 = (d1 as any)[cz0 * n1y * n1x + cy0 * n1x + x1] * slope1 + inter1;
    const v010 = (d1 as any)[cz0 * n1y * n1x + y1 * n1x + cx0] * slope1 + inter1;
    const v110 = (d1 as any)[cz0 * n1y * n1x + y1 * n1x + x1] * slope1 + inter1;
    const v001 = (d1 as any)[z1 * n1y * n1x + cy0 * n1x + cx0] * slope1 + inter1;
    const v101 = (d1 as any)[z1 * n1y * n1x + cy0 * n1x + x1] * slope1 + inter1;
    const v011 = (d1 as any)[z1 * n1y * n1x + y1 * n1x + cx0] * slope1 + inter1;
    const v111 = (d1 as any)[z1 * n1y * n1x + y1 * n1x + x1] * slope1 + inter1;

    const c00 = v000 * (1 - fx) + v100 * fx;
    const c10 = v010 * (1 - fx) + v110 * fx;
    const c01 = v001 * (1 - fx) + v101 * fx;
    const c11 = v011 * (1 - fx) + v111 * fx;
    const c0 = c00 * (1 - fy) + c10 * fy;
    const c1 = c01 * (1 - fy) + c11 * fy;
    return c0 * (1 - fz) + c1 * fz;
  };

  for (let j = 0; j < outH; j++) {
    for (let i = 0; i < outW; i++) {
      let vx0: number, vy0: number, vz0: number;
      if (axis === 'axial') {
        vx0 = i; vy0 = j; vz0 = sliceIdx0;
      } else if (axis === 'coronal') {
        vx0 = i; vy0 = sliceIdx0; vz0 = j;
      } else {
        vx0 = sliceIdx0; vy0 = i; vz0 = j;
      }

      const [wx, wy, wz] = voxelToWorld(h0, vx0, vy0, vz0);
      const [vx1, vy1, vz1] = worldToVoxel(h1, wx, wy, wz);

      const val = getVoxel1Lerp(vx1, vy1, vz1);
      result[j * outW + i] = isNaN(val) ? 0 : val;
    }
  }

  return result;
}

function paintOverlaySlice(axis: string, data0: Float32Array, data1: Float32Array,
  w0: number, h0_: number, w1: number, h1_: number,
  pw0: number, ph0: number, pw1: number, ph1: number,
  img0: VolumeImage, img1: VolumeImage) {
  const canvas = canvases[axis as keyof typeof canvases];
  if (!canvas || !data0) return;

  const vs = viewState[axis as keyof typeof viewState] as { zoom: number; panX: number; panY: number };
  const zoom = vs.zoom;
  const dpr = window.devicePixelRatio || 1;
  const container = canvas.parentElement!;
  const dw = container.clientWidth;
  const dh = container.clientHeight;
  if (dw === 0 || dh === 0) return;

  // Use unified physical extent for consistent overlay alignment
  const unifiedPW = Math.max(pw0, pw1);
  const unifiedPH = Math.max(ph0, ph1);
  const ar = unifiedPW / unifiedPH;
  let cw: number, ch: number;
  if (dw / dh > ar) { ch = dh; cw = Math.floor(dh * ar); }
  else { cw = dw; ch = Math.floor(dw / ar); }
  cw = Math.floor(cw * zoom);
  ch = Math.floor(ch * zoom);

  canvas.style.width = cw + 'px';
  canvas.style.height = ch + 'px';
  canvas.width = cw * dpr;
  canvas.height = ch * dpr;

  const ctx = canvas.getContext('2d')!;
  ctx.imageSmoothingEnabled = false;

  const tc0 = renderSliceToTempCanvas(data0, w0, h0_, img0.min, img0.max, colormap, true);

  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  const offsetX = (canvas.width - cw * dpr) / 2;
  const offsetY = (canvas.height + ch * dpr) / 2;

  // Draw base image (img0) scaled to unified physical extent
  ctx.save();
  ctx.translate(offsetX, offsetY);
  ctx.scale(cw * dpr / w0, -ch * dpr / h0_);
  ctx.globalAlpha = 1.0;
  ctx.drawImage(tc0, 0, 0);
  ctx.restore();

  // Draw overlay image (img1) using pre-registered data1
  if (data1 && data1.length > 0) {
    const tc1 = renderSliceToTempCanvas(data1, w1, h1_, img1.min, img1.max, overlayColormap);

    ctx.save();
    ctx.translate(offsetX, offsetY);
    ctx.scale(cw * dpr / w1, -ch * dpr / h1_);
    ctx.globalAlpha = overlayOpacity;
    ctx.drawImage(tc1, 0, 0);
    ctx.restore();
  }

  ctx.globalAlpha = 1.0;

  updateDirectionLabels(axis);
  updateCrosshair(axis, w0, h0_, zoom, vs.panX, vs.panY, cw, ch);
  updateScaleBar(axis, pw0, ph0, zoom, cw);
  updateMinimap(axis, w0, h0_, zoom, vs.panX, vs.panY, cw, ch);
}

function paintSideBySideSlice(axis: string, data0: Float32Array, data1: Float32Array,
  w0: number, h0_: number, w1: number, h1_: number,
  pw0: number, ph0: number, pw1: number, ph1: number,
  img0: VolumeImage, img1: VolumeImage) {
  const canvas = canvases[axis as keyof typeof canvases];
  if (!canvas || !data0 || !data1) return;

  const vs = viewState[axis as keyof typeof viewState] as { zoom: number; panX: number; panY: number };
  const zoom = vs.zoom;
  const dpr = window.devicePixelRatio || 1;
  const container = canvas.parentElement!;
  const dw = container.clientWidth;
  const dh = container.clientHeight;
  if (dw === 0 || dh === 0) return;

  const halfW = Math.floor(dw / 2);

  // Unified physical extent for consistent registration display
  const unifiedPW = Math.max(pw0, pw1);
  const unifiedPH = Math.max(ph0, ph1);
  const unifiedAR = unifiedPW / unifiedPH;

  // Both images use the same display size based on unified physical extent
  let cw: number, ch: number;
  if (halfW / dh > unifiedAR) { ch = dh; cw = Math.floor(dh * unifiedAR); }
  else { cw = halfW; ch = Math.floor(halfW / unifiedAR); }
  cw = Math.floor(cw * zoom);
  ch = Math.floor(ch * zoom);

  canvas.style.width = dw + 'px';
  canvas.style.height = dh + 'px';
  canvas.width = dw * dpr;
  canvas.height = dh * dpr;

  const ctx = canvas.getContext('2d')!;
  ctx.imageSmoothingEnabled = false;

  const tc0 = renderSliceToTempCanvas(data0, w0, h0_, img0.min, img0.max, colormap);
  const tc1 = renderSliceToTempCanvas(data1, w1, h1_, img1.min, img1.max, overlayColormap);

  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  // Left half: img0 with unified scale
  const offsetX0 = (halfW * dpr - cw * dpr) / 2;
  const offsetY0 = (dh * dpr + ch * dpr) / 2;
  ctx.save();
  ctx.translate(offsetX0, offsetY0);
  ctx.scale(cw * dpr / w0, -ch * dpr / h0_);
  ctx.drawImage(tc0, 0, 0);
  ctx.restore();

  // Right half: img1 with unified scale (same physical size as img0)
  const offsetX1 = halfW * dpr + (halfW * dpr - cw * dpr) / 2;
  const offsetY1 = (dh * dpr + ch * dpr) / 2;
  ctx.save();
  ctx.translate(offsetX1, offsetY1);
  ctx.scale(cw * dpr / w1, -ch * dpr / h1_);
  ctx.drawImage(tc1, 0, 0);
  ctx.restore();

  ctx.strokeStyle = 'rgba(233,69,96,0.7)';
  ctx.lineWidth = 2 * dpr;
  ctx.beginPath();
  ctx.moveTo(halfW * dpr, 0);
  ctx.lineTo(halfW * dpr, dh * dpr);
  ctx.stroke();

  if (crosshairVisible && img0.header) {
    const h0 = img0.header;
    const cursorX = sliceIdx.sagittal;
    const cursorY = sliceIdx.coronal;
    const cursorZ = sliceIdx.axial;
    let sliceX0: number, sliceY0: number;
    if (axis === 'axial') { sliceX0 = cursorX; sliceY0 = cursorY; }
    else if (axis === 'coronal') { sliceX0 = cursorX; sliceY0 = cursorZ; }
    else { sliceX0 = cursorY; sliceY0 = cursorZ; }
    const nx0 = axis === 'sagittal' ? h0.ny : h0.nx;
    const ny0 = axis === 'sagittal' ? h0.nz : (axis === 'coronal' ? h0.nz : h0.ny);
    const cx0 = sliceX0 / (nx0 - 1 || 1);
    const cy0 = sliceY0 / (ny0 - 1 || 1);

    // Use unified cw/ch for crosshair positioning
    const imgLeft0 = (halfW - cw) / 2 - vs.panX;
    const imgTop0 = (dh - ch) / 2 - vs.panY;
    const sx0 = (imgLeft0 + cx0 * cw) * dpr;
    const sy0 = (imgTop0 + (1 - cy0) * ch) * dpr;

    ctx.strokeStyle = 'rgba(255,0,0,0.6)';
    ctx.lineWidth = 1 * dpr;
    ctx.beginPath();
    ctx.moveTo(0, sy0); ctx.lineTo(halfW * dpr, sy0);
    ctx.moveTo(sx0, 0); ctx.lineTo(sx0, dh * dpr);
    ctx.stroke();

    const h1 = img1.header;
    const [wx, wy, wz] = voxelToWorld(h0, cursorX, cursorY, cursorZ);
    const [vx1, vy1, vz1] = worldToVoxel(h1, wx, wy, wz);
    let sliceX1: number, sliceY1: number;
    if (axis === 'axial') { sliceX1 = Math.round(vx1); sliceY1 = Math.round(vy1); }
    else if (axis === 'coronal') { sliceX1 = Math.round(vx1); sliceY1 = Math.round(vz1); }
    else { sliceX1 = Math.round(vy1); sliceY1 = Math.round(vz1); }
    const nx1 = axis === 'sagittal' ? h1.ny : h1.nx;
    const ny1 = axis === 'sagittal' ? h1.nz : (axis === 'coronal' ? h1.nz : h1.ny);
    const cx1 = Math.max(0, Math.min(1, sliceX1 / (nx1 - 1 || 1)));
    const cy1 = Math.max(0, Math.min(1, sliceY1 / (ny1 - 1 || 1)));

    // Use unified cw/ch for crosshair positioning
    const imgLeft1 = halfW + (halfW - cw) / 2 - vs.panX;
    const imgTop1 = (dh - ch) / 2 - vs.panY;
    const sx1 = (imgLeft1 + cx1 * cw) * dpr;
    const sy1 = (imgTop1 + (1 - cy1) * ch) * dpr;

    ctx.strokeStyle = 'rgba(255,200,0,0.6)';
    ctx.lineWidth = 1 * dpr;
    ctx.beginPath();
    ctx.moveTo(halfW * dpr, sy1); ctx.lineTo(dw * dpr, sy1);
    ctx.moveTo(sx1, 0); ctx.lineTo(sx1, dh * dpr);
    ctx.stroke();
  }

  const vc = canvas.parentElement!;
  const htmlCrosshair = vc.querySelector('.crosshair') as HTMLDivElement;
  if (htmlCrosshair) htmlCrosshair.style.display = 'none';

  updateDirectionLabels(axis);
  updateScaleBar(axis, pw0, ph0, zoom, cw);
  updateMinimap(axis, w0, h0_, zoom, vs.panX, vs.panY, cw, ch);
}

function paintMIP() {
  if (!header || !volumeData) return;
  const { nx, ny, nz, dx, dy, dz } = header;
  const mipData = computeMIP(viewState.mip.rotationX, viewState.mip.rotationY);

  const scaleCorr = dz / Math.sqrt(dx * dy);
  const pixelW = nx * dx * scaleCorr;
  const pixelH = ny * dy;

  const canvas = canvases.mip;
  const dpr = window.devicePixelRatio || 1;
  const container = canvas.parentElement!;
  const dw = container.clientWidth;
  const dh = container.clientHeight;
  if (dw === 0 || dh === 0) return;

  const ar = pixelW / pixelH;
  let cw: number, ch: number;
  if (dw / dh > ar) { ch = dh; cw = Math.floor(dh * ar); }
  else { cw = dw; ch = Math.floor(dw / ar); }

  canvas.style.width = cw + 'px';
  canvas.style.height = ch + 'px';
  canvas.width = cw * dpr;
  canvas.height = ch * dpr;

  const ctx = canvas.getContext('2d')!;
  ctx.imageSmoothingEnabled = false;

  const imgData = ctx.createImageData(nx, ny);
  const pixels = imgData.data;
  const cmapFn = COLORMAPS[colormap] || COLORMAPS.gray;
  const lo = windowLevel - windowWidth * 0.5;
  const hi = windowLevel + windowWidth * 0.5;
  const range = hi - lo || 1;
  const dataRange = globalMax - globalMin || 1;

  for (let i = 0; i < nx * ny; i++) {
    const norm = (mipData[i] - globalMin) / dataRange;
    const t = Math.max(0, Math.min(1, (norm - lo) / range));
    const [r, g, b] = cmapFn(t);
    const idx = i * 4;
    pixels[idx] = r; pixels[idx + 1] = g; pixels[idx + 2] = b; pixels[idx + 3] = 255;
  }

  const tc = document.createElement('canvas');
  tc.width = nx; tc.height = ny;
  const tctx = tc.getContext('2d')!;
  tctx.putImageData(imgData, 0, 0);
  
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(tc, 0, 0, canvas.width, canvas.height);
}

function updateSingleView(axis: 'axial' | 'coronal' | 'sagittal') {
  if (!header) return;
  const { nx, ny, nz, dx, dy, dz } = header;

  if (compareMode && images.length >= 2) {
    renderCompareViews(axis);
    updateSliceInfo(axis);
    updateSliderValues();
    if (crosshairVisible) updateCoordInfoFromCenter();
    return;
  }

  if (volumeData) {
    if (axis === 'axial') {
      paintSlice('axial', extractSlice('axial', sliceIdx.axial), nx, ny, nx * dx, ny * dy);
    } else if (axis === 'coronal') {
      paintSlice('coronal', extractSlice('coronal', sliceIdx.coronal), nx, nz, nx * dx, nz * dz);
    } else {
      paintSlice('sagittal', extractSlice('sagittal', sliceIdx.sagittal), ny, nz, ny * dy, nz * dz);
    }
  } else {
    // LOD-aware rendering for single view update
    const lodLevel = currentLOD[axis];
    const lod = lodData[lodLevel];
    const lodSlice = lod?.[axis];
    const fallback = currentSlices[axis];

    const pixelW = axis === 'sagittal' ? ny * dy : nx * dx;
    const pixelH = axis === 'axial' ? ny * dy : nz * dz;

    if (enableLOD && lodSlice) {
      paintSlice(axis, lodSlice.data, lodSlice.w, lodSlice.h, pixelW, pixelH);
    } else if (fallback) {
      paintSlice(axis, fallback.data, fallback.width, fallback.height, pixelW, pixelH);
    }
  }

  updateSliceInfo(axis);
  updateSliderValues();
  if (crosshairVisible) updateCoordInfoFromCenter();

  if (volumeData) preloadSlices(axis, sliceIdx[axis]);
}

function updateAllInfo() {
  if (!header) return;
  updateSliceInfo('axial');
  updateSliceInfo('coronal');
  updateSliceInfo('sagittal');
  updateSliderValues();
}

function updateSliceInfo(axis: 'axial' | 'coronal' | 'sagittal') {
  if (!header) return;
  const el = document.getElementById(`${axis}-info`);
  if (!el) return;
  const max = axis === 'axial' ? header.nz : axis === 'coronal' ? header.ny : header.nx;
  el.textContent = `${sliceIdx[axis] + 1}/${max}`;
}

function updateSliderValues() {
  if (!header) return;

  const sliders = [
    { axis: 'axial', slider: 'axial-slider', sideSlider: 'axial-slider-side', val: 'axial-val', max: header.nz - 1 },
    { axis: 'coronal', slider: 'coronal-slider', sideSlider: 'coronal-slider-side', val: 'coronal-val', max: header.ny - 1 },
    { axis: 'sagittal', slider: 'sagittal-slider', sideSlider: 'sagittal-slider-side', val: 'sagittal-val', max: header.nx - 1 },
  ];

  for (const s of sliders) {
    const sl = document.getElementById(s.slider) as HTMLInputElement;
    const ssl = document.getElementById(s.sideSlider) as HTMLInputElement;
    const vl = document.getElementById(s.val) as HTMLSpanElement;
    if (sl) { sl.max = String(s.max); sl.value = String(sliceIdx[s.axis as keyof typeof sliceIdx]); }
    if (ssl) { ssl.max = String(s.max); ssl.value = String(sliceIdx[s.axis as keyof typeof sliceIdx]); }
    if (vl) vl.textContent = String(sliceIdx[s.axis as keyof typeof sliceIdx]);
  }
}

function updateFileInfo() {
  if (!header) return;
  const { nx, ny, nz, nt, dx, dy, dz, datatype, isGzip: gz } = header;
  const dtName = DATATYPE_NAMES[datatype] ?? `dt=${datatype}`;

  const fileNameEl = document.getElementById('file-name') as HTMLSpanElement;
  const fileDetailEl = document.getElementById('file-detail') as HTMLDivElement;
  const formatBadge = document.getElementById('format-badge') as HTMLSpanElement;

  if (fileNameEl) fileNameEl.textContent = fileName;
  if (formatBadge) formatBadge.style.display = fileName.endsWith('.zarr') ? 'inline-block' : 'none';
  if (fileDetailEl) {
    fileDetailEl.innerHTML = `
      <span>${nx}×${ny}×${nz}${nt > 1 ? `×${nt}` : ''}</span>
      <span>${dx.toFixed(2)}×${dy.toFixed(2)}×${dz.toFixed(2)}mm</span>
      <span>${dtName}${gz ? ' (gz)' : ''}</span>
    `;
  }
}

function autoContrast() {
  if (!volumeData || globalMin === globalMax) return;

  const n = volumeData.length;
  const sampleSize = Math.min(10000, n);
  const step = Math.max(1, Math.floor(n / sampleSize));
  const samples: number[] = [];
  const s = dataSlope;
  const t = dataInter;

  for (let i = 0; i < n; i += step) {
    samples.push(volumeData[i] * s + t);
  }
  samples.sort((a, b) => a - b);

  const p1Idx = Math.floor(samples.length * 0.01);
  const p99Idx = Math.floor(samples.length * 0.99);
  const p1 = samples[p1Idx];
  const p99 = samples[p99Idx];

  const range = globalMax - globalMin || 1;
  windowLevel = ((p1 + p99) / 2 - globalMin) / range;
  windowWidth = (p99 - p1) / range;

  const wwSlider = document.getElementById('ww-slider') as HTMLInputElement;
  const wlSlider = document.getElementById('wl-slider') as HTMLInputElement;
  if (wwSlider) wwSlider.value = String(Math.round(windowWidth * 100));
  if (wlSlider) wlSlider.value = String(Math.round(windowLevel * 100));

  if (volumeData) renderAllViews();
  else void refreshSlices(['axial', 'coronal', 'sagittal']);
}

function resetViews() {
  sliceIdx.axial = Math.floor((header?.nz || 1) / 2);
  sliceIdx.coronal = Math.floor((header?.ny || 1) / 2);
  sliceIdx.sagittal = Math.floor((header?.nx || 1) / 2);

  viewState.axial = { zoom: 1, panX: 0, panY: 0 };
  viewState.coronal = { zoom: 1, panX: 0, panY: 0 };
  viewState.sagittal = { zoom: 1, panX: 0, panY: 0 };
  viewState.mip = { rotationX: 0, rotationY: 0 };

  windowWidth = initialWindowWidth;
  windowLevel = initialWindowLevel;

  const wwSlider = document.getElementById('ww-slider') as HTMLInputElement;
  const wlSlider = document.getElementById('wl-slider') as HTMLInputElement;
  if (wwSlider) wwSlider.value = String(Math.round(windowWidth * 100));
  if (wlSlider) wlSlider.value = String(Math.round(windowLevel * 100));

  renderAllViews();
}

function handleKeyboardAction(action: string) {
  if (!header) return;
  if (action === 'scrollSliceUp' || action === 'scrollSliceDown') {
    const delta = action === 'scrollSliceUp' ? -1 : 1;
    // Scroll the currently maximized view, or all views
    const axes: Axis[] = maximizedView ? [maximizedView as Axis] : ['axial', 'coronal', 'sagittal'];
    for (const axis of axes) {
      const max = axis === 'axial' ? header.nz - 1 : axis === 'coronal' ? header.ny - 1 : header.nx - 1;
      const newIdx = Math.max(0, Math.min(max, sliceIdx[axis] + delta));
      if (newIdx !== sliceIdx[axis]) {
        sliceIdx[axis] = newIdx;
        if (volumeData) updateSingleView(axis);
        else void refreshSlices([axis], true);
      }
    }
  } else if (action === 'setViewAxial') {
    toggleMaximize('axial');
  } else if (action === 'setViewCoronal') {
    toggleMaximize('coronal');
  } else if (action === 'setViewSagittal') {
    toggleMaximize('sagittal');
  } else if (action === 'resetView') {
    resetViews();
  }
}

let headerPanelVisible = false;

function renderColormapPreview() {
  const canvas = document.getElementById('colormap-preview') as HTMLCanvasElement;
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  const w = canvas.width;
  const h = canvas.height;
  const cmapFn = COLORMAPS[colormap];
  if (!cmapFn) return;
  const imgData = ctx.createImageData(w, h);
  for (let x = 0; x < w; x++) {
    const t = x / (w - 1);
    const [r, g, b] = cmapFn(t);
    for (let y = 0; y < h; y++) {
      const idx = (y * w + x) * 4;
      imgData.data[idx] = r;
      imgData.data[idx + 1] = g;
      imgData.data[idx + 2] = b;
      imgData.data[idx + 3] = 255;
    }
  }
  ctx.putImageData(imgData, 0, 0);
}

function updateHeaderPanel(info?: Record<string, any>) {
  const h = info ? info : header;
  if (!h) return;
  const content = document.getElementById('header-info-content');
  if (!content) return;

  const rows: [string, string][] = [
    ['Dimensions', `${h.nx} × ${h.ny} × ${h.nz}`],
    ['Voxel Size', `${(h.dx || 0).toFixed(4)} × ${(h.dy || 0).toFixed(4)} × ${(h.dz || 0).toFixed(4)} mm`],
    ['Data Type', DATATYPE_NAMES[h.datatype] ?? `dt=${h.datatype}`],
    ['scl_slope', String(h.scl_slope ?? 1)],
    ['scl_inter', String(h.scl_inter ?? 0)],
    ['qform_code', String(h.qform_code ?? 0)],
    ['sform_code', String(h.sform_code ?? 0)],
  ];

  if (h.srow_x && h.srow_y && h.srow_z) {
    rows.push(['sform R', `[${h.srow_x.map((v: number) => v.toFixed(2)).join(', ')}]`]);
    rows.push(['sform A', `[${h.srow_y.map((v: number) => v.toFixed(2)).join(', ')}]`]);
    rows.push(['sform S', `[${h.srow_z.map((v: number) => v.toFixed(2)).join(', ')}]`]);
  }

  if (h.qoffset_x !== undefined) {
    rows.push(['qoffset', `(${h.qoffset_x.toFixed(2)}, ${h.qoffset_y.toFixed(2)}, ${h.qoffset_z.toFixed(2)})`]);
  }

  // Compute orientation from sform/qform matrix — never show "unknown"
  let orientation = h.orientation;
  if ((!orientation || orientation === 'unknown') && h.srow_x && h.srow_y && h.srow_z) {
    orientation = computeOrientationFromSform(h.srow_x, h.srow_y, h.srow_z);
  }
  // Fallback: try qform quaternion if sform didn't work
  if ((!orientation || orientation === 'unknown') && h.qform_code > 0 && h.quatern_b !== undefined) {
    orientation = computeOrientationFromQform(h);
  }
  // Final fallback: infer from voxel sizes (diagonal sform assumption)
  if (!orientation || orientation === 'unknown') {
    orientation = 'RAS'; // NIfTI default coordinate system
  }
  rows.push(['Orientation', orientation]);

  content.innerHTML = rows.map(([key, val]) =>
    `<div class="header-row"><span class="header-key">${key}</span><span class="header-val" title="Click to copy" data-copy="${val}">${val}</span></div>`
  ).join('');

  // Add click-to-copy handlers
  content.querySelectorAll('.header-val').forEach((el) => {
    el.addEventListener('click', () => {
      const text = (el as HTMLElement).getAttribute('data-copy') || el.textContent || '';
      navigator.clipboard.writeText(text).then(() => {
        el.classList.add('copied');
        setTimeout(() => el.classList.remove('copied'), 800);
      }).catch(() => {});
    });
  });
}

function toggleMaximize(view: string) {
  if (compareMode && compareLayout === 'sideBySide') return;
  const viewsContainer = document.getElementById('views') as HTMLDivElement;
  const viewContainers = document.querySelectorAll('.vc');

  if (maximizedView === view) {
    maximizedView = null;
    viewsContainer.classList.remove('single-view');
    viewContainers.forEach(vc => vc.classList.remove('hidden'));
  } else {
    maximizedView = view;
    viewsContainer.classList.add('single-view');
    viewContainers.forEach(vc => {
      if (vc.id === `${view}-c`) {
        vc.classList.remove('hidden');
      } else {
        vc.classList.add('hidden');
      }
    });
  }

  requestAnimationFrame(() => renderAllViews());
}

function applyPreviewData(previewData: any) {
  header = previewData.header;
  computeViewFlips();
  globalMin = previewData.globalMin;
  globalMax = previewData.globalMax;
  dataSlope = previewData.slope || 1;
  dataInter = previewData.inter || 0;
  sliceIdx.axial = previewData.sliceIdx.axial;
  sliceIdx.coronal = previewData.sliceIdx.coronal;
  sliceIdx.sagittal = previewData.sliceIdx.sagittal;

  setCurrentSlice('axial', new Float32Array(previewData.slices.axial), header!.nx, header!.ny, 1);
  setCurrentSlice('coronal', new Float32Array(previewData.slices.coronal), header!.nx, header!.nz, 1);
  setCurrentSlice('sagittal', new Float32Array(previewData.slices.sagittal), header!.ny, header!.nz, 1);

  windowLevel = 0.5;
  windowWidth = 1.0;
  initialWindowWidth = windowWidth;
  initialWindowLevel = windowLevel;

  if (headerPanelVisible) updateHeaderPanel();
}

function setPrimaryImageFromPreview(previewData: any) {
  images.length = 0;
  images.push({
    header: previewData.header,
    data: null,
    min: previewData.globalMin,
    max: previewData.globalMax,
    name: fileName,
    url: fileUrl,
    slope: previewData.slope || 1,
    inter: previewData.inter || 0,
    preview: {
      axial: new Float32Array(previewData.slices.axial),
      coronal: new Float32Array(previewData.slices.coronal),
      sagittal: new Float32Array(previewData.slices.sagittal),
    },
    state: 'preview',
    lastAccess: Date.now(),
  });
  activeImageIdx = 0;
  publishPerfMonitor();
}

function decodePreviewBinary(buffer: ArrayBuffer): any {
  const view = new DataView(buffer);
  let offset = 0;
  const headerLen = view.getUint32(offset, true); offset += 4;
  const headerJson = new TextDecoder().decode(new Uint8Array(buffer, offset, headerLen)); offset += headerLen;
  const header = JSON.parse(headerJson);
  const globalMin = view.getFloat32(offset, true); offset += 4;
  const globalMax = view.getFloat32(offset, true); offset += 4;
  const sliceIdxData = {
    axial: view.getUint32(offset, true),
    coronal: view.getUint32(offset + 4, true),
    sagittal: view.getUint32(offset + 8, true),
  };
  offset += 12;
  const axialLen = view.getUint32(offset, true); offset += 4;
  const axial = new Float32Array(buffer.slice(offset, offset + axialLen)); offset += axialLen;
  const coronalLen = view.getUint32(offset, true); offset += 4;
  const coronal = new Float32Array(buffer.slice(offset, offset + coronalLen)); offset += coronalLen;
  const sagittalLen = view.getUint32(offset, true); offset += 4;
  const sagittal = new Float32Array(buffer.slice(offset, offset + sagittalLen));
  return {
    header,
    globalMin,
    globalMax,
    sliceIdx: sliceIdxData,
    slope: header.scl_slope || 1,
    inter: header.scl_inter || 0,
    slices: { axial, coronal, sagittal },
  };
}

async function fetchWithRetry(url: string, responseType: 'json' | 'arrayBuffer'): Promise<any | null> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const fetchStart = Date.now();
    const resp = await fetch(url);
    if (resp.ok) {
      const payload = responseType === 'arrayBuffer' ? await resp.arrayBuffer() : await resp.json();
      const fetchDuration = Date.now() - fetchStart;
      const contentLength = Number(resp.headers.get('Content-Length') || 0);
      bandwidthEstimator.addSample(contentLength || (responseType === 'arrayBuffer' ? payload.byteLength : JSON.stringify(payload).length), Math.max(1, fetchDuration));
      return payload;
    }
    const retryable = resp.status === 408 || resp.status === 425 || resp.status === 429 || resp.status >= 500;
    if (!retryable || attempt === 2) return null;
    await new Promise(resolve => window.setTimeout(resolve, 200 * Math.pow(2, attempt)));
  }
  return null;
}

async function fetchPreviewData(url: string = fileUrl): Promise<any | null> {
  if (previewRequestCache.has(url)) {
    return previewRequestCache.get(url)!;
  }
  const request = (async () => {
    const startedAt = performance.now();
    let previewData: any | null = null;
    if (viewerConfig.previewMode === 'binary') {
      const previewBinUrl = url.replace('/file/', '/preview-bin/');
      const buffer = await fetchWithRetry(previewBinUrl, 'arrayBuffer');
      if (buffer) {
        previewData = decodePreviewBinary(buffer);
      }
    }
    if (!previewData) {
      const previewUrl = url.replace('/file/', '/preview/');
      const buffer = await fetchWithRetry(previewUrl, 'arrayBuffer');
      if (buffer) {
        previewData = decodePreviewBinary(buffer);
      }
    }
    if (previewData) {
      perfMonitor.previewLoads.push(performance.now() - startedAt);
      publishPerfMonitor();
    }
    return previewData;
  })().finally(() => {
    previewRequestCache.delete(url);
  });
  previewRequestCache.set(url, request);
  return request;
}

let directPreviewReceived = false;
let directPreviewTimer: number | null = null;

window.addEventListener('DOMContentLoaded', () => {
  publishPerfMonitor();
  vscode.postMessage({ type: 'ready' });
});

window.addEventListener('message', async (e) => {
  const msg = e.data;

  if (msg.type === 'newImage') {
    loadNewImage(msg.fileUrl, msg.fileName, msg.isGzip, msg.isRemote);
    return;
  }

  if (msg.type === 'preview') {
    directPreviewReceived = true;
    if (directPreviewTimer) { window.clearTimeout(directPreviewTimer); directPreviewTimer = null; }
    handleDirectPreview(msg);
    return;
  }

  if (msg.type === 'cachedVolume') {
    directPreviewReceived = true;
    if (directPreviewTimer) { window.clearTimeout(directPreviewTimer); directPreviewTimer = null; }
    handleCachedVolume(msg);
    return;
  }

  if (msg.type === 'lodData') {
    handleLODData(msg);
    return;
  }

  if (msg.type === 'keyboard') {
    handleKeyboardAction(msg.action);
    return;
  }

  if (msg.type === 'headerInfo') {
    updateHeaderPanel(msg.headerInfo);
    return;
  }

  if (msg.type !== 'config') return;

  broadcastToSliceWorkers({ type: 'cancelVolumeLoad', id: 0 });
  fileUrl = msg.fileUrl;
  fileName = msg.fileName;
  isGzip = fileName.endsWith('.gz');
  isRemoteSource = !!msg.isRemote;
  viewerConfig.previewMode = msg.previewMode || viewerConfig.previewMode;
  applyRenderBackend(msg.renderBackend || viewerConfig.renderBackend);
  viewerConfig.renderBackend = msg.renderBackend || viewerConfig.renderBackend;
  viewerConfig.fullVolumePolicy = msg.fullVolumePolicy || viewerConfig.fullVolumePolicy;
  viewerConfig.nativeAcceleration = msg.nativeAcceleration || viewerConfig.nativeAcceleration;
  if (msg.renderMode === 'volume' || msg.renderMode === 'slice') {
    renderMode = msg.renderMode;
  }
  fullVolumeLoaded = false;
  volumeData = null;
  currentSlices.axial = null;
  currentSlices.coronal = null;
  currentSlices.sagittal = null;
  colormap = msg.defaultColormap || 'gray';
  enableLOD = msg.enableLOD !== undefined ? msg.enableLOD : true;

  // Reset LOD state for new volume
  for (const k of Object.keys(lodData)) delete lodData[Number(k)];
  currentLOD.axial = 2; currentLOD.coronal = 2; currentLOD.sagittal = 2;

  // Send file hash to slice workers for IndexedDB cache key generation
  if (msg.fileName) {
    const fileSize = msg.fileSize || 0;
    broadcastToSliceWorkers({ type: 'setFileHash', fileName: msg.fileName, fileSize });
  }

  // Cache invalidation: if validation token changed, invalidate cached slices
  if (msg.validationToken && msg.fileName) {
    const fileSize = msg.fileSize || 0;
    broadcastToSliceWorkers({
      type: 'invalidateCache',
      fileName: msg.fileName,
      fileSize,
      validationToken: msg.validationToken,
    });
  }

  const cmapSelect = document.getElementById('colormap') as HTMLSelectElement;
  if (cmapSelect && msg.defaultColormap) cmapSelect.value = msg.defaultColormap;
  renderColormapPreview();

  directPreviewReceived = false;
  directPreviewTimer = window.setTimeout(() => {
    directPreviewTimer = null;
    if (!directPreviewReceived) {
      fallbackToHttpPreview();
    }
  }, 800);
});

function toFloat32Array(val: any, fallbackKey: string, msg: any): Float32Array {
  if (val instanceof ArrayBuffer) return new Float32Array(val);
  if (ArrayBuffer.isView(val)) return new Float32Array(val.buffer, val.byteOffset, val.byteLength / 4);
  const arr = msg.slices?.[fallbackKey];
  if (Array.isArray(arr)) return new Float32Array(arr);
  if (Array.isArray(val)) return new Float32Array(val);
  return new Float32Array(0);
}

function handleDirectPreview(msg: any): void {
  header = msg.header;
  computeViewFlips();
  globalMin = msg.globalMin;
  globalMax = msg.globalMax;
  dataSlope = msg.slope || 1;
  dataInter = msg.inter || 0;
  sliceIdx.axial = msg.sliceIdx.axial;
  sliceIdx.coronal = msg.sliceIdx.coronal;
  sliceIdx.sagittal = msg.sliceIdx.sagittal;

  const axial = toFloat32Array(msg.axialSlice, 'axial', msg);
  const coronal = toFloat32Array(msg.coronalSlice, 'coronal', msg);
  const sagittal = toFloat32Array(msg.sagittalSlice, 'sagittal', msg);

  if (axial.length === 0) {
    fallbackToHttpPreview();
    return;
  }

  setCurrentSlice('axial', axial, header!.nx, header!.ny, 1);
  setCurrentSlice('coronal', coronal, header!.nx, header!.nz, 1);
  setCurrentSlice('sagittal', sagittal, header!.ny, header!.nz, 1);

  windowLevel = 0.5;
  windowWidth = 1.0;
  initialWindowWidth = windowWidth;
  initialWindowLevel = windowLevel;

  setPrimaryImageFromDirectPreview(msg, axial, coronal, sagittal);
  updateFileInfo();
  updateSliderValues();
  updateImagePicker();
  renderAllViews();
  loading.style.display = 'none';
  updateProgress(0.5);
  setupInteraction();

  if (msg.partialPreview || viewerConfig.fullVolumePolicy === 'debounced') {
    scheduleActiveImageLoad(0);
  } else if (viewerConfig.fullVolumePolicy === 'eager') {
    void ensureImageData(0, 'active').catch((err) => {
      if ((err as any)?.name !== 'AbortError') loadingText.textContent = 'Error: ' + ((err as any)?.message || String(err));
    });
  }
}

function handleCachedVolume(msg: any): void {
  const wasPartialPreview = sliceIdx.axial === 0 && header && header.nz > 1;
  header = msg.header;
  computeViewFlips();
  globalMin = msg.globalMin;
  globalMax = msg.globalMax;
  dataSlope = msg.slope || 1;
  dataInter = msg.inter || 0;
  sliceIdx.axial = msg.sliceIdx.axial;
  sliceIdx.coronal = msg.sliceIdx.coronal;
  sliceIdx.sagittal = msg.sliceIdx.sagittal;

  // If we were showing z=0 preview, navigate to center slice now
  if (wasPartialPreview && header) {
    sliceIdx.axial = Math.floor(header.nz / 2);
    sliceIdx.coronal = Math.floor(header.ny / 2);
    sliceIdx.sagittal = Math.floor(header.nx / 2);
  }

  const datatype = msg.datatype || 16;
  let voxelBuffer: ArrayBuffer | null = null;
  if (msg.voxelData instanceof ArrayBuffer) {
    voxelBuffer = msg.voxelData;
  } else if (msg.voxelData?.buffer instanceof ArrayBuffer) {
    const view = msg.voxelData;
    voxelBuffer = view.buffer.slice(view.byteOffset, view.byteOffset + view.byteLength);
  } else if (Array.isArray(msg.voxelData)) {
    const f32 = new Float32Array(msg.voxelData);
    voxelBuffer = f32.buffer.slice(f32.byteOffset, f32.byteOffset + f32.byteLength);
  } else if (msg.voxelData && typeof msg.voxelData === 'object' && msg.voxelData.byteLength !== undefined) {
    try {
      const keys = Object.keys(msg.voxelData);
      if (keys.length > 0) {
        const arr = new Uint8Array(keys.length);
        for (let i = 0; i < keys.length; i++) arr[i] = msg.voxelData[i];
        voxelBuffer = arr.buffer;
      }
    } catch {}
  }

  if (voxelBuffer) {
    switch (datatype) {
      case 2: volumeData = new Uint8Array(voxelBuffer); break;
      case 4: volumeData = new Int16Array(voxelBuffer); break;
      case 8: volumeData = new Int32Array(voxelBuffer); break;
      case 16: volumeData = new Float32Array(voxelBuffer); break;
      case 64: volumeData = new Float64Array(voxelBuffer); break;
      case 256: volumeData = new Int8Array(voxelBuffer); break;
      case 512: volumeData = new Uint16Array(voxelBuffer); break;
      case 768: volumeData = new Uint32Array(voxelBuffer); break;
      default: volumeData = new Float32Array(voxelBuffer); break;
    }
    fullVolumeLoaded = true;

    // Track memory usage
    totalVolumeBytes = volumeData.byteLength;
    workerCopyBytes = volumeData.byteLength; // would be duplicated in workers without SAB
    sharedBufferBytes = 0;

    // Create SharedArrayBuffer and broadcast to slice workers for zero-copy access
    if (header && volumeData) {
      const n = header.nx * header.ny * header.nz;
      let float32Data: Float32Array;
      if (volumeData instanceof Float32Array) {
        float32Data = volumeData;
      } else {
        float32Data = new Float32Array(n);
        for (let i = 0; i < n; i++) float32Data[i] = (volumeData as any)[i] * dataSlope + dataInter;
      }
      sharedVolumeBuffer = createSharedVolumeBuffer(float32Data);
      if (sharedVolumeBuffer) {
        sharedBufferBytes = sharedVolumeBuffer.byteLength;
        workerCopyBytes = 0; // workers no longer need their own copy
        broadcastToSliceWorkers({
          type: 'sharedVolume',
          buffer: sharedVolumeBuffer,
          nx: header.nx, ny: header.ny, nz: header.nz,
          slope: dataSlope, inter: dataInter,
        });
      }
    }
  }

  if (!voxelBuffer || !volumeData) {
    fallbackToHttpPreview();
    return;
  }

  // Keep default window/level [0, 1] range on initial load
  // User can click "Auto Contrast" button to apply data-driven W/L
  windowWidth = 1.0;
  windowLevel = 0.5;

  const wwSlider = document.getElementById('ww-slider') as HTMLInputElement;
  const wlSlider = document.getElementById('wl-slider') as HTMLInputElement;
  if (wwSlider) wwSlider.value = String(Math.round(windowWidth * 100));
  if (wlSlider) wlSlider.value = String(Math.round(windowLevel * 100));

  initialWindowWidth = windowWidth;
  initialWindowLevel = windowLevel;

  if (pendingAddImageIdx >= 0 && pendingAddImageIdx < images.length) {
    images[pendingAddImageIdx] = {
      header: msg.header,
      data: volumeData,
      min: msg.globalMin,
      max: msg.globalMax,
      name: fileName,
      url: fileUrl,
      slope: msg.slope || 1,
      inter: msg.inter || 0,
      state: volumeData ? 'ready' : 'preview',
      lastAccess: Date.now(),
    };
    activeImageIdx = pendingAddImageIdx;
    pendingAddImageIdx = -1;
  } else {
    images.length = 0;
    images.push({
      header: msg.header,
      data: volumeData,
      min: msg.globalMin,
      max: msg.globalMax,
      name: fileName,
      url: fileUrl,
      slope: msg.slope || 1,
      inter: msg.inter || 0,
      state: volumeData ? 'ready' : 'preview',
      lastAccess: Date.now(),
    });
    activeImageIdx = 0;
  }
  publishPerfMonitor();

  updateFileInfo();
  updateSliderValues();
  updateImagePicker();
  renderAllViews();
  loading.style.display = 'none';
  updateProgress(1.0);
  setupInteraction();

  if (headerPanelVisible) updateHeaderPanel();

  if (!volumeData) {
    scheduleActiveImageLoad(0);
  }
}

function handleLODData(msg: any): void {
  if (!enableLOD || !header) return;
  const level = msg.level as number;

  // LOD0 means full volume is ready — upgrade all axes to LOD0
  if (level === 0) {
    // Full volume data is already available via volumeData
    // Just upgrade current LOD and re-render
    for (const axis of ['axial', 'coronal', 'sagittal'] as const) {
      if (currentLOD[axis] > 0) {
        currentLOD[axis] = 0;
      }
    }
    renderAllViews();
    return;
  }

  // Store LOD slice data
  if (!lodData[level]) {
    lodData[level] = { axial: null, coronal: null, sagittal: null };
  }
  const ld = lodData[level];

  if (msg.axial && msg.axialW && msg.axialH) {
    ld.axial = {
      data: msg.axial instanceof ArrayBuffer ? new Float32Array(msg.axial)
        : Array.isArray(msg.axial) ? new Float32Array(msg.axial)
        : new Float32Array(0),
      w: msg.axialW, h: msg.axialH
    };
  }
  if (msg.coronal && msg.coronalW && msg.coronalH) {
    ld.coronal = {
      data: msg.coronal instanceof ArrayBuffer ? new Float32Array(msg.coronal)
        : Array.isArray(msg.coronal) ? new Float32Array(msg.coronal)
        : new Float32Array(0),
      w: msg.coronalW, h: msg.coronalH
    };
  }
  if (msg.sagittal && msg.sagittalW && msg.sagittalH) {
    ld.sagittal = {
      data: msg.sagittal instanceof ArrayBuffer ? new Float32Array(msg.sagittal)
        : Array.isArray(msg.sagittal) ? new Float32Array(msg.sagittal)
        : new Float32Array(0),
      w: msg.sagittalW, h: msg.sagittalH
    };
  }

  // If volumeData is not yet loaded, show LOD data immediately
  if (!volumeData) {
    for (const axis of ['axial', 'coronal', 'sagittal'] as const) {
      if (ld[axis] && currentLOD[axis] > level) {
        currentLOD[axis] = level;
      }
    }
    renderAllViews();
  }
}

function scheduleLODUpgrade(axis: Axis): void {
  if (!enableLOD || volumeData) return;
  lastScrollTime = Date.now();

  // While scrolling, stay at LOD2
  if (currentLOD[axis] > 2) {
    currentLOD[axis] = 2;
    updateSingleView(axis);
  }

  // Clear any pending upgrade timer
  if (lodUpgradeTimer) {
    window.clearTimeout(lodUpgradeTimer);
    lodUpgradeTimer = null;
  }

  // After 300ms of no scrolling, upgrade to LOD1
  lodUpgradeTimer = window.setTimeout(() => {
    const elapsed = Date.now() - lastScrollTime;
    if (elapsed < 280) return; // still scrolling

    if (!volumeData && currentLOD[axis] > 1 && lodData[1]?.[axis]) {
      currentLOD[axis] = 1;
      updateSingleView(axis);
      // Apply cross-fade transition
      applyLODTransition(axis);
    }

    // After 1000ms total of no scrolling, upgrade to LOD0
    lodUpgradeTimer = window.setTimeout(() => {
      const elapsed2 = Date.now() - lastScrollTime;
      if (elapsed2 < 980) return;

      if (!volumeData && currentLOD[axis] > 0) {
        currentLOD[axis] = 0;
        updateSingleView(axis);
        applyLODTransition(axis);
      }
      lodUpgradeTimer = null;
    }, 700);
  }, 300);
}

function applyLODTransition(axis: Axis): void {
  const canvas = canvases[axis];
  if (!canvas) return;
  canvas.style.transition = 'opacity 0.2s ease-in-out';
  canvas.style.opacity = '0.7';
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      canvas.style.opacity = '1';
      setTimeout(() => {
        canvas.style.transition = '';
      }, 200);
    });
  });
}

function setPrimaryImageFromDirectPreview(msg: any, axial: Float32Array, coronal: Float32Array, sagittal: Float32Array): void {
  images.length = 0;
  images.push({
    header: msg.header,
    data: null,
    min: msg.globalMin,
    max: msg.globalMax,
    name: fileName,
    url: fileUrl,
    slope: msg.slope || 1,
    inter: msg.inter || 0,
    preview: { axial, coronal, sagittal },
    state: 'preview',
    lastAccess: Date.now(),
  });
  activeImageIdx = 0;
  publishPerfMonitor();
}

async function fallbackToHttpPreview(): Promise<void> {
  try {
    loadingText.textContent = 'Loading preview...';
    updateProgress(0.01, 'Fetching preview...', 'Preview');

    await ensureAllSliceWorkers();
    if (slicePool) {
      slicePool.setErrorHandler((err) => { loadingText.textContent = 'Worker error: ' + (err.message || 'unknown'); });
    }

    try {
      const previewData = await fetchPreviewData();
      if (previewData && previewData.header && previewData.slices) {
        applyPreviewData(previewData);
        setPrimaryImageFromPreview(previewData);
        updateFileInfo();
        updateSliderValues();
        updateImagePicker();
        renderAllViews();
        loading.style.display = 'none';
        updateProgress(0.5);
        setupInteraction();
        if (viewerConfig.fullVolumePolicy === 'eager') {
          void ensureImageData(0, 'active').catch((err) => {
            if ((err as any)?.name !== 'AbortError') loadingText.textContent = 'Error: ' + ((err as any)?.message || String(err));
          });
        } else if (viewerConfig.fullVolumePolicy === 'debounced') {
          scheduleActiveImageLoad(0);
        }
        return;
      }
    } catch (_) {}

    loadFullVolume();
  } catch (err: any) {
    loadingText.textContent = 'Error: ' + (err?.message ?? String(err));
  }
}

function loadFullVolume() {
  let previewReceived = false;
  let volumeReceived = false;

  workerStreamListener = (d) => {
    if (d.type === 'progress') {
      updateProgress(0.5 + d.value * 0.5, undefined, d.stage ? `${d.stage}...` : undefined);
      return;
    }
    if (d.type === 'error') {
      const loadingText = document.getElementById('loading-text');
      if (loadingText) loadingText.textContent = 'Error: ' + d.error;
      return;
    }
    if (d.type === 'preview') {
      if (previewReceived) return;
      previewReceived = true;
      if (!header) {
        header = d.header;
        computeViewFlips();
        globalMin = d.globalMin;
        globalMax = d.globalMax;
        dataSlope = d.slope || 1;
        dataInter = d.inter || 0;

        sliceIdx.axial = d.sliceIdx.axial;
        sliceIdx.coronal = d.sliceIdx.coronal;
        sliceIdx.sagittal = d.sliceIdx.sagittal;

        autoContrast();
        initialWindowWidth = windowWidth;
        initialWindowLevel = windowLevel;

        const h = d.header;
        paintSlice('axial', d.slices.axial, h.nx, h.ny, h.nx * h.dx, h.ny * h.dy);
        paintSlice('coronal', d.slices.coronal, h.nx, h.nz, h.nx * h.dx, h.nz * h.dz);
        paintSlice('sagittal', d.slices.sagittal, h.ny, h.nz, h.ny * h.dy, h.nz * h.dz);

        updateFileInfo();
        updateSliderValues();

        const loading = document.getElementById('loading');
        if (loading) loading.style.display = 'none';
        setupInteraction();
      }
      return;
    }
    if (d.type === 'volume') {
      if (volumeReceived) return;
      volumeReceived = true;
      volumeData = d.voxelData;
      fullVolumeLoaded = true;
      const primary = images[0];
      if (primary) {
        primary.header = d.header;
        primary.data = d.voxelData;
        primary.min = d.globalMin;
        primary.max = d.globalMax;
        primary.slope = d.slope || 1;
        primary.inter = d.inter || 0;
        primary.state = 'ready';
        primary.lastAccess = Date.now();
      } else {
        images.push({
          header: d.header,
          data: d.voxelData,
          min: d.globalMin,
          max: d.globalMax,
          name: fileName,
          url: fileUrl,
          slope: d.slope || 1,
          inter: d.inter || 0,
          preview: currentSlices.axial && currentSlices.coronal && currentSlices.sagittal ? {
            axial: new Float32Array(currentSlices.axial.data),
            coronal: new Float32Array(currentSlices.coronal.data),
            sagittal: new Float32Array(currentSlices.sagittal.data),
          } : undefined,
          state: 'ready',
          lastAccess: Date.now(),
        });
        activeImageIdx = 0;
      }
      publishPerfMonitor();

      updateImagePicker();
      updateProgress(1.0);
      renderAllViews();
      return;
    }
  };

  if (slicePool) slicePool.broadcast({ id: 0, type: 'loadVolume', url: fileUrl, isGzip });
}

function updateProgress(value: number, text?: string, detail?: string) {
  progress.style.width = `${Math.min(100, value * 100)}%`;
  if (text !== undefined) loadingText.textContent = text;
  if (detail !== undefined) loadingDetail.textContent = detail;
}

async function switchToImage(idx: number) {
  if (idx < 0 || idx >= images.length) return;

  const prevHeader = header;
  const prevSliceIdx = { ...sliceIdx };

  activeImageIdx = idx;
  const img = images[idx];
  applyImageState(img);

  if (header) {
    if (prevHeader && images.length > 1) {
      const [wx, wy, wz] = voxelToWorld(prevHeader, prevSliceIdx.sagittal, prevSliceIdx.coronal, prevSliceIdx.axial);
      const [vx, vy, vz] = worldToVoxel(header, wx, wy, wz);
      sliceIdx.sagittal = Math.max(0, Math.min(header.nx - 1, Math.round(vx)));
      sliceIdx.coronal = Math.max(0, Math.min(header.ny - 1, Math.round(vy)));
      sliceIdx.axial = Math.max(0, Math.min(header.nz - 1, Math.round(vz)));
    } else {
      sliceIdx.axial = Math.min(sliceIdx.axial, header.nz - 1);
      sliceIdx.coronal = Math.min(sliceIdx.coronal, header.ny - 1);
      sliceIdx.sagittal = Math.min(sliceIdx.sagittal, header.nx - 1);
    }
  }
  viewState.axial = { zoom: 1, panX: 0, panY: 0 };
  viewState.coronal = { zoom: 1, panX: 0, panY: 0 };
  viewState.sagittal = { zoom: 1, panX: 0, panY: 0 };
  viewState.mip = { rotationX: 0, rotationY: 0 };
  if (!img.data) {
    primeSliceFramesFromPreview(img);
    void refreshSlices(['axial', 'coronal', 'sagittal'], true).catch(() => {});
  }

  autoContrast();
  initialWindowWidth = windowWidth;
  initialWindowLevel = windowLevel;

  updateFileInfo();
  updateSliderValues();
  updateImagePicker();
  renderAllViews();
  if (!img.data) {
    scheduleActiveImageLoad(idx);
  } else {
    scheduledActiveIndex = null;
    if (activeLoadDebounceTimer) {
      window.clearTimeout(activeLoadDebounceTimer);
      activeLoadDebounceTimer = null;
    }
    publishPerfMonitor();
  }
}

function updateImagePicker() {
  const picker = document.getElementById('image-list');
  if (!picker) return;
  if (!thumbnailObserver && 'IntersectionObserver' in window) {
    thumbnailObserver = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        const canvas = entry.target as HTMLCanvasElement;
        const index = Number(canvas.dataset.imageIdx || '-1');
        if (index >= 0 && images[index]) {
          renderThumbnail(canvas, images[index]);
        }
        thumbnailObserver?.unobserve(canvas);
      }
    }, { root: picker, rootMargin: '48px' });
  }
  picker.innerHTML = '';
  images.forEach((img, idx) => {
    const item = document.createElement('div');
    item.className = 'image-item' + (idx === activeImageIdx ? ' active' : '');

    const thumb = document.createElement('div');
    thumb.className = 'image-item-thumb';
    const thumbCanvas = document.createElement('canvas');
    thumb.appendChild(thumbCanvas);
    item.appendChild(thumb);

    const name = document.createElement('span');
    name.className = 'image-item-name';
    name.textContent = img.name;
    name.title = img.name;
    item.appendChild(name);

    if (images.length > 1) {
      const remove = document.createElement('div');
      remove.className = 'image-item-remove';
      remove.textContent = '×';
      remove.title = 'Remove image';
      remove.addEventListener('click', (e) => {
        e.stopPropagation();
        if (images.length > 1) {
          images.splice(idx, 1);
          if (activeImageIdx >= images.length) activeImageIdx = images.length - 1;
          void switchToImage(activeImageIdx);
        }
      });
      item.appendChild(remove);
    }

    item.addEventListener('click', () => void switchToImage(idx));
    picker.appendChild(item);
    thumbCanvas.dataset.imageIdx = String(idx);
    if (idx === activeImageIdx || idx < 3 || !thumbnailObserver) {
      const renderThumb = () => renderThumbnail(thumbCanvas, img);
      if ('requestIdleCallback' in window) {
        (window as any).requestIdleCallback(renderThumb, { timeout: 120 });
      } else {
        globalThis.setTimeout(renderThumb, 0);
      }
    } else {
      thumbnailObserver.observe(thumbCanvas);
    }
  });
}

function renderThumbnail(canvas: HTMLCanvasElement, img: VolumeImage) {
  if (!img.header) return;
  const { nx, ny, nz } = img.header;
  const slice = img.preview?.axial ? new Float32Array(img.preview.axial) : new Float32Array(nx * ny);
  if (!img.preview?.axial && img.data) {
    const sliceIdx = Math.floor(nz / 2);
    const base = sliceIdx * nx * ny;
    const s = img.slope, t = img.inter;
    const needScale = s !== 1 || t !== 0;
    if (needScale) {
      for (let i = 0; i < nx * ny; i++) slice[i] = img.data[base + i] * s + t;
    } else {
      for (let i = 0; i < nx * ny; i++) slice[i] = img.data[base + i];
    }
  }

  const dpr = 2;
  canvas.width = 32 * dpr;
  canvas.height = 32 * dpr;
  const ctx = canvas.getContext('2d')!;
  ctx.imageSmoothingEnabled = false;

  const w = nx, h = ny;
  const imgData = ctx.createImageData(w, h);
  const pixels = imgData.data;
  const cmapFn = COLORMAPS[colormap] || COLORMAPS.gray;
  const lo = windowLevel - windowWidth * 0.5;
  const hi = windowLevel + windowWidth * 0.5;
  const range = hi - lo || 1;
  const dataRange = img.max - img.min || 1;

  for (let i = 0; i < w * h; i++) {
    const norm = (slice[i] - img.min) / dataRange;
    const t = Math.max(0, Math.min(1, (norm - lo) / range));
    const [r, g, b] = cmapFn(t);
    const idx = i * 4;
    pixels[idx] = r; pixels[idx + 1] = g; pixels[idx + 2] = b; pixels[idx + 3] = 255;
  }

  const tc = document.createElement('canvas');
  tc.width = w; tc.height = h;
  const tctx = tc.getContext('2d')!;
  tctx.putImageData(imgData, 0, 0);

  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.save();
  ctx.translate(0, canvas.height);
  ctx.scale(32 * dpr / w, -32 * dpr / h);
  ctx.drawImage(tc, 0, 0);
  ctx.restore();
}

function primeSliceFramesFromPreview(img: VolumeImage): void {
  if (!img.preview) return;
  setCurrentSlice('axial', new Float32Array(img.preview.axial), img.header.nx, img.header.ny, 1);
  setCurrentSlice('coronal', new Float32Array(img.preview.coronal), img.header.nx, img.header.nz, 1);
  setCurrentSlice('sagittal', new Float32Array(img.preview.sagittal), img.header.ny, img.header.nz, 1);
}

async function loadNewImage(url: string, name: string, _gz: boolean, _remote?: boolean) {
  broadcastToSliceWorkers({ type: 'cancelVolumeLoad', id: 0 });
  fileUrl = url;
  fileName = name;
  isGzip = name.endsWith('.gz');
  isRemoteSource = !!_remote;
  fullVolumeLoaded = false;
  volumeData = null;
  currentSlices.axial = null;
  currentSlices.coronal = null;
  currentSlices.sagittal = null;

  pendingAddImageIdx = images.length;
  images.push({
    header: null as any,
    data: null,
    min: 0,
    max: 1,
    name,
    url,
    slope: 1,
    inter: 0,
    state: 'loading',
    lastAccess: Date.now(),
  });
  updateImagePicker();
}

// Tooltip system: data-tip based, inspired by Project_Manager
let tooltipEl: HTMLDivElement | null = null;
let tooltipHideTimer: number | null = null;

function initTooltipSystem() {
  const el = document.createElement('div');
  el.className = 'ns-tooltip';
  document.body.appendChild(el);
  tooltipEl = el;

  document.addEventListener('mouseover', (e) => {
    const target = (e.target as HTMLElement).closest('[data-tip]') as HTMLElement | null;
    if (!target) return;
    const tip = target.getAttribute('data-tip');
    if (!tip) return;
    if (tooltipHideTimer) { clearTimeout(tooltipHideTimer); tooltipHideTimer = null; }
    const pos = target.getAttribute('data-tip-pos') || 'top';
    const rect = target.getBoundingClientRect();
    el.textContent = tip;
    el.style.left = '0px';
    el.style.top = '0px';
    el.classList.add('visible');
    const tipRect = el.getBoundingClientRect();
    let left = rect.left + rect.width / 2 - tipRect.width / 2;
    let top: number;
    if (pos === 'bottom') {
      top = rect.bottom + 6;
    } else {
      top = rect.top - tipRect.height - 6;
    }
    // Viewport clamping
    if (left < 4) left = 4;
    if (left + tipRect.width > window.innerWidth - 4) left = window.innerWidth - tipRect.width - 4;
    if (top < 4) top = rect.bottom + 6;
    if (top + tipRect.height > window.innerHeight - 4) top = rect.top - tipRect.height - 6;
    el.style.left = `${left}px`;
    el.style.top = `${top}px`;
  });

  document.addEventListener('mouseout', (e) => {
    const target = (e.target as HTMLElement).closest('[data-tip]') as HTMLElement | null;
    if (!target) return;
    if (tooltipHideTimer) clearTimeout(tooltipHideTimer);
    tooltipHideTimer = window.setTimeout(() => {
      el.classList.remove('visible');
    }, 80);
  });
}

function setupInteraction() {
  if (!header) return;
  if (interactionInitialized) return;
  interactionInitialized = true;

  // Initialize tooltip system (data-tip based, like Project_Manager)
  initTooltipSystem();

  // Initialize WASM SIMD acceleration (async, non-blocking)
  initWasmBindings().then(bindings => {
    if (bindings?.hasSimd()) {
      console.log('[NiftiSpy] WASM SIMD128 acceleration active');
    }
  }).catch(() => {
    console.log('[NiftiSpy] WASM SIMD not available');
  });

  const wwSlider = document.getElementById('ww-slider') as HTMLInputElement;
  const wlSlider = document.getElementById('wl-slider') as HTMLInputElement;
  const cmapSelect = document.getElementById('colormap') as HTMLSelectElement;
  const btnAuto = document.getElementById('btn-auto') as HTMLButtonElement;
  const btnReset = document.getElementById('btn-reset') as HTMLButtonElement;
  const helpBtn = document.getElementById('help-btn') as HTMLDivElement;
  const helpPopup = document.getElementById('help-popup') as HTMLDivElement;
  const sidebarToggle = document.getElementById('sidebar-toggle') as HTMLDivElement;
  const sidebar = document.getElementById('sidebar') as HTMLDivElement;
  const sidebarResize = document.getElementById('sidebar-resize') as HTMLDivElement;

  let renderTimer: number | null = null;
  const scheduleRender = () => {
    if (renderTimer) cancelAnimationFrame(renderTimer);
    renderTimer = requestAnimationFrame(() => { renderAllViews(); renderTimer = null; });
  };

  wwSlider?.addEventListener('input', () => { const v = validateWindowLevel(Number(wwSlider.value) / 100, windowLevel); windowWidth = v.windowWidth; scheduleRender(); a11yAnnounce(`Window width: ${Math.round(windowWidth * 100)}`); });
  wlSlider?.addEventListener('input', () => { const v = validateWindowLevel(windowWidth, Number(wlSlider.value) / 100); windowLevel = v.windowLevel; scheduleRender(); a11yAnnounce(`Window level: ${Math.round(windowLevel * 100)}`); });
  cmapSelect?.addEventListener('change', () => { colormap = cmapSelect.value; sliceRenderCache.clear(); renderColormapPreview(); scheduleRender(); });
  btnAuto?.addEventListener('click', autoContrast);
  btnReset?.addEventListener('click', resetViews);

  const btnFit = document.getElementById('btn-fit') as HTMLButtonElement;
  btnFit?.addEventListener('click', () => {
    viewState.axial = { zoom: 1, panX: 0, panY: 0 };
    viewState.coronal = { zoom: 1, panX: 0, panY: 0 };
    viewState.sagittal = { zoom: 1, panX: 0, panY: 0 };
    renderAllViews();
  });

  const btnCompare = document.getElementById('btn-compare') as HTMLButtonElement;
  btnCompare?.addEventListener('click', async () => {
    if (images.length < 2) return;
    if (activeLoadDebounceTimer) {
      window.clearTimeout(activeLoadDebounceTimer);
      activeLoadDebounceTimer = null;
      scheduledActiveIndex = null;
    }
    if (!compareMode) {
      try {
        await ensureImageData(0, 'active');
        await ensureImageData(1, 'active');
      } catch (err) {
        console.error('Failed to prepare compare mode:', err);
        return;
      }
      compareMode = true;
      compareLayout = 'overlay';
    } else if (compareLayout === 'overlay') {
      compareLayout = 'sideBySide';
    } else {
      compareMode = false;
      compareLayout = 'overlay';
    }
    btnCompare.classList.toggle('active', compareMode);
    btnCompare.textContent = !compareMode ? '⊞ Compare' : compareLayout === 'overlay' ? '◑ Overlay' : '◫ SBS';
    const overlayControls = document.getElementById('overlay-controls');
    if (overlayControls) overlayControls.style.display = compareMode ? 'block' : 'none';
    if (compareMode) {
      const img0 = images[0];
      applyImageState(img0, true);
      activeImageIdx = 0;
      sliceIdx.axial = Math.min(sliceIdx.axial, img0.header.nz - 1);
      sliceIdx.coronal = Math.min(sliceIdx.coronal, img0.header.ny - 1);
      sliceIdx.sagittal = Math.min(sliceIdx.sagittal, img0.header.nx - 1);
      updateImagePicker();
      updateFileInfo();
      updateSliderValues();
    }
    renderAllViews();
  });

  const opacitySlider = document.getElementById('opacity-slider') as HTMLInputElement;
  const opacityVal = document.getElementById('opacity-val');
  opacitySlider?.addEventListener('input', () => {
    overlayOpacity = parseInt(opacitySlider.value) / 100;
    if (opacityVal) opacityVal.textContent = opacitySlider.value;
    if (compareMode) renderAllViews();
  });

  const overlayCmapSelect = document.getElementById('overlay-colormap') as HTMLSelectElement;
  overlayCmapSelect?.addEventListener('change', () => {
    overlayColormap = overlayCmapSelect.value;
    if (compareMode) renderAllViews();
  });

  const btnAddImg = document.getElementById('btn-add-img') as HTMLButtonElement;
  btnAddImg?.addEventListener('click', () => {
    vscode.postMessage({ type: 'selectImage' });
  });

  const btnCrosshair = document.getElementById('btn-crosshair') as HTMLButtonElement;
  btnCrosshair?.addEventListener('click', () => {
    crosshairVisible = !crosshairVisible;
    btnCrosshair.classList.toggle('active', crosshairVisible);
    const coordEl = document.getElementById('coord-info');
    if (crosshairVisible) updateCoordInfoFromCenter();
    else if (coordEl) coordEl.textContent = 'Hover over image';
    renderAllViews();
  });
  if (crosshairVisible) btnCrosshair?.classList.add('active');

  // Measurement mode toggle
  const btnMeasure = document.getElementById('btn-measure') as HTMLButtonElement;
  btnMeasure?.addEventListener('click', () => {
    measureMode = !measureMode;
    btnMeasure.classList.toggle('active', measureMode);
    measureClickPending = null;
    measureDragStart = null;
    // Change cursor on canvases
    for (const axis of ['axial', 'coronal', 'sagittal'] as const) {
      canvases[axis].style.cursor = measureMode ? 'crosshair' : 'crosshair';
    }
    a11yAnnounce(measureMode ? 'Measure mode enabled' : 'Measure mode disabled');
  });

  // Clear measurements button
  const btnClearMeasure = document.getElementById('btn-clear-measure') as HTMLButtonElement;
  btnClearMeasure?.addEventListener('click', () => {
    clearMeasurements();
    a11yAnnounce('Measurements cleared');
  });

  const btnExport = document.getElementById('btn-export') as HTMLButtonElement;
  btnExport?.addEventListener('click', () => {
    if (!header) return;
    // Determine which axis to export (maximized or axial default)
    const exportAxis: Axis = (maximizedView as Axis) || 'axial';
    const canvas = canvases[exportAxis];
    if (!canvas) return;
    canvas.toBlob((blob) => {
      if (!blob) return;
      const reader = new FileReader();
      reader.onload = () => {
        const arrayBuffer = reader.result as ArrayBuffer;
        vscode.postMessage({
          type: 'exportSlice',
          axis: exportAxis,
          sliceIndex: sliceIdx[exportAxis],
          data: Array.from(new Uint8Array(arrayBuffer)),
        });
      };
      reader.readAsArrayBuffer(blob);
    }, 'image/png');
  });

  const btnHeader = document.getElementById('btn-header') as HTMLButtonElement;
  btnHeader?.addEventListener('click', () => {
    headerPanelVisible = !headerPanelVisible;
    const panel = document.getElementById('header-panel');
    if (panel) panel.style.display = headerPanelVisible ? 'block' : 'none';
    btnHeader.classList.toggle('active', headerPanelVisible);
    if (headerPanelVisible && header) updateHeaderPanel();
  });

  helpBtn?.addEventListener('click', () => helpPopup.classList.toggle('show'));
  document.addEventListener('click', (e) => {
    if (!helpBtn?.contains(e.target as Node) && !helpPopup?.contains(e.target as Node)) {
      helpPopup?.classList.remove('show');
    }
  });

  sidebarToggle?.addEventListener('click', () => {
    sidebarCollapsed = !sidebarCollapsed;
    if (sidebarCollapsed) {
      sidebarWidth = sidebar.offsetWidth;
      sidebar.style.width = '';
      sidebar.style.minWidth = '';
      sidebar.classList.add('collapsed');
      sidebarToggle.style.right = '0px';
    } else {
      sidebar.classList.remove('collapsed');
      sidebar.style.width = sidebarWidth + 'px';
      sidebar.style.minWidth = sidebarWidth + 'px';
      sidebarToggle.style.right = sidebarWidth + 'px';
    }
    sidebarToggle.textContent = sidebarCollapsed ? '◀' : '▶';
    renderAllViews();
  });

  let isResizing = false;
  let startX = 0;
  let startWidth = 0;

  sidebarResize?.addEventListener('mousedown', (e) => {
    isResizing = true;
    startX = e.clientX;
    startWidth = sidebar.offsetWidth;
    sidebar.style.transition = 'none';
    sidebarToggle.style.transition = 'none';
    document.body.style.cursor = 'ew-resize';
    e.preventDefault();
  });

  document.addEventListener('mousemove', (e) => {
    if (!isResizing) return;
    const newWidth = Math.max(120, Math.min(400, startWidth - (e.clientX - startX)));
    sidebar.style.width = newWidth + 'px';
    sidebar.style.minWidth = newWidth + 'px';
    sidebarWidth = newWidth;
    sidebarToggle.style.right = newWidth + 'px';
  });

  document.addEventListener('mouseup', () => {
    if (isResizing) {
      isResizing = false;
      sidebar.style.transition = '';
      sidebarToggle.style.transition = '';
      document.body.style.cursor = '';
      renderAllViews();
    }
  });

  const bindSlider = (sliderId: string, sideSliderId: string, axis: 'axial' | 'coronal' | 'sagittal') => {
    const handler = (val: number) => {
      sliceIdx[axis] = validateSliceIndex(axis, val);
      a11yAnnounce(`${axis} slice ${sliceIdx[axis] + 1}`);
      if (volumeData) updateSingleView(axis);
      else {
        void refreshSlices([axis], true);
        scheduleLODUpgrade(axis);
      }
    };
    const sl = document.getElementById(sliderId) as HTMLInputElement;
    const ssl = document.getElementById(sideSliderId) as HTMLInputElement;
    sl?.addEventListener('input', () => handler(parseInt(sl.value)));
    ssl?.addEventListener('input', () => handler(parseInt(ssl.value)));
  };

  bindSlider('axial-slider', 'axial-slider-side', 'axial');
  bindSlider('coronal-slider', 'coronal-slider-side', 'coronal');
  bindSlider('sagittal-slider', 'sagittal-slider-side', 'sagittal');

  document.querySelectorAll('.vb').forEach(btn => {
    btn.addEventListener('click', (e) => {
      const view = (e.target as HTMLElement).getAttribute('data-view');
      if (view) toggleMaximize(view);
    });
  });

  for (const axis of ['axial', 'coronal', 'sagittal'] as const) {
    const canvas = canvases[axis];

    let scrollAccumulator = 0;
    const SCROLL_THRESHOLD = perfProfile.tier === 'low' ? 30 : 15;
    let lastScrollTime = 0;

    canvas.addEventListener('wheel', (e) => {
      e.preventDefault();
      if (!header) return;
      
      if (e.ctrlKey || e.metaKey) {
        const zoomFactor = e.deltaY > 0 ? 0.9 : 1.1;
        viewState[axis].zoom = Math.max(0.5, Math.min(10, viewState[axis].zoom * zoomFactor));
        scheduleRender();
      } else {
        const now = Date.now();
        const timeDelta = now - lastScrollTime;
        lastScrollTime = now;

        const velocity = timeDelta > 0 ? Math.abs(e.deltaY) / timeDelta : 0;
        const adaptiveStep = velocity > 2 ? 2 : 1;

        scrollAccumulator += e.deltaY * (velocity > 2 ? 0.5 : 1);

        if (Math.abs(scrollAccumulator) >= SCROLL_THRESHOLD) {
          const delta = scrollAccumulator > 0 ? adaptiveStep : -adaptiveStep;
          scrollAccumulator = 0;
          const newIdx = validateSliceIndex(axis, sliceIdx[axis] + delta);
          if (newIdx !== sliceIdx[axis]) {
            sliceIdx[axis] = newIdx;
            if (volumeData) updateSingleView(axis);
            else {
              void refreshSlices([axis], true);
              scheduleLODUpgrade(axis);
            }
          }
        }
      }
    }, { passive: false });

    let isDragging = false;
    let lastX = 0, lastY = 0;
    let dragStartX = 0, dragStartY = 0;
    let dragMoved = false;
    let suppressClickUntil = 0;
    let isPinching = false;
    let lastPinchDist = 0;

    canvas.addEventListener('mousedown', (e) => {
      if (e.button === 0) {
        // ROI measurement: click and drag
        if (measureMode) {
          const rect = canvas.getBoundingClientRect();
          measureDragStart = { x: e.clientX - rect.left, y: e.clientY - rect.top, axis };
          measureClickPending = null; // Cancel any pending line click
          return;
        }
        isDragging = true;
        lastX = e.clientX;
        lastY = e.clientY;
        dragStartX = e.clientX;
        dragStartY = e.clientY;
        dragMoved = false;
        canvas.style.cursor = 'grabbing';
      }
    });

    document.addEventListener('mousemove', (e) => {
      if (isDragging) {
        const dx = e.clientX - lastX;
        const dy = e.clientY - lastY;
        viewState[axis].panX += dx;
        viewState[axis].panY += dy;
        if (Math.abs(e.clientX - dragStartX) > 3 || Math.abs(e.clientY - dragStartY) > 3) {
          dragMoved = true;
        }
        lastX = e.clientX;
        lastY = e.clientY;
        updateSingleView(axis);
      }
    });

    document.addEventListener('mouseup', (e) => {
      // ROI measurement: complete drag
      if (measureMode && measureDragStart && measureDragStart.axis === axis) {
        const rect = canvas.getBoundingClientRect();
        const endX = e.clientX - rect.left;
        const endY = e.clientY - rect.top;
        const dx = Math.abs(endX - measureDragStart.x);
        const dy = Math.abs(endY - measureDragStart.y);
        if (dx > 5 || dy > 5) {
          const area = computeRoiArea(axis, measureDragStart.x, measureDragStart.y, endX, endY);
          measurements.push({ type: 'roi', axis, x1: measureDragStart.x, y1: measureDragStart.y, x2: endX, y2: endY, area });
          drawMeasurements();
          a11yAnnounce(`ROI area: ${area.toFixed(2)} mm²`);
        }
        measureDragStart = null;
        return;
      }
      if (isDragging) {
        isDragging = false;
        canvas.style.cursor = 'crosshair';
        if (dragMoved) suppressClickUntil = Date.now() + 180;
      }
    });

    canvas.addEventListener('touchstart', (e) => {
      if (e.touches.length === 2) {
        isPinching = true;
        const dx = e.touches[0].clientX - e.touches[1].clientX;
        const dy = e.touches[0].clientY - e.touches[1].clientY;
        lastPinchDist = Math.sqrt(dx * dx + dy * dy);
      } else if (e.touches.length === 1) {
        isDragging = true;
        lastX = e.touches[0].clientX;
        lastY = e.touches[0].clientY;
        dragStartX = lastX;
        dragStartY = lastY;
        dragMoved = false;
      }
    }, { passive: true });

    canvas.addEventListener('touchmove', (e) => {
      if (isPinching && e.touches.length === 2) {
        const dx = e.touches[0].clientX - e.touches[1].clientX;
        const dy = e.touches[0].clientY - e.touches[1].clientY;
        const dist = Math.sqrt(dx * dx + dy * dy);
        const scale = dist / lastPinchDist;
        viewState[axis].zoom = Math.max(0.5, Math.min(10, viewState[axis].zoom * scale));
        lastPinchDist = dist;
        updateSingleView(axis);
      } else if (isDragging && e.touches.length === 1) {
        const dx = e.touches[0].clientX - lastX;
        const dy = e.touches[0].clientY - lastY;
        viewState[axis].panX += dx;
        viewState[axis].panY += dy;
        if (Math.abs(e.touches[0].clientX - dragStartX) > 3 || Math.abs(e.touches[0].clientY - dragStartY) > 3) {
          dragMoved = true;
        }
        lastX = e.touches[0].clientX;
        lastY = e.touches[0].clientY;
        updateSingleView(axis);
      }
    }, { passive: true });

    canvas.addEventListener('touchend', () => {
      if (isDragging && dragMoved) suppressClickUntil = Date.now() + 180;
      isDragging = false;
      isPinching = false;
    });

    canvas.addEventListener('click', (e) => {
      if (Date.now() < suppressClickUntil) return;
      if (!header) return;
      const rect = canvas.getBoundingClientRect();
      const clickX = e.clientX - rect.left;
      const clickY = e.clientY - rect.top;

      // Measurement mode: line measurement (click two points)
      if (measureMode && !measureDragStart) {
        if (!measureClickPending) {
          measureClickPending = { x: clickX, y: clickY, axis };
        } else if (measureClickPending.axis === axis) {
          const distance = computeLineDistance(axis, measureClickPending.x, measureClickPending.y, clickX, clickY);
          measurements.push({ type: 'line', axis, x1: measureClickPending.x, y1: measureClickPending.y, x2: clickX, y2: clickY, distance });
          measureClickPending = null;
          drawMeasurements();
          a11yAnnounce(`Line measurement: ${distance.toFixed(2)} mm`);
        } else {
          measureClickPending = { x: clickX, y: clickY, axis };
        }
        return;
      }

      if (compareMode && compareLayout === 'sideBySide' && images.length >= 2) {
        const img0 = images[0];
        const img1 = images[1];
        const h0 = img0.header;
        const h1 = img1.header;
        const halfW = rect.width / 2;
        const vs = viewState[axis];
        const isRight = clickX >= halfW;

        if (isRight) {
          const pw1 = axis === 'sagittal' ? h1.ny * h1.dy : h1.nx * h1.dx;
          const ph1 = axis === 'axial' ? h1.ny * h1.dy : h1.nz * h1.dz;
          const ar1 = pw1 / ph1;
          let cw1: number, ch1: number;
          if (halfW / rect.height > ar1) { ch1 = rect.height; cw1 = ch1 * ar1; }
          else { cw1 = halfW; ch1 = cw1 / ar1; }
          cw1 *= vs.zoom; ch1 *= vs.zoom;
          const imgLeft1 = halfW + (halfW - cw1) / 2 + vs.panX;
          const imgTop1 = (rect.height - ch1) / 2 + vs.panY;
          if (clickX < imgLeft1 || clickX > imgLeft1 + cw1 || clickY < imgTop1 || clickY > imgTop1 + ch1) return;
          const nx_click = (clickX - imgLeft1) / cw1;
          const ny_click = (clickY - imgTop1) / ch1;
          const w1 = axis === 'sagittal' ? h1.ny : h1.nx;
          const h1_ = axis === 'axial' ? h1.ny : h1.nz;
          let vx: number, vy: number, vz: number;
          if (axis === 'axial') { vx = nx_click * w1; vy = (1 - ny_click) * h1_; vz = sliceIdx.axial; }
          else if (axis === 'coronal') { vx = nx_click * w1; vy = sliceIdx.coronal; vz = (1 - ny_click) * h1_; }
          else { vx = sliceIdx.sagittal; vy = nx_click * w1; vz = (1 - ny_click) * h1_; }
          const [wx, wy, wz] = voxelToWorld(h1, vx, vy, vz);
          const [svx, svy, svz] = worldToVoxel(h0, wx, wy, wz);
          sliceIdx.sagittal = Math.max(0, Math.min(h0.nx - 1, Math.round(svx)));
          sliceIdx.coronal = Math.max(0, Math.min(h0.ny - 1, Math.round(svy)));
          sliceIdx.axial = Math.max(0, Math.min(h0.nz - 1, Math.round(svz)));
        } else {
          const pw0 = axis === 'sagittal' ? h0.ny * h0.dy : h0.nx * h0.dx;
          const ph0 = axis === 'axial' ? h0.ny * h0.dy : h0.nz * h0.dz;
          const ar0 = pw0 / ph0;
          let cw0: number, ch0: number;
          if (halfW / rect.height > ar0) { ch0 = rect.height; cw0 = ch0 * ar0; }
          else { cw0 = halfW; ch0 = cw0 / ar0; }
          cw0 *= vs.zoom; ch0 *= vs.zoom;
          const imgLeft0 = (halfW - cw0) / 2 + vs.panX;
          const imgTop0 = (rect.height - ch0) / 2 + vs.panY;
          if (clickX < imgLeft0 || clickX > imgLeft0 + cw0 || clickY < imgTop0 || clickY > imgTop0 + ch0) return;
          const nx_click = (clickX - imgLeft0) / cw0;
          const ny_click = (clickY - imgTop0) / ch0;
          const w0 = axis === 'sagittal' ? h0.ny : h0.nx;
          const h0_ = axis === 'axial' ? h0.ny : h0.nz;
          if (axis === 'axial') {
            sliceIdx.sagittal = Math.max(0, Math.min(h0.nx - 1, Math.floor(nx_click * w0)));
            sliceIdx.coronal = Math.max(0, Math.min(h0.ny - 1, Math.floor((1 - ny_click) * h0_)));
          } else if (axis === 'coronal') {
            sliceIdx.sagittal = Math.max(0, Math.min(h0.nx - 1, Math.floor(nx_click * w0)));
            sliceIdx.axial = Math.max(0, Math.min(h0.nz - 1, Math.floor((1 - ny_click) * h0_)));
          } else {
            sliceIdx.coronal = Math.max(0, Math.min(h0.ny - 1, Math.floor(nx_click * w0)));
            sliceIdx.axial = Math.max(0, Math.min(h0.nz - 1, Math.floor((1 - ny_click) * h0_)));
          }
        }
        if (volumeData) renderAllViews();
        else void refreshSlices(['axial', 'coronal', 'sagittal']);
        return;
      }

      const { nx, ny, nz, dx, dy } = header;
      const pixelW = nx * dx;
      const pixelH = ny * dy;
      const ar = pixelW / pixelH;
      const vs = viewState[axis];
      let cw: number, ch: number;
      if (rect.width / rect.height > ar) { ch = rect.height; cw = ch * ar; }
      else { cw = rect.width; ch = cw / ar; }
      cw *= vs.zoom;
      ch *= vs.zoom;

      const imgLeft = (rect.width - cw) / 2 + vs.panX;
      const imgTop = (rect.height - ch) / 2 + vs.panY;

      if (clickX < imgLeft || clickX > imgLeft + cw ||
          clickY < imgTop || clickY > imgTop + ch) return;

      const nx_click = (clickX - imgLeft) / cw;
      const ny_click = (clickY - imgTop) / ch;

      if (axis === 'axial') {
        sliceIdx.sagittal = Math.max(0, Math.min(nx - 1, Math.floor(nx_click * nx)));
        sliceIdx.coronal = Math.max(0, Math.min(ny - 1, Math.floor((1 - ny_click) * ny)));
      } else if (axis === 'coronal') {
        sliceIdx.sagittal = Math.max(0, Math.min(nx - 1, Math.floor(nx_click * nx)));
        sliceIdx.axial = Math.max(0, Math.min(nz - 1, Math.floor((1 - ny_click) * nz)));
      } else {
        sliceIdx.coronal = Math.max(0, Math.min(ny - 1, Math.floor(nx_click * ny)));
        sliceIdx.axial = Math.max(0, Math.min(nz - 1, Math.floor((1 - ny_click) * nz)));
      }

      if (volumeData) renderAllViews();
      else void refreshSlices(['axial', 'coronal', 'sagittal']);
    });

    canvas.addEventListener('mousemove', (e) => {
      if (!header) return;
      if (crosshairVisible) {
        updateCoordInfoFromCenter();
        return;
      }
      const rect = canvas.getBoundingClientRect();
      const mouseX = e.clientX - rect.left;
      const mouseY = e.clientY - rect.top;
      const coordEl = document.getElementById('coord-info');
      if (!coordEl) return;

      if (compareMode && images.length >= 2) {
        const img0 = images[0];
        const img1 = images[1];
        if (!img0.data || !img1.data) {
          coordEl.textContent = '';
          return;
        }
        const h0 = img0.header;
        const h1 = img1.header;
        const vs = viewState[axis];

        if (compareLayout === 'sideBySide') {
          const halfW = rect.width / 2;
          const isRight = mouseX >= halfW;
          const img = isRight ? img1 : img0;
          const hi = img.header;
          const pw = axis === 'sagittal' ? hi.ny * hi.dy : hi.nx * hi.dx;
          const ph = axis === 'axial' ? hi.ny * hi.dy : hi.nz * hi.dz;
          const ar = pw / ph;
          let iw: number, ih: number;
          if (halfW / rect.height > ar) { ih = rect.height; iw = ih * ar; }
          else { iw = halfW; ih = iw / ar; }
          iw *= vs.zoom; ih *= vs.zoom;
          const il = (isRight ? halfW : 0) + (halfW - iw) / 2 + vs.panX;
          const it = (rect.height - ih) / 2 + vs.panY;
          if (mouseX < il || mouseX > il + iw || mouseY < it || mouseY > it + ih) { coordEl.textContent = ''; return; }
          const nx_m = (mouseX - il) / iw;
          const ny_m = (mouseY - it) / ih;
          const w = axis === 'sagittal' ? hi.ny : hi.nx;
          const h_ = axis === 'axial' ? hi.ny : hi.nz;
          let px: number, py: number, pz: number;
          if (axis === 'axial') { px = Math.floor(nx_m * w); py = Math.floor((1 - ny_m) * h_); pz = sliceIdx.axial; }
          else if (axis === 'coronal') { px = Math.floor(nx_m * w); pz = Math.floor((1 - ny_m) * h_); py = sliceIdx.coronal; }
          else { py = Math.floor(nx_m * w); pz = Math.floor((1 - ny_m) * h_); px = sliceIdx.sagittal; }
          if (px >= 0 && px < hi.nx && py >= 0 && py < hi.ny && pz >= 0 && pz < hi.nz) {
            const other = isRight ? img0 : img1;
            if (!img.data || !other.data) {
              coordEl.textContent = '';
              return;
            }
            const val = img.data[pz * hi.ny * hi.nx + py * hi.nx + px] * img.slope + img.inter;
            const [wx, wy, wz] = voxelToWorld(hi, px, py, pz);
            const oh = other.header;
            const [ox, oy, oz] = worldToVoxel(oh, wx, wy, wz);
            const oxi = Math.round(ox), oyi = Math.round(oy), ozi = Math.round(oz);
            let otherVal: string;
            if (oxi >= 0 && oxi < oh.nx && oyi >= 0 && oyi < oh.ny && ozi >= 0 && ozi < oh.nz) {
              const ov = other.data[ozi * oh.ny * oh.nx + oyi * oh.nx + oxi] * other.slope + other.inter;
              otherVal = ov.toFixed(4);
            } else { otherVal = '---'; }
            const name0 = isRight ? other.name : img.name;
            const name1 = isRight ? img.name : other.name;
            const v0 = isRight ? otherVal : val.toFixed(4);
            const v1 = isRight ? val.toFixed(4) : otherVal;
            coordEl.textContent = `${name0}: ${v0}\n${name1}: ${v1}`;
          }
        } else {
          const { nx, ny, nz, dx, dy } = h0;
          const pixelW = nx * dx;
          const pixelH = ny * dy;
          const ar = pixelW / pixelH;
          let imgW: number, imgH: number;
          if (rect.width / rect.height > ar) { imgH = rect.height; imgW = imgH * ar; }
          else { imgW = rect.width; imgH = imgW / ar; }
          imgW *= vs.zoom; imgH *= vs.zoom;
          const imgLeft = (rect.width - imgW) / 2 + vs.panX;
          const imgTop = (rect.height - imgH) / 2 + vs.panY;
          if (mouseX < imgLeft || mouseX > imgLeft + imgW || mouseY < imgTop || mouseY > imgTop + imgH) { coordEl.textContent = ''; return; }
          const nx_mouse = (mouseX - imgLeft) / imgW;
          const ny_mouse = (mouseY - imgTop) / imgH;
          let px: number, py: number, pz: number;
          if (axis === 'axial') { px = Math.floor(nx_mouse * nx); py = Math.floor((1 - ny_mouse) * ny); pz = sliceIdx.axial; }
          else if (axis === 'coronal') { px = Math.floor(nx_mouse * nx); pz = Math.floor((1 - ny_mouse) * nz); py = sliceIdx.coronal; }
          else { py = Math.floor(nx_mouse * ny); pz = Math.floor((1 - ny_mouse) * nz); px = sliceIdx.sagittal; }
          if (px >= 0 && px < nx && py >= 0 && py < ny && pz >= 0 && pz < nz) {
            if (!img0.data || !img1.data) {
              coordEl.textContent = '';
              return;
            }
            const val0 = img0.data[pz * ny * nx + py * nx + px] * img0.slope + img0.inter;
            const [wx, wy, wz] = voxelToWorld(h0, px, py, pz);
            const [vx1, vy1, vz1] = worldToVoxel(h1, wx, wy, wz);
            const ix1 = Math.round(vx1), iy1 = Math.round(vy1), iz1 = Math.round(vz1);
            let val1Str: string;
            if (ix1 >= 0 && ix1 < h1.nx && iy1 >= 0 && iy1 < h1.ny && iz1 >= 0 && iz1 < h1.nz) {
              val1Str = (img1.data[iz1 * h1.ny * h1.nx + iy1 * h1.nx + ix1] * img1.slope + img1.inter).toFixed(4);
            } else { val1Str = '---'; }
            coordEl.textContent = `${img0.name}: ${val0.toFixed(4)}\n${img1.name}: ${val1Str}`;
          }
        }
        return;
      }

      const { nx, ny, nz, dx, dy } = header;
      const pixelW = nx * dx;
      const pixelH = ny * dy;
      const ar = pixelW / pixelH;
      const vs = viewState[axis];
      let imgW: number, imgH: number;
      if (rect.width / rect.height > ar) { imgH = rect.height; imgW = imgH * ar; }
      else { imgW = rect.width; imgH = imgW / ar; }
      imgW *= vs.zoom;
      imgH *= vs.zoom;

      const imgLeft = (rect.width - imgW) / 2 + vs.panX;
      const imgTop = (rect.height - imgH) / 2 + vs.panY;

      if (mouseX < imgLeft || mouseX > imgLeft + imgW ||
          mouseY < imgTop || mouseY > imgTop + imgH) return;

      const nx_mouse = (mouseX - imgLeft) / imgW;
      const ny_mouse = (mouseY - imgTop) / imgH;

      let px: number, py: number, pz: number;

      if (axis === 'axial') {
        px = Math.floor(nx_mouse * nx);
        py = Math.floor((1 - ny_mouse) * ny);
        pz = sliceIdx.axial;
      } else if (axis === 'coronal') {
        px = Math.floor(nx_mouse * nx);
        pz = Math.floor((1 - ny_mouse) * nz);
        py = sliceIdx.coronal;
      } else {
        py = Math.floor(nx_mouse * ny);
        pz = Math.floor((1 - ny_mouse) * nz);
        px = sliceIdx.sagittal;
      }

      if (px >= 0 && px < nx && py >= 0 && py < ny && pz >= 0 && pz < nz) {
        let val: number | null = null;
        if (volumeData) {
          val = volumeData[pz * ny * nx + py * nx + px] * dataSlope + dataInter;
        } else {
          const frame = currentSlices[axis];
          const geometry = getAxisGeometry(axis);
          if (frame) {
            const sx = Math.max(0, Math.min(frame.width - 1, Math.floor((px / Math.max(1, geometry.width - 1)) * Math.max(1, frame.width - 1))));
            const syBase = axis === 'axial' ? py : pz;
            const sy = Math.max(0, Math.min(frame.height - 1, Math.floor((syBase / Math.max(1, geometry.height - 1)) * Math.max(1, frame.height - 1))));
            val = frame.data[sy * frame.width + sx];
          }
        }
        if (val !== null) coordEl.textContent = `x=${px} y=${py} z=${pz}\nValue: ${val.toFixed(4)}`;
      }
    });

    const minimap = canvas.parentElement?.querySelector('.minimap') as HTMLDivElement;
    minimap?.addEventListener('click', (e) => {
      if (!header || viewState[axis].zoom <= 1.1) return;
      e.stopPropagation();
      const rect = minimap.getBoundingClientRect();
      const mx = (e.clientX - rect.left) / rect.width;
      const my = (e.clientY - rect.top) / rect.height;

      const zoom = viewState[axis].zoom;
      const container = canvas.parentElement!;
      const dw = container.clientWidth;
      const dh = container.clientHeight;

      // Compute displayed image size (same as paintSlice)
      const pixelW = axis === 'axial' ? header.nx * header.dx : axis === 'coronal' ? header.nx * header.dx : header.ny * header.dy;
      const pixelH = axis === 'axial' ? header.ny * header.dy : axis === 'coronal' ? header.nz * header.dz : header.nz * header.dz;
      const ar = pixelW / pixelH;
      let cw: number, ch: number;
      if (dw / dh > ar) { ch = dh; cw = Math.floor(dh * ar); }
      else { cw = dw; ch = Math.floor(dw / ar); }
      cw = Math.floor(cw * zoom);
      ch = Math.floor(ch * zoom);

      // Pan limits match paintSlice exactly
      const maxPanX = Math.max(0, (cw - dw) / 2);
      const maxPanY = Math.max(0, (ch - dh) / 2);

      const effectiveMx = 1 - mx;
      const effectiveMy = 1 - my;
      viewState[axis].panX = (effectiveMx - 0.5) * 2 * maxPanX;
      viewState[axis].panY = (effectiveMy - 0.5) * 2 * maxPanY;

      updateSingleView(axis);
    });
  }

  const mipCanvas = canvases.mip;
  let mipDragging = false;
  let mipLastX = 0, mipLastY = 0;

  mipCanvas.addEventListener('mousedown', (e) => {
    mipDragging = true;
    mipLastX = e.clientX;
    mipLastY = e.clientY;
    mipCanvas.style.cursor = 'grabbing';
  });

  document.addEventListener('mousemove', (e) => {
    if (mipDragging) {
      const dx = e.clientX - mipLastX;
      const dy = e.clientY - mipLastY;
      viewState.mip.rotationY += dx * 0.01;
      viewState.mip.rotationX += dy * 0.01;
      mipLastX = e.clientX;
      mipLastY = e.clientY;
      paintMIP();
    }
  });

  document.addEventListener('mouseup', () => {
    if (mipDragging) {
      mipDragging = false;
      mipCanvas.style.cursor = 'crosshair';
    }
  });

  let resizeTimer: ReturnType<typeof setTimeout> | null = null;
  window.addEventListener('resize', () => {
    if (resizeTimer) clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => renderAllViews(), 150);
  });

  // Direct keyboard shortcuts in webview
  document.addEventListener('keydown', (e) => {
    if (e.altKey) {
      if (e.key === 'ArrowUp') { e.preventDefault(); handleKeyboardAction('scrollSliceUp'); }
      else if (e.key === 'ArrowDown') { e.preventDefault(); handleKeyboardAction('scrollSliceDown'); }
      else if (e.key === 'a') { e.preventDefault(); handleKeyboardAction('setViewAxial'); }
      else if (e.key === 'c') { e.preventDefault(); handleKeyboardAction('setViewCoronal'); }
      else if (e.key === 's') { e.preventDefault(); handleKeyboardAction('setViewSagittal'); }
      else if (e.key === 'r') { e.preventDefault(); handleKeyboardAction('resetView'); }
    }
    // Accessibility: Escape exits measure mode
    if (e.key === 'Escape' && measureMode) {
      measureMode = false;
      measureClickPending = null;
      measureDragStart = null;
      const btnM = document.getElementById('btn-measure') as HTMLButtonElement;
      if (btnM) btnM.classList.remove('active');
      a11yAnnounce('Measure mode disabled');
    }
  });

  // Accessibility: keyboard focus management for canvases
  for (const axis of ['axial', 'coronal', 'sagittal'] as const) {
    const canvas = canvases[axis];
    canvas.addEventListener('focus', () => { focusedCanvas = axis; });
    canvas.addEventListener('blur', () => { if (focusedCanvas === axis) focusedCanvas = null; });
    canvas.addEventListener('keydown', (e) => {
      if (!header) return;
      if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
        e.preventDefault();
        const delta = e.key === 'ArrowUp' ? -1 : 1;
        const max = axis === 'axial' ? header.nz - 1 : axis === 'coronal' ? header.ny - 1 : header.nx - 1;
        const newIdx = Math.max(0, Math.min(max, sliceIdx[axis] + delta));
        if (newIdx !== sliceIdx[axis]) {
          sliceIdx[axis] = newIdx;
          if (volumeData) updateSingleView(axis);
          else { void refreshSlices([axis], true); scheduleLODUpgrade(axis); }
          a11yAnnounce(`${axis} slice ${newIdx + 1} of ${max + 1}`);
        }
      }
    });
    // WebGL context loss recovery
    canvas.addEventListener('webglcontextlost', (e) => {
      e.preventDefault();
      handleWebGLContextLoss(canvas, axis);
    });
  }

  // High contrast media query listener
  try {
    window.matchMedia('(prefers-contrast: more)').addEventListener('change', (e) => {
      highContrastPreferred = e.matches;
      renderAllViews();
    });
  } catch {}
}

import { NiiHeader, DATATYPE_NAMES } from './nii-parser';

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
  renderBackend: 'webgl' | 'canvas';
  fullVolumePolicy: 'manual' | 'debounced' | 'eager';
  nativeAcceleration: 'off' | 'auto' | 'force';
}

interface PerformanceProfile {
  tier: 'high' | 'medium' | 'low';
  gpuAvailable: boolean;
  maxTextureSize: number;
  cores: number;
  memoryMB: number;
}

const images: VolumeImage[] = [];
let activeImageIdx = 0;
let compareMode = false;

let header: NiiHeader | null = null;
let volumeData: Int8Array | Uint8Array | Int16Array | Uint16Array | Int32Array | Uint32Array | Float32Array | Float64Array | null = null;
let dataSlope = 1;
let dataInter = 0;
let globalMin = 0;
let globalMax = 1;
let initialWindowWidth = 1.0;
let initialWindowLevel = 0.5;

const sliceIdx = { axial: 0, coronal: 0, sagittal: 0 };
let windowWidth = 1.0;
let windowLevel = 0.5;
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

const currentSlices: Record<Axis, SliceFrame | null> = {
  axial: null,
  coronal: null,
  sagittal: null,
};

const perfMonitor = {
  previewLoads: [] as number[],
  fullLoads: [] as number[],
  failures: 0,
  evictions: 0,
};

const viewerConfig: ViewerConfig = {
  previewMode: 'binary',
  renderBackend: 'canvas',
  fullVolumePolicy: 'debounced',
  nativeAcceleration: 'auto',
};

const previewRequestCache = new Map<string, Promise<any | null>>();
let thumbnailObserver: IntersectionObserver | null = null;

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
  };
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
  private texture: WebGLTexture | null = null;
  private lutTexture: WebGLTexture | null = null;
  private posBuffer: WebGLBuffer | null = null;
  private texCoordBuffer: WebGLBuffer | null = null;
  private ready = false;
  private currentLut: string = '';
  private supportsFloatTexture = false;

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

  init(canvas: HTMLCanvasElement): boolean {
    const gl2 = canvas.getContext('webgl2', { premultipliedAlpha: false, preserveDrawingBuffer: true });
    if (gl2) {
      this.gl = gl2;
      this.supportsFloatTexture = false;
      return false;
    }
    const gl1 = canvas.getContext('webgl', { premultipliedAlpha: false, preserveDrawingBuffer: true });
    if (gl1) {
      this.gl = gl1;
      this.supportsFloatTexture = !!gl1.getExtension('OES_texture_float');
      if (!this.supportsFloatTexture) return false;
      return this.setupProgram();
    }
    return false;
  }

  private setupProgram(): boolean {
    const gl = this.gl!;
    const vs = this.compileShader(gl.VERTEX_SHADER, this.vertexShaderSource);
    const fs = this.compileShader(gl.FRAGMENT_SHADER, this.fragmentShaderSource);
    if (!vs || !fs) return false;

    this.program = gl.createProgram()!;
    gl.attachShader(this.program, vs);
    gl.attachShader(this.program, fs);
    gl.linkProgram(this.program);
    if (!gl.getProgramParameter(this.program, gl.LINK_STATUS)) return false;

    this.texture = gl.createTexture();
    this.lutTexture = gl.createTexture();
    this.posBuffer = gl.createBuffer();
    this.texCoordBuffer = gl.createBuffer();

    gl.bindBuffer(gl.ARRAY_BUFFER, this.texCoordBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([0, 1, 1, 1, 0, 0, 1, 0]), gl.STATIC_DRAW);

    this.ready = true;
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
    lo: number, range: number, cmapName: string): boolean {
    if (!this.ready || !this.gl || !this.program || !this.supportsFloatTexture) return false;
    const gl = this.gl;

    const dpr = window.devicePixelRatio || 1;
    canvas.width = canvas.clientWidth * dpr;
    canvas.height = canvas.clientHeight * dpr;
    gl.viewport(0, 0, canvas.width, canvas.height);

    gl.useProgram(this.program);

    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.texture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

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
    if (gl.getError() !== gl.NO_ERROR) return false;

    if (this.currentLut !== cmapName) {
      this.updateLUT(cmapName);
      this.currentLut = cmapName;
    }

    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.lutTexture);

    const uImage = gl.getUniformLocation(this.program, 'u_image');
    const uLut = gl.getUniformLocation(this.program, 'u_lut');
    const uLo = gl.getUniformLocation(this.program, 'u_lo');
    const uHi = gl.getUniformLocation(this.program, 'u_hi');
    const uRange = gl.getUniformLocation(this.program, 'u_range');

    gl.uniform1i(uImage, 0);
    gl.uniform1i(uLut, 1);
    gl.uniform1f(uLo, lo);
    gl.uniform1f(uHi, lo + range);
    gl.uniform1f(uRange, range);

    const aPos = gl.getAttribLocation(this.program, 'a_position');
    const aTex = gl.getAttribLocation(this.program, 'a_texCoord');

    gl.bindBuffer(gl.ARRAY_BUFFER, this.posBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.DYNAMIC_DRAW);
    gl.enableVertexAttribArray(aPos);
    gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 0, 0);

    gl.bindBuffer(gl.ARRAY_BUFFER, this.texCoordBuffer);
    gl.enableVertexAttribArray(aTex);
    gl.vertexAttribPointer(aTex, 2, gl.FLOAT, false, 0, 0);

    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    if (gl.getError() !== gl.NO_ERROR) return false;
    return true;
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
    if (this.posBuffer) this.gl.deleteBuffer(this.posBuffer);
    if (this.texCoordBuffer) this.gl.deleteBuffer(this.texCoordBuffer);
    this.ready = false;
    this.gl = null;
  }
}

function detectPerformance(): PerformanceProfile {
  const nav = navigator as any;
  const cores = nav.hardwareConcurrency || 4;
  const memoryMB = nav.deviceMemory ? nav.deviceMemory * 1024 : 4096;

  let gpuAvailable = false;
  let maxTextureSize = 4096;
  try {
    const testCanvas = document.createElement('canvas');
    const gl = testCanvas.getContext('webgl2') || testCanvas.getContext('webgl');
    if (gl) {
      gpuAvailable = true;
      maxTextureSize = gl.getParameter(gl.MAX_TEXTURE_SIZE) || 4096;
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

  return { tier, gpuAvailable, maxTextureSize, cores, memoryMB };
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
  return [wx / h.dx, wy / h.dy, wz / h.dz];
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

let cachedWorker: Worker | null = null;
let cachedBlobUrl: string | null = null;

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
}

async function getWorker(): Promise<Worker> {
  if (cachedWorker) return cachedWorker;
  cachedWorker = new Worker(await ensureWorkerBlobUrl());
  attachWorkerRouter(cachedWorker);
  return cachedWorker;
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

function applyImageState(img: VolumeImage, preserveSlices = false) {
  header = img.header;
  volumeData = img.data;
  dataSlope = img.slope;
  dataInter = img.inter;
  globalMin = img.min;
  globalMax = img.max;
  fileName = img.name;
  img.lastAccess = Date.now();
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
  const worker = await getWorker();
  const geometry = getAxisGeometry(axis);
  const response = await sendWorkerRequest<{
    type: 'slice';
    axis: Axis;
    index: number;
    factor: number;
    width: number;
    height: number;
    data: Float32Array;
  }>(worker, {
    type: 'fetchSlice',
    url: fileUrl,
    axis,
    index: sliceIdx[axis],
    factor,
    prefetch: PRELOAD_RANGE,
    maxIndex: geometry.maxIndex,
  });
  if (response.index !== sliceIdx[axis]) return;
  setCurrentSlice(axis, response.data, response.width || geometry.width, response.height || geometry.height, response.factor);
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

function preloadSlices(axis: 'axial' | 'coronal' | 'sagittal', currentIdx: number): void {
  if (!header || !volumeData) return;
  const max = axis === 'axial' ? header.nz : axis === 'coronal' ? header.ny : header.nx;

  for (let d = 1; d <= PRELOAD_RANGE; d++) {
    for (const offset of [d, -d]) {
      const idx = currentIdx + offset;
      if (idx < 0 || idx >= max) continue;
      const cacheKey = `${axis}:${idx}:${colormap}:${windowWidth}:${windowLevel}`;
      if (sliceRenderCache.has(cacheKey)) continue;

      requestIdleCallback(() => {
        if (!header || !volumeData) return;
        const { nx, ny, nz, dx, dy, dz } = header;
        const slice = extractSlice(axis, idx);
        let w: number, h: number, pw: number, ph: number;
        if (axis === 'axial') { w = nx; h = ny; pw = nx * dx; ph = ny * dy; }
        else if (axis === 'coronal') { w = nx; h = nz; pw = nx * dx; ph = nz * dz; }
        else { w = ny; h = nz; pw = ny * dy; ph = nz * dz; }

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

        for (let i = 0; i < n; i++) {
          const norm = (slice[i] - globalMin) / dataRange;
          const t = Math.max(0, Math.min(1, (norm - lo) / range));
          const [r, g, b] = cmapFn(t);
          const idx4 = i * 4;
          pixels[idx4] = r; pixels[idx4 + 1] = g; pixels[idx4 + 2] = b; pixels[idx4 + 3] = 255;
        }
        tctx.putImageData(imgData, 0, 0);
        setCachedSliceRender(axis, idx, tc);
        float32Pool.release(slice);
      });
    }
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

function paintSlice(axis: string, data: Float32Array, w: number, h: number, pixelW: number, pixelH: number) {
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
  if (renderer && zoom === 1 && panX === 0 && panY === 0 && renderer.renderSlice(canvas, data, w, h, windowLevel - windowWidth * 0.5, windowWidth || 1, colormap)) {
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
  const hi = windowLevel + windowWidth * 0.5;
  const range = hi - lo || 1;
  const dataRange = globalMax - globalMin || 1;
  const n = w * h;

  for (let i = 0; i < n; i++) {
    const norm = (data[i] - globalMin) / dataRange;
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

  const imgLeft = (dw - cw) / 2 + panX;
  const imgTop = (dh - ch) / 2 + panY;
  const offsetX = imgLeft * dpr;
  const offsetY = (imgTop + ch) * dpr;
  const scaleX = cw * dpr / w;
  const scaleY = -ch * dpr / h;

  ctx.save();
  ctx.translate(offsetX, offsetY);
  ctx.scale(scaleX, scaleY);
  ctx.drawImage(tc, 0, 0);
  ctx.restore();

  updateDirectionLabels(axis);
  updateCrosshair(axis, w, h, zoom, panX, panY, cw, ch);
  updateScaleBar(axis, pixelW, pixelH, zoom, cw);
  updateMinimap(axis, w, h, zoom, panX, panY, cw, ch);
}

function getCoordLabelX(axis: string): { left: string; right: string } {
  const ori = header?.orientation || 'RAS';
  if (axis === 'sagittal') {
    switch (ori) {
      case 'RAS': case 'RPS': case 'RSA': return { left: 'A', right: 'P' };
      case 'LAS': case 'LPS': case 'LSA': return { left: 'P', right: 'A' };
      default: return { left: 'A', right: 'P' };
    }
  }
  switch (ori) {
    case 'RAS': case 'RPS': case 'RSA': return { left: 'R', right: 'L' };
    case 'LAS': case 'LPS': case 'LSA': return { left: 'L', right: 'R' };
    default: return { left: 'R', right: 'L' };
  }
}

function getCoordLabelY(axis: string): { top: string; bottom: string } {
  const ori = header?.orientation || 'RAS';
  if (axis === 'sagittal') {
    switch (ori) {
      case 'RAS': case 'LAS': case 'RSA': case 'LSA': return { top: 'S', bottom: 'I' };
      case 'RPS': case 'LPS': return { top: 'I', bottom: 'S' };
      default: return { top: 'S', bottom: 'I' };
    }
  }
  if (axis === 'coronal') {
    switch (ori) {
      case 'RAS': case 'LAS': return { top: 'S', bottom: 'I' };
      case 'RPS': case 'LPS': return { top: 'I', bottom: 'S' };
      case 'RSA': case 'LSA': return { top: 'A', bottom: 'P' };
      default: return { top: 'S', bottom: 'I' };
    }
  }
  switch (ori) {
    case 'RAS': case 'LAS': return { top: 'A', bottom: 'P' };
    case 'RPS': case 'LPS': return { top: 'P', bottom: 'A' };
    case 'RSA': case 'LSA': return { top: 'P', bottom: 'A' };
    default: return { top: 'A', bottom: 'P' };
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

  const screenX = imgLeft + cx_norm * imgW;
  const screenY = imgTop + (1 - cy_norm) * imgH;

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

        for (let my = 0; my < mh; my++) {
          for (let mx = 0; mx < mw; mx++) {
            const sx = Math.floor((mx / mw) * w);
            const sy = h - 1 - Math.floor((my / mh) * h);
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
  
  const maxPanX = (cw * zoom - cw) / 2;
  const maxPanY = (ch * zoom - ch) / 2;
  
  const normPanX = maxPanX > 0 ? (panX + maxPanX) / (2 * maxPanX) : 0.5;
  const normPanY = maxPanY > 0 ? (panY + maxPanY) / (2 * maxPanY) : 0.5;
  
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
    if (currentSlices.axial) paintSlice('axial', currentSlices.axial.data, currentSlices.axial.width, currentSlices.axial.height, nx * dx, ny * dy);
    if (currentSlices.coronal) paintSlice('coronal', currentSlices.coronal.data, currentSlices.coronal.width, currentSlices.coronal.height, nx * dx, nz * dz);
    if (currentSlices.sagittal) paintSlice('sagittal', currentSlices.sagittal.data, currentSlices.sagittal.width, currentSlices.sagittal.height, ny * dy, nz * dz);
  }

  updateAllInfo();
  if (crosshairVisible) updateCoordInfoFromCenter();

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

function renderCompareViews() {
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

  const axes: ('axial' | 'coronal' | 'sagittal')[] = ['axial', 'coronal', 'sagittal'];
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
  paintMIP();
  updateAllInfo();
}

function renderSliceToTempCanvas(data: Float32Array, w: number, h: number, imgMin: number, imgMax: number, cmapName: string): HTMLCanvasElement {
  const tc = document.createElement('canvas');
  tc.width = w; tc.height = h;
  const tctx = tc.getContext('2d')!;
  const imgData = tctx.createImageData(w, h);
  const pixels = imgData.data;
  const cmapFn = COLORMAPS[cmapName] || COLORMAPS.gray;
  const lo = windowLevel - windowWidth * 0.5;
  const hi = windowLevel + windowWidth * 0.5;
  const range = hi - lo || 1;
  const dataRange = imgMax - imgMin || 1;
  const n = w * h;
  for (let i = 0; i < n; i++) {
    const norm = (data[i] - imgMin) / dataRange;
    const t = Math.max(0, Math.min(1, (norm - lo) / range));
    const [r, g, b] = cmapFn(t);
    const idx = i * 4;
    pixels[idx] = r; pixels[idx + 1] = g; pixels[idx + 2] = b; pixels[idx + 3] = 255;
  }
  tctx.putImageData(imgData, 0, 0);
  return tc;
}

function paintOverlaySlice(axis: string, data0: Float32Array, data1: Float32Array,
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

  const ar0 = pw0 / ph0;
  let cw: number, ch: number;
  if (dw / dh > ar0) { ch = dh; cw = Math.floor(dh * ar0); }
  else { cw = dw; ch = Math.floor(dw / ar0); }
  cw = Math.floor(cw * zoom);
  ch = Math.floor(ch * zoom);

  canvas.style.width = cw + 'px';
  canvas.style.height = ch + 'px';
  canvas.width = cw * dpr;
  canvas.height = ch * dpr;

  const ctx = canvas.getContext('2d')!;
  ctx.imageSmoothingEnabled = false;

  const tc0 = renderSliceToTempCanvas(data0, w0, h0_, img0.min, img0.max, colormap);
  const tc1 = renderSliceToTempCanvas(data1, w1, h1_, img1.min, img1.max, overlayColormap);

  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  const offsetX = (canvas.width - cw * dpr) / 2;
  const offsetY = (canvas.height + ch * dpr) / 2;

  ctx.save();
  ctx.translate(offsetX, offsetY);
  ctx.scale(cw * dpr / w0, -ch * dpr / h0_);
  ctx.globalAlpha = 1.0;
  ctx.drawImage(tc0, 0, 0);
  ctx.restore();

  ctx.save();
  ctx.translate(offsetX, offsetY);
  ctx.scale(cw * dpr / w1, -ch * dpr / h1_);
  ctx.globalAlpha = overlayOpacity;
  ctx.drawImage(tc1, 0, 0);
  ctx.restore();

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

  const ar0 = pw0 / ph0;
  let cw0: number, ch0: number;
  if (halfW / dh > ar0) { ch0 = dh; cw0 = Math.floor(dh * ar0); }
  else { cw0 = halfW; ch0 = Math.floor(halfW / ar0); }
  cw0 = Math.floor(cw0 * zoom);
  ch0 = Math.floor(ch0 * zoom);

  const ar1 = pw1 / ph1;
  let cw1: number, ch1: number;
  if (halfW / dh > ar1) { ch1 = dh; cw1 = Math.floor(dh * ar1); }
  else { cw1 = halfW; ch1 = Math.floor(halfW / ar1); }
  cw1 = Math.floor(cw1 * zoom);
  ch1 = Math.floor(ch1 * zoom);

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

  const offsetX0 = (halfW * dpr - cw0 * dpr) / 2;
  const offsetY0 = (dh * dpr + ch0 * dpr) / 2;
  ctx.save();
  ctx.translate(offsetX0, offsetY0);
  ctx.scale(cw0 * dpr / w0, -ch0 * dpr / h0_);
  ctx.drawImage(tc0, 0, 0);
  ctx.restore();

  const offsetX1 = halfW * dpr + (halfW * dpr - cw1 * dpr) / 2;
  const offsetY1 = (dh * dpr + ch1 * dpr) / 2;
  ctx.save();
  ctx.translate(offsetX1, offsetY1);
  ctx.scale(cw1 * dpr / w1, -ch1 * dpr / h1_);
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

    const imgLeft0 = (halfW - cw0) / 2 - vs.panX;
    const imgTop0 = (dh - ch0) / 2 - vs.panY;
    const sx0 = (imgLeft0 + cx0 * cw0) * dpr;
    const sy0 = (imgTop0 + (1 - cy0) * ch0) * dpr;

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

    const imgLeft1 = halfW + (halfW - cw1) / 2 - vs.panX;
    const imgTop1 = (dh - ch1) / 2 - vs.panY;
    const sx1 = (imgLeft1 + cx1 * cw1) * dpr;
    const sy1 = (imgTop1 + (1 - cy1) * ch1) * dpr;

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
  updateScaleBar(axis, pw0, ph0, zoom, cw0);
  updateMinimap(axis, w0, h0_, zoom, vs.panX, vs.panY, cw0, ch0);
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

  if (volumeData) {
    if (axis === 'axial') {
      paintSlice('axial', extractSlice('axial', sliceIdx.axial), nx, ny, nx * dx, ny * dy);
    } else if (axis === 'coronal') {
      paintSlice('coronal', extractSlice('coronal', sliceIdx.coronal), nx, nz, nx * dx, nz * dz);
    } else {
      paintSlice('sagittal', extractSlice('sagittal', sliceIdx.sagittal), ny, nz, ny * dy, nz * dz);
    }
  } else {
    const slice = currentSlices[axis];
    if (!slice) return;
    if (axis === 'axial') {
      paintSlice('axial', slice.data, slice.width, slice.height, nx * dx, ny * dy);
    } else if (axis === 'coronal') {
      paintSlice('coronal', slice.data, slice.width, slice.height, nx * dx, nz * dz);
    } else {
      paintSlice('sagittal', slice.data, slice.width, slice.height, ny * dy, nz * dz);
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

  if (fileNameEl) fileNameEl.textContent = fileName;
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

  for (let i = 0; i < n; i += step) {
    samples.push(volumeData[i]);
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
      previewData = await fetchWithRetry(previewUrl, 'json');
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

  if (msg.type !== 'config') return;

  fileUrl = msg.fileUrl;
  fileName = msg.fileName;
  isGzip = fileName.endsWith('.gz');
  isRemoteSource = !!msg.isRemote;
  viewerConfig.previewMode = msg.previewMode || viewerConfig.previewMode;
  viewerConfig.renderBackend = msg.renderBackend || viewerConfig.renderBackend;
  viewerConfig.fullVolumePolicy = msg.fullVolumePolicy || viewerConfig.fullVolumePolicy;
  viewerConfig.nativeAcceleration = msg.nativeAcceleration || viewerConfig.nativeAcceleration;
  fullVolumeLoaded = false;
  volumeData = null;
  currentSlices.axial = null;
  currentSlices.coronal = null;
  currentSlices.sagittal = null;
  colormap = msg.defaultColormap || 'gray';

  const cmapSelect = document.getElementById('colormap') as HTMLSelectElement;
  if (cmapSelect && msg.defaultColormap) cmapSelect.value = msg.defaultColormap;

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
  header = msg.header;
  globalMin = msg.globalMin;
  globalMax = msg.globalMax;
  dataSlope = msg.slope || 1;
  dataInter = msg.inter || 0;
  sliceIdx.axial = msg.sliceIdx.axial;
  sliceIdx.coronal = msg.sliceIdx.coronal;
  sliceIdx.sagittal = msg.sliceIdx.sagittal;

  const datatype = msg.datatype || 16;
  let voxelBuffer: ArrayBuffer | null = null;
  if (msg.voxelData instanceof ArrayBuffer) {
    voxelBuffer = msg.voxelData;
  } else if (Array.isArray(msg.voxelData)) {
    const f32 = new Float32Array(msg.voxelData);
    voxelBuffer = f32.buffer.slice(f32.byteOffset, f32.byteOffset + f32.byteLength);
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
  }

  if (!voxelBuffer) {
    fallbackToHttpPreview();
    return;
  }

  autoContrast();
  initialWindowWidth = windowWidth;
  initialWindowLevel = windowLevel;

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
  publishPerfMonitor();

  updateFileInfo();
  updateSliderValues();
  updateImagePicker();
  renderAllViews();
  loading.style.display = 'none';
  updateProgress(1.0);
  setupInteraction();

  if (!volumeData) {
    scheduleActiveImageLoad(0);
  }
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

    const worker = await getWorker();
    worker.onerror = (err) => { loadingText.textContent = 'Worker error: ' + (err.message || 'unknown'); };

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

    loadFullVolume(worker);
  } catch (err: any) {
    loadingText.textContent = 'Error: ' + (err?.message ?? String(err));
  }
}

async function loadFullVolume(worker: Worker) {
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
      if (!header) {
        header = d.header;
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

  worker.postMessage({ id: 0, type: 'loadVolume', url: fileUrl, isGzip });
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
  try {
    const previewData = await fetchPreviewData(url);
    if (!previewData?.header || !previewData?.slices) {
      throw new Error('Preview unavailable');
    }
    images.push({
      header: previewData.header,
      data: null,
      min: previewData.globalMin,
      max: previewData.globalMax,
      name,
      url,
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
    publishPerfMonitor();
    updateImagePicker();
    if (images.length === 2) {
      void switchToImage(images.length - 1);
    }
  } catch (err) {
    console.error('Failed to load image:', err);
  }
}

function setupInteraction() {
  if (!header) return;
  if (interactionInitialized) return;
  interactionInitialized = true;

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

  wwSlider?.addEventListener('input', () => { windowWidth = Number(wwSlider.value) / 100; scheduleRender(); });
  wlSlider?.addEventListener('input', () => { windowLevel = Number(wlSlider.value) / 100; scheduleRender(); });
  cmapSelect?.addEventListener('change', () => { colormap = cmapSelect.value; sliceRenderCache.clear(); scheduleRender(); });
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
      sliceIdx[axis] = val;
      if (volumeData) updateSingleView(axis);
      else void refreshSlices([axis], true);
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
          const max = axis === 'axial' ? header.nz - 1 : axis === 'coronal' ? header.ny - 1 : header.nx - 1;
          const newIdx = Math.max(0, Math.min(max, sliceIdx[axis] + delta));
          if (newIdx !== sliceIdx[axis]) {
            sliceIdx[axis] = newIdx;
            if (volumeData) updateSingleView(axis);
            else void refreshSlices([axis], true);
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

    document.addEventListener('mouseup', () => {
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
      
      const { nx, ny, nz } = header;
      const zoom = viewState[axis].zoom;
      
      const maxPanX = (zoom - 1) * (axis === 'sagittal' ? ny : nx) / 2;
      const maxPanY = (zoom - 1) * (axis === 'axial' ? ny : nz) / 2;
      
      viewState[axis].panX = (mx - 0.5) * 2 * maxPanX;
      viewState[axis].panY = (my - 0.5) * 2 * maxPanY;
      
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
}

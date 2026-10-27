import { NiiHeader, DATATYPE_NAMES, parseNiiHeader } from './nii-parser';
import { errorMessage, isAbortError } from '../src/errors';
import type { Axis, TypedArray, VolumeImage } from './viewer/types';
import { toGpuTypedArray } from './viewer/types';
import { RegistrationController } from './viewer/registration';
import { CompareRenderer } from './viewer/compareRenderer';
import { WebGPURenderer } from './webgpuRenderer';
import { WebGLRenderer } from './viewer/webglRenderer';
import { COLORMAPS } from './viewer/colormaps';
import { computeMIP, rotAxisAngle, mul3 } from './viewer/mip';
import { drawMeasurements, type Measurement } from './viewer/measure';
import { showToast, initTooltipSystem } from './viewer/ui';
import { Float32Pool, BandwidthEstimator } from './viewer/pools';
import { voxelToWorld, worldToVoxel } from './viewer/geometry';
import {
  getAnatomicalAxisDir,
  computeOrientationFromSform,
  computeOrientationFromQform,
  computeFlipsForHeader,
} from './viewer/orientation';
import { VolumeRaycaster } from './volumeRaycaster';
import { getVolumeCacheDB, makeTypedArrayFromBuffer } from './SliceCacheDB';
import { shouldAutoloadFullVolume as evaluateFullVolumePolicy, SLICE_MODE_MIN_BYTES } from '../src/volumePolicy';
import { initWasmBindings, getWasmBindings } from './wasmBridge';
import {
  concatUint8Chunks,
  computeVolumeStatsWebview,
  decodePreviewBinary,
  sliceHasSignal,
  toFloat32Array,
  toPreviewSlice,
  type PreviewData,
  type SliceIdxMessage,
} from './viewer/previewCodec';
import { setupInteraction as setupInteractionImpl, type InteractionHost } from './viewer/interaction';

interface VsCodeApi {
  postMessage(message: unknown): void;
  getState?(): unknown;
  setState?(state: unknown): void;
}
declare function acquireVsCodeApi(): VsCodeApi;
const vscode = acquireVsCodeApi();

interface SliceFrame {
  data: Float32Array;
  width: number;
  height: number;
  factor: number;
}

interface ViewerConfig {
  previewMode: 'binary' | 'json';
  renderBackend: 'auto' | 'webgl' | 'canvas';
  fullVolumePolicy: 'manual' | 'debounced' | 'eager' | 'adaptive';
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

interface NiftiWindowGlobals {
  WORKER_URL?: string;
  REG_WORKER_URL?: string;
  __NII_WORKER_BLOB_URL__?: string;
  __NII_REG_WORKER_BLOB_URL__?: string;
  __niftiPerf?: unknown;
  requestIdleCallback?: typeof requestIdleCallback;
}
const win = window as Window & NiftiWindowGlobals;

interface WorkerStreamMessage extends PreviewData {
  id?: number;
  type: string;
  value?: number;
  stage?: string;
  error?: string;
  /** Diagnostic line forwarded to the host output channel ('log' messages). */
  line?: string;
  bytes?: number;
  durationMs?: number;
  rttMs?: number;
  voxelData?:
    | Int8Array
    | Uint8Array
    | Int16Array
    | Uint16Array
    | Int32Array
    | Uint32Array
    | Float32Array
    | Float64Array;
  factor?: number;
}

interface CacheStatsMessage {
  type: string;
  cacheHits?: number;
  cacheMisses?: number;
  cacheSize?: number;
  cacheEntries?: number;
}

interface CachedVolumeMessage {
  header: NiiHeader;
  globalMin: number;
  globalMax: number;
  slope: number;
  inter: number;
  voxelData: unknown;
  voxOffset: number;
  voxelLength: number;
  datatype: number;
  sliceIdx: SliceIdxMessage;
  perfExtTiming?: Record<string, unknown>;
  perfVoxelBytes?: number;
}

interface ChunkedVolumeMessage {
  chunk: ArrayBuffer;
  index: number;
  total: number;
  isGzip: boolean;
  fileName: string;
  fileSize: number;
  validationToken: string;
  perfExtTiming?: Record<string, unknown>;
}

interface CompressedVolumeMessage {
  compressedData: ArrayBuffer;
  perfExtTiming?: Record<string, unknown>;
}

interface LodDataMessage {
  level: number;
  axial?: ArrayBuffer | number[];
  axialW?: number;
  axialH?: number;
  coronal?: ArrayBuffer | number[];
  coronalW?: number;
  coronalH?: number;
  sagittal?: ArrayBuffer | number[];
  sagittalW?: number;
  sagittalH?: number;
}

const DEBUG =
  typeof window !== 'undefined' &&
  typeof URLSearchParams !== 'undefined' &&
  new URLSearchParams(window.location.search).has('debug');

const images: VolumeImage[] = [];
let activeImageIdx = 0;
let compareMode = false;

let header: NiiHeader | null = null;
let volumeData:
  | Int8Array
  | Uint8Array
  | Int16Array
  | Uint16Array
  | Int32Array
  | Uint32Array
  | Float32Array
  | Float64Array
  | null = null;
let sharedVolumeBuffer: SharedArrayBuffer | null = null;
let offscreenCanvas2D: HTMLCanvasElement | null = null;
let sabAvailable = false;

try {
  sabAvailable = typeof SharedArrayBuffer !== 'undefined';
} catch {
  sabAvailable = false;
}

function verifySABSupport(): boolean {
  try {
    new SharedArrayBuffer(1024);
    // If we got here, SAB is available
    sabAvailable = true;
    return true;
  } catch (err) {
    console.warn('[NiftiSpy] SharedArrayBuffer not available:', errorMessage(err));
    sabAvailable = false;
    return false;
  }
}

// Verify SAB support on load
verifySABSupport();

function createSharedVolumeBuffer(data: TypedArray): SharedArrayBuffer | null {
  if (!sabAvailable) return null;
  try {
    // Reserve 8 bytes at the front for metadata (avoid corrupting first voxel)
    const HEADER_BYTES = 8;
    const sab = new SharedArrayBuffer(HEADER_BYTES + data.byteLength);
    // Write body after header
    const bodyBytes = new Uint8Array(sab, HEADER_BYTES);
    const srcBytes = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    bodyBytes.set(srcBytes);
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
let timeIdx = 0;
let windowWidth = 1.0;
let windowLevel = 0.5;
let pendingAddImageIdx = -1;
let overlayOpacity = 0.5;
type CompareLayout = 'overlay' | 'sideBySide';
let compareLayout: CompareLayout = 'overlay';
// Indices of the two images taking part in compare mode, chosen via the
// per-image checkboxes in the sidebar (exactly two must be checked).
let compareIdxA = 0;
let compareIdxB = 1;
/** Compare-pair accessor with index clamping after removals. */
function cmpImg(which: 0 | 1): VolumeImage | null {
  if (images.length === 0) return null;
  const a = Math.min(compareIdxA, images.length - 1);
  const b = Math.min(compareIdxB, images.length - 1);
  return images[which === 0 ? a : b] || null;
}
let colormap = 'gray';
let fileUrl = '';
let directUrl = ''; // Original remote URL for direct fetch (bypasses proxy)
let isGzip = false;
let fileName = '';
let crosshairVisible = true;
let isRemoteSource = false;
// When true, do not auto-download the full volume (large Remote-SSH files /
// HTTP remotes). Scrolling uses /slice; MIP/registration still require a
// manual or explicit full load.
let deferFullVolume = false;
let currentFileSize = 0;
// WebviewId assigned by the extension host (used to route fallback
// requests such as 'remoteHttpFallback' back to the right webview).
let currentWebviewId = '';
// Unique id for the load currently being dispatched. A webview can own
// several images (Add Image / compare), so fallback messages must carry the
// loadId instead of relying on webviewId alone.
let currentLoadId = '';
// Remote-SSH slice mode: when the host offers to relay planes, every wheel
// step goes through postMessage instead of the port-forwarded proxy URL. The
// forward can be unavailable (connection refused) or take tens of seconds to
// come up, during which the slice index changed but no pixels ever arrived.
let hostSliceMode = false;
let hostSliceEntryId = '';
let hostSliceSeq = 0;
const hostSlicePending = new Map<
  number,
  {
    resolve: (v: {
      type: 'slice';
      axis: Axis;
      index: number;
      factor: number;
      width: number;
      height: number;
      data: Float32Array;
    }) => void;
    reject: (e: unknown) => void;
    timer: ReturnType<typeof setTimeout>;
  }
>();
let fullVolumeLoaded = false;
let interactionInitialized = false;
// Low-res preview state (Stage 1: strided sub-sampling)
let isLowResPreview = false;
let lowResFactor = 1;
let lowResBadge: HTMLDivElement | null = null;

// Measurement tools state
let measureMode = false;
const measurements: Measurement[] = [];
let measureDragStart: { x: number; y: number; axis: Axis } | null = null;
let measureClickPending: { x: number; y: number; axis: Axis } | null = null;

// Accessibility state
let highContrastPreferred = false;
try {
  highContrastPreferred = window.matchMedia('(prefers-contrast: more)').matches;
} catch {
  /* optional API unavailable */
}
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
let remotePreviewStartedAt = 0;
let remotePreviewToken = '';

const MAX_RESIDENT_IMAGE_DATA = 4;
const MAX_PARALLEL_VOLUME_LOADS = 2;
const ACTIVE_FULL_LOAD_DEBOUNCE_MS = 180;

// ── Fast-path stall watchdog ─────────────────────────────────────────
// The Remote-SSH fast path fetches the port-forwarded proxy URL from a
// Worker. When the tunnel stalls without erroring (no rejection, no timeout,
// no message), the spinner used to stay up forever and nothing was reported
// to the host, so its chunked-transfer fallback never ran. Any progress from
// the worker resets this timer; silence beyond the budget falls back to the
// host-side chunked transfer explicitly.
const FAST_PATH_STALL_MS = 15_000;
interface FastPathWatchdog {
  loadId: string;
  timer: number | null;
  lastSignal: number;
  fired: boolean;
}
let fastPathWatchdog: FastPathWatchdog | null = null;

function clearFastPathWatchdog(): void {
  if (!fastPathWatchdog) return;
  if (fastPathWatchdog.timer !== null) window.clearTimeout(fastPathWatchdog.timer);
  fastPathWatchdog = null;
}

/** Any byte of progress proves the tunnel is alive — reset the stall timer. */
function noteFastPathSignal(): void {
  if (fastPathWatchdog) fastPathWatchdog.lastSignal = Date.now();
}

function startFastPathWatchdog(loadId: string): void {
  clearFastPathWatchdog();
  const state: FastPathWatchdog = { loadId, timer: null, lastSignal: Date.now(), fired: false };
  fastPathWatchdog = state;
  const tick = (): void => {
    if (fastPathWatchdog !== state || state.fired) return;
    const idle = Date.now() - state.lastSignal;
    if (idle < FAST_PATH_STALL_MS) {
      state.timer = window.setTimeout(tick, 1000);
      return;
    }
    state.fired = true;
    const reason = `fast path stalled: no progress for ${Math.round(idle / 1000)}s`;
    vscode.postMessage({ type: 'webviewLog', line: `[remote-ssh-http] ${reason} — falling back` });
    vscode.postMessage({
      type: 'remoteHttpFallback',
      webviewId: currentWebviewId,
      loadId,
      reason,
    });
    loadingText.textContent = 'Retrying with chunked transfer...';
    updateProgress(0.02, 'Retrying with chunked transfer...');
    // Stop the stalled worker so it cannot race the host-side transfer.
    volumeWorkerCancels.get(fileUrl)?.();
    clearFastPathWatchdog();
  };
  state.timer = window.setTimeout(tick, 1000);
}

/** Race a promise against a deadline so a hung browser API cannot block a load. */
function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = window.setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs);
    promise.then(
      (value) => {
        window.clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        window.clearTimeout(timer);
        reject(err);
      },
    );
  });
}

let activeVolumeLoads = 0;
type VolumeLoadPriority = 'active' | 'background';
type VolumeLoadReason = 'user' | 'auto';
interface QueuedVolumeLoad {
  key: string;
  priority: VolumeLoadPriority;
  reason: VolumeLoadReason;
  cancelled: boolean;
  run: () => void;
  reject: (reason?: unknown) => void;
}
const volumeLoadQueue: QueuedVolumeLoad[] = [];
let nextStreamRequestId = 2000;
let activeVolumeLoadKey: string | null = null;
const volumeWorkers = new Map<string, Worker>();
const volumeWorkerCancels = new Map<string, () => void>();
const volumeLoadReasons = new Map<string, VolumeLoadReason>();
let activeLoadDebounceTimer: number | null = null;
let scheduledActiveIndex: number | null = null;

// Per-axis AbortController for cancelling stale slice requests
const sliceAbortControllers = new Map<Axis, AbortController>();

const currentSlices: Record<Axis, SliceFrame | null> = {
  axial: null,
  coronal: null,
  sagittal: null,
};

const viewFlips: Record<string, { flipX: boolean; flipY: boolean }> = {
  axial: { flipX: false, flipY: false },
  coronal: { flipX: false, flipY: false },
  sagittal: { flipX: false, flipY: false },
};

const perfMonitor = {
  previewLoads: [] as number[],
  fullLoads: [] as number[],
  sliceTimings: [] as unknown[],
  renderTimes: [] as number[],
  failures: 0,
  evictions: 0,
};

// NOTE: worker-side OffscreenCanvas slice rendering was removed.
// transferControlToOffscreen() irreversibly transfers ownership of the
// display canvas away from the main thread: afterwards getContext('2d')
// returns null forever and assigning canvas.width THROWS, so every main-
// thread painter (canvas2d fallback, compare mode, prefetch blit, GL blit)
// died mid-render and the viewport went blank while info panels kept
// updating. All GPU backends now render into private canvases and blit.

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
  fullVolumePolicy: 'adaptive',
  nativeAcceleration: 'auto',
};

const previewRequestCache = new Map<string, Promise<PreviewData | null>>();
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
    slicePool
      .dispatch<CacheStatsMessage>({ type: 'getCacheStats' })
      .then((msg) => {
        if (msg && msg.type === 'cacheStats') {
          diskCacheStats.cacheHits = msg.cacheHits || 0;
          diskCacheStats.cacheMisses = msg.cacheMisses || 0;
          diskCacheStats.cacheSize = msg.cacheSize || 0;
          diskCacheStats.cacheEntries = msg.cacheEntries || 0;
        }
      })
      .catch(() => {});
  }
}

function publishPerfMonitor() {
  win.__niftiPerf = {
    previewLoads: [...perfMonitor.previewLoads],
    fullLoads: [...perfMonitor.fullLoads],
    sliceTimings: [...perfMonitor.sliceTimings],
    renderTimes: [...perfMonitor.renderTimes],
    failures: perfMonitor.failures,
    evictions: perfMonitor.evictions,
    queuedLoads: volumeLoadQueue.length,
    activeLoads: activeVolumeLoads,
    residentImages: images.filter((img) => !!img.data).length,
    activeVolumeLoadKey,
    scheduledActiveIndex,
    fps: fpsCounter.getFPS(),
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
// Requests are tracked together with the worker that owns them so a crashed
// or wedged worker can be settled instead of leaving the caller hanging.
const workerRequests = new Map<
  number,
  { worker: Worker; resolve: (value: unknown) => void; reject: (reason?: unknown) => void }
>();
const sliceQualityTimers: Partial<Record<Axis, number>> = {};
let workerStreamListener: ((message: WorkerStreamMessage) => void) | null = null;

// Row-major 3x3 identity for the MIP virtual trackball (see computeMIP).
const MIP_IDENTITY: number[] = [1, 0, 0, 0, 1, 0, 0, 0, 1];

const viewState = {
  axial: { zoom: 1, panX: 0, panY: 0 },
  coronal: { zoom: 1, panX: 0, panY: 0 },
  sagittal: { zoom: 1, panX: 0, panY: 0 },
  mip: { rot: MIP_IDENTITY.slice() },
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

// Sync detection: WebGL2 getContext is synchronous — no need for async.
// WebGPU is checked asynchronously later (non-blocking, graceful upgrade).
function detectBestRenderBackendSync(): RenderBackend {
  try {
    const testCanvas = document.createElement('canvas');
    const gl2 = testCanvas.getContext('webgl2') as WebGL2RenderingContext | null;
    if (gl2) {
      const max3D = gl2.getParameter(gl2.MAX_3D_TEXTURE_SIZE) || 0;
      if (max3D >= 256) return 'webgl3d';
      return 'webgl2d';
    }
  } catch {
    /* optional API unavailable */
  }
  return 'canvas2d';
}

function applyRenderBackend(configValue: string): void {
  if (configValue === 'auto') {
    // Synchronous detection — ensures renderBackend is set before first render
    renderBackend = detectBestRenderBackendSync();
    // NOTE: the former async "upgrade" to renderBackend='webgpu' was removed.
    // The WebGPU slice path is fundamentally broken for integer volumes:
    //  1. it uploads them as r16sint/r8sint textures, but the WGSL shader
    //     declares texture_3d<f32> + textureSample — integer textures cannot
    //     be sampled by textureSample, so every draw fails validation and
    //     nothing renders (white viewport);
    //  2. writeTexture bytesPerRow must be 256-aligned (nx*4 rarely is);
    //  3. r32float linear sampling needs the optional 'float32-filterable'
    //     feature;
    //  4. the shader never applies slope/inter.
    // Slice rendering stays on WebGL2 (R32F/R16I/... + isampler3D variants),
    // which is equally fast for slice views.
  } else if (configValue === 'webgl') {
    renderBackend = detectBestRenderBackendSync();
  } else {
    renderBackend = 'canvas2d';
  }
}

applyRenderBackend('auto');

let volumeRaycaster: VolumeRaycaster | null = null;
let renderMode: 'slice' | 'volume' = 'slice';
let mipInitialized = false; // lazy init: MIP panel content rendered on demand
let volumeRotationMatrix = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]) as Float32Array;
let volumeZoom = 1.0;
let isDraggingVolume = false;
let lastVolumeMouseX = 0;
let lastVolumeMouseY = 0;

const float32Pool = new Float32Pool();
const bandwidthEstimator = new BandwidthEstimator();

function shouldAutoloadFullVolume(): boolean {
  return evaluateFullVolumePolicy({
    policy: viewerConfig.fullVolumePolicy,
    fileSize: currentFileSize,
    sliceMode: deferFullVolume,
    quality: bandwidthEstimator.qualityLevel,
  });
}

function volumeHasTimepoint(t: number): boolean {
  if (!header || !volumeData) return false;
  const frame = header.nx * header.ny * header.nz;
  return volumeData.length >= (Math.max(0, t) + 1) * frame;
}

function slicePrefetchCount(): number {
  if (isVerySlowLink()) return 1;
  if (bandwidthEstimator.qualityLevel === 'high') return 4;
  return Math.min(PRELOAD_RANGE, 3);
}

// Warm up the TCP/TLS connection for a remote URL as early as possible and
// measure the round-trip time. On high-latency links this hides the handshake
// cost from the first real Range request.
const warmupCache = new Map<string, Promise<void>>();
function isWarmupable(url: string): boolean {
  return url.startsWith('http://') || url.startsWith('https://');
}
async function warmupConnection(url: string): Promise<void> {
  if (!isWarmupable(url)) return;
  const cached = warmupCache.get(url);
  if (cached) return cached;
  const promise = (async () => {
    try {
      const start = performance.now();
      // Use HEAD when allowed; fallback to a tiny Range request.  Both warm
      // the connection without transferring meaningful data.
      const controller = new AbortController();
      const timeout = window.setTimeout(() => controller.abort(), 5000);
      let resp: Response | undefined;
      try {
        resp = await fetch(url, { method: 'HEAD', signal: controller.signal, mode: 'cors' });
      } catch {
        // HEAD may be disallowed; try a single-byte Range request.
        controller.abort();
        const ctrl2 = new AbortController();
        const t2 = window.setTimeout(() => ctrl2.abort(), 5000);
        resp = await fetch(url, {
          method: 'GET',
          headers: { Range: 'bytes=0-0' },
          signal: ctrl2.signal,
          mode: 'cors',
        });
        window.clearTimeout(t2);
      } finally {
        window.clearTimeout(timeout);
      }
      if (resp) {
        // Ensure response body is consumed so the connection can be reused.
        try {
          await resp.body?.cancel();
        } catch {
          /* ignore */
        }
        const rtt = performance.now() - start;
        bandwidthEstimator.addRttSample(rtt);
        if (DEBUG) console.log('[NiftiSpy] connection warmup RTT:', rtt.toFixed(1), 'ms for', url);
      }
    } catch (err) {
      if (DEBUG) console.log('[NiftiSpy] connection warmup failed:', errorMessage(err));
    }
  })();
  warmupCache.set(url, promise);
  return promise;
}

function injectPreconnectHint(url: string): void {
  if (!isWarmupable(url)) return;
  try {
    const u = new URL(url);
    const origin = u.origin;
    if (!origin || origin === location.origin) return;
    const id = 'preconnect-' + origin.replace(/[^a-z0-9]/gi, '-');
    if (document.getElementById(id)) return;
    const link = document.createElement('link');
    link.id = id;
    link.rel = 'preconnect';
    link.href = origin;
    link.crossOrigin = 'anonymous';
    document.head.appendChild(link);
    const dns = document.createElement('link');
    dns.id = id + '-dns';
    dns.rel = 'dns-prefetch';
    dns.href = origin;
    document.head.appendChild(dns);
  } catch {
    // ignore malformed URLs
  }
}

// TRIANGLE_STRIP destination quad in NDC for a device-pixel rect on a canvas.
// Matches the CPU painter's zoom/pan geometry (image rect centered in the
// container + pan offsets); a missing dst covers the full canvas.
function detectPerformance(): PerformanceProfile {
  const nav = navigator as Navigator & { deviceMemory?: number };
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
  } catch {
    /* optional API unavailable */
  }

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
  if (dw / dh > ar) {
    ch = dh;
    cw = ch * ar;
  } else {
    cw = dw;
    ch = cw / ar;
  }
  cw *= vs.zoom;
  ch *= vs.zoom;
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

function clearMeasurements(): void {
  measurements.length = 0;
  drawMeasurements(measurements, highContrastPreferred);
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

function restartCrashedWorker(axis: Axis): void {
  const idx = AXIS_TO_WORKER_IDX[axis];
  const oldWorker = sliceWorkers[idx];
  if (oldWorker) {
    oldWorker.terminate();
    sliceWorkers[idx] = null;
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

const compareRenderer = new CompareRenderer({
  getImages: () => images,
  getImage: (which) => cmpImg(which),
  getSliceIdx: () => sliceIdx,
  getLayout: () => compareLayout,
  getOverlayOpacity: () => overlayOpacity,
  getCanvases: () => canvases,
  getViewState: () => ({
    axial: viewState.axial,
    coronal: viewState.coronal,
    sagittal: viewState.sagittal,
  }),
  getWindow: () => ({ width: windowWidth, level: windowLevel }),
  isCrosshairVisible: () => crosshairVisible,
  isMipInitialized: () => mipInitialized,
  paintMIP: () => paintMIP(),
  updateAllInfo: () => updateAllInfo(),
  updateDirectionLabels: (axis) => updateDirectionLabels(axis),
  updateCrosshair: (axis, w, h, zoom, panX, panY, cw, ch) => updateCrosshair(axis, w, h, zoom, panX, panY, cw, ch),
  updateScaleBar: (axis, pixelW, pixelH, zoom, cw) => updateScaleBar(axis, pixelW, pixelH, zoom, cw),
  updateMinimap: (axis, w, h, zoom, panX, panY, cw, ch, data) =>
    updateMinimap(axis, w, h, zoom, panX, panY, cw, ch, data),
  extractSliceFromImage: (img, axis, idx) => extractSliceFromImage(img, axis, idx),
});

const sliceWorkers: (Worker | null)[] = [];
const AXIS_TO_WORKER_IDX: Record<Axis, number> = { axial: 0, coronal: 1, sagittal: 2 };
let cachedBlobUrl: string | null = null;
let blobUrlPromise: Promise<string> | null = null;
const WORKER_SCRIPT_TIMEOUT_MS = 20_000;
// A slice the viewer asked for must settle (or be abandoned) inside this
// window. Requests used to hang forever when a worker died or an IndexedDB
// lookup wedged, and because refreshSlices waited on all three axes the
// viewer simply stopped repainting while pan/zoom kept working.
const SLICE_REQUEST_TIMEOUT_MS = 15_000;

type WorkerPayload = Record<string, unknown> & { signal?: AbortSignal };

class SliceWorkerPool {
  private workers: Worker[] = [];
  private idle: Worker[] = [];
  private maxSize: number;
  private blobUrl: string | null = null;
  private queue: Array<{ payload: WorkerPayload; resolve: (v: unknown) => void; reject: (e: unknown) => void }> = [];
  private terminated = false;

  constructor(maxSize: number) {
    this.maxSize = maxSize;
  }

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

  dispatch<T = unknown>(payload: WorkerPayload): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const resolveUnknown = (v: unknown) => resolve(v as T);
      const idleWorker = this.idle.shift();
      if (idleWorker) {
        this.exec(idleWorker, payload, resolveUnknown, reject);
      } else if (this.workers.length < this.maxSize) {
        const w = new Worker(this.blobUrl!);
        attachWorkerRouter(w);
        this.workers.push(w);
        this.exec(w, payload, resolveUnknown, reject);
      } else {
        this.queue.push({ payload, resolve: resolveUnknown, reject });
      }
    });
  }

  private exec(
    worker: Worker,
    payload: WorkerPayload,
    resolve: (v: unknown) => void,
    reject: (e: unknown) => void,
  ): void {
    // AbortSignal cannot be structured-cloned into a Worker. Keep it on the
    // caller side (requestSliceFrame ignores replies after abort) and skip
    // queued requests that have already become obsolete.
    const { signal, ...message } = payload;
    if (signal?.aborted) {
      reject(makeAbortError());
      this.release(worker);
      return;
    }
    const id = nextWorkerRequestId++;
    let settled = false;
    // Bare setTimeout (not window.setTimeout) keeps this pool usable in the
    // isolated worker test runtime, which injects only global timers.
    let timer: ReturnType<typeof setTimeout> | null = null;
    const finish = (kind: 'resolve' | 'reject', value: unknown) => {
      if (settled) return;
      settled = true;
      if (timer !== null) clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      workerRequests.delete(id);
      if (kind === 'resolve') resolve(value);
      else reject(value);
      this.release(worker);
    };
    const onAbort = () => {
      // Without this the pool kept every aborted request's worker pinned until
      // the request settled on its own; fast scrolling starved all workers and
      // no slice was ever rendered again.
      const pending = workerRequests.get(id);
      if (pending) pending.reject(makeAbortError());
    };
    workerRequests.set(id, {
      worker,
      resolve: (msg: unknown) => finish('resolve', msg),
      reject: (err?: unknown) => finish('reject', err),
    });
    // A request that never answers must not wedge the pool: reject it, then
    // replace the worker because its fetch may still be stuck.
    timer = setTimeout(() => {
      const pending = workerRequests.get(id);
      if (!pending) return;
      pending.reject(new Error(`Slice request timed out after ${SLICE_REQUEST_TIMEOUT_MS / 1000}s`));
      this.retire(worker);
    }, SLICE_REQUEST_TIMEOUT_MS);
    signal?.addEventListener('abort', onAbort, { once: true });
    try {
      worker.postMessage({ ...message, id });
    } catch (err) {
      workerRequests.get(id)?.reject(err);
    }
  }

  private release(worker: Worker): void {
    if (this.terminated || !this.workers.includes(worker)) return;
    if (this.queue.length > 0) {
      const next = this.queue.shift()!;
      this.exec(worker, next.payload, next.resolve, next.reject);
    } else if (!this.idle.includes(worker)) {
      this.idle.push(worker);
    }
  }

  /** Drop a worker that crashed or never answered and replace it, so wedged
   *  requests can never exhaust the pool. */
  retire(worker: Worker): void {
    if (!this.workers.includes(worker)) return;
    this.workers = this.workers.filter((w) => w !== worker);
    this.idle = this.idle.filter((w) => w !== worker);
    worker.terminate();
    for (const [, pending] of [...workerRequests]) {
      if (pending.worker === worker) pending.reject(new Error('Slice worker was replaced'));
    }
    if (this.terminated || !this.blobUrl || this.workers.length >= this.maxSize) return;
    const replacement = new Worker(this.blobUrl);
    attachWorkerRouter(replacement);
    this.workers.push(replacement);
    this.release(replacement);
  }

  broadcast(message: Record<string, unknown>): void {
    for (const w of this.workers) w.postMessage(message);
  }

  /** Send a message to only the first worker — avoids duplicate downloads
   *  when loading a volume (broadcast would make every worker fetch the
   *  same file simultaneously, wasting 2/3 of bandwidth). */
  sendToFirst(message: Record<string, unknown>): void {
    if (this.workers.length > 0) this.workers[0].postMessage(message);
  }

  terminate(): void {
    this.terminated = true;
    const workers = this.workers;
    for (const w of workers) {
      for (const [, pending] of [...workerRequests]) {
        if (pending.worker === w) pending.reject(makeAbortError());
      }
      w.terminate();
    }
    for (const entry of this.queue) entry.reject(makeAbortError());
    this.workers = [];
    this.idle = [];
    this.queue = [];
  }

  setErrorHandler(handler: (err: ErrorEvent) => void): void {
    for (const w of this.workers) w.onerror = handler;
  }
}

let slicePool: SliceWorkerPool | null = null;
let slicePoolInit: Promise<void> | null = null;

async function ensureWorkerBlobUrl(): Promise<string> {
  if (win.__NII_WORKER_BLOB_URL__) return win.__NII_WORKER_BLOB_URL__!;
  if (cachedBlobUrl) return cachedBlobUrl;
  // Memoize the in-flight fetch: without this, every caller started its own
  // request for the worker script, and a request that never settles left the
  // volume spinner up forever (no error, no host fallback).
  if (!blobUrlPromise) {
    blobUrlPromise = (async () => {
      const ctrl = new AbortController();
      const timer = window.setTimeout(() => ctrl.abort(new Error('worker script timeout')), WORKER_SCRIPT_TIMEOUT_MS);
      let workerSrc: string;
      try {
        const workerResp = await fetch(win.WORKER_URL!, { signal: ctrl.signal });
        if (!workerResp.ok) throw new Error(`Worker fetch failed: ${workerResp.status}`);
        workerSrc = await workerResp.text();
      } catch (err) {
        if (ctrl.signal.aborted) {
          throw new Error(`Worker script load timed out after ${WORKER_SCRIPT_TIMEOUT_MS / 1000}s`);
        }
        throw err;
      } finally {
        window.clearTimeout(timer);
      }
      const blob = new Blob([workerSrc], { type: 'application/javascript' });
      cachedBlobUrl = URL.createObjectURL(blob);
      win.__NII_WORKER_BLOB_URL__ = cachedBlobUrl;
      return cachedBlobUrl;
    })().finally(() => {
      blobUrlPromise = null;
    });
  }
  return blobUrlPromise;
}

function attachWorkerRouter(worker: Worker) {
  if ((worker as Worker & { __routerAttached?: boolean }).__routerAttached) return;
  (worker as Worker & { __routerAttached?: boolean }).__routerAttached = true;
  worker.onmessage = (ev) => {
    const msg = ev.data;
    if (msg?.type === 'bandwidthSample') {
      if (msg.timing) {
        perfMonitor.sliceTimings.push(msg.timing);
        if (perfMonitor.sliceTimings.length > 100) perfMonitor.sliceTimings.shift();
      }
      bandwidthEstimator.addSample(msg.bytes || 0, msg.durationMs || 0);
      return;
    }
    const pending = workerRequests.get(msg.id);
    if (pending && msg?.type !== 'progress' && msg?.type !== 'preview' && msg?.type !== 'volume') {
      workerRequests.delete(msg.id);
      if (msg.type === 'error') pending.reject(new Error(msg.error || 'Worker error'));
      else pending.resolve(msg);
      return;
    }
    if (
      msg?.type === 'progress' ||
      msg?.type === 'preview' ||
      msg?.type === 'previewVolume' ||
      msg?.type === 'volume' ||
      msg?.type === 'error'
    ) {
      workerStreamListener?.(msg);
    }
  };
  // Worker crash recovery
  worker.onerror = (e: ErrorEvent) => {
    console.error('[NiftiSpy] Worker error:', e.message);
    // A dead worker can never answer the requests queued on it; settle them so
    // the caller can retry instead of waiting forever.
    for (const [, pending] of [...workerRequests]) {
      if (pending.worker === worker) pending.reject(new Error(e.message || 'Slice worker crashed'));
    }
    // Find which axis this worker belongs to and restart it
    const idx = sliceWorkers.indexOf(worker);
    if (idx >= 0) {
      const axis = (['axial', 'coronal', 'sagittal'] as Axis[])[idx];
      if (axis) restartCrashedWorker(axis);
    } else if (slicePool) {
      slicePool.retire(worker);
    }
  };
}

async function getSlicePool(): Promise<SliceWorkerPool> {
  if (!slicePool) {
    const maxWorkers = Math.min(navigator.hardwareConcurrency || 4, 6);
    const pool = new SliceWorkerPool(maxWorkers);
    slicePool = pool;
    slicePoolInit = pool.init().catch((err) => {
      sliceDiag('pool', `[slice] worker pool init failed: ${errorMessage(err)}`, 2);
      pool.terminate();
      slicePool = null;
      slicePoolInit = null;
      throw err;
    });
  }
  // All three axes can request their first slice concurrently. Every caller
  // must wait until the pool has a blob URL and its initial workers.
  await slicePoolInit;
  return slicePool!;
}

async function ensureAllSliceWorkers(): Promise<void> {
  await getSlicePool();
}

function broadcastToSliceWorkers(message: Record<string, unknown>): void {
  if (slicePool) slicePool.broadcast(message);
  for (const worker of sliceWorkers) {
    if (worker) worker.postMessage(message);
  }
}

function cancelVolumeLoadByKey(key: string | null): void {
  if (!key) return;
  const cancel = volumeWorkerCancels.get(key);
  if (cancel) {
    cancel();
    return;
  }
  const worker = volumeWorkers.get(key);
  volumeLoadReasons.delete(key);
  if (!worker) return;
  volumeWorkers.delete(key);
  if (activeVolumeLoadKey === key) activeVolumeLoadKey = null;
  worker.terminate();
  publishPerfMonitor();
}

function cancelAutoVolumeLoads(): void {
  for (const [key, reason] of [...volumeLoadReasons]) {
    if (reason === 'auto') cancelVolumeLoadByKey(key);
  }
  for (const entry of volumeLoadQueue) {
    if (entry.reason !== 'auto') continue;
    entry.cancelled = true;
    entry.reject(makeAbortError());
  }
  for (let i = volumeLoadQueue.length - 1; i >= 0; i--) {
    if (volumeLoadQueue[i].reason === 'auto') volumeLoadQueue.splice(i, 1);
  }
  if (preloadTimer) {
    window.clearTimeout(preloadTimer);
    preloadTimer = null;
  }
  if (activeLoadDebounceTimer) {
    window.clearTimeout(activeLoadDebounceTimer);
    activeLoadDebounceTimer = null;
  }
}

function onUserScrollSlices(): void {
  lastScrollTime = Date.now();
  // Prove the wheel/slider actually reached the slice-mode navigation path;
  // without this, a missing repaint is indistinguishable from a lost event.
  sliceDiag('scroll', '[slice] user scroll');
  cancelAutoVolumeLoads();
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
  // Only cancel the active load when at capacity. With MAX_PARALLEL_VOLUME_LOADS > 1
  // we let the previous load continue in the background so the user can keep
  // browsing the first image while the second loads.
  if (activeVolumeLoadKey && activeVolumeLoadKey !== key && activeVolumeLoads >= MAX_PARALLEL_VOLUME_LOADS) {
    cancelVolumeLoadByKey(activeVolumeLoadKey);
  }
}

function queueVolumeLoad<T>(
  key: string,
  task: () => Promise<T>,
  priority: VolumeLoadPriority = 'background',
  reason: VolumeLoadReason = 'auto',
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const entry: QueuedVolumeLoad = {
      key,
      priority,
      reason,
      cancelled: false,
      reject,
      run: () => {
        if (entry.cancelled) {
          reject(makeAbortError());
          return;
        }
        activeVolumeLoads++;
        activeVolumeLoadKey = key;
        volumeLoadReasons.set(key, reason);
        publishPerfMonitor();
        task()
          .then(resolve, reject)
          .finally(() => {
            activeVolumeLoads = Math.max(0, activeVolumeLoads - 1);
            if (activeVolumeLoadKey === key) activeVolumeLoadKey = null;
            volumeLoadReasons.delete(key);
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
    // Protect the actual compare pair — not positions 0/1, which are
    // unrelated when the user compared e.g. images 3 and 5.
    keep.add(compareIdxA);
    keep.add(compareIdxB);
  }
  const loaded = images.map((img, idx) => ({ img, idx })).filter(({ img }) => !!img.data);
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
  const estimatedBytes = n * volumeData.BYTES_PER_ELEMENT;

  // Skip 3D texture upload if volume exceeds 1GB to prevent GPU OOM
  const VOLUME_3D_MAX_BYTES = 1 * 1024 * 1024 * 1024; // 1GB
  const skipVolume3D = estimatedBytes > VOLUME_3D_MAX_BYTES;
  if (skipVolume3D) {
    console.log(
      `[NiftiSpy] Skipping 3D texture upload: volume size ${(estimatedBytes / (1024 * 1024)).toFixed(0)}MB exceeds 1GB limit`,
    );
  }

  // Upload native typed array directly — no CPU-side float32 conversion.
  // WebGL2 auto-converts integer types to float in the texture (R32F internal).
  sharedVolumeBuffer = createSharedVolumeBuffer(volumeData);
  if (sharedVolumeBuffer) {
    broadcastToSliceWorkers({
      type: 'sharedVolume',
      buffer: sharedVolumeBuffer,
      nx,
      ny,
      nz,
      slope: dataSlope,
      inter: dataInter,
      datatype: header.datatype,
    });
  }

  if (!skipVolume3D) {
    // Convert Float64 to Float32 for GPU upload (extremely rare datatype)
    const gpuData = toGpuTypedArray(volumeData);
    for (const axis of ['axial', 'coronal', 'sagittal'] as const) {
      // Eagerly create the renderer BEFORE uploading: tryUploadVolume3D often
      // runs from applyImageState before the first paint, and glRenderers used
      // to be populated lazily inside paintSlice/paintSlice3D - so the upload
      // loop below found no renderers and the 3D texture never reached the
      // GPU until some later re-upload trigger.
      const r = getOrCreateRenderer(axis);
      if (r) {
        if (!r.isVolume3DReady()) {
          r.uploadVolume3D(gpuData, nx, ny, nz);
        }
      }
      const wgr = webgpuRenderers[axis];
      if (wgr && wgr.isReady() && !wgr.hasVolume3D()) {
        wgr.uploadVolume3D(gpuData, nx, ny, nz);
      }
    }
  }

  // Lazy-init VolumeRaycaster only when user switches to volume mode
  // Avoids wasting GPU memory + upload time for the common slice-only workflow
  if (renderMode === 'volume' || mipInitialized) {
    if (!volumeRaycaster) {
      initVolumeRaycaster();
    }
    if (volumeRaycaster) {
      const gpuData = toGpuTypedArray(volumeData);
      volumeRaycaster.uploadVolume(gpuData, nx, ny, nz, dataSlope, dataInter);
    }
  }
}

function applyImageState(img: VolumeImage, preserveSlices = false) {
  header = img.header;
  computeViewFlips();
  volumeData = img.data;
  fullVolumeLoaded = !!img.data;
  dataSlope = img.slope;
  dataInter = img.inter;
  globalMin = img.min;
  globalMax = img.max;
  fileName = img.name;
  img.lastAccess = Date.now();
  // Prefetched slice renders belong to the PREVIOUS image (cache key lacks
  // image identity) - keep them and the first visited-slice blit would draw
  // the old image's pixels. Cleared here; window/level and colormap already
  // invalidate via the key itself.
  sliceRenderCache.clear();
  // Clear old GPU 3D textures so the new volume's data gets uploaded.
  // Without this, isVolume3DReady() stays true from the previous image and
  // tryUploadVolume3D() skips the upload — rendering stale data after a switch.
  if (volumeData) {
    for (const axis of ['axial', 'coronal', 'sagittal'] as const) {
      glRenderers[axis]?.clearVolume3D();
      webgpuRenderers[axis]?.clearVolume3D();
    }
  }
  tryUploadVolume3D();
  if (!preserveSlices && img.preview) {
    setCurrentSlice('axial', new Float32Array(img.preview.axial), img.header!.nx, img.header!.ny, 1);
    setCurrentSlice('coronal', new Float32Array(img.preview.coronal), img.header!.nx, img.header!.nz, 1);
    setCurrentSlice('sagittal', new Float32Array(img.preview.sagittal), img.header!.ny, img.header!.nz, 1);
  }
  // Keep the header info panel in sync with the newly active image (it reads
  // the global `header`, which was just swapped above).
  if (headerPanelVisible) updateHeaderPanel();
}

// Both worker downloads and IndexedDB restores must finish the visible UI.
// Worker "done" only means parsing finished; the image is ready after render.
function displayLoadedImage(img: VolumeImage): void {
  // The volume is in memory — the fast path (if any) finished, so stop
  // watching for a stall.
  clearFastPathWatchdog();
  const h = img.header;
  if (isLowResPreview && lowResFactor > 1) {
    sliceIdx.axial = Math.min(h!.nz - 1, Math.round(sliceIdx.axial * lowResFactor));
    sliceIdx.coronal = Math.min(h!.ny - 1, Math.round(sliceIdx.coronal * lowResFactor));
    sliceIdx.sagittal = Math.min(h!.nx - 1, Math.round(sliceIdx.sagittal * lowResFactor));
  } else if (!header || (!volumeData && sliceIdx.axial === 0)) {
    // No preview, or only the early z=0 preview: start at the volume center.
    sliceIdx.axial = Math.floor(h!.nz / 2);
    sliceIdx.coronal = Math.floor(h!.ny / 2);
    sliceIdx.sagittal = Math.floor(h!.nx / 2);
  }
  applyImageState(img, true);
  hideLowResBadge();
  updateFileInfo();
  updateSliderValues();
  renderAllViews();
  updateImagePicker();
  updateProgress(1, '', '');
  loading.style.display = 'none';
  setupInteraction();
}

async function loadVolumeViaWorker(
  loadKey: string,
  url: string,
  gz: boolean,
  progress?: (msg: WorkerStreamMessage) => void,
  directFetchUrl?: string,
  preParsedHeader?: NiiHeader,
): Promise<WorkerStreamMessage> {
  const worker = new Worker(await ensureWorkerBlobUrl());
  const requestId = nextStreamRequestId++;
  return new Promise((resolve, reject) => {
    volumeWorkers.set(loadKey, worker);
    publishPerfMonitor();
    const cleanup = () => {
      if (volumeWorkers.get(loadKey) === worker) {
        volumeWorkers.delete(loadKey);
        volumeWorkerCancels.delete(loadKey);
      }
      worker.terminate();
      publishPerfMonitor();
    };
    volumeWorkerCancels.set(loadKey, () => {
      cleanup();
      reject(makeAbortError());
    });
    worker.onmessage = (ev) => {
      const msg = ev.data as WorkerStreamMessage;
      if (msg.id !== requestId) return;
      if (msg.type === 'progress' || msg.type === 'preview' || msg.type === 'previewVolume') {
        noteFastPathSignal();
        progress?.(msg);
        return;
      }
      if (msg.type === 'log') {
        noteFastPathSignal();
        if (msg.line) vscode.postMessage({ type: 'webviewLog', line: `[worker] ${msg.line}` });
        return;
      }
      if (msg.type === 'bandwidthSample') {
        bandwidthEstimator.addSample(msg.bytes || 0, msg.durationMs || 0);
        if (msg.rttMs) bandwidthEstimator.addRttSample(msg.rttMs);
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
    // Optionally pass a recent bandwidth + RTT estimate so the Worker can choose
    // an initial chunk size tuned for the current network.
    worker.postMessage({
      id: requestId,
      type: 'loadVolume',
      url,
      isGzip: gz,
      directUrl: directFetchUrl || '',
      preParsedHeader: preParsedHeader || null,
      estimatedBps: bandwidthEstimator?.estimatedBps ?? 0,
      estimatedRttMs: bandwidthEstimator?.estimatedRttMs ?? 0,
      priority: volumeLoadReasons.get(loadKey) === 'user' ? 'user' : 'background',
    });
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
    void ensureImageData(index, 'active', 'auto').catch((err) => {
      if (!isAbortError(err)) {
        console.error('Failed to activate image:', err);
      }
    });
  }, ACTIVE_FULL_LOAD_DEBOUNCE_MS);
}

// ── Anticipatory preload of the next image ──────────────────────────
// After the active image finishes loading, we speculatively start loading
// the NEXT image in the background.  This way, when the user clicks "next",
// the data is either already in memory, in IndexedDB (instant restore), or
// mid-download (much shorter wait).  The preload uses 'background' priority
// so it never cancels or interferes with an active load.
let preloadTimer: number | null = null;
function isVerySlowLink(): boolean {
  return bandwidthEstimator.qualityLevel === 'low';
}

async function ensureFullVolumeForTool(): Promise<boolean> {
  if (volumeData && fullVolumeLoaded) return true;
  try {
    await ensureImageData(activeImageIdx, 'active', 'user');
    return !!(volumeData && fullVolumeLoaded);
  } catch {
    return false;
  }
}

function maybeScheduleFullVolume(index: number): void {
  if (!shouldAutoloadFullVolume()) return;
  const policy = viewerConfig.fullVolumePolicy;
  const small = currentFileSize > 0 && currentFileSize <= SLICE_MODE_MIN_BYTES;
  if (policy === 'eager' || (policy === 'adaptive' && (small || !deferFullVolume))) {
    void ensureImageData(index, 'active', 'auto').catch((err) => {
      if (!isAbortError(err)) {
        loadingText.textContent = 'Error: ' + errorMessage(err);
      }
    });
    return;
  }
  scheduleActiveImageLoad(index);
}

bandwidthEstimator.onQualityChange(() => {
  if (bandwidthEstimator.qualityLevel === 'low') {
    cancelAutoVolumeLoads();
    return;
  }
  if (header && shouldAutoloadFullVolume() && !fullVolumeLoaded) {
    maybeScheduleFullVolume(activeImageIdx);
  }
});

function scheduleNextImagePreload(currentIdx: number): void {
  if (deferFullVolume || isVerySlowLink()) return;
  if (preloadTimer) {
    window.clearTimeout(preloadTimer);
    preloadTimer = null;
  }
  // Delay 800ms so the active image's render + GPU upload settle first,
  // and the user has time to start scrolling before we consume bandwidth.
  preloadTimer = window.setTimeout(() => {
    preloadTimer = null;
    if (deferFullVolume || isVerySlowLink()) return;
    const nextIdx = currentIdx + 1;
    if (nextIdx >= images.length) return;
    const nextImg = images[nextIdx];
    if (!nextImg || nextImg.data || nextImg.loadPromise) return;
    // Warm the TCP/TLS connection so the actual download starts faster
    const nextUrl = nextImg.directUrl || nextImg.url;
    injectPreconnectHint(nextUrl);
    void warmupConnection(nextUrl);
    // Trigger background load (checks IndexedDB first, then remote)
    void ensureImageData(nextIdx, 'background').catch(() => {});
  }, 800);
}

async function ensureImageData(
  index: number,
  priority: VolumeLoadPriority = 'background',
  reason: VolumeLoadReason = 'auto',
): Promise<void> {
  const img = images[index];
  if (!img) return;
  const loadKey = img.url;
  await reprioritizeVolumeLoad(loadKey, priority);
  if (img.data) {
    img.lastAccess = Date.now();
    evictInactiveImageData([index, activeImageIdx]);
    if (index === activeImageIdx) scheduleNextImagePreload(index);
    return;
  }
  if (img.loadPromise) {
    await img.loadPromise;
    return;
  }
  img.state = 'loading';
  img.loadPromise = queueVolumeLoad(
    loadKey,
    async () => {
      const startedAt = performance.now();

      // ── Try IndexedDB volume cache first ────────────────────────────
      // If the image was previously evicted from memory (img.data = null) but
      // the full volume is still on disk, restore it instantly instead of
      // re-downloading from the remote server.  This is what makes repeated
      // clicking between images feel instant.
      try {
        // Guard against a wedged IndexedDB: open/get can hang indefinitely in a
        // sandboxed webview, and the volume download must never wait on the
        // cache (that hang looked exactly like a stuck fast-path load).
        const cached = await withTimeout(getVolumeCacheDB().get(loadKey), 3000, 'Volume cache read');
        if (cached) {
          img.header = cached.header;
          img.data = makeTypedArrayFromBuffer(cached.voxelData, cached.datatype);
          img.min = cached.min;
          img.max = cached.max;
          img.slope = cached.slope;
          img.inter = cached.inter;
          img.state = 'ready';
          img.lastAccess = Date.now();
          perfMonitor.fullLoads.push(performance.now() - startedAt);
          publishPerfMonitor();
          if (images[activeImageIdx] === img) displayLoadedImage(img);
          evictInactiveImageData([index, activeImageIdx]);
          if (index === activeImageIdx) scheduleNextImagePreload(index);
          return;
        }
      } catch {
        // Cache read failed — fall through to remote download
      }

      let lastError: unknown = null;
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          const gz = !img.preParsedHeader && ((img.name && img.name.endsWith('.gz')) || img.url.endsWith('.gz'));
          const result = await loadVolumeViaWorker(
            loadKey,
            img.url,
            gz,
            (msg) => {
              if (
                msg.type === 'preview' &&
                !isLowResPreview &&
                images[activeImageIdx] === img &&
                !img.data &&
                !(msg.partialPreview && img.preview?.axial.length)
              ) {
                // A host preview can already show meaningful anatomy at the user's
                // current position. A later streaming z=0 must not replace it.
                showPartialPreviewFromMessage(msg, { fetchMissingSlices: false });
              }
              if (msg.type === 'previewVolume' && images[activeImageIdx] === img && !img.data) {
                // Low-res preview arrived — render immediately so the user sees
                // something while the full-resolution download continues.
                img.header = msg.header;
                img.min = msg.globalMin;
                img.max = msg.globalMax;
                img.slope = msg.slope || 1;
                img.inter = msg.inter || 0;
                img.state = 'preview';
                img.lastAccess = Date.now();

                header = msg.header;
                computeViewFlips();
                globalMin = msg.globalMin;
                globalMax = msg.globalMax;
                dataSlope = msg.slope || 1;
                dataInter = msg.inter || 0;
                volumeData = msg.voxelData!;

                const h = msg.header;
                sliceIdx.axial = Math.floor(h.nz / 2);
                sliceIdx.coronal = Math.floor(h.ny / 2);
                sliceIdx.sagittal = Math.floor(h.nx / 2);

                updateFileInfo();
                updateSliderValues();
                const loadingEl = document.getElementById('loading');
                if (loadingEl) loadingEl.style.display = 'none';
                renderAllViews();
                setupInteraction();
                showLowResBadge(msg.factor || 4);
                updateImagePicker();
              }
              if (images[activeImageIdx] === img && msg.type === 'progress') {
                updateProgress(0.5 + (msg.value ?? 0) * 0.5, undefined, msg.stage ? `${msg.stage}...` : undefined);
              }
            },
            img.directUrl,
            img.preParsedHeader,
          );
          img.header = result.header;
          img.data = result.voxelData!;
          img.min = result.globalMin;
          img.max = result.globalMax;
          img.slope = result.slope || 1;
          img.inter = result.inter || 0;
          img.state = 'ready';
          img.lastAccess = Date.now();
          perfMonitor.fullLoads.push(performance.now() - startedAt);
          publishPerfMonitor();

          // ── Persist full volume to IndexedDB for instant restore later ──
          // Fire-and-forget: if IndexedDB is full or unavailable, just skip.
          if (img.data) {
            const volBuf =
              img.data.byteOffset === 0
                ? img.data.buffer
                : img.data.buffer.slice(img.data.byteOffset, img.data.byteOffset + img.data.byteLength);
            getVolumeCacheDB()
              .put({
                key: loadKey,
                header: result.header,
                voxelData: volBuf instanceof ArrayBuffer ? volBuf : new Uint8Array(volBuf).slice().buffer,
                datatype: result.header.datatype,
                min: result.globalMin,
                max: result.globalMax,
                slope: result.slope || 1,
                inter: result.inter || 0,
              })
              .catch(() => {});
          }

          if (images[activeImageIdx] === img) displayLoadedImage(img);
          evictInactiveImageData([index, activeImageIdx]);
          if (index === activeImageIdx) scheduleNextImagePreload(index);
          return;
        } catch (err) {
          if (isAbortError(err)) throw err;
          lastError = err;
        }
      }
      perfMonitor.failures++;
      publishPerfMonitor();
      throw lastError;
    },
    priority,
    reason,
  )
    .catch((err) => {
      img.state = isAbortError(err) ? 'preview' : 'error';
      throw err;
    })
    .finally(() => {
      img.loadPromise = undefined;
    });
  await img.loadPromise;
}

function setCurrentSlice(axis: Axis, data: Float32Array, width: number, height: number, factor = 1) {
  currentSlices[axis] = { data, width, height, factor };
}

function getAxisGeometry(
  axis: Axis,
  hdr: NiiHeader = header!,
): { width: number; height: number; pixelW: number; pixelH: number; maxIndex: number } {
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

const HOST_SLICE_TIMEOUT_MS = 12_000;

/**
 * Ask the extension host for one plane. In Remote-SSH the host reads it over
 * its own loopback proxy, which avoids depending on VS Code's port forward.
 */
function requestSliceFromHost(
  axis: Axis,
  factor: number,
  index: number,
  signal: AbortSignal,
): Promise<{
  type: 'slice';
  axis: Axis;
  index: number;
  factor: number;
  width: number;
  height: number;
  data: Float32Array;
}> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(makeAbortError());
      return;
    }
    const requestId = ++hostSliceSeq;
    const settle = (fn: () => void) => {
      const pending = hostSlicePending.get(requestId);
      if (!pending) return;
      hostSlicePending.delete(requestId);
      clearTimeout(pending.timer);
      signal.removeEventListener('abort', onAbort);
      fn();
    };
    const onAbort = () =>
      settle(() => {
        reject(makeAbortError());
      });
    const timer = setTimeout(() => {
      settle(() => {
        reject(new Error(`Host slice request timed out after ${HOST_SLICE_TIMEOUT_MS / 1000}s`));
      });
    }, HOST_SLICE_TIMEOUT_MS);
    hostSlicePending.set(requestId, { resolve, reject, timer });
    signal.addEventListener('abort', onAbort, { once: true });
    vscode.postMessage({
      type: 'sliceRequest',
      requestId,
      entryId: hostSliceEntryId,
      webviewId: currentWebviewId,
      axis,
      index,
      factor,
      timeIdx,
    });
  });
}

function handleSliceResponse(msg: {
  requestId?: number;
  axis?: Axis;
  index?: number;
  factor?: number;
  width?: number;
  height?: number;
  data?: ArrayBuffer | ArrayBufferView | number[];
  error?: string;
}): void {
  const requestId = Number(msg.requestId) || 0;
  const pending = hostSlicePending.get(requestId);
  if (!pending) return;
  hostSlicePending.delete(requestId);
  clearTimeout(pending.timer);
  if (msg.error) {
    pending.reject(new Error(msg.error));
    return;
  }
  const raw = msg.data;
  let data: Float32Array;
  if (raw instanceof ArrayBuffer) {
    data = new Float32Array(raw);
  } else if (ArrayBuffer.isView(raw)) {
    data = new Float32Array(raw.buffer, raw.byteOffset, Math.floor(raw.byteLength / 4));
  } else if (Array.isArray(raw)) {
    data = new Float32Array(raw);
  } else {
    pending.reject(new Error('malformed host slice response'));
    return;
  }
  pending.resolve({
    type: 'slice',
    axis: msg.axis || 'axial',
    index: Number(msg.index) || 0,
    factor: Number(msg.factor) || 1,
    width: Number(msg.width) || 0,
    height: Number(msg.height) || 0,
    data,
  });
}

function resetHostSlicePending(): void {
  // Abandoned, not failed: a new image or load path superseded them.
  for (const [, pending] of hostSlicePending) {
    clearTimeout(pending.timer);
    pending.reject(makeAbortError());
  }
  hostSlicePending.clear();
}

async function requestSliceFrame(axis: Axis, factor = 1): Promise<void> {
  if (!header) return;
  // Abort any previous slice request for this axis
  const prevController = sliceAbortControllers.get(axis);
  if (prevController) prevController.abort();
  const controller = new AbortController();
  sliceAbortControllers.set(axis, controller);
  const signal = controller.signal;

  const geometry = getAxisGeometry(axis);
  const requestedIndex = sliceIdx[axis];
  try {
    const response = hostSliceMode
      ? await requestSliceFromHost(axis, factor, requestedIndex, signal)
      : await (
          await getSlicePool()
        ).dispatch<{
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
          directUrl: directUrl,
          axis,
          index: requestedIndex,
          factor,
          prefetch: slicePrefetchCount(),
          maxIndex: geometry.maxIndex,
          timeIdx,
          signal,
        });
    if (signal.aborted) return;
    if (response.index !== sliceIdx[axis]) return;
    sliceDiag(
      `frame-ok:${axis}`,
      `[slice] ${axis} idx=${response.index}/${geometry.maxIndex} factor=${response.factor || factor} ${response.width}x${response.height} bytes=${response.data?.length || 0}`,
      3,
    );
    setCurrentSlice(
      axis,
      response.data,
      response.width || geometry.width,
      response.height || geometry.height,
      response.factor,
    );
  } catch (err) {
    if (isAbortError(err)) return;
    sliceDiag(
      `frame-fail:${axis}`,
      `[slice] ${axis} idx=${requestedIndex} factor=${factor} -> ${errorMessage(err)}`,
      4,
    );
    throw err;
  }
}

// Consecutive per-axis failures, used to report a broken slice endpoint once
// instead of on every wheel tick.
const sliceFailureCounts: Record<Axis, number> = { axial: 0, coronal: 0, sagittal: 0 };

/**
 * Bounded slice-mode trace. The host mirrors every 'webviewLog' line into its
 * output channel and a diagnostics file, which is the only way to see what a
 * Remote-SSH webview did after the fact (its DevTools console is not on disk).
 */
const sliceDiagCounts: Record<string, number> = {};
function sliceDiag(key: string, line: string, max = 4): void {
  const count = (sliceDiagCounts[key] || 0) + 1;
  sliceDiagCounts[key] = count;
  if (count > max) return;
  vscode.postMessage({ type: 'webviewLog', line });
}

function reportSliceFailure(axis: Axis, error: unknown): void {
  const count = ++sliceFailureCounts[axis];
  if (count === 1 || count === 5 || count % 25 === 0) {
    vscode.postMessage({
      type: 'webviewLog',
      line: `[slice] ${axis} fetch failed (${count}x): ${errorMessage(error)}`,
    });
  }
  if (count === 5) showToast('Slice fetch failed — see the NiftiSpy output for details');
}

async function refreshSlices(axes: Axis[], interactive = false) {
  if (!header) return;
  const factor = interactive ? getActiveDownsample() : 1;
  const renderAt = performance.now();
  let anyRendered = false;

  // One axis must never be able to freeze the others: a stuck worker, proxy or
  // IndexedDB lookup previously left the whole viewer unpainted (pan kept
  // working because it does not go through refreshSlices).
  await Promise.all(
    axes.map(async (axis) => {
      try {
        await requestSliceFrame(axis, factor);
      } catch (err) {
        if (isAbortError(err)) return;
        reportSliceFailure(axis, err);
        return;
      }
      sliceFailureCounts[axis] = 0;
      anyRendered = true;
      // Until every axis settles, repaint the ones that already have pixels so
      // a slow sibling cannot hide progress.
      if (axes.length > 1) updateSingleView(axis);
    }),
  );

  if (anyRendered) {
    try {
      renderAllViews();
    } catch (err) {
      // A throwing painter used to abort the whole slice refresh silently:
      // the wheel changed sliceIdx but the canvas never repainted.
      sliceDiag('render', `[slice] render failed: ${errorMessage(err)}`, 3);
    }
    perfMonitor.renderTimes.push(performance.now() - renderAt);
    if (perfMonitor.renderTimes.length > 100) perfMonitor.renderTimes.shift();
  }
  publishPerfMonitor();
  if (interactive && factor > 1) {
    for (const axis of axes) {
      if (sliceQualityTimers[axis]) window.clearTimeout(sliceQualityTimers[axis]);
      sliceQualityTimers[axis] = window.setTimeout(() => {
        requestSliceFrame(axis, 1)
          .then(() => renderAllViews())
          .catch(() => {});
      }, 120);
    }
  }
}

function extractSlice(axis: 'axial' | 'coronal' | 'sagittal', idx: number): Float32Array {
  if (!header || !volumeData) return new Float32Array(0);
  const { nx, ny, nz } = header;
  const src = volumeData;
  const s = dataSlope;
  const intercept = dataInter;
  const needScale = s !== 1 || intercept !== 0;
  const frame = nx * ny * nz;
  const tBase = Math.max(0, timeIdx) * frame;
  if (src.length < tBase + frame) return new Float32Array(0);

  if (axis === 'axial') {
    const slice = float32Pool.acquire(nx * ny);
    const base = tBase + idx * ny * nx;
    if (needScale) {
      for (let i = 0; i < nx * ny; i++) slice[i] = src[base + i] * s + intercept;
    } else {
      for (let i = 0; i < nx * ny; i++) slice[i] = src[base + i];
    }
    return slice;
  } else if (axis === 'coronal') {
    const slice = float32Pool.acquire(nx * nz);
    for (let z = 0; z < nz; z++) {
      const base = tBase + z * ny * nx + idx * nx;
      if (needScale) {
        for (let x = 0; x < nx; x++) slice[z * nx + x] = src[base + x] * s + intercept;
      } else {
        for (let x = 0; x < nx; x++) slice[z * nx + x] = src[base + x];
      }
    }
    return slice;
  } else {
    const slice = float32Pool.acquire(ny * nz);
    for (let z = 0; z < nz; z++) {
      const base = tBase + z * ny * nx;
      if (needScale) {
        for (let y = 0; y < ny; y++) slice[z * ny + y] = src[base + y * nx + idx] * s + intercept;
      } else {
        for (let y = 0; y < ny; y++) slice[z * ny + y] = src[base + y * nx + idx];
      }
    }
    return slice;
  }
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
    await new Promise<void>((resolve) => {
      requestIdleCallback(() => {
        if (job.cancelled || !header || !volumeData) {
          resolve();
          return;
        }
        const { nx, ny, nz } = header;
        const slice = extractSlice(job.axis as 'axial' | 'coronal' | 'sagittal', job.sliceIdx);
        let w: number, h: number;
        if (job.axis === 'axial') {
          w = nx;
          h = ny;
        } else if (job.axis === 'coronal') {
          w = nx;
          h = nz;
        } else {
          w = ny;
          h = nz;
        }

        const tc = document.createElement('canvas');
        tc.width = w;
        tc.height = h;
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
          pixels[idx4] = r;
          pixels[idx4 + 1] = g;
          pixels[idx4 + 2] = b;
          pixels[idx4 + 3] = 255;
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

  recordHit(): void {
    this.hits++;
  },

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
    const behindEnd =
      direction > 0
        ? sliceIndex - 1
        : axis === 'axial'
          ? (header?.nz ?? 0) - 1
          : axis === 'coronal'
            ? (header?.ny ?? 0) - 1
            : (header?.nx ?? 0) - 1;
    if (behindEnd >= behindStart) {
      this.priorityQueue.cancelByAxisAndDirection(axis, behindStart, behindEnd);
    }

    return this.getPrefetchRange(axis);
  }

  getPrefetchRange(axis: string): number {
    const v = Math.abs(this.velocity[axis] || 0); // slices/100ms
    if (v > 3) return 15; // fast scrolling
    if (v >= 1) return 8; // medium scrolling
    return 3; // slow scrolling
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
    if (d <= 2) {
      priority = 'high';
      priorityValue = 3;
    } else if (d <= 5) {
      priority = 'medium';
      priorityValue = 2;
    } else {
      priority = 'low';
      priorityValue = 1;
    }

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
  // GPU slice rendering is OPT-IN only (niftispy.renderBackend=webgl).
  // The default 'auto' must keep using the CPU canvas2d painter: it is the
  // only path that letterboxes each volume by its true physical aspect
  // ratio and applies the per-image orientation flips, so every subject
  // keeps its own size and orientation (ITK-SNAP-like). The GPU 3D-texture
  // path stretches the volume texture across the full canvas and only
  // honors the manual viewFlips — routed through it by default, every
  // brain rendered identically sized/oriented.
  if (viewerConfig.renderBackend !== 'webgl' || !perfProfile.gpuAvailable) return null;
  const existing = glRenderers[axis];
  if (existing?.isReady()) return existing;
  // Replace a dead renderer (e.g. after webglcontextlost destroyed it).
  const renderer = new WebGLRenderer({
    getDataRange: () => ({ min: globalMin, max: globalMax }),
    colormaps: COLORMAPS,
  });
  if (!renderer.init(canvases[axis])) return null;
  glRenderers[axis] = renderer;
  // A fresh renderer has an empty 3D texture; re-upload in the background so
  // the zero-CPU uniform-only slice path comes back after context loss.
  if (volumeData && header) {
    queueMicrotask(() => {
      tryUploadVolume3D();
    });
  }
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
  // A fresh renderer has an empty 3D texture (init is async and usually
  // completes long after tryUploadVolume3D ran); re-upload in the background
  // so the WebGPU slice path actually becomes active.
  if (volumeData && header) {
    queueMicrotask(() => {
      tryUploadVolume3D();
    });
  }
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

  volumeRaycaster.render(
    viewMatrix,
    projMatrix,
    windowLevel - windowWidth * 0.5,
    windowWidth || 1,
    globalMin,
    globalMax - globalMin || 1,
  );
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
    volumeRotationMatrix = multiply4x4(deltaRot as Float32Array, volumeRotationMatrix as Float32Array) as Float32Array;
    renderVolume3D();
  });

  window.addEventListener('mouseup', () => {
    isDraggingVolume = false;
  });

  canvas.addEventListener(
    'wheel',
    (e: WheelEvent) => {
      if (renderMode !== 'volume') return;
      e.preventDefault();
      volumeZoom *= e.deltaY > 0 ? 0.9 : 1.1;
      volumeZoom = Math.max(0.1, Math.min(10, volumeZoom));
      renderVolume3D();
    },
    { passive: false },
  );
}

function multiply4x4(a: Float32Array | ArrayLike<number>, b: Float32Array | ArrayLike<number>): Float32Array {
  const out = new Float32Array(16);
  const aa = a as ArrayLike<number>,
    bb = b as ArrayLike<number>;
  for (let i = 0; i < 4; i++) {
    for (let j = 0; j < 4; j++) {
      out[i * 4 + j] = 0;
      for (let k = 0; k < 4; k++) {
        out[i * 4 + j] += aa[i * 4 + k] * bb[k * 4 + j];
      }
    }
  }
  return out;
}

// GPU-only slice rendering — skips CPU extractSlice entirely.
// Only used when WebGL3D/WebGPU texture is uploaded and ready.
function paintSlice3D(axis: string, w: number, h: number, pixelW: number, pixelH: number) {
  fpsCounter.recordFrame();
  if (!header) return;

  const canvas = canvases[axis as keyof typeof canvases];
  if (!canvas) return;

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
  if (dw / dh > ar) {
    ch = dh;
    cw = Math.floor(dh * ar);
  } else {
    cw = dw;
    ch = Math.floor(dw / ar);
  }

  cw = Math.floor(cw * zoom);
  ch = Math.floor(ch * zoom);

  const newW3d = dw * dpr;
  const newH3d = dh * dpr;
  if (canvas.width !== newW3d || canvas.height !== newH3d) {
    canvas.style.width = dw + 'px';
    canvas.style.height = dh + 'px';
    canvas.width = newW3d;
    canvas.height = newH3d;
  }

  const renderer = getOrCreateRenderer(axis as Axis);
  const flips = viewFlips[axis] || { flipX: false, flipY: false };
  const axisIdx = axis === 'axial' ? 0 : axis === 'coronal' ? 1 : 2;

  const webgpuRenderer = webgpuRenderers[axis as Axis];
  if (
    renderBackend === 'webgpu' &&
    webgpuRenderer &&
    webgpuRenderer.isReady() &&
    webgpuRenderer.renderSlice3D(
      axisIdx,
      sliceIdx[axis as Axis],
      header.nx,
      header.ny,
      header.nz,
      windowLevel - windowWidth * 0.5,
      windowWidth || 1,
      colormap,
      flips.flipX,
      flips.flipY,
      dataSlope,
      dataInter,
      globalMin,
      globalMax - globalMin || 1,
    )
  ) {
    updateDirectionLabels(axis);
    updateCrosshair(axis, w, h, zoom, panX, panY, cw, ch);
    updateScaleBar(axis, pixelW, pixelH, zoom, cw);
    updateMinimap(axis, w, h, zoom, panX, panY, cw, ch);
    return;
  }

  if (
    renderer &&
    renderer.renderSlice3D(
      canvas,
      axisIdx,
      sliceIdx[axis as Axis],
      header.nx,
      header.ny,
      header.nz,
      windowLevel - windowWidth * 0.5,
      windowWidth || 1,
      colormap,
      flips.flipX,
      flips.flipY,
      dataSlope,
      dataInter,
    )
  ) {
    updateDirectionLabels(axis);
    updateCrosshair(axis, w, h, zoom, panX, panY, cw, ch);
    updateScaleBar(axis, pixelW, pixelH, zoom, cw);
    updateMinimap(axis, w, h, zoom, panX, panY, cw, ch);
    return;
  }

  // Should not reach here if volume3D is ready, but fallback gracefully
  paintSlice(
    axis,
    extractSlice(axis as 'axial' | 'coronal' | 'sagittal', sliceIdx[axis as Axis]),
    w,
    h,
    pixelW,
    pixelH,
  );
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
  if (dw / dh > ar) {
    ch = dh;
    cw = Math.floor(dh * ar);
  } else {
    cw = dw;
    ch = Math.floor(dw / ar);
  }

  cw = Math.floor(cw * zoom);
  ch = Math.floor(ch * zoom);

  // Only update canvas dimensions when they actually change — setting
  // canvas.width/height clears the canvas and resets all state, which
  // is expensive on every frame during scrolling/WL adjustment.
  const newW = dw * dpr;
  const newH = dh * dpr;
  // CSS size MUST be synced every frame (the SBS painter already does this
  // unconditionally). Gating it on a buffer-size change left stale CSS
  // dimensions in place whenever the drawing buffer happened to be unchanged
  // while the layout had moved on — the painted image then appeared shifted
  // outside the container.
  canvas.style.width = dw + 'px';
  canvas.style.height = dh + 'px';
  if (canvas.width !== newW || canvas.height !== newH) {
    canvas.width = newW;
    canvas.height = newH;
  }

  const renderer = getOrCreateRenderer(axis as Axis);
  const flips = viewFlips[axis] || { flipX: false, flipY: false };

  if (renderBackend === 'webgpu' && !webgpuChecked) {
    getOrCreateWebGPURenderer(axis as Axis).then(() => {});
  }

  // Try 3D texture paths (WebGPU or WebGL2) when volume is uploaded
  if (renderBackend !== 'canvas2d' && renderBackend !== 'webgl2d' && renderer && renderer.isVolume3DReady() && header) {
    const axisIdx = axis === 'axial' ? 0 : axis === 'coronal' ? 1 : 2;

    const webgpuRenderer = webgpuRenderers[axis as Axis];
    if (
      renderBackend === 'webgpu' &&
      webgpuRenderer &&
      webgpuRenderer.isReady() &&
      webgpuRenderer.renderSlice3D(
        axisIdx,
        sliceIdx[axis as Axis],
        header.nx,
        header.ny,
        header.nz,
        windowLevel - windowWidth * 0.5,
        windowWidth || 1,
        colormap,
        flips.flipX,
        flips.flipY,
        dataSlope,
        dataInter,
        globalMin,
        globalMax - globalMin || 1,
      )
    ) {
      updateDirectionLabels(axis);
      updateCrosshair(axis, w, h, zoom, panX, panY, cw, ch);
      updateScaleBar(axis, pixelW, pixelH, zoom, cw);
      updateMinimap(axis, w, h, zoom, panX, panY, cw, ch);
      return;
    }

    if (
      renderer.renderSlice3D(
        canvas,
        axisIdx,
        sliceIdx[axis as Axis],
        header.nx,
        header.ny,
        header.nz,
        windowLevel - windowWidth * 0.5,
        windowWidth || 1,
        colormap,
        flips.flipX,
        flips.flipY,
        dataSlope,
        dataInter,
      )
    ) {
      updateDirectionLabels(axis);
      updateCrosshair(axis, w, h, zoom, panX, panY, cw, ch);
      updateScaleBar(axis, pixelW, pixelH, zoom, cw);
      updateMinimap(axis, w, h, zoom, panX, panY, cw, ch);
      return;
    }
  }

  // Fallback to 2D rendering when volume3D is not ready (still loading) or 3D path failed
  // renderSlice() handles zoom/pan via canvas transform, so no zoom/pan restriction needed
  if (
    renderBackend !== 'canvas2d' &&
    renderer &&
    data &&
    data.length > 0 &&
    renderer.renderSlice(
      canvas,
      data,
      w,
      h,
      windowLevel - windowWidth * 0.5,
      windowWidth || 1,
      colormap,
      flips.flipX,
      flips.flipY,
    )
  ) {
    updateDirectionLabels(axis);
    updateCrosshair(axis, w, h, zoom, panX, panY, cw, ch);
    updateScaleBar(axis, pixelW, pixelH, zoom, cw);
    updateMinimap(axis, w, h, zoom, panX, panY, cw, ch);
    return;
  }

  // ── Prefetch render-cache hit: skip the per-pixel normalize+colormap pass ──
  // The prefetcher (requestIdleCallback) pre-renders neighboring slices into
  // sliceRenderCache; until now that cache was write-only - scrolling back to
  // a visited slice still paid the full CPU cost. Key includes colormap and
  // window/level; the cache is cleared on image switch (applyImageState).
  // Guard on volumeData: the cache is only populated in full-resolution mode
  // (prefetch jobs require volumeData), and dims must match the current slice.
  if (volumeData) {
    const cachedCanvas = getCachedSliceRender(axis, sliceIdx[axis as Axis]);
    if (cachedCanvas && cachedCanvas.width === w && cachedCanvas.height === h) {
      const ctx = canvas.getContext('2d')!;
      ctx.imageSmoothingEnabled = false;
      ctx.fillStyle = '#000';
      ctx.fillRect(0, 0, canvas.width, canvas.height);

      const imgLeft = (dw - cw) / 2 + panX;
      const imgTop = (dh - ch) / 2 + panY;
      const finalScaleX = flips.flipX ? (-cw * dpr) / w : (cw * dpr) / w;
      const finalScaleY = flips.flipY ? (ch * dpr) / h : (-ch * dpr) / h;
      const finalOffsetX = flips.flipX ? (imgLeft + cw) * dpr : imgLeft * dpr;
      const finalOffsetY = flips.flipY ? imgTop * dpr : (imgTop + ch) * dpr;

      ctx.save();
      ctx.translate(finalOffsetX, finalOffsetY);
      ctx.scale(finalScaleX, finalScaleY);
      ctx.drawImage(cachedCanvas, 0, 0);
      ctx.restore();

      updateDirectionLabels(axis);
      updateCrosshair(axis, w, h, zoom, panX, panY, cw, ch);
      updateScaleBar(axis, pixelW, pixelH, zoom, cw);
      updateMinimap(axis, w, h, zoom, panX, panY, cw, ch, data);
      return;
    }
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

  // Normalize + colormap: merge into single pass to avoid double iteration
  const wasm = getWasmBindings();
  if (wasm && data instanceof Float32Array) {
    const normalized = wasm.applyWindowLevel(data, lo, range, globalMin, globalMax);
    for (let i = 0; i < n; i++) {
      const t = normalized[i] / 255;
      const [r, g, b] = cmapFn(t);
      const idx = i * 4;
      pixels[idx] = r;
      pixels[idx + 1] = g;
      pixels[idx + 2] = b;
      pixels[idx + 3] = 255;
    }
  } else {
    // Single-pass: normalize + colormap in one loop
    for (let i = 0; i < n; i++) {
      const norm = (data[i] - globalMin) / dataRange;
      const t = Math.max(0, Math.min(1, (norm - lo) / range));
      const [r, g, b] = cmapFn(t);
      const idx = i * 4;
      pixels[idx] = r;
      pixels[idx + 1] = g;
      pixels[idx + 2] = b;
      pixels[idx + 3] = 255;
    }
  }

  if (!offscreenCanvas2D) offscreenCanvas2D = document.createElement('canvas');
  offscreenCanvas2D.width = w;
  offscreenCanvas2D.height = h;
  const tctx = offscreenCanvas2D.getContext('2d')!;
  tctx.putImageData(imgData, 0, 0);

  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  const imgLeft = (dw - cw) / 2 + panX;
  const imgTop = (dh - ch) / 2 + panY;
  const finalScaleX = flips.flipX ? (-cw * dpr) / w : (cw * dpr) / w;
  const finalScaleY = flips.flipY ? (ch * dpr) / h : (-ch * dpr) / h;
  const finalOffsetX = flips.flipX ? (imgLeft + cw) * dpr : imgLeft * dpr;
  const finalOffsetY = flips.flipY ? imgTop * dpr : (imgTop + ch) * dpr;

  ctx.save();
  ctx.translate(finalOffsetX, finalOffsetY);
  ctx.scale(finalScaleX, finalScaleY);
  ctx.drawImage(offscreenCanvas2D, 0, 0);
  ctx.restore();

  updateDirectionLabels(axis);
  updateCrosshair(axis, w, h, zoom, panX, panY, cw, ch);
  updateScaleBar(axis, pixelW, pixelH, zoom, cw);
  updateMinimap(axis, w, h, zoom, panX, panY, cw, ch, data);
}

// ITK-Snap style: Get dominant anatomical axis and direction from a srow vector
// Returns { axis: 0(R/L), 1(A/P), 2(S/I), dir: 1(+), -1(-) }
function computeViewFlips() {
  if (!header) return;
  const flips = computeFlipsForHeader(header);
  viewFlips.axial = flips.axial;
  viewFlips.coronal = flips.coronal;
  viewFlips.sagittal = flips.sagittal;
}

// ITK-Snap style letter mapping: [anatomical axis][direction index]
// direction 0 = negative (L/P/I), direction 1 = positive (R/A/S)
const letters: string[][] = [
  ['L', 'R'],
  ['P', 'A'],
  ['I', 'S'],
];

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
    return flips.flipX ? { left: positiveLabel, right: negativeLabel } : { left: negativeLabel, right: positiveLabel };
  } else {
    // Voxel axis goes negative (L/P/I direction)
    // Without flip: left=positive, right=negative
    // With flip: left=negative, right=positive
    return flips.flipX ? { left: negativeLabel, right: positiveLabel } : { left: positiveLabel, right: negativeLabel };
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
    return flips.flipY ? { top: negativeLabel, bottom: positiveLabel } : { top: positiveLabel, bottom: negativeLabel };
  } else {
    // Voxel axis goes negative (L/P/I)
    // Without flip: top=negative, bottom=positive
    // With flip: top=positive, bottom=negative
    return flips.flipY ? { top: positiveLabel, bottom: negativeLabel } : { top: negativeLabel, bottom: positiveLabel };
  }
}

// ── Container size cache: kill forced layouts in the scroll hot path ──
// updateCrosshair runs up to 4x per scroll frame (paintSlice3D once +
// updateAllCrosshairs 3x) and every call forced a synchronous layout via
// getBoundingClientRect. Sizes only change on window/sidebar resize or
// maximize toggle - all caught by a ResizeObserver.
const containerSizeCache = new Map<string, { width: number; height: number }>();
let containerSizeObserver: ResizeObserver | null = null;

function getContainerSize(axis: string): { width: number; height: number } {
  const cached = containerSizeCache.get(axis);
  if (cached) return cached;
  const container = canvases[axis as keyof typeof canvases]?.parentElement;
  if (!container) return { width: 0, height: 0 };
  if (!containerSizeObserver) {
    try {
      containerSizeObserver = new ResizeObserver(() => containerSizeCache.clear());
    } catch {
      containerSizeObserver = null;
    }
  }
  containerSizeObserver?.observe(container);
  const r = container.getBoundingClientRect();
  const size = { width: r.width, height: r.height };
  if (size.width > 0 && size.height > 0) containerSizeCache.set(axis, size);
  return size;
}

function updateCrosshair(
  axis: string,
  w: number,
  h: number,
  zoom: number,
  panX: number,
  panY: number,
  _cw: number,
  _ch: number,
) {
  const container = canvases[axis as keyof typeof canvases]?.parentElement;
  if (!container) return;
  const crosshair = container.querySelector('.crosshair') as HTMLDivElement;
  const crosshairH = container.querySelector('.crosshair-h') as HTMLDivElement;
  const crosshairV = container.querySelector('.crosshair-v') as HTMLDivElement;
  if (!crosshair || !crosshairH || !crosshairV) return;

  // Side-by-side compare mode paints crosshairs INTO the canvas (one per
  // image half, see paintSideBySideSlice, which also hides this DOM node).
  // The DOM crosshair must stay hidden there: re-showing it — e.g. via
  // updateAllCrosshairs() during a pan drag (updateSingleView compare
  // branch) — rendered a SECOND, mispositioned crosshair (its position math
  // assumes a single full-width image, not the SBS split layout) that only
  // disappeared on the next full render (renderAllViews skips the call).
  const sbsCompare = compareMode && compareLayout === 'sideBySide' && images.length >= 2;
  crosshair.style.display = crosshairVisible && !sbsCompare ? 'block' : 'none';
  // In compare mode the views are painted from the compare pair's geometry
  // (img0), not the ACTIVE image — using the global header here put the
  // crosshair at a different scale/position than the painted image whenever
  // the user had switched the active image after entering compare.
  const cmpActive = compareMode && images.length >= 2 ? cmpImg(0) : null;
  const hActive = cmpActive ? cmpActive.header : header;
  if (!crosshairVisible || sbsCompare || !hActive) return;

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

  const nx_axis = axis === 'sagittal' ? hActive.ny : hActive.nx;
  const ny_axis = axis === 'sagittal' ? hActive.nz : axis === 'coronal' ? hActive.nz : hActive.ny;
  const cx_norm = sliceX / (nx_axis - 1 || 1);
  const cy_norm = sliceY / (ny_axis - 1 || 1);

  // Cached container size (ResizeObserver-invalidated) - avoids a forced
  // synchronous layout on every crosshair update in the scroll hot path.
  const containerRect = getContainerSize(axis);

  const pixelW =
    axis === 'axial' ? hActive.nx * hActive.dx : axis === 'coronal' ? hActive.nx * hActive.dx : hActive.ny * hActive.dy;
  const pixelH =
    axis === 'axial' ? hActive.ny * hActive.dy : axis === 'coronal' ? hActive.nz * hActive.dz : hActive.nz * hActive.dz;
  const ar = pixelW / pixelH;
  let imgW: number, imgH: number;
  if (containerRect.width / containerRect.height > ar) {
    imgH = containerRect.height;
    imgW = imgH * ar;
  } else {
    imgW = containerRect.width;
    imgH = imgW / ar;
  }
  imgW *= zoom;
  imgH *= zoom;

  const imgLeft = (containerRect.width - imgW) / 2 + panX;
  const imgTop = (containerRect.height - imgH) / 2 + panY;

  const flips = cmpActive
    ? computeFlipsForHeader(hActive)[axis as 'axial' | 'coronal' | 'sagittal']
    : viewFlips[axis] || { flipX: false, flipY: false };
  const screenX = flips.flipX ? imgLeft + (1 - cx_norm) * imgW : imgLeft + cx_norm * imgW;
  const screenY = flips.flipY ? imgTop + cy_norm * imgH : imgTop + (1 - cy_norm) * imgH;

  crosshairH.style.top = screenY + 'px';
  crosshairV.style.left = screenX + 'px';
}

/** Update the crosshair DOM position for a single axis using current viewState. */
function updateCrosshairPosition(axis: 'axial' | 'coronal' | 'sagittal') {
  const vs = viewState[axis];
  // updateCrosshair reads container dims via getBoundingClientRect(); w/h/cw/ch are unused.
  updateCrosshair(axis, 0, 0, vs.zoom, vs.panX, vs.panY, 0, 0);
}

/** Update crosshair positions in all three orthogonal views. */
function updateAllCrosshairs() {
  updateCrosshairPosition('axial');
  updateCrosshairPosition('coronal');
  updateCrosshairPosition('sagittal');
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

function updateMinimap(
  axis: string,
  w: number,
  h: number,
  zoom: number,
  panX: number,
  panY: number,
  cw: number,
  ch: number,
  existingSliceData?: Float32Array,
) {
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
    // Reuse existing slice data if provided (avoids redundant extractSlice call)
    const sliceData =
      existingSliceData ||
      extractSlice(axis as 'axial' | 'coronal' | 'sagittal', sliceIdx[axis as keyof typeof sliceIdx]);
    const shouldRelease = !existingSliceData && sliceData; // only release if we extracted it ourselves
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
            pixels[idx] = r;
            pixels[idx + 1] = g;
            pixels[idx + 2] = b;
            pixels[idx + 3] = 255;
          }
        }
        mctx.putImageData(imgData, 0, 0);
      }
      if (shouldRelease) float32Pool.release(sliceData);
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

  labels.forEach((label) => {
    const el = label as HTMLElement;
    const pos = el.className.split(' ').find((c) => c.startsWith('dir-'));
    if (pos === 'dir-l') el.textContent = labelsX.left;
    else if (pos === 'dir-r') el.textContent = labelsX.right;
    else if (pos === 'dir-a') el.textContent = labelsY.top;
    else if (pos === 'dir-p') el.textContent = labelsY.bottom;
  });
}

function renderAllViews() {
  if (!header) return;
  const { nx, ny, nz, dx, dy, dz } = header;

  if (!compareMode) {
    ['axial', 'coronal', 'sagittal'].forEach((axis) => {
      const label = document.getElementById(`overlay-label-${axis}`);
      if (label) label.style.display = 'none';
      const sbsL = document.getElementById(`sbs-l-${axis}`);
      const sbsR = document.getElementById(`sbs-r-${axis}`);
      if (sbsL) sbsL.style.display = 'none';
      if (sbsR) sbsR.style.display = 'none';
    });
  }

  if (compareMode && images.length >= 2) {
    // The compare pair renders from its OWN image data — never gate this on
    // the ACTIVE image's volumeData. Clicking an unloaded image in the picker
    // must not collapse the overlay/SBS views into the single-image preview.
    compareRenderer.renderCompareViews();
    return;
  }

  if (volumeData) {
    // When WebGL3D/WebGPU texture is ready, skip CPU extractSlice — GPU samples directly
    const renderer3D = glRenderers.axial;
    const hasVolume3D =
      renderer3D && renderer3D.isVolume3DReady() && renderBackend !== 'canvas2d' && renderBackend !== 'webgl2d';
    if (hasVolume3D) {
      // GPU path: paintSlice3D uses 3D texture sampling, no CPU extraction needed
      paintSlice3D('axial', nx, ny, nx * dx, ny * dy);
      paintSlice3D('coronal', nx, nz, nx * dx, nz * dz);
      paintSlice3D('sagittal', ny, nz, ny * dy, nz * dz);
    } else {
      paintSlice('axial', extractSlice('axial', sliceIdx.axial), nx, ny, nx * dx, ny * dy);
      paintSlice('coronal', extractSlice('coronal', sliceIdx.coronal), nx, nz, nx * dx, nz * dz);
      paintSlice('sagittal', extractSlice('sagittal', sliceIdx.sagittal), ny, nz, ny * dy, nz * dz);
    }
    if (mipInitialized) paintMIP();
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
  drawMeasurements(measurements, highContrastPreferred);

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
    const img0 = cmpImg(0);
    const img1 = cmpImg(1);
    if (!img0?.data || !img1?.data) {
      coordEl.textContent = '';
      return;
    }
    const h0 = img0.header;
    const h1 = img1.header;
    if (cx < 0 || cx >= h0!.nx || cy < 0 || cy >= h0!.ny || cz < 0 || cz >= h0!.nz) {
      coordEl.textContent = '';
      return;
    }
    const v0 = img0.data[cz * h0!.ny * h0!.nx + cy * h0!.nx + cx] * img0.slope + img0.inter;
    const [wx, wy, wz] = voxelToWorld(h0!, cx, cy, cz);
    const [vx1, vy1, vz1] = worldToVoxel(h1!, wx, wy, wz);
    const ix1 = Math.round(vx1),
      iy1 = Math.round(vy1),
      iz1 = Math.round(vz1);
    let v1 = '---';
    if (ix1 >= 0 && ix1 < h1!.nx && iy1 >= 0 && iy1 < h1!.ny && iz1 >= 0 && iz1 < h1!.nz) {
      v1 = (img1.data[iz1 * h1!.ny * h1!.nx + iy1 * h1!.nx + ix1] * img1.slope + img1.inter).toFixed(4);
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
    // Slice mode frames can be downsampled (factor > 1), so the full-resolution
    // voxel coordinate has to be mapped into the slice's own grid. Indexing the
    // small buffer with cx/cy returned undefined and .toFixed() threw inside
    // renderAllViews, which aborted every scroll repaint.
    const slice = currentSlices.axial;
    const sx = Math.min(slice.width - 1, Math.max(0, Math.round((cx / header.nx) * slice.width)));
    const sy = Math.min(slice.height - 1, Math.max(0, Math.round((cy / header.ny) * slice.height)));
    const sample = slice.data[sy * slice.width + sx];
    if (!Number.isFinite(sample)) {
      coordEl.textContent = '';
      return;
    }
    val = sample;
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
  const maxIdx = axis === 'axial' ? img.header!.nz - 1 : axis === 'coronal' ? img.header!.ny - 1 : img.header!.nx - 1;
  const slice = extractSlice(axis, Math.max(0, Math.min(maxIdx, idx)));
  header = savedHeader;
  volumeData = savedData;
  dataSlope = savedSlope;
  dataInter = savedInter;
  return slice;
}

function paintMIP(interactive = false) {
  if (!header) return;
  if (!volumeData || !fullVolumeLoaded) {
    void ensureFullVolumeForTool().then((ok) => {
      if (ok) paintMIP(interactive);
    });
    return;
  }
  const mip = computeMIP(viewState.mip.rot, interactive, { header, volumeData, dataSlope, dataInter, globalMin });
  const outW = mip.w,
    outH = mip.h;
  if (!outW || !outH) return;

  // MIP pixels are square in world mm, so aspect = outW / outH directly
  const canvas = canvases.mip;
  const dpr = window.devicePixelRatio || 1;
  const container = canvas.parentElement!;
  const dw = container.clientWidth;
  const dh = container.clientHeight;
  if (dw === 0 || dh === 0) return;

  const ar = outW / outH;
  let cw: number, ch: number;
  if (dw / dh > ar) {
    ch = dh;
    cw = Math.floor(dh * ar);
  } else {
    cw = dw;
    ch = Math.floor(dw / ar);
  }

  canvas.style.width = cw + 'px';
  canvas.style.height = ch + 'px';
  canvas.width = cw * dpr;
  canvas.height = ch * dpr;

  const ctx = canvas.getContext('2d')!;
  ctx.imageSmoothingEnabled = false;

  const imgData = ctx.createImageData(outW, outH);
  const pixels = imgData.data;
  const cmapFn = COLORMAPS[colormap] || COLORMAPS.gray;
  const lo = windowLevel - windowWidth * 0.5;
  const hi = windowLevel + windowWidth * 0.5;
  const range = hi - lo || 1;
  const dataRange = globalMax - globalMin || 1;

  for (let i = 0; i < outW * outH; i++) {
    const norm = (mip.data[i] - globalMin) / dataRange;
    const t = Math.max(0, Math.min(1, (norm - lo) / range));
    const [r, g, b] = cmapFn(t);
    const idx = i * 4;
    pixels[idx] = r;
    pixels[idx + 1] = g;
    pixels[idx + 2] = b;
    pixels[idx + 3] = 255;
  }

  const tc = document.createElement('canvas');
  tc.width = outW;
  tc.height = outH;
  const tctx = tc.getContext('2d')!;
  tctx.putImageData(imgData, 0, 0);

  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(tc, 0, 0, canvas.width, canvas.height);
}

// rAF-coalesced MIP renders: at most one per display frame. `interactive`
// tracks whether any pending request came from an active drag — dragging
// renders a cheaper preview, idle renders (and drag end) render full quality.
let mipRenderScheduled = false;
let mipInteractivePending = false;

function scheduleMIPRender(interactive: boolean): void {
  mipInteractivePending = mipInteractivePending || interactive;
  if (mipRenderScheduled) return;
  mipRenderScheduled = true;
  requestAnimationFrame(() => {
    mipRenderScheduled = false;
    const wasInteractive = mipInteractivePending;
    mipInteractivePending = false;
    paintMIP(wasInteractive);
  });
}

// ── rAF-coalesced single-view renders ──
// Trackpad/wheel events can fire faster than the display refresh; rendering
// synchronously per threshold crossing painted 2-3x per frame. sliceIdx
// state updates immediately (UI logic stays consistent); only the paint is
// batched to at most one per axis per display frame.
const pendingAxisRenders = new Set<'axial' | 'coronal' | 'sagittal'>();
let axisRenderTimer: number | null = null;

function scheduleSingleViewRender(axis: 'axial' | 'coronal' | 'sagittal'): void {
  pendingAxisRenders.add(axis);
  if (axisRenderTimer !== null) return;
  axisRenderTimer = requestAnimationFrame(() => {
    axisRenderTimer = null;
    const axes = [...pendingAxisRenders];
    pendingAxisRenders.clear();
    for (const a of axes) updateSingleView(a);
  });
}

function updateSingleView(axis: 'axial' | 'coronal' | 'sagittal') {
  // A direct synchronous call supersedes any scheduled render for this axis
  // (prevents double-painting when bulk paths like renderAllViews run).
  pendingAxisRenders.delete(axis);
  if (!header) return;
  const { nx, ny, nz, dx, dy, dz } = header;

  if (compareMode && images.length >= 2) {
    compareRenderer.renderCompareViews(axis);
    updateSliceInfo(axis);
    updateSliderValues();
    if (crosshairVisible) updateCoordInfoFromCenter();
    updateAllCrosshairs();
    return;
  }

  if (volumeHasTimepoint(timeIdx)) {
    // Skip CPU extractSlice when 3D texture is ready (first timepoint only)
    const renderer3D = glRenderers[axis as Axis];
    const hasVolume3D =
      timeIdx === 0 &&
      renderer3D &&
      renderer3D.isVolume3DReady() &&
      renderBackend !== 'canvas2d' &&
      renderBackend !== 'webgl2d';
    if (hasVolume3D) {
      const pixelW = axis === 'sagittal' ? ny * dy : nx * dx;
      const pixelH = axis === 'axial' ? ny * dy : nz * dz;
      paintSlice3D(
        axis,
        axis === 'axial' ? nx : axis === 'coronal' ? nx : ny,
        axis === 'axial' ? ny : axis === 'coronal' ? nz : nz,
        pixelW,
        pixelH,
      );
    } else if (axis === 'axial') {
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

  // Scrolling one axis moves the crosshair in the other two views — update all.
  updateAllCrosshairs();

  if (volumeHasTimepoint(timeIdx)) preloadSlices(axis, sliceIdx[axis]);
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
    {
      axis: 'coronal',
      slider: 'coronal-slider',
      sideSlider: 'coronal-slider-side',
      val: 'coronal-val',
      max: header.ny - 1,
    },
    {
      axis: 'sagittal',
      slider: 'sagittal-slider',
      sideSlider: 'sagittal-slider-side',
      val: 'sagittal-val',
      max: header.nx - 1,
    },
  ];

  for (const s of sliders) {
    const sl = document.getElementById(s.slider) as HTMLInputElement;
    const ssl = document.getElementById(s.sideSlider) as HTMLInputElement;
    const vl = document.getElementById(s.val) as HTMLSpanElement;
    if (sl) {
      sl.max = String(s.max);
      sl.value = String(sliceIdx[s.axis as keyof typeof sliceIdx]);
    }
    if (ssl) {
      ssl.max = String(s.max);
      ssl.value = String(sliceIdx[s.axis as keyof typeof sliceIdx]);
    }
    if (vl) vl.textContent = String(sliceIdx[s.axis as keyof typeof sliceIdx]);
  }

  const nt = Math.max(1, header.nt || 1);
  const timeRow = document.getElementById('time-slider-row') as HTMLElement | null;
  const tsl = document.getElementById('time-slider-side') as HTMLInputElement | null;
  const tvl = document.getElementById('time-val') as HTMLSpanElement | null;
  if (timeRow) timeRow.style.display = nt > 1 ? '' : 'none';
  if (tsl) {
    tsl.max = String(Math.max(0, nt - 1));
    tsl.value = String(Math.min(timeIdx, nt - 1));
    tsl.setAttribute('aria-valuemax', String(Math.max(0, nt - 1)));
    tsl.setAttribute('aria-valuenow', String(timeIdx));
  }
  if (tvl) tvl.textContent = String(timeIdx);
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
  if (globalMin === globalMax) return;

  // Collect samples normalized to [0,1] using each volume's own min/max.
  // This matches how renderSliceToTempCanvas applies W/L: each image is
  // independently normalized before the global W/L is applied, so the
  // W/L must be computed in normalized space to work for all images.
  const samples: number[] = [];

  // Primary volume (img0)
  if (volumeData && volumeData.length > 0) {
    const n = volumeData.length;
    const sampleSize = Math.min(10000, n);
    const step = Math.max(1, Math.floor(n / sampleSize));
    const s = dataSlope;
    const t = dataInter;
    const range0 = globalMax - globalMin || 1;
    for (let i = 0; i < n; i += step) {
      samples.push((volumeData[i] * s + t - globalMin) / range0);
    }
  } else {
    // Fallback to preview slices before the full volume is loaded
    const range0 = globalMax - globalMin || 1;
    const addSlice = (slice: Float32Array | undefined) => {
      if (!slice || slice.length === 0) return;
      const step = Math.max(1, Math.floor(slice.length / 3000));
      for (let i = 0; i < slice.length; i += step) samples.push((slice[i] - globalMin) / range0);
    };
    addSlice(currentSlices.axial?.data);
    addSlice(currentSlices.coronal?.data);
    addSlice(currentSlices.sagittal?.data);
  }

  // Secondary volume (img1) in compare mode — sample and normalize
  // using img1's own range so the W/L works for both images.
  if (compareMode && images.length >= 2) {
    const img1 = cmpImg(1);
    if (!img1) return;
    const range1 = img1.max - img1.min || 1;
    if (img1.data && img1.data.length > 0) {
      const d1 = img1.data;
      const n1 = d1.length;
      const sampleSize1 = Math.min(10000, n1);
      const step1 = Math.max(1, Math.floor(n1 / sampleSize1));
      const s1 = img1.slope || 1;
      const t1 = img1.inter || 0;
      for (let i = 0; i < n1; i += step1) {
        samples.push((d1[i] * s1 + t1 - img1.min) / range1);
      }
    } else if (img1.preview) {
      const addSlice = (slice: Float32Array | undefined) => {
        if (!slice || slice.length === 0) return;
        const step = Math.max(1, Math.floor(slice.length / 3000));
        for (let i = 0; i < slice.length; i += step) samples.push((slice[i] - img1.min) / range1);
      };
      addSlice(img1.preview.axial);
      addSlice(img1.preview.coronal);
      addSlice(img1.preview.sagittal);
    }
  }

  if (samples.length === 0) return;
  samples.sort((a, b) => a - b);

  const p1Idx = Math.floor(samples.length * 0.01);
  const p99Idx = Math.floor(samples.length * 0.99);
  const p1 = samples[p1Idx];
  const p99 = samples[p99Idx];

  // W/L is in normalized [0,1] space — works for all images
  windowLevel = (p1 + p99) / 2;
  windowWidth = p99 - p1;

  const wwSlider = document.getElementById('ww-slider') as HTMLInputElement;
  const wlSlider = document.getElementById('wl-slider') as HTMLInputElement;
  if (wwSlider) wwSlider.value = String(Math.round(windowWidth * 100));
  if (wlSlider) wlSlider.value = String(Math.round(windowLevel * 100));

  if (volumeHasTimepoint(timeIdx)) renderAllViews();
  else void refreshSlices(['axial', 'coronal', 'sagittal']);
}

function resetViews() {
  sliceIdx.axial = Math.floor((header?.nz || 1) / 2);
  sliceIdx.coronal = Math.floor((header?.ny || 1) / 2);
  sliceIdx.sagittal = Math.floor((header?.nx || 1) / 2);

  viewState.axial = { zoom: 1, panX: 0, panY: 0 };
  viewState.coronal = { zoom: 1, panX: 0, panY: 0 };
  viewState.sagittal = { zoom: 1, panX: 0, panY: 0 };
  viewState.mip = { rot: MIP_IDENTITY.slice() };

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
        if (volumeHasTimepoint(timeIdx)) updateSingleView(axis);
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
  const activeImg = images[activeImageIdx];
  const activeColormap = activeImg?.colormap || colormap;
  const cmapFn = COLORMAPS[activeColormap];
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

function updateHeaderPanel(info?: NiiHeader) {
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
  let orientation: string | undefined = h.orientation;
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

  content.innerHTML = rows
    .map(
      ([key, val]) =>
        `<div class="header-row"><span class="header-key">${key}</span><span class="header-val" title="Click to copy" data-copy="${val}">${val}</span></div>`,
    )
    .join('');

  // Add click-to-copy handlers
  content.querySelectorAll('.header-val').forEach((el) => {
    el.addEventListener('click', () => {
      const text = (el as HTMLElement).getAttribute('data-copy') || el.textContent || '';
      navigator.clipboard
        .writeText(text)
        .then(() => {
          el.classList.add('copied');
          setTimeout(() => el.classList.remove('copied'), 800);
        })
        .catch(() => {});
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
    viewContainers.forEach((vc) => vc.classList.remove('hidden'));
  } else {
    maximizedView = view;
    viewsContainer.classList.add('single-view');
    viewContainers.forEach((vc) => {
      if (vc.id === `${view}-c`) {
        vc.classList.remove('hidden');
      } else {
        vc.classList.add('hidden');
      }
    });
  }

  requestAnimationFrame(() => renderAllViews());
}

function applyPreviewData(previewData: PreviewData) {
  header = previewData.header;
  computeViewFlips();
  globalMin = previewData.globalMin;
  globalMax = previewData.globalMax;
  dataSlope = previewData.slope || 1;
  dataInter = previewData.inter || 0;
  sliceIdx.axial = previewData.sliceIdx.axial;
  sliceIdx.coronal = previewData.sliceIdx.coronal;
  sliceIdx.sagittal = previewData.sliceIdx.sagittal;

  // Reuse preview slice arrays directly — avoid unnecessary copy.
  // If slices are empty (placeholder), skip them.
  const axialPreview = toPreviewSlice(previewData.slices?.axial);
  const coronalPreview = toPreviewSlice(previewData.slices?.coronal);
  const sagittalPreview = toPreviewSlice(previewData.slices?.sagittal);
  const axialSlice = axialPreview.length > 0 ? axialPreview : null;
  const coronalSlice = coronalPreview.length > 0 ? coronalPreview : null;
  const sagittalSlice = sagittalPreview.length > 0 ? sagittalPreview : null;
  if (axialSlice) setCurrentSlice('axial', axialSlice, header!.nx, header!.ny, 1);
  if (coronalSlice) setCurrentSlice('coronal', coronalSlice, header!.nx, header!.nz, 1);
  if (sagittalSlice) setCurrentSlice('sagittal', sagittalSlice, header!.ny, header!.nz, 1);

  windowLevel = 0.5;
  windowWidth = 1.0;
  initialWindowWidth = windowWidth;
  initialWindowLevel = windowLevel;

  if (headerPanelVisible) updateHeaderPanel();
}

function setPrimaryImageFromPreview(previewData: PreviewData) {
  images.length = 0;
  images.push({
    header: previewData.header,
    data: null,
    min: previewData.globalMin,
    max: previewData.globalMax,
    name: fileName,
    url: fileUrl,
    directUrl: directUrl,
    slope: previewData.slope || 1,
    inter: previewData.inter || 0,
    colormap: colormap,
    preview: {
      axial: toPreviewSlice(previewData.slices?.axial),
      coronal: toPreviewSlice(previewData.slices?.coronal),
      sagittal: toPreviewSlice(previewData.slices?.sagittal),
    },
    state: 'preview',
    lastAccess: Date.now(),
  });
  activeImageIdx = 0;
  publishPerfMonitor();
}

async function fetchWithRetry(url: string): Promise<ArrayBuffer | null> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const fetchStart = Date.now();
    const resp = await fetch(url);
    if (resp.ok) {
      const payload = await resp.arrayBuffer();
      const fetchDuration = Date.now() - fetchStart;
      const contentLength = Number(resp.headers.get('Content-Length') || 0);
      bandwidthEstimator.addSample(contentLength || payload.byteLength, Math.max(1, fetchDuration));
      return payload;
    }
    const retryable = resp.status === 408 || resp.status === 425 || resp.status === 429 || resp.status >= 500;
    if (!retryable || attempt === 2) return null;
    await new Promise((resolve) => window.setTimeout(resolve, 200 * Math.pow(2, attempt)));
  }
  return null;
}

async function fetchPreviewData(url: string = fileUrl): Promise<PreviewData | null> {
  if (previewRequestCache.has(url)) {
    return previewRequestCache.get(url)!;
  }
  const request = (async () => {
    const startedAt = performance.now();
    let previewData: PreviewData | null = null;
    if (viewerConfig.previewMode === 'binary') {
      const previewBinUrl = url.replace('/file/', '/preview-bin/');
      const buffer = await fetchWithRetry(previewBinUrl);
      if (buffer) {
        previewData = decodePreviewBinary(buffer);
      }
    }
    if (!previewData) {
      const previewUrl = url.replace('/file/', '/preview/');
      const buffer = await fetchWithRetry(previewUrl);
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

// State for the Remote-SSH chunked volume transfer. Only one chunked
// transfer is active at a time; a new transfer resets this state.
let chunkedState: {
  total: number;
  received: number;
  nextExpected: number;
  pending: Map<number, ArrayBuffer>;
  controller: ReadableStreamDefaultController<Uint8Array> | null;
  decompressedChunks: Uint8Array[];
  decompressedLen: number;
  header: NiiHeader | null;
  fileName: string;
  fileSize: number;
  validationToken: string;
  receiveTime: number;
  generation: number; // incremented on each new transfer; stale readers check this
  earlyPreviewSent: boolean;
} | null = null;
let chunkedGeneration = 0;

// ─────────────────────────────────────────────────────────────────────────
// Registration to template space (MNI standard / custom) — sidebar flow.
// The affine search runs in a dedicated regWorker; this section only wires
// the sidebar buttons, mirrors progress into the status box, and stores the
// estimated transform on the moving image (ITK-SNAP style: the original
// volume data is never resampled or modified).
// ─────────────────────────────────────────────────────────────────────────

const registration = new RegistrationController({
  getImages: () => images,
  getActiveIndex: () => activeImageIdx,
  getHeader: () => header,
  getVolumeData: () => volumeData,
  isFullVolumeLoaded: () => fullVolumeLoaded,
  ensureFullVolume: () => ensureFullVolumeForTool(),
  ensureImage: (index, priority, reason) => ensureImageData(index, priority, reason),
  getComparedImage: (which) => cmpImg(which),
  getCompareIndices: () => ({ a: compareIdxA, b: compareIdxB }),
  setCompareIndices: (a, b) => {
    compareIdxA = a;
    compareIdxB = b;
  },
  enterCompareOverlayUI: () => enterCompareOverlayUI(),
  clearCompareCaches: () => {
    compareRenderer.clearCaches();
  },
  showToast,
  postMessage: (message) => vscode.postMessage(message),
  getRegWorkerUrl: () => win.REG_WORKER_URL,
  getCachedRegWorkerUrl: () => win.__NII_REG_WORKER_BLOB_URL__,
  setCachedRegWorkerUrl: (url) => {
    win.__NII_REG_WORKER_BLOB_URL__ = url;
  },
});

function enterCompareOverlayUI(): void {
  compareMode = true;
  compareLayout = 'overlay';
  const btnCompare = document.getElementById('btn-compare') as HTMLButtonElement | null;
  btnCompare?.classList.add('active');
  if (btnCompare) btnCompare.textContent = '◑ Overlay';
  const overlayControls = document.getElementById('overlay-controls');
  if (overlayControls) overlayControls.style.display = 'block';
  const img0 = cmpImg(0);
  const img1 = cmpImg(1);
  if (!img0 || !img1) return;
  applyImageState(img0, true);
  activeImageIdx = images.indexOf(img0);
  const cmapSelect = document.getElementById('colormap') as HTMLSelectElement | null;
  if (cmapSelect && img0) {
    cmapSelect.value = img0.colormap;
    colormap = img0.colormap;
  }
  const overlayCmapSelect = document.getElementById('overlay-colormap') as HTMLSelectElement | null;
  if (overlayCmapSelect && img1) {
    overlayCmapSelect.value = img1.colormap;
  }
  renderColormapPreview();
  sliceIdx.axial = Math.min(sliceIdx.axial, img0.header!.nz - 1);
  sliceIdx.coronal = Math.min(sliceIdx.coronal, img0.header!.ny - 1);
  sliceIdx.sagittal = Math.min(sliceIdx.sagittal, img0.header!.nx - 1);
  updateImagePicker();
  updateFileInfo();
  updateSliderValues();
  renderAllViews();
}

window.addEventListener('DOMContentLoaded', () => {
  publishPerfMonitor();
  // Pre-warm the Worker blob URL so the first loadVolumeViaWorker()
  // doesn't pay the fetch+text+Blob creation cost (~150-200ms).
  // This runs in parallel with the IPC round-trip for the 'ready' → 'config'
  // messages, so it's effectively free.
  ensureWorkerBlobUrl().catch(() => {});
  vscode.postMessage({ type: 'ready' });
});

window.addEventListener('message', async (e) => {
  const msg = e.data;

  if (msg.type === 'sliceResponse') {
    handleSliceResponse(msg);
    return;
  }

  if (msg.type === 'newImage') {
    hostSliceMode = false;
    hostSliceEntryId = '';
    resetHostSlicePending();
    currentLoadId = msg.loadId || currentLoadId;
    const target = msg.directUrl || msg.fileUrl;
    injectPreconnectHint(target);
    void warmupConnection(target);
    loadNewImage(msg.fileUrl, msg.fileName, msg.isGzip, msg.isRemote, msg.directUrl);
    return;
  }

  // Registration flow, step 2: template bytes arrived from the host, hand
  // them to the registration worker along with the current volume.
  if (msg.type === 'templateData') {
    registration.handleTemplateData(msg);
    return;
  }

  if (msg.type === 'regStatus') {
    // Host-side failure / cancellation before any worker was started.
    registration.handleHostFailure(String(msg.message || ''), !!msg.cancelled);
    return;
  }

  if (msg.type === 'loadError') {
    // Host-parsed formats (e.g. .npy) report parse/read failures directly;
    // there is no HTTP fallback that could recover them.
    if (directPreviewTimer) {
      window.clearTimeout(directPreviewTimer);
      directPreviewTimer = null;
    }
    loading.style.display = 'flex';
    updateProgress(0, 'Error: ' + (msg.message || 'Failed to load file'));
    return;
  }

  if (msg.type === 'remoteSshHttp') {
    // Remote-SSH small-file path: the extension host registered the file in
    // the localhost HTTP proxy and port-forwarded it via asExternalUri. The
    // Worker streams the forwarded URL — full tunnel bandwidth, overlapping
    // decompression, early preview — instead of one postMessage per chunk.
    directPreviewReceived = true;
    hostSliceMode = false;
    hostSliceEntryId = '';
    resetHostSlicePending();
    if (directPreviewTimer) {
      window.clearTimeout(directPreviewTimer);
      directPreviewTimer = null;
    }

    fileUrl = msg.url;
    directUrl = ''; // force the Worker to fetch the proxy URL
    fileName = msg.fileName || fileName;
    currentLoadId = msg.loadId || currentLoadId;
    // Trust the host: it knows whether this entry is gzip-backed. Falling back
    // to the file name keeps older hosts working.
    isGzip = msg.isGzip !== undefined ? !!msg.isGzip : fileName.endsWith('.gz');
    isRemoteSource = true;
    deferFullVolume = false;

    // Host-parsed formats (npy/npz/nrrd/mha/mrc/mgh) ship their NIfTI-shaped
    // header here; the Worker must not try to parse the bytes as NIfTI.
    if (msg.hostParsed) msg.preParsedHeader = msg.header;

    if (msg.validationToken && fileName) {
      broadcastToSliceWorkers({
        type: 'setFileHash',
        fileName,
        fileSize: msg.fileSize || 0,
        identity: `${msg.sourceIdentity || msg.url || fileUrl}|${msg.validationToken || ''}`,
      });
      broadcastToSliceWorkers({
        type: 'invalidateCache',
        fileName,
        fileSize: msg.fileSize || 0,
        validationToken: msg.validationToken,
      });
    }

    if (images.length === 0) {
      images.push({
        header: null,
        data: null,
        min: 0,
        max: 1,
        name: fileName,
        url: fileUrl,
        directUrl: '',
        slope: 1,
        inter: 0,
        colormap: colormap,
        state: 'loading',
        lastAccess: Date.now(),
        preParsedHeader: msg.preParsedHeader || undefined,
      });
      activeImageIdx = 0;
    } else {
      const idx = images.length - 1;
      images[idx].url = fileUrl;
      images[idx].directUrl = '';
      images[idx].name = fileName;
      images[idx].preParsedHeader = msg.preParsedHeader || undefined;
      activeImageIdx = idx;
    }
    publishPerfMonitor();

    loadingText.textContent = 'Streaming volume...';
    updateProgress(0.02, 'Streaming volume (fast path)...', 'Stream');
    setupInteraction();

    // A tunnel that goes silent must not leave the spinner up: 15s without
    // progress reports back to the host, which resumes the chunked transfer.
    startFastPathWatchdog(msg.loadId || currentLoadId);

    void ensureImageData(activeImageIdx, 'active').catch((err) => {
      if (isAbortError(err)) return;
      clearFastPathWatchdog();
      vscode.postMessage({
        type: 'webviewLog',
        line: `[remote-ssh-http] fast path failed: ${(err as Error)?.message || String(err)}`,
      });
      vscode.postMessage({
        type: 'remoteHttpFallback',
        webviewId: currentWebviewId,
        loadId: msg.loadId || currentLoadId,
        reason: (err as Error)?.message || String(err),
      });
      loadingText.textContent = 'Retrying with chunked transfer...';
      updateProgress(0.02, 'Retrying with chunked transfer...');
    });
    return;
  }

  if (msg.type === 'remoteSliceMode') {
    remotePreviewStartedAt = Date.now();
    remotePreviewToken = msg.validationToken || '';
    currentLoadId = msg.loadId || currentLoadId;
    // Large Remote-SSH files: preview pixels come from the remote disk;
    // scrolling uses /slice. The compressed object is not pulled across
    // the tunnel.
    directPreviewReceived = true;
    if (directPreviewTimer) {
      window.clearTimeout(directPreviewTimer);
      directPreviewTimer = null;
    }

    fileUrl = msg.url;
    directUrl = '';
    fileName = msg.fileName || fileName;
    // Prefer host-relayed planes when the host offers them: no dependency on
    // the port-forward accepting connections.
    hostSliceMode = !!msg.hostSlices && !!msg.entryId;
    hostSliceEntryId = hostSliceMode ? String(msg.entryId) : '';
    resetHostSlicePending();
    // Keep the compressed flag truthful instead of assuming raw: formats the
    // host already parsed (npz/npy/...) arrive as raw voxels, while .nii.gz
    // stays compressed for the gzip-aware paths.
    isGzip = msg.isGzip !== undefined ? !!msg.isGzip : !msg.hostParsed && /\.nii\.gz$/i.test(fileName);
    isRemoteSource = true;
    deferFullVolume = true;
    if (msg.fileSize) currentFileSize = msg.fileSize;
    {
      let origin = '(unparsable)';
      try {
        origin = new URL(fileUrl).origin;
      } catch {
        /* keep placeholder */
      }
      const h = msg.header;
      sliceDiag(
        'mode',
        `[slice-mode] gz=${isGzip} size=${msg.fileSize || 0} header=${h ? `${h.nx}x${h.ny}x${h.nz}` : 'none'} url=${origin} route=${fileUrl.includes('/file/') ? 'file' : 'other'} hostParsed=${!!msg.hostParsed} hostSlices=${hostSliceMode ? `entry=${hostSliceEntryId}` : 'no'}`,
        1,
      );
    }
    // Slice mode also supports host-parsed formats: slices come from the
    // remote /slice endpoint and the header is already NIfTI-shaped.
    if (msg.hostParsed) msg.preParsedHeader = msg.header;

    if (msg.validationToken && fileName) {
      broadcastToSliceWorkers({
        type: 'setFileHash',
        fileName,
        fileSize: msg.fileSize || 0,
        identity: `${msg.sourceIdentity || msg.url || fileUrl}|${msg.validationToken || ''}`,
      });
      broadcastToSliceWorkers({
        type: 'invalidateCache',
        fileName,
        fileSize: msg.fileSize || 0,
        validationToken: msg.validationToken,
      });
    }

    if (msg.header) {
      showPartialPreviewFromMessage(msg, { fetchMissingSlices: true });
      maybeScheduleFullVolume(0);
    } else {
      loadingText.textContent = 'Loading preview...';
      setupInteraction();
      void fetchPreviewData(fileUrl)
        .then((previewData) => {
          if (!previewData?.header) {
            vscode.postMessage({
              type: 'remoteHttpFallback',
              webviewId: currentWebviewId,
              loadId: msg.loadId || currentLoadId,
              reason: 'slice-mode preview unavailable',
            });
            return;
          }
          applyPreviewData(previewData);
          setPrimaryImageFromPreview(previewData);
          updateFileInfo();
          updateSliderValues();
          updateImagePicker();
          renderAllViews();
          loading.style.display = 'none';
          showSliceModeBadge();
          void refreshSlices(['axial', 'coronal', 'sagittal'], false).catch(() => {});
          maybeScheduleFullVolume(0);
        })
        .catch((err) => {
          vscode.postMessage({
            type: 'remoteHttpFallback',
            webviewId: currentWebviewId,
            loadId: msg.loadId || currentLoadId,
            reason: (err as Error)?.message || String(err),
          });
        });
    }
    return;
  }

  if (msg.type === 'previewOrtho') {
    applyRemoteOrthoPreview(msg);
    return;
  }

  if (msg.type === 'preview') {
    directPreviewReceived = true;
    if (directPreviewTimer) {
      window.clearTimeout(directPreviewTimer);
      directPreviewTimer = null;
    }
    handleDirectPreview(msg);
    return;
  }

  if (msg.type === 'chunkedVolume') {
    // Remote-SSH large-file path: ext host sends the compressed .nii.gz in
    // small chunks (2MB each) to avoid blocking the main thread with one
    // huge postMessage. We feed each chunk to a streaming DecompressionStream
    // and show early preview as soon as enough data is decompressed.
    directPreviewReceived = true;
    if (directPreviewTimer) {
      window.clearTimeout(directPreviewTimer);
      directPreviewTimer = null;
    }
    void handleChunkedVolume(msg);
    return;
  }

  if (msg.type === 'compressedVolume') {
    // Remote-SSH fast path: extension host shipped the COMPRESSED .nii.gz
    // bytes (small) instead of the decompressed volume (large). We
    // decompress locally with the browser-native DecompressionStream,
    // which runs in the renderer's internal thread pool (non-blocking),
    // then reuse handleCachedVolume for rendering. This avoids pushing
    // the full decompressed volume across the SSH tunnel.
    directPreviewReceived = true;
    if (directPreviewTimer) {
      window.clearTimeout(directPreviewTimer);
      directPreviewTimer = null;
    }
    void handleCompressedVolume(msg);
    return;
  }

  if (msg.type === 'cachedVolume') {
    directPreviewReceived = true;
    if (directPreviewTimer) {
      window.clearTimeout(directPreviewTimer);
      directPreviewTimer = null;
    }
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
  directUrl = msg.directUrl || '';
  currentWebviewId = msg.webviewId || '';
  currentLoadId = msg.loadId || '';
  // A new dispatch (local file, or a non-slice remote path) must not inherit
  // the previous image's host-relay routing.
  hostSliceMode = false;
  hostSliceEntryId = '';
  resetHostSlicePending();
  const targetUrl = directUrl || fileUrl;
  injectPreconnectHint(targetUrl);
  void warmupConnection(targetUrl);
  fileName = msg.fileName;
  isGzip = !msg.hostParsed && fileName.endsWith('.gz');
  isRemoteSource = !!msg.isRemote;
  deferFullVolume = !!msg.deferFullVolume;
  currentFileSize = msg.fileSize || currentFileSize;
  viewerConfig.previewMode = msg.previewMode || viewerConfig.previewMode;
  applyRenderBackend(msg.renderBackend || viewerConfig.renderBackend);
  viewerConfig.renderBackend = msg.renderBackend || viewerConfig.renderBackend;
  viewerConfig.fullVolumePolicy = msg.fullVolumePolicy || viewerConfig.fullVolumePolicy;
  viewerConfig.nativeAcceleration = msg.nativeAcceleration || viewerConfig.nativeAcceleration;
  if (msg.renderMode === 'volume' || msg.renderMode === 'slice') {
    renderMode = msg.renderMode;
    if (renderMode === 'volume') {
      mipInitialized = true;
      // VolumeRaycaster will be initialized lazily in tryUploadVolume3D
    }
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
  currentLOD.axial = 2;
  currentLOD.coronal = 2;
  currentLOD.sagittal = 2;

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
  if (msg.isRemoteSsh) {
    // Remote-SSH: startLocalLoad is dispatching the port-forwarded HTTP
    // fast path ('remoteSshHttp' follows) or, if forwarding failed, the
    // legacy chunked/cached postMessage path. Either message drives the
    // UI from here — no HTTP-preview fallback timer.
    loadingText.textContent = 'Preparing volume stream...';
    updateProgress(0.01, 'Preparing volume stream...');
  } else if (msg.skipHttpFallback) {
    // Host-parsed formats (e.g. .npy) deliver a cachedVolume directly. An
    // HTTP preview fallback would re-download and misparse the file.
    loadingText.textContent = 'Preparing volume stream...';
    updateProgress(0.01, 'Preparing volume stream...');
  } else {
    // Use a shorter timeout for remote files — the Worker's streaming path
    // provides early preview, so we don't need to wait 800ms for the
    // Extension Host preview. For local files, 400ms is still enough.
    const previewTimeout = isRemoteSource ? 300 : 400;
    directPreviewTimer = window.setTimeout(() => {
      directPreviewTimer = null;
      if (!directPreviewReceived) {
        fallbackToHttpPreview();
      }
    }, previewTimeout);
  }
});

function showSliceModeBadge(): void {
  if (!lowResBadge) {
    lowResBadge = document.createElement('div');
    lowResBadge.id = 'lowres-badge';
    lowResBadge.style.cssText =
      'position:fixed;top:12px;right:12px;background:rgba(0,0,0,0.78);color:#ffd54f;padding:6px 12px;border-radius:6px;font-size:12px;font-family:monospace;z-index:9999;pointer-events:none;border:1px solid rgba(255,213,79,0.45);';
    document.body.appendChild(lowResBadge);
  }
  lowResBadge.textContent = 'Preview · scrolling loads slices (full volume not downloaded)';
  lowResBadge.style.display = 'block';
}

function extractAxialZ0(raw: Uint8Array, hdr: NiiHeader): Float32Array | null {
  const { nx, ny, voxOffset, bytesPerVoxel, datatype, scl_slope, scl_inter, littleEndian } = hdr;
  const sliceBytes = nx * ny * bytesPerVoxel;
  if (raw.byteLength < voxOffset + sliceBytes) return null;
  const slope = scl_slope || 1;
  const inter = scl_inter || 0;
  const le = littleEndian;
  const out = new Float32Array(nx * ny);
  const view = new DataView(raw.buffer, raw.byteOffset + voxOffset, sliceBytes);
  for (let i = 0; i < nx * ny; i++) {
    const off = i * bytesPerVoxel;
    let val: number;
    switch (datatype) {
      case 2:
        val = view.getUint8(off);
        break;
      case 4:
        val = view.getInt16(off, le);
        break;
      case 8:
        val = view.getInt32(off, le);
        break;
      case 16:
        val = view.getFloat32(off, le);
        break;
      case 64:
        val = view.getFloat64(off, le);
        break;
      case 256:
        val = view.getInt8(off);
        break;
      case 512:
        val = view.getUint16(off, le);
        break;
      case 768:
        val = view.getUint32(off, le);
        break;
      default:
        val = 0;
    }
    out[i] = val * slope + inter;
  }
  return out;
}

function applyRemoteOrthoPreview(msg: PreviewData): void {
  if ((volumeData && fullVolumeLoaded) || (msg.url && msg.url !== fileUrl)) return;
  if (msg.validationToken && msg.validationToken !== remotePreviewToken) return;
  // Scrolling transfers ownership of all planes to the interactive slice pipeline.
  if (lastScrollTime >= remotePreviewStartedAt) return;
  const hdr = (msg.header || header) as NiiHeader | null;
  if (!hdr) return;
  for (const axis of ['axial', 'coronal', 'sagittal'] as Axis[]) {
    const plane = toFloat32Array(msg[`${axis}Slice`], axis, msg);
    const w = axis === 'sagittal' ? hdr.ny : hdr.nx;
    const h = axis === 'axial' ? hdr.ny : hdr.nz;
    if (plane.length === w * h) {
      setCurrentSlice(axis, plane, w, h, 1);
      sliceIdx[axis] = msg.sliceIdx?.[axis] ?? sliceIdx[axis];
    }
  }
  if (msg.globalMax > msg.globalMin) {
    globalMin = msg.globalMin;
    globalMax = msg.globalMax;
  }
  const img = images[activeImageIdx];
  if (img) {
    img.min = globalMin;
    img.max = globalMax;
    img.preview = {
      axial: currentSlices.axial!.data,
      coronal: currentSlices.coronal!.data,
      sagittal: currentSlices.sagittal!.data,
    };
  }
  updateSliderValues();
  renderAllViews();
}

function showPartialPreviewFromMessage(msg: PreviewData, opts?: { fetchMissingSlices?: boolean }): void {
  if (volumeData && fullVolumeLoaded) return;
  if (msg.deferFullVolume) deferFullVolume = true;

  if (!msg.header) {
    loadingText.textContent = 'Loading volume...';
    updateProgress(0.25, 'Reading volume data...');
    return;
  }

  header = msg.header;
  const hdr = header as NiiHeader;
  computeViewFlips();
  globalMin = msg.globalMin ?? 0;
  globalMax = msg.globalMax ?? 1;
  dataSlope = msg.slope || 1;
  dataInter = msg.inter || 0;
  if (msg.sliceIdx) {
    sliceIdx.axial = msg.sliceIdx.axial ?? 0;
    sliceIdx.coronal = msg.sliceIdx.coronal ?? Math.floor(hdr.ny / 2);
    sliceIdx.sagittal = msg.sliceIdx.sagittal ?? Math.floor(hdr.nx / 2);
  } else {
    sliceIdx.axial = 0;
    sliceIdx.coronal = Math.floor(hdr.ny / 2);
    sliceIdx.sagittal = Math.floor(hdr.nx / 2);
  }

  const axial = toFloat32Array(msg.axialSlice, 'axial', msg);
  const coronal = toFloat32Array(msg.coronalSlice, 'coronal', msg);
  const sagittal = toFloat32Array(msg.sagittalSlice, 'sagittal', msg);

  if (axial.length > 0) {
    setCurrentSlice('axial', axial, hdr.nx, hdr.ny, 1);
    if (globalMax <= globalMin) {
      let mn = Infinity,
        mx = -Infinity;
      for (let i = 0; i < axial.length; i++) {
        if (axial[i] < mn) mn = axial[i];
        if (axial[i] > mx) mx = axial[i];
      }
      if (mn === mx) mx = mn + 1;
      globalMin = mn;
      globalMax = mx;
    }
  }
  if (coronal.length > 0 && sliceHasSignal(coronal)) {
    setCurrentSlice('coronal', coronal, hdr.nx, hdr.nz, 1);
  }
  if (sagittal.length > 0 && sliceHasSignal(sagittal)) {
    setCurrentSlice('sagittal', sagittal, hdr.ny, hdr.nz, 1);
  }

  windowLevel = 0.5;
  windowWidth = 1.0;
  initialWindowWidth = windowWidth;
  initialWindowLevel = windowLevel;

  if (!images[activeImageIdx]) {
    setPrimaryImageFromDirectPreview(msg, axial, coronal, sagittal);
  } else {
    const img = images[activeImageIdx];
    img.header = msg.header;
    img.min = globalMin;
    img.max = globalMax;
    img.slope = dataSlope;
    img.inter = dataInter;
    img.state = 'preview';
    img.url = fileUrl;
    img.directUrl = directUrl;
    if (msg.preParsedHeader) img.preParsedHeader = msg.preParsedHeader;
    img.preview = {
      axial,
      coronal: currentSlices.coronal?.data || coronal,
      sagittal: currentSlices.sagittal?.data || sagittal,
    };
  }

  updateFileInfo();
  updateSliderValues();
  updateImagePicker();
  renderAllViews();
  loading.style.display = 'none';
  updateProgress(0.35, deferFullVolume ? 'Slices on demand' : 'Loading volume...');
  setupInteraction();
  if (headerPanelVisible) updateHeaderPanel();

  if (deferFullVolume) {
    showSliceModeBadge();
    if (opts?.fetchMissingSlices) {
      const missing: Axis[] = [];
      if (!currentSlices.coronal) missing.push('coronal');
      if (!currentSlices.sagittal) missing.push('sagittal');
      if (missing.length > 0) {
        void refreshSlices(missing, false).catch(() => {});
      }
    }
  }
}

function handleDirectPreview(msg: PreviewData): void {
  // Remote streaming fast path: Extension Host skipped the preview download
  // because the Worker will stream the remote file directly (overlapping
  // download + decompress + early slice extraction). Start the Worker
  // immediately instead of falling back to the 800ms preview re-fetch.
  if (msg.remoteStreaming === true) {
    if (msg.deferFullVolume) deferFullVolume = true;
    // Cancel the fallback timer — the Worker streaming path will provide
    // early preview, no need for the HTTP preview fallback.
    if (directPreviewTimer) {
      clearTimeout(directPreviewTimer);
      directPreviewTimer = null;
    }
    directPreviewReceived = true;

    images.length = 0;
    images.push({
      header: null,
      data: null,
      min: 0,
      max: 1,
      name: fileName,
      url: fileUrl,
      directUrl: directUrl,
      slope: 1,
      inter: 0,
      colormap: colormap,
      state: 'loading',
      lastAccess: Date.now(),
    });
    activeImageIdx = 0;
    publishPerfMonitor();

    loadingText.textContent = 'Streaming from remote...';
    updateProgress(0.02, 'Streaming remote file...', 'Stream');
    setupInteraction();

    if (deferFullVolume) {
      void fetchPreviewData()
        .then((previewData) => {
          if (previewData && previewData.header) {
            applyPreviewData(previewData);
            setPrimaryImageFromPreview(previewData);
            updateFileInfo();
            updateSliderValues();
            updateImagePicker();
            renderAllViews();
            loading.style.display = 'none';
            showSliceModeBadge();
            void refreshSlices(['axial', 'coronal', 'sagittal'], false).catch(() => {});
          }
        })
        .catch(() => {});
      return;
    }

    void ensureImageData(0, 'active').catch((err) => {
      if (!isAbortError(err)) {
        loadingText.textContent = 'Error: ' + errorMessage(err);
      }
    });
    return;
  }

  if (msg.deferFullVolume) deferFullVolume = true;

  // First axial / ortho preview: paint immediately so Remote-SSH users see
  // an image before the full volume (which may never be downloaded).
  if (msg.partialPreview) {
    showPartialPreviewFromMessage(msg, { fetchMissingSlices: deferFullVolume });
    if (!deferFullVolume) maybeScheduleFullVolume(0);
    return;
  }

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

  maybeScheduleFullVolume(0);
}

/**
 * Remote-SSH compressed-volume handler.
 *
 * The extension host (running on the remote server) read the .nii.gz file
 * WITHOUT decompressing and shipped the compressed bytes here via
 * postMessage. We decompress locally with the browser-native
 * DecompressionStream (runs in the renderer's internal thread pool,
 * non-blocking), then hand the decompressed volume to the existing
 * handleCachedVolume rendering pipeline.
 *
 * This avoids pushing the full DECOMPRESSED volume across the SSH tunnel
 * — only the 3-5x smaller compressed payload crosses the network.
 */

/**
 * Remote-SSH chunked volume handler.
 *
 * The extension host sends the compressed .nii.gz in 2MB chunks (via
 * separate postMessage calls) to avoid blocking its main thread with
 * one huge structured-clone. We feed each chunk IN ORDER to a streaming
 * DecompressionStream, collect the decompressed output, and render once
 * complete. Early preview is shown as soon as the header is parseable.
 */
async function handleChunkedVolume(msg: ChunkedVolumeMessage): Promise<void> {
  // First chunk: initialize streaming decompression state
  if (msg.index === 0) {
    // Abort any previous chunked transfer (user switched files)
    if (chunkedState?.controller) {
      try {
        chunkedState.controller.close();
      } catch {
        /* already closed */
      }
    }
    chunkedState = {
      total: msg.total,
      received: 0,
      nextExpected: 0,
      pending: new Map(),
      controller: null,
      decompressedChunks: [],
      decompressedLen: 0,
      header: null,
      fileName: msg.fileName,
      fileSize: msg.fileSize,
      validationToken: msg.validationToken,
      receiveTime: performance.now(),
      generation: ++chunkedGeneration,
      earlyPreviewSent: false,
    };

    loadingText.textContent = 'Streaming volume...';
    updateProgress(0.05, 'Streaming volume...');

    // Create a ReadableStream that we'll feed chunks to.
    // The DecompressionStream pipes it to decompressed output.
    const compressedStream = new ReadableStream<Uint8Array>({
      start(controller) {
        chunkedState!.controller = controller;
      },
    });

    // Non-gzip fallback (raw .nii over chunked postMessage): the bytes
    // are already decompressed — feed the collector directly.
    const useGzip = msg.isGzip !== false;
    let decompressedStream: ReadableStream<Uint8Array> = compressedStream;
    if (useGzip) {
      // The DOM lib types DecompressionStream as BufferSource -> BufferSource;
      // every chunk fed here is already Uint8Array.
      const ds = new DecompressionStream('gzip') as TransformStream<Uint8Array, Uint8Array>;
      decompressedStream = compressedStream.pipeThrough(ds);
    }
    void readDecompressedStream(decompressedStream);
  }

  if (!chunkedState) return;

  // Cache perfExtTiming for readDecompressedStream (runs in separate async context)
  if (msg.perfExtTiming) msg_perfExtTimingCache = msg.perfExtTiming;

  const chunkData = new Uint8Array(msg.chunk);
  chunkedState.received++;

  // Feed chunks to the decompressor IN ORDER (postMessage preserves order,
  // but we guard against reordering just in case)
  if (msg.index === chunkedState.nextExpected) {
    chunkedState.controller?.enqueue(chunkData);
    chunkedState.nextExpected++;
    // Flush any pending chunks that arrived early
    while (chunkedState.pending.has(chunkedState.nextExpected)) {
      const pending = chunkedState.pending.get(chunkedState.nextExpected)!;
      chunkedState.pending.delete(chunkedState.nextExpected);
      chunkedState.controller?.enqueue(new Uint8Array(pending));
      chunkedState.nextExpected++;
    }
  } else {
    chunkedState.pending.set(msg.index, msg.chunk);
  }

  updateProgress(
    0.05 + 0.35 * (chunkedState.received / chunkedState.total),
    `Streaming volume... ${chunkedState.received}/${chunkedState.total} chunks`,
  );

  // Last chunk: close the stream so the decompressor can finish
  if (chunkedState.received === chunkedState.total) {
    chunkedState.controller?.close();
  }
}

/**
 * Background reader for the decompressed stream. Collects chunks,
 * parses the NIfTI header as soon as enough data is available, and
 * renders the full volume when decompression completes.
 */
async function readDecompressedStream(decompressedStream: ReadableStream<Uint8Array>): Promise<void> {
  const reader = decompressedStream.getReader();
  const state = chunkedState;
  if (!state) return;
  const myGeneration = state.generation;

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      // Stale check: user switched files, abandon this decompression
      if (!chunkedState || chunkedState.generation !== myGeneration) return;
      const chunk = value as Uint8Array;
      state.decompressedChunks.push(chunk);
      state.decompressedLen += chunk.byteLength;

      // Parse header as soon as we have enough data (NIfTI v1=348, v2=544)
      if (!state.header && state.decompressedLen >= 544) {
        const buf = concatUint8Chunks(state.decompressedChunks, state.decompressedLen);
        state.header = parseNiiHeader(buf.buffer as ArrayBuffer, true);
        if (state.header) {
          updateProgress(0.5, 'Decompressing volume...');
        }
      }

      // Paint z=0 as soon as the first axial slice is decompressed.
      if (state.header && !state.earlyPreviewSent) {
        const needed = state.header.voxOffset + state.header.nx * state.header.ny * state.header.bytesPerVoxel;
        if (state.decompressedLen >= needed) {
          const buf = concatUint8Chunks(state.decompressedChunks, state.decompressedLen);
          const axial = extractAxialZ0(buf, state.header);
          if (axial) {
            state.earlyPreviewSent = true;
            let mn = Infinity,
              mx = -Infinity;
            for (let i = 0; i < axial.length; i++) {
              if (axial[i] < mn) mn = axial[i];
              if (axial[i] > mx) mx = axial[i];
            }
            if (mn === mx) mx = mn + 1;
            showPartialPreviewFromMessage(
              {
                header: state.header,
                axialSlice: axial,
                coronalSlice: new Float32Array(0),
                sagittalSlice: new Float32Array(0),
                globalMin: mn,
                globalMax: mx,
                slope: state.header.scl_slope || 1,
                inter: state.header.scl_inter || 0,
                sliceIdx: {
                  axial: 0,
                  coronal: Math.floor(state.header.ny / 2),
                  sagittal: Math.floor(state.header.nx / 2),
                },
                partialPreview: true,
              },
              { fetchMissingSlices: false },
            );
          }
        }
      }
    }

    // Final stale check before rendering
    if (!chunkedState || chunkedState.generation !== myGeneration) return;

    if (!state.header) {
      loadingText.textContent = 'Error: could not parse NIfTI header from decompressed stream';
      return;
    }

    // Assemble the full decompressed buffer
    const full = concatUint8Chunks(state.decompressedChunks, state.decompressedLen);

    // Compute volume statistics (min/max)
    const stats = computeVolumeStatsWebview(full, state.header);

    // Float64 → Float32 downcast
    let voxelBuffer: ArrayBuffer = full.buffer as ArrayBuffer;
    let voxOffset = state.header.voxOffset;
    let datatype = state.header.datatype;
    let bytesPerVoxel = state.header.bytesPerVoxel;
    if (datatype === 64) {
      const n = state.header.nx * state.header.ny * state.header.nz;
      const src = new Float64Array(full.buffer, full.byteOffset + state.header.voxOffset, n);
      const f32 = new Float32Array(n);
      for (let i = 0; i < n; i++) f32[i] = src[i];
      voxelBuffer = f32.buffer;
      voxOffset = 0;
      datatype = 16;
      bytesPerVoxel = 4;
    }

    updateProgress(0.85, 'Rendering...');

    // Reuse the existing rendering pipeline
    const nFinal = state.header.nx * state.header.ny * state.header.nz;
    handleCachedVolume({
      header: { ...state.header, datatype, bytesPerVoxel, bitpix: bytesPerVoxel * 8, voxOffset },
      voxelData: voxelBuffer,
      voxOffset,
      voxelLength: nFinal * bytesPerVoxel,
      datatype,
      globalMin: stats.min,
      globalMax: stats.max,
      slope: state.header.scl_slope || 1,
      inter: state.header.scl_inter || 0,
      sliceIdx: {
        axial: Math.floor(state.header.nz / 2),
        coronal: Math.floor(state.header.ny / 2),
        sagittal: Math.floor(state.header.nx / 2),
      },
      perfExtTiming: {
        ...(msg_perfExtTimingCache || {}),
        isRemoteSSH: true,
        path: 'remote-ssh-chunked',
        webviewDecompressMs: +(performance.now() - state.receiveTime).toFixed(1),
      },
      perfVoxelBytes: nFinal * bytesPerVoxel,
    });

    chunkedState = null; // free state
  } catch (err) {
    loadingText.textContent = 'Error: ' + ((err as Error)?.message || String(err));
    chunkedState = null;
  }
}

// Cache for perfExtTiming from the last chunked message (readDecompressedStream
// runs in a separate async context and can't access the msg parameter).
let msg_perfExtTimingCache: Record<string, unknown> | null = null;

async function handleCompressedVolume(msg: CompressedVolumeMessage): Promise<void> {
  const receiveTime = performance.now();
  const compressed = new Uint8Array(msg.compressedData as ArrayBuffer);
  const extTiming = msg.perfExtTiming || {};

  // Feature detection: DecompressionStream is available in all modern
  // Chromium/WebView2 builds (VS Code's webview engine). If absent
  // (ancient runtime), fall back to the HTTP-proxy preview path.
  const hasNativeDecompress = typeof DecompressionStream !== 'undefined';
  if (!hasNativeDecompress) {
    fallbackToHttpPreview();
    return;
  }

  loadingText.textContent = 'Decompressing volume...';
  updateProgress(0.3, 'Decompressing volume...');

  // Read gzip ISIZE (uncompressed size, little-endian uint32 in the last
  // 4 bytes) to pre-allocate the output buffer. This avoids the O(n)
  // chunks-array + final concat memcpy that dominates large-file loads.
  let preAlloc: Uint8Array | null = null;
  let writeOffset = 0;
  if (compressed.length >= 8) {
    const tail = compressed.length - 4;
    const isize =
      compressed[tail] | (compressed[tail + 1] << 8) | (compressed[tail + 2] << 16) | (compressed[tail + 3] >>> 0);
    // Sanity: 1KB..4GB, and not absurdly larger than compressed * 50
    if (isize >= 1024 && isize <= 0xffffffff && isize < compressed.length * 50) {
      try {
        preAlloc = new Uint8Array(isize);
      } catch {
        /* OOM → fall back to chunks */
      }
    }
  }
  const chunks: Uint8Array[] = [];
  let totalLen = 0;

  // Browser-native streaming inflate. The actual DEFLATE work runs off
  // the main thread in the renderer's compression service, so UI stays
  // responsive; we only do lightweight memcpy + header parse per chunk.
  const ds = new DecompressionStream('gzip');
  const resp = new Response(compressed);
  const decompressedStream = resp.body!.pipeThrough(ds);
  const reader = (decompressedStream as ReadableStream<Uint8Array>).getReader();

  let header: NiiHeader | null = null;
  let earlyPreviewSent = false;

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    const chunk = value as Uint8Array;

    if (preAlloc) {
      if (writeOffset + chunk.byteLength <= preAlloc.length) {
        preAlloc.set(chunk, writeOffset);
        writeOffset += chunk.byteLength;
      } else {
        // Overflow (ISIZE lied or multi-stream) → fall back to chunk list
        if (writeOffset > 0) chunks.push(preAlloc.subarray(0, writeOffset));
        chunks.push(chunk);
        preAlloc = null;
      }
    } else {
      chunks.push(chunk);
    }
    totalLen += chunk.byteLength;

    // Parse header once we have enough bytes (NIfTI v1=348, v2=544).
    if (!header && totalLen >= 544) {
      const view = preAlloc ? preAlloc.subarray(0, Math.min(totalLen, preAlloc.length)) : concatUint8Chunks(chunks);
      header = parseNiiHeader(view.buffer as ArrayBuffer, true);
      if (header) updateProgress(0.5, 'Reading volume data...');
    }

    if (header && !earlyPreviewSent) {
      const needed = header.voxOffset + header.nx * header.ny * header.bytesPerVoxel;
      if (totalLen >= needed) {
        const view = preAlloc ? preAlloc.subarray(0, Math.min(totalLen, preAlloc.length)) : concatUint8Chunks(chunks);
        const axial = extractAxialZ0(view, header);
        if (axial) {
          earlyPreviewSent = true;
          let mn = Infinity,
            mx = -Infinity;
          for (let i = 0; i < axial.length; i++) {
            if (axial[i] < mn) mn = axial[i];
            if (axial[i] > mx) mx = axial[i];
          }
          if (mn === mx) mx = mn + 1;
          showPartialPreviewFromMessage(
            {
              header,
              axialSlice: axial,
              coronalSlice: new Float32Array(0),
              sagittalSlice: new Float32Array(0),
              globalMin: mn,
              globalMax: mx,
              slope: header.scl_slope || 1,
              inter: header.scl_inter || 0,
              sliceIdx: { axial: 0, coronal: Math.floor(header.ny / 2), sagittal: Math.floor(header.nx / 2) },
              partialPreview: true,
            },
            { fetchMissingSlices: false },
          );
        }
      }
    }
  }

  if (!header) {
    fallbackToHttpPreview();
    return;
  }

  // Assemble the full decompressed buffer
  let full: Uint8Array;
  if (preAlloc) {
    full = writeOffset === totalLen ? preAlloc : preAlloc.subarray(0, totalLen);
  } else {
    full = concatUint8Chunks(chunks, totalLen);
  }

  // Stats (min/max) via typed-array fast path with sampling — mirrors
  // the extension host's computeVoxelStats so window/level matches.
  const stats = computeVolumeStatsWebview(full, header);

  // Float64 → Float32 downcast (visualization only; halves memory).
  // full is always backed by a regular ArrayBuffer (we allocate it via
  // new Uint8Array(isize) or concatUint8Chunks), so the cast is sound.
  let voxelBuffer: ArrayBuffer = full.buffer as ArrayBuffer;
  let voxOffset = header.voxOffset;
  let datatype = header.datatype;
  let bytesPerVoxel = header.bytesPerVoxel;
  if (datatype === 64) {
    const n = header.nx * header.ny * header.nz;
    const src = new Float64Array(full.buffer, full.byteOffset + header.voxOffset, n);
    const f32 = new Float32Array(n);
    for (let i = 0; i < n; i++) f32[i] = src[i];
    voxelBuffer = f32.buffer;
    voxOffset = 0;
    datatype = 16;
    bytesPerVoxel = 4;
  }

  updateProgress(0.7, 'Rendering...');

  // Reuse the existing rendering pipeline by constructing a message
  // with the same shape handleCachedVolume expects.
  const nFinal = header.nx * header.ny * header.nz;
  handleCachedVolume({
    header: { ...header, datatype, bytesPerVoxel, bitpix: bytesPerVoxel * 8, voxOffset },
    voxelData: voxelBuffer,
    voxOffset,
    voxelLength: nFinal * bytesPerVoxel,
    datatype,
    globalMin: stats.min,
    globalMax: stats.max,
    slope: header.scl_slope || 1,
    inter: header.scl_inter || 0,
    sliceIdx: {
      axial: Math.floor(header.nz / 2),
      coronal: Math.floor(header.ny / 2),
      sagittal: Math.floor(header.nx / 2),
    },
    perfExtTiming: {
      ...extTiming,
      webviewDecompressMs: +(performance.now() - receiveTime).toFixed(1),
    },
    perfVoxelBytes: nFinal * bytesPerVoxel,
  });
}

function handleCachedVolume(msg: CachedVolumeMessage): void {
  // Webview performance.now() origin differs from extension host origin,
  // so we cannot subtract extension sendTime from webview receiveTime.
  // Instead, we measure the webview-internal interval (receive → render done)
  // and report it back. Extension reports its own decompress/serial time.
  const receiveTime = performance.now();
  const extTiming = msg.perfExtTiming || null;
  const voxelBytes = msg.perfVoxelBytes || 0;
  // A full volume can arrive while Remote-SSH slice streaming is active
  // (background relay). Retire the relay so scrolling switches to the
  // in-memory volume, and keep the slice position the user is looking at
  // instead of jumping to the message's defaults.
  const wasSliceRelay = hostSliceMode;
  if (hostSliceMode) {
    hostSliceMode = false;
    hostSliceEntryId = '';
    resetHostSlicePending();
  }
  deferFullVolume = false;
  const wasPartialPreview = !wasSliceRelay && sliceIdx.axial === 0 && header && header.nz > 1;
  header = msg.header;
  computeViewFlips();
  globalMin = msg.globalMin;
  globalMax = msg.globalMax;
  dataSlope = msg.slope || 1;
  dataInter = msg.inter || 0;
  if (!wasSliceRelay || !header) {
    sliceIdx.axial = msg.sliceIdx.axial;
    sliceIdx.coronal = msg.sliceIdx.coronal;
    sliceIdx.sagittal = msg.sliceIdx.sagittal;

    // If we were showing z=0 preview, navigate to center slice now
    if (wasPartialPreview && header) {
      sliceIdx.axial = Math.floor(header.nz / 2);
      sliceIdx.coronal = Math.floor(header.ny / 2);
      sliceIdx.sagittal = Math.floor(header.nx / 2);
    }
  }

  const datatype = msg.datatype || 16;
  let voxelBuffer: ArrayBuffer | null = null;
  let voxOffset = 0; // byte offset within voxelBuffer where voxel data starts
  const voxelData = msg.voxelData;
  if (voxelData instanceof ArrayBuffer) {
    voxelBuffer = voxelData;
    voxOffset = msg.voxOffset || 0;
  } else if (ArrayBuffer.isView(voxelData)) {
    // Legacy path: caller passed a typed-array view. Slice it out.
    voxelBuffer = voxelData.buffer.slice(
      voxelData.byteOffset,
      voxelData.byteOffset + voxelData.byteLength,
    ) as ArrayBuffer;
    voxOffset = 0;
  } else if (Array.isArray(voxelData)) {
    const f32 = new Float32Array(voxelData);
    voxelBuffer = f32.buffer.slice(f32.byteOffset, f32.byteOffset + f32.byteLength) as ArrayBuffer;
    voxOffset = 0;
  } else if (voxelData && typeof voxelData === 'object' && 'byteLength' in voxelData) {
    try {
      const record = voxelData as Record<number, number>;
      const keys = Object.keys(record);
      if (keys.length > 0) {
        const arr = new Uint8Array(keys.length);
        for (let i = 0; i < keys.length; i++) arr[i] = record[i];
        voxelBuffer = arr.buffer;
        voxOffset = 0;
      }
    } catch {
      /* optional API unavailable */
    }
  }

  if (voxelBuffer) {
    // Use the voxelLength if provided to compute element count precisely;
    // otherwise infer from (buffer - voxOffset) / elemSize.
    const elemSize =
      datatype === 64
        ? 8
        : datatype === 8 || datatype === 16 || datatype === 768
          ? 4
          : datatype === 4 || datatype === 512
            ? 2
            : 1;
    const voxelBytes = msg.voxelLength !== undefined ? msg.voxelLength : voxelBuffer.byteLength - voxOffset;
    const elemCount = (voxelBytes / elemSize) | 0;
    switch (datatype) {
      case 2:
        volumeData = new Uint8Array(voxelBuffer, voxOffset, elemCount);
        break;
      case 4:
        volumeData = new Int16Array(voxelBuffer, voxOffset, elemCount);
        break;
      case 8:
        volumeData = new Int32Array(voxelBuffer, voxOffset, elemCount);
        break;
      case 16:
        volumeData = new Float32Array(voxelBuffer, voxOffset, elemCount);
        break;
      case 64:
        volumeData = new Float64Array(voxelBuffer, voxOffset, elemCount);
        break;
      case 256:
        volumeData = new Int8Array(voxelBuffer, voxOffset, elemCount);
        break;
      case 512:
        volumeData = new Uint16Array(voxelBuffer, voxOffset, elemCount);
        break;
      case 768:
        volumeData = new Uint32Array(voxelBuffer, voxOffset, elemCount);
        break;
      default:
        volumeData = new Float32Array(voxelBuffer, voxOffset, elemCount);
        break;
    }
    fullVolumeLoaded = true;

    // Track memory usage
    totalVolumeBytes = volumeData.byteLength;
    workerCopyBytes = volumeData.byteLength; // would be duplicated in workers without SAB
    sharedBufferBytes = 0;

    // Create SharedArrayBuffer for slice workers (CPU fallback path only)
    // GPU 3D texture path doesn't need SAB — shader handles everything
    if (header && volumeData) {
      sharedVolumeBuffer = createSharedVolumeBuffer(volumeData);
      if (sharedVolumeBuffer) {
        sharedBufferBytes = sharedVolumeBuffer.byteLength;
        workerCopyBytes = 0; // workers no longer need their own copy
        broadcastToSliceWorkers({
          type: 'sharedVolume',
          buffer: sharedVolumeBuffer,
          nx: header.nx,
          ny: header.ny,
          nz: header.nz,
          slope: dataSlope,
          inter: dataInter,
          datatype: msg.datatype || 16,
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
    const existingCmap = images[pendingAddImageIdx]?.colormap ?? colormap;
    images[pendingAddImageIdx] = {
      header: msg.header,
      data: volumeData,
      min: msg.globalMin,
      max: msg.globalMax,
      name: fileName,
      url: fileUrl,
      directUrl: directUrl,
      slope: msg.slope || 1,
      inter: msg.inter || 0,
      colormap: existingCmap,
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
      directUrl: directUrl,
      slope: msg.slope || 1,
      inter: msg.inter || 0,
      colormap: colormap,
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
  if (volumeData) hideLowResBadge();

  if (headerPanelVisible) updateHeaderPanel();

  if (!volumeData) {
    maybeScheduleFullVolume(0);
  }

  // ── Performance report ──
  // Measure wall-clock time for: postMessage transfer + view creation +
  // SharedArrayBuffer setup + render. Post back to extension so it can
  // correlate with its own decompress/downcast/cache timings and emit
  // a full breakdown to the NiftiSpy Performance output channel.
  if (extTiming) {
    const renderDoneTime = performance.now();
    const viewSetupMs = +(renderDoneTime - receiveTime).toFixed(1);
    vscode.postMessage({
      type: 'perfReport',
      fileName,
      voxelBytes,
      isGzip: !!extTiming.isGzip,
      viewSetupMs,
      ext: extTiming,
    });
  }
}

function handleLODData(msg: LodDataMessage): void {
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
      data:
        msg.axial instanceof ArrayBuffer
          ? new Float32Array(msg.axial)
          : Array.isArray(msg.axial)
            ? new Float32Array(msg.axial)
            : new Float32Array(0),
      w: msg.axialW,
      h: msg.axialH,
    };
  }
  if (msg.coronal && msg.coronalW && msg.coronalH) {
    ld.coronal = {
      data:
        msg.coronal instanceof ArrayBuffer
          ? new Float32Array(msg.coronal)
          : Array.isArray(msg.coronal)
            ? new Float32Array(msg.coronal)
            : new Float32Array(0),
      w: msg.coronalW,
      h: msg.coronalH,
    };
  }
  if (msg.sagittal && msg.sagittalW && msg.sagittalH) {
    ld.sagittal = {
      data:
        msg.sagittal instanceof ArrayBuffer
          ? new Float32Array(msg.sagittal)
          : Array.isArray(msg.sagittal)
            ? new Float32Array(msg.sagittal)
            : new Float32Array(0),
      w: msg.sagittalW,
      h: msg.sagittalH,
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

function setPrimaryImageFromDirectPreview(
  msg: PreviewData,
  axial: Float32Array,
  coronal: Float32Array,
  sagittal: Float32Array,
): void {
  images.length = 0;
  images.push({
    header: msg.header,
    data: null,
    min: msg.globalMin,
    max: msg.globalMax,
    name: fileName,
    url: fileUrl,
    directUrl: directUrl,
    slope: msg.slope || 1,
    inter: msg.inter || 0,
    colormap: colormap,
    preview: { axial, coronal, sagittal },
    state: 'preview',
    lastAccess: Date.now(),
    preParsedHeader: msg.preParsedHeader || undefined,
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
      slicePool.setErrorHandler((err) => {
        loadingText.textContent = 'Worker error: ' + (err.message || 'unknown');
      });
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
        maybeScheduleFullVolume(0);
        return;
      }
    } catch {
      /* optional preview path unavailable */
    }

    loadFullVolume();
  } catch (err) {
    loadingText.textContent = 'Error: ' + errorMessage(err);
  }
}

function showLowResBadge(factor: number) {
  isLowResPreview = true;
  lowResFactor = factor;
  if (!lowResBadge) {
    lowResBadge = document.createElement('div');
    lowResBadge.id = 'lowres-badge';
    lowResBadge.style.cssText =
      'position:fixed;top:12px;right:12px;background:rgba(0,0,0,0.78);color:#ffd54f;padding:6px 12px;border-radius:6px;font-size:12px;font-family:monospace;z-index:9999;pointer-events:none;border:1px solid rgba(255,213,79,0.45);';
    document.body.appendChild(lowResBadge);
  }
  const denom = factor * factor * factor;
  lowResBadge.textContent = `低分辨率预览 (1/${denom} 数据) · 正在加载完整分辨率…`;
  lowResBadge.style.display = 'block';
}

function hideLowResBadge() {
  isLowResPreview = false;
  if (lowResBadge) lowResBadge.style.display = 'none';
}

function loadFullVolume() {
  let previewReceived = false;
  let volumeReceived = false;

  workerStreamListener = (d) => {
    if (d.type === 'progress') {
      updateProgress(0.5 + (d.value ?? 0) * 0.5, undefined, d.stage ? `${d.stage}...` : undefined);
      return;
    }
    if (d.type === 'error') {
      const loadingText = document.getElementById('loading-text');
      if (loadingText) loadingText.textContent = 'Error: ' + d.error;
      return;
    }
    if (d.type === 'previewVolume') {
      // Stage 1 low-res preview: a complete strided sub-sampled volume
      // already decoded by the proxy. Render all three orthogonal views
      // immediately and surface a badge; the full-resolution `volume`
      // message will replace it when download/decompress finishes.
      if (volumeReceived) return; // full volume already shown
      if (isLowResPreview) return; // badge already up
      header = d.header;
      computeViewFlips();
      globalMin = d.globalMin;
      globalMax = d.globalMax;
      dataSlope = d.slope || 1;
      dataInter = d.inter || 0;
      volumeData = d.voxelData!;

      // Center slices within the low-res volume
      const h = d.header;
      sliceIdx.axial = Math.floor(h.nz / 2);
      sliceIdx.coronal = Math.floor(h.ny / 2);
      sliceIdx.sagittal = Math.floor(h.nx / 2);

      initialWindowWidth = windowWidth;
      initialWindowLevel = windowLevel;

      updateFileInfo();
      updateSliderValues();

      const loading = document.getElementById('loading');
      if (loading) loading.style.display = 'none';
      renderAllViews();
      setupInteraction();
      showLowResBadge(d.factor || 4);
      return;
    }
    if (d.type === 'preview') {
      if (previewReceived) return;
      previewReceived = true;
      // Partial early preview (axial z=0 only) is not user-ready; keep loading visible.
      if (d.partialPreview) {
        showPartialPreviewFromMessage(d, { fetchMissingSlices: false });
        return;
      }
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

        initialWindowWidth = windowWidth;
        initialWindowLevel = windowLevel;

        const h = d.header;
        paintSlice('axial', toPreviewSlice(d.slices?.axial), h.nx, h.ny, h.nx * h.dx, h.ny * h.dy);
        paintSlice('coronal', toPreviewSlice(d.slices?.coronal), h.nx, h.nz, h.nx * h.dx, h.nz * h.dz);
        paintSlice('sagittal', toPreviewSlice(d.slices?.sagittal), h.ny, h.nz, h.ny * h.dy, h.nz * h.dz);

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
      volumeData = d.voxelData!;
      fullVolumeLoaded = true;
      // Full-resolution volume arrived — clear the low-res preview state.
      // `header` may already be set from `previewVolume`; only override if
      // the full-volume header differs (it carries the true dimensions).
      const prevHeaderWasLowRes = isLowResPreview;
      if (prevHeaderWasLowRes) {
        // Preserve the user's current slice indices by scaling them back
        // into full-resolution voxel space.
        const prevH = header;
        const newH = d.header;
        if (prevH && lowResFactor > 1) {
          sliceIdx.axial = Math.min(newH.nz - 1, Math.round(sliceIdx.axial * lowResFactor));
          sliceIdx.coronal = Math.min(newH.ny - 1, Math.round(sliceIdx.coronal * lowResFactor));
          sliceIdx.sagittal = Math.min(newH.nx - 1, Math.round(sliceIdx.sagittal * lowResFactor));
        }
      }
      // Promote the global header/min/max/slope/inter to full-resolution
      // values. After a previewVolume, the globals still hold the low-res
      // header (smaller nx/ny/nz, scaled spacings) and must be replaced
      // before renderAllViews() reads them.
      header = d.header;
      computeViewFlips();
      globalMin = d.globalMin;
      globalMax = d.globalMax;
      dataSlope = d.slope || 1;
      dataInter = d.inter || 0;
      hideLowResBadge();
      const primary = images[0];
      if (primary) {
        primary.header = d.header;
        primary.data = d.voxelData!;
        primary.min = d.globalMin;
        primary.max = d.globalMax;
        primary.slope = d.slope || 1;
        primary.inter = d.inter || 0;
        primary.state = 'ready';
        primary.lastAccess = Date.now();
      } else {
        images.push({
          header: d.header,
          data: d.voxelData!,
          min: d.globalMin,
          max: d.globalMax,
          name: fileName,
          url: fileUrl,
          directUrl: directUrl,
          slope: d.slope || 1,
          inter: d.inter || 0,
          colormap: colormap,
          preview:
            currentSlices.axial && currentSlices.coronal && currentSlices.sagittal
              ? {
                  axial: new Float32Array(currentSlices.axial.data),
                  coronal: new Float32Array(currentSlices.coronal.data),
                  sagittal: new Float32Array(currentSlices.sagittal.data),
                }
              : undefined,
          state: 'ready',
          lastAccess: Date.now(),
        });
        activeImageIdx = 0;
      }
      publishPerfMonitor();

      updateImagePicker();
      updateProgress(1.0);
      loading.style.display = 'none';
      renderAllViews();
      setupInteraction();
      return;
    }
  };

  if (slicePool)
    slicePool.sendToFirst({
      id: 0,
      type: 'loadVolume',
      url: fileUrl,
      isGzip,
      directUrl: directUrl || '',
      estimatedBps: bandwidthEstimator?.estimatedBps ?? 0,
      estimatedRttMs: bandwidthEstimator?.estimatedRttMs ?? 0,
    });
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
  viewState.mip = { rot: MIP_IDENTITY.slice() };
  if (!img.data) {
    primeSliceFramesFromPreview(img);
    void refreshSlices(['axial', 'coronal', 'sagittal'], true).catch(() => {});
  }

  initialWindowWidth = windowWidth;
  initialWindowLevel = windowLevel;

  const cmapSelect = document.getElementById('colormap') as HTMLSelectElement;
  const overlayCmapSelect = document.getElementById('overlay-colormap') as HTMLSelectElement;
  if (cmapSelect && images[activeImageIdx]) {
    cmapSelect.value = images[activeImageIdx].colormap;
    colormap = images[activeImageIdx].colormap;
  }
  if (overlayCmapSelect && cmpImg(1)) {
    overlayCmapSelect.value = cmpImg(1)!.colormap;
  }
  renderColormapPreview();

  updateFileInfo();
  updateSliderValues();
  updateImagePicker();
  renderAllViews();
  if (!img.data) {
    maybeScheduleFullVolume(idx);
  } else {
    scheduledActiveIndex = null;
    if (activeLoadDebounceTimer) {
      window.clearTimeout(activeLoadDebounceTimer);
      activeLoadDebounceTimer = null;
    }
    publishPerfMonitor();
    // Image is ready — speculatively preload the next one in the background
    scheduleNextImagePreload(idx);
  }
}

function updateImagePicker() {
  const picker = document.getElementById('image-list');
  if (!picker) return;
  if (!thumbnailObserver && 'IntersectionObserver' in window) {
    thumbnailObserver = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue;
          const canvas = entry.target as HTMLCanvasElement;
          const index = Number(canvas.dataset.imageIdx || '-1');
          if (index >= 0 && images[index]) {
            renderThumbnail(canvas, images[index]);
          }
          thumbnailObserver?.unobserve(canvas);
        }
      },
      { root: picker, rootMargin: '48px' },
    );
  }
  picker.innerHTML = '';
  images.forEach((img, idx) => {
    const item = document.createElement('div');
    item.className = 'image-item' + (idx === activeImageIdx ? ' active' : '');

    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.className = 'image-item-cmp';
    cb.checked = !!img.selected;
    cb.title = 'Select for compare (exactly two)';
    cb.style.margin = '0 6px 0 2px';
    cb.style.flexShrink = '0';
    cb.style.cursor = 'pointer';
    cb.addEventListener('click', (e) => e.stopPropagation());
    cb.addEventListener('change', () => {
      if (cb.checked && images.filter((im) => im.selected).length >= 2) {
        cb.checked = false;
        showToast('Cannot compare more than two images.');
        return;
      }
      img.selected = cb.checked;
    });
    item.appendChild(cb);

    const thumb = document.createElement('div');
    thumb.className = 'image-item-thumb';
    const thumbCanvas = document.createElement('canvas');
    thumb.appendChild(thumbCanvas);
    item.appendChild(thumb);

    const name = document.createElement('span');
    name.className = 'image-item-name';
    name.textContent = img.align ? `${img.name} ⇄` : img.name;
    name.title = img.align
      ? `${img.name} — aligned to ${img.align.ref} (stored transform, original data untouched)`
      : img.name;
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
        win.requestIdleCallback?.(renderThumb, { timeout: 120 });
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
    const s = img.slope,
      t = img.inter;
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

  const w = nx,
    h = ny;
  const imgData = ctx.createImageData(w, h);
  const pixels = imgData.data;
  const cmapFn = COLORMAPS[img.colormap] || COLORMAPS.gray;
  const lo = windowLevel - windowWidth * 0.5;
  const hi = windowLevel + windowWidth * 0.5;
  const range = hi - lo || 1;
  const dataRange = img.max - img.min || 1;

  for (let i = 0; i < w * h; i++) {
    const norm = (slice[i] - img.min) / dataRange;
    const t = Math.max(0, Math.min(1, (norm - lo) / range));
    const [r, g, b] = cmapFn(t);
    const idx = i * 4;
    pixels[idx] = r;
    pixels[idx + 1] = g;
    pixels[idx + 2] = b;
    pixels[idx + 3] = 255;
  }

  const tc = document.createElement('canvas');
  tc.width = w;
  tc.height = h;
  const tctx = tc.getContext('2d')!;
  tctx.putImageData(imgData, 0, 0);

  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.save();
  ctx.translate(0, canvas.height);
  ctx.scale((32 * dpr) / w, (-32 * dpr) / h);
  ctx.drawImage(tc, 0, 0);
  ctx.restore();
}

function primeSliceFramesFromPreview(img: VolumeImage): void {
  if (!img.preview) return;
  setCurrentSlice('axial', new Float32Array(img.preview.axial), img.header!.nx, img.header!.ny, 1);
  setCurrentSlice('coronal', new Float32Array(img.preview.coronal), img.header!.nx, img.header!.nz, 1);
  setCurrentSlice('sagittal', new Float32Array(img.preview.sagittal), img.header!.ny, img.header!.nz, 1);
}

async function loadNewImage(url: string, name: string, _gz: boolean, _remote?: boolean, newDirectUrl?: string) {
  // If we already have a displayed image, keep it visible while the new one
  // loads in the background.  Only clear the display when there's nothing to
  // show (first load or previous image failed).
  const hasVisibleImage = volumeData && images.length > 0 && images[0]?.data;

  if (!hasVisibleImage) {
    broadcastToSliceWorkers({ type: 'cancelVolumeLoad', id: 0 });
  }

  fileUrl = url;
  if (newDirectUrl) directUrl = newDirectUrl;
  const targetUrl = directUrl || fileUrl;
  injectPreconnectHint(targetUrl);
  void warmupConnection(targetUrl);
  fileName = name;
  isGzip = !!_gz;
  isRemoteSource = !!_remote;
  fullVolumeLoaded = false;

  if (!hasVisibleImage) {
    volumeData = null;
    currentSlices.axial = null;
    currentSlices.coronal = null;
    currentSlices.sagittal = null;
  }

  pendingAddImageIdx = images.length;
  images.push({
    header: null,
    data: null,
    min: 0,
    max: 1,
    name,
    url,
    directUrl: directUrl,
    slope: 1,
    inter: 0,
    colormap: colormap,
    state: 'loading',
    lastAccess: Date.now(),
  });
  updateImagePicker();
}

const interactionHost: InteractionHost = {
  get header() {
    return header;
  },
  get images() {
    return images;
  },
  get sliceIdx() {
    return sliceIdx;
  },
  get viewState() {
    return viewState;
  },
  get measurements() {
    return measurements;
  },
  get canvases() {
    return canvases;
  },
  get viewFlips() {
    return viewFlips;
  },
  get currentSlices() {
    return currentSlices;
  },
  get volumeData() {
    return volumeData;
  },
  get dataSlope() {
    return dataSlope;
  },
  get dataInter() {
    return dataInter;
  },
  get perfProfile() {
    return perfProfile;
  },
  get sliceRenderCache() {
    return sliceRenderCache;
  },
  get registration() {
    return registration;
  },
  get compareRenderer() {
    return compareRenderer;
  },
  get maximizedView() {
    return maximizedView;
  },
  get mipIdentity() {
    return MIP_IDENTITY;
  },
  get interactionInitialized() {
    return interactionInitialized;
  },
  set interactionInitialized(v) {
    interactionInitialized = v;
  },
  get windowWidth() {
    return windowWidth;
  },
  set windowWidth(v) {
    windowWidth = v;
  },
  get windowLevel() {
    return windowLevel;
  },
  set windowLevel(v) {
    windowLevel = v;
  },
  get colormap() {
    return colormap;
  },
  set colormap(v) {
    colormap = v;
  },
  get compareMode() {
    return compareMode;
  },
  set compareMode(v) {
    compareMode = v;
  },
  get compareLayout() {
    return compareLayout;
  },
  set compareLayout(v) {
    compareLayout = v;
  },
  get compareIdxA() {
    return compareIdxA;
  },
  set compareIdxA(v) {
    compareIdxA = v;
  },
  get compareIdxB() {
    return compareIdxB;
  },
  set compareIdxB(v) {
    compareIdxB = v;
  },
  get overlayOpacity() {
    return overlayOpacity;
  },
  set overlayOpacity(v) {
    overlayOpacity = v;
  },
  get crosshairVisible() {
    return crosshairVisible;
  },
  set crosshairVisible(v) {
    crosshairVisible = v;
  },
  get measureMode() {
    return measureMode;
  },
  set measureMode(v) {
    measureMode = v;
  },
  get measureDragStart() {
    return measureDragStart;
  },
  set measureDragStart(v) {
    measureDragStart = v;
  },
  get measureClickPending() {
    return measureClickPending;
  },
  set measureClickPending(v) {
    measureClickPending = v;
  },
  get activeImageIdx() {
    return activeImageIdx;
  },
  set activeImageIdx(v) {
    activeImageIdx = v;
  },
  get timeIdx() {
    return timeIdx;
  },
  set timeIdx(v) {
    timeIdx = v;
  },
  get headerPanelVisible() {
    return headerPanelVisible;
  },
  set headerPanelVisible(v) {
    headerPanelVisible = v;
  },
  get sidebarCollapsed() {
    return sidebarCollapsed;
  },
  set sidebarCollapsed(v) {
    sidebarCollapsed = v;
  },
  get sidebarWidth() {
    return sidebarWidth;
  },
  set sidebarWidth(v) {
    sidebarWidth = v;
  },
  get highContrastPreferred() {
    return highContrastPreferred;
  },
  set highContrastPreferred(v) {
    highContrastPreferred = v;
  },
  get focusedCanvas() {
    return focusedCanvas;
  },
  set focusedCanvas(v) {
    focusedCanvas = v;
  },
  get mipInitialized() {
    return mipInitialized;
  },
  set mipInitialized(v) {
    mipInitialized = v;
  },
  get activeLoadDebounceTimer() {
    return activeLoadDebounceTimer;
  },
  set activeLoadDebounceTimer(v) {
    activeLoadDebounceTimer = v;
  },
  get scheduledActiveIndex() {
    return scheduledActiveIndex;
  },
  set scheduledActiveIndex(v) {
    scheduledActiveIndex = v;
  },
  postMessage(message: unknown) {
    vscode.postMessage(message);
  },
  initTooltipSystem,
  initWasmBindings,
  showToast,
  renderAllViews,
  validateWindowLevel,
  a11yAnnounce,
  renderColormapPreview,
  autoContrast,
  resetViews,
  ensureImageData,
  cmpImg,
  updateImagePicker,
  updateFileInfo,
  updateSliderValues,
  applyImageState,
  updateCoordInfoFromCenter,
  clearMeasurements,
  updateHeaderPanel,
  toggleMaximize,
  validateSliceIndex,
  onUserScrollSlices,
  scheduleSingleViewRender,
  volumeHasTimepoint,
  refreshSlices,
  scheduleLODUpgrade,
  computeRoiArea,
  computeLineDistance,
  updateSingleView,
  getAxisGeometry,
  paintMIP,
  scheduleMIPRender,
  setupVolumeInteraction,
  handleKeyboardAction,
  drawMeasurements,
  computeFlipsForHeader,
  voxelToWorld,
  worldToVoxel,
  rotAxisAngle,
  mul3,
};

// Tooltip system: data-tip based, inspired by Project_Manager
function setupInteraction() {
  setupInteractionImpl(interactionHost);
}

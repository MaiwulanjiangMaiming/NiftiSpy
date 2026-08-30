import { gunzip } from 'fflate';
import { parseNiiHeader, type NiiHeader } from './nii-parser';
import { getCachedChunk, setCachedChunk, makeCacheKey, recordCacheHit, recordCacheMiss, recordL4Fetch } from './cache';
import { SliceCacheDB, deriveFileHash, makeSliceCacheKey, getSliceCacheDB } from './SliceCacheDB';
import { initWasmBindings, getWasmBindings, type WasmBindings } from './wasmBridge';

// Initialize WASM SIMD module (async, non-blocking)
let wasmReady = false;
initWasmBindings().then(bindings => {
  wasmReady = !!bindings;
  if (wasmReady) {
    console.log('[Worker] WASM SIMD acceleration enabled');
  }
}).catch(() => {
  console.log('[Worker] WASM SIMD not available, using JS fallback');
});

const MAX_RETRIES = 3;
const CHUNK_SIZE = 16 * 1024 * 1024;
const RETRY_DELAY_BASE = 500;
const MAX_SLICE_CACHE = 96;
const LOCALHOST_CHUNK_SIZE = 128 * 1024 * 1024;  // 128MB for loopback (no network latency)
const LOCALHOST_MAX_CONCURRENT = 16;
const REMOTE_MAX_CONCURRENT = 16;
type SliceAxis = 'axial' | 'coronal' | 'sagittal';
const volumeControllers = new Map<number, AbortController>();
const pendingSliceFetches = new Map<string, Promise<CachedSlice>>();
const headCache = new Map<string, { totalSize: number; acceptRanges: boolean }>();
// Track which volume IDs have already received an early preview
const earlyPreviewSent = new Set<number>();
const earlyPreviewHeaders = new Map<number, NiiHeader>();  // cache header from early preview

interface CachedSlice {
  data: Float32Array;
  width: number;
  height: number;
  timestamp: number;
}

const sliceCache = new Map<string, CachedSlice>();

// SliceCacheDB — persistent IndexedDB disk cache
const sliceCacheDB = getSliceCacheDB();
let sliceCacheDBReady = false;
async function ensureSliceCacheDB(): Promise<SliceCacheDB> {
  if (!sliceCacheDBReady) {
    await sliceCacheDB.init();
    sliceCacheDBReady = true;
  }
  return sliceCacheDB;
}

// Track file hash for cache key generation
let currentFileHash = '';
function setFileHashForCache(fileName: string, fileSize: number): void {
  currentFileHash = deriveFileHash(fileName, fileSize);
}

let sharedVolume: { buffer: SharedArrayBuffer; nx: number; ny: number; nz: number; slope: number; inter: number; datatype: number } | null = null;

self.onmessage = async (e: MessageEvent) => {
  const { id, type, url, isGzip, directUrl } = e.data;
  try {
    if (type === 'loadVolume') {
      const { estimatedBps = 0, estimatedRttMs = 0 } = e.data;
      await handleLoadVolume(id, url, isGzip, directUrl, estimatedBps, estimatedRttMs);
    } else if (type === 'loadVolumeFromData') {
      await handleLoadVolumeFromData(id, e.data);
    } else if (type === 'cancelVolumeLoad') {
      cancelVolumeLoad(id);
    } else if (type === 'fetchSlice') {
      await handleFetchSlice(e.data);
    } else if (type === 'sharedVolume') {
      sharedVolume = {
        buffer: e.data.buffer as SharedArrayBuffer,
        nx: e.data.nx,
        ny: e.data.ny,
        nz: e.data.nz,
        slope: e.data.slope ?? 1,
        inter: e.data.inter ?? 0,
        datatype: e.data.datatype ?? 16,
      };
    } else if (type === 'setFileHash') {
      setFileHashForCache(e.data.fileName || '', e.data.fileSize || 0);
    } else if (type === 'invalidateCache') {
      await handleInvalidateCache(e.data);
    } else if (type === 'getCacheStats') {
      await handleGetCacheStats(id);
    }
  } catch (err: any) {
    if (err?.name === 'AbortError') {
      self.postMessage({ id, type: 'cancelled' });
    } else {
      self.postMessage({ id, type: 'error', error: String(err?.message ?? err) });
    }
  }
};

// Track validation tokens per file hash for cache invalidation
const validationTokens = new Map<string, string>();

async function handleGetCacheStats(id: number): Promise<void> {
  try {
    const db = await ensureSliceCacheDB();
    const stats = db.getStats();
    const cacheSize = await db.cacheSize();
    const cacheEntries = await db.cacheEntries();
    self.postMessage({
      id,
      type: 'cacheStats',
      cacheHits: stats.cacheHits,
      cacheMisses: stats.cacheMisses,
      cacheSize,
      cacheEntries,
    });
  } catch {
    self.postMessage({
      id,
      type: 'cacheStats',
      cacheHits: 0,
      cacheMisses: 0,
      cacheSize: 0,
      cacheEntries: 0,
    });
  }
}

async function handleInvalidateCache(data: { fileName?: string; fileSize?: number; validationToken?: string }): Promise<void> {
  try {
    if (data.fileName && data.fileSize !== undefined) {
      const fileHash = deriveFileHash(data.fileName, data.fileSize);
      const prevToken = validationTokens.get(fileHash);
      const newToken = data.validationToken || '';

      // If validation token changed, invalidate all cached slices for this file
      if (newToken && prevToken && prevToken !== newToken) {
        const db = await ensureSliceCacheDB();
        await db.invalidateByPrefix(fileHash);
      }

      // Update stored token
      if (newToken) {
        validationTokens.set(fileHash, newToken);
      }
    }
  } catch {
    // Invalidation failure is non-critical
  }
}

function abortError(): Error {
  const err = new Error('Aborted');
  err.name = 'AbortError';
  return err;
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw abortError();
}

function cancelVolumeLoad(id: number): void {
  const controller = volumeControllers.get(id);
  controller?.abort();
  volumeControllers.delete(id);
}

const VOLUME_BUFFER_HEADER_BYTES = 8;

function createVolumeView(buffer: SharedArrayBuffer, datatype: number, length: number): Int8Array | Uint8Array | Int16Array | Uint16Array | Int32Array | Uint32Array | Float32Array | Float64Array {
  const byteOffset = VOLUME_BUFFER_HEADER_BYTES;
  switch (datatype) {
    case 2: return new Uint8Array(buffer, byteOffset, length);
    case 4: return new Int16Array(buffer, byteOffset, length);
    case 8: return new Int32Array(buffer, byteOffset, length);
    case 16: return new Float32Array(buffer, byteOffset, length);
    case 64: return new Float64Array(buffer, byteOffset, length);
    case 256: return new Int8Array(buffer, byteOffset, length);
    case 512: return new Uint16Array(buffer, byteOffset, length);
    case 768: return new Uint32Array(buffer, byteOffset, length);
    default: return new Float32Array(buffer, byteOffset, length);
  }
}

async function fetchWithRetry(url: string, options?: RequestInit, retries: number = MAX_RETRIES, signal?: AbortSignal): Promise<Response> {
  let lastErr: Error | null = null;
  for (let attempt = 0; attempt < retries; attempt++) {
    throwIfAborted(signal);
    try {
      // Headers phase is watchdog-protected: a frozen VPN never rejects the
      // fetch promise, so without this every caller could hang at TTFB.
      // TimeoutError lands in the retry path below (it is not an AbortError).
      const resp = await fetchHeadersWatchdog(url, options || {}, DEFAULT_IDLE_TIMEOUT_MS, signal);
      if (resp.ok || resp.status === 206) return resp;
      const shouldRetryStatus = resp.status === 408 || resp.status === 425 || resp.status === 429 || resp.status >= 500;
      if (shouldRetryStatus && attempt < retries - 1) {
        await sleep(RETRY_DELAY_BASE * Math.pow(2, attempt));
        continue;
      }
      return resp;
    } catch (err: any) {
      lastErr = err;
      if (err?.name === 'AbortError') throw err;
      if (attempt < retries - 1) {
        await sleep(RETRY_DELAY_BASE * Math.pow(2, attempt));
      }
    }
  }
  throw lastErr || new Error('Fetch failed after retries');
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// Idle watchdog (slow/stalled-link protection)
//
// A VPN that "freezes" (silent packet loss, tunnel renegotiation) never
// errors the fetch — it just stops delivering bytes, hanging a chunk fetch
// for 15+ minutes. A pure total-duration timeout cannot distinguish
// "slow but flowing" from "dead", so on slow links it would kill healthy
// transfers and trigger retry storms. The idle watchdog instead aborts only
// when NO bytes arrived for `idleMs` — a flowing transfer is never killed,
// a silent one dies within seconds.
// ---------------------------------------------------------------------------

const DEFAULT_IDLE_TIMEOUT_MS = 20000;

function clampIdleTimeout(rttMs: number): number {
  return Math.min(30000, Math.max(5000, rttMs * 8));
}

function makeIdleError(): DOMException {
  return new DOMException('idle timeout', 'TimeoutError');
}

/**
 * One reader.read() bounded by `idleMs` of silence. Rejects with
 * TimeoutError when the stream produces no chunk in time. Used by both
 * readBodyWithWatchdog (whole-body aggregation) and the streaming loaders
 * (incremental parse loops that cannot aggregate).
 */
async function readStreamChunkWithWatchdog(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  idleMs: number,
): Promise<ReadableStreamReadResult<Uint8Array>> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(makeIdleError()), idleMs);
  });
  try {
    return await Promise.race([reader.read(), timeoutPromise]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Read a Response body with a resettable idle watchdog: every successful
 * read() resets the timer. Rejects with TimeoutError when the stream goes
 * silent for `idleMs`. External AbortSignal still wins (AbortError).
 * `onProgress` receives the cumulative byte count after each chunk.
 */
async function readBodyWithWatchdog(
  resp: Response,
  idleMs: number,
  signal?: AbortSignal,
  onProgress?: (received: number) => void,
): Promise<Uint8Array> {
  if (!resp.body) return new Uint8Array(await resp.arrayBuffer());
  const reader = resp.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    throwIfAborted(signal);
    let result: ReadableStreamReadResult<Uint8Array>;
    try {
      result = await readStreamChunkWithWatchdog(reader, idleMs);
    } catch (err) {
      try { await reader.cancel(); } catch { /* stream already gone */ }
      throw err;
    }
    if (result.done) break;
    chunks.push(result.value);
    total += result.value.byteLength;
    onProgress?.(total);
  }
  if (chunks.length === 1) return chunks[0];
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) { out.set(c, off); off += c.byteLength; }
  return out;
}

/**
 * Fetch with the HEADERS phase (TTFB) bounded by `idleMs` of silence.
 * Accepts a full RequestInit (method/headers/body all forwarded); any
 * signal inside init is superseded by the watchdog controller, which
 * itself bridges the external `signal`. Returns the raw Response — body
 * reading stays the caller's job (usually via readBodyWithWatchdog).
 * TimeoutError is thrown so callers can retry; AbortError propagates.
 * Needed because a frozen VPN never errors the fetch promise, it just
 * never resolves it.
 */
async function fetchHeadersWatchdog(
  url: string,
  init: RequestInit,
  idleMs: number,
  signal?: AbortSignal,
): Promise<Response> {
  let timedOut = false;
  const ctrl = new AbortController();
  const onExternalAbort = () => ctrl.abort(signal!.reason);
  signal?.addEventListener('abort', onExternalAbort, { once: true });
  const timer = setTimeout(() => {
    timedOut = true;
    ctrl.abort(makeIdleError());
  }, idleMs);

  try {
    return await fetch(url, { ...init, signal: ctrl.signal });
  } catch (err: any) {
    if (timedOut) throw makeIdleError();
    throw err;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onExternalAbort);
  }
}

/**
 * Fetch one range with full idle-watchdog protection: the headers phase
 * (TTFB) and every body read are each bounded by `idleMs` of silence.
 * TimeoutError is thrown so callers can retry; AbortError propagates.
 */
async function fetchRangeWatchdog(
  url: string,
  headers: Record<string, string>,
  idleMs: number,
  signal?: AbortSignal,
): Promise<Uint8Array> {
  const resp = await fetchHeadersWatchdog(url, { headers }, idleMs, signal);

  if (!resp.ok) {
    try { await resp.body?.cancel(); } catch { /* ignore */ }
    throw new Error(`HTTP ${resp.status}`);
  }
  return readBodyWithWatchdog(resp, idleMs, signal);
}

/**
 * fetchRangeWatchdog + retry with backoff. TimeoutError and network errors
 * are retryable; AbortError (user cancel) propagates immediately.
 */
async function fetchRangeBytesWithRetry(
  url: string,
  start: number,
  end: number,
  idleMs: number,
  signal?: AbortSignal,
  retries: number = MAX_RETRIES,
): Promise<Uint8Array> {
  let lastErr: Error | null = null;
  for (let attempt = 0; attempt < retries; attempt++) {
    throwIfAborted(signal);
    try {
      return await fetchRangeWatchdog(url, { Range: `bytes=${start}-${end}` }, idleMs, signal);
    } catch (err: any) {
      if (err?.name === 'AbortError') throw err;
      lastErr = err;
      if (attempt < retries - 1) {
        await sleep(RETRY_DELAY_BASE * Math.pow(2, attempt));
      }
    }
  }
  throw lastErr || new Error('Range fetch failed after retries');
}

function getSliceCacheKey(url: string, axis: SliceAxis, index: number, factor: number): string {
  return `${url}|${axis}|${index}|${factor}`;
}

function getCachedSlice(url: string, axis: SliceAxis, index: number, factor: number): CachedSlice | null {
  const key = getSliceCacheKey(url, axis, index, factor);
  const cached = sliceCache.get(key);
  if (!cached) return null;
  sliceCache.delete(key);
  sliceCache.set(key, { ...cached, timestamp: Date.now() });
  return cached;
}

function setCachedSlice(url: string, axis: SliceAxis, index: number, factor: number, slice: CachedSlice): void {
  const key = getSliceCacheKey(url, axis, index, factor);
  sliceCache.delete(key);
  sliceCache.set(key, slice);
  while (sliceCache.size > MAX_SLICE_CACHE) {
    const firstKey = sliceCache.keys().next().value;
    if (!firstKey) break;
    sliceCache.delete(firstKey);
  }
}

function buildSliceUrl(url: string, axis: SliceAxis, index: number, factor: number): string {
  const sliceUrl = new URL(url.replace('/file/', '/slice/') + `/${axis}/${index}`);
  if (factor > 1) sliceUrl.searchParams.set('factor', String(factor));
  return sliceUrl.toString();
}

function getPreferredChunkSize(url: string): number {
  if (url.includes('127.0.0.1')) return LOCALHOST_CHUNK_SIZE;
  return CHUNK_SIZE;
}

function getPreferredConcurrency(url: string): number {
  if (url.includes('127.0.0.1')) return LOCALHOST_MAX_CONCURRENT;
  return REMOTE_MAX_CONCURRENT;
}

async function fetchSlice(url: string, axis: SliceAxis, index: number, factor: number, signal?: AbortSignal): Promise<CachedSlice> {
  const cached = getCachedSlice(url, axis, index, factor);
  if (cached) return cached;
  const cacheKey = getSliceCacheKey(url, axis, index, factor);
  const pending = pendingSliceFetches.get(cacheKey);
  if (pending) return pending;

  const request = (async () => {
    // Check new SliceCacheDB first (primary L3 disk cache)
    if (currentFileHash) {
      try {
        const db = await ensureSliceCacheDB();
        const dbKey = makeSliceCacheKey(currentFileHash, axis, index);
        const dbData = await db.get(dbKey);
        if (dbData) {
          recordCacheHit('l3');
          const data = new Float32Array(dbData);
          const slice: CachedSlice = { data, width: 0, height: 0, timestamp: Date.now() };
          setCachedSlice(url, axis, index, factor, slice);
          return slice;
        }
      } catch {
        // SliceCacheDB not available; fall through
      }
    }

    // Fall back to legacy IndexedDB cache
    const idbKey = makeCacheKey(url, axis, index);
    const idbData = await getCachedChunk(idbKey);
    if (idbData) {
      recordCacheHit('l3');
      const data = new Float32Array(idbData);
      const slice: CachedSlice = { data, width: 0, height: 0, timestamp: Date.now() };
      setCachedSlice(url, axis, index, factor, slice);
      return slice;
    }
    recordCacheMiss('l3');

    const startedAt = performance.now();
    recordL4Fetch();
    if (signal?.aborted) throw abortError();
    const resp = await fetchWithRetry(buildSliceUrl(url, axis, index, factor), undefined, MAX_RETRIES, signal);
    if (!resp.ok) {
      throw new Error(`Slice fetch failed: ${resp.status}`);
    }

    const width = Number(resp.headers.get('X-Width') || 0);
    const height = Number(resp.headers.get('X-Height') || 0);
    const buffer = await resp.arrayBuffer();
    const data = new Float32Array(buffer);
    const slice: CachedSlice = {
      data,
      width,
      height,
      timestamp: Date.now(),
    };
    setCachedSlice(url, axis, index, factor, slice);

    // Store in new SliceCacheDB (primary)
    if (currentFileHash) {
      const db = await ensureSliceCacheDB();
      const dbKey = makeSliceCacheKey(currentFileHash, axis, index);
      db.put(dbKey, buffer).catch(() => {});
      // Background eviction
      db.evictLRU().catch(() => {});
    }

    // Also store in legacy cache for backward compatibility
    setCachedChunk(idbKey, buffer).catch(() => {});

    self.postMessage({
      id: -1,
      type: 'bandwidthSample',
      bytes: buffer.byteLength,
      durationMs: performance.now() - startedAt,
    });
    return slice;
  })().finally(() => {
    pendingSliceFetches.delete(cacheKey);
  });
  pendingSliceFetches.set(cacheKey, request);
  return request;
}

async function handleFetchSlice(message: {
  id: number;
  url: string;
  axis: SliceAxis;
  index: number;
  factor?: number;
  prefetch?: number;
  maxIndex?: number;
  signal?: AbortSignal;
}): Promise<void> {
  const factor = Math.max(1, message.factor || 1);

  if (sharedVolume && factor === 1) {
    const { buffer, nx, ny, nz, slope, inter, datatype } = sharedVolume;
    const data = createVolumeView(buffer, datatype, nx * ny * nz);
    const idx = message.index;
    let sliceData: Float32Array;
    let w: number, h: number;

    if (message.axis === 'axial') {
      w = nx; h = ny;
      sliceData = new Float32Array(nx * ny);
      const base = idx * ny * nx;
      for (let i = 0; i < nx * ny; i++) {
        sliceData[i] = data[base + i] * slope + inter;
      }
    } else if (message.axis === 'coronal') {
      w = nx; h = nz;
      sliceData = new Float32Array(nx * nz);
      for (let z = 0; z < nz; z++) {
        const base = z * ny * nx + idx * nx;
        for (let x = 0; x < nx; x++) {
          sliceData[z * nx + x] = data[base + x] * slope + inter;
        }
      }
    } else {
      w = ny; h = nz;
      sliceData = new Float32Array(ny * nz);
      for (let z = 0; z < nz; z++) {
        const base = z * ny * nx;
        for (let y = 0; y < ny; y++) {
          sliceData[z * ny + y] = data[base + y * nx + idx] * slope + inter;
        }
      }
    }

    self.postMessage({
      id: message.id,
      type: 'slice',
      axis: message.axis,
      index: message.index,
      factor,
      width: w,
      height: h,
      data: sliceData,
    }, [sliceData.buffer]);
    return;
  }

  const slice = await fetchSlice(message.url, message.axis, message.index, factor, message.signal);
  // Transfer the buffer directly instead of copying — the cache entry
  // becomes invalid after transfer, so remove it from the cache.
  const payload = slice.data;
  const cacheKey = getSliceCacheKey(message.url, message.axis, message.index, factor);
  sliceCache.delete(cacheKey);
  self.postMessage({
    id: message.id,
    type: 'slice',
    axis: message.axis,
    index: message.index,
    factor,
    width: slice.width,
    height: slice.height,
    data: payload,
  }, [payload.buffer]);

  const prefetch = Math.max(0, message.prefetch || 0);
  const maxIndex = Math.max(0, message.maxIndex || 0);
  if (prefetch === 0) return;

  for (let delta = 1; delta <= prefetch; delta++) {
    for (const nextIndex of [message.index - delta, message.index + delta]) {
      if (nextIndex < 0 || nextIndex > maxIndex) continue;
      if (getCachedSlice(message.url, message.axis, nextIndex, factor)) continue;
      void fetchSlice(message.url, message.axis, nextIndex, factor, message.signal).catch(() => {});
    }
  }
}

/**
 * Stream-decompress a gzip response and emit a preview as soon as enough data
 * is available (header + middle axial slice), then continue decompressing the
 * rest of the volume.  This cuts the "time-to-first-preview" from the full
 * download+decompress cycle to just the time needed for ~50% of the data.
 */
async function nativeDecompressWithEarlyPreview(
  resp: Response,
  id: number,
  signal: AbortSignal,
  isGzip: boolean,
): Promise<Uint8Array> {
  const ds = new (self as any).DecompressionStream('gzip');
  const decompressedStream = resp.body!.pipeThrough(ds);
  const reader = decompressedStream.getReader() as ReadableStreamDefaultReader<Uint8Array>;

  // Collect decompressed chunks; try to parse header & send preview early
  const chunks: Uint8Array[] = [];
  let totalSize = 0;
  let previewSent = false;

  // Pre-allocate if Content-Length is known (decompressed size)
  const declaredLength = Number(resp.headers.get('Content-Length') || 0);
  let preAlloc: Uint8Array | null = declaredLength > 0 ? new Uint8Array(declaredLength) : null;
  let writeOffset = 0;

  // Incremental contiguous buffer for early preview — avoids O(n²) chunk
  // concatenation on every iteration. Grows geometrically like a vector.
  let previewBuf: Uint8Array | null = null;
  let previewBufLen = 0;

  while (true) {
    throwIfAborted(signal);
    // Watchdog: the decompressed stream is network-fed — a stalled tunnel
    // must surface as TimeoutError instead of an eternal pending read().
    const { done, value } = await readStreamChunkWithWatchdog(reader, DEFAULT_IDLE_TIMEOUT_MS);
    if (done) break;

    const chunk = value!;

    if (preAlloc) {
      if (writeOffset + chunk.byteLength <= preAlloc.length) {
        preAlloc.set(chunk, writeOffset);
        writeOffset += chunk.byteLength;
      } else {
        // Overflow — fall back to chunk collection
        chunks.push(preAlloc.slice(0, writeOffset));
        chunks.push(chunk);
        preAlloc = null;
      }
    }
    if (!preAlloc) {
      chunks.push(chunk);
    }
    totalSize += chunk.byteLength;

    // Maintain incremental contiguous buffer for early preview parsing
    if (!previewSent) {
      if (!previewBuf) {
        previewBuf = new Uint8Array(Math.max(chunk.byteLength * 4, 1 << 20));
      }
      while (previewBufLen + chunk.byteLength > previewBuf!.length) {
        const grown: Uint8Array = new Uint8Array(previewBuf!.length * 2);
        grown.set(previewBuf!.subarray(0, previewBufLen), 0);
        previewBuf = grown;
      }
      previewBuf!.set(chunk, previewBufLen);
      previewBufLen += chunk.byteLength;
    }

    // ── Early preview: try once we have enough decompressed data ──
    if (!previewSent && previewBufLen >= 544) {
      try {
        const buf = previewBuf!.subarray(0, previewBufLen);

        const header = parseNiiHeader(buf.buffer as ArrayBuffer, isGzip);
        const { nx, ny, nz, voxOffset, bytesPerVoxel, scl_slope, scl_inter, littleEndian, datatype } = header;
        // Use z=0 slice for instant preview (right after header, ~0% of data)
        // instead of center slice which requires ~45% of data to be decompressed
        const firstSliceNeeded = voxOffset + nx * ny * bytesPerVoxel;

        if (previewBufLen >= firstSliceNeeded) {
          // We have enough data to extract the first axial slice
          const slope = scl_slope || 1;
          const inter = scl_inter || 0;
          const le = littleEndian;
          const needsConversion = slope !== 1 || inter !== 0;
          const elemSize = datatype === 64 ? 8 : datatype === 8 || datatype === 16 || datatype === 768 ? 4 : datatype === 4 || datatype === 512 ? 2 : 1;

          // Extract z=0 axial preview slice (instant — right after header)
          const sliceStart = voxOffset;
          const sliceEnd = voxOffset + nx * ny * bytesPerVoxel;
          const axialSlice = new Float32Array(nx * ny);
          const sliceView = new DataView(buf.buffer, buf.byteOffset + sliceStart, nx * ny * bytesPerVoxel);
          const byteOff = buf.byteOffset + sliceStart;
          const canUseTA = (byteOff % elemSize === 0) && le;

          if (canUseTA && datatype === 16 && !needsConversion) {
            axialSlice.set(new Float32Array(buf.buffer, byteOff, nx * ny));
          } else if (canUseTA && datatype === 16 && needsConversion) {
            const src = new Float32Array(buf.buffer, byteOff, nx * ny);
            for (let i = 0; i < nx * ny; i++) axialSlice[i] = src[i] * slope + inter;
          } else {
            for (let i = 0; i < nx * ny; i++) {
              let val: number;
              switch (datatype) {
                case 2: val = buf[buf.byteOffset + sliceStart + i]; break;
                case 4: val = sliceView.getInt16(i * 2, le); break;
                case 8: val = sliceView.getInt32(i * 4, le); break;
                case 16: val = sliceView.getFloat32(i * 4, le); break;
                case 64: val = sliceView.getFloat64(i * 8, le); break;
                case 256: val = (buf[buf.byteOffset + sliceStart + i] << 24) >> 24; break;
                case 512: val = sliceView.getUint16(i * 2, le); break;
                case 768: val = sliceView.getUint32(i * 4, le); break;
                default: val = 0;
              }
              axialSlice[i] = val * slope + inter;
            }
          }

          // Quick min/max from preview slice
          let min = Infinity, max = -Infinity;
          for (let i = 0; i < axialSlice.length; i++) {
            if (axialSlice[i] < min) min = axialSlice[i];
            if (axialSlice[i] > max) max = axialSlice[i];
          }
          if (min === max) max = min + 1;

          const coMid = Math.floor(ny / 2);
          const saMid = Math.floor(nx / 2);

          self.postMessage({
            id, type: 'preview',
            partialPreview: true,
            header,
            slices: {
              axial: axialSlice,
              coronal: new Float32Array(0),  // placeholder — GPU will render
              sagittal: new Float32Array(0), // placeholder — GPU will render
            },
            globalMin: min, globalMax: max,
            sliceIdx: { axial: 0, coronal: coMid, sagittal: saMid },
            slope, inter,
          }, [axialSlice.buffer]);

          previewSent = true;
          earlyPreviewSent.add(id);
          previewBuf = null;  // Release preview buffer memory
          self.postMessage({ id, type: 'progress', value: 0.5, stage: 'decompressing (native)' });
        }
      } catch {
        // Header not parseable yet — continue streaming
      }
    }

    // Progress updates
    if (!previewSent) {
      self.postMessage({ id, type: 'progress', value: 0.1 + (totalSize / (declaredLength || totalSize * 2)) * 0.2, stage: 'decompressing (native)' });
    } else {
      self.postMessage({ id, type: 'progress', value: 0.5 + (totalSize / (declaredLength || totalSize * 2)) * 0.2, stage: 'decompressing (native)' });
    }
  }

  // Assemble final result
  if (preAlloc) {
    if (writeOffset !== declaredLength) return preAlloc.slice(0, writeOffset);
    return preAlloc;
  }

  const result = new Uint8Array(totalSize);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}

async function nativeDecompress(resp: Response, signal?: AbortSignal): Promise<Uint8Array> {
  const ds = new (self as any).DecompressionStream('gzip');
  const decompressedStream = resp.body!.pipeThrough(ds);

  // Try to pre-allocate from Content-Length if available
  const declaredLength = Number(resp.headers.get('Content-Length') || 0);
  let result: Uint8Array | null = null;
  let writeOffset = 0;

  if (declaredLength > 0) {
    result = new Uint8Array(declaredLength);
  }

  const reader = decompressedStream.getReader() as ReadableStreamDefaultReader<Uint8Array>;
  const chunks: Uint8Array[] = [];
  let totalSize = 0;

  while (true) {
    throwIfAborted(signal);
    // Watchdog: network-fed decompressed stream — a stalled tunnel must
    // surface as TimeoutError instead of an eternal pending read().
    const { done, value } = await readStreamChunkWithWatchdog(reader, DEFAULT_IDLE_TIMEOUT_MS);
    if (done) break;
    if (result) {
      // Write directly into pre-allocated buffer
      result.set(value!, writeOffset);
      writeOffset += value!.byteLength;
    } else {
      chunks.push(value!);
      totalSize += value!.byteLength;
    }
  }

  if (result) {
    // Trim if actual size differs from declared
    if (writeOffset !== declaredLength) {
      return result.slice(0, writeOffset);
    }
    return result;
  }

  // Fallback: concatenate collected chunks
  result = new Uint8Array(totalSize);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}

async function downloadChunked(url: string, id: number, isGzip: boolean, signal?: AbortSignal): Promise<Uint8Array> {
  const chunkSize = getPreferredChunkSize(url);
  const MAX_CONCURRENT = getPreferredConcurrency(url);
  let totalSize = 0;
  let acceptRanges = false;
  const cached = headCache.get(url);
  if (cached) {
    totalSize = cached.totalSize;
    acceptRanges = cached.acceptRanges;
  } else {
    try {
      // For localhost proxy, HEAD is fast (no remote round-trip).
      // For remote URLs, HEAD may fail or be slow — skip if it times out.
      const headResp = await fetchWithRetry(url, { method: 'HEAD' }, MAX_RETRIES, signal);
      if (headResp.ok) {
        totalSize = Number(headResp.headers.get('Content-Length') || 0);
        acceptRanges = headResp.headers.get('Accept-Ranges') === 'bytes';
        headCache.set(url, { totalSize, acceptRanges });
      }
    } catch (err: any) {
      if (err?.name === 'AbortError') throw err;
      // HEAD failed — will fall through to single GET
    }
  }

  if (totalSize > 0 && acceptRanges && totalSize > chunkSize) {
    // Calculate all chunk ranges upfront
    const ranges: { offset: number; end: number }[] = [];
    let offset = 0;
    while (offset < totalSize) {
      const end = Math.min(offset + chunkSize - 1, totalSize - 1);
      ranges.push({ offset, end });
      offset = end + 1;
    }

    // Pre-allocate result buffer and write chunks directly at correct positions
    const result = new Uint8Array(totalSize);
    let received = 0;

    // Semaphore-based parallel download pool
    let running = 0;
    let nextIdx = 0;
    let poolError: Error | null = null;

    await new Promise<void>((resolve, reject) => {
      const tryLaunch = (): void => {
        while (running < MAX_CONCURRENT && nextIdx < ranges.length && !poolError) {
          const idx = nextIdx++;
          const { offset: off, end } = ranges[idx];
          running++;

          (async () => {
            try {
              throwIfAborted(signal);
              // Watchdog-protected range fetch: chunk-level TimeoutError is
              // retried internally, so a frozen VPN fails fast per chunk
              // instead of hanging one of the pool slots forever.
              const chunkData = await fetchRangeBytesWithRetry(url, off, end, DEFAULT_IDLE_TIMEOUT_MS, signal);
              result.set(chunkData, off);
              received += chunkData.byteLength;
              const progressBase = 0.02;
              const progressRange = isGzip ? 0.3 : 0.7;
              self.postMessage({
                id, type: 'progress',
                value: progressBase + (received / totalSize) * progressRange,
                stage: 'downloading',
              });
            } catch (err: any) {
              if (err?.name === 'AbortError') { poolError = err; }
              else { poolError = err; }
            }

            running--;
            if (poolError) {
              reject(poolError);
              return;
            }
            if (nextIdx >= ranges.length && running === 0) {
              resolve();
            } else {
              tryLaunch();
            }
          })();
        }
        // Edge case: no ranges to download
        if (ranges.length === 0) resolve();
      };

      tryLaunch();
    });

    return result;
  }

  const resp = await fetchWithRetry(url, undefined, MAX_RETRIES, signal);
  if (!resp.ok) throw new Error(`Fetch failed: ${resp.status}`);

  const contentLength = Number(resp.headers.get('Content-Length') || 0);

  // Whole-body read with idle watchdog + progress reporting: a server that
  // stalls mid-stream fails with TimeoutError instead of hanging forever.
  return readBodyWithWatchdog(resp, DEFAULT_IDLE_TIMEOUT_MS, signal, (received) => {
    if (contentLength > 0) {
      self.postMessage({
        id, type: 'progress',
        value: 0.02 + (received / contentLength) * (isGzip ? 0.3 : 0.7),
        stage: 'downloading',
      });
    }
  });
}

async function processRawVolume(rawData: Uint8Array, id: number, signal: AbortSignal, isGzip: boolean, preParsedHeader?: NiiHeader): Promise<void> {
  const header = preParsedHeader || parseNiiHeader(rawData.buffer as ArrayBuffer, isGzip);

  const { nx, ny, nz, datatype, scl_slope, scl_inter, littleEndian, voxOffset } = header;
  const n = nx * ny * nz;
  const dataOffset = voxOffset;
  const byteOff = rawData.byteOffset + dataOffset;
  const le = littleEndian;
  const slope = scl_slope || 1;
  const inter = scl_inter || 0;
  const elemSize = datatype === 64 ? 8 : datatype === 8 || datatype === 16 || datatype === 768 ? 4 : datatype === 4 || datatype === 512 ? 2 : 1;
  const canUseTypedArray = (byteOff % elemSize === 0) && (byteOff + n * elemSize <= rawData.buffer.byteLength) && le;

  let nativeData: Int8Array | Uint8Array | Int16Array | Uint16Array | Int32Array | Uint32Array | Float32Array | Float64Array;

  switch (datatype) {
  case 2: nativeData = canUseTypedArray ? new Uint8Array(rawData.buffer, byteOff, n) : new Uint8Array(n); break;
  case 4: nativeData = canUseTypedArray ? new Int16Array(rawData.buffer, byteOff, n) : new Int16Array(n); break;
  case 8: nativeData = canUseTypedArray ? new Int32Array(rawData.buffer, byteOff, n) : new Int32Array(n); break;
  case 16: nativeData = canUseTypedArray ? new Float32Array(rawData.buffer, byteOff, n) : new Float32Array(n); break;
  case 64: nativeData = canUseTypedArray ? new Float64Array(rawData.buffer, byteOff, n) : new Float64Array(n); break;
  case 256: nativeData = canUseTypedArray ? new Int8Array(rawData.buffer, byteOff, n) : new Int8Array(n); break;
  case 512: nativeData = canUseTypedArray ? new Uint16Array(rawData.buffer, byteOff, n) : new Uint16Array(n); break;
  case 768: nativeData = canUseTypedArray ? new Uint32Array(rawData.buffer, byteOff, n) : new Uint32Array(n); break;
  default: nativeData = new Float32Array(n); break;
  }

  if (!canUseTypedArray) {
  if (datatype === 2) {
    // Uint8: byte-level copy (no endian concern)
    (nativeData as Uint8Array).set(new Uint8Array(rawData.buffer, byteOff, n));
  } else if (datatype === 256) {
    // Int8: byte-level copy (no endian concern)
    (nativeData as Int8Array).set(new Int8Array(rawData.buffer, byteOff, n));
  } else {
  const view = new DataView(rawData.buffer, byteOff, n * elemSize);
  switch (datatype) {
    case 4: { const a = nativeData as Int16Array; for (let i = 0; i < n; i++) a[i] = view.getInt16(i * 2, le); break; }
    case 8: { const a = nativeData as Int32Array; for (let i = 0; i < n; i++) a[i] = view.getInt32(i * 4, le); break; }
    case 16: { const a = nativeData as Float32Array; for (let i = 0; i < n; i++) a[i] = view.getFloat32(i * 4, le); break; }
    case 64: { const a = nativeData as Float64Array; for (let i = 0; i < n; i++) a[i] = view.getFloat64(i * 8, le); break; }
    case 512: { const a = nativeData as Uint16Array; for (let i = 0; i < n; i++) a[i] = view.getUint16(i * 2, le); break; }
    case 768: { const a = nativeData as Uint32Array; for (let i = 0; i < n; i++) a[i] = view.getUint32(i * 4, le); break; }
  }
  }
  }

  self.postMessage({ id, type: 'progress', value: 0.7, stage: 'computing range' });

  // ── Efficient min/max with direct sampling ─────────────────────────
  // Sample up to ~100k voxels for fast min/max estimation.
  // Direct iteration avoids creating intermediate sampled arrays.
  let min = Infinity, max = -Infinity;
  const sampleStep = Math.max(1, Math.floor(n / 100000));
  const needsConversion = slope !== 1 || inter !== 0;

  if (!needsConversion) {
    // Fast path: no slope/inter conversion needed
    for (let i = 0; i < n; i += sampleStep) {
      const v = (nativeData as any)[i];
      if (v < min) min = v;
      if (v > max) max = v;
    }
  } else {
    for (let i = 0; i < n; i += sampleStep) {
      const v = (nativeData as any)[i] * slope + inter;
      if (v < min) min = v;
      if (v > max) max = v;
    }
  }
  if (min === max) max = min + 1;

  // Skip preview if already sent via early streaming decompress — avoid
  // wasting CPU computing 3 slices that will be discarded.
  const skipPreview = earlyPreviewSent.has(id);
  if (skipPreview) earlyPreviewSent.delete(id);

  self.postMessage({ id, type: 'progress', value: 0.75, stage: 'preview' });

  if (!skipPreview) {
  const axMid = Math.floor(nz / 2);
  const coMid = Math.floor(ny / 2);
  const saMid = Math.floor(nx / 2);

  const previewSlices: { axial: Float32Array; coronal: Float32Array; sagittal: Float32Array } = {
  axial: new Float32Array(nx * ny),
  coronal: new Float32Array(0),  // placeholder — GPU will render
  sagittal: new Float32Array(0), // placeholder — GPU will render
  };

  {
  const base = axMid * ny * nx;
  const src = nativeData instanceof Float32Array
    ? (nativeData as Float32Array).subarray(base, base + nx * ny)
    : null;
  if (src && !needsConversion) {
    previewSlices.axial.set(src);
  } else if (src && needsConversion) {
    previewSlices.axial.set(src);
    for (let i = 0; i < nx * ny; i++) previewSlices.axial[i] = previewSlices.axial[i] * slope + inter;
  } else if (needsConversion) {
    for (let i = 0; i < nx * ny; i++) { if (i % 4096 === 0) throwIfAborted(signal); previewSlices.axial[i] = (nativeData as any)[base + i] * slope + inter; }
  } else {
    for (let i = 0; i < nx * ny; i++) { if (i % 4096 === 0) throwIfAborted(signal); previewSlices.axial[i] = (nativeData as any)[base + i]; }
  }
  }

  self.postMessage({
  id, type: 'preview',
  header,
  slices: previewSlices,
  globalMin: min, globalMax: max,
  sliceIdx: { axial: axMid, coronal: coMid, sagittal: saMid },
  slope, inter,
  }, [previewSlices.axial.buffer, previewSlices.coronal.buffer, previewSlices.sagittal.buffer]);
  }

  self.postMessage({ id, type: 'progress', value: 0.85, stage: 'transferring volume' });

  // Always send native data — GPU shader handles slope/inter
  let voxelData: Int8Array | Uint8Array | Int16Array | Uint16Array | Int32Array | Uint32Array | Float32Array | Float64Array;
  voxelData = nativeData;
  nativeData = null as any; // release reference for GC

  self.postMessage({ id, type: 'progress', value: 1.0, stage: 'done' });

  self.postMessage(
  {
    id,
    type: 'volume',
    header,
    voxelData,
    globalMin: min,
    globalMax: max,
    datatype,
    slope,
    inter,
  },
  [voxelData.buffer]
  );
}

/**
 * Emit an early preview from a partially-decompressed buffer.
 * Extracts the z=0 axial slice and posts it as a preview message.
 * Returns true if preview was emitted, false if not enough data yet.
 */
function tryEmitEarlyPreview(
  buf: Uint8Array,
  bufLen: number,
  id: number,
  isGzip: boolean,
): boolean {
  if (bufLen < 544) return false;
  try {
    const header = parseNiiHeader(buf.buffer as ArrayBuffer, isGzip);
    if (!header) return false;

    const { nx, ny, voxOffset, bytesPerVoxel, scl_slope, scl_inter, littleEndian, datatype } = header;
    const firstSliceNeeded = voxOffset + nx * ny * bytesPerVoxel;
    if (bufLen < firstSliceNeeded) return false;

    const slope = scl_slope || 1;
    const inter = scl_inter || 0;
    const le = littleEndian;
    const needsConversion = slope !== 1 || inter !== 0;
    const elemSize = datatype === 64 ? 8 : datatype === 8 || datatype === 16 || datatype === 768 ? 4 : datatype === 4 || datatype === 512 ? 2 : 1;

    const sliceStart = voxOffset;
    const axialSlice = new Float32Array(nx * ny);
    const sliceView = new DataView(buf.buffer, buf.byteOffset + sliceStart, nx * ny * bytesPerVoxel);
    const byteOff = buf.byteOffset + sliceStart;
    const canUseTA = (byteOff % elemSize === 0) && le;

    if (canUseTA && datatype === 16 && !needsConversion) {
      axialSlice.set(new Float32Array(buf.buffer, byteOff, nx * ny));
    } else if (canUseTA && datatype === 16 && needsConversion) {
      const src = new Float32Array(buf.buffer, byteOff, nx * ny);
      for (let i = 0; i < nx * ny; i++) axialSlice[i] = src[i] * slope + inter;
    } else {
      for (let i = 0; i < nx * ny; i++) {
        let val: number;
        switch (datatype) {
          case 2: val = buf[buf.byteOffset + sliceStart + i]; break;
          case 4: val = sliceView.getInt16(i * 2, le); break;
          case 8: val = sliceView.getInt32(i * 4, le); break;
          case 16: val = sliceView.getFloat32(i * 4, le); break;
          case 64: val = sliceView.getFloat64(i * 8, le); break;
          case 256: val = (buf[buf.byteOffset + sliceStart + i] << 24) >> 24; break;
          case 512: val = sliceView.getUint16(i * 2, le); break;
          case 768: val = sliceView.getUint32(i * 4, le); break;
          default: val = 0;
        }
        axialSlice[i] = val * slope + inter;
      }
    }

    let min = Infinity, max = -Infinity;
    for (let i = 0; i < axialSlice.length; i++) {
      if (axialSlice[i] < min) min = axialSlice[i];
      if (axialSlice[i] > max) max = axialSlice[i];
    }
    if (min === max) max = min + 1;

    const coMid = Math.floor(ny / 2);
    const saMid = Math.floor(nx / 2);

    self.postMessage({
      id, type: 'preview',
      partialPreview: true,
      header,
      slices: {
        axial: axialSlice,
        coronal: new Float32Array(0),
        sagittal: new Float32Array(0),
      },
      globalMin: min, globalMax: max,
      sliceIdx: { axial: 0, coronal: coMid, sagittal: saMid },
      slope, inter,
    }, [axialSlice.buffer]);

    earlyPreviewSent.add(id);
    earlyPreviewHeaders.set(id, header);  // cache for processRawVolume
    return true;
  } catch {
    return false;
  }
}

/**
 * High-performance parallel download with early preview.
 *
 * This is the primary loading path for all files. It combines:
 *  1. A small range probe (first 1MB) to get total size + parse header + emit preview
 *  2. Parallel range requests for the rest of the file (saturates bandwidth)
 *  3. For gzip: streaming decompression fed by ordered chunk arrival
 *  4. For uncompressed: direct write to pre-allocated buffer
 *
 * This eliminates the HEAD request RTT, uses parallel downloads for
 * bandwidth saturation, and provides early preview from the probe data.
 */
// Report a bandwidth sample to the main thread so the shared estimator stays
// up-to-date across loads.
function reportBandwidthSample(id: number, bytes: number, durationMs: number, rttMs?: number): void {
  self.postMessage({ id, type: 'bandwidthSample', bytes, durationMs, rttMs });
}

// Compute chunk size / concurrency using bandwidth-delay product (BDP).
// The goal is to keep enough bytes in flight to saturate the link without
// creating head-of-line blocking or excessive small requests.
//
// Callers should pass PROBE-MEASURED bandwidth/RTT (ground truth for the
// current link), falling back to session estimates. The pool is always
// launched after the probe measurement, so these values are fresh.
function computeAdaptiveParams(
  estimatedBps: number,
  estimatedRttMs: number,
  isRemote: boolean,
  totalSize: number,
): { chunkSize: number; maxConcurrent: number } {
  const MAX_CHUNK = 64 * 1024 * 1024;
  const LOCAL_CHUNK = 32 * 1024 * 1024;
  const LOCAL_CONCURRENT = 8;

  if (!isRemote) {
    return {
      chunkSize: Math.min(LOCAL_CHUNK, totalSize),
      maxConcurrent: LOCAL_CONCURRENT,
    };
  }

  // Use caller estimates if available; otherwise fall back to conservative defaults.
  const bps = estimatedBps > 0 ? estimatedBps : 10 * 1024 * 1024;
  const rtt = estimatedRttMs > 0 ? estimatedRttMs : 80;
  const mbps = bps / (1024 * 1024);

  // On slow links (<2 Mbps) shrink the minimum chunk to 512KB: a 2MB floor
  // means 16-64s of wasted transfer on every failed-chunk retry. 512KB keeps
  // the retry granularity proportional to the link speed.
  const MIN_CHUNK = mbps < 2 ? 512 * 1024 : 2 * 1024 * 1024;

  // BDP in bytes (1 RTT worth of data). Multiply by 2 to keep the pipe full.
  const bdpBytes = Math.max(MIN_CHUNK, (bps * (rtt / 1000)) / 8 * 2);

  // Choose a target concurrency based on link quality. On weak links we keep
  // concurrency low to avoid per-request RTT overhead and TCP congestion,
  // and so background full-volume traffic cannot starve interactive slice
  // and preview requests sharing the same tunnel.
  let targetConcurrent: number;
  if (mbps < 2 || rtt > 500) {
    targetConcurrent = 2;
  } else if (mbps < 10 || rtt > 200) {
    targetConcurrent = 4;
  } else if (mbps < 50) {
    targetConcurrent = 8;
  } else if (mbps < 100) {
    targetConcurrent = 16;
  } else {
    targetConcurrent = 24;
  }

  let chunkSize: number;
  if (totalSize <= bdpBytes) {
    // Small file relative to BDP: download in one chunk.
    chunkSize = totalSize;
  } else {
    // Each chunk should be at least the BDP so a single transfer keeps the
    // pipe full for one RTT. Also spread the file across the target concurrency.
    chunkSize = Math.max(bdpBytes, Math.ceil(totalSize / targetConcurrent));
    chunkSize = Math.min(MAX_CHUNK, chunkSize);
  }

  // Concurrency is limited by the number of chunks we actually created.
  const numChunks = Math.ceil(totalSize / chunkSize);
  const maxConcurrent = Math.max(1, Math.min(numChunks, targetConcurrent));

  return { chunkSize: Math.floor(chunkSize), maxConcurrent };
}

// Choose the initial range-probe size. The probe doubles as (a) the first
// preview data (header + first slices) and (b) the link measurement, so it
// must be small on slow links — a fixed 1MB probe costs 8-16s before the
// first image on a VPN. 256KB covers the NIfTI header plus 1-2 compressed
// slices of a typical 256^2 int16 volume; anything larger is fetched by the
// pool immediately after measurement. Only links KNOWN to be fast (session
// history) get the 1MB probe to save one extra range request.
function computeProbeSize(estimatedBps: number, _estimatedRttMs: number): number {
  return estimatedBps >= 40 * 1024 * 1024 ? 1024 * 1024 : 256 * 1024;
}

async function parallelDownloadWithEarlyPreview(
  url: string,
  id: number,
  isGzip: boolean,
  signal: AbortSignal,
  estimatedBps = 0,
  estimatedRttMs = 0,
  firePreview?: (measuredBps: number) => void,
): Promise<Uint8Array> {
  const hasNativeDecompress = typeof (self as any).DecompressionStream !== 'undefined';

  // ── Step 1: Range probe to get total size + first data ──
  // Probe size is chosen by network quality: tiny on slow links for fast
  // preview, slightly larger on high-RTT links to cover bigger first slices.
  const PROBE_SIZE = computeProbeSize(estimatedBps, estimatedRttMs);

  // Probe fetch with idle-watchdog + one retry: on a stalled link the probe
  // itself would otherwise hang before any measurement exists. The watchdog
  // covers the headers phase (TTFB) — a frozen VPN never rejects the fetch
  // promise, it just leaves it pending forever. fetchWithRetry alone has no
  // such timeout, so it must not be used here.
  let probeResp: Response | null = null;
  const probeStart = performance.now();
  for (let attempt = 0; attempt < 2 && !probeResp; attempt++) {
    throwIfAborted(signal);
    try {
      probeResp = await fetchHeadersWatchdog(url, {
        headers: { Range: `bytes=0-${PROBE_SIZE - 1}` },
      }, DEFAULT_IDLE_TIMEOUT_MS, signal);
      // Retry only on retryable statuses; hand back others for the caller's
      // status checks below (200/206 handling).
      const st = probeResp.status;
      if (st !== 200 && st !== 206 && attempt === 0) {
        try { await probeResp.body?.cancel(); } catch { /* ignore */ }
        probeResp = null;
        await sleep(RETRY_DELAY_BASE);
      }
    } catch (err: any) {
      if (err?.name === 'AbortError') throw err;
      if (attempt === 1) throw err;
      await sleep(RETRY_DELAY_BASE);
    }
  }
  // TTFB of the probe ≈ one link round trip (used as the RTT estimate).
  const probeHeaderMs = performance.now() - probeStart;
  if (!probeResp) throw new Error('Probe failed');

  // If server doesn't support ranges (returns 200), fall back to streaming
  if (probeResp.status === 200) {
    // Server returned full file — read it directly
    if (isGzip && hasNativeDecompress) {
      return streamingGzipLoadFromResponse(probeResp, id, signal);
    }
    return streamingNiiLoadFromResponse(probeResp, id, signal);
  }

  if (probeResp.status !== 206) {
    throw new Error(`Probe failed: ${probeResp.status}`);
  }

  // Extract total size from Content-Range header
  let totalSize = 0;
  const contentRange = probeResp.headers.get('Content-Range') || '';
  const crMatch = contentRange.match(/\/(\d+)/);
  if (crMatch) totalSize = parseInt(crMatch[1]);

  if (!totalSize) {
    // No Content-Range — can't do parallel download, fall back
    probeResp.body?.cancel();
    if (isGzip && hasNativeDecompress) return streamingGzipLoadWithEarlyPreview(url, id, signal);
    return streamingNiiLoadWithEarlyPreview(url, id, signal);
  }

  // Check if this is a remote source to tune chunk size.
  // Direct remote URLs (not localhost proxy) are always "remote".
  // Proxy URLs may have X-Remote-Source header — set by the proxy when it
  // runs inside a remote extension host, marking that the request traversed
  // the SSH tunnel (the URL still LOOKS like 127.0.0.1 from the local side).
  const isLocalhost = url.startsWith('http://127.0.0.1') || url.startsWith('http://localhost');
  const isRemote = !isLocalhost || probeResp.headers.get('X-Remote-Source') === 'true';

  // ── Measure the link BEFORE launching anything bandwidth-hungry ──
  // The probe is the only ground truth for THIS link right now; stale
  // session defaults (10Mbps) would pick 6MB+ chunks on a VPN.
  const bodyStart = performance.now();
  const probeBodyPromise = readBodyWithWatchdog(probeResp, DEFAULT_IDLE_TIMEOUT_MS, signal);
  const probeData = await probeBodyPromise;
  const bodyMs = Math.max(1, performance.now() - bodyStart);
  const measuredBps = Math.min((probeData.byteLength / bodyMs) * 1000 * 8, 1024 * 1024 * 1024);
  const measuredRttMs = Math.max(1, probeHeaderMs);
  // Feed the viewer's estimator so slice-quality adaptation reacts from the
  // very first load (interactive downsampling, preview factor choice).
  reportBandwidthSample(id, probeData.byteLength, bodyMs, measuredRttMs);

  // Now that the link is measured, fire the low-res preview fetch with a
  // factor scaled to the REAL bandwidth (it must not stall the first image).
  firePreview?.(measuredBps);

  const { chunkSize: CHUNK_SIZE, maxConcurrent: MAX_CONCURRENT } = computeAdaptiveParams(
    measuredBps || estimatedBps, measuredRttMs || estimatedRttMs, isRemote, totalSize,
  );
  const idleMs = clampIdleTimeout(measuredRttMs || estimatedRttMs);

  // If the entire file fits in the probe, just return it.
  if (totalSize <= PROBE_SIZE) {
    if (isGzip && hasNativeDecompress) {
      return nativeDecompressFromBuffer(probeData, signal);
    }
    return probeData;
  }

  const settledProbe = Promise.resolve(probeData);

  // ── Step 2: For gzip — streaming decompress with ordered chunk feeding ──
  if (isGzip && hasNativeDecompress) {
    return parallelGzipDownload(url, id, signal, totalSize, settledProbe, PROBE_SIZE, CHUNK_SIZE, MAX_CONCURRENT, idleMs);
  }

  // ── Step 3: For uncompressed — direct parallel download ──
  return parallelNiiDownload(url, id, signal, totalSize, settledProbe, PROBE_SIZE, CHUNK_SIZE, MAX_CONCURRENT, idleMs);
}

// A pool round that makes no progress at all (every chunk failed) means the
// link is down — retrying further is pointless. Otherwise, up to this many
// rounds refetch ONLY the missing chunks (resume): the decompressor stream
// and all completed-but-unfed chunks stay alive across rounds, so resume
// costs zero extra memory and zero re-download of completed bytes.
const MAX_POOL_ROUNDS = 3;

/**
 * Parallel gzip download with streaming decompression.
 * Downloads compressed chunks in parallel, feeds them to the decompressor
 * in order, and emits early preview from the first decompressed slice.
 */
async function parallelGzipDownload(
  url: string,
  id: number,
  signal: AbortSignal,
  totalSize: number,
  probeDataPromise: Promise<Uint8Array>,
  probeSize: number,
  chunkSize: number,
  maxConcurrent: number,
  idleMs: number,
): Promise<Uint8Array> {
  const ds = new (self as any).DecompressionStream('gzip');
  const writer = ds.writable.getWriter();
  const reader = ds.readable.getReader() as ReadableStreamDefaultReader<Uint8Array>;

  // Pre-allocate decompressed buffer — cap initial size to avoid OOM
  const estimatedSize = Math.min(totalSize * 4, 512 * 1024 * 1024);
  let result = new Uint8Array(Math.max(estimatedSize, 16 * 1024 * 1024));
  let writeOffset = 0;
  let previewSent = false;
  let lastProgressTime = 0;

  // Concurrent decompression reader — runs alongside downloads
  const decompressPromise = (async () => {
    while (true) {
      throwIfAborted(signal);
      const { done, value } = await reader.read();
      if (done) break;

      if (writeOffset + value.byteLength > result.length) {
        let newCap = result.length;
        while (newCap < writeOffset + value.byteLength) newCap *= 2;
        const grown = new Uint8Array(newCap);
        grown.set(result.subarray(0, writeOffset), 0);
        result = grown;
      }
      result.set(value, writeOffset);
      writeOffset += value.byteLength;

      if (!previewSent) {
        previewSent = tryEmitEarlyPreview(result, writeOffset, id, true);
        if (previewSent) {
          self.postMessage({ id, type: 'progress', value: 0.5, stage: 'decompressing (parallel)' });
        }
      }

      // Throttled progress updates (max 20fps)
      const now = performance.now();
      if (now - lastProgressTime > 50) {
        lastProgressTime = now;
        const pct = Math.min(0.95, 0.1 + (writeOffset / (totalSize * 4)) * 0.8);
        self.postMessage({ id, type: 'progress', value: pct, stage: 'decompressing (parallel)' });
      }
    }
  })();

  const remainingStart = probeSize;
  const numChunks = Math.ceil((totalSize - remainingStart) / chunkSize);

  // Ordered chunk buffer with back-pressure — limit pending size
  const pending = new Map<number, Uint8Array>();
  const MAX_PENDING = maxConcurrent * 2;
  let nextFeedIdx = 0;
  let downloadError: Error | null = null;
  // Decompressor/write failures are fatal — refetching network bytes cannot
  // fix a broken stream, so resume rounds must not be attempted for them.
  let fatalStreamError: Error | null = null;

  // Batch feed: merge consecutive pending chunks into a single writer.write()
  // to reduce await overhead and improve throughput.
  let feedingChain = Promise.resolve();
  const feedIfReady = (): Promise<void> => {
    feedingChain = feedingChain.then(async () => {
      const batch: Uint8Array[] = [];
      while (pending.has(nextFeedIdx) && !fatalStreamError) {
        batch.push(pending.get(nextFeedIdx)!);
        pending.delete(nextFeedIdx);
        nextFeedIdx++;
      }
      if (batch.length === 0) return;
      // Merge batch into one write to reduce await overhead
      const writeBatch = async (data: Uint8Array) => {
        try { await writer.write(data); } catch (err) { fatalStreamError = err as Error; }
      };
      if (batch.length === 1) {
        await writeBatch(batch[0]);
      } else {
        let totalLen = 0;
        for (const c of batch) totalLen += c.byteLength;
        const merged = new Uint8Array(totalLen);
        let off = 0;
        for (const c of batch) { merged.set(c, off); off += c.byteLength; }
        await writeBatch(merged);
      }
    });
    return feedingChain;
  };

  // Chunks completed across ALL rounds (survives round boundaries → resume).
  const fetchedIdx = new Set<number>();
  let received = remainingStart;
  let successCount = 0;
  let failureCount = 0;
  let effectiveMaxConcurrent = maxConcurrent;

  /**
   * One pool round: fetch every chunk not yet in `fetchedIdx`. A failing
   * chunk does NOT kill the round — in-flight chunks finish, then the round
   * ends and the caller decides whether to resume with another round.
   */
  const runPoolRound = (firstGapIdx: number): Promise<void> => new Promise((resolve, reject) => {
    let running = 0;
    let launched = 0;
    const tryLaunch = (): void => {
      while (running < effectiveMaxConcurrent && launched < numChunks && !fatalStreamError) {
        const idx = launched++;
        if (fetchedIdx.has(idx)) continue;
        const start = remainingStart + idx * chunkSize;
        const end = Math.min(start + chunkSize - 1, totalSize - 1);
        // Back-pressure bounds out-of-order buffering, but never blocks a
        // GAP chunk (idx <= first gap): gap chunks unblock the ordered feed
        // the moment they land, so they cannot inflate `pending`.
        if (pending.size >= MAX_PENDING && idx > firstGapIdx) break;
        running++;

        (async () => {
          const chunkStartTime = performance.now();
          try {
            throwIfAborted(signal);
            const data = await fetchRangeBytesWithRetry(url, start, end, idleMs, signal);
            fetchedIdx.add(idx);
            successCount++;
            received += data.byteLength;
            reportBandwidthSample(id, data.byteLength, Math.max(1, performance.now() - chunkStartTime));
            // Throttled progress
            const now = performance.now();
            if (now - lastProgressTime > 50) {
              lastProgressTime = now;
              self.postMessage({
                id, type: 'progress',
                value: 0.02 + (received / totalSize) * 0.5,
                stage: 'downloading (parallel)',
              });
            }
            pending.set(idx, data);
            await feedIfReady();
          } catch (err: any) {
            if (err?.name === 'AbortError') {
              downloadError = err;
              reject(err);
              return;
            }
            failureCount++;
            // Adaptive backoff: if failure rate is high, reduce concurrency
            // to ease pressure on a struggling network and avoid cascading timeouts.
            const totalAttempts = successCount + failureCount;
            if (totalAttempts > 3 && failureCount / totalAttempts > 0.15) {
              effectiveMaxConcurrent = Math.max(2, Math.floor(effectiveMaxConcurrent / 2));
            }
            if (!downloadError) downloadError = err;
          }
          running--;
          if (launched >= numChunks && running === 0) {
            resolve();
          }
          else tryLaunch();
        })();
      }
      if (launched >= numChunks && running === 0) {
        resolve();
      }
    };
    tryLaunch();
  });

  try {
    // Await probe body and feed it to the decompressor.  Chunks that finished
    // before the probe are buffered in `pending` and will be fed right after.
    const probeData = await probeDataPromise;
    await writer.write(probeData);
    for (let round = 0; ; round++) {
      // Lowest missing index = the head of the ordered feed gap. Chunks at
      // or below it bypass the back-pressure gate (they drain `pending`).
      let firstGapIdx = numChunks;
      for (let i = 0; i < numChunks; i++) {
        if (!fetchedIdx.has(i)) { firstGapIdx = i; break; }
      }
      const progressBefore = fetchedIdx.size;
      await runPoolRound(firstGapIdx);
      if (fatalStreamError) throw fatalStreamError;
      if (fetchedIdx.size >= numChunks) break;
      // Incomplete round — decide whether resuming is worthwhile.
      const lastErr = downloadError;
      downloadError = null;
      if (round + 1 >= MAX_POOL_ROUNDS) {
        throw lastErr || new Error('Download failed after resume rounds');
      }
      if (fetchedIdx.size === progressBefore) {
        // Zero progress in a full round: the link is effectively dead.
        throw lastErr || new Error('Download stalled: no progress');
      }
      await sleep(RETRY_DELAY_BASE * 2);
    }
    await writer.close();
    await decompressPromise;
  } catch (err) {
    downloadError = downloadError || (err as Error);
  } finally {
    // Ensure stream resources are cleaned up on error/abort
    try { writer.abort(); } catch {}
    try { reader.releaseLock(); } catch {}
  }

  if (downloadError) throw downloadError;

  self.postMessage({ id, type: 'progress', value: 0.9, stage: 'processing' });
  return result.subarray(0, writeOffset);
}

/**
 * Parallel uncompressed NIfTI download with early preview.
 * Writes chunks directly to pre-allocated buffer at correct positions.
 */
async function parallelNiiDownload(
  url: string,
  id: number,
  signal: AbortSignal,
  totalSize: number,
  probeDataPromise: Promise<Uint8Array>,
  probeSize: number,
  chunkSize: number,
  maxConcurrent: number,
  idleMs: number,
): Promise<Uint8Array> {
  // Pre-allocate exact buffer — no growth needed for uncompressed
  const result = new Uint8Array(totalSize);

  // Start the download pool immediately; chunks that arrive before the probe
  // body simply write to their final offsets.
  const remainingStart = probeSize;
  const numChunks = Math.ceil((totalSize - remainingStart) / chunkSize);

  let running = 0;
  let nextIdx = 0;
  let poolError: Error | null = null;
  let successCount = 0;
  let failureCount = 0;
  let effectiveMaxConcurrent = maxConcurrent;

  const downloadPoolPromise = new Promise<void>((resolve, reject) => {
    const tryLaunch = (): void => {
      while (running < effectiveMaxConcurrent && nextIdx < numChunks && !poolError) {
        const idx = nextIdx++;
        const start = remainingStart + idx * chunkSize;
        const end = Math.min(start + chunkSize - 1, totalSize - 1);
        running++;

        (async () => {
          const chunkStartTime = performance.now();
          try {
            throwIfAborted(signal);
            // Watchdog-protected range fetch (headers + body): a frozen VPN
            // must fail fast so the pool can retry/resume instead of hanging.
            const data = await fetchRangeBytesWithRetry(url, start, end, idleMs, signal);
            successCount++;
            result.set(data, start);
            reportBandwidthSample(id, data.byteLength, Math.max(1, performance.now() - chunkStartTime));
            const received = start + data.byteLength;
            self.postMessage({
              id, type: 'progress',
              value: 0.02 + (received / totalSize) * 0.85,
              stage: 'downloading (parallel)',
            });
          } catch (err: any) {
            if (err?.name === 'AbortError') { poolError = err; }
            else {
              failureCount++;
              const totalAttempts = successCount + failureCount;
              if (totalAttempts > 3 && failureCount / totalAttempts > 0.15) {
                effectiveMaxConcurrent = Math.max(2, Math.floor(effectiveMaxConcurrent / 2));
              }
              if (!poolError) poolError = err;
            }
          }
          running--;
          if (poolError) { reject(poolError); return; }
          if (nextIdx >= numChunks && running === 0) resolve();
          else tryLaunch();
        })();
      }
      if (numChunks === 0) resolve();
    };
    tryLaunch();
  });

  const probeData = await probeDataPromise;
  result.set(probeData, 0);
  // Emit early preview from probe data
  tryEmitEarlyPreview(result, probeData.byteLength, id, false);
  self.postMessage({ id, type: 'progress', value: 0.1, stage: 'downloading (parallel)' });

  await downloadPoolPromise;
  if (poolError) throw poolError;

  self.postMessage({ id, type: 'progress', value: 0.9, stage: 'processing' });
  return result;
}

/**
 * Stream-decompress a gzip Response from a full (non-range) response.
 * Used when the server doesn't support range requests.
 */
async function streamingGzipLoadFromResponse(
  resp: Response,
  id: number,
  signal: AbortSignal,
): Promise<Uint8Array> {
  const ds = new (self as any).DecompressionStream('gzip');
  const decompressedStream = resp.body!.pipeThrough(ds);
  const reader = decompressedStream.getReader() as ReadableStreamDefaultReader<Uint8Array>;

  let result = new Uint8Array(16 * 1024 * 1024);
  let writeOffset = 0;
  let previewSent = false;

  while (true) {
    throwIfAborted(signal);
    // Watchdog: network-fed decompressed stream — a stalled tunnel must
    // surface as TimeoutError instead of an eternal pending read().
    const { done, value } = await readStreamChunkWithWatchdog(reader, DEFAULT_IDLE_TIMEOUT_MS);
    if (done) break;

    if (writeOffset + value.byteLength > result.length) {
      let newCap = result.length;
      while (newCap < writeOffset + value.byteLength) newCap *= 2;
      const grown = new Uint8Array(newCap);
      grown.set(result.subarray(0, writeOffset), 0);
      result = grown;
    }
    result.set(value, writeOffset);
    writeOffset += value.byteLength;

    if (!previewSent) {
      previewSent = tryEmitEarlyPreview(result, writeOffset, id, true);
    }

    self.postMessage({ id, type: 'progress', value: 0.1 + (writeOffset / (result.length)) * 0.8, stage: 'decompressing (stream)' });
  }

  return result.subarray(0, writeOffset);
}

/**
 * Stream-load an uncompressed NIfTI from a full (non-range) Response.
 */
async function streamingNiiLoadFromResponse(
  resp: Response,
  id: number,
  signal: AbortSignal,
): Promise<Uint8Array> {
  const contentLength = Number(resp.headers.get('Content-Length') || 0);
  const reader = resp.body!.getReader();

  let result: Uint8Array = contentLength > 0 ? new Uint8Array(contentLength) : new Uint8Array(16 * 1024 * 1024);
  const chunks: Uint8Array[] = [];
  let writeOffset = 0;
  let totalSize = 0;
  let previewSent = false;

  while (true) {
    throwIfAborted(signal);
    // Watchdog: raw network stream — a stalled tunnel must surface as
    // TimeoutError instead of an eternal pending read().
    const { done, value } = await readStreamChunkWithWatchdog(reader, DEFAULT_IDLE_TIMEOUT_MS);
    if (done) break;

    if (result) {
      if (writeOffset + value.byteLength <= result.length) {
        result.set(value, writeOffset);
      } else {
        chunks.push(result.subarray(0, writeOffset));
        chunks.push(value);
        result = null as any;
      }
    } else {
      chunks.push(value);
    }
    writeOffset += value.byteLength;
    totalSize += value.byteLength;

    if (!previewSent) {
      const buf = result ? result.subarray(0, writeOffset) : (() => {
        const tmp = new Uint8Array(writeOffset);
        let off = 0;
        for (const c of chunks) { tmp.set(c, off); off += c.byteLength; }
        return tmp;
      })();
      previewSent = tryEmitEarlyPreview(buf, writeOffset, id, false);
    }

    if (contentLength > 0) {
      self.postMessage({ id, type: 'progress', value: 0.02 + (writeOffset / contentLength) * 0.85, stage: 'downloading (stream)' });
    }
  }

  if (result) return result.subarray(0, writeOffset);

  const final = new Uint8Array(totalSize);
  let offset = 0;
  for (const chunk of chunks) { final.set(chunk, offset); offset += chunk.byteLength; }
  return final;
}

/**
 * Try to fetch a low-resolution subsampled preview volume from the proxy's
 * /preview-volume/{id}?factor=N endpoint. On success, emits a `previewVolume`
 * message to the main thread so the viewer can render all three orthogonal
 * views immediately at reduced resolution, while the full volume continues
 * downloading in the background.
 *
 * Binary response layout (little-endian):
 *   [4]  header_json_length (uint32)
 *   [N]  header_json (UTF-8)  — low-res header with scaled dims/voxel sizes
 *   [4]  factor (uint32)
 *   [4]  out_nx (uint32)
 *   [4]  out_ny (uint32)
 *   [4]  out_nz (uint32)
 *   [4]  global_min (float32)
 *   [4]  global_max (float32)
 *   [4]  slope (float32)
 *   [4]  inter (float32)
 *   [M]  voxel_data (Float32, out_nx*out_ny*out_nz * 4 bytes)
 *
 * Returns true if a preview was emitted, false if the endpoint was
 * unavailable or the fetch failed (caller falls back to existing flow).
 */
async function tryFetchPreviewVolume(proxyUrl: string, id: number, signal: AbortSignal, estimatedBps = 0, isGzip = false): Promise<boolean> {
  // Convert /file/{id} → /preview-volume/{id}?factor=N
  // Only proxy URLs (localhost) have this endpoint. Direct remote URLs don't.
  if (!proxyUrl.includes('/file/')) return false;
  // Adaptive factor, split by compression type:
  // - .nii.gz: the proxy must stream-decompress sequentially, so the preview
  //   cost scales with the compressed bytes transferred. On VPN-class links
  //   (<2 MB/s) request factor=32 (~3% of the stream) so the first image
  //   lands in seconds; mid links get 16; fast links get 8.
  // - .nii: range-parallel subsampling, cheap — keep 8 on slow / 4 on fast.
  // estimatedBps is bits/sec. 0 = unknown, treated as mid-tier.
  const slow = estimatedBps > 0 && estimatedBps < 2 * 1024 * 1024 * 8;
  const mid = estimatedBps === 0 || estimatedBps < 5 * 1024 * 1024 * 8;
  const factor = isGzip ? (slow ? 32 : mid ? 16 : 8) : (mid ? 8 : 4);
  const previewUrl = proxyUrl.replace('/file/', '/preview-volume/') + `?factor=${factor}`;

  try {
    const resp = await fetchWithRetry(previewUrl, undefined, 2, signal);
    if (!resp.ok) return false;

    const ab = await resp.arrayBuffer();
    const data = new Uint8Array(ab);
    if (data.length < 4) return false;

    let offset = 0;
    const dv = new DataView(ab);

    const headerLen = dv.getUint32(offset, true); offset += 4;
    if (offset + headerLen > data.length) return false;

    const headerJson = new TextDecoder().decode(data.subarray(offset, offset + headerLen));
    offset += headerLen;

    let header: any;
    try { header = JSON.parse(headerJson); } catch { return false; }

    if (offset + 28 > data.length) return false;
    const factor = dv.getUint32(offset, true); offset += 4;
    const outNx = dv.getUint32(offset, true); offset += 4;
    const outNy = dv.getUint32(offset, true); offset += 4;
    const outNz = dv.getUint32(offset, true); offset += 4;
    const min = dv.getFloat32(offset, true); offset += 4;
    const max = dv.getFloat32(offset, true); offset += 4;
    const slope = dv.getFloat32(offset, true); offset += 4;
    const inter = dv.getFloat32(offset, true); offset += 4;

    const voxelCount = outNx * outNy * outNz;
    const voxelBytes = voxelCount * 4;
    if (offset + voxelBytes > data.length) return false;

    // Copy voxel data into a fresh, transferable Float32Array so we can
    // transfer its buffer to the main thread without neutering the response.
    const voxelData = new Float32Array(voxelCount);
    voxelData.set(new Float32Array(ab, offset, voxelCount));

    self.postMessage({
      id,
      type: 'previewVolume',
      header,
      voxelData,
      globalMin: min,
      globalMax: max,
      slope,
      inter,
      factor,
      datatype: 16, // Float32
    }, [voxelData.buffer]);

    // Cache the low-res header so processRawVolume can skip redundant parse
    earlyPreviewSent.add(id);
    earlyPreviewHeaders.set(id, header);
    return true;
  } catch (err: any) {
    if (err?.name === 'AbortError') throw err;
    return false;
  }
}

async function handleLoadVolume(id: number, url: string, isGzip: boolean, directFetchUrl?: string, estimatedBps = 0, estimatedRttMs = 0) {
  cancelVolumeLoad(id);
  const controller = new AbortController();
  volumeControllers.set(id, controller);
  const signal = controller.signal;

  // For remote files, prefer the direct URL over the localhost proxy.
  // The proxy adds a full round-trip and double-hops every byte through
  // Node.js (remote → proxy → worker). Direct fetch eliminates this,
  // cutting latency by 30-50% on high-bandwidth links.
  // If direct fetch fails (CORS, no Range support), we fall back to proxy.
  const fetchUrl = directFetchUrl || url;
  try {
    self.postMessage({ id, type: 'progress', value: 0.02, stage: 'downloading' });

    // ── Low-res preview volume (Stage 1: .nii, Stage 2: .nii.gz) ──
    // The proxy exposes /preview-volume/{id}?factor=N which streams the
    // remote file, subsamples every N-th voxel, and returns a complete
    // low-res Float32 volume. For .nii it uses parallel Range requests;
    // for .nii.gz it stream-decompresses just enough slices (factor=16 →
    // ~6% of the compressed stream on VPN-class links) and closes the
    // connection early.  This gives a full three-view preview in ~1-3 s
    // for a 100 MB remote file.  Falls back silently if the endpoint is
    // unavailable.
    //
    // The preview is NOT fired here: the factor choice depends on the REAL
    // link bandwidth, which is only known after the range probe inside the
    // primary download path completes.  Firing early with a stale session
    // estimate would pick factor=8 on a VPN and stall the first image.
    // `firePreview` is invoked by parallelDownloadWithEarlyPreview right
    // after measurement; all fallback paths (streaming / chunked) emit
    // their own partial previews, so no path is left without one.
    // The preview goes through the localhost proxy (subsampling
    // server-side) while the full download goes direct to the remote
    // origin — different connections, fully overlapped.
    const firePreview = (measuredBps: number) => {
      tryFetchPreviewVolume(url, id, signal, measuredBps, isGzip).catch((err: any) => {
        // AbortError is expected when the load is cancelled — swallow it to
        // avoid an unhandled rejection (this promise is intentionally not awaited).
        if (err?.name === 'AbortError') return;
      });
    };

    const hasNativeDecompress = typeof (self as any).DecompressionStream !== 'undefined';
    let rawData: Uint8Array;

    // ── Primary path: parallel download with early preview ──
    // This combines a small range probe (for link measurement + header +
    // preview) with parallel range requests (for bandwidth saturation).
    // For gzip, chunks are fed to a streaming decompressor in order,
    // overlapping download + decompress. This is 3-8x faster than
    // single-stream download on high-bandwidth links.
    // Try direct remote URL first; if it fails (CORS, no Range), fall back
    // to the localhost proxy URL.
    try {
      rawData = await parallelDownloadWithEarlyPreview(fetchUrl, id, isGzip, signal, estimatedBps, estimatedRttMs, firePreview);
      throwIfAborted(signal);
      self.postMessage({ id, type: 'progress', value: 0.9, stage: 'processing' });
    } catch (err: any) {
      if (err?.name === 'AbortError') throw err;

      // If direct fetch failed and we have a different proxy URL, retry via proxy
      const retryUrl = (fetchUrl !== url) ? url : fetchUrl;

      // Fallback 1: streaming path (single GET, overlap download + decompress)
      try {
        if (isGzip && hasNativeDecompress) {
          rawData = await streamingGzipLoadWithEarlyPreview(retryUrl, id, signal);
        } else if (isGzip) {
          const compressedData = await downloadChunked(retryUrl, id, isGzip, signal);
          self.postMessage({ id, type: 'progress', value: 0.35, stage: 'decompressing' });
          throwIfAborted(signal);
          rawData = await new Promise<Uint8Array>((resolve, reject) => {
            gunzip(compressedData, (err, data) => {
              if (err) reject(err);
              else resolve(data);
            });
          });
        } else {
          rawData = await streamingNiiLoadWithEarlyPreview(retryUrl, id, signal);
        }
        throwIfAborted(signal);
        self.postMessage({ id, type: 'progress', value: 0.85, stage: 'processing' });
      } catch (err2: any) {
        if (err2?.name === 'AbortError') throw err2;
        // Fallback 2: parallel chunked download + buffer decompress
        const compressedData = await downloadChunked(retryUrl, id, isGzip, signal);
        self.postMessage({ id, type: 'progress', value: 0.35, stage: 'decompressing' });
        throwIfAborted(signal);
        if (isGzip) {
          if (hasNativeDecompress) {
            rawData = await nativeDecompressFromBuffer(compressedData, signal);
          } else {
            rawData = await new Promise<Uint8Array>((resolve, reject) => {
              gunzip(compressedData, (err, data) => {
                if (err) reject(err);
                else resolve(data);
              });
            });
          }
        } else {
          rawData = compressedData;
        }
        throwIfAborted(signal);
        self.postMessage({ id, type: 'progress', value: 0.7, stage: 'parsing' });
      }
    }

    // Pass pre-parsed header from early preview to avoid redundant parseNiiHeader call
    const preParsed = earlyPreviewHeaders.get(id);
    earlyPreviewHeaders.delete(id);
    await processRawVolume(rawData, id, signal, isGzip, preParsed);
  } finally {
    volumeControllers.delete(id);
    earlyPreviewHeaders.delete(id);
  }
}

/**
 * Streaming gzip loader: fetches the URL with a single GET, pipes the
 * response body through DecompressionStream, and emits an early preview
 * as soon as the header + first axial slice are available. The rest of
 * the volume is collected into a pre-allocated buffer.
 *
 * This overlaps network I/O with decompression and cuts time-to-preview
 * to the time needed for ~1-2% of the compressed data.
 */
async function streamingGzipLoadWithEarlyPreview(url: string, id: number, signal: AbortSignal): Promise<Uint8Array> {
  const resp = await fetchWithRetry(url, undefined, MAX_RETRIES, signal);
  if (!resp.ok) throw new Error(`Fetch failed: ${resp.status}`);
  if (!resp.body) throw new Error('No response body for streaming');

  const ds = new (self as any).DecompressionStream('gzip');
  const decompressedStream = resp.body.pipeThrough(ds);
  const reader = decompressedStream.getReader() as ReadableStreamDefaultReader<Uint8Array>;

  // Pre-allocate a growable buffer — avoids O(n) chunk concatenation
  const INITIAL_CAP = 16 * 1024 * 1024;  // 16MB initial
  let result = new Uint8Array(INITIAL_CAP);
  let writeOffset = 0;

  // Parse preview directly from result buffer — no separate previewBuf needed
  let previewSent = false;
  let header: any = null;
  let firstSliceNeeded = Infinity;

  const contentLength = Number(resp.headers.get('Content-Length') || 0);

  while (true) {
    throwIfAborted(signal);
    // Watchdog: network-fed decompressed stream — a stalled tunnel must
    // surface as TimeoutError instead of an eternal pending read().
    const { done, value } = await readStreamChunkWithWatchdog(reader, DEFAULT_IDLE_TIMEOUT_MS);
    if (done) break;

    const chunk = value!;

    // Grow result buffer if needed (geometric growth, like std::vector)
    if (writeOffset + chunk.byteLength > result.length) {
      let newCap = result.length;
      while (newCap < writeOffset + chunk.byteLength) newCap *= 2;
      const grown = new Uint8Array(newCap);
      grown.set(result.subarray(0, writeOffset), 0);
      result = grown;
    }
    result.set(chunk, writeOffset);
    writeOffset += chunk.byteLength;

    // ── Early preview: parse directly from result buffer ──
    // No separate previewBuf needed — result[0..writeOffset] is contiguous
    if (!previewSent && writeOffset >= 544) {
      try {
        const buf = result.subarray(0, writeOffset);
        header = parseNiiHeader(buf.buffer as ArrayBuffer, true);
        if (header) {
          const { nx, ny, voxOffset, bytesPerVoxel, scl_slope, scl_inter, littleEndian, datatype } = header;
          firstSliceNeeded = voxOffset + nx * ny * bytesPerVoxel;

          if (writeOffset >= firstSliceNeeded) {
            const slope = scl_slope || 1;
            const inter = scl_inter || 0;
            const le = littleEndian;
            const needsConversion = slope !== 1 || inter !== 0;
            const elemSize = datatype === 64 ? 8 : datatype === 8 || datatype === 16 || datatype === 768 ? 4 : datatype === 4 || datatype === 512 ? 2 : 1;

            const sliceStart = voxOffset;
            const axialSlice = new Float32Array(nx * ny);
            const sliceView = new DataView(buf.buffer, buf.byteOffset + sliceStart, nx * ny * bytesPerVoxel);
            const byteOff = buf.byteOffset + sliceStart;
            const canUseTA = (byteOff % elemSize === 0) && le;

            if (canUseTA && datatype === 16 && !needsConversion) {
              axialSlice.set(new Float32Array(buf.buffer, byteOff, nx * ny));
            } else if (canUseTA && datatype === 16 && needsConversion) {
              const src = new Float32Array(buf.buffer, byteOff, nx * ny);
              for (let i = 0; i < nx * ny; i++) axialSlice[i] = src[i] * slope + inter;
            } else {
              for (let i = 0; i < nx * ny; i++) {
                let val: number;
                switch (datatype) {
                  case 2: val = buf[buf.byteOffset + sliceStart + i]; break;
                  case 4: val = sliceView.getInt16(i * 2, le); break;
                  case 8: val = sliceView.getInt32(i * 4, le); break;
                  case 16: val = sliceView.getFloat32(i * 4, le); break;
                  case 64: val = sliceView.getFloat64(i * 8, le); break;
                  case 256: val = (buf[buf.byteOffset + sliceStart + i] << 24) >> 24; break;
                  case 512: val = sliceView.getUint16(i * 2, le); break;
                  case 768: val = sliceView.getUint32(i * 4, le); break;
                  default: val = 0;
                }
                axialSlice[i] = val * slope + inter;
              }
            }

            let min = Infinity, max = -Infinity;
            for (let i = 0; i < axialSlice.length; i++) {
              if (axialSlice[i] < min) min = axialSlice[i];
              if (axialSlice[i] > max) max = axialSlice[i];
            }
            if (min === max) max = min + 1;

            const coMid = Math.floor(ny / 2);
            const saMid = Math.floor(nx / 2);

            self.postMessage({
              id, type: 'preview',
              partialPreview: true,
              header,
              slices: {
                axial: axialSlice,
                coronal: new Float32Array(0),
                sagittal: new Float32Array(0),
              },
              globalMin: min, globalMax: max,
              sliceIdx: { axial: 0, coronal: coMid, sagittal: saMid },
              slope, inter,
            }, [axialSlice.buffer]);

            previewSent = true;
            earlyPreviewSent.add(id);
            self.postMessage({ id, type: 'progress', value: 0.5, stage: 'decompressing (stream)' });
          }
        }
      } catch {
        // Header not parseable yet — continue streaming
      }
    }

    // Progress updates
    if (!previewSent) {
      self.postMessage({ id, type: 'progress', value: 0.1 + (writeOffset / (contentLength * 4 || writeOffset * 2)) * 0.2, stage: 'downloading (stream)' });
    } else {
      self.postMessage({ id, type: 'progress', value: 0.5 + (writeOffset / (contentLength * 4 || writeOffset * 2)) * 0.3, stage: 'decompressing (stream)' });
    }
  }

  return result.subarray(0, writeOffset);
}

/**
 * Streaming uncompressed .nii loader: fetches the URL with a single GET,
 * emits an early preview as soon as the header + first axial slice are
 * available, and collects the rest into a pre-allocated buffer.
 */
async function streamingNiiLoadWithEarlyPreview(url: string, id: number, signal: AbortSignal): Promise<Uint8Array> {
  const resp = await fetchWithRetry(url, undefined, MAX_RETRIES, signal);
  if (!resp.ok) throw new Error(`Fetch failed: ${resp.status}`);
  if (!resp.body) throw new Error('No response body for streaming');

  const reader = resp.body.getReader();
  const contentLength = Number(resp.headers.get('Content-Length') || 0);

  // Pre-allocate if Content-Length is known
  let result: Uint8Array | null = contentLength > 0 ? new Uint8Array(contentLength) : null;
  const chunks: Uint8Array[] = [];
  let writeOffset = 0;
  let totalSize = 0;

  // Parse preview directly from result buffer — no separate previewBuf
  let previewSent = false;

  while (true) {
    throwIfAborted(signal);
    // Watchdog: raw network stream — a stalled tunnel must surface as
    // TimeoutError instead of an eternal pending read().
    const { done, value } = await readStreamChunkWithWatchdog(reader, DEFAULT_IDLE_TIMEOUT_MS);
    if (done) break;

    const chunk = value!;

    if (result) {
      if (writeOffset + chunk.byteLength <= result.length) {
        result.set(chunk, writeOffset);
      } else {
        // Overflow — fall back to chunk collection
        chunks.push(result.subarray(0, writeOffset));
        chunks.push(chunk);
        result = null;
      }
    } else {
      chunks.push(chunk);
    }
    writeOffset += chunk.byteLength;
    totalSize += chunk.byteLength;

    // Early preview — parse directly from result buffer
    if (!previewSent && writeOffset >= 544) {
      try {
        const buf = result ? result.subarray(0, writeOffset) : (() => {
          // Assemble from chunks for preview parsing
          const tmp = new Uint8Array(writeOffset);
          let off = 0;
          for (const c of chunks) { tmp.set(c, off); off += c.byteLength; }
          return tmp;
        })();
        const header = parseNiiHeader(buf.buffer as ArrayBuffer, false);
        if (header) {
          const { nx, ny, voxOffset, bytesPerVoxel, scl_slope, scl_inter, littleEndian, datatype } = header;
          const firstSliceNeeded = voxOffset + nx * ny * bytesPerVoxel;

          if (writeOffset >= firstSliceNeeded) {
            const slope = scl_slope || 1;
            const inter = scl_inter || 0;
            const le = littleEndian;
            const needsConversion = slope !== 1 || inter !== 0;
            const elemSize = datatype === 64 ? 8 : datatype === 8 || datatype === 16 || datatype === 768 ? 4 : datatype === 4 || datatype === 512 ? 2 : 1;

            const sliceStart = voxOffset;
            const axialSlice = new Float32Array(nx * ny);
            const sliceView = new DataView(buf.buffer, buf.byteOffset + sliceStart, nx * ny * bytesPerVoxel);
            const byteOff = buf.byteOffset + sliceStart;
            const canUseTA = (byteOff % elemSize === 0) && le;

            if (canUseTA && datatype === 16 && !needsConversion) {
              axialSlice.set(new Float32Array(buf.buffer, byteOff, nx * ny));
            } else if (canUseTA && datatype === 16 && needsConversion) {
              const src = new Float32Array(buf.buffer, byteOff, nx * ny);
              for (let i = 0; i < nx * ny; i++) axialSlice[i] = src[i] * slope + inter;
            } else {
              for (let i = 0; i < nx * ny; i++) {
                let val: number;
                switch (datatype) {
                  case 2: val = buf[buf.byteOffset + sliceStart + i]; break;
                  case 4: val = sliceView.getInt16(i * 2, le); break;
                  case 8: val = sliceView.getInt32(i * 4, le); break;
                  case 16: val = sliceView.getFloat32(i * 4, le); break;
                  case 64: val = sliceView.getFloat64(i * 8, le); break;
                  case 256: val = (buf[buf.byteOffset + sliceStart + i] << 24) >> 24; break;
                  case 512: val = sliceView.getUint16(i * 2, le); break;
                  case 768: val = sliceView.getUint32(i * 4, le); break;
                  default: val = 0;
                }
                axialSlice[i] = val * slope + inter;
              }
            }

            let min = Infinity, max = -Infinity;
            for (let i = 0; i < axialSlice.length; i++) {
              if (axialSlice[i] < min) min = axialSlice[i];
              if (axialSlice[i] > max) max = axialSlice[i];
            }
            if (min === max) max = min + 1;

            const coMid = Math.floor(ny / 2);
            const saMid = Math.floor(nx / 2);

            self.postMessage({
              id, type: 'preview',
              partialPreview: true,
              header,
              slices: {
                axial: axialSlice,
                coronal: new Float32Array(0),
                sagittal: new Float32Array(0),
              },
              globalMin: min, globalMax: max,
              sliceIdx: { axial: 0, coronal: coMid, sagittal: saMid },
              slope, inter,
            }, [axialSlice.buffer]);

            previewSent = true;
            earlyPreviewSent.add(id);
            self.postMessage({ id, type: 'progress', value: 0.5, stage: 'downloading (stream)' });
          }
        }
      } catch {
        // Header not parseable yet
      }
    }

    // Progress
    if (contentLength > 0) {
      const pct = writeOffset / contentLength;
      if (!previewSent) {
        self.postMessage({ id, type: 'progress', value: 0.02 + pct * 0.5, stage: 'downloading (stream)' });
      } else {
        self.postMessage({ id, type: 'progress', value: 0.5 + pct * 0.35, stage: 'downloading (stream)' });
      }
    }
  }

  // Assemble final result
  if (result) {
    if (writeOffset !== contentLength && contentLength > 0) {
      return result.subarray(0, writeOffset);
    }
    return result;
  }

  const final = new Uint8Array(totalSize);
  let offset = 0;
  for (const chunk of chunks) {
    final.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return final;
}

async function nativeDecompressFromBuffer(compressed: Uint8Array, signal?: AbortSignal): Promise<Uint8Array> {
  const ds = new (self as any).DecompressionStream('gzip');
  const writer = ds.writable.getWriter();
  const reader = ds.readable.getReader() as ReadableStreamDefaultReader<Uint8Array>;

  // Parallelize writing and reading — the writer feeds compressed data
  // into the DecompressionStream while the reader consumes decompressed
  // output concurrently. This overlaps CPU (decompress) with I/O (write)
  // and cuts latency roughly in half for large buffers.
  const writePromise = (async () => {
    const CHUNK = 4 * 1024 * 1024;
    let off = 0;
    while (off < compressed.length) {
      throwIfAborted(signal);
      const end = Math.min(off + CHUNK, compressed.length);
      await writer.write(compressed.subarray(off, end));
      off = end;
    }
    await writer.close();
  })();

  const estimatedSize = compressed.length * 4;
  let result = new Uint8Array(Math.max(estimatedSize, 16 * 1024 * 1024));
  let writeOffset = 0;

  while (true) {
    throwIfAborted(signal);
    const { done, value } = await reader.read();
    if (done) break;

    if (writeOffset + value.byteLength > result.length) {
      let newCap = result.length;
      while (newCap < writeOffset + value.byteLength) newCap *= 2;
      const grown = new Uint8Array(newCap);
      grown.set(result.subarray(0, writeOffset), 0);
      result = grown;
    }
    result.set(value, writeOffset);
    writeOffset += value.byteLength;
  }

  await writePromise;
  return result.subarray(0, writeOffset);
}

async function handleLoadVolumeFromData(id: number, message: { rawData: ArrayBuffer; isGzip?: boolean }): Promise<void> {
  cancelVolumeLoad(id);
  const controller = new AbortController();
  volumeControllers.set(id, controller);
  const signal = controller.signal;

  try {
    self.postMessage({ id, type: 'progress', value: 0.5, stage: 'parsing' });
    throwIfAborted(signal);

    let rawData: Uint8Array;
    if (message.isGzip) {
      const compressed = new Uint8Array(message.rawData);
      if (typeof (self as any).DecompressionStream !== 'undefined') {
        const ds = new (self as any).DecompressionStream('gzip');
        const writer = ds.writable.getWriter();
        writer.write(compressed);
        writer.close();
        const reader = ds.readable.getReader();
        const chunks: Uint8Array[] = [];
        let totalSize = 0;
        while (true) {
          throwIfAborted(signal);
          const { done, value } = await reader.read();
          if (done) break;
          chunks.push(value);
          totalSize += value.byteLength;
        }
        rawData = new Uint8Array(totalSize);
        let offset = 0;
        for (const chunk of chunks) {
          rawData.set(chunk, offset);
          offset += chunk.byteLength;
        }
      } else {
        rawData = await new Promise<Uint8Array>((resolve, reject) => {
          gunzip(compressed, (err, data) => {
            if (err) reject(err);
            else resolve(data);
          });
        });
        throwIfAborted(signal);
      }
    } else {
      rawData = new Uint8Array(message.rawData);
    }

    throwIfAborted(signal);

    await processRawVolume(rawData, id, signal, !!message.isGzip);
  } finally {
    volumeControllers.delete(id);
  }
}

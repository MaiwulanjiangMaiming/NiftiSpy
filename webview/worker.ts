import { gunzip } from 'fflate';
import { parseNiiHeader } from './nii-parser';
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
const REMOTE_MAX_CONCURRENT = 12;
type SliceAxis = 'axial' | 'coronal' | 'sagittal';
const volumeControllers = new Map<number, AbortController>();
const pendingSliceFetches = new Map<string, Promise<CachedSlice>>();
const headCache = new Map<string, { totalSize: number; acceptRanges: boolean }>();
// Track which volume IDs have already received an early preview
const earlyPreviewSent = new Set<number>();

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

// OffscreenCanvas rendering state
const offscreenCanvases = new Map<string, { canvas: OffscreenCanvas; gl: WebGL2RenderingContext | null }>();

self.onmessage = async (e: MessageEvent) => {
  const { id, type, url, isGzip } = e.data;
  try {
    if (type === 'loadVolume') {
      await handleLoadVolume(id, url, isGzip);
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
    } else if (type === 'initOffscreenCanvas') {
      handleInitOffscreenCanvas(e.data);
    } else if (type === 'renderRequest') {
      handleRenderRequest(e.data);
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

function handleInitOffscreenCanvas(data: { axis: string; canvas: OffscreenCanvas }): void {
  const { axis, canvas } = data;
  try {
    const gl = canvas.getContext('webgl2', { premultipliedAlpha: false, preserveDrawingBuffer: true }) as WebGL2RenderingContext | null;
    if (gl) {
      offscreenCanvases.set(axis, { canvas, gl });
    }
  } catch {
    // OffscreenCanvas WebGL2 context creation failed; skip
  }
}

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

function handleRenderRequest(data: { axis: string; sliceIndex: number; windowLevel: number; windowWidth: number; colormap: string; flipX: boolean; flipY: boolean }): void {
  const { axis } = data;
  // OffscreenCanvas rendering not yet implemented — signal failure
  // so main thread falls back to direct rendering
  self.postMessage({ type: 'renderComplete', axis, fallback: true });
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
      const resp = await fetch(url, { ...options, signal });
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
  const payload = new Float32Array(slice.data);
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
    const { done, value } = await reader.read();
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
    const { done, value } = await reader.read();
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
              const resp = await fetchWithRetry(url, {
                headers: { Range: `bytes=${off}-${end}` },
              }, MAX_RETRIES, signal);
              if (resp.status === 206 || resp.status === 200) {
                const chunkData = new Uint8Array(await resp.arrayBuffer());
                result.set(chunkData, off);
                received += chunkData.byteLength;
                const progressBase = 0.02;
                const progressRange = isGzip ? 0.3 : 0.7;
                self.postMessage({
                  id, type: 'progress',
                  value: progressBase + (received / totalSize) * progressRange,
                  stage: 'downloading',
                });
              }
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

  if (contentLength > 0 && resp.body) {
    const reader = resp.body.getReader();

    // Pre-allocate result buffer if contentLength is known
    const result = new Uint8Array(contentLength);
    let received = 0;

    while (true) {
      throwIfAborted(signal);
      const { done, value } = await reader.read();
      if (done) break;
      result.set(value, received);
      received += value.byteLength;
      self.postMessage({
        id, type: 'progress',
        value: 0.02 + (received / contentLength) * (isGzip ? 0.3 : 0.7),
        stage: 'downloading',
      });
    }

    // If actual received differs from contentLength, trim the buffer
    if (received !== contentLength) {
      return result.slice(0, received);
    }
    return result;
  }

  return new Uint8Array(await resp.arrayBuffer());
}

async function processRawVolume(rawData: Uint8Array, id: number, signal: AbortSignal, isGzip: boolean): Promise<void> {
  const header = parseNiiHeader(rawData.buffer as ArrayBuffer, isGzip);

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

async function handleLoadVolume(id: number, url: string, isGzip: boolean) {
  cancelVolumeLoad(id);
  const controller = new AbortController();
  volumeControllers.set(id, controller);
  const signal = controller.signal;
  try {
    self.postMessage({ id, type: 'progress', value: 0.02, stage: 'downloading' });

    const hasNativeDecompress = typeof (self as any).DecompressionStream !== 'undefined';
    let rawData: Uint8Array;

    if (isGzip && hasNativeDecompress) {
      // ── Streaming path: overlap download + decompress + early preview ──
      // This is the fast path for .nii.gz: a single streaming GET is piped
      // through DecompressionStream. Preview is emitted as soon as the first
      // axial slice is available (typically <2% of data), and the rest of
      // the volume streams in concurrently. This cuts time-to-preview from
      // "full download + full decompress" to "header + first slice".
      try {
        rawData = await streamingGzipLoadWithEarlyPreview(url, id, signal);
        throwIfAborted(signal);
        self.postMessage({ id, type: 'progress', value: 0.85, stage: 'processing' });
      } catch (err: any) {
        if (err?.name === 'AbortError') throw err;
        // Fall back to parallel chunked download + buffer decompress
        const compressedData = await downloadChunked(url, id, isGzip, signal);
        self.postMessage({ id, type: 'progress', value: 0.35, stage: 'decompressing' });
        throwIfAborted(signal);
        rawData = await nativeDecompressFromBuffer(compressedData, signal);
        throwIfAborted(signal);
        self.postMessage({ id, type: 'progress', value: 0.7, stage: 'parsing' });
      }
    } else if (isGzip) {
      // No DecompressionStream — must use fflate
      const compressedData = await downloadChunked(url, id, isGzip, signal);
      self.postMessage({ id, type: 'progress', value: 0.35, stage: 'decompressing' });
      throwIfAborted(signal);
      rawData = await new Promise<Uint8Array>((resolve, reject) => {
        gunzip(compressedData, (err, data) => {
          if (err) reject(err);
          else resolve(data);
        });
      });
      throwIfAborted(signal);
      self.postMessage({ id, type: 'progress', value: 0.7, stage: 'parsing' });
    } else {
      // Uncompressed .nii — try streaming with early preview first
      try {
        rawData = await streamingNiiLoadWithEarlyPreview(url, id, signal);
        throwIfAborted(signal);
        self.postMessage({ id, type: 'progress', value: 0.85, stage: 'processing' });
      } catch (err: any) {
        if (err?.name === 'AbortError') throw err;
        // Fall back to parallel chunked download
        rawData = await downloadChunked(url, id, isGzip, signal);
        self.postMessage({ id, type: 'progress', value: 0.7, stage: 'parsing' });
      }
    }

    await processRawVolume(rawData, id, signal, isGzip);
  } finally {
    volumeControllers.delete(id);
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
    const { done, value } = await reader.read();
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
    const { done, value } = await reader.read();
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
  // Write in reasonably-sized chunks to avoid back-pressure on the writable stream.
  const CHUNK = 4 * 1024 * 1024;
  let off = 0;
  while (off < compressed.length) {
    throwIfAborted(signal);
    const end = Math.min(off + CHUNK, compressed.length);
    await writer.write(compressed.subarray(off, end));
    off = end;
  }
  await writer.close();

  const reader = ds.readable.getReader() as ReadableStreamDefaultReader<Uint8Array>;

  // Pre-allocate a growable buffer — typical gzip ratio is 3-5x,
  // so start with 4x the compressed size to avoid reallocations.
  const estimatedSize = compressed.length * 4;
  let result = new Uint8Array(Math.max(estimatedSize, 16 * 1024 * 1024));
  let writeOffset = 0;

  while (true) {
    throwIfAborted(signal);
    const { done, value } = await reader.read();
    if (done) break;

    // Grow buffer if needed (geometric growth)
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

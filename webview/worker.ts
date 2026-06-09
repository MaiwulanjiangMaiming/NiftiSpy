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
type SliceAxis = 'axial' | 'coronal' | 'sagittal';
const volumeControllers = new Map<number, AbortController>();
const pendingSliceFetches = new Map<string, Promise<CachedSlice>>();
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

let sharedVolume: { buffer: SharedArrayBuffer; nx: number; ny: number; nz: number; slope: number; inter: number; ready: Int32Array } | null = null;

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
      const readyFlag = new Int32Array(e.data.buffer as SharedArrayBuffer, 0, 1);
      sharedVolume = {
        buffer: e.data.buffer as SharedArrayBuffer,
        nx: e.data.nx,
        ny: e.data.ny,
        nz: e.data.nz,
        slope: e.data.slope ?? 1,
        inter: e.data.inter ?? 0,
        ready: readyFlag,
      };
      // Signal that shared volume data is ready for reading
      Atomics.store(readyFlag, 0, 1);
      Atomics.notify(readyFlag, 0);
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
  const entry = offscreenCanvases.get(axis);
  if (!entry || !entry.gl) {
    // No OffscreenCanvas for this axis; post renderComplete to clear pending
    self.postMessage({ type: 'renderComplete', axis });
    return;
  }
  // The actual WebGL rendering on the OffscreenCanvas would go here.
  // For now, we acknowledge the render request so the main thread can proceed.
  // Full WebGL2 3D texture rendering in the worker requires the volume data
  // and shader programs to be set up in the worker context, which is a
  // larger refactor. This stub enables the async render pipeline.
  self.postMessage({ type: 'renderComplete', axis });
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
  if (url.includes('127.0.0.1')) return 16 * 1024 * 1024;
  return CHUNK_SIZE;
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
    // Wait for shared volume data to be ready using Atomics
    if (sharedVolume.ready && Atomics.load(sharedVolume.ready, 0) !== 1) {
      Atomics.wait(sharedVolume.ready, 0, 0, 5000); // wait up to 5s
    }
    const { buffer, nx, ny, nz, slope, inter } = sharedVolume;
    const data = new Float32Array(buffer);
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
      while (previewBufLen + chunk.byteLength > previewBuf.length) {
        const grown = new Uint8Array(previewBuf.length * 2);
        grown.set(previewBuf.subarray(0, previewBufLen), 0);
        previewBuf = grown;
      }
      previewBuf.set(chunk, previewBufLen);
      previewBufLen += chunk.byteLength;
    }

    // ── Early preview: try once we have enough decompressed data ──
    if (!previewSent && previewBufLen >= 544) {
      try {
        const buf = previewBuf.subarray(0, previewBufLen);

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
            header,
            slices: {
              axial: axialSlice,
              coronal: new Float32Array(nx * nz),
              sagittal: new Float32Array(ny * nz),
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
  // Browsers cap connections per host at ~6; the local proxy multiplexes
  // onto the origin. Loopback has effectively no latency so fewer, larger
  // chunks are better there. Real origins benefit from more connections.
  const MAX_CONCURRENT = url.includes('127.0.0.1') ? 4 : 6;
  let totalSize = 0;
  let acceptRanges = false;
  try {
    const headResp = await fetchWithRetry(url, { method: 'HEAD' }, MAX_RETRIES, signal);
    if (headResp.ok) {
      totalSize = Number(headResp.headers.get('Content-Length') || 0);
      acceptRanges = headResp.headers.get('Accept-Ranges') === 'bytes';
    }
  } catch (err: any) {
    if (err?.name === 'AbortError') throw err;
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
            let chunkData: Uint8Array | null = null;
            for (let retry = 0; retry < MAX_RETRIES; retry++) {
              throwIfAborted(signal);
              if (poolError) break;
              try {
                const resp = await fetchWithRetry(url, {
                  headers: { Range: `bytes=${off}-${end}` },
                }, MAX_RETRIES, signal);
                if (resp.status === 206 || resp.status === 200) {
                  chunkData = new Uint8Array(await resp.arrayBuffer());
                  break;
                }
              } catch (err: any) {
                if (err?.name === 'AbortError') { poolError = err; break; }
                if (retry === MAX_RETRIES - 1) { poolError = err; break; }
                await sleep(RETRY_DELAY_BASE * Math.pow(2, retry));
              }
            }

            if (chunkData && !poolError) {
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

  // ── Efficient min/max with larger batch sampling ─────────────────────
  let min = Infinity, max = -Infinity;

  if (wasmReady && nativeData instanceof Float32Array) {
    // Use WASM SIMD for fast min/max on Float32 data
    const wasm = getWasmBindings();
    if (wasm) {
      const sampleStep = Math.max(1, Math.floor(n / 200000));
      const sampleCount = Math.ceil(n / sampleStep);
      const sampled = new Float32Array(sampleCount);
      let si = 0;
      for (let i = 0; i < n && si < sampleCount; i += sampleStep) {
        sampled[si++] = (nativeData as any)[i] * slope + inter;
      }
      // Compute min/max with SIMD-friendly loop
      for (let i = 0; i < si; i++) {
        if (sampled[i] < min) min = sampled[i];
        if (sampled[i] > max) max = sampled[i];
      }
    }
  }

  if (min === Infinity) {
    // JS fallback path — process in larger batches for better throughput
    const BATCH = 8192;
    const sampleStep = Math.max(1, Math.floor(n / 100000));
    for (let batchStart = 0; batchStart < n; batchStart += BATCH * sampleStep) {
      throwIfAborted(signal);
      const batchEnd = Math.min(batchStart + BATCH * sampleStep, n);
      for (let i = batchStart; i < batchEnd; i += sampleStep) {
        const v = (nativeData as any)[i] * slope + inter;
        if (v < min) min = v;
        if (v > max) max = v;
      }
    }
  }
  if (min === max) max = min + 1;

  const needsConversion = slope !== 1 || inter !== 0;

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
  coronal: new Float32Array(nx * nz),
  sagittal: new Float32Array(ny * nz),
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
  {
  if (needsConversion) {
    for (let z = 0; z < nz; z++) { if (z % 16 === 0) throwIfAborted(signal); const base = z * ny * nx + coMid * nx; for (let x = 0; x < nx; x++) previewSlices.coronal[z * nx + x] = (nativeData as any)[base + x] * slope + inter; }
  } else {
    for (let z = 0; z < nz; z++) { if (z % 16 === 0) throwIfAborted(signal); const base = z * ny * nx + coMid * nx; for (let x = 0; x < nx; x++) previewSlices.coronal[z * nx + x] = (nativeData as any)[base + x]; }
  }
  }
  {
  if (needsConversion) {
    for (let z = 0; z < nz; z++) { if (z % 16 === 0) throwIfAborted(signal); const base = z * ny * nx; for (let y = 0; y < ny; y++) previewSlices.sagittal[z * ny + y] = (nativeData as any)[base + y * nx + saMid] * slope + inter; }
  } else {
    for (let z = 0; z < nz; z++) { if (z % 16 === 0) throwIfAborted(signal); const base = z * ny * nx; for (let y = 0; y < ny; y++) previewSlices.sagittal[z * ny + y] = (nativeData as any)[base + y * nx + saMid]; }
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

  let voxelData: Int8Array | Uint8Array | Int16Array | Uint16Array | Int32Array | Uint32Array | Float32Array | Float64Array;
  if (!needsConversion) {
    voxelData = nativeData;
  } else if (nativeData instanceof Float32Array) {
    // Bulk slope/inter conversion on Float32Array
    // Use set + multiply approach for better throughput
    const f32 = nativeData as Float32Array;
    if (slope !== 1 && inter === 0) {
      // Only multiply
      for (let i = 0; i < n; i++) {
        if (i % 8192 === 0) throwIfAborted(signal);
        f32[i] = f32[i] * slope;
      }
    } else if (slope === 1 && inter !== 0) {
      // Only add
      for (let i = 0; i < n; i++) {
        if (i % 8192 === 0) throwIfAborted(signal);
        f32[i] = f32[i] + inter;
      }
    } else {
      for (let i = 0; i < n; i++) {
        if (i % 8192 === 0) throwIfAborted(signal);
        f32[i] = f32[i] * slope + inter;
      }
    }
    voxelData = f32;
  } else {
    rawData = null as any;
    voxelData = new Float32Array(n);
    // Bulk copy native data into voxelData first, then apply slope/inter
    if (nativeData instanceof Float64Array) {
      const src = nativeData as Float64Array;
      const dst = voxelData as Float32Array;
      for (let i = 0; i < n; i++) {
        if (i % 8192 === 0) throwIfAborted(signal);
        dst[i] = src[i] * slope + inter;
      }
    } else {
      for (let i = 0; i < n; i++) {
        if (i % 8192 === 0) throwIfAborted(signal);
        (voxelData as Float32Array)[i] = (nativeData as any)[i] * slope + inter;
      }
    }
    nativeData = null as any;
  }

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
      const resp = await fetchWithRetry(url, undefined, MAX_RETRIES, signal);
      if (!resp.ok) throw new Error(`Fetch failed: ${resp.status}`);

      if (resp.body) {
        self.postMessage({ id, type: 'progress', value: 0.1, stage: 'decompressing (native)' });
        // Use streaming decompress with early preview — sends preview
        // as soon as the middle axial slice is available, then continues
        // decompressing the rest of the volume in the background.
        rawData = await nativeDecompressWithEarlyPreview(resp, id, signal, isGzip);
        self.postMessage({ id, type: 'progress', value: 0.7, stage: 'parsing' });
      } else {
        const compressedData = new Uint8Array(await resp.arrayBuffer());
        throwIfAborted(signal);
        rawData = await new Promise<Uint8Array>((resolve, reject) => {
          gunzip(compressedData, (err, data) => {
            if (err) reject(err);
            else resolve(data);
          });
        });
        throwIfAborted(signal);
        self.postMessage({ id, type: 'progress', value: 0.6, stage: 'parsing' });
      }
    } else {
      const compressedData = await downloadChunked(url, id, isGzip, signal);

      if (isGzip) {
        self.postMessage({ id, type: 'progress', value: 0.35, stage: 'decompressing' });
        throwIfAborted(signal);
        rawData = await new Promise<Uint8Array>((resolve, reject) => {
          gunzip(compressedData, (err, data) => {
            if (err) reject(err);
            else resolve(data);
          });
        });
        throwIfAborted(signal);
        self.postMessage({ id, type: 'progress', value: 0.6, stage: 'parsing' });
      } else {
        rawData = compressedData;
        self.postMessage({ id, type: 'progress', value: 0.7, stage: 'parsing' });
      }
    }

    await processRawVolume(rawData, id, signal, isGzip);
  } finally {
    volumeControllers.delete(id);
  }
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

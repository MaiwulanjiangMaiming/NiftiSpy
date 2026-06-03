import { gunzip } from 'fflate';
import { parseNiiHeader } from './nii-parser';
import { getCachedChunk, setCachedChunk, makeCacheKey, recordCacheHit, recordCacheMiss, recordL4Fetch } from './cache';

const MAX_RETRIES = 3;
const CHUNK_SIZE = 4 * 1024 * 1024;
const RETRY_DELAY_BASE = 500;
const MAX_SLICE_CACHE = 96;
type SliceAxis = 'axial' | 'coronal' | 'sagittal';
const volumeControllers = new Map<number, AbortController>();
const pendingSliceFetches = new Map<string, Promise<CachedSlice>>();

interface CachedSlice {
  data: Float32Array;
  width: number;
  height: number;
  timestamp: number;
}

const sliceCache = new Map<string, CachedSlice>();

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
  if (url.includes('127.0.0.1')) return 8 * 1024 * 1024;
  return CHUNK_SIZE;
}

async function fetchSlice(url: string, axis: SliceAxis, index: number, factor: number): Promise<CachedSlice> {
  const cached = getCachedSlice(url, axis, index, factor);
  if (cached) return cached;
  const cacheKey = getSliceCacheKey(url, axis, index, factor);
  const pending = pendingSliceFetches.get(cacheKey);
  if (pending) return pending;

  const request = (async () => {
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
    const resp = await fetchWithRetry(buildSliceUrl(url, axis, index, factor));
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

  const slice = await fetchSlice(message.url, message.axis, message.index, factor);
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
      void fetchSlice(message.url, message.axis, nextIndex, factor).catch(() => {});
    }
  }
}

async function nativeDecompress(resp: Response, signal?: AbortSignal): Promise<Uint8Array> {
  const ds = new (self as any).DecompressionStream('gzip');
  const decompressedStream = resp.body!.pipeThrough(ds);
  const reader = decompressedStream.getReader() as ReadableStreamDefaultReader<Uint8Array>;
  const chunks: Uint8Array[] = [];
  let totalSize = 0;
  while (true) {
    throwIfAborted(signal);
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value!);
    totalSize += value!.byteLength;
  }
  const result = new Uint8Array(totalSize);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}

async function downloadChunked(url: string, id: number, isGzip: boolean, signal?: AbortSignal): Promise<Uint8Array> {
  const chunkSize = getPreferredChunkSize(url);
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
    const chunks: Uint8Array[] = [];
    let received = 0;
    let offset = 0;

    while (offset < totalSize) {
      throwIfAborted(signal);
      const end = Math.min(offset + chunkSize - 1, totalSize - 1);
      let chunkData: Uint8Array | null = null;

      for (let retry = 0; retry < MAX_RETRIES; retry++) {
        try {
          const resp = await fetchWithRetry(url, {
            headers: { Range: `bytes=${offset}-${end}` },
          }, MAX_RETRIES, signal);
          if (resp.status === 206 || resp.status === 200) {
            chunkData = new Uint8Array(await resp.arrayBuffer());
            break;
          }
        } catch (err) {
          if (retry === MAX_RETRIES - 1) throw err;
          await sleep(RETRY_DELAY_BASE * Math.pow(2, retry));
        }
      }

      if (!chunkData) throw new Error('Failed to download chunk');

      chunks.push(chunkData);
      received += chunkData.byteLength;
      offset = end + 1;

      const progressBase = 0.02;
      const progressRange = isGzip ? 0.3 : 0.7;
      self.postMessage({
        id, type: 'progress',
        value: progressBase + (received / totalSize) * progressRange,
        stage: 'downloading',
      });
    }

    const total = chunks.reduce((s, c) => s + c.byteLength, 0);
    const result = new Uint8Array(total);
    let pos = 0;
    for (const chunk of chunks) {
      result.set(chunk, pos);
      pos += chunk.byteLength;
    }
    return result;
  }

  const resp = await fetchWithRetry(url, undefined, MAX_RETRIES, signal);
  if (!resp.ok) throw new Error(`Fetch failed: ${resp.status}`);

  const contentLength = Number(resp.headers.get('Content-Length') || 0);

  if (contentLength > 0 && resp.body) {
    const reader = resp.body.getReader();
    const chunks: Uint8Array[] = [];
    let received = 0;

    while (true) {
      throwIfAborted(signal);
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      received += value.byteLength;
      self.postMessage({
        id, type: 'progress',
        value: 0.02 + (received / contentLength) * (isGzip ? 0.3 : 0.7),
        stage: 'downloading',
      });
    }

    const total = chunks.reduce((s, c) => s + c.byteLength, 0);
    const result = new Uint8Array(total);
    let pos = 0;
    for (const chunk of chunks) {
      result.set(chunk, pos);
      pos += chunk.byteLength;
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
  case 2: nativeData = canUseTypedArray ? new Uint8Array(rawData.buffer, byteOff, n) : new Uint8Array(rawData.buffer, byteOff, n); break;
  case 4: nativeData = canUseTypedArray ? new Int16Array(rawData.buffer, byteOff, n) : new Int16Array(n); break;
  case 8: nativeData = canUseTypedArray ? new Int32Array(rawData.buffer, byteOff, n) : new Int32Array(n); break;
  case 16: nativeData = canUseTypedArray ? new Float32Array(rawData.buffer, byteOff, n) : new Float32Array(n); break;
  case 64: nativeData = canUseTypedArray ? new Float64Array(rawData.buffer, byteOff, n) : new Float64Array(n); break;
  case 256: nativeData = canUseTypedArray ? new Int8Array(rawData.buffer, byteOff, n) : new Int8Array(n); break;
  case 512: nativeData = canUseTypedArray ? new Uint16Array(rawData.buffer, byteOff, n) : new Uint16Array(n); break;
  case 768: nativeData = canUseTypedArray ? new Uint32Array(rawData.buffer, byteOff, n) : new Uint32Array(n); break;
  default: nativeData = new Float32Array(n); break;
  }

  if (!canUseTypedArray && datatype !== 2 && datatype !== 256) {
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

  self.postMessage({ id, type: 'progress', value: 0.7, stage: 'computing range' });

  let min = Infinity, max = -Infinity;
  const sampleStep = Math.max(1, Math.floor(n / 50000));
  for (let i = 0; i < n; i += sampleStep) {
  throwIfAborted(signal);
  const v = (nativeData as any)[i] * slope + inter;
  if (v < min) min = v;
  if (v > max) max = v;
  }
  if (min === max) max = min + 1;

  const needsConversion = slope !== 1 || inter !== 0;

  self.postMessage({ id, type: 'progress', value: 0.75, stage: 'preview' });

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
  if (needsConversion) {
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

  self.postMessage({ id, type: 'progress', value: 0.85, stage: 'transferring volume' });

  let voxelData: Int8Array | Uint8Array | Int16Array | Uint16Array | Int32Array | Uint32Array | Float32Array | Float64Array;
  if (!needsConversion) {
    voxelData = nativeData;
  } else if (nativeData instanceof Float32Array) {
    for (let i = 0; i < n; i++) {
      if (i % 4096 === 0) throwIfAborted(signal);
      nativeData[i] = nativeData[i] * slope + inter;
    }
    voxelData = nativeData;
  } else {
    rawData = null as any;
    voxelData = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      if (i % 4096 === 0) throwIfAborted(signal);
      voxelData[i] = (nativeData as any)[i] * slope + inter;
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
        rawData = await nativeDecompress(resp, signal);
        self.postMessage({ id, type: 'progress', value: 0.6, stage: 'parsing' });
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

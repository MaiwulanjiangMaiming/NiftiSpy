import { encodeSliceFrame, decodeSliceFrame, decodeRawSlice } from '../sliceFrame';
import { getCachedChunk, setCachedChunk, makeCacheKey, recordCacheHit, recordCacheMiss, recordL4Fetch } from '../cache';
import { SliceCacheDB, makeSliceCacheKey } from '../SliceCacheDB';

export type SliceAxis = 'axial' | 'coronal' | 'sagittal';

interface CachedSlice {
  data: Float32Array;
  width: number;
  height: number;
  timestamp: number;
}

export interface SharedVolume {
  buffer: SharedArrayBuffer;
  nx: number;
  ny: number;
  nz: number;
  slope: number;
  inter: number;
  datatype: number;
}

/** Everything the slice subsystem needs from the worker message loop. */
export interface SliceDeps {
  fetchWithRetry(url: string, options?: RequestInit, retries?: number, signal?: AbortSignal): Promise<Response>;
  abortError(): Error;
  ensureSliceCacheDB(): Promise<SliceCacheDB>;
  getSharedVolume(): SharedVolume | null;
  getFileHash(): string;
  postMessage(message: unknown, transfer?: Transferable[]): void;
  maxRetries: number;
  maxSliceCache: number;
}

const VOLUME_BUFFER_HEADER_BYTES = 8;

function createVolumeView(
  buffer: SharedArrayBuffer,
  datatype: number,
  length: number,
): Int8Array | Uint8Array | Int16Array | Uint16Array | Int32Array | Uint32Array | Float32Array | Float64Array {
  const byteOffset = VOLUME_BUFFER_HEADER_BYTES;
  switch (datatype) {
    case 2:
      return new Uint8Array(buffer, byteOffset, length);
    case 4:
      return new Int16Array(buffer, byteOffset, length);
    case 8:
      return new Int32Array(buffer, byteOffset, length);
    case 16:
      return new Float32Array(buffer, byteOffset, length);
    case 64:
      return new Float64Array(buffer, byteOffset, length);
    case 256:
      return new Int8Array(buffer, byteOffset, length);
    case 512:
      return new Uint16Array(buffer, byteOffset, length);
    case 768:
      return new Uint32Array(buffer, byteOffset, length);
    default:
      return new Float32Array(buffer, byteOffset, length);
  }
}

/**
 * Slice transport + three-level cache: in-memory LRU, the new persistent
 * SliceCacheDB, then the legacy IndexedDB cache. A transferable payload is
 * removed from the in-memory cache after postMessage because the buffer
 * becomes detached.
 */
export class SliceService {
  private readonly pendingSliceFetches = new Map<string, Promise<CachedSlice>>();
  private readonly sliceCache = new Map<string, CachedSlice>();

  constructor(private readonly deps: SliceDeps) {}

  private getSliceCacheKey(
    url: string,
    axis: SliceAxis,
    index: number,
    factor: number,
    timeIdx = 0,
    identity = this.deps.getFileHash(),
  ): string {
    return `${identity}|${url}|${axis}|${index}|${factor}|t${timeIdx}`;
  }

  getCachedSlice(url: string, axis: SliceAxis, index: number, factor: number, timeIdx = 0): CachedSlice | null {
    const key = this.getSliceCacheKey(url, axis, index, factor, timeIdx);
    const cached = this.sliceCache.get(key);
    if (!cached) return null;
    this.sliceCache.delete(key);
    this.sliceCache.set(key, { ...cached, timestamp: Date.now() });
    return cached;
  }

  private setCachedSlice(
    url: string,
    axis: SliceAxis,
    index: number,
    factor: number,
    slice: CachedSlice,
    timeIdx = 0,
    identity = this.deps.getFileHash(),
  ): void {
    const key = this.getSliceCacheKey(url, axis, index, factor, timeIdx, identity);
    this.sliceCache.delete(key);
    this.sliceCache.set(key, slice);
    while (this.sliceCache.size > this.deps.maxSliceCache) {
      const firstKey = this.sliceCache.keys().next().value;
      if (!firstKey) break;
      this.sliceCache.delete(firstKey);
    }
  }

  buildSliceUrl(url: string, axis: SliceAxis, index: number, factor: number, timeIdx = 0): string {
    const sliceUrl = new URL(url.replace('/file/', '/slice/') + `/${axis}/${index}`);
    if (factor > 1) sliceUrl.searchParams.set('factor', String(factor));
    if (timeIdx > 0) sliceUrl.searchParams.set('t', String(timeIdx));
    return sliceUrl.toString();
  }

  async fetchSlice(
    url: string,
    axis: SliceAxis,
    index: number,
    factor: number,
    signal?: AbortSignal,
    timeIdx = 0,
  ): Promise<CachedSlice> {
    const cached = this.getCachedSlice(url, axis, index, factor, timeIdx);
    if (cached) return cached;
    const cacheKey = this.getSliceCacheKey(url, axis, index, factor, timeIdx);
    const pending = this.pendingSliceFetches.get(cacheKey);
    if (pending) return pending;

    const fileHash = this.deps.getFileHash();
    const request = (async () => {
      // Check new SliceCacheDB first (primary L3 disk cache)
      if (fileHash) {
        try {
          const db = await this.deps.ensureSliceCacheDB();
          const dbKey = makeSliceCacheKey(fileHash, axis, index, timeIdx, factor);
          const dbData = await db.get(dbKey);
          const frame = dbData ? decodeSliceFrame(dbData, factor) : null;
          if (frame) {
            recordCacheHit('l3');
            const slice: CachedSlice = { ...frame, timestamp: Date.now() };
            this.setCachedSlice(url, axis, index, factor, slice, timeIdx, fileHash);
            return slice;
          }
        } catch {
          // SliceCacheDB not available; fall through
        }
      }

      // Fall back to legacy IndexedDB cache
      const idbKey = `v2|${fileHash}|${makeCacheKey(url, axis, index)}|t${timeIdx}|f${factor}`;
      const idbData = await getCachedChunk(idbKey);
      const legacyFrame = idbData ? decodeSliceFrame(idbData, factor) : null;
      if (legacyFrame) {
        recordCacheHit('l3');
        const slice: CachedSlice = { ...legacyFrame, timestamp: Date.now() };
        this.setCachedSlice(url, axis, index, factor, slice, timeIdx, fileHash);
        return slice;
      }
      recordCacheMiss('l3');

      const startedAt = performance.now();
      recordL4Fetch();
      if (signal?.aborted) throw this.deps.abortError();
      const resp = await this.deps.fetchWithRetry(
        this.buildSliceUrl(url, axis, index, factor, timeIdx),
        undefined,
        this.deps.maxRetries,
        signal,
      );
      if (!resp.ok) {
        throw new Error(`Slice fetch failed: ${resp.status}`);
      }

      const headersAt = performance.now();
      const width = Number(resp.headers.get('X-Width') || 0);
      const height = Number(resp.headers.get('X-Height') || 0);
      const buffer = await resp.arrayBuffer();
      const decodeAt = performance.now();
      let data: Float32Array;
      if (resp.headers.get('X-NiftiSpy-Slice-Format') === 'raw') {
        const decoded = decodeRawSlice(
          buffer,
          Number(resp.headers.get('X-NiftiSpy-Dtype') || 0),
          Number(resp.headers.get('X-NiftiSpy-Slope') || 1),
          Number(resp.headers.get('X-NiftiSpy-Inter') || 0),
          width,
          height,
        );
        if (!decoded) throw new Error('Invalid raw slice dimensions or payload');
        data = decoded;
      } else {
        if (!width || !height || buffer.byteLength !== width * height * 4)
          throw new Error('Invalid slice dimensions or payload');
        data = new Float32Array(buffer);
      }
      const persisted = encodeSliceFrame(data, width, height, factor);
      const slice: CachedSlice = {
        data,
        width,
        height,
        timestamp: Date.now(),
      };
      this.setCachedSlice(url, axis, index, factor, slice, timeIdx, fileHash);

      // Store in new SliceCacheDB (primary)
      if (fileHash) {
        try {
          const db = await this.deps.ensureSliceCacheDB();
          const dbKey = makeSliceCacheKey(fileHash, axis, index, timeIdx, factor);
          db.put(dbKey, persisted).catch(() => {});
          db.evictLRU().catch(() => {});
        } catch {
          /* An unavailable disk cache must not fail a successful slice fetch. */
        }
      }

      // Also store in legacy cache for backward compatibility
      setCachedChunk(idbKey, persisted).catch(() => {});

      this.deps.postMessage({
        id: -1,
        type: 'bandwidthSample',
        bytes: Number(resp.headers.get('Content-Length')) || buffer.byteLength,
        durationMs: Math.max(1, decodeAt - headersAt),
        timing: {
          ttfbMs: headersAt - startedAt,
          transferMs: decodeAt - headersAt,
          decodeMs: performance.now() - decodeAt,
          server: resp.headers.get('Server-Timing'),
        },
      });
      return slice;
    })().finally(() => {
      this.pendingSliceFetches.delete(cacheKey);
    });
    this.pendingSliceFetches.set(cacheKey, request);
    return request;
  }

  async handleFetchSlice(message: {
    id: number;
    url: string;
    axis: SliceAxis;
    index: number;
    factor?: number;
    prefetch?: number;
    maxIndex?: number;
    timeIdx?: number;
    signal?: AbortSignal;
  }): Promise<void> {
    const factor = Math.max(1, message.factor || 1);
    const timeIdx = message.timeIdx || 0;

    const sharedVolume = this.deps.getSharedVolume();
    if (sharedVolume && factor === 1 && timeIdx === 0) {
      const { buffer, nx, ny, nz, slope, inter, datatype } = sharedVolume;
      const data = createVolumeView(buffer, datatype, nx * ny * nz);
      const idx = message.index;
      let sliceData: Float32Array;
      let w: number, h: number;

      if (message.axis === 'axial') {
        w = nx;
        h = ny;
        sliceData = new Float32Array(nx * ny);
        const base = idx * ny * nx;
        for (let i = 0; i < nx * ny; i++) {
          sliceData[i] = data[base + i] * slope + inter;
        }
      } else if (message.axis === 'coronal') {
        w = nx;
        h = nz;
        sliceData = new Float32Array(nx * nz);
        for (let z = 0; z < nz; z++) {
          const base = z * ny * nx + idx * nx;
          for (let x = 0; x < nx; x++) {
            sliceData[z * nx + x] = data[base + x] * slope + inter;
          }
        }
      } else {
        w = ny;
        h = nz;
        sliceData = new Float32Array(ny * nz);
        for (let z = 0; z < nz; z++) {
          const base = z * ny * nx;
          for (let y = 0; y < ny; y++) {
            sliceData[z * ny + y] = data[base + y * nx + idx] * slope + inter;
          }
        }
      }

      this.deps.postMessage(
        {
          id: message.id,
          type: 'slice',
          axis: message.axis,
          index: message.index,
          factor,
          width: w,
          height: h,
          data: sliceData,
        },
        [sliceData.buffer],
      );
      return;
    }

    const slice = await this.fetchSlice(message.url, message.axis, message.index, factor, message.signal, timeIdx);
    // Transfer the buffer directly instead of copying — the cache entry
    // becomes invalid after transfer, so remove it from the cache.
    const payload = slice.data;
    const cacheKey = this.getSliceCacheKey(message.url, message.axis, message.index, factor, timeIdx);
    this.sliceCache.delete(cacheKey);
    this.deps.postMessage(
      {
        id: message.id,
        type: 'slice',
        axis: message.axis,
        index: message.index,
        factor,
        width: slice.width,
        height: slice.height,
        data: payload,
      },
      [payload.buffer],
    );

    const prefetch = Math.max(0, message.prefetch || 0);
    const maxIndex = Math.max(0, message.maxIndex || 0);
    if (prefetch === 0) return;

    for (let delta = 1; delta <= prefetch; delta++) {
      for (const nextIndex of [message.index - delta, message.index + delta]) {
        if (nextIndex < 0 || nextIndex > maxIndex) continue;
        if (this.getCachedSlice(message.url, message.axis, nextIndex, factor, timeIdx)) continue;
        void this.fetchSlice(message.url, message.axis, nextIndex, factor, message.signal, timeIdx).catch(() => {});
      }
    }
  }
}

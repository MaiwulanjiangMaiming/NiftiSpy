import type { NiiHeader } from './nii-parser';
import { SliceCacheDB, deriveFileHash, getSliceCacheDB } from './SliceCacheDB';
import { SliceService } from './worker/slices';
import { MAX_RETRIES, fetchWithRetry, setVolumeFetchPriority } from './worker/net';
import { TransferEngine, type TransferHost } from './worker/transfer';
import { errorMessage, isAbortError } from '../src/errors';

// No WASM here on purpose: this worker only fetches bytes and slices planes.
// The eager import of ./wasm/niftispy_wasm used to run at module scope, where
// its relative URL cannot resolve inside a blob: worker — the failing fetch
// surfaced as an unhandled worker error and took slice requests down with it.

const MAX_SLICE_CACHE = 96;
const volumeControllers = new Map<number, AbortController>();
const headCache = new Map<string, { totalSize: number; acceptRanges: boolean }>();
// Track which volume IDs have already received an early preview
const earlyPreviewSent = new Set<number>();
const earlyPreviewHeaders = new Map<number, NiiHeader>(); // cache header from early preview
// Headers supplied by the extension host for formats that have no NIfTI
// header in the stream (npy/npz/nrrd/mha/mrc/mgh). The downloaded bytes are
// pure voxels, i.e. voxOffset 0 from the worker's point of view.
const hostParsedHeaders = new Map<number, NiiHeader>();

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
function setFileHashForCache(fileName: string, fileSize: number, identity = ''): void {
  currentFileHash = deriveFileHash(fileName + '|' + identity, fileSize);
}

let sharedVolume: {
  buffer: SharedArrayBuffer;
  nx: number;
  ny: number;
  nz: number;
  slope: number;
  inter: number;
  datatype: number;
} | null = null;

const sliceService = new SliceService({
  fetchWithRetry,
  abortError,
  ensureSliceCacheDB,
  getSharedVolume: () => sharedVolume,
  getFileHash: () => currentFileHash,
  postMessage: (message, transfer) => (transfer ? self.postMessage(message, transfer) : self.postMessage(message)),
  maxRetries: MAX_RETRIES,
  maxSliceCache: MAX_SLICE_CACHE,
});

// Download/transport engine. It owns no state: every map/set is reached through
// these live getters, and workers' entry points stay here.
const transferHost: TransferHost = {
  getHeadCache: () => headCache,
  getVolumeControllers: () => volumeControllers,
  getEarlyPreviewSent: () => earlyPreviewSent,
  getEarlyPreviewHeaders: () => earlyPreviewHeaders,
  getHostParsedHeaders: () => hostParsedHeaders,
  cancelVolumeLoad,
  tryFetchPreviewVolume,
};
const transferEngine = new TransferEngine(transferHost);

self.onmessage = async (e: MessageEvent) => {
  const { id, type, url, isGzip, directUrl } = e.data;
  try {
    if (type === 'loadVolume') {
      const { estimatedBps = 0, estimatedRttMs = 0, priority = 'background' } = e.data;
      setVolumeFetchPriority(priority === 'user' ? 'user' : 'background');
      await transferEngine.handleLoadVolume(
        id,
        url,
        isGzip,
        directUrl,
        estimatedBps,
        estimatedRttMs,
        e.data.preParsedHeader || undefined,
      );
    } else if (type === 'loadVolumeFromData') {
      await transferEngine.handleLoadVolumeFromData(id, e.data);
    } else if (type === 'cancelVolumeLoad') {
      cancelVolumeLoad(id);
    } else if (type === 'fetchSlice') {
      await sliceService.handleFetchSlice(e.data);
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
      setFileHashForCache(e.data.fileName || '', e.data.fileSize || 0, e.data.identity || '');
    } else if (type === 'invalidateCache') {
      await handleInvalidateCache(e.data);
    } else if (type === 'getCacheStats') {
      await handleGetCacheStats(id);
    }
  } catch (err) {
    if (isAbortError(err)) {
      self.postMessage({ id, type: 'cancelled' });
    } else {
      self.postMessage({ id, type: 'error', error: errorMessage(err) });
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

async function handleInvalidateCache(data: {
  fileName?: string;
  fileSize?: number;
  validationToken?: string;
}): Promise<void> {
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

function cancelVolumeLoad(id: number): void {
  const controller = volumeControllers.get(id);
  controller?.abort();
  volumeControllers.delete(id);
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
async function tryFetchPreviewVolume(
  proxyUrl: string,
  id: number,
  signal: AbortSignal,
  estimatedBps = 0,
  isGzip = false,
): Promise<boolean> {
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
  const factor = isGzip ? (slow ? 32 : mid ? 16 : 8) : mid ? 8 : 4;
  const previewUrl = proxyUrl.replace('/file/', '/preview-volume/') + `?factor=${factor}`;

  try {
    const resp = await fetchWithRetry(previewUrl, undefined, 2, signal);
    if (!resp.ok) return false;

    const ab = await resp.arrayBuffer();
    const data = new Uint8Array(ab);
    if (data.length < 4) return false;

    let offset = 0;
    const dv = new DataView(ab);

    const headerLen = dv.getUint32(offset, true);
    offset += 4;
    if (offset + headerLen > data.length) return false;

    const headerJson = new TextDecoder().decode(data.subarray(offset, offset + headerLen));
    offset += headerLen;

    let header: NiiHeader;
    try {
      header = JSON.parse(headerJson) as NiiHeader;
    } catch {
      return false;
    }

    if (offset + 32 > data.length) return false;
    const factor = dv.getUint32(offset, true);
    offset += 4;
    const outNx = dv.getUint32(offset, true);
    offset += 4;
    const outNy = dv.getUint32(offset, true);
    offset += 4;
    const outNz = dv.getUint32(offset, true);
    offset += 4;
    const min = dv.getFloat32(offset, true);
    offset += 4;
    const max = dv.getFloat32(offset, true);
    offset += 4;
    // The proxy has already applied slope/inter to its Float32 voxels.
    offset += 8;

    const voxelCount = outNx * outNy * outNz;
    const voxelBytes = voxelCount * 4;
    if (offset + voxelBytes > data.length) return false;

    // Copy voxel data into a fresh, transferable Float32Array so we can
    // transfer its buffer to the main thread without neutering the response.
    // JSON has arbitrary byte length, so the voxel offset need not be aligned.
    const voxelData = new Float32Array(ab.slice(offset, offset + voxelBytes));

    self.postMessage(
      {
        id,
        type: 'previewVolume',
        header: { ...header, datatype: 16, bitpix: 32, bytesPerVoxel: 4, scl_slope: 1, scl_inter: 0 },
        voxelData,
        globalMin: min,
        globalMax: max,
        slope: 1,
        inter: 0,
        factor,
        datatype: 16, // Float32
      },
      [voxelData.buffer],
    );

    // This header describes the subsampled Float32 preview, not the source.
    // Only headers parsed from source bytes may be reused by processRawVolume.
    earlyPreviewSent.add(id);
    return true;
  } catch (err) {
    if (isAbortError(err)) throw err;
    return false;
  }
}

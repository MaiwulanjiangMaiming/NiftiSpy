/**
 * Download / transport engine: chunked and parallel range download, streaming
 * decompression, early preview emission, raw volume parsing and the
 * `loadVolume` / `loadVolumeFromData` entry points.
 *
 * All mutable worker state stays in `worker.ts`; this module only reads and
 * writes it through the live maps/sets exposed by `TransferHost`.
 */
import { gunzip } from 'fflate';
import { parseNiiHeader, type NiiHeader } from '../nii-parser';
import {
  MAX_RETRIES,
  RETRY_DELAY_BASE,
  DEFAULT_IDLE_TIMEOUT_MS,
  sleep,
  clampIdleTimeout,
  readStreamChunkWithWatchdog,
  readBodyWithWatchdog,
  fetchHeadersWatchdog,
  fetchRangeBytesWithRetry,
  fetchWithRetry,
  getPreferredChunkSize,
  getPreferredConcurrency,
  throwIfAborted,
} from './net';
import { computeAdaptiveParams, computeProbeSize } from './adaptive';
import { makeByteWriter, nativeDecompressFromBuffer } from './decompress';
import { asError, isAbortError } from '../../src/errors';

/** Everything the transfer engine needs from the worker message loop. */
export interface TransferHost {
  getHeadCache(): Map<string, { totalSize: number; acceptRanges: boolean }>;
  getVolumeControllers(): Map<number, AbortController>;
  getEarlyPreviewSent(): Set<number>;
  getEarlyPreviewHeaders(): Map<number, NiiHeader>;
  getHostParsedHeaders(): Map<number, NiiHeader>;
  cancelVolumeLoad(id: number): void;
  tryFetchPreviewVolume(
    proxyUrl: string,
    id: number,
    signal: AbortSignal,
    estimatedBps?: number,
    isGzip?: boolean,
  ): Promise<boolean>;
}

// A pool round that makes no progress at all (every chunk failed) means the
// link is down — retrying further is pointless. Otherwise, up to this many
// rounds refetch ONLY the missing chunks (resume): the decompressor stream
// and all completed-but-unfed chunks stay alive across rounds, so resume
// costs zero extra memory and zero re-download of completed bytes.
const MAX_POOL_ROUNDS = 3;

// A gzip low-res preview makes the proxy inflate the ENTIRE stream into a
// seekable disk cache before it can answer (handlePreviewVolume →
// ensureGzipScan → unpackGzipToCache). Below this compressed size the full
// volume lands sooner than that preview, and the server-side unpack competes
// with the tunnel for CPU and disk — so small gzip files skip the preview.
const GZIP_PREVIEW_MIN_BYTES = 2 * 1024 * 1024;

// Small gzip files use one continuous decompressor across the probe and
// remaining range. Do not buffer the whole download before emitting a slice.
const SINGLE_SHOT_GZIP_MAX_BYTES = 24 * 1024 * 1024;

export class TransferEngine {
  constructor(private readonly host: TransferHost) {}

  /**
   * Stage trace for the host's "NiftiSpy Performance" output channel. Sent
   * through the worker message port (the viewer forwards it) so a stalled
   * Remote-SSH load can be diagnosed from the extension host log alone.
   */
  private log(id: number, line: string): void {
    try {
      self.postMessage({ id, type: 'log', line });
    } catch {
      /* diagnostics must never break a transfer */
    }
  }

  async handleLoadVolume(
    id: number,
    url: string,
    isGzip: boolean,
    directFetchUrl?: string,
    estimatedBps = 0,
    estimatedRttMs = 0,
    preParsedHeader?: NiiHeader,
  ): Promise<void> {
    const volumeControllers = this.host.getVolumeControllers();
    this.host.cancelVolumeLoad(id);
    const controller = new AbortController();
    volumeControllers.set(id, controller);
    const signal = controller.signal;

    // Host-parsed formats (npy/npz/nrrd/mha/mrc/mgh): the byte stream contains
    // no NIfTI header, so header discovery and the proxy's NIfTI-only
    // /preview-volume endpoint are both inapplicable. The host already sent the
    // header; we only need the voxel bytes.
    if (preParsedHeader) this.host.getHostParsedHeaders().set(id, preParsedHeader);

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
      // for .nii.gz it scans through the last sampled z, near the stream
      // end. Subsampling shrinks the response, not the required inflate span.
      // Falls back silently if the endpoint is unavailable.
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
      const firePreview = preParsedHeader
        ? undefined
        : (measuredBps: number) => {
            this.host.tryFetchPreviewVolume(url, id, signal, measuredBps, isGzip).catch((err) => {
              // AbortError is expected when the load is cancelled — swallow it to
              // avoid an unhandled rejection (this promise is intentionally not awaited).
              if (isAbortError(err)) return;
            });
          };

      const hasNativeDecompress = typeof DecompressionStream !== 'undefined';
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
        rawData = await this.parallelDownloadWithEarlyPreview(
          fetchUrl,
          id,
          isGzip,
          signal,
          estimatedBps,
          estimatedRttMs,
          firePreview,
        );
        throwIfAborted(signal);
        self.postMessage({ id, type: 'progress', value: 0.9, stage: 'processing' });
      } catch (err) {
        if (isAbortError(err)) throw err;
        this.log(id, `primary path failed (${asError(err).message}) — fallback 1`);

        // If direct fetch failed and we have a different proxy URL, retry via proxy
        const retryUrl = fetchUrl !== url ? url : fetchUrl;

        // Fallback 1: streaming path (single GET, overlap download + decompress)
        try {
          if (isGzip && hasNativeDecompress) {
            rawData = await this.streamingGzipLoadWithEarlyPreview(retryUrl, id, signal);
          } else if (isGzip) {
            const compressedData = await this.downloadChunked(retryUrl, id, isGzip, signal);
            self.postMessage({ id, type: 'progress', value: 0.35, stage: 'decompressing' });
            throwIfAborted(signal);
            rawData = await new Promise<Uint8Array>((resolve, reject) => {
              gunzip(compressedData, (err, data) => {
                if (err) reject(err);
                else resolve(data);
              });
            });
          } else {
            rawData = await this.streamingNiiLoadWithEarlyPreview(retryUrl, id, signal);
          }
          throwIfAborted(signal);
          self.postMessage({ id, type: 'progress', value: 0.85, stage: 'processing' });
        } catch (err2) {
          if (isAbortError(err2)) throw err2;
          this.log(id, `fallback 1 failed (${asError(err2).message}) — fallback 2`);
          // Fallback 2: parallel chunked download + buffer decompress
          const compressedData = await this.downloadChunked(retryUrl, id, isGzip, signal);
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
      const earlyPreviewHeaders = this.host.getEarlyPreviewHeaders();
      const preParsed = preParsedHeader || earlyPreviewHeaders.get(id);
      earlyPreviewHeaders.delete(id);
      await this.processRawVolume(rawData, id, signal, isGzip, preParsed);
    } finally {
      volumeControllers.delete(id);
      this.host.getEarlyPreviewHeaders().delete(id);
      this.host.getHostParsedHeaders().delete(id);
    }
  }

  async handleLoadVolumeFromData(id: number, message: { rawData: ArrayBuffer; isGzip?: boolean }): Promise<void> {
    const volumeControllers = this.host.getVolumeControllers();
    this.host.cancelVolumeLoad(id);
    const controller = new AbortController();
    volumeControllers.set(id, controller);
    const signal = controller.signal;

    try {
      self.postMessage({ id, type: 'progress', value: 0.5, stage: 'parsing' });
      throwIfAborted(signal);

      let rawData: Uint8Array;
      if (message.isGzip) {
        const compressed = new Uint8Array(message.rawData);
        if (typeof DecompressionStream !== 'undefined') {
          const ds = new DecompressionStream('gzip');
          const writer = makeByteWriter(ds.writable);
          writer.write(compressed);
          writer.close();
          const reader = ds.readable.getReader();
          const chunks: Uint8Array[] = [];
          let totalSize = 0;
          for (;;) {
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

      await this.processRawVolume(rawData, id, signal, !!message.isGzip);
    } finally {
      volumeControllers.delete(id);
    }
  }

  private async downloadChunked(url: string, id: number, isGzip: boolean, signal?: AbortSignal): Promise<Uint8Array> {
    const headCache = this.host.getHeadCache();
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
      } catch (err) {
        if (isAbortError(err)) throw err;
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
                  id,
                  type: 'progress',
                  value: progressBase + (received / totalSize) * progressRange,
                  stage: 'downloading',
                });
              } catch (err) {
                poolError = asError(err);
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
          id,
          type: 'progress',
          value: 0.02 + (received / contentLength) * (isGzip ? 0.3 : 0.7),
          stage: 'downloading',
        });
      }
    });
  }

  private async processRawVolume(
    rawData: Uint8Array,
    id: number,
    signal: AbortSignal,
    isGzip: boolean,
    preParsedHeader?: NiiHeader,
  ): Promise<void> {
    const header = preParsedHeader || parseNiiHeader(rawData.buffer as ArrayBuffer, isGzip);

    const { nx, ny, nz, datatype, scl_slope, scl_inter, littleEndian, voxOffset } = header;
    const n = nx * ny * nz;
    const dataOffset = voxOffset;
    const byteOff = rawData.byteOffset + dataOffset;
    const le = littleEndian;
    const slope = scl_slope || 1;
    const inter = scl_inter || 0;
    const elemSize =
      datatype === 64
        ? 8
        : datatype === 8 || datatype === 16 || datatype === 768
          ? 4
          : datatype === 4 || datatype === 512
            ? 2
            : 1;
    const canUseTypedArray = byteOff % elemSize === 0 && byteOff + n * elemSize <= rawData.buffer.byteLength && le;

    let nativeData:
      | Int8Array
      | Uint8Array
      | Int16Array
      | Uint16Array
      | Int32Array
      | Uint32Array
      | Float32Array
      | Float64Array;

    switch (datatype) {
      case 2:
        nativeData = canUseTypedArray ? new Uint8Array(rawData.buffer, byteOff, n) : new Uint8Array(n);
        break;
      case 4:
        nativeData = canUseTypedArray ? new Int16Array(rawData.buffer, byteOff, n) : new Int16Array(n);
        break;
      case 8:
        nativeData = canUseTypedArray ? new Int32Array(rawData.buffer, byteOff, n) : new Int32Array(n);
        break;
      case 16:
        nativeData = canUseTypedArray ? new Float32Array(rawData.buffer, byteOff, n) : new Float32Array(n);
        break;
      case 64:
        nativeData = canUseTypedArray ? new Float64Array(rawData.buffer, byteOff, n) : new Float64Array(n);
        break;
      case 256:
        nativeData = canUseTypedArray ? new Int8Array(rawData.buffer, byteOff, n) : new Int8Array(n);
        break;
      case 512:
        nativeData = canUseTypedArray ? new Uint16Array(rawData.buffer, byteOff, n) : new Uint16Array(n);
        break;
      case 768:
        nativeData = canUseTypedArray ? new Uint32Array(rawData.buffer, byteOff, n) : new Uint32Array(n);
        break;
      default:
        nativeData = new Float32Array(n);
        break;
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
          case 4: {
            const a = nativeData as Int16Array;
            for (let i = 0; i < n; i++) a[i] = view.getInt16(i * 2, le);
            break;
          }
          case 8: {
            const a = nativeData as Int32Array;
            for (let i = 0; i < n; i++) a[i] = view.getInt32(i * 4, le);
            break;
          }
          case 16: {
            const a = nativeData as Float32Array;
            for (let i = 0; i < n; i++) a[i] = view.getFloat32(i * 4, le);
            break;
          }
          case 64: {
            const a = nativeData as Float64Array;
            for (let i = 0; i < n; i++) a[i] = view.getFloat64(i * 8, le);
            break;
          }
          case 512: {
            const a = nativeData as Uint16Array;
            for (let i = 0; i < n; i++) a[i] = view.getUint16(i * 2, le);
            break;
          }
          case 768: {
            const a = nativeData as Uint32Array;
            for (let i = 0; i < n; i++) a[i] = view.getUint32(i * 4, le);
            break;
          }
        }
      }
    }

    self.postMessage({ id, type: 'progress', value: 0.7, stage: 'computing range' });

    // ── Efficient min/max with direct sampling ─────────────────────────
    // Sample up to ~100k voxels for fast min/max estimation.
    // Direct iteration avoids creating intermediate sampled arrays.
    let min = Infinity,
      max = -Infinity;
    const sampleStep = Math.max(1, Math.floor(n / 100000));
    const needsConversion = slope !== 1 || inter !== 0;

    if (!needsConversion) {
      // Fast path: no slope/inter conversion needed
      for (let i = 0; i < n; i += sampleStep) {
        const v = (nativeData as ArrayLike<number>)[i];
        if (v < min) min = v;
        if (v > max) max = v;
      }
    } else {
      for (let i = 0; i < n; i += sampleStep) {
        const v = (nativeData as ArrayLike<number>)[i] * slope + inter;
        if (v < min) min = v;
        if (v > max) max = v;
      }
    }
    if (min === max) max = min + 1;

    // Skip preview if already sent via early streaming decompress — avoid
    // wasting CPU computing 3 slices that will be discarded.
    const earlyPreviewSent = this.host.getEarlyPreviewSent();
    const skipPreview = earlyPreviewSent.has(id);
    if (skipPreview) earlyPreviewSent.delete(id);

    self.postMessage({ id, type: 'progress', value: 0.75, stage: 'preview' });

    if (!skipPreview) {
      const axMid = Math.floor(nz / 2);
      const coMid = Math.floor(ny / 2);
      const saMid = Math.floor(nx / 2);

      const previewSlices: { axial: Float32Array; coronal: Float32Array; sagittal: Float32Array } = {
        axial: new Float32Array(nx * ny),
        coronal: new Float32Array(0), // placeholder — GPU will render
        sagittal: new Float32Array(0), // placeholder — GPU will render
      };

      {
        const base = axMid * ny * nx;
        const src =
          nativeData instanceof Float32Array ? (nativeData as Float32Array).subarray(base, base + nx * ny) : null;
        if (src && !needsConversion) {
          previewSlices.axial.set(src);
        } else if (src && needsConversion) {
          previewSlices.axial.set(src);
          for (let i = 0; i < nx * ny; i++) previewSlices.axial[i] = previewSlices.axial[i] * slope + inter;
        } else if (needsConversion) {
          for (let i = 0; i < nx * ny; i++) {
            if (i % 4096 === 0) throwIfAborted(signal);
            previewSlices.axial[i] = (nativeData as ArrayLike<number>)[base + i] * slope + inter;
          }
        } else {
          for (let i = 0; i < nx * ny; i++) {
            if (i % 4096 === 0) throwIfAborted(signal);
            previewSlices.axial[i] = (nativeData as ArrayLike<number>)[base + i];
          }
        }
      }

      self.postMessage(
        {
          id,
          type: 'preview',
          header,
          slices: previewSlices,
          globalMin: min,
          globalMax: max,
          sliceIdx: { axial: axMid, coronal: coMid, sagittal: saMid },
          slope,
          inter,
        },
        [previewSlices.axial.buffer, previewSlices.coronal.buffer, previewSlices.sagittal.buffer],
      );
    }

    self.postMessage({ id, type: 'progress', value: 0.85, stage: 'transferring volume' });

    // Always send native data — GPU shader handles slope/inter
    const voxelData:
      | Int8Array
      | Uint8Array
      | Int16Array
      | Uint16Array
      | Int32Array
      | Uint32Array
      | Float32Array
      | Float64Array = nativeData;

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
      [voxelData.buffer],
    );
  }

  /**
   * Emit an early preview from a partially-decompressed buffer.
   * Extracts the z=0 axial slice and posts it as a preview message.
   * Returns true if preview was emitted, false if not enough data yet.
   */
  private tryEmitEarlyPreview(buf: Uint8Array, bufLen: number, id: number, isGzip: boolean): boolean {
    const hostHeader = this.host.getHostParsedHeaders().get(id);
    let header: NiiHeader | null;
    if (hostHeader) {
      // The host header carries the real voxOffset into this stream (0 for
      // materialized containers, the .npy data offset for a streamed .npy).
      const firstSliceBytes = hostHeader.voxOffset + hostHeader.nx * hostHeader.ny * hostHeader.bytesPerVoxel;
      if (bufLen < firstSliceBytes) return false;
      header = hostHeader;
    } else {
      if (bufLen < 544) return false;
      header = parseNiiHeader(buf.buffer as ArrayBuffer, isGzip);
    }
    if (!header) return false;

    const { nx, ny, voxOffset, bytesPerVoxel, scl_slope, scl_inter, littleEndian, datatype } = header;
    const firstSliceNeeded = voxOffset + nx * ny * bytesPerVoxel;
    if (bufLen < firstSliceNeeded) return false;

    const slope = scl_slope || 1;
    const inter = scl_inter || 0;
    const le = littleEndian;
    const needsConversion = slope !== 1 || inter !== 0;
    const elemSize =
      datatype === 64
        ? 8
        : datatype === 8 || datatype === 16 || datatype === 768
          ? 4
          : datatype === 4 || datatype === 512
            ? 2
            : 1;

    const sliceStart = voxOffset;
    const axialSlice = new Float32Array(nx * ny);
    const sliceView = new DataView(buf.buffer, buf.byteOffset + sliceStart, nx * ny * bytesPerVoxel);
    const byteOff = buf.byteOffset + sliceStart;
    const canUseTA = byteOff % elemSize === 0 && le;

    if (canUseTA && datatype === 16 && !needsConversion) {
      axialSlice.set(new Float32Array(buf.buffer, byteOff, nx * ny));
    } else if (canUseTA && datatype === 16 && needsConversion) {
      const src = new Float32Array(buf.buffer, byteOff, nx * ny);
      for (let i = 0; i < nx * ny; i++) axialSlice[i] = src[i] * slope + inter;
    } else {
      for (let i = 0; i < nx * ny; i++) {
        let val: number;
        switch (datatype) {
          case 2:
            val = buf[buf.byteOffset + sliceStart + i];
            break;
          case 4:
            val = sliceView.getInt16(i * 2, le);
            break;
          case 8:
            val = sliceView.getInt32(i * 4, le);
            break;
          case 16:
            val = sliceView.getFloat32(i * 4, le);
            break;
          case 64:
            val = sliceView.getFloat64(i * 8, le);
            break;
          case 256:
            val = (buf[buf.byteOffset + sliceStart + i] << 24) >> 24;
            break;
          case 512:
            val = sliceView.getUint16(i * 2, le);
            break;
          case 768:
            val = sliceView.getUint32(i * 4, le);
            break;
          default:
            val = 0;
        }
        axialSlice[i] = val * slope + inter;
      }
    }

    let min = Infinity,
      max = -Infinity;
    for (let i = 0; i < axialSlice.length; i++) {
      if (axialSlice[i] < min) min = axialSlice[i];
      if (axialSlice[i] > max) max = axialSlice[i];
    }
    if (min === max) max = min + 1;

    const coMid = Math.floor(ny / 2);
    const saMid = Math.floor(nx / 2);

    self.postMessage(
      {
        id,
        type: 'preview',
        partialPreview: true,
        header,
        slices: {
          axial: axialSlice,
          coronal: new Float32Array(0),
          sagittal: new Float32Array(0),
        },
        globalMin: min,
        globalMax: max,
        sliceIdx: { axial: 0, coronal: coMid, sagittal: saMid },
        slope,
        inter,
      },
      [axialSlice.buffer],
    );

    this.host.getEarlyPreviewSent().add(id);
    this.host.getEarlyPreviewHeaders().set(id, header); // cache for processRawVolume
    return true;
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
  private async parallelDownloadWithEarlyPreview(
    url: string,
    id: number,
    isGzip: boolean,
    signal: AbortSignal,
    estimatedBps = 0,
    estimatedRttMs = 0,
    firePreview?: (measuredBps: number) => void,
  ): Promise<Uint8Array> {
    const hasNativeDecompress = typeof DecompressionStream !== 'undefined';

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
        probeResp = await fetchHeadersWatchdog(
          url,
          {
            headers: { Range: `bytes=0-${PROBE_SIZE - 1}` },
          },
          DEFAULT_IDLE_TIMEOUT_MS,
          signal,
        );
        // Retry only on retryable statuses; hand back others for the caller's
        // status checks below (200/206 handling).
        const st = probeResp.status;
        if (st !== 200 && st !== 206 && attempt === 0) {
          try {
            await probeResp.body?.cancel();
          } catch {
            /* ignore */
          }
          probeResp = null;
          await sleep(RETRY_DELAY_BASE);
        }
      } catch (err) {
        if (isAbortError(err)) throw err;
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
        return this.streamingGzipLoadFromResponse(probeResp, id, signal);
      }
      return this.streamingNiiLoadFromResponse(probeResp, id, signal);
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
      if (isGzip && hasNativeDecompress) return this.streamingGzipLoadWithEarlyPreview(url, id, signal);
      return this.streamingNiiLoadWithEarlyPreview(url, id, signal);
    }

    // Check if this is a remote source to tune chunk size.
    // Direct remote URLs (not localhost proxy) are always "remote".
    // Proxy URLs may have X-Remote-Source header — set by the proxy when it
    // runs inside a remote extension host, marking that the request traversed
    // the SSH tunnel (the URL still LOOKS like 127.0.0.1 from the local side).
    const isLocalhost = url.startsWith('http://127.0.0.1') || url.startsWith('http://localhost');
    const isRemote = !isLocalhost || probeResp.headers.get('X-Remote-Source') === 'true';

    // Start decoding the probe body immediately. Waiting for its EOF hides
    // slices already received on slow links, even when the entire file fits
    // in this one response. Small gzip downloads continue with only the
    // missing range, through the same decompressor (no prefix re-download).
    if (isGzip && hasNativeDecompress && totalSize <= SINGLE_SHOT_GZIP_MAX_BYTES) {
      const match = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(contentRange);
      if (!match || Number(match[1]) !== 0 || !probeResp.body) throw new Error('Invalid gzip probe range');
      return this.streamingGzipRanges(
        url,
        probeResp,
        Number(match[2]) + 1,
        totalSize,
        id,
        signal,
        clampIdleTimeout(estimatedRttMs),
      );
    }

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
    this.reportBandwidthSample(id, probeData.byteLength, bodyMs, measuredRttMs);

    // Now that the link is measured, fire the low-res preview fetch with a
    // factor scaled to the REAL bandwidth (it must not stall the first image).
    // Small gzip files are the exception: the proxy would have to inflate the
    // whole stream to answer, which is slower than just finishing the download.
    if (!isGzip || totalSize >= GZIP_PREVIEW_MIN_BYTES) firePreview?.(measuredBps);

    const { chunkSize: CHUNK_SIZE, maxConcurrent: MAX_CONCURRENT } = computeAdaptiveParams(
      measuredBps || estimatedBps,
      measuredRttMs || estimatedRttMs,
      isRemote,
      totalSize,
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
      return this.parallelGzipDownload(
        url,
        id,
        signal,
        totalSize,
        settledProbe,
        PROBE_SIZE,
        CHUNK_SIZE,
        MAX_CONCURRENT,
        idleMs,
      );
    }

    // ── Step 3: For uncompressed — direct parallel download ──
    return this.parallelNiiDownload(
      url,
      id,
      signal,
      totalSize,
      settledProbe,
      PROBE_SIZE,
      CHUNK_SIZE,
      MAX_CONCURRENT,
      idleMs,
    );
  }

  /**
   * Parallel gzip download with streaming decompression.
   * Downloads compressed chunks in parallel, feeds them to the decompressor
   * in order, and emits early preview from the first decompressed slice.
   */
  private async parallelGzipDownload(
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
    const ds = new DecompressionStream('gzip');
    const writer = makeByteWriter(ds.writable);
    const reader = ds.readable.getReader() as ReadableStreamDefaultReader<Uint8Array>;

    // Pre-allocate decompressed buffer — cap initial size to avoid OOM
    const estimatedSize = Math.min(totalSize * 4, 512 * 1024 * 1024);
    let result = new Uint8Array(Math.max(estimatedSize, 16 * 1024 * 1024));
    let writeOffset = 0;
    let previewSent = false;
    let lastProgressTime = 0;
    // Decompressor/write failures are fatal — refetching network bytes cannot
    // fix a broken stream, so resume rounds must not be attempted for them.
    // Declared BEFORE the reader loop so its failure handler can record the
    // first fatal error and unblock the download pool instead of leaving it
    // waiting for chunks that can never be fed.
    let fatalStreamError: Error | null = null;

    // Concurrent decompression reader — runs alongside downloads
    const decompressPromise = (async () => {
      for (;;) {
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
          try {
            previewSent = this.tryEmitEarlyPreview(result, writeOffset, id, true);
          } catch {
            // An unparseable header must not kill the decompression stream.
          }
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
    })().catch((err) => {
      // The stream is dead. Keep the FIRST failure (it is the root cause) and
      // abort the writable side so pending/future writes reject instead of
      // waiting forever for a stream that will never drain again.
      fatalStreamError = fatalStreamError || asError(err);
      try {
        writer.abort(fatalStreamError).catch(() => {});
      } catch {
        /* writer already released — stream cleanup is best effort */
      }
    });

    const remainingStart = probeSize;
    const numChunks = Math.ceil((totalSize - remainingStart) / chunkSize);

    // Ordered chunk buffer with back-pressure — limit pending size
    const pending = new Map<number, Uint8Array>();
    const MAX_PENDING = maxConcurrent * 2;
    let nextFeedIdx = 0;
    let downloadError: Error | null = null;

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
          try {
            await writer.write(data);
          } catch (err) {
            fatalStreamError = asError(err);
          }
        };
        if (batch.length === 1) {
          await writeBatch(batch[0]);
        } else {
          let totalLen = 0;
          for (const c of batch) totalLen += c.byteLength;
          const merged = new Uint8Array(totalLen);
          let off = 0;
          for (const c of batch) {
            merged.set(c, off);
            off += c.byteLength;
          }
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
    const runPoolRound = (firstGapIdx: number): Promise<void> =>
      new Promise((resolve, reject) => {
        let running = 0;
        let launched = 0;
        let settled = false;
        const settle = (fn: () => void): void => {
          if (settled) return;
          settled = true;
          fn();
        };
        // A broken decompressor never recovers. Reject the round the moment it
        // is noticed instead of waiting for chunks that can never be fed — that
        // wait is what left the worker (and the loading bar) hanging forever.
        const rejectIfStreamBroken = (): boolean => {
          const fatal = fatalStreamError;
          if (!fatal) return false;
          settle(() => reject(fatal));
          return true;
        };
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
                this.reportBandwidthSample(id, data.byteLength, Math.max(1, performance.now() - chunkStartTime));
                // Throttled progress
                const now = performance.now();
                if (now - lastProgressTime > 50) {
                  lastProgressTime = now;
                  self.postMessage({
                    id,
                    type: 'progress',
                    value: 0.02 + (received / totalSize) * 0.5,
                    stage: 'downloading (parallel)',
                  });
                }
                pending.set(idx, data);
                await feedIfReady();
              } catch (err) {
                if (isAbortError(err)) {
                  downloadError = asError(err);
                  settle(() => reject(err));
                  return;
                }
                failureCount++;
                // Adaptive backoff: if failure rate is high, reduce concurrency
                // to ease pressure on a struggling network and avoid cascading timeouts.
                const totalAttempts = successCount + failureCount;
                if (totalAttempts > 3 && failureCount / totalAttempts > 0.15) {
                  effectiveMaxConcurrent = Math.max(2, Math.floor(effectiveMaxConcurrent / 2));
                }
                if (!downloadError) downloadError = asError(err);
              }
              running--;
              if (rejectIfStreamBroken()) return;
              // tryLaunch() launches whatever is still allowed and settles the
              // round once nothing is in flight — the only terminal condition.
              // (Settling here purely on `running === 0` would cut a round
              // short on slow links where concurrency is 1.)
              tryLaunch();
            })();
          }
          if (rejectIfStreamBroken()) return;
          if (running === 0) {
            settle(resolve);
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
          if (!fetchedIdx.has(i)) {
            firstGapIdx = i;
            break;
          }
        }
        const progressBefore = fetchedIdx.size;
        this.log(
          id,
          `gz pool round ${round}: chunks=${numChunks} fetched=${progressBefore} gap=${firstGapIdx} conc=${effectiveMaxConcurrent}`,
        );
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
      // Surface the original stream failure (corrupt gzip, dead reader) instead
      // of returning a silently truncated volume.
      if (fatalStreamError) throw fatalStreamError;
    } catch (err) {
      downloadError = downloadError || (err as Error);
    } finally {
      // Ensure stream resources are cleaned up on error/abort
      try {
        writer.abort();
      } catch {
        /* stream cleanup is best effort */
      }
      try {
        reader.releaseLock();
      } catch {
        /* stream cleanup is best effort */
      }
    }

    if (downloadError) throw downloadError;

    self.postMessage({ id, type: 'progress', value: 0.9, stage: 'processing' });
    return result.subarray(0, writeOffset);
  }

  /**
   * Parallel uncompressed NIfTI download with early preview.
   * Writes chunks directly to pre-allocated buffer at correct positions.
   */
  private async parallelNiiDownload(
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
              this.reportBandwidthSample(id, data.byteLength, Math.max(1, performance.now() - chunkStartTime));
              const received = start + data.byteLength;
              self.postMessage({
                id,
                type: 'progress',
                value: 0.02 + (received / totalSize) * 0.85,
                stage: 'downloading (parallel)',
              });
            } catch (err) {
              if (isAbortError(err)) {
                poolError = asError(err);
              } else {
                failureCount++;
                const totalAttempts = successCount + failureCount;
                if (totalAttempts > 3 && failureCount / totalAttempts > 0.15) {
                  effectiveMaxConcurrent = Math.max(2, Math.floor(effectiveMaxConcurrent / 2));
                }
                if (!poolError) poolError = asError(err);
              }
            }
            running--;
            if (poolError) {
              reject(poolError);
              return;
            }
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
    this.tryEmitEarlyPreview(result, probeData.byteLength, id, false);
    self.postMessage({ id, type: 'progress', value: 0.1, stage: 'downloading (parallel)' });

    await downloadPoolPromise;
    if (poolError) throw poolError;

    self.postMessage({ id, type: 'progress', value: 0.9, stage: 'processing' });
    return result;
  }

  /** Feed the probe and remaining bytes into one backpressured gzip stream. */
  private async streamingGzipRanges(
    url: string,
    probe: Response,
    probeEnd: number,
    totalSize: number,
    id: number,
    signal: AbortSignal,
    idleMs: number,
  ): Promise<Uint8Array> {
    let reader = probe.body!.getReader();
    let received = 0,
      rangeEnd = probeEnd;
    const abort = () => {
      void reader.cancel(signal.reason).catch(() => {});
    };
    signal.addEventListener('abort', abort, { once: true });
    const body = new ReadableStream<Uint8Array>({
      async pull(controller) {
        try {
          for (;;) {
            throwIfAborted(signal);
            const chunk = await readStreamChunkWithWatchdog(reader, idleMs);
            throwIfAborted(signal);
            if (!chunk.done) {
              received += chunk.value.byteLength;
              if (received > rangeEnd) throw new Error('Gzip range exceeded its declared length');
              controller.enqueue(chunk.value);
              return;
            }
            reader.releaseLock();
            if (received !== rangeEnd) throw new Error(`Short gzip range: ${received}/${rangeEnd} bytes`);
            if (received === totalSize) {
              controller.close();
              return;
            }
            const response = await fetchHeadersWatchdog(
              url,
              { headers: { Range: `bytes=${received}-${totalSize - 1}` } },
              idleMs,
              signal,
            );
            const expected = `bytes ${received}-${totalSize - 1}/${totalSize}`;
            if (response.status !== 206 || response.headers.get('Content-Range') !== expected || !response.body) {
              await response.body?.cancel();
              throw new Error('Invalid remaining gzip range');
            }
            reader = response.body.getReader();
            rangeEnd = totalSize;
          }
        } catch (error) {
          void reader.cancel(error).catch(() => {});
          controller.error(error);
        }
      },
      cancel: (reason) => reader.cancel(reason),
    });
    this.log(id, `gz streaming ${totalSize}B (probe ${probeEnd}B, incremental preview)`);
    try {
      return await this.streamingGzipLoadFromResponse(new Response(body), id, signal);
    } finally {
      signal.removeEventListener('abort', abort);
    }
  }

  /**
   * Stream-decompress a gzip Response from a full (non-range) response.
   * Used when the server doesn't support range requests.
   */
  private async streamingGzipLoadFromResponse(resp: Response, id: number, signal: AbortSignal): Promise<Uint8Array> {
    const ds = new DecompressionStream('gzip');
    const decompressedStream = resp.body!.pipeThrough(ds, { signal });
    const reader = decompressedStream.getReader() as ReadableStreamDefaultReader<Uint8Array>;

    let result = new Uint8Array(16 * 1024 * 1024);
    let writeOffset = 0;
    let previewSent = false;

    for (;;) {
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
        previewSent = this.tryEmitEarlyPreview(result, writeOffset, id, true);
      }

      self.postMessage({
        id,
        type: 'progress',
        value: 0.1 + (writeOffset / result.length) * 0.8,
        stage: 'decompressing (stream)',
      });
    }

    return result.subarray(0, writeOffset);
  }

  /**
   * Stream-load an uncompressed NIfTI from a full (non-range) Response.
   */
  private async streamingNiiLoadFromResponse(resp: Response, id: number, signal: AbortSignal): Promise<Uint8Array> {
    const contentLength = Number(resp.headers.get('Content-Length') || 0);
    const reader = resp.body!.getReader();

    let result: Uint8Array | null =
      contentLength > 0 ? new Uint8Array(contentLength) : new Uint8Array(16 * 1024 * 1024);
    const chunks: Uint8Array[] = [];
    let writeOffset = 0;
    let totalSize = 0;
    let previewSent = false;

    for (;;) {
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
          result = null;
        }
      } else {
        chunks.push(value);
      }
      writeOffset += value.byteLength;
      totalSize += value.byteLength;

      if (!previewSent) {
        const buf = result
          ? result.subarray(0, writeOffset)
          : (() => {
              const tmp = new Uint8Array(writeOffset);
              let off = 0;
              for (const c of chunks) {
                tmp.set(c, off);
                off += c.byteLength;
              }
              return tmp;
            })();
        previewSent = this.tryEmitEarlyPreview(buf, writeOffset, id, false);
      }

      if (contentLength > 0) {
        self.postMessage({
          id,
          type: 'progress',
          value: 0.02 + (writeOffset / contentLength) * 0.85,
          stage: 'downloading (stream)',
        });
      }
    }

    if (result) return result.subarray(0, writeOffset);

    const final = new Uint8Array(totalSize);
    let offset = 0;
    for (const chunk of chunks) {
      final.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return final;
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
  private async streamingGzipLoadWithEarlyPreview(url: string, id: number, signal: AbortSignal): Promise<Uint8Array> {
    const resp = await fetchWithRetry(url, undefined, MAX_RETRIES, signal);
    if (!resp.ok) throw new Error(`Fetch failed: ${resp.status}`);
    if (!resp.body) throw new Error('No response body for streaming');

    const ds = new DecompressionStream('gzip');
    const decompressedStream = resp.body.pipeThrough(ds);
    const reader = decompressedStream.getReader() as ReadableStreamDefaultReader<Uint8Array>;

    // Pre-allocate a growable buffer — avoids O(n) chunk concatenation
    const INITIAL_CAP = 16 * 1024 * 1024; // 16MB initial
    let result = new Uint8Array(INITIAL_CAP);
    let writeOffset = 0;

    // Parse preview directly from result buffer — no separate previewBuf needed
    let previewSent = false;
    let header: NiiHeader | null = null;
    let firstSliceNeeded = Infinity;

    const contentLength = Number(resp.headers.get('Content-Length') || 0);

    for (;;) {
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
              const elemSize =
                datatype === 64
                  ? 8
                  : datatype === 8 || datatype === 16 || datatype === 768
                    ? 4
                    : datatype === 4 || datatype === 512
                      ? 2
                      : 1;

              const sliceStart = voxOffset;
              const axialSlice = new Float32Array(nx * ny);
              const sliceView = new DataView(buf.buffer, buf.byteOffset + sliceStart, nx * ny * bytesPerVoxel);
              const byteOff = buf.byteOffset + sliceStart;
              const canUseTA = byteOff % elemSize === 0 && le;

              if (canUseTA && datatype === 16 && !needsConversion) {
                axialSlice.set(new Float32Array(buf.buffer, byteOff, nx * ny));
              } else if (canUseTA && datatype === 16 && needsConversion) {
                const src = new Float32Array(buf.buffer, byteOff, nx * ny);
                for (let i = 0; i < nx * ny; i++) axialSlice[i] = src[i] * slope + inter;
              } else {
                for (let i = 0; i < nx * ny; i++) {
                  let val: number;
                  switch (datatype) {
                    case 2:
                      val = buf[buf.byteOffset + sliceStart + i];
                      break;
                    case 4:
                      val = sliceView.getInt16(i * 2, le);
                      break;
                    case 8:
                      val = sliceView.getInt32(i * 4, le);
                      break;
                    case 16:
                      val = sliceView.getFloat32(i * 4, le);
                      break;
                    case 64:
                      val = sliceView.getFloat64(i * 8, le);
                      break;
                    case 256:
                      val = (buf[buf.byteOffset + sliceStart + i] << 24) >> 24;
                      break;
                    case 512:
                      val = sliceView.getUint16(i * 2, le);
                      break;
                    case 768:
                      val = sliceView.getUint32(i * 4, le);
                      break;
                    default:
                      val = 0;
                  }
                  axialSlice[i] = val * slope + inter;
                }
              }

              let min = Infinity,
                max = -Infinity;
              for (let i = 0; i < axialSlice.length; i++) {
                if (axialSlice[i] < min) min = axialSlice[i];
                if (axialSlice[i] > max) max = axialSlice[i];
              }
              if (min === max) max = min + 1;

              const coMid = Math.floor(ny / 2);
              const saMid = Math.floor(nx / 2);

              self.postMessage(
                {
                  id,
                  type: 'preview',
                  partialPreview: true,
                  header,
                  slices: {
                    axial: axialSlice,
                    coronal: new Float32Array(0),
                    sagittal: new Float32Array(0),
                  },
                  globalMin: min,
                  globalMax: max,
                  sliceIdx: { axial: 0, coronal: coMid, sagittal: saMid },
                  slope,
                  inter,
                },
                [axialSlice.buffer],
              );

              previewSent = true;
              this.host.getEarlyPreviewSent().add(id);
              self.postMessage({ id, type: 'progress', value: 0.5, stage: 'decompressing (stream)' });
            }
          }
        } catch {
          // Header not parseable yet — continue streaming
        }
      }

      // Progress updates
      if (!previewSent) {
        self.postMessage({
          id,
          type: 'progress',
          value: 0.1 + (writeOffset / (contentLength * 4 || writeOffset * 2)) * 0.2,
          stage: 'downloading (stream)',
        });
      } else {
        self.postMessage({
          id,
          type: 'progress',
          value: 0.5 + (writeOffset / (contentLength * 4 || writeOffset * 2)) * 0.3,
          stage: 'decompressing (stream)',
        });
      }
    }

    return result.subarray(0, writeOffset);
  }

  /**
   * Streaming uncompressed .nii loader: fetches the URL with a single GET,
   * emits an early preview as soon as the header + first axial slice are
   * available, and collects the rest into a pre-allocated buffer.
   */
  private async streamingNiiLoadWithEarlyPreview(url: string, id: number, signal: AbortSignal): Promise<Uint8Array> {
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

    for (;;) {
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
          const buf = result
            ? result.subarray(0, writeOffset)
            : (() => {
                // Assemble from chunks for preview parsing
                const tmp = new Uint8Array(writeOffset);
                let off = 0;
                for (const c of chunks) {
                  tmp.set(c, off);
                  off += c.byteLength;
                }
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
              const elemSize =
                datatype === 64
                  ? 8
                  : datatype === 8 || datatype === 16 || datatype === 768
                    ? 4
                    : datatype === 4 || datatype === 512
                      ? 2
                      : 1;

              const sliceStart = voxOffset;
              const axialSlice = new Float32Array(nx * ny);
              const sliceView = new DataView(buf.buffer, buf.byteOffset + sliceStart, nx * ny * bytesPerVoxel);
              const byteOff = buf.byteOffset + sliceStart;
              const canUseTA = byteOff % elemSize === 0 && le;

              if (canUseTA && datatype === 16 && !needsConversion) {
                axialSlice.set(new Float32Array(buf.buffer, byteOff, nx * ny));
              } else if (canUseTA && datatype === 16 && needsConversion) {
                const src = new Float32Array(buf.buffer, byteOff, nx * ny);
                for (let i = 0; i < nx * ny; i++) axialSlice[i] = src[i] * slope + inter;
              } else {
                for (let i = 0; i < nx * ny; i++) {
                  let val: number;
                  switch (datatype) {
                    case 2:
                      val = buf[buf.byteOffset + sliceStart + i];
                      break;
                    case 4:
                      val = sliceView.getInt16(i * 2, le);
                      break;
                    case 8:
                      val = sliceView.getInt32(i * 4, le);
                      break;
                    case 16:
                      val = sliceView.getFloat32(i * 4, le);
                      break;
                    case 64:
                      val = sliceView.getFloat64(i * 8, le);
                      break;
                    case 256:
                      val = (buf[buf.byteOffset + sliceStart + i] << 24) >> 24;
                      break;
                    case 512:
                      val = sliceView.getUint16(i * 2, le);
                      break;
                    case 768:
                      val = sliceView.getUint32(i * 4, le);
                      break;
                    default:
                      val = 0;
                  }
                  axialSlice[i] = val * slope + inter;
                }
              }

              let min = Infinity,
                max = -Infinity;
              for (let i = 0; i < axialSlice.length; i++) {
                if (axialSlice[i] < min) min = axialSlice[i];
                if (axialSlice[i] > max) max = axialSlice[i];
              }
              if (min === max) max = min + 1;

              const coMid = Math.floor(ny / 2);
              const saMid = Math.floor(nx / 2);

              self.postMessage(
                {
                  id,
                  type: 'preview',
                  partialPreview: true,
                  header,
                  slices: {
                    axial: axialSlice,
                    coronal: new Float32Array(0),
                    sagittal: new Float32Array(0),
                  },
                  globalMin: min,
                  globalMax: max,
                  sliceIdx: { axial: 0, coronal: coMid, sagittal: saMid },
                  slope,
                  inter,
                },
                [axialSlice.buffer],
              );

              previewSent = true;
              this.host.getEarlyPreviewSent().add(id);
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

  // Report a bandwidth sample to the main thread so the shared estimator stays
  // up-to-date across loads.
  private reportBandwidthSample(id: number, bytes: number, durationMs: number, rttMs?: number): void {
    self.postMessage({ id, type: 'bandwidthSample', bytes, durationMs, rttMs });
  }
}

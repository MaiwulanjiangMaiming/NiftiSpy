import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import * as zlib from 'zlib';
import * as os from 'os';
import { LocalFileProxy } from '../LocalFileProxy';
import { VolumeCache } from '../VolumeCache';
import { LoadQueue } from './loadQueue';
import { getNativeBindings } from '../nativeBridge';
import { parseNiiHeaderQuick, type NiiHeader } from '../nifti/headerParser';
import { isWanRemote, shouldUseSliceMode, SLICE_MODE_MIN_BYTES } from '../remoteEnv';
import { resolveAnalyzePair, type AnalyzePair } from '../io/analyzePair';
import { computeVoxelStats } from './stats';
import { isAbortError } from '../errors';

export type Timing = Record<string, number | string | boolean | undefined>;

/** Fallback context stashed per remote-SSH dispatch (see NiiEditorProvider). */
export interface RemoteHttpFallback {
  webview: vscode.Webview;
  fsPath: string;
  fileSize: number;
  validationToken: string;
  signal: AbortSignal;
  isGzip: boolean;
}

/** Host state and callbacks the volume loaders need from the editor provider. */
export interface LocalVolumeHost {
  context: vscode.ExtensionContext;
  volumeCache: VolumeCache;
  loadQueue: LoadQueue;
  remoteHttpFallbacks: Map<string, RemoteHttpFallback>;
  gzipIndexStatusItems: Map<string, vscode.Disposable>;
  isWebviewActive(webviewId: string): boolean;
  logPerf(line: string): void;
  updateCacheStatusBar(): void;
  getProxy(): LocalFileProxy | null;
  setProxy(proxy: LocalFileProxy | null): void;
}

/**
 * Local and Remote-SSH volume transports: whole-volume cache hits, streaming
 * gzip, native/JS one-shot paths, remote slice mode and early previews.
 */
export class LocalVolumeLoader {
  constructor(private readonly host: LocalVolumeHost) {}

  private get context(): vscode.ExtensionContext { return this.host.context; }
  private get volumeCache(): VolumeCache { return this.host.volumeCache; }
  private get loadQueue(): LoadQueue { return this.host.loadQueue; }
  private get remoteHttpFallbacks(): Map<string, RemoteHttpFallback> { return this.host.remoteHttpFallbacks; }
  private get gzipIndexStatusItems(): Map<string, vscode.Disposable> { return this.host.gzipIndexStatusItems; }
  private get proxy(): LocalFileProxy | null { return this.host.getProxy(); }
  private set proxy(value: LocalFileProxy | null) { this.host.setProxy(value); }
  private isWebviewActive(webviewId: string): boolean { return this.host.isWebviewActive(webviewId); }
  private logPerf(line: string): void { this.host.logPerf(line); }
  private updateCacheStatusBar(): void { this.host.updateCacheStatusBar(); }
  private parseNiiHeaderFromBuffer(buf: Uint8Array, separateImg = false): NiiHeader | null {
    return parseNiiHeaderQuick(buf, { separateImg });
  }

  async startLocalLoad(
    webview: vscode.Webview,
    webviewId: string,
    loadId: string,
    uri: vscode.Uri,
    signal: AbortSignal,
    fileSize: number = 0,
    validationToken: string = '',
    pair?: AnalyzePair,
  ): Promise<void> {
    const uriKey = uri.toString();
    const cached = this.volumeCache.get(uriKey);
    if (cached && !shouldUseSliceMode(fileSize)) {
      this.volumeCache.setActive(uriKey, webviewId);
      // Pass the full underlying buffer + voxOffset to avoid a costly
      // buffer.slice() copy on cache-hit (second open of same file).
      const voxelBuffer = cached.voxelData.buffer;
      webview.postMessage({
        type: 'cachedVolume',
        header: cached.header,
        globalMin: cached.min,
        globalMax: cached.max,
        slope: cached.slope,
        inter: cached.inter,
        sliceIdx: {
          axial: Math.floor(cached.header.nz / 2),
          coronal: Math.floor(cached.header.ny / 2),
          sagittal: Math.floor(cached.header.nx / 2),
        },
        voxelData: voxelBuffer,
        voxOffset: cached.header.voxOffset,
        voxelLength: cached.voxelData.byteLength,
        datatype: cached.header.datatype,
      });
      return;
    }

    const isActive = this.isWebviewActive(webviewId);
    this.loadQueue.enqueue({
      webviewId,
      priority: isActive ? 100 : 1,
      isRemote: false,
      abortController: signal instanceof AbortController ? signal : new AbortController(),
      execute: async () => {
        if (signal.aborted) return;
        try {
          this.volumeCache.setActive(uriKey, webviewId);
          const fsPath = uri.fsPath;
          const isGzip = fsPath.endsWith('.gz');
          const perfT0 = performance.now();
          let streamTiming: Timing = {};

          // ── Optimized single-pass load ──
          // For .nii.gz: stream-decompress ONCE, send z=0 preview early,
          //   then send full volume from the same decompression pass.
          // For .nii: read directly (SSD fast), use native mmap stats if available.
          // This eliminates the previous double-read/double-decompress bug.

          let rawData: Uint8Array;
          let header: NiiHeader | null = null;
          let streamStats: { min: number; max: number } | null = null;
          // Hoisted out of the isGzip block so the finalize path's
          // perfExtTiming (which runs for both .nii and .nii.gz) can read it.
          const isRemoteSSH = isWanRemote();

          // ── Remote-SSH fast path: HTTP port-forward streaming ──
          // The chunked postMessage path is latency-bound: each 2MB chunk
          // waits a full ext-host→renderer RPC round trip over the SSH
          // relay, so a 100-200MB volume needs 50-100 sequential awaits
          // (1-2 minutes in practice). Instead, serve the file from the
          // localhost HTTP proxy and let vscode.env.asExternalUri port-
          // forward it to the local side. The webview Worker then fetches
          // the forwarded URL directly: a raw TCP stream through SSH's
          // direct-tcpip channel (full tunnel bandwidth, backpressure,
          // no per-message RPC overhead) with overlapping decompression
          // and early preview. Falls through to the postMessage paths
          // below if port forwarding is unavailable.
          if (isRemoteSSH) {
            const dispatched = await this.tryRemoteSshHttpLoad(
              webview, webviewId, loadId, uri, fsPath, fileSize, validationToken, signal
            );
            if (dispatched) return;
            // asExternalUri failed → legacy postMessage paths below.
          }

          if (isGzip) {
            // ── Remote-SSH: chunked compressed transfer ──
            // postMessage serializes its argument via structured clone SYNCHRONOUSLY
            // on the ext-host main thread. One large ArrayBuffer (e.g. 142MB) blocks
            // the main thread for hundreds of ms AND saturates the RPC channel for
            // the entire SSH transfer, freezing the IDE.
            //
            // Fix: read the compressed file in small chunks (2MB) and postMessage
            // each chunk separately. Each serialization takes ~10-20ms (not blocking),
            // and we yield to the event loop between chunks so other extensions, UI,
            // and command palette stay responsive. The webview feeds chunks to a
            // streaming DecompressionStream and shows early preview as data arrives.
            //
            // This avoids the "worker fetch of asWebviewUri URLs is unreliable across
            // VS Code versions" problem documented at the asWebviewUri assignment.
            if (isRemoteSSH) {
              const REMOTE_SSH_ONESHOT_MAX_MB = 4;
              const fileMB = fileSize / (1024 * 1024);
              if (fileSize > 0 && fileMB <= REMOTE_SSH_ONESHOT_MAX_MB) {
                // Small file: one-shot compressed postMessage (fast, minimal overhead)
                try {
                  await this.remoteSshCompressedLoad(webview, fsPath, fileSize, validationToken, signal);
                  return;
                } catch (err) {
                  this.logPerf(`[remote-ssh] oneshot failed, falling back to chunked: ${String(err)}`);
                }
              }
              // Large file (or small-file failure): chunked transfer
              await this.remoteSshChunkedLoad(webview, fsPath, fileSize, validationToken, signal);
              return;
            }
            // ── Strategy: prefer native libdeflate oneshot, fall back to streaming.
            //    Benchmarked on recon_hr.nii.gz (342MB→465MB), Apple Silicon:
            //      native libdeflate oneshot:  ~550-650ms (700-850 MB/s) ← BEST
            //      streaming (chunkSize=16MB): 1153ms (403 MB/s)
            //      gunzipSync (system zlib):   1229ms (378 MB/s) + 231ms fs read
            //      native fastDecompressGzip (zlib-ng): 1153ms (slower than system zlib on ARM64)
            //    libdeflate wins because it uses more aggressive SIMD inflate
            //    (NEON on ARM64) and avoids streaming/event-loop overhead.
            //    Trade-off: no early preview (z=0 during decompression) —
            // ── Strategy: prefer parallel (lgz + rayon), fall back to single-core
            //    oneshot (libdeflate + mmap), then streaming (zlib).
            //
            //    Benchmarked on recon_hr.nii.gz (342MB→465MB), Apple Silicon:
            //      native parallel (lgz + 8 cores):  ~150-300ms  ← BEST (expected)
            //      native oneshot (libdeflate):       ~761ms (standalone) / 1260ms (extension)
            //      streaming (chunkSize=16MB):        ~1153ms (pipelined, early preview)
            //      gunzipSync (system zlib):          ~1229ms + 231ms fs read
            //
            //    Parallel path uses lgz (speculative DEFLATE block-boundary scanner +
            //    rayon) — works on ANY gzip file, not just pigz/bgzf. Pure Rust,
            //    cross-platform (macOS/Linux/Windows, aarch64 + x86_64).
            //
            //    Fallback chain:
            //      parallel → oneshot → streaming
            //    All async variants run on libuv worker thread (not blocking JS main).
            const native = getNativeBindings();
            const SMALL_FILE_THRESHOLD_MB = 10;   // < 10MB → JS gunzipSync (no stream overhead)
            const PARALLEL_THRESHOLD_MB = 50;     // > 50MB → native parallel (rusty-rapidgzip)
            const fileSizeMB = fileSize / (1024 * 1024);  // fileSize from stat at L334

            // Detect Remote-SSH: when extension host runs on a remote server,
            // postMessage crosses the network. Early preview (z=0 slice during
            // decompression) becomes more valuable than raw decompress speed,
            // because the user sees the first image while the full volume is
            // still transferring over the network.
            //   Local:      parallel (300ms, no preview) > streaming (1150ms, preview at 50ms)
            //               because transfer is instant, decompress time dominates.
            //   Remote-SSH: streaming (preview at 50ms) > parallel (preview at 300ms)
            //               because transfer takes seconds; seeing an image early matters
            //               more than saving 850ms on decompress.
            //   Exception: very large files (>200MB) where the 850ms decompress gap
            //   is significant even vs network transfer time.
            const REMOTE_PARALLEL_THRESHOLD_MB = 200;  // only use parallel on huge files when remote

            let result: { rawData: Uint8Array; header: NiiHeader; stats: { min: number; max: number } | null; timing: Timing } | null = null;

            // Determine the parallel threshold based on environment:
            //   Local: > 50MB → parallel (decompress speed matters)
            //   Remote-SSH: > 200MB → parallel (only huge files justify losing early preview)
            const effectiveParallelThresholdMB = isRemoteSSH
              ? REMOTE_PARALLEL_THRESHOLD_MB
              : PARALLEL_THRESHOLD_MB;

            // 1. Large file + native parallel → rusty-rapidgzip (multi-core)
            if (fileSize > 0 && fileSizeMB > effectiveParallelThresholdMB
                && native?.fastDecompressGzipParallelAsync) {
              try {
                result = await this.parallelLocalGzLoad(webview, fsPath, signal);
              } catch (err) {
                this.logPerf(`[parallel] failed, falling back: ${String(err)}`);
                result = null;
              }
            }

            // 2. Medium file + native oneshot → libdeflate (single-core, no stream)
            //    In Remote-SSH, only use oneshot for medium files (< threshold) where
            //    the decompress is fast enough that early preview isn't critical.
            if (!result && fileSize > 0 && fileSizeMB <= effectiveParallelThresholdMB
                && (native?.fastDecompressGzipFileAsync || native?.fastDecompressGzipOneshot)) {
              try {
                result = await this.oneshotLocalGzLoad(webview, fsPath, signal);
              } catch (err) {
                this.logPerf(`[oneshot] failed, falling back: ${String(err)}`);
                result = null;
              }
            }

            // 3. Small file (or native unavailable) → JS gunzipSync (no stream overhead)
            //    This is the key path for Remote-SSH Linux where native is unavailable:
            //    eliminates createReadStream + pipe + event-loop startup cost.
            if (!result && fileSize > 0 && fileSizeMB <= SMALL_FILE_THRESHOLD_MB) {
              try {
                result = await this.jsOneshotLocalGzLoad(webview, fsPath, signal);
              } catch (err) {
                this.logPerf(`[js-oneshot] failed, falling back to streaming: ${String(err)}`);
                result = null;
              }
            }

            // 4. Fallback: streaming zlib
            //    In Remote-SSH, this is the PREFERRED path for medium-to-large files
            //    (10MB–200MB) because it provides early preview (z=0 slice at ~50ms)
            //    while the full volume continues to decompress + transfer in background.
            if (!result) {
              result = await this.streamingLocalGzLoad(webview, fsPath, signal);
            }

            if (!result || signal.aborted) return;
            rawData = result.rawData;
            header = result.header;
            streamStats = result.stats;  // min/max computed during load (full scan, free)
            streamTiming = result.timing;
          } else {
            // Uncompressed .nii, or Analyze .hdr + companion .img
            const headerPath = pair?.headerUri.fsPath || fsPath;
            const dataPath = pair?.dataUri.fsPath || fsPath;
            if (pair?.separateImg && headerPath !== dataPath) {
              const headerBuf = await fs.promises.readFile(headerPath);
              if (signal.aborted) return;
              header = this.parseNiiHeaderFromBuffer(new Uint8Array(headerBuf), true);
              if (!header) return;
              const imgData = await fs.promises.readFile(dataPath);
              if (signal.aborted) return;
              rawData = new Uint8Array(imgData.buffer, imgData.byteOffset, imgData.byteLength);
            } else {
              const fullData = await fs.promises.readFile(fsPath);
              if (signal.aborted) return;
              rawData = new Uint8Array(fullData.buffer, fullData.byteOffset, fullData.byteLength);
              header = this.parseNiiHeaderFromBuffer(rawData);
              if (!header) return;
            }
          }

          if (signal.aborted) return;

          const perfT1 = performance.now();
          // ── Float64 → Float32 downcast ──
          // Float64 MRI data is rare and wasteful for visualization: it doubles
          // memory, doubles the Extension→Webview postMessage copy (the single
          // biggest bottleneck), and offers no visual benefit over Float32
          // (23-bit mantissa is far beyond the 8-bit display range).
          // Downcasting cuts 465MB → 232MB for a typical 512³ volume.
          let min: number, max: number;
          if (header.datatype === 64) {
            const n64 = header.nx * header.ny * header.nz;
            const src64 = new Float64Array(rawData.buffer, rawData.byteOffset + header.voxOffset, n64);
            const f32Buf = new ArrayBuffer(n64 * 4);
            const dst32 = new Float32Array(f32Buf);
            let lo = Infinity, hi = -Infinity;
            for (let i = 0; i < n64; i++) {
              const v = src64[i];
              dst32[i] = v;
              if (v < lo) lo = v;
              if (v > hi) hi = v;
            }
            if (lo === hi) hi = lo + 1;
            if (!isFinite(lo) || !isFinite(hi)) { lo = 0; hi = 1; }
            min = lo; max = hi;
            rawData = new Uint8Array(f32Buf);
            header.datatype = 16;       // Float32
            header.bytesPerVoxel = 4;
            header.bitpix = 32;
            header.voxOffset = 0;       // new buffer has no NIfTI header
          } else if (streamStats) {
            // Stats were already computed during streaming decompression
            min = streamStats.min;
            max = streamStats.max;
          } else {
            const stats = computeVoxelStats(rawData, header, fsPath);
            min = stats.min;
            max = stats.max;
          }

          const perfT2 = performance.now();
          const nFinal = header.nx * header.ny * header.nz;
          const elemSizeFinal = header.bytesPerVoxel;
          const voxelOnly = rawData.subarray(header.voxOffset, header.voxOffset + nFinal * elemSizeFinal);

          this.volumeCache.set(uriKey, {
            header,
            voxelData: voxelOnly,
            min, max,
            slope: header.scl_slope || 1,
            inter: header.scl_inter || 0,
          });
          this.updateCacheStatusBar();

          const perfT3 = performance.now();

          // ── Avoid double copy: pass the full underlying ArrayBuffer ──
          // Previous code did `voxelOnly.buffer.slice(...)` which COPIED the
          // entire voxel region, then postMessage copied it AGAIN (VS Code
          // webview postMessage doesn't support Transferable). For a 465MB
          // Float64 volume that was ~2s of pure memcpy.
          // Now we pass the full buffer + voxOffset; the webview creates a
          // zero-copy typed-array view at the correct offset.
          const voxelBuffer = rawData.buffer;
          const voxelBytes = nFinal * elemSizeFinal;

          // Measure the synchronous part of postMessage (structured-clone
          // serialization + IPC dispatch). This is the extension-side cost;
          // the webview-side receive time uses a different performance.now()
          // origin (worker startup), so receiveTime - sendTime would be
          // meaningless. We report postMessageSyncMs instead.
          const postMsgStart = performance.now();
          webview.postMessage({
            type: 'cachedVolume',
            header,
            voxelData: voxelBuffer,
            // Webview uses this to create a zero-copy typed-array view at the
            // correct offset, avoiding a costly buffer.slice() on its side too.
            voxOffset: header.voxOffset,
            voxelLength: voxelBytes,
            datatype: header.datatype,
            globalMin: min,
            globalMax: max,
            slope: header.scl_slope || 1,
            inter: header.scl_inter || 0,
            sliceIdx: {
              axial: Math.floor(header.nz / 2),
              coronal: Math.floor(header.ny / 2),
              sagittal: Math.floor(header.nx / 2),
            },
            // Performance instrumentation: webview measures its own receive→render
            // interval (same-origin clock) and posts back a perfReport. Extension
            // reports its own decompress/downcast/cache/serial time. Total wall
            // time = extTotal + postMessageSyncMs + webviewReceiveToRender +
            // IPC latency (not directly measurable; bounded by sync time).
            perfVoxelBytes: voxelBytes,
            perfExtTiming: {
              totalLoad: +(perfT1 - perfT0).toFixed(1),
              downcastOrStats: +(perfT2 - perfT1).toFixed(1),
              cacheSet: +(perfT3 - perfT2).toFixed(1),
              postMessageSync: +(performance.now() - postMsgStart).toFixed(1),
              voxelBytes,
              isGzip,
              isRemoteSSH,
              stream: streamTiming,
            },
          });
          const postMsgEnd = performance.now();
          // Update the ext timing with actual sync time for the report
          streamTiming.postMessageSync = +(postMsgEnd - postMsgStart).toFixed(1);

        } catch (err) {
          if (!isAbortError(err)) {
            console.error('Local load error:', err);
          }
        }
      },
    });
  }

  /**
   * Single-pass streaming gzip load: decompresses the file once,
   * sends z=0 preview as soon as available, and returns the full
   * decompressed data. Eliminates the previous double-read bug.
   * Also computes min/max during decompression (full scan, free).
   */
  private async streamingLocalGzLoad(
    webview: vscode.Webview,
    fsPath: string,
    signal: AbortSignal
  ): Promise<{ rawData: Uint8Array; header: NiiHeader; stats: { min: number; max: number } | null; timing: Record<string, number> } | null> {
    const timing: Record<string, number> = {};
    return new Promise((resolve, reject) => {
      // chunkSize: output buffer per flush. Default 16KB causes ~29000 data
      // events for a 465MB volume, dominating runtime with event-loop overhead
      // (observed: 3.5s for 342MB → 465MB). Bumping to 16MB cuts this to ~29
      // events and lets zlib stream large slices per call. Memory cost: one
      // 16MB output buffer (transient, GC'd after end).
      const gunzip = zlib.createGunzip({ chunkSize: 16 * 1024 * 1024 });

      // ── Pre-allocate output buffer using gzip ISIZE ──
      // gzip footer (RFC 1952): last 8 bytes = CRC32 (4) + ISIZE (4, LE u32).
      // ISIZE = uncompressed size mod 2^32. For files < 4GB this is the exact
      // decompressed size. Pre-allocating avoids Buffer.concat (which copies
      // every chunk → 465MB copy, ~50-80ms) and cuts peak memory from
      // ~930MB (chunks[] + concat result) to ~481MB (single outputBuf).
      let outputBuf: Buffer | null = null;
      let outputOffset = 0;
      let preallocSize = 0;
      try {
        const fd = fs.openSync(fsPath, 'r');
        const stat = fs.fstatSync(fd);
        if (stat.size > 8) {
          const tail = Buffer.alloc(8);
          fs.readSync(fd, tail, 0, 8, stat.size - 8);
          const isize = tail.readUInt32LE(4);
          // Sanity: ISIZE must be > compressed size (decompressing expands),
          // non-zero, and < 4GB (otherwise it wrapped and we can't trust it).
          if (isize > 0 && isize < 0xFFFFFFFF && isize > stat.size) {
            outputBuf = Buffer.allocUnsafe(isize);
            preallocSize = isize;
          }
        }
        fs.closeSync(fd);
      } catch { /* fall back to chunks[] path */ }

      const chunks: Buffer[] = [];
      let totalSize = 0;
      let resolved = false;
      let header: NiiHeader | null = null;
      let previewSent = false;
      let firstSliceNeeded = Infinity;
      let tFsStart = 0, tFirstData = 0, tHeaderParsed = 0, tPreviewSent = 0, tDecompressEnd = 0;

      // 16MB highWaterMark: fewer syscalls, better SSD throughput.
      // 4MB was too small for 350MB+ files — the stream kept stalling.
      tFsStart = performance.now();
      const fileStream = fs.createReadStream(fsPath, { highWaterMark: 16 * 1024 * 1024 });
      fileStream.pipe(gunzip);

      const onAbort = () => {
        if (!resolved) {
          resolved = true;
          fileStream.destroy();
          gunzip.destroy();
          reject(new DOMException('Aborted', 'AbortError'));
        }
      };
      if (signal) signal.addEventListener('abort', onAbort, { once: true });

      gunzip.on('data', (chunk: Buffer) => {
        if (resolved) return;
        if (signal.aborted) { gunzip.destroy(); return; }
        if (!tFirstData) tFirstData = performance.now();

        if (outputBuf) {
          // Pre-alloc path: copy chunk into pre-allocated buffer (zero-alloc).
          // If chunk overruns pre-alloc (ISIZE was wrong), demote to chunks[]
          // for the rest of the stream — rare, only if gzip footer was corrupt.
          if (outputOffset + chunk.length <= preallocSize) {
            chunk.copy(outputBuf, outputOffset);
            outputOffset += chunk.length;
          } else {
            // Overflow: copy what we already wrote, then push overflowing chunk.
            chunks.push(Buffer.from(outputBuf.subarray(0, outputOffset)));
            chunks.push(chunk);
            outputBuf = null;
          }
        } else {
          chunks.push(chunk);
        }
        totalSize += chunk.length;

        // Parse header as soon as we have enough data
        if (!header && totalSize >= 544) {
          const buf = outputBuf
            ? outputBuf.subarray(0, outputOffset)
            : Buffer.concat(chunks);
          header = this.parseNiiHeaderFromBuffer(new Uint8Array(buf.buffer, buf.byteOffset, buf.length));
          if (header) {
            tHeaderParsed = performance.now();
            const { nx, ny, voxOffset, bytesPerVoxel } = header;
            firstSliceNeeded = voxOffset + nx * ny * bytesPerVoxel;
          }
        }

        // Send z=0 preview as soon as available
        if (header && !previewSent && totalSize >= firstSliceNeeded) {
          previewSent = true;
          tPreviewSent = performance.now();
          const previewBuf = outputBuf
            ? outputBuf.subarray(0, outputOffset)
            : Buffer.concat(chunks);
          this.sendEarlyPreviewFromBuffer(webview, header, previewBuf, signal);
        }
      });

      gunzip.on('end', () => {
        if (signal) signal.removeEventListener('abort', onAbort);
        if (resolved) return;
        resolved = true;
        tDecompressEnd = performance.now();
        let buf: Buffer;
        if (outputBuf && outputOffset === preallocSize) {
          // Pre-alloc success: use buffer directly, NO concat.
          // Saves one 465MB copy (~50-80ms) and 465MB peak memory.
          buf = outputBuf;
        } else {
          buf = Buffer.concat(chunks, totalSize);
        }
        const rawData = new Uint8Array(buf.buffer, buf.byteOffset, buf.length);
        if (!header) {
          header = this.parseNiiHeaderFromBuffer(rawData);
          tHeaderParsed = performance.now();
        }
        if (!header) {
          reject(new Error('Failed to parse NIfTI header'));
          return;
        }
        const tStatsStart = performance.now();
        // Compute min/max in a single pass over the fully decompressed data.
        // This is "free" — we're already touching the data once for cache,
        // and it gives exact stats (vs. the sampled computeVoxelStats).
        const stats = computeVoxelStats(rawData, header, fsPath);
        const tStatsEnd = performance.now();
        timing.fsToFirstData = +(tFirstData - tFsStart).toFixed(1);
        timing.headerParse = +(tHeaderParsed - tFirstData).toFixed(1);
        timing.previewReady = +(tPreviewSent - tHeaderParsed).toFixed(1);
        timing.totalDecompress = +(tDecompressEnd - tFsStart).toFixed(1);
        timing.statsCompute = +(tStatsEnd - tStatsStart).toFixed(1);
        timing.decompressedBytes = totalSize;
        resolve({ rawData, header, stats, timing });
      });

      gunzip.on('error', (err) => {
        if (signal) signal.removeEventListener('abort', onAbort);
        if (!resolved) { resolved = true; reject(err); }
      });

      fileStream.on('error', (err) => {
        if (signal) signal.removeEventListener('abort', onAbort);
        if (!resolved) { resolved = true; reject(err); }
      });
    });
  }

  /**
   * Parallel gzip decompression for local .nii.gz files (multi-core, cross-platform).
   *
   * Uses lgz (speculative DEFLATE block-boundary scanner + rayon) to decompress
   * across all available CPU cores. Works on ANY gzip file — not just pigz/bgzf
   * with flush markers — because it forward-searches for valid DEFLATE block
   * starts and decodes each segment with a 32KB LZ77 prefix window.
   *
   * Cross-platform: pure Rust + rayon, no OS-specific dependencies.
   * Compiles and runs on macOS (aarch64 + x86_64), Linux (x86_64 + aarch64),
   * and Windows (x86_64).
   *
   * Expected speedup on Apple Silicon (8 perf cores): 4-6x vs single-threaded
   * libdeflate. 465MB decompress: ~150-300ms standalone, ~250-450ms in extension.
   *
   * Trade-offs:
   *   - No early preview (z=0 during decompression). Preview is sent after
   *     decompression (~250-450ms vs ~50ms for streaming).
   *   - Higher peak memory (~807MB: holds mmap input + decompressed output).
   *
   * Fallback: if lgz fails (decode error, malformed file, etc.), the caller
   * falls back to oneshotLocalGzLoad, then streamingLocalGzLoad.
   */
  private async parallelLocalGzLoad(
    webview: vscode.Webview,
    fsPath: string,
    signal: AbortSignal
  ): Promise<{ rawData: Uint8Array; header: NiiHeader; stats: { min: number; max: number } | null; timing: Timing } | null> {
    const timing: Timing = {};
    const native = getNativeBindings();
    if (!native?.fastDecompressGzipParallelAsync) {
      throw new Error('native fastDecompressGzipParallelAsync unavailable');
    }

    // ── 1. Rust: mmap + lgz speculative parallel decompress (worker thread) ──
    // Entire pipeline (open + mmap + gzip header parse + speculative scan +
    // parallel decode + CRC check) runs in a libuv worker thread via AsyncTask.
    // Returns Node.js Buffer wrapping the decompressed Vec<u8> (heap transfer).
    const tStart = performance.now();
    let decompressed: Uint8Array | Buffer;
    try {
      decompressed = await native.fastDecompressGzipParallelAsync(fsPath);
    } catch (err) {
      throw new Error(`fastDecompressGzipParallelAsync failed: ${String(err)}`);
    }
    const tDecompressEnd = performance.now();
    if (signal.aborted) return null;

    // Zero-copy type view (Buffer IS a Uint8Array in Node.js)
    const rawData: Uint8Array = decompressed;

    // ── 2. Parse NIfTI header ──
    const tHeaderStart = performance.now();
    const header = this.parseNiiHeaderFromBuffer(rawData);
    const tHeaderEnd = performance.now();
    if (!header) {
      throw new Error('Failed to parse NIfTI header after parallel decompression');
    }

    // ── 3. Send early preview (z=0 axial slice) ──
    const decompressedBuf = Buffer.isBuffer(decompressed)
      ? decompressed
      : Buffer.from(decompressed.buffer, decompressed.byteOffset, decompressed.byteLength);
    this.sendEarlyPreviewFromBuffer(webview, header, decompressedBuf, signal);
    const tPreviewSent = performance.now();

    // ── 4. Compute min/max stats ──
    const tStatsStart = performance.now();
    const stats = computeVoxelStats(rawData, header, fsPath);
    const tStatsEnd = performance.now();

    // ── 5. Report timings ──
    // All Rust-side work (mmap + scan + parallel decode) is one combined number.
    timing.fsToFirstData = +((tDecompressEnd - tStart).toFixed(1));
    timing.headerParse = +(tHeaderEnd - tHeaderStart).toFixed(1);
    timing.previewReady = +(tPreviewSent - tHeaderEnd).toFixed(1);
    timing.totalDecompress = +((tDecompressEnd - tStart).toFixed(1));
    timing.nativeDecompress = timing.totalDecompress;  // combined (Rust did everything)
    timing.statsCompute = +(tStatsEnd - tStatsStart).toFixed(1);
    timing.decompressedBytes = rawData.byteLength;
    timing.nativeBackend = 'rusty-rapidgzip';
    timing.asyncPath = true;

    return { rawData, header, stats, timing };
  }

  /**
   * One-shot libdeflate decompression for local .nii.gz files.
   *
   * Reads the entire compressed file into memory, then calls the native
   * libdeflate binding to decompress in a single call. ~2x faster than
   * streaming zlib on Apple Silicon because libdeflate uses more aggressive
   * SIMD inflate (NEON) and avoids Node.js stream/event-loop overhead.
   *
   * Trade-off vs streaming:
   *   + ~2x faster total decompress (550-650ms vs 1153ms for 465MB)
   *   - No early preview (z=0 slice during decompression); preview is sent
   *     after decompression instead (~600ms delay vs ~50ms for streaming)
   *   - Higher peak memory (~807MB vs ~481MB: holds compressed + decompressed)
   *
   * Fallback: if native unavailable, ISIZE=0 (multi-stream gzip), or
   * decompression errors, the caller falls back to streamingLocalGzLoad.
   */
  private async oneshotLocalGzLoad(
    webview: vscode.Webview,
    fsPath: string,
    signal: AbortSignal
  ): Promise<{ rawData: Uint8Array; header: NiiHeader; stats: { min: number; max: number } | null; timing: Timing } | null> {
    const timing: Timing = {};
    const native = getNativeBindings();

    // ── Strategy selection ──
    // Prefer fastDecompressGzipFileAsync (mmap + AsyncTask + libdeflate):
    //   - mmap in Rust avoids Node.js fs.readFile overhead (396-1459ms → ~10-50ms)
    //   - AsyncTask runs on libuv worker thread, NOT blocking JS main thread
    //     (eliminates 22-43% slowdown: 964-1133ms → 791ms baseline)
    //   - Single Rust call: mmap + libdeflate oneshot, returns Buffer
    // Fall back to fastDecompressGzipOneshot (sync, V8 Buffer input) only if
    // async version unavailable (older native binary).
    const useAsync = !!native?.fastDecompressGzipFileAsync;
    if (!useAsync && !native?.fastDecompressGzipOneshot) {
      throw new Error('native fastDecompressGzipFileAsync/Oneshot unavailable');
    }

    // ── 1+2. Rust mmap + libdeflate oneshot (async, off-thread) ──
    // For async path: single call returns Promise<Buffer>. Worker thread
    // does: open file → mmap → read ISIZE → pre-allocate → libdeflate inflate
    // → return Vec<u8> (converted to Node Buffer in resolve()).
    // For sync fallback path: TS reads file then calls sync native fn
    // (kept for backward compat with older native binaries).
    const tStart = performance.now();
    let decompressed: Uint8Array | Buffer;
    let tFsEnd: number;
    let tDecompressEnd: number;

    if (useAsync) {
      // Async path: entire fs read + decompress happens in Rust worker thread.
      // We can't separate fs read time from decompress time without Rust-side
      // timing, but the total is what matters (and it's much faster).
      try {
        decompressed = await native!.fastDecompressGzipFileAsync!(fsPath);
      } catch (err) {
        throw new Error(`fastDecompressGzipFileAsync failed: ${String(err)}`);
      }
      if (signal.aborted) return null;
      tFsEnd = performance.now();        // approx (mmap+decompress combined)
      tDecompressEnd = tFsEnd;
    } else {
      // Sync fallback path (older native binary): TS reads file, calls sync fn.
      const compressed = await fs.promises.readFile(fsPath);
      if (signal.aborted) return null;
      tFsEnd = performance.now();
      decompressed = native!.fastDecompressGzipOneshot!(compressed);
      tDecompressEnd = performance.now();
    }

    // Convert to Uint8Array view (zero-copy: napi Buffer IS a Uint8Array,
    // so this is just a type view, no copy. Buffer extends Uint8Array in Node.js.)
    const rawData: Uint8Array = decompressed;

    // ── 3. Parse NIfTI header ──
    const tHeaderStart = performance.now();
    const header = this.parseNiiHeaderFromBuffer(rawData);
    const tHeaderEnd = performance.now();
    if (!header) {
      throw new Error('Failed to parse NIfTI header after libdeflate decompression');
    }

    // ── 4. Send early preview (z=0 axial slice) ──
    // Streaming sends this during decompression (~50ms); oneshot sends it
    // after decompression (~600ms). Still useful for user feedback.
    // Use Buffer view for zero-copy preview extraction.
    const decompressedBuf = Buffer.isBuffer(decompressed)
      ? decompressed
      : Buffer.from(decompressed.buffer, decompressed.byteOffset, decompressed.byteLength);
    this.sendEarlyPreviewFromBuffer(webview, header, decompressedBuf, signal);
    const tPreviewSent = performance.now();

    // ── 5. Compute min/max stats (full scan, free) ──
    const tStatsStart = performance.now();
    const stats = computeVoxelStats(rawData, header, fsPath);
    const tStatsEnd = performance.now();

    // ── 6. Report timings ──
    // For async path: fsToFirstData and nativeDecompress are not separable
    // (both happen in Rust worker thread). Report combined as totalDecompress
    // and set nativeDecompress = totalDecompress for backward-compat display.
    if (useAsync) {
      timing.fsToFirstData = +((tFsEnd - tStart).toFixed(1));
      timing.headerParse = +(tHeaderEnd - tHeaderStart).toFixed(1);
      timing.previewReady = +(tPreviewSent - tHeaderEnd).toFixed(1);
      // totalDecompress = entire Rust worker time (mmap + inflate + buffer transfer)
      timing.totalDecompress = +((tDecompressEnd - tStart).toFixed(1));
      // nativeDecompress reported as same (Rust didn't break it down).
      // Display layer will show "[libdeflate] native decompress" = total.
      timing.nativeDecompress = timing.totalDecompress;
      timing.statsCompute = +(tStatsEnd - tStatsStart).toFixed(1);
      timing.decompressedBytes = rawData.byteLength;
      timing.nativeBackend = 'libdeflate';
      timing.asyncPath = true;
    } else {
      timing.fsToFirstData = +((tFsEnd - tStart).toFixed(1));
      timing.headerParse = +(tHeaderEnd - tHeaderStart).toFixed(1);
      timing.previewReady = +(tPreviewSent - tHeaderEnd).toFixed(1);
      timing.totalDecompress = +((tDecompressEnd - tStart).toFixed(1));
      timing.nativeDecompress = +((tDecompressEnd - tFsEnd).toFixed(1));
      timing.statsCompute = +(tStatsEnd - tStatsStart).toFixed(1);
      timing.decompressedBytes = rawData.byteLength;
      timing.nativeBackend = 'libdeflate';
      timing.asyncPath = false;
    }

    return { rawData, header, stats, timing };
  }

  /**
   * Remote-SSH fast path: serve the file over the localhost HTTP proxy and
   * port-forward it via vscode.env.asExternalUri, then let the webview
   * Worker fetch the forwarded URL directly.
   *
   * Large files (≥8MB) keep the compressed object on the remote disk: the
   * host extracts a cheap z=0 / ortho preview and the webview scrolls via
   * /slice. Small files still stream the whole compressed object — the
   * extra round trips of slice mode are a net loss below that size.
   *
   * Returns true if the fast path was dispatched (webview will drive the
   * load); false if port forwarding is unavailable (caller falls back to
   * the postMessage paths).
   */
  private async tryRemoteSshHttpLoad(
    webview: vscode.Webview,
    webviewId: string,
    loadId: string,
    uri: vscode.Uri,
    fsPath: string,
    fileSize: number,
    validationToken: string,
    signal: AbortSignal
  ): Promise<boolean> {
    try {
      if (!this.proxy) {
        this.proxy = new LocalFileProxy(this.volumeCache);
        await this.proxy.start();
        this.context.subscriptions.push({ dispose: () => this.proxy?.stop() });
      }
      const pair = await resolveAnalyzePair(uri);
      const proxyUrl = this.proxy.registerFile(pair.headerUri, pair.separateImg ? pair.dataUri : undefined);
      const entryId = proxyUrl.split('/').pop()!;
      // Ask VS Code to forward the remote-side localhost port so the local
      // webview can reach it. Throws when forwarding is unavailable
      // (e.g. restricted remote environments).
      const external = await vscode.env.asExternalUri(vscode.Uri.parse(proxyUrl));

      const sliceMode = shouldUseSliceMode(fileSize);
      const isGzip = fsPath.endsWith('.gz');

      this.remoteHttpFallbacks.set(loadId, {
        webview, fsPath, fileSize, validationToken, signal,
        isGzip,
      });

      if (sliceMode) {
        if (isGzip) {
          const statusItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
          statusItem.text = '$(sync~spin) Preparing remote volume...';
          statusItem.show();
          this.gzipIndexStatusItems.set(webviewId, statusItem);
          this.proxy.startGzipIndex(entryId, (pct: number) => {
            statusItem.text = `$(sync~spin) Preparing remote volume... ${pct}%`;
          });
          void this.proxy.whenGzipIndexReady(entryId).then(() => {
            statusItem.dispose();
            this.gzipIndexStatusItems.delete(webviewId);
          });
        }
        let preview: Awaited<ReturnType<LocalFileProxy['extractPreviewForWebview']>> = null;
        try {
          preview = await this.proxy.extractPreviewForWebview(entryId, signal);
        } catch (err) {
          this.logPerf(`[remote-ssh-slice] preview extract failed (${String(err)}) — still dispatching slice URL`);
        }
        if (signal.aborted) {
          this.remoteHttpFallbacks.delete(loadId);
          return true;
        }

        const ok = await webview.postMessage({
          type: 'remoteSliceMode',
          sourceIdentity: `${os.hostname()}|${uri.toString()}`,
          url: external.toString(),
          fileName: path.basename(fsPath),
          webviewId,
          loadId,
          fileSize,
          validationToken,
          isGzip,
          deferFullVolume: true,
          header: preview?.header,
          globalMin: preview?.globalMin ?? 0,
          globalMax: preview?.globalMax ?? 1,
          slope: preview?.slope ?? 1,
          inter: preview?.inter ?? 0,
          sliceIdx: preview?.sliceIdx,
          axialSlice: preview?.slices.axial,
          coronalSlice: preview?.slices.coronal,
          sagittalSlice: preview?.slices.sagittal,
          partialPreview: true,
          perfExtTiming: {
            isRemoteSSH: true,
            path: 'remote-ssh-slice',
          },
        });
        if (!ok) {
          this.remoteHttpFallbacks.delete(loadId);
          return false;
        }
        if (isGzip) {
          const unsubscribe = this.proxy.subscribeGzipPreview(entryId, (ortho) => {
            if (signal.aborted) return;
            void webview.postMessage({
              type: 'previewOrtho', url: external.toString(), validationToken,
              header: ortho.header, globalMin: ortho.min, globalMax: ortho.max,
              slope: ortho.slope, inter: ortho.inter, sliceIdx: ortho.sliceIdx,
              axialSlice: ortho.axial, coronalSlice: ortho.coronal, sagittalSlice: ortho.sagittal,
            });
          });
          signal.addEventListener('abort', unsubscribe, { once: true });
          void this.proxy.whenGzipIndexReady(entryId).finally(() => signal.removeEventListener('abort', unsubscribe));
        }
        this.logPerf(`[remote-ssh-slice] dispatched ${path.basename(fsPath)} (${(fileSize / 1048576).toFixed(1)}MB) via ${external.toString()}`);
        return true;
      }

      const ok = await webview.postMessage({
        type: 'remoteSshHttp',
        sourceIdentity: `${os.hostname()}|${uri.toString()}`,
        url: external.toString(),
        fileName: path.basename(fsPath),
        webviewId,
        loadId,
        fileSize,
        validationToken,
        isGzip,
        perfExtTiming: {
          isRemoteSSH: true,
          path: 'remote-ssh-http',
        },
      });
      if (!ok) {
        this.remoteHttpFallbacks.delete(loadId);
        return false;
      }
      this.logPerf(`[remote-ssh-http] dispatched ${path.basename(fsPath)} (${(fileSize / 1048576).toFixed(1)}MB) via ${external.toString()}`);
      return true;
    } catch (err) {
      this.remoteHttpFallbacks.delete(loadId);
      this.logPerf(`[remote-ssh-http] unavailable (${String(err)}) — falling back to postMessage transfer`);
      return false;
    }
  }

  /**
   * Remote-SSH compressed transfer: read the .nii.gz file WITHOUT
   * decompressing on the extension host, and ship the compressed bytes
   * to the webview. The webview decompresses locally with the browser-
   * native DecompressionStream, avoiding a postMessage of the full
   * DECOMPRESSED volume across the SSH tunnel (3-5x network saving).
   *
   * The extension host does zero inflate work — it only does one fs read.
   * This is platform-agnostic: works on any remote (Linux/Win/Mac)
   * regardless of native module availability, because decompression runs
   * in the webview's browser engine.
   */
  private async remoteSshCompressedLoad(
    webview: vscode.Webview,
    fsPath: string,
    fileSize: number,
    validationToken: string,
    signal: AbortSignal
  ): Promise<void> {
    const tStart = performance.now();
    // 1. Single read of the COMPRESSED file — no gunzip on the ext host.
    const compressed = await fs.promises.readFile(fsPath);
    if (signal.aborted) return;
    const tReadEnd = performance.now();

    // 2. Ship compressed bytes to the webview. The webview runs locally,
    //    so DecompressionStream inflate uses the local CPU (fast, idle),
    //    and only the small compressed payload crosses the SSH tunnel.
    const postMsgStart = performance.now();
    webview.postMessage({
      type: 'compressedVolume',
      compressedData: compressed.buffer,
      fileName: path.basename(fsPath),
      fileSize,
      validationToken,
      perfExtTiming: {
        fsRead: +((tReadEnd - tStart).toFixed(1)),
        postMessageSync: +(performance.now() - postMsgStart).toFixed(1),
        totalLoad: +((tReadEnd - tStart).toFixed(1)),
        isRemoteSSH: true,
        compressedBytes: compressed.byteLength,
        // Sentinel so handlePerfReport can label this path distinctly
        // from the in-extension decompression paths.
        path: 'remote-ssh-compressed',
      },
    });
  }

  /**
   * Remote-SSH chunked transfer (fallback when the port-forwarded HTTP
   * path is unavailable): read the file in chunks and postMessage each
   * separately, avoiding the synchronous structured-clone cost of one
   * huge ArrayBuffer.
   *
   * Pipelined: messages are posted without awaiting each one — we keep a
   * bounded window of chunks in flight (4MB × 6 ≈ 24MB buffered) so the
   * RPC channel stays saturated instead of idling one round-trip per
   * chunk. This is ~6x faster than the previous sequential await.
   */
  async remoteSshChunkedLoad(
    webview: vscode.Webview,
    fsPath: string,
    fileSize: number,
    validationToken: string,
    signal: AbortSignal,
    isGzip: boolean = true
  ): Promise<void> {
    const CHUNK_SIZE = 4 * 1024 * 1024; // 4MB per postMessage
    const MAX_INFLIGHT = 6;             // pipelining window
    const totalChunks = Math.max(1, Math.ceil(fileSize / CHUNK_SIZE));
    const tStart = performance.now();

    // Use createReadStream for efficient chunked reading
    const stream = fs.createReadStream(fsPath, { highWaterMark: CHUNK_SIZE });
    let chunkIndex = 0;
    const inflight: Thenable<boolean>[] = [];

    try {
      for await (const chunk of stream) {
        if (signal.aborted) { stream.destroy(); return; }

        // Extract a clean ArrayBuffer (Node Buffer may have byteOffset)
        const ab = chunk.buffer.slice(chunk.byteOffset, chunk.byteOffset + chunk.byteLength);

        // Fire without awaiting: FIFO order is preserved by VS Code's
        // message channel, and the webview reorders defensively anyway.
        inflight.push(webview.postMessage({
          type: 'chunkedVolume',
          chunk: ab,
          index: chunkIndex,
          total: totalChunks,
          isGzip,
          fileName: path.basename(fsPath),
          fileSize,
          validationToken,
          perfExtTiming: {
            isRemoteSSH: true,
            path: 'remote-ssh-chunked',
            compressedBytes: fileSize,
          },
        }));
        chunkIndex++;

        // Backpressure: wait for the oldest in-flight message before
        // queueing more, keeping the window bounded.
        if (inflight.length >= MAX_INFLIGHT) {
          await inflight.shift();
          // Yield to the event loop so other extensions, UI, and command
          // palette can run between batches.
          await new Promise<void>(r => setImmediate(r));
        }
      }
      await Promise.all(inflight);

      this.logPerf(`[remote-ssh-chunked] sent ${chunkIndex}/${totalChunks} chunks for ${path.basename(fsPath)} in ${+(performance.now() - tStart).toFixed(0)}ms`);
    } finally {
      stream.destroy();
    }
  }

  /**
   * JS-only one-shot gzip decompression for small local .nii.gz files.
   *
   * Uses Node.js fs.readFile + zlib.gunzipSync — no native module required.
   * Eliminates the stream startup overhead (createReadStream + pipe +
   * event-loop scheduling) that dominates small-file load time.
   *
   * Benchmark on 4.8MB file (Remote-SSH Linux, no native):
   *   streaming: 60-80ms (stream startup ~45ms + gunzip ~15ms)
   *   js-oneshot: 15-20ms (readFile ~5ms + gunzipSync ~10ms)
   *
   * No early preview: the full volume is ready in <25ms, so sending a
   * z=0 partial preview would be pure waste (postMessage overhead > gain).
   * The webview already ignores partialPreview messages.
   *
   * Fallback: if gunzipSync fails (rare; corrupt or multi-stream gzip),
   * the caller falls back to streamingLocalGzLoad.
   */
  private async jsOneshotLocalGzLoad(
    webview: vscode.Webview,
    fsPath: string,
    signal: AbortSignal
  ): Promise<{ rawData: Uint8Array; header: NiiHeader; stats: { min: number; max: number } | null; timing: Timing } | null> {
    const tStart = performance.now();
    // 1. Single readFile — no stream, no pipe, no event-loop scheduling.
    const compressed = await fs.promises.readFile(fsPath);
    if (signal.aborted) return null;
    const tFsEnd = performance.now();

    // 2. Synchronous gunzip — single V8→zlib call, no 'data' events.
    const decompressed = zlib.gunzipSync(compressed);
    const tDecompressEnd = performance.now();

    const rawData: Uint8Array = new Uint8Array(
      decompressed.buffer, decompressed.byteOffset, decompressed.byteLength
    );

    // 3. Parse NIfTI header.
    const tHeaderStart = performance.now();
    const header = this.parseNiiHeaderFromBuffer(rawData);
    const tHeaderEnd = performance.now();
    if (!header) {
      throw new Error('Failed to parse NIfTI header after gunzipSync');
    }

    // 4. No early preview — full volume ready in <25ms, preview is waste.

    // 5. Compute min/max stats.
    const tStatsStart = performance.now();
    const stats = computeVoxelStats(rawData, header, fsPath);
    const tStatsEnd = performance.now();

    return {
      rawData, header, stats,
      timing: {
        fsToFirstData: +((tFsEnd - tStart).toFixed(1)),
        headerParse: +((tHeaderEnd - tHeaderStart).toFixed(1)),
        previewReady: 0,
        totalDecompress: +((tDecompressEnd - tStart).toFixed(1)),
        nativeDecompress: +((tDecompressEnd - tFsEnd).toFixed(1)),
        statsCompute: +((tStatsEnd - tStatsStart).toFixed(1)),
        decompressedBytes: rawData.byteLength,
        nativeBackend: 'system-zlib',
        asyncPath: false,
      },
    };
  }

  /**
   * Send z=0 axial preview from a contiguous decompressed buffer.
   * Accepts a Buffer (not Buffer[]) so the pre-alloc path can pass a
   * zero-copy subarray view of outputBuf instead of concatenating chunks.
   */
  private sendEarlyPreviewFromBuffer(
    webview: vscode.Webview,
    header: NiiHeader,
    buf: Buffer,
    signal: AbortSignal
  ): void {
    try {
      const { nx, ny, voxOffset, bytesPerVoxel, datatype, scl_slope, scl_inter, littleEndian } = header;
      const sliceEnd = voxOffset + nx * ny * bytesPerVoxel;
      if (buf.length < sliceEnd) return;

      const sliceBytes = new Uint8Array(buf.buffer, buf.byteOffset + voxOffset, nx * ny * bytesPerVoxel);
      const bpv = Math.max(1, bytesPerVoxel);
      const le = littleEndian;
      const slope = scl_slope || 1;
      const inter = scl_inter || 0;
      const axialSlice = new Float32Array(nx * ny);
      const view = new DataView(sliceBytes.buffer, sliceBytes.byteOffset, sliceBytes.byteLength);

      let min = Infinity, max = -Infinity;
      for (let i = 0; i < nx * ny; i++) {
        const off = i * bpv;
        let val: number;
        switch (datatype) {
          case 2: val = sliceBytes[off]; break;
          case 4: val = view.getInt16(off, le); break;
          case 8: val = view.getInt32(off, le); break;
          case 16: val = view.getFloat32(off, le); break;
          case 64: val = view.getFloat64(off, le); break;
          case 256: val = (sliceBytes[off] << 24) >> 24; break;
          case 512: val = view.getUint16(off, le); break;
          case 768: val = view.getUint32(off, le); break;
          default: val = 0;
        }
        const v = val * slope + inter;
        axialSlice[i] = v;
        if (v < min) min = v;
        if (v > max) max = v;
      }
      if (min === max) max = min + 1;

      if (!signal.aborted) {
        webview.postMessage({
          type: 'preview',
          header,
          globalMin: min, globalMax: max,
          slope, inter,
          sliceIdx: { axial: 0, coronal: Math.floor(ny / 2), sagittal: Math.floor(nx / 2) },
          axialSlice,
          coronalSlice: new Float32Array(0),
          sagittalSlice: new Float32Array(0),
          partialPreview: true,
        });
      }
    } catch {
      // Preview failed — non-critical
    }
  }

  /**
   * Send early preview from fully decompressed raw data (native path).
   */
  private sendEarlyPreviewFromRawData(
    webview: vscode.Webview,
    header: NiiHeader,
    rawData: Uint8Array,
    signal: AbortSignal
  ): void {
    const { nx, ny, voxOffset, bytesPerVoxel, datatype, scl_slope, scl_inter, littleEndian } = header;
    const sliceBytes = rawData.subarray(voxOffset, voxOffset + nx * ny * bytesPerVoxel);
    const bpv = Math.max(1, bytesPerVoxel);
    const le = littleEndian;
    const slope = scl_slope || 1;
    const inter = scl_inter || 0;
    const axialSlice = new Float32Array(nx * ny);
    const view = new DataView(sliceBytes.buffer, sliceBytes.byteOffset, sliceBytes.byteLength);

    let min = Infinity, max = -Infinity;
    for (let i = 0; i < nx * ny; i++) {
      const off = i * bpv;
      let val: number;
      switch (datatype) {
        case 2: val = sliceBytes[off]; break;
        case 4: val = view.getInt16(off, le); break;
        case 8: val = view.getInt32(off, le); break;
        case 16: val = view.getFloat32(off, le); break;
        case 64: val = view.getFloat64(off, le); break;
        case 256: val = (sliceBytes[off] << 24) >> 24; break;
        case 512: val = view.getUint16(off, le); break;
        case 768: val = view.getUint32(off, le); break;
        default: val = 0;
      }
      const v = val * slope + inter;
      axialSlice[i] = v;
      if (v < min) min = v;
      if (v > max) max = v;
    }
    if (min === max) max = min + 1;

    if (!signal.aborted) {
      webview.postMessage({
        type: 'preview',
        header,
        globalMin: min, globalMax: max,
        slope, inter,
        sliceIdx: { axial: 0, coronal: Math.floor(ny / 2), sagittal: Math.floor(nx / 2) },
        axialSlice,
        coronalSlice: new Float32Array(0),
        sagittalSlice: new Float32Array(0),
        partialPreview: true,
      });
    }
  }

  startPreviewLoad(
    entryId: string,
    webview: vscode.Webview,
    webviewId: string,
    loadId: string,
    uri: vscode.Uri,
    signal: AbortSignal
  ): void {
    const uriKey = uri.toString();
    const isRemote = uri.scheme !== 'file';
    const cached = this.volumeCache.get(uriKey);

    if (cached) {
      const cachedBytes = cached.voxelData.byteLength;
      const skipCachedVolume = isRemote && cachedBytes >= SLICE_MODE_MIN_BYTES;
      if (!skipCachedVolume) {
        this.volumeCache.setActive(uriKey, webviewId);
        webview.postMessage({
          type: 'cachedVolume',
          header: cached.header,
          globalMin: cached.min,
          globalMax: cached.max,
          slope: cached.slope,
          inter: cached.inter,
          sliceIdx: {
            axial: Math.floor(cached.header.nz / 2),
            coronal: Math.floor(cached.header.ny / 2),
            sagittal: Math.floor(cached.header.nx / 2),
          },
          // Pass the backing buffer + offsets instead of copying the volume.
          voxelData: cached.voxelData.buffer,
          voxOffset: cached.header.voxOffset,
          voxelLength: cached.voxelData.byteLength,
          datatype: cached.header.datatype,
        });
        return;
      }
    }

    const isActive = this.isWebviewActive(webviewId);

    this.loadQueue.enqueue({
      webviewId,
      priority: isActive ? 100 : 1,
      isRemote,
      abortController: signal instanceof AbortController ? signal : new AbortController(),
      execute: async () => {
        if (signal.aborted) return;

        try {
          this.volumeCache.setActive(uriKey, webviewId);

          // For remote files: the webview Worker's streaming path now provides
          // an early preview (within ~1s for .nii.gz) by overlapping download
          // and decompression. Sending a separate preview from the Extension
          // Host would cause a redundant download of the same remote file.
          // Instead, we skip the Extension Host preview and let the Worker
          // handle everything — this cuts total time-to-preview dramatically
          // for remote files.
          //
          // Exception: for non-HTTP remote schemes (vscode-remote://, etc.),
          // the Worker can't stream directly, so we still need the preview.
          const uriScheme = uri.scheme;
          const isHttpRemote = uriScheme === 'http' || uriScheme === 'https';

          if (isRemote && isHttpRemote) {
            // HTTP(S) remotes: extract a cheap preview on the proxy (Range
            // for .nii, stream-to-z=0 for .gz) and let the webview scroll
            // via /slice. Do not start a full-volume worker download.
            const preview = await this.proxy!.extractPreviewForWebview(entryId, signal);
            if (signal.aborted) return;
            if (preview) {
              webview.postMessage({
                type: 'preview',
                header: preview.header,
                globalMin: preview.globalMin, globalMax: preview.globalMax,
                slope: preview.slope, inter: preview.inter,
                sliceIdx: preview.sliceIdx,
                axialSlice: preview.slices.axial,
                coronalSlice: preview.slices.coronal,
                sagittalSlice: preview.slices.sagittal,
                partialPreview: true,
                deferFullVolume: true,
              });
              return;
            }
            webview.postMessage({
              type: 'preview',
              header: null,
              globalMin: 0, globalMax: 1,
              slope: 1, inter: 0,
              sliceIdx: { axial: 0, coronal: 0, sagittal: 0 },
              axialSlice: new Float32Array(0),
              coronalSlice: new Float32Array(0),
              sagittalSlice: new Float32Array(0),
              partialPreview: true,
              remoteStreaming: true,
              deferFullVolume: true,
            });
            return;
          }

          if (isRemote) {
            // Non-HTTP remote (vscode-remote://, etc.): use proxy preview
            const preview = await this.proxy!.extractPreviewForWebview(entryId, signal);
            if (!preview || signal.aborted) return;

            const { header, slices, globalMin, globalMax, slope, inter, sliceIdx } = preview;

            webview.postMessage({
              type: 'preview',
              header,
              globalMin, globalMax,
              slope, inter,
              sliceIdx,
              axialSlice: slices.axial,
              coronalSlice: slices.coronal,
              sagittalSlice: slices.sagittal,
              partialPreview: true,
              deferFullVolume: true,
            });
            return;
          }

          // Local file path: load full volume and send as cachedVolume
          const entry = this.proxy!.getEntry(entryId);
          if (!entry) return;

          const { rawData, header } = await this.proxy!.loadFileData(entry, signal);
          if (!rawData || !header || signal.aborted) return;

          const voxOffset = header.voxOffset;
          const n = header.nx * header.ny * header.nz * Math.max(1, header.nt || 1);
          const elemSize = header.bytesPerVoxel;
          const voxelOnly = rawData.slice(voxOffset, voxOffset + n * elemSize);
          const { min, max } = computeVoxelStats(rawData, header);
          // The compacted copy starts at byte 0; keep the cached header and
          // the published payload consistent for later cache hits.
          header.voxOffset = 0;

          this.volumeCache.set(uriKey, {
            header,
            voxelData: voxelOnly,
            min, max,
            slope: header.scl_slope || 1,
            inter: header.scl_inter || 0,
          });
          this.updateCacheStatusBar();

          webview.postMessage({
            type: 'cachedVolume',
            header,
            voxelData: voxelOnly.buffer,
            voxOffset: 0,
            voxelLength: voxelOnly.byteLength,
            datatype: header.datatype,
            globalMin: min,
            globalMax: max,
            slope: header.scl_slope || 1,
            inter: header.scl_inter || 0,
            sliceIdx: {
              axial: Math.floor(header.nz / 2),
              coronal: Math.floor(header.ny / 2),
              sagittal: Math.floor(header.nx / 2),
            },
          });

        } catch (err) {
          if (!isAbortError(err)) {
            console.error('Preview load error:', err);
          }
        }
      },
    });
  }

  /**
   * Host-parsed formats (npy/npz/nrrd/mha/mrc/mgh/...): the parser normalizes
   * the volume into a NIfTI-shaped header, then the data flows through the
   * exact same cache / stats / LOD / cachedVolume pipeline as local NIfTI.
   * Remote hosts stay on the streaming path so only slices cross the tunnel.
   */
}

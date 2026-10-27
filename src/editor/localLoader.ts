import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import { LocalFileProxy } from '../LocalFileProxy';
import { VolumeCache } from '../VolumeCache';
import { LoadQueue } from './loadQueue';
import { getNativeBindings } from '../nativeBridge';
import { parseNiiHeaderQuick, type NiiHeader } from '../nifti/headerParser';
import { isWanRemote, shouldUseSliceMode, SLICE_MODE_MIN_BYTES } from '../remoteEnv';
import { resolveAnalyzePair, type AnalyzePair } from '../io/analyzePair';
import { computeVoxelStats } from './stats';
import { GzipVolumeLoader } from './gzipLoader';
import { isAbortError } from '../errors';

import type { Timing } from './types';

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
  private readonly gzipLoader: GzipVolumeLoader;

  constructor(private readonly host: LocalVolumeHost) {
    this.gzipLoader = new GzipVolumeLoader({
      parseHeader: (buf, separateImg) => this.parseNiiHeaderFromBuffer(buf, separateImg),
      sendEarlyPreviewFromBuffer: (webview, header, rawData, signal) =>
        this.sendEarlyPreviewFromBuffer(webview, header, rawData, signal),
    });
  }

  private get context(): vscode.ExtensionContext {
    return this.host.context;
  }
  private get volumeCache(): VolumeCache {
    return this.host.volumeCache;
  }
  private get loadQueue(): LoadQueue {
    return this.host.loadQueue;
  }
  private get remoteHttpFallbacks(): Map<string, RemoteHttpFallback> {
    return this.host.remoteHttpFallbacks;
  }
  private get gzipIndexStatusItems(): Map<string, vscode.Disposable> {
    return this.host.gzipIndexStatusItems;
  }
  private get proxy(): LocalFileProxy | null {
    return this.host.getProxy();
  }
  private set proxy(value: LocalFileProxy | null) {
    this.host.setProxy(value);
  }
  private isWebviewActive(webviewId: string): boolean {
    return this.host.isWebviewActive(webviewId);
  }
  private logPerf(line: string): void {
    this.host.logPerf(line);
  }
  private updateCacheStatusBar(): void {
    this.host.updateCacheStatusBar();
  }
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
    if (cached && !shouldUseSliceMode(fileSize, undefined, /\.nii\.gz$/i.test(uri.fsPath))) {
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
              webview,
              webviewId,
              loadId,
              uri,
              fsPath,
              fileSize,
              validationToken,
              signal,
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
            const SMALL_FILE_THRESHOLD_MB = 10; // < 10MB → JS gunzipSync (no stream overhead)
            const PARALLEL_THRESHOLD_MB = 50; // > 50MB → native parallel (rusty-rapidgzip)
            const fileSizeMB = fileSize / (1024 * 1024); // fileSize from stat at L334

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
            const REMOTE_PARALLEL_THRESHOLD_MB = 200; // only use parallel on huge files when remote

            let result: {
              rawData: Uint8Array;
              header: NiiHeader;
              stats: { min: number; max: number } | null;
              timing: Timing;
            } | null = null;

            // Determine the parallel threshold based on environment:
            //   Local: > 50MB → parallel (decompress speed matters)
            //   Remote-SSH: > 200MB → parallel (only huge files justify losing early preview)
            const effectiveParallelThresholdMB = isRemoteSSH ? REMOTE_PARALLEL_THRESHOLD_MB : PARALLEL_THRESHOLD_MB;

            // 1. Large file + native parallel → rusty-rapidgzip (multi-core)
            if (fileSize > 0 && fileSizeMB > effectiveParallelThresholdMB && native?.fastDecompressGzipParallelAsync) {
              try {
                result = await this.gzipLoader.parallelLocalGzLoad(webview, fsPath, signal);
              } catch (err) {
                this.logPerf(`[parallel] failed, falling back: ${String(err)}`);
                result = null;
              }
            }

            // 2. Medium file + native oneshot → libdeflate (single-core, no stream)
            //    In Remote-SSH, only use oneshot for medium files (< threshold) where
            //    the decompress is fast enough that early preview isn't critical.
            if (
              !result &&
              fileSize > 0 &&
              fileSizeMB <= effectiveParallelThresholdMB &&
              (native?.fastDecompressGzipFileAsync || native?.fastDecompressGzipOneshot)
            ) {
              try {
                result = await this.gzipLoader.oneshotLocalGzLoad(webview, fsPath, signal);
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
                result = await this.gzipLoader.jsOneshotLocalGzLoad(webview, fsPath, signal);
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
              result = await this.gzipLoader.streamingLocalGzLoad(webview, fsPath, signal);
            }

            if (!result || signal.aborted) return;
            rawData = result.rawData;
            header = result.header;
            streamStats = result.stats; // min/max computed during load (full scan, free)
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
            let lo = Infinity,
              hi = -Infinity;
            for (let i = 0; i < n64; i++) {
              const v = src64[i];
              dst32[i] = v;
              if (v < lo) lo = v;
              if (v > hi) hi = v;
            }
            if (lo === hi) hi = lo + 1;
            if (!isFinite(lo) || !isFinite(hi)) {
              lo = 0;
              hi = 1;
            }
            min = lo;
            max = hi;
            rawData = new Uint8Array(f32Buf);
            header.datatype = 16; // Float32
            header.bytesPerVoxel = 4;
            header.bitpix = 32;
            header.voxOffset = 0; // new buffer has no NIfTI header
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
            min,
            max,
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
   * Remote-SSH fast path: serve the file over the localhost HTTP proxy and
   * port-forward it via vscode.env.asExternalUri, then let the webview
   * Worker fetch the forwarded URL directly.
   *
   * Gzip files always show a host preview before any full-volume transfer;
   * their compressed byte count is not a reliable measure of image size.
   * Other files keep the size-based choice between slices and streaming.
   * Full volume loading remains available for MIP and registration.
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
    signal: AbortSignal,
  ): Promise<boolean> {
    try {
      if (!this.proxy) {
        this.proxy = new LocalFileProxy(this.volumeCache, (line) => this.logPerf(line));
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

      const isGzip = /\.nii\.gz$/i.test(fsPath);
      const sliceMode = shouldUseSliceMode(fileSize, undefined, isGzip);

      this.remoteHttpFallbacks.set(loadId, {
        webview,
        fsPath,
        fileSize,
        validationToken,
        signal,
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
          // The webview asks the host for planes instead of fetching the
          // forwarded proxy URL (which may not accept connections yet).
          hostSlices: true,
          entryId,
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
        this.logPerf(
          `[remote-ssh-slice] dispatched gz=${isGzip} size=${fileSize} header=${preview?.header ? `${preview.header.nx}x${preview.header.ny}x${preview.header.nz}` : 'missing'} url=${external.toString().split('/')[2]} preview=${preview ? 'yes' : 'none'}`,
        );
        // Background full-volume relay. Slice-by-slice scrolling costs one
        // webview→host round trip per wheel step (remote RPC + proxy), which
        // feels janky next to the in-memory volumes small files get. Files
        // that fit comfortably in the tunnel get the whole volume shipped
        // over the same postMessage channel: compressed bytes for .nii.gz
        // (the webview inflates locally), raw chunks otherwise. Once it
        // lands, the viewer scrolls from memory — no per-step latency.
        const FULL_VOLUME_RELAY_MAX_BYTES = 64 * 1024 * 1024;
        if (fileSize > 0 && fileSize <= FULL_VOLUME_RELAY_MAX_BYTES && !signal.aborted) {
          const relay = isGzip
            ? this.remoteSshCompressedLoad(webview, fsPath, fileSize, validationToken, signal)
            : this.remoteSshChunkedLoad(webview, fsPath, fileSize, validationToken, signal, false);
          void relay.catch((err) => this.logPerf(`[remote-ssh-slice] full-volume relay failed: ${String(err)}`));
        }
        if (isGzip) {
          const unsubscribe = this.proxy.subscribeGzipPreview(entryId, (ortho) => {
            if (signal.aborted) return;
            void webview.postMessage({
              type: 'previewOrtho',
              url: external.toString(),
              validationToken,
              header: ortho.header,
              globalMin: ortho.min,
              globalMax: ortho.max,
              slope: ortho.slope,
              inter: ortho.inter,
              sliceIdx: ortho.sliceIdx,
              axialSlice: ortho.axial,
              coronalSlice: ortho.coronal,
              sagittalSlice: ortho.sagittal,
            });
          });
          signal.addEventListener('abort', unsubscribe, { once: true });
          void this.proxy.whenGzipIndexReady(entryId).finally(() => signal.removeEventListener('abort', unsubscribe));
        }
        this.logPerf(
          `[remote-ssh-slice] dispatched ${path.basename(fsPath)} (${(fileSize / 1048576).toFixed(1)}MB) via ${external.toString()}`,
        );
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
      this.logPerf(
        `[remote-ssh-http] dispatched ${path.basename(fsPath)} (${(fileSize / 1048576).toFixed(1)}MB) via ${external.toString()}`,
      );
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
    signal: AbortSignal,
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
        fsRead: +(tReadEnd - tStart).toFixed(1),
        postMessageSync: +(performance.now() - postMsgStart).toFixed(1),
        totalLoad: +(tReadEnd - tStart).toFixed(1),
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
    isGzip: boolean = true,
  ): Promise<void> {
    const CHUNK_SIZE = 4 * 1024 * 1024; // 4MB per postMessage
    const MAX_INFLIGHT = 6; // pipelining window
    const totalChunks = Math.max(1, Math.ceil(fileSize / CHUNK_SIZE));
    const tStart = performance.now();

    // Use createReadStream for efficient chunked reading
    const stream = fs.createReadStream(fsPath, { highWaterMark: CHUNK_SIZE });
    let chunkIndex = 0;
    const inflight: Thenable<boolean>[] = [];

    try {
      for await (const chunk of stream) {
        if (signal.aborted) {
          stream.destroy();
          return;
        }

        // Extract a clean ArrayBuffer (Node Buffer may have byteOffset)
        const ab = chunk.buffer.slice(chunk.byteOffset, chunk.byteOffset + chunk.byteLength);

        // Fire without awaiting: FIFO order is preserved by VS Code's
        // message channel, and the webview reorders defensively anyway.
        inflight.push(
          webview.postMessage({
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
          }),
        );
        chunkIndex++;

        // Backpressure: wait for the oldest in-flight message before
        // queueing more, keeping the window bounded.
        if (inflight.length >= MAX_INFLIGHT) {
          await inflight.shift();
          // Yield to the event loop so other extensions, UI, and command
          // palette can run between batches.
          await new Promise<void>((r) => setImmediate(r));
        }
      }
      await Promise.all(inflight);

      this.logPerf(
        `[remote-ssh-chunked] sent ${chunkIndex}/${totalChunks} chunks for ${path.basename(fsPath)} in ${+(performance.now() - tStart).toFixed(0)}ms`,
      );
    } finally {
      stream.destroy();
    }
  }

  private sendEarlyPreviewFromBuffer(
    webview: vscode.Webview,
    header: NiiHeader,
    buf: Buffer,
    signal: AbortSignal,
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

      let min = Infinity,
        max = -Infinity;
      for (let i = 0; i < nx * ny; i++) {
        const off = i * bpv;
        let val: number;
        switch (datatype) {
          case 2:
            val = sliceBytes[off];
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
            val = (sliceBytes[off] << 24) >> 24;
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
          globalMin: min,
          globalMax: max,
          slope,
          inter,
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
    signal: AbortSignal,
  ): void {
    const { nx, ny, voxOffset, bytesPerVoxel, datatype, scl_slope, scl_inter, littleEndian } = header;
    const sliceBytes = rawData.subarray(voxOffset, voxOffset + nx * ny * bytesPerVoxel);
    const bpv = Math.max(1, bytesPerVoxel);
    const le = littleEndian;
    const slope = scl_slope || 1;
    const inter = scl_inter || 0;
    const axialSlice = new Float32Array(nx * ny);
    const view = new DataView(sliceBytes.buffer, sliceBytes.byteOffset, sliceBytes.byteLength);

    let min = Infinity,
      max = -Infinity;
    for (let i = 0; i < nx * ny; i++) {
      const off = i * bpv;
      let val: number;
      switch (datatype) {
        case 2:
          val = sliceBytes[off];
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
          val = (sliceBytes[off] << 24) >> 24;
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
        globalMin: min,
        globalMax: max,
        slope,
        inter,
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
    signal: AbortSignal,
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
                globalMin: preview.globalMin,
                globalMax: preview.globalMax,
                slope: preview.slope,
                inter: preview.inter,
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
              globalMin: 0,
              globalMax: 1,
              slope: 1,
              inter: 0,
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
              globalMin,
              globalMax,
              slope,
              inter,
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
            min,
            max,
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

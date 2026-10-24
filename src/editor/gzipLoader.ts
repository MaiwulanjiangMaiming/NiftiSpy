import * as fs from 'fs';
import * as zlib from 'zlib';
import * as vscode from 'vscode';
import { getNativeBindings } from '../nativeBridge';
import type { NiiHeader } from '../nifti/headerParser';
import { computeVoxelStats } from './stats';
import type { GzipLoadResult, Timing } from './types';

/** Host services the gzip transports need; keeps this module free of provider state. */
export interface GzipLoaderHost {
  parseHeader(buf: Uint8Array, separateImg?: boolean): NiiHeader | null;
  sendEarlyPreviewFromBuffer(webview: vscode.Webview, header: NiiHeader, rawData: Buffer, signal: AbortSignal): void;
}

/** One responsibility: whole-file gzip decompression strategies. */
export class GzipVolumeLoader {
  constructor(private readonly host: GzipLoaderHost) {}

  /**
   * Single-pass streaming gzip load: decompresses the file once,
   * sends z=0 preview as soon as available, and returns the full
   * decompressed data. Eliminates the previous double-read bug.
   * Also computes min/max during decompression (full scan, free).
   */
  async streamingLocalGzLoad(
    webview: vscode.Webview,
    fsPath: string,
    signal: AbortSignal,
  ): Promise<GzipLoadResult | null> {
    const timing: Timing = {};
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
          if (isize > 0 && isize < 0xffffffff && isize > stat.size) {
            outputBuf = Buffer.allocUnsafe(isize);
            preallocSize = isize;
          }
        }
        fs.closeSync(fd);
      } catch {
        /* fall back to chunks[] path */
      }

      const chunks: Buffer[] = [];
      let totalSize = 0;
      let resolved = false;
      let header: NiiHeader | null = null;
      let previewSent = false;
      let firstSliceNeeded = Infinity;
      let tFsStart = 0,
        tFirstData = 0,
        tHeaderParsed = 0,
        tPreviewSent = 0,
        tDecompressEnd = 0;

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
        if (signal.aborted) {
          gunzip.destroy();
          return;
        }
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
          const buf = outputBuf ? outputBuf.subarray(0, outputOffset) : Buffer.concat(chunks);
          header = this.host.parseHeader(new Uint8Array(buf.buffer, buf.byteOffset, buf.length));
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
          const previewBuf = outputBuf ? outputBuf.subarray(0, outputOffset) : Buffer.concat(chunks);
          this.host.sendEarlyPreviewFromBuffer(webview, header, previewBuf, signal);
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
          header = this.host.parseHeader(rawData);
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
        if (!resolved) {
          resolved = true;
          reject(err);
        }
      });

      fileStream.on('error', (err) => {
        if (signal) signal.removeEventListener('abort', onAbort);
        if (!resolved) {
          resolved = true;
          reject(err);
        }
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
  async parallelLocalGzLoad(
    webview: vscode.Webview,
    fsPath: string,
    signal: AbortSignal,
  ): Promise<GzipLoadResult | null> {
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
    const header = this.host.parseHeader(rawData);
    const tHeaderEnd = performance.now();
    if (!header) {
      throw new Error('Failed to parse NIfTI header after parallel decompression');
    }

    // ── 3. Send early preview (z=0 axial slice) ──
    const decompressedBuf = Buffer.isBuffer(decompressed)
      ? decompressed
      : Buffer.from(decompressed.buffer, decompressed.byteOffset, decompressed.byteLength);
    this.host.sendEarlyPreviewFromBuffer(webview, header, decompressedBuf, signal);
    const tPreviewSent = performance.now();

    // ── 4. Compute min/max stats ──
    const tStatsStart = performance.now();
    const stats = computeVoxelStats(rawData, header, fsPath);
    const tStatsEnd = performance.now();

    // ── 5. Report timings ──
    // All Rust-side work (mmap + scan + parallel decode) is one combined number.
    timing.fsToFirstData = +(tDecompressEnd - tStart).toFixed(1);
    timing.headerParse = +(tHeaderEnd - tHeaderStart).toFixed(1);
    timing.previewReady = +(tPreviewSent - tHeaderEnd).toFixed(1);
    timing.totalDecompress = +(tDecompressEnd - tStart).toFixed(1);
    timing.nativeDecompress = timing.totalDecompress; // combined (Rust did everything)
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
  async oneshotLocalGzLoad(
    webview: vscode.Webview,
    fsPath: string,
    signal: AbortSignal,
  ): Promise<GzipLoadResult | null> {
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
      tFsEnd = performance.now(); // approx (mmap+decompress combined)
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
    const header = this.host.parseHeader(rawData);
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
    this.host.sendEarlyPreviewFromBuffer(webview, header, decompressedBuf, signal);
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
      timing.fsToFirstData = +(tFsEnd - tStart).toFixed(1);
      timing.headerParse = +(tHeaderEnd - tHeaderStart).toFixed(1);
      timing.previewReady = +(tPreviewSent - tHeaderEnd).toFixed(1);
      // totalDecompress = entire Rust worker time (mmap + inflate + buffer transfer)
      timing.totalDecompress = +(tDecompressEnd - tStart).toFixed(1);
      // nativeDecompress reported as same (Rust didn't break it down).
      // Display layer will show "[libdeflate] native decompress" = total.
      timing.nativeDecompress = timing.totalDecompress;
      timing.statsCompute = +(tStatsEnd - tStatsStart).toFixed(1);
      timing.decompressedBytes = rawData.byteLength;
      timing.nativeBackend = 'libdeflate';
      timing.asyncPath = true;
    } else {
      timing.fsToFirstData = +(tFsEnd - tStart).toFixed(1);
      timing.headerParse = +(tHeaderEnd - tHeaderStart).toFixed(1);
      timing.previewReady = +(tPreviewSent - tHeaderEnd).toFixed(1);
      timing.totalDecompress = +(tDecompressEnd - tStart).toFixed(1);
      timing.nativeDecompress = +(tDecompressEnd - tFsEnd).toFixed(1);
      timing.statsCompute = +(tStatsEnd - tStatsStart).toFixed(1);
      timing.decompressedBytes = rawData.byteLength;
      timing.nativeBackend = 'libdeflate';
      timing.asyncPath = false;
    }

    return { rawData, header, stats, timing };
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
  async jsOneshotLocalGzLoad(
    webview: vscode.Webview,
    fsPath: string,
    signal: AbortSignal,
  ): Promise<GzipLoadResult | null> {
    const tStart = performance.now();
    // 1. Single readFile — no stream, no pipe, no event-loop scheduling.
    const compressed = await fs.promises.readFile(fsPath);
    if (signal.aborted) return null;
    const tFsEnd = performance.now();

    // 2. Synchronous gunzip — single V8→zlib call, no 'data' events.
    const decompressed = zlib.gunzipSync(compressed);
    const tDecompressEnd = performance.now();

    const rawData: Uint8Array = new Uint8Array(decompressed.buffer, decompressed.byteOffset, decompressed.byteLength);

    // 3. Parse NIfTI header.
    const tHeaderStart = performance.now();
    const header = this.host.parseHeader(rawData);
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
      rawData,
      header,
      stats,
      timing: {
        fsToFirstData: +(tFsEnd - tStart).toFixed(1),
        headerParse: +(tHeaderEnd - tHeaderStart).toFixed(1),
        previewReady: 0,
        totalDecompress: +(tDecompressEnd - tStart).toFixed(1),
        nativeDecompress: +(tDecompressEnd - tFsEnd).toFixed(1),
        statsCompute: +(tStatsEnd - tStatsStart).toFixed(1),
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
}

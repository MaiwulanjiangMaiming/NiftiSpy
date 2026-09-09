import * as fs from 'fs';
import {
  ZStream,
  zlibInflateInit2,
  zlibInflate,
  zlibInflateEnd,
  zlibInflateSetDictionary,
  Z_BLOCK,
  Z_OK,
  Z_STREAM_END,
  Z_BUF_ERROR,
  Z_SYNC_FLUSH,
} from 'pako';

export interface GzipIndexEntry {
  /** Byte offset from the start of the deflate stream (after the gzip header). */
  compressedOffset: number;
  /** Unused bits in the previous compressed byte (0–7). */
  bits: number;
  decompressedOffset: number;
  /** 32KB inflate window at this point, or null at the start of the stream. */
  window: Uint8Array | null;
}

const SPACING = 1 << 20;
const WINDOW_SIZE = 32768;
const IN_CHUNK = 256 * 1024;
const OUT_CHUNK = 64 * 1024;
const INDEX_MAGIC = Buffer.from('NSPI');
const INDEX_VERSION = 2;

export function gzipHeaderLength(buf: Uint8Array): number {
  if (buf.length < 10 || buf[0] !== 0x1f || buf[1] !== 0x8b) {
    throw new Error('Not a gzip file');
  }
  const flg = buf[3];
  let off = 10;
  if (flg & 4) {
    if (off + 2 > buf.length) throw new Error('Truncated gzip extra field');
    const xlen = buf[off] | (buf[off + 1] << 8);
    off += 2 + xlen;
  }
  if (flg & 8) {
    while (off < buf.length && buf[off] !== 0) off++;
    off++;
  }
  if (flg & 16) {
    while (off < buf.length && buf[off] !== 0) off++;
    off++;
  }
  if (flg & 2) off += 2;
  if (off > buf.length) throw new Error('Truncated gzip header');
  return off;
}

function updateWindow(window: Buffer, filled: number, chunk: Uint8Array): number {
  if (chunk.length >= WINDOW_SIZE) {
    Buffer.from(chunk.subarray(chunk.length - WINDOW_SIZE)).copy(window);
    return WINDOW_SIZE;
  }
  if (filled + chunk.length <= WINDOW_SIZE) {
    Buffer.from(chunk).copy(window, filled);
    return filled + chunk.length;
  }
  const keep = WINDOW_SIZE - chunk.length;
  window.copyWithin(0, filled - keep, filled);
  Buffer.from(chunk).copy(window, keep);
  return WINDOW_SIZE;
}

function snapshotWindow(window: Buffer, filled: number): Uint8Array {
  const out = Buffer.alloc(WINDOW_SIZE);
  if (filled === WINDOW_SIZE) {
    window.copy(out);
  } else if (filled > 0) {
    window.copy(out, WINDOW_SIZE - filled, 0, filled);
  }
  return new Uint8Array(out.buffer, out.byteOffset, out.byteLength);
}

function primeInflate(strm: InstanceType<typeof ZStream>, bits: number, prevByte: number): void {
  if (!bits) return;
  strm.state.hold = prevByte >> (8 - bits);
  strm.state.bits = bits;
}

export class GzipIndex {
  gzipHeaderLength = 10;
  entries: GzipIndexEntry[] = [];

  static async buildIndex(
    fsPath: string,
    signal?: AbortSignal,
    onProgress?: (pct: number) => void,
    onOutput?: (chunk: Uint8Array, decompressedOffset: number) => void | Promise<void>,
  ): Promise<GzipIndex> {
    const stat = await fs.promises.stat(fsPath);
    const fd = await fs.promises.open(fsPath, 'r');
    try {
      const head = Buffer.alloc(Math.min(1024, stat.size));
      const { bytesRead: headRead } = await fd.read(head, 0, head.length, 0);
      const headerLen = gzipHeaderLength(head.subarray(0, headRead));
      return await inflateAndIndex(fd, stat.size, headerLen, signal, onProgress, onOutput);
    } finally {
      await fd.close();
    }
  }

  /**
   * Inflate decompressed bytes in `[start, end)` and visit each chunk at its
   * absolute decompressed offset. Used for coronal/sagittal slices so one
   * inflate walk can pick rows instead of restarting per z.
   */
  static async scanRange(
    fsPath: string,
    index: GzipIndex,
    start: number,
    end: number,
    onChunk: (absOffset: number, bytes: Uint8Array) => void | Promise<void>,
    signal?: AbortSignal,
  ): Promise<void> {
    if (start >= end) return;
    const entries = index.entries;
    if (entries.length === 0) {
      throw new Error('Empty gzip index');
    }

    let best = entries[0];
    for (let i = 1; i < entries.length; i++) {
      if (entries[i].decompressedOffset <= start) best = entries[i];
      else break;
    }

    const fd = await fs.promises.open(fsPath, 'r');
    const strm = new ZStream();
    const init = zlibInflateInit2(strm, -15);
    if (init !== Z_OK) {
      await fd.close();
      throw new Error('Failed to start raw inflate');
    }

    try {
      if (best.window && best.window.length > 0) {
        const dictRet = zlibInflateSetDictionary(strm, best.window);
        if (dictRet !== Z_OK) throw new Error('Failed to restore inflate window');
      }

      let filePos = index.gzipHeaderLength + best.compressedOffset;
      if (best.bits) {
        const prev = Buffer.alloc(1);
        const { bytesRead } = await fd.read(prev, 0, 1, filePos - 1);
        if (bytesRead !== 1) throw new Error('Failed to read gzip leftover byte');
        primeInflate(strm, best.bits, prev[0]);
      }

      const needed = end - start;
      let skip = start - best.decompressedOffset;
      let written = 0;
      let loops = 0;
      const inBuf = Buffer.alloc(IN_CHUNK);
      const outBuf = new Uint8Array(OUT_CHUNK);
      strm.output = outBuf;
      const stat = await fd.stat();

      while (written < needed) {
        if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
        if (strm.avail_in === 0) {
          const { bytesRead } = await fd.read(inBuf, 0, inBuf.length, filePos);
          filePos += bytesRead;
          if (bytesRead === 0) break;
          strm.input = inBuf.subarray(0, bytesRead);
          strm.next_in = 0;
          strm.avail_in = bytesRead;
        }

        strm.next_out = 0;
        strm.avail_out = outBuf.length;
        const ret = zlibInflate(strm, Z_SYNC_FLUSH);
        const got = outBuf.length - strm.avail_out;
        if (got > 0) {
          let from = 0;
          let n = got;
          if (skip > 0) {
            if (skip >= n) {
              skip -= n;
              n = 0;
            } else {
              from = skip;
              n -= skip;
              skip = 0;
            }
          }
          if (n > 0) {
            const take = Math.min(n, needed - written);
            const abs = start + written;
            await onChunk(abs, Buffer.from(outBuf.subarray(from, from + take)));
            written += take;
          }
        }

        if (ret === Z_STREAM_END) break;
        if (ret !== Z_OK && ret !== Z_BUF_ERROR) {
          throw new Error(strm.msg || `gzip inflate failed (${ret})`);
        }
        if (got === 0 && strm.avail_in === 0 && filePos >= stat.size) break;

        loops++;
        if ((loops & 15) === 0) {
          await new Promise<void>(resolve => setImmediate(resolve));
        }
      }
    } finally {
      zlibInflateEnd(strm);
      await fd.close();
    }
  }

  static async readRange(
    fsPath: string,
    index: GzipIndex,
    start: number,
    end: number,
    signal?: AbortSignal,
  ): Promise<Uint8Array> {
    if (start >= end) return new Uint8Array(0);
    const result = Buffer.alloc(end - start);
    let written = 0;
    await GzipIndex.scanRange(fsPath, index, start, end, (abs, chunk) => {
      Buffer.from(chunk).copy(result, abs - start);
      written = Math.max(written, abs - start + chunk.length);
    }, signal);
    return new Uint8Array(result.buffer, result.byteOffset, written);
  }

  serializeIndex(): Buffer {
    let total = 4 + 4; // headerLen + entry count
    for (const entry of this.entries) {
      total += 8 + 1 + 8 + 1;
      if (entry.window) total += 4 + entry.window.length;
    }
    const buf = Buffer.alloc(total);
    let off = 0;
    buf.writeUInt32LE(this.gzipHeaderLength, off); off += 4;
    buf.writeUInt32LE(this.entries.length, off); off += 4;
    for (const entry of this.entries) {
      buf.writeBigUInt64LE(BigInt(entry.compressedOffset), off); off += 8;
      buf.writeUInt8(entry.bits & 7, off); off += 1;
      buf.writeBigUInt64LE(BigInt(entry.decompressedOffset), off); off += 8;
      if (entry.window) {
        buf.writeUInt8(1, off); off += 1;
        buf.writeUInt32LE(entry.window.length, off); off += 4;
        Buffer.from(entry.window.buffer, entry.window.byteOffset, entry.window.byteLength).copy(buf, off);
        off += entry.window.length;
      } else {
        buf.writeUInt8(0, off); off += 1;
      }
    }
    return buf.subarray(0, off);
  }

  static deserializeIndex(data: Buffer): GzipIndex {
    if (data.length < 8) throw new Error('Truncated gzip index');
    let off = 0;
    const index = new GzipIndex();
    index.gzipHeaderLength = data.readUInt32LE(off); off += 4;
    const count = data.readUInt32LE(off); off += 4;
    for (let i = 0; i < count; i++) {
      const compressedOffset = Number(data.readBigUInt64LE(off)); off += 8;
      const bits = data.readUInt8(off); off += 1;
      const decompressedOffset = Number(data.readBigUInt64LE(off)); off += 8;
      const hasWindow = data.readUInt8(off); off += 1;
      let window: Uint8Array | null = null;
      if (hasWindow) {
        const windowLength = data.readUInt32LE(off); off += 4;
        window = Uint8Array.from(data.subarray(off, off + windowLength));
        off += windowLength;
      }
      index.entries.push({ compressedOffset, bits, decompressedOffset, window });
    }
    return index;
  }
}

async function inflateAndIndex(
  fd: fs.promises.FileHandle,
  fileSize: number,
  headerLen: number,
  signal: AbortSignal | undefined,
  onProgress: ((pct: number) => void) | undefined,
  onOutput: ((chunk: Uint8Array, decompressedOffset: number) => void | Promise<void>) | undefined,
): Promise<GzipIndex> {
  const index = new GzipIndex();
  index.gzipHeaderLength = headerLen;
  index.entries.push({
    compressedOffset: 0,
    bits: 0,
    decompressedOffset: 0,
    window: null,
  });

  const strm = new ZStream();
  const init = zlibInflateInit2(strm, -15);
  if (init !== Z_OK) throw new Error('Failed to start raw inflate');

  const window = Buffer.alloc(WINDOW_SIZE);
  let winFill = 0;
  let produced = 0;
  let lastSync = 0;
  let loops = 0;
  const inBuf = Buffer.alloc(IN_CHUNK);
  const outBuf = new Uint8Array(OUT_CHUNK);
  strm.output = outBuf;
  let filePos = headerLen;

  try {
    while (filePos < fileSize || strm.avail_in > 0) {
      if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');

      if (strm.avail_in === 0) {
        const { bytesRead } = await fd.read(inBuf, 0, inBuf.length, filePos);
        filePos += bytesRead;
        if (bytesRead === 0) break;
        strm.input = inBuf.subarray(0, bytesRead);
        strm.next_in = 0;
        strm.avail_in = bytesRead;
        if (onProgress && fileSize > 0) {
          onProgress(Math.min(99, Math.round((filePos / fileSize) * 100)));
        }
      }

      strm.next_out = 0;
      strm.avail_out = outBuf.length;
      const ret = zlibInflate(strm, Z_BLOCK);
      const got = outBuf.length - strm.avail_out;
      if (got > 0) {
        const chunk = outBuf.subarray(0, got);
        winFill = updateWindow(window, winFill, chunk);
        if (onOutput) await onOutput(Buffer.from(chunk), produced);
        produced += got;
      }

      const dataType = strm.data_type;
      const atBlockEnd = (dataType & 128) !== 0 && (dataType & 64) === 0;
      if (atBlockEnd && produced - lastSync >= SPACING) {
        index.entries.push({
          compressedOffset: strm.total_in,
          bits: dataType & 7,
          decompressedOffset: produced,
          window: snapshotWindow(window, winFill),
        });
        lastSync = produced;
      }

      if (ret === Z_STREAM_END) break;
      if (ret !== Z_OK && ret !== Z_BUF_ERROR) {
        throw new Error(strm.msg || `gzip inflate failed (${ret})`);
      }

      loops++;
      if ((loops & 15) === 0) {
        await new Promise<void>(resolve => setImmediate(resolve));
      }
    }
  } finally {
    zlibInflateEnd(strm);
  }

  if (onProgress) onProgress(100);
  return index;
}

export interface IndexCacheMeta {
  fileSize: number;
  mtimeMs: number;
}

export function getIndexCachePath(fsPath: string): string {
  return fsPath + '.niftispy-index';
}

export async function loadCachedIndex(fsPath: string): Promise<GzipIndex | null> {
  const cachePath = getIndexCachePath(fsPath);
  try {
    const [fileStat, cacheStat] = await Promise.all([
      fs.promises.stat(fsPath),
      fs.promises.stat(cachePath),
    ]);
    if (cacheStat.mtimeMs < fileStat.mtimeMs) return null;
    const data = await fs.promises.readFile(cachePath);
    if (data.length < 20) return null;
    if (data.compare(INDEX_MAGIC, 0, 4, 0, 4) !== 0) return null;

    let off = 0;
    off += 4; // magic, already checked
    const version = data.readUInt16LE(off); off += 2;
    if (version !== INDEX_VERSION) return null;
    const cachedFileSize = Number(data.readBigUInt64LE(off)); off += 8;
    const cachedMtimeMs = data.readDoubleLE(off); off += 8;
    if (cachedFileSize !== fileStat.size || Math.abs(cachedMtimeMs - fileStat.mtimeMs) > 1) {
      return null;
    }
    return GzipIndex.deserializeIndex(data.subarray(off));
  } catch {
    return null;
  }
}

export async function saveCachedIndex(fsPath: string, index: GzipIndex): Promise<void> {
  const cachePath = getIndexCachePath(fsPath);
  try {
    const stat = await fs.promises.stat(fsPath);
    const indexData = index.serializeIndex();
    const buf = Buffer.alloc(4 + 2 + 8 + 8 + indexData.length);
    let off = 0;
    INDEX_MAGIC.copy(buf, off); off += 4;
    buf.writeUInt16LE(INDEX_VERSION, off); off += 2;
    buf.writeBigUInt64LE(BigInt(stat.size), off); off += 8;
    buf.writeDoubleLE(stat.mtimeMs, off); off += 8;
    indexData.copy(buf, off);
    await fs.promises.writeFile(cachePath, buf);
  } catch {
    // Sidecar write is best-effort; a missing cache just rebuilds next time.
  }
}

export function buildGzipIndex(fsPath: string, signal?: AbortSignal): Promise<GzipIndexEntry[]> {
  return GzipIndex.buildIndex(fsPath, signal).then(idx => idx.entries);
}

export function extractRangeFromGzipIndex(
  fsPath: string,
  index: GzipIndexEntry[],
  decompStart: number,
  decompEnd: number,
  signal?: AbortSignal,
): Promise<Uint8Array> {
  const gi = new GzipIndex();
  gi.entries = index;
  return GzipIndex.readRange(fsPath, gi, decompStart, decompEnd, signal);
}

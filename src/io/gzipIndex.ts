import * as fs from 'fs';
import * as zlib from 'zlib';

export interface GzipIndexEntry {
  compressedOffset: number;
  decompressedOffset: number;
  windowBits: Uint8Array | null;
}

const SPACING = 1 << 20; // ~1MB between index points
const WINDOW_SIZE = 32768; // 32KB sliding window

// Serialization format:
// [4 bytes] entry count
// For each entry:
//   [4 bytes] compressedOffset
//   [4 bytes] decompressedOffset
//   [1 byte]  hasWindow (0 or 1)
//   [4 bytes] windowLength (if hasWindow)
//   [windowLength bytes] window data

export class GzipIndex {
  entries: GzipIndexEntry[] = [];

  static async buildIndex(fsPath: string, signal?: AbortSignal, onProgress?: (pct: number) => void): Promise<GzipIndex> {
    const index = new GzipIndex();
    const stat = await fs.promises.stat(fsPath);
    const fileSize = stat.size;

    return new Promise<GzipIndex>((resolve, reject) => {
      const entries: GzipIndexEntry[] = [];
      let compOffset = 0;
      let decompOffset = 0;
      let windowBuf: Buffer | null = null;
      let windowFilled = 0;
      let lastSyncDecompOffset = 0;
      let resolved = false;

      const inflator = zlib.createInflateRaw();

      const input = fs.createReadStream(fsPath);
      input.on('data', (chunk: string | Buffer) => {
        if (resolved) return;
        if (typeof chunk === 'string') return;
        if (signal?.aborted) {
          resolved = true;
          input.destroy();
          inflator.destroy();
          reject(new DOMException('Aborted', 'AbortError'));
          return;
        }
        compOffset += chunk.length;
        if (onProgress && fileSize > 0) {
          onProgress(Math.min(99, Math.round((compOffset / fileSize) * 100)));
        }
      });

      inflator.on('data', (chunk: Buffer) => {
        if (resolved) return;

        if (windowBuf === null) {
          windowBuf = Buffer.alloc(WINDOW_SIZE);
          windowFilled = 0;
        }

        const spaceLeft = WINDOW_SIZE - windowFilled;
        if (chunk.length <= spaceLeft) {
          chunk.copy(windowBuf, windowFilled);
          windowFilled += chunk.length;
        } else {
          const overflow = chunk.length - spaceLeft;
          chunk.copy(windowBuf, windowFilled, 0, spaceLeft);
          chunk.copy(windowBuf, 0, spaceLeft);
          windowFilled = Math.min(WINDOW_SIZE, overflow);
          if (overflow < WINDOW_SIZE) {
            windowBuf.copyWithin(0, WINDOW_SIZE - overflow, WINDOW_SIZE);
            windowFilled = overflow;
          } else {
            const tailStart = chunk.length - WINDOW_SIZE;
            chunk.copy(windowBuf, 0, tailStart);
            windowFilled = WINDOW_SIZE;
          }
        }

        decompOffset += chunk.length;

        if (decompOffset - lastSyncDecompOffset >= SPACING) {
          const entry: GzipIndexEntry = {
            compressedOffset: compOffset,
            decompressedOffset: decompOffset,
            windowBits: null,
          };

          if (windowFilled > 0) {
            const w = Buffer.alloc(WINDOW_SIZE);
            if (windowFilled === WINDOW_SIZE) {
              windowBuf.copy(w);
            } else {
              w.fill(0, 0, WINDOW_SIZE - windowFilled);
              windowBuf.copy(w, WINDOW_SIZE - windowFilled, 0, windowFilled);
            }
            entry.windowBits = new Uint8Array(w.buffer, w.byteOffset, w.byteLength);
          }

          entries.push(entry);
          lastSyncDecompOffset = decompOffset;
        }
      });

      inflator.on('end', () => {
        if (!resolved) {
          resolved = true;
          if (entries.length === 0 || entries[0].decompressedOffset !== 0) {
            entries.unshift({
              compressedOffset: 0,
              decompressedOffset: 0,
              windowBits: null,
            });
          }
          index.entries = entries;
          if (onProgress) onProgress(100);
          resolve(index);
        }
      });

      inflator.on('error', (err: Error) => {
        if (!resolved) {
          resolved = true;
          reject(err);
        }
      });

      input.on('error', (err: Error) => {
        if (!resolved) {
          resolved = true;
          inflator.destroy();
          reject(err);
        }
      });

      input.pipe(inflator);
    });
  }

  static async readRange(
    fsPath: string,
    index: GzipIndex,
    start: number,
    end: number,
    signal?: AbortSignal
  ): Promise<Uint8Array> {
    if (start >= end) {
      return new Uint8Array(0);
    }

    const entries = index.entries;

    let bestIdx = 0;
    for (let i = 0; i < entries.length; i++) {
      if (entries[i].decompressedOffset <= start) {
        bestIdx = i;
      } else {
        break;
      }
    }

    const entry = entries[bestIdx];
    const compStart = entry.compressedOffset;
    const resultSize = end - start;
    const result = Buffer.alloc(resultSize);
    let resultOffset = 0;
    let decompPos = entry.decompressedOffset;
    let resolved = false;

    return new Promise<Uint8Array>((resolve, reject) => {
      const inflator = zlib.createInflateRaw();

      if (entry.windowBits && entry.windowBits.length > 0) {
        try {
          (inflator as any)._window = Buffer.from(entry.windowBits);
        } catch { /* best-effort window restore */ }
      }

      const input = fs.createReadStream(fsPath, { start: compStart });
      input.on('data', (chunk: string | Buffer) => {
        if (resolved) return;
        if (typeof chunk === 'string') return;
        if (signal?.aborted) {
          resolved = true;
          input.destroy();
          inflator.destroy();
          reject(new DOMException('Aborted', 'AbortError'));
          return;
        }
      });

      inflator.on('data', (chunk: Buffer) => {
        if (resolved) return;

        const chunkStart = decompPos;
        const chunkEnd = decompPos + chunk.length;

        if (chunkEnd <= start) {
          decompPos = chunkEnd;
          return;
        }

        if (chunkStart >= end) {
          resolved = true;
          input.destroy();
          inflator.destroy();
          resolve(new Uint8Array(result.buffer, result.byteOffset, resultOffset));
          return;
        }

        const copyStart = Math.max(chunkStart, start) - chunkStart;
        const copyEnd = Math.min(chunkEnd, end) - chunkStart;
        const copyLen = copyEnd - copyStart;

        if (copyLen > 0 && resultOffset + copyLen <= resultSize) {
          chunk.copy(result, resultOffset, copyStart, copyEnd);
          resultOffset += copyLen;
        }

        decompPos = chunkEnd;

        if (decompPos >= end) {
          resolved = true;
          input.destroy();
          inflator.destroy();
          resolve(new Uint8Array(result.buffer, result.byteOffset, resultOffset));
        }
      });

      inflator.on('end', () => {
        if (!resolved) {
          resolved = true;
          resolve(new Uint8Array(result.buffer, result.byteOffset, resultOffset));
        }
      });

      inflator.on('error', (err: Error) => {
        if (!resolved) {
          resolved = true;
          reject(err);
        }
      });

      input.on('error', (err: Error) => {
        if (!resolved) {
          resolved = true;
          inflator.destroy();
          reject(err);
        }
      });

      input.pipe(inflator);
    });
  }

  serializeIndex(): Buffer {
    const entryCount = this.entries.length;
    // Calculate total size
    let totalSize = 4; // entry count
    for (const entry of this.entries) {
      totalSize += 4 + 4 + 1; // compressedOffset + decompressedOffset + hasWindow
      if (entry.windowBits) {
        totalSize += 4 + entry.windowBits.length; // windowLength + window data
      }
    }

    const buf = Buffer.alloc(totalSize);
    let offset = 0;

    buf.writeUInt32LE(entryCount, offset); offset += 4;

    for (const entry of this.entries) {
      buf.writeUInt32LE(entry.compressedOffset, offset); offset += 4;
      buf.writeUInt32LE(entry.decompressedOffset, offset); offset += 4;
      const hasWindow = entry.windowBits !== null ? 1 : 0;
      buf.writeUInt8(hasWindow, offset); offset += 1;
      if (entry.windowBits) {
        buf.writeUInt32LE(entry.windowBits.length, offset); offset += 4;
        Buffer.from(entry.windowBits.buffer, entry.windowBits.byteOffset, entry.windowBits.byteLength).copy(buf, offset);
        offset += entry.windowBits.length;
      }
    }

    return buf;
  }

  static deserializeIndex(data: Buffer): GzipIndex {
    const index = new GzipIndex();
    let offset = 0;

    const entryCount = data.readUInt32LE(offset); offset += 4;
    index.entries = [];

    for (let i = 0; i < entryCount; i++) {
      const compressedOffset = data.readUInt32LE(offset); offset += 4;
      const decompressedOffset = data.readUInt32LE(offset); offset += 4;
      const hasWindow = data.readUInt8(offset); offset += 1;

      let windowBits: Uint8Array | null = null;
      if (hasWindow) {
        const windowLength = data.readUInt32LE(offset); offset += 4;
        windowBits = new Uint8Array(windowLength);
        data.copy(Buffer.from(windowBits.buffer, windowBits.byteOffset, windowBits.byteLength), 0, offset, offset + windowLength);
        offset += windowLength;
      }

      index.entries.push({ compressedOffset, decompressedOffset, windowBits });
    }

    return index;
  }
}

// --- Index Persistence ---

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
    // Cache must be newer than the file
    if (cacheStat.mtimeMs < fileStat.mtimeMs) {
      return null;
    }
    const data = await fs.promises.readFile(cachePath);
    if (data.length < 4) return null;

    // Read and validate metadata header
    const metaSize = 4 + 8; // fileSize (uint32) + mtimeMs (double)
    if (data.length < metaSize + 4) return null;

    let off = 0;
    const cachedFileSize = data.readUInt32LE(off); off += 4;
    const cachedMtimeMs = data.readDoubleLE(off); off += 8;

    // Validate file hasn't changed
    if (cachedFileSize !== fileStat.size || Math.abs(cachedMtimeMs - fileStat.mtimeMs) > 1) {
      return null;
    }

    // Rest is the serialized index
    const indexData = data.slice(off);
    return GzipIndex.deserializeIndex(indexData);
  } catch {
    return null;
  }
}

export async function saveCachedIndex(fsPath: string, index: GzipIndex): Promise<void> {
  const cachePath = getIndexCachePath(fsPath);
  try {
    const stat = await fs.promises.stat(fsPath);
    const indexData = index.serializeIndex();

    // Prepend metadata: fileSize (uint32) + mtimeMs (float64)
    const metaSize = 4 + 8;
    const buf = Buffer.alloc(metaSize + indexData.length);
    let off = 0;
    buf.writeUInt32LE(stat.size, off); off += 4;
    buf.writeDoubleLE(stat.mtimeMs, off); off += 8;
    indexData.copy(buf, off);

    await fs.promises.writeFile(cachePath, buf);
  } catch {
    // Silently fail - caching is best-effort
  }
}

// --- Legacy standalone functions for backward compatibility ---

export function buildGzipIndex(fsPath: string, signal?: AbortSignal): Promise<GzipIndexEntry[]> {
  return GzipIndex.buildIndex(fsPath, signal).then(idx => idx.entries);
}

export function extractRangeFromGzipIndex(
  fsPath: string,
  index: GzipIndexEntry[],
  decompStart: number,
  decompEnd: number,
  signal?: AbortSignal
): Promise<Uint8Array> {
  const gi = new GzipIndex();
  gi.entries = index;
  return GzipIndex.readRange(fsPath, gi, decompStart, decompEnd, signal);
}

export function buildGzipIndexFromBuffer(data: Uint8Array, signal?: AbortSignal): Promise<GzipIndexEntry[]> {
  return new Promise((resolve, reject) => {
    const entries: GzipIndexEntry[] = [];
    let decompOffset = 0;
    let lastSyncDecompOffset = 0;
    let resolved = false;

    const inflator = zlib.createInflateRaw();

    if (signal?.aborted) {
      reject(new DOMException('Aborted', 'AbortError'));
      return;
    }

    inflator.on('data', (chunk: Buffer) => {
      if (resolved) return;
      decompOffset += chunk.length;

      if (decompOffset - lastSyncDecompOffset >= SPACING) {
        entries.push({
          compressedOffset: 0,
          decompressedOffset: decompOffset,
          windowBits: null,
        });
        lastSyncDecompOffset = decompOffset;
      }
    });

    inflator.on('end', () => {
      if (!resolved) {
        resolved = true;
        entries.unshift({
          compressedOffset: 0,
          decompressedOffset: 0,
          windowBits: null,
        });
        resolve(entries);
      }
    });

    inflator.on('error', (err: Error) => {
      if (!resolved) {
        resolved = true;
        reject(err);
      }
    });

    inflator.write(Buffer.from(data.buffer, data.byteOffset, data.byteLength));
    inflator.end();
  });
}

import * as fs from 'fs';
import * as zlib from 'zlib';

export interface GzipIndexEntry {
  compressedOffset: number;
  decompressedOffset: number;
  windowBits: Uint8Array | null;
}

const SPACING = 1 << 20;
const WINDOW_SIZE = 32768;

export function buildGzipIndex(fsPath: string, signal?: AbortSignal): Promise<GzipIndexEntry[]> {
  return new Promise((resolve, reject) => {
    const entries: GzipIndexEntry[] = [];
    let compOffset = 0;
    let decompOffset = 0;
    let windowBuf: Buffer | null = null;
    let windowFilled = 0;
    let lastSyncCompOffset = 0;
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
        lastSyncCompOffset = compOffset;
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
        resolve(entries);
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

export function extractRangeFromGzipIndex(
  fsPath: string,
  index: GzipIndexEntry[],
  decompStart: number,
  decompEnd: number,
  signal?: AbortSignal
): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    if (decompStart >= decompEnd) {
      resolve(new Uint8Array(0));
      return;
    }

    let bestIdx = 0;
    for (let i = 0; i < index.length; i++) {
      if (index[i].decompressedOffset <= decompStart) {
        bestIdx = i;
      } else {
        break;
      }
    }

    const entry = index[bestIdx];
    const compStart = entry.compressedOffset;
    const resultSize = decompEnd - decompStart;
    const result = Buffer.alloc(resultSize);
    let resultOffset = 0;
    let decompPos = entry.decompressedOffset;
    let resolved = false;

    const inflator = zlib.createInflateRaw();

    if (entry.windowBits && entry.windowBits.length > 0) {
      try {
        (inflator as any)._window = Buffer.from(entry.windowBits);
      } catch {}
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

      if (chunkEnd <= decompStart) {
        decompPos = chunkEnd;
        return;
      }

      if (chunkStart >= decompEnd) {
        resolved = true;
        input.destroy();
        inflator.destroy();
        resolve(new Uint8Array(result.buffer, result.byteOffset, resultOffset));
        return;
      }

      const copyStart = Math.max(chunkStart, decompStart) - chunkStart;
      const copyEnd = Math.min(chunkEnd, decompEnd) - chunkStart;
      const copyLen = copyEnd - copyStart;

      if (copyLen > 0 && resultOffset + copyLen <= resultSize) {
        chunk.copy(result, resultOffset, copyStart, copyEnd);
        resultOffset += copyLen;
      }

      decompPos = chunkEnd;

      if (decompPos >= decompEnd) {
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

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as zlib from 'zlib';
import { createHash } from 'crypto';
import { pipeline } from 'stream/promises';
import { getNativeBindings } from '../nativeBridge';

export function getUnpackCachePath(gzPath: string): string {
  return gzPath + '.niftispy-unpack.nii';
}

/** gzip ISIZE is uncompressed length modulo 2^32 (last 4 bytes). */
export async function readGzipISize(gzPath: string): Promise<number> {
  const stat = await fs.promises.stat(gzPath);
  if (stat.size < 8) return 0;
  const buf = Buffer.alloc(4);
  const fd = await fs.promises.open(gzPath, 'r');
  try {
    await fd.read(buf, 0, 4, stat.size - 4);
  } finally {
    await fd.close();
  }
  return buf.readUInt32LE(0);
}

function isizeMatches(fileSize: number, isize: number): boolean {
  if (isize <= 0) return fileSize > 348;
  return (fileSize >>> 0) === isize || fileSize === isize;
}

async function hasEnoughSpace(dir: string, bytes: number): Promise<boolean> {
  if (bytes <= 0) return true;
  try {
    const statfs = (fs.promises as any).statfs;
    if (typeof statfs !== 'function') return true;
    const s = await statfs(dir);
    const free = Number(s.bavail ?? s.bfree) * Number(s.bsize);
    return free > bytes + 64 * 1024 * 1024;
  } catch {
    return true;
  }
}

async function unpackToFile(gzPath: string, outPath: string, isize: number): Promise<void> {
  const native = getNativeBindings();
  const nativeMax = 80 * 1024 * 1024;
  if (isize > 0 && isize <= nativeMax && native?.fastDecompressGzipParallelAsync) {
    const buf = await native.fastDecompressGzipParallelAsync(gzPath);
    await fs.promises.writeFile(outPath, buf);
    return;
  }
  if (isize > 0 && isize <= nativeMax && native?.fastDecompressGzipFileAsync) {
    const buf = await native.fastDecompressGzipFileAsync(gzPath);
    await fs.promises.writeFile(outPath, buf);
    return;
  }
  await pipeline(
    fs.createReadStream(gzPath),
    zlib.createGunzip(),
    fs.createWriteStream(outPath),
  );
}

/**
 * When the random-access gzip index cannot be built, decompress once to a
 * seekable `.nii` sidecar (or tmp) so `/slice` can use ordinary Range reads
 * instead of inflating the whole file into RAM on every request.
 */
export async function unpackGzipToCache(gzPath: string): Promise<string | null> {
  let isize = 0;
  try {
    isize = await readGzipISize(gzPath);
  } catch {
    isize = 0;
  }

  const hash = createHash('sha1').update(gzPath).digest('hex').slice(0, 12);
  const candidates = [
    getUnpackCachePath(gzPath),
    path.join(os.tmpdir(), `niftispy-unpack-${hash}.nii`),
  ];

  let gzStat: fs.Stats;
  try {
    gzStat = await fs.promises.stat(gzPath);
  } catch {
    return null;
  }

  for (const out of candidates) {
    try {
      const st = await fs.promises.stat(out);
      if (st.mtimeMs >= gzStat.mtimeMs && isizeMatches(st.size, isize)) return out;
    } catch {
      // missing sidecar
    }
  }

  for (const out of candidates) {
    try {
      if (!(await hasEnoughSpace(path.dirname(out), isize))) continue;
      await unpackToFile(gzPath, out, isize);
      return out;
    } catch {
      await fs.promises.unlink(out).catch(() => {});
    }
  }
  return null;
}

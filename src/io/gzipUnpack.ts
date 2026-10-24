import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as zlib from 'zlib';
import { createHash, randomUUID } from 'crypto';
import { Transform } from 'stream';
import { pipeline } from 'stream/promises';
import { parseNiiHeaderQuick } from '../nifti/headerParser';

export interface GzipCacheOptions {
  directory?: string;
  budgetBytes?: number;
  signal?: AbortSignal;
  onChunk?: (chunk: Buffer, offset: number) => void;
  onProgress?: (pct: number) => void;
}
const DEFAULT_BUDGET = 4 * 1024 ** 3;
interface CacheBuild { promise: Promise<string | null>; controller: AbortController; clients: number; settled: boolean; }
const inflight = new Map<string, CacheBuild>();
// Serialise reservations as well as eviction: concurrent volumes share one budget.
let reservationQueue: Promise<unknown> = Promise.resolve();
const reservations = new Map<string, number>();

/** gzip ISIZE is only a hint: sizes above 4 GiB wrap around. */
export async function readGzipISize(gzPath: string): Promise<number> {
  const fd = await fs.promises.open(gzPath, 'r');
  try {
    const stat = await fd.stat();
    if (stat.size < 8) return 0;
    const buf = Buffer.alloc(4);
    await fd.read(buf, 0, 4, stat.size - 4);
    return buf.readUInt32LE(0);
  } finally { await fd.close(); }
}

export async function gzipCacheIdentity(gzPath: string, directory?: string): Promise<{ key: string; output: string; identity: string }> {
  const real = await fs.promises.realpath(gzPath);
  const st = await fs.promises.stat(real);
  const identity = JSON.stringify([os.hostname(), real, st.dev, st.ino, st.size, st.mtimeMs, st.ctimeMs]);
  const key = createHash('sha256').update(identity).digest('hex');
  return { key, identity, output: path.join(directory || path.join(os.tmpdir(), 'niftispy-cache-v2'), key + '.nii') };
}

async function reserve(output: string, bytes: number, budget: number): Promise<boolean> {
  const operation = reservationQueue.then(async () => {
    if (bytes > budget || budget <= 0) return false;
    const dir = path.dirname(output);
    await fs.promises.mkdir(dir, { recursive: true, mode: 0o700 });
    const names = await fs.promises.readdir(dir);
    const entries = await Promise.all(names.filter(n => /^[a-f0-9]{64}\.nii$/.test(n)).map(async n => {
      const file = path.join(dir, n), st = await fs.promises.stat(file).catch(() => null);
      const extra = await Promise.all(['.json', '.preview'].map(suffix => fs.promises.stat(file + suffix).catch(() => null)));
      return { file, bytes: (st?.size || 0) + extra.reduce((sum, item) => sum + (item?.size || 0), 0), used: st?.mtimeMs || 0 };
    }));
    let used = entries.reduce((n, e) => n + e.bytes, 0) + [...reservations.values()].reduce((a, b) => a + b, 0);
    for (const e of entries.sort((a, b) => a.used - b.used)) {
      if (used + bytes <= budget) break;
      if (reservations.has(e.file) || e.file === output) continue;
      const removed = await fs.promises.unlink(e.file).then(() => true, error => error.code === 'ENOENT');
      if (!removed) continue;
      await fs.promises.unlink(e.file + '.json').catch(() => {});
      await fs.promises.unlink(e.file + '.preview').catch(() => {});
      const remaining = await Promise.all(['.json', '.preview'].map(suffix => fs.promises.stat(e.file + suffix).catch(() => null)));
      used -= e.bytes - remaining.reduce((sum, st) => sum + (st?.size || 0), 0);
    }
    if (used + bytes > budget) return false;
    try {
      const disk = await fs.promises.statfs(dir);
      if (Number(disk.bavail) * Number(disk.bsize) < bytes + 64 * 1024 ** 2) return false;
    } catch { /* statfs is unavailable on some remote file systems. */ }
    reservations.set(output, bytes);
    return true;
  });
  reservationQueue = operation.catch(() => {});
  return operation;
}

/** Native streaming inflate into an atomic, identity-validated, quota-bound seekable cache. */
export async function unpackGzipToCache(gzPath: string, options: GzipCacheOptions = {}): Promise<string | null> {
  if (options.signal?.aborted) throw new DOMException('Aborted', 'AbortError');
  const info = await gzipCacheIdentity(gzPath, options.directory);
  let job = inflight.get(info.output);
  if (job?.controller.signal.aborted) {
    await job.promise.catch(() => {});
    return unpackGzipToCache(gzPath, options);
  }
  if (!job) {
    const controller = new AbortController();
    job = { controller, clients: 0, settled: false, promise: Promise.resolve(null) };
    const current = job;
    current.promise = build(gzPath, info, { ...options, signal: controller.signal }).finally(() => {
      current.settled = true;
      if (inflight.get(info.output) === current) inflight.delete(info.output);
    });
    inflight.set(info.output, current);
  }
  const shared = job;
  shared.clients++;
  return new Promise<string | null>((resolve, reject) => {
    let finished = false;
    const finish = () => {
      if (finished) return false;
      finished = true;
      options.signal?.removeEventListener('abort', abort);
      shared.clients--;
      if (!shared.clients && !shared.settled) shared.controller.abort();
      return true;
    };
    const abort = () => {
      const lastConsumer = shared.clients === 1;
      if (!finish()) return;
      const error = new DOMException('Aborted', 'AbortError');
      // The final consumer observes cancellation only after temporary files are removed.
      if (lastConsumer) shared.promise.then(() => reject(error), () => reject(error));
      else reject(error);
    };
    options.signal?.addEventListener('abort', abort, { once: true });
    if (options.signal?.aborted) abort();
    shared.promise.then(value => { if (finish()) resolve(value); }, error => { if (finish()) reject(error); });
  });
}

async function build(gzPath: string, info: Awaited<ReturnType<typeof gzipCacheIdentity>>, options: GzipCacheOptions): Promise<string | null> {
  const { output, identity } = info;
  const budget = options.budgetBytes ?? DEFAULT_BUDGET;
  if (budget <= 0) return null;
  try {
    const meta = JSON.parse(await fs.promises.readFile(output + '.json', 'utf8'));
    const st = await fs.promises.stat(output);
    if (meta.version === 2 && meta.identity === identity && st.size === meta.bytes && st.size <= budget) {
      let fits = await reserve(output, 0, budget).catch(() => false);
      reservations.delete(output);
      if (!fits) {
        await fs.promises.unlink(output + '.preview').catch(() => {});
        fits = await reserve(output, 0, budget).catch(() => false);
        reservations.delete(output);
      }
      if (fits) {
        await fs.promises.utimes(output, new Date(), new Date()).catch(() => {});
        return output;
      }
    }
  } catch { /* A missing/partial cache entry is rebuilt. */ }
  for (const suffix of ['', '.json', '.preview']) await fs.promises.unlink(output + suffix).catch(() => {});
  const hint = await readGzipISize(gzPath);
  // ISIZE cannot be trusted to size the reservation; the header below validates the true length.
  if (!(await reserve(output, Math.max(544, hint) + 1024, budget).catch(() => false))) return null;
  const tmp = output + '.' + randomUUID() + '.tmp';
  let offset = 0, expected = 0, headerBytes = Buffer.alloc(0);
  try {
    const input = fs.createReadStream(gzPath, { highWaterMark: 1024 * 1024 });
    const tap = new Transform({ transform(chunk: Buffer, _encoding, callback) {
      try {
        if (!expected) {
          headerBytes = Buffer.concat([headerBytes, chunk]);
          const h = parseNiiHeaderQuick(headerBytes);
          if (h) {
            expected = h.voxOffset + h.nx * h.ny * h.nz * Math.max(1, h.nt || 1) * Math.max(1, h.nu || 1) * h.bytesPerVoxel;
            if (!Number.isSafeInteger(expected) || expected < 348 || expected > budget || expected > (reservations.get(output) || 0)) {
              // A wrapping ISIZE must not bypass the reserved disk budget.
              throw new Error('NIfTI volume exceeds disk cache reservation');
            }
            headerBytes = Buffer.alloc(0);
          } else if (headerBytes.length >= 544) throw new Error('Invalid NIfTI header');
        }
        if (offset + chunk.length > budget || offset + chunk.length > (reservations.get(output) || 0)) throw new Error('Disk cache budget exceeded');
        options.onChunk?.(chunk, offset);
        offset += chunk.length;
        options.onProgress?.(expected ? Math.min(99, Math.floor(offset / expected * 100)) : 0);
        callback(null, chunk);
      } catch (error) { callback(error as Error); }
    } });
    await pipeline(input, zlib.createGunzip({ chunkSize: 256 * 1024 }), tap, fs.createWriteStream(tmp, { flags: 'wx', mode: 0o600 }), { signal: options.signal });
    if (!expected || offset < expected || (offset >>> 0) !== hint) throw new Error('Truncated or inconsistent gzip volume');
    if ((await gzipCacheIdentity(gzPath, options.directory)).identity !== identity) throw new Error('Source changed during decompression');
    const metadata = JSON.stringify({ version: 2, identity, bytes: offset });
    await fs.promises.writeFile(tmp + '.json', metadata, { mode: 0o600 });
    if (options.signal?.aborted) throw new DOMException('Aborted', 'AbortError');
    await fs.promises.rename(tmp, output);
    await fs.promises.rename(tmp + '.json', output + '.json');
    options.onProgress?.(100);
    return output;
  } catch (error) {
    if (options.signal?.aborted) throw error;
    return null;
  } finally {
    reservations.delete(output);
    await fs.promises.unlink(tmp).catch(() => {});
    await fs.promises.unlink(tmp + '.json').catch(() => {});
  }
}

/** Persist only when metadata and preview fit alongside completed and in-flight volumes. */
export async function persistGzipPreview(file: string, data: Buffer, budgetBytes = DEFAULT_BUDGET): Promise<void> {
  const operation = reservationQueue.then(async () => {
    if (!(await fs.promises.stat(file).catch(() => null))) return;
    const dir = path.dirname(file);
    const names = await fs.promises.readdir(dir);
    let used = [...reservations.values()].reduce((a, b) => a + b, 0);
    for (const name of names) {
      if (!/^[a-f0-9]{64}\.nii(?:\.json|\.preview)?$/.test(name) || path.join(dir, name) === file + '.preview') continue;
      used += (await fs.promises.stat(path.join(dir, name)).catch(() => null))?.size || 0;
    }
    if (used + data.length > budgetBytes) return;
    const tmp = file + '.' + randomUUID() + '.tmp';
    try { await fs.promises.writeFile(tmp, data, { mode: 0o600 }); await fs.promises.rename(tmp, file + '.preview'); }
    finally { await fs.promises.unlink(tmp).catch(() => {}); }
  });
  reservationQueue = operation.catch(() => {});
  await operation;
}

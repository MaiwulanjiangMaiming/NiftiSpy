import * as fs from 'fs';
import { serialize, deserialize } from 'v8';
import { createHash } from 'crypto';
import { parseNiiHeaderQuick, timepointByteOffset, type NiiHeader } from '../nifti/headerParser';
import { decodeVoxel, extractAxialSliceFromRange, extractLocalSlice } from '../nifti/sliceExtractor';
import { GzipIndex, loadCachedIndex, saveCachedIndex } from './gzipIndex';
import { unpackGzipToCache, persistGzipPreview, GzipCacheOptions } from './gzipUnpack';
import { readLocalFilePartial } from './fileReader';

export const GZIP_LOD_FACTOR = 8;

export interface GzipOrthoPreview {
  header: NiiHeader;
  axial: Float32Array;
  coronal: Float32Array;
  sagittal: Float32Array;
  min: number;
  max: number;
  sliceIdx: { axial: number; coronal: number; sagittal: number };
  slope: number;
  inter: number;
}

export interface GzipLodVolume {
  header: NiiHeader;
  factor: number;
  volume: Float32Array;
  outNx: number;
  outNy: number;
  outNz: number;
  min: number;
  max: number;
}

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (err: Error) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (err: Error) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** One shared scan publishes useful previews and prepares seekable remote reads. */
export class GzipScanSession {
  header: NiiHeader | null = null;
  axial0: Float32Array | null = null;
  coronal: Float32Array | null = null;
  sagittal: Float32Array | null = null;
  lod: GzipLodVolume | null = null;
  index: GzipIndex | null = null;
  unpackPath: string | null = null;
  readonly z0: Promise<GzipOrthoPreview>;
  readonly ortho: Promise<GzipOrthoPreview>;
  readonly done: Promise<GzipIndex | null>;
  private readonly z0Defer = deferred<GzipOrthoPreview>();
  private readonly orthoDefer = deferred<GzipOrthoPreview>();
  private readonly doneDefer = deferred<GzipIndex | null>();
  private z0Settled = false;
  private orthoSettled = false;
  private completed = false;
  private latest: GzipOrthoPreview | null = null;
  private listeners = new Set<(preview: GzipOrthoPreview) => void>();
  private static active = new Map<string, GzipScanSession>();

  constructor() {
    this.z0 = this.z0Defer.promise;
    this.ortho = this.orthoDefer.promise;
    this.done = this.doneDefer.promise;
    this.z0.catch(() => {});
    this.ortho.catch(() => {});
  }

  subscribe(listener: (preview: GzipOrthoPreview) => void): () => void {
    this.listeners.add(listener);
    if (this.latest) listener(this.latest);
    return () => this.listeners.delete(listener);
  }

  static start(
    fsPath: string,
    signal?: AbortSignal,
    onProgress?: (pct: number) => void,
    options: GzipCacheOptions = {},
  ): GzipScanSession {
    // Stat-based identity also prevents sharing a scan after the source changed.
    let key = fsPath;
    try {
      const st = fs.statSync(fsPath);
      key += `:${st.size}:${st.mtimeMs}:${st.ctimeMs}`;
    } catch {
      /* source may have vanished */
    }
    const active = this.active.get(key);
    if (active && !active.completed && !signal) return active;
    const session = new GzipScanSession();
    if (!signal) this.active.set(key, session);
    void session.run(fsPath, signal, onProgress, options).finally(() => {
      if (this.active.get(key) === session) this.active.delete(key);
    });
    return session;
  }

  private publish(preview: GzipOrthoPreview): void {
    this.latest = preview;
    for (const listener of this.listeners) {
      try {
        listener(preview);
      } catch {
        /* a subscriber must not break the stream */
      }
    }
  }

  private async run(
    fsPath: string,
    signal?: AbortSignal,
    onProgress?: (pct: number) => void,
    options: GzipCacheOptions = {},
  ): Promise<void> {
    let collector = new NiftiInflateCollector();
    let lastPublished = 0,
      centerPublished = false;
    const step = () => {
      if (collector.header) this.header = collector.header;
      if (collector.axial0 && !this.z0Settled) this.settleZ0(collector.snapshot(true));
      const now = Date.now();
      if (collector.centerReady && (!centerPublished || now - lastPublished >= 500) && !collector.orthoComplete) {
        const h = collector.header;
        if (h && 4 * (h.nx * h.ny + h.nx * h.nz + h.ny * h.nz) <= 4 * 1024 ** 2) {
          this.publish(collector.snapshot(false));
          lastPublished = now;
          centerPublished = true;
        }
      }
    };
    collector.onSlice = step;
    const consume = (chunk: Uint8Array, offset: number) => collector.push(chunk, offset);
    try {
      const unpacked = await unpackGzipToCache(fsPath, { ...options, signal, onProgress, onChunk: consume });
      if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
      if (unpacked) {
        this.unpackPath = unpacked;
        if (!collector.orthoComplete) {
          if (!(await this.restorePreview(unpacked))) {
            await this.previewFromUnpack(unpacked, signal);
            this.lod = await extractStridedVolumeFromFile(unpacked, this.header!, GZIP_LOD_FACTOR, signal);
            await this.savePreview(unpacked, options.budgetBytes);
          }
        } else {
          this.finishCollector(collector);
          await this.savePreview(unpacked, options.budgetBytes);
        }
        this.completed = true;
        this.doneDefer.resolve(null);
        return;
      }
      // Read-only / quota-limited hosts retain the gzip checkpoint fallback.
      collector = new NiftiInflateCollector();
      collector.onSlice = step;
      const cached = await loadCachedIndex(fsPath);
      if (cached) {
        const preview = await previewFromGzipIndex(fsPath, cached, signal);
        this.header = preview.header;
        this.settleZ0(preview);
        this.settleOrtho(preview);
        this.publish(preview);
        this.index = cached;
      } else {
        this.index = await GzipIndex.buildIndex(fsPath, signal, onProgress, consume);
        if (!collector.orthoComplete) throw new Error('Incomplete NIfTI volume');
        this.finishCollector(collector);
        await saveCachedIndex(fsPath, this.index);
      }
      this.completed = true;
      this.doneDefer.resolve(this.index);
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      if (!this.z0Settled) this.z0Defer.reject(error);
      if (!this.orthoSettled) this.orthoDefer.reject(error);
      this.completed = true;
      this.doneDefer.resolve(null);
    } finally {
      this.listeners.clear();
    }
  }

  private finishCollector(collector: NiftiInflateCollector): void {
    if (!collector.orthoComplete) throw new Error('Truncated NIfTI volume');
    this.header = collector.header;
    this.axial0 = collector.axial0;
    this.coronal = collector.coronal;
    this.sagittal = collector.sagittal;
    this.lod = collector.lod;
    const preview = collector.snapshot(false);
    this.settleZ0(preview);
    this.settleOrtho(preview);
    this.publish(preview);
  }

  private settleZ0(preview: GzipOrthoPreview): void {
    if (this.z0Settled) return;
    this.z0Settled = true;
    this.z0Defer.resolve(preview);
  }
  private settleOrtho(preview: GzipOrthoPreview): void {
    if (this.orthoSettled) return;
    this.orthoSettled = true;
    this.orthoDefer.resolve(preview);
  }

  private async previewFromUnpack(file: string, signal?: AbortSignal): Promise<void> {
    const header = parseNiiHeaderQuick(await readLocalFilePartial(file, 0, 543));
    if (!header) throw new Error('Invalid unpacked NIfTI header');
    const sliceIdx = {
      axial: Math.floor(header.nz / 2),
      coronal: Math.floor(header.ny / 2),
      sagittal: Math.floor(header.nx / 2),
    };
    const [axial, coronal, sagittal] = await Promise.all(
      (['axial', 'coronal', 'sagittal'] as const).map((axis) =>
        extractLocalSlice(file, header, axis, sliceIdx[axis], 0, 1, signal),
      ),
    );
    if (!axial || !coronal || !sagittal) throw new Error('Incomplete cached preview');
    let min = Infinity,
      max = -Infinity;
    for (const plane of [axial, coronal, sagittal])
      for (const v of plane)
        if (Number.isFinite(v)) {
          min = Math.min(min, v);
          max = Math.max(max, v);
        }
    const preview = {
      header,
      axial,
      coronal,
      sagittal,
      sliceIdx,
      min: min === Infinity ? 0 : min,
      max: max > min ? max : min + 1,
      slope: header.scl_slope || 1,
      inter: header.scl_inter || 0,
    };
    this.header = header;
    this.settleZ0(preview);
    this.settleOrtho(preview);
    this.publish(preview);
  }

  private async savePreview(file: string, budgetBytes?: number): Promise<void> {
    if (!this.latest) return;
    const payload = serialize({ version: 1, preview: this.latest, lod: this.lod });
    // Preview storage is bounded independently of source dimensions.
    if (payload.length > 16 * 1024 ** 2) return;
    const checksum = createHash('sha256').update(payload).digest();
    try {
      await persistGzipPreview(file, Buffer.concat([checksum, payload]), budgetBytes);
    } catch {
      /* The seekable volume remains usable without a persisted preview. */
    }
  }

  private async restorePreview(file: string): Promise<boolean> {
    try {
      const st = await fs.promises.stat(file + '.preview');
      if (st.size > 16 * 1024 ** 2 + 32) return false;
      const bytes = await fs.promises.readFile(file + '.preview');
      if (!createHash('sha256').update(bytes.subarray(32)).digest().equals(bytes.subarray(0, 32))) return false;
      const value = deserialize(bytes.subarray(32)),
        p = value.preview;
      if (
        value.version !== 1 ||
        !(p?.axial instanceof Float32Array) ||
        !(p.coronal instanceof Float32Array) ||
        !(p.sagittal instanceof Float32Array)
      )
        return false;
      const h = p.header;
      if (!h || p.axial.length !== h.nx * h.ny || p.coronal.length !== h.nx * h.nz || p.sagittal.length !== h.ny * h.nz)
        return false;
      const actual = parseNiiHeaderQuick(await readLocalFilePartial(file, 0, 543));
      if (
        !actual ||
        actual.nx !== h.nx ||
        actual.ny !== h.ny ||
        actual.nz !== h.nz ||
        actual.datatype !== h.datatype ||
        actual.voxOffset !== h.voxOffset ||
        actual.scl_slope !== h.scl_slope ||
        actual.scl_inter !== h.scl_inter
      )
        return false;
      this.header = h;
      const lod = value.lod;
      if (
        lod &&
        (!(lod.volume instanceof Float32Array) ||
          lod.factor !== GZIP_LOD_FACTOR ||
          lod.volume.length !== lod.outNx * lod.outNy * lod.outNz ||
          lod.outNx !== Math.max(1, Math.floor(h.nx / lod.factor)) ||
          lod.outNy !== Math.max(1, Math.floor(h.ny / lod.factor)) ||
          lod.outNz !== Math.max(1, Math.floor(h.nz / lod.factor)))
      )
        return false;
      this.lod = lod;
      this.settleZ0(p);
      this.settleOrtho(p);
      this.publish(p);
      return true;
    } catch {
      return false;
    }
  }
}

class NiftiInflateCollector {
  header: NiiHeader | null = null;
  axial0: Float32Array | null = null;
  coronal: Float32Array | null = null;
  sagittal: Float32Array | null = null;
  lod: GzipLodVolume | null = null;
  orthoComplete = false;
  centerReady = false;
  onSlice?: () => void;
  private axialIndex = 0;

  private buf = Buffer.alloc(0);
  private bufStart = 0;
  private z = 0;
  private min = Infinity;
  private max = -Infinity;
  private coMid = 0;
  private saMid = 0;
  private sliceBytes = 0;
  private lodFactor = GZIP_LOD_FACTOR;
  private outNx = 0;
  private outNy = 0;
  private outNz = 0;

  push(chunk: Uint8Array, decompressedOffset: number): void {
    if (this.orthoComplete) return;
    if (this.buf.length === 0) this.bufStart = decompressedOffset;
    this.buf = Buffer.concat([this.buf, chunk]);

    if (!this.header && this.bufStart === 0 && this.buf.length >= 348) {
      this.header = parseNiiHeaderQuick(new Uint8Array(this.buf.buffer, this.buf.byteOffset, this.buf.length));
      if (this.header) this.allocFromHeader();
    }
    if (!this.header) return;

    const { nz, voxOffset } = this.header;
    while (this.z < nz) {
      const sliceStart = voxOffset + this.z * this.sliceBytes;
      const sliceEnd = sliceStart + this.sliceBytes;
      if (this.bufStart + this.buf.length < sliceEnd) break;
      const rel = sliceStart - this.bufStart;
      const sliceBuf = this.buf.subarray(rel, rel + this.sliceBytes);
      this.consumeSlice(sliceBuf, this.z);
      this.onSlice?.();
      this.z++;
      const nextStart = voxOffset + this.z * this.sliceBytes;
      if (nextStart > this.bufStart) {
        const drop = nextStart - this.bufStart;
        this.buf = Buffer.from(this.buf.subarray(Math.min(drop, this.buf.length)));
        this.bufStart = nextStart;
      }
    }

    if (this.z >= nz && !this.orthoComplete) {
      this.orthoComplete = true;
      if (this.min === this.max) this.max = this.min + 1;
      if (this.lod && this.lod.min === this.lod.max) this.lod.max = this.lod.min + 1;
    }
  }

  snapshot(axialOnly: boolean): GzipOrthoPreview {
    const header = this.header!;
    const { nx, ny, nz } = header;
    return {
      header,
      axial: this.axial0 ? this.axial0.slice() : new Float32Array(nx * ny),
      coronal: axialOnly ? new Float32Array(0) : this.coronal?.slice() || new Float32Array(nx * nz),
      sagittal: axialOnly ? new Float32Array(0) : this.sagittal?.slice() || new Float32Array(ny * nz),
      min: this.min === Infinity ? 0 : this.min,
      max: this.max === -Infinity || this.max === this.min ? (this.min === Infinity ? 1 : this.min + 1) : this.max,
      sliceIdx: {
        axial: this.axialIndex,
        coronal: this.coMid,
        sagittal: this.saMid,
      },
      slope: header.scl_slope || 1,
      inter: header.scl_inter || 0,
    };
  }

  private allocFromHeader(): void {
    const header = this.header!;
    const { nx, ny, nz, bytesPerVoxel } = header;
    this.sliceBytes = nx * ny * Math.max(1, bytesPerVoxel);
    this.coMid = Math.floor(ny / 2);
    this.saMid = Math.floor(nx / 2);
    this.coronal = new Float32Array(nx * nz);
    this.sagittal = new Float32Array(ny * nz);
    this.outNx = Math.max(1, Math.floor(nx / this.lodFactor));
    this.outNy = Math.max(1, Math.floor(ny / this.lodFactor));
    this.outNz = Math.max(1, Math.floor(nz / this.lodFactor));
    const loHeader: NiiHeader = { ...header };
    loHeader.nx = this.outNx;
    loHeader.ny = this.outNy;
    loHeader.nz = this.outNz;
    loHeader.dx = (header.dx || 1) * this.lodFactor;
    loHeader.dy = (header.dy || 1) * this.lodFactor;
    loHeader.dz = (header.dz || 1) * this.lodFactor;
    loHeader.pixDims = [loHeader.dx, loHeader.dy, loHeader.dz];
    const scaleRow = (row: number[]): number[] => row.map((v, i) => (i < 3 ? v * this.lodFactor : v));
    loHeader.srow_x = scaleRow(header.srow_x);
    loHeader.srow_y = scaleRow(header.srow_y);
    loHeader.srow_z = scaleRow(header.srow_z);
    if (Array.isArray(header.sform)) {
      const sform = header.sform.map((row: number[]) => [...row]);
      for (const row of sform) {
        row[0] *= this.lodFactor;
        row[1] *= this.lodFactor;
        row[2] *= this.lodFactor;
      }
      loHeader.sform = sform;
    }
    this.lod = {
      header: loHeader,
      factor: this.lodFactor,
      volume: new Float32Array(this.outNx * this.outNy * this.outNz),
      outNx: this.outNx,
      outNy: this.outNy,
      outNz: this.outNz,
      min: Infinity,
      max: -Infinity,
    };
  }

  private consumeSlice(sliceBytes: Uint8Array, z: number): void {
    const header = this.header!;
    const { nx, ny } = header;
    const bpv = Math.max(1, header.bytesPerVoxel);
    const view = new DataView(sliceBytes.buffer, sliceBytes.byteOffset, sliceBytes.byteLength);

    // Skip uniform background planes, but always provide a center plane for empty volumes.
    if (!this.axial0 || z === Math.floor(header.nz / 2)) {
      const axial = extractAxialSliceFromRange(sliceBytes, header);
      let lo = Infinity,
        hi = -Infinity;
      for (const v of axial)
        if (Number.isFinite(v)) {
          lo = Math.min(lo, v);
          hi = Math.max(hi, v);
        }
      const background = header.scl_inter || 0;
      if (hi > lo || hi !== background || z === Math.floor(header.nz / 2)) {
        this.axial0 = axial;
        this.axialIndex = z;
        this.min = Math.min(this.min, lo);
        this.max = Math.max(this.max, hi);
      }
    }
    if (z === Math.floor(header.nz / 2)) this.centerReady = true;

    if (this.coronal) {
      for (let x = 0; x < nx; x++) {
        const v = decodeVoxel(sliceBytes, (this.coMid * nx + x) * bpv, header, view);
        this.coronal[z * nx + x] = v;
        if (v < this.min) this.min = v;
        if (v > this.max) this.max = v;
      }
    }
    if (this.sagittal) {
      for (let y = 0; y < ny; y++) {
        const v = decodeVoxel(sliceBytes, (y * nx + this.saMid) * bpv, header, view);
        this.sagittal[z * ny + y] = v;
        if (v < this.min) this.min = v;
        if (v > this.max) this.max = v;
      }
    }

    if (this.lod && z % this.lodFactor === 0) {
      const outZ = z / this.lodFactor;
      if (outZ < this.outNz) {
        const base = outZ * this.outNy * this.outNx;
        for (let oy = 0; oy < this.outNy; oy++) {
          const srcY = oy * this.lodFactor;
          for (let ox = 0; ox < this.outNx; ox++) {
            const srcX = ox * this.lodFactor;
            const v = decodeVoxel(sliceBytes, (srcY * nx + srcX) * bpv, header, view);
            this.lod.volume[base + oy * this.outNx + ox] = v;
            if (v < this.lod.min) this.lod.min = v;
            if (v > this.lod.max) this.lod.max = v;
          }
        }
      }
    }
  }
}

export async function previewFromGzipIndex(
  fsPath: string,
  index: GzipIndex,
  signal?: AbortSignal,
): Promise<GzipOrthoPreview> {
  const headerBytes = await GzipIndex.readRange(fsPath, index, 0, 544, signal);
  const header = parseNiiHeaderQuick(headerBytes);
  if (!header) throw new Error('Failed to parse NIfTI header from gzip index');
  const { nx, ny, nz } = header;
  const axialIndex = Math.floor(nz / 2);
  const [axial, coronal, sagittal] = await Promise.all([
    extractSliceFromGzipIndex(fsPath, index, header, 'axial', axialIndex, 0, signal),
    extractSliceFromGzipIndex(fsPath, index, header, 'coronal', Math.floor(ny / 2), 0, signal),
    extractSliceFromGzipIndex(fsPath, index, header, 'sagittal', Math.floor(nx / 2), 0, signal),
  ]);
  if (!axial || !coronal || !sagittal) throw new Error('Incomplete indexed preview');
  let min = Infinity,
    max = -Infinity;
  for (let i = 0; i < axial.length; i++) {
    if (axial[i] < min) min = axial[i];
    if (axial[i] > max) max = axial[i];
  }
  if (min === max) max = min + 1;
  return {
    header,
    axial,
    coronal,
    sagittal,
    min,
    max,
    sliceIdx: { axial: axialIndex, coronal: Math.floor(ny / 2), sagittal: Math.floor(nx / 2) },
    slope: header.scl_slope || 1,
    inter: header.scl_inter || 0,
  };
}

export async function extractStridedVolumeFromFile(
  file: string,
  header: NiiHeader,
  factor: number,
  signal?: AbortSignal,
): Promise<GzipLodVolume> {
  const f = Math.max(2, Math.min(32, factor));
  const outNx = Math.max(1, Math.floor(header.nx / f)),
    outNy = Math.max(1, Math.floor(header.ny / f)),
    outNz = Math.max(1, Math.floor(header.nz / f));
  const volume = new Float32Array(outNx * outNy * outNz);
  let min = Infinity,
    max = -Infinity;
  for (let z = 0; z < outNz; z++) {
    const plane = await extractLocalSlice(file, header, 'axial', z * f, 0, f, signal);
    if (!plane) throw new Error('Incomplete low-resolution cache');
    volume.set(plane, z * outNx * outNy);
    for (const v of plane) {
      min = Math.min(min, v);
      max = Math.max(max, v);
    }
  }
  const loHeader: NiiHeader = {
    ...header,
    nx: outNx,
    ny: outNy,
    nz: outNz,
    dx: header.dx * f,
    dy: header.dy * f,
    dz: header.dz * f,
  };
  loHeader.pixDims = [loHeader.dx, loHeader.dy, loHeader.dz];
  const scaleRow = (row: number[]): number[] => row.map((v, i) => (i < 3 ? v * f : v));
  loHeader.srow_x = scaleRow(header.srow_x);
  loHeader.srow_y = scaleRow(header.srow_y);
  loHeader.srow_z = scaleRow(header.srow_z);
  return { header: loHeader, factor: f, volume, outNx, outNy, outNz, min, max: max > min ? max : min + 1 };
}

export async function extractStridedVolumeFromIndex(
  fsPath: string,
  index: GzipIndex,
  factor: number,
  signal?: AbortSignal,
): Promise<GzipLodVolume> {
  const f = Math.max(2, Math.min(32, Math.floor(factor) || 8));
  const headerBytes = await GzipIndex.readRange(fsPath, index, 0, 544, signal);
  const header = parseNiiHeaderQuick(headerBytes);
  if (!header) throw new Error('Failed to parse NIfTI header from gzip index');
  const { nx, ny, nz, voxOffset, bytesPerVoxel } = header;
  const bpv = Math.max(1, bytesPerVoxel);
  const sliceSize = nx * ny * bpv;
  const outNx = Math.max(1, Math.floor(nx / f));
  const outNy = Math.max(1, Math.floor(ny / f));
  const outNz = Math.max(1, Math.floor(nz / f));
  const volume = new Float32Array(outNx * outNy * outNz);
  let min = Infinity,
    max = -Infinity;

  for (let oz = 0; oz < outNz; oz++) {
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
    const srcZ = oz * f;
    const start = voxOffset + srcZ * sliceSize;
    const sliceBytes = await GzipIndex.readRange(fsPath, index, start, start + sliceSize, signal);
    const view = new DataView(sliceBytes.buffer, sliceBytes.byteOffset, sliceBytes.byteLength);
    const base = oz * outNy * outNx;
    for (let oy = 0; oy < outNy; oy++) {
      const srcY = oy * f;
      for (let ox = 0; ox < outNx; ox++) {
        const v = decodeVoxel(sliceBytes, (srcY * nx + ox * f) * bpv, header, view);
        volume[base + oy * outNx + ox] = v;
        if (v < min) min = v;
        if (v > max) max = v;
      }
    }
  }
  if (min === max) max = min + 1;

  const loHeader: NiiHeader = { ...header };
  loHeader.nx = outNx;
  loHeader.ny = outNy;
  loHeader.nz = outNz;
  loHeader.dx = (header.dx || 1) * f;
  loHeader.dy = (header.dy || 1) * f;
  loHeader.dz = (header.dz || 1) * f;
  loHeader.pixDims = [loHeader.dx, loHeader.dy, loHeader.dz];
  if (Array.isArray(header.sform)) {
    const sform = header.sform.map((row: number[]) => [...row]);
    for (const row of sform) {
      row[0] *= f;
      row[1] *= f;
      row[2] *= f;
    }
    loHeader.sform = sform;
  }

  return { header: loHeader, factor: f, volume, outNx, outNy, outNz, min, max };
}

/**
 * Extract one orthogonal slice from a gzip file using a single inflate walk
 * for coronal/sagittal (instead of one inflate per z).
 */
export async function extractSliceFromGzipIndex(
  fsPath: string,
  index: GzipIndex,
  header: NiiHeader,
  axis: string,
  idx: number,
  timeIdx = 0,
  signal?: AbortSignal,
): Promise<Float32Array | null> {
  const { nx, ny, nz, voxOffset } = header;
  const bpv = Math.max(1, header.bitpix / 8);
  const tOff = timepointByteOffset(header, timeIdx);
  const base = voxOffset + tOff;

  if (axis === 'axial') {
    if (idx < 0 || idx >= nz) return null;
    const sliceStart = base + idx * nx * ny * bpv;
    const sliceBytes = await GzipIndex.readRange(fsPath, index, sliceStart, sliceStart + nx * ny * bpv, signal);
    return extractAxialSliceFromRange(sliceBytes, header);
  }

  if (axis === 'coronal') {
    if (idx < 0 || idx >= ny) return null;
    const slice = new Float32Array(nx * nz);
    const rowSize = nx * bpv;
    const first = base + idx * nx * bpv;
    const last = base + ((nz - 1) * ny * nx + idx * nx) * bpv + rowSize;
    const rows = Array.from({ length: nz }, () => Buffer.alloc(rowSize));
    await GzipIndex.scanRange(
      fsPath,
      index,
      first,
      last,
      (abs, chunk) => {
        for (let z = 0; z < nz; z++) {
          const rowOff = base + (z * ny * nx + idx * nx) * bpv;
          const rowEnd = rowOff + rowSize;
          const a = Math.max(abs, rowOff);
          const b = Math.min(abs + chunk.length, rowEnd);
          if (a < b) Buffer.from(chunk.subarray(a - abs, b - abs)).copy(rows[z], a - rowOff);
        }
      },
      signal,
    );
    for (let z = 0; z < nz; z++) {
      const view = new DataView(rows[z].buffer, rows[z].byteOffset, rows[z].byteLength);
      for (let x = 0; x < nx; x++) {
        slice[z * nx + x] = decodeVoxel(rows[z], x * bpv, header, view);
      }
    }
    return slice;
  }

  if (idx < 0 || idx >= nx) return null;
  const slice = new Float32Array(ny * nz);
  const first = base + idx * bpv;
  const last = base + ((nz - 1) * nx * ny + (ny - 1) * nx + idx) * bpv + bpv;
  const voxels = Array.from({ length: ny * nz }, () => Buffer.alloc(bpv));
  await GzipIndex.scanRange(
    fsPath,
    index,
    first,
    last,
    (abs, chunk) => {
      for (let z = 0; z < nz; z++) {
        for (let y = 0; y < ny; y++) {
          const off = base + (z * nx * ny + y * nx + idx) * bpv;
          const end = off + bpv;
          const a = Math.max(abs, off);
          const b = Math.min(abs + chunk.length, end);
          if (a < b) Buffer.from(chunk.subarray(a - abs, b - abs)).copy(voxels[z * ny + y], a - off);
        }
      }
    },
    signal,
  );
  for (let z = 0; z < nz; z++) {
    for (let y = 0; y < ny; y++) {
      const buf = voxels[z * ny + y];
      const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
      slice[z * ny + y] = decodeVoxel(buf, 0, header, view);
    }
  }
  return slice;
}

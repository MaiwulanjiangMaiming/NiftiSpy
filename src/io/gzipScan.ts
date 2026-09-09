import { parseNiiHeaderQuick, timepointByteOffset } from '../nifti/headerParser';
import { decodeVoxel, extractAxialSliceFromRange } from '../nifti/sliceExtractor';
import { GzipIndex, loadCachedIndex, saveCachedIndex } from './gzipIndex';
import { unpackGzipToCache } from './gzipUnpack';
import { readLocalFilePartial } from './fileReader';

export const GZIP_LOD_FACTOR = 8;

export interface GzipOrthoPreview {
  header: any;
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
  header: any;
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

/**
 * One sequential inflate of a local `.nii.gz`: first axial slice as soon as
 * it exists, mid-plane coronal/sagittal as z advances, a coarse strided
 * volume, and a random-access gzip index for later `/slice` requests.
 */
export class GzipScanSession {
  header: any = null;
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

  constructor() {
    this.z0 = this.z0Defer.promise;
    this.ortho = this.orthoDefer.promise;
    this.done = this.doneDefer.promise;
    this.z0.catch(() => {});
    this.ortho.catch(() => {});
  }

  static start(
    fsPath: string,
    signal?: AbortSignal,
    onProgress?: (pct: number) => void,
  ): GzipScanSession {
    const session = new GzipScanSession();
    void session.run(fsPath, signal, onProgress);
    return session;
  }

  private async run(
    fsPath: string,
    signal?: AbortSignal,
    onProgress?: (pct: number) => void,
  ): Promise<void> {
    try {
      const cached = await loadCachedIndex(fsPath);
      if (cached && !signal?.aborted) {
        try {
          const preview = await previewFromGzipIndex(fsPath, cached, signal);
          this.index = cached;
          this.header = preview.header;
          this.axial0 = preview.axial;
          this.coronal = preview.coronal;
          this.sagittal = preview.sagittal;
          this.settleZ0(preview);
          this.settleOrtho(preview);
          this.doneDefer.resolve(cached);
          return;
        } catch {
          // Sidecar present but unusable — rebuild from the gzip stream.
        }
      }

      const collector = new NiftiInflateCollector();
      const index = await GzipIndex.buildIndex(fsPath, signal, onProgress, (chunk, offset) => {
        collector.push(chunk, offset);
        if (collector.header && !this.header) this.header = collector.header;
        if (collector.axial0 && !this.z0Settled) {
          this.axial0 = collector.axial0;
          this.coronal = collector.coronal;
          this.sagittal = collector.sagittal;
          this.settleZ0(collector.snapshot(true));
        }
        if (collector.orthoComplete && !this.orthoSettled) {
          this.coronal = collector.coronal;
          this.sagittal = collector.sagittal;
          this.lod = collector.lod;
          this.settleOrtho(collector.snapshot(false));
        }
      });
      this.index = index;
      this.header = collector.header || this.header;
      this.axial0 = collector.axial0 || this.axial0;
      this.coronal = collector.coronal || this.coronal;
      this.sagittal = collector.sagittal || this.sagittal;
      this.lod = collector.lod || this.lod;
      if (this.header && this.axial0 && !this.z0Settled) {
        this.settleZ0(collector.snapshot(true));
      }
      if (this.header && this.coronal && this.sagittal && !this.orthoSettled) {
        this.settleOrtho(collector.snapshot(false));
      }
      await saveCachedIndex(fsPath, index);
      this.doneDefer.resolve(index);
    } catch (err: any) {
      try {
        const unpacked = await unpackGzipToCache(fsPath);
        if (unpacked) {
          this.unpackPath = unpacked;
          await this.settleFromUnpack(unpacked);
        }
      } catch {
        // Unpack is best-effort; /slice may still fall back to a full inflate.
      }
      const error = err instanceof Error ? err : new Error(String(err));
      if (!this.z0Settled) this.z0Defer.reject(error);
      if (!this.orthoSettled) this.orthoDefer.reject(error);
      this.doneDefer.resolve(null);
    }
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

  private async settleFromUnpack(unpackPath: string): Promise<void> {
    try {
      const headerBytes = await readLocalFilePartial(unpackPath, 0, 543);
      const header = parseNiiHeaderQuick(headerBytes);
      if (!header) return;
      this.header = header;
      const { nx, ny, voxOffset, bytesPerVoxel } = header;
      const sliceSize = nx * ny * Math.max(1, bytesPerVoxel);
      const axialBytes = await readLocalFilePartial(unpackPath, voxOffset, voxOffset + sliceSize - 1);
      const axial = extractAxialSliceFromRange(axialBytes, header);
      let min = Infinity, max = -Infinity;
      for (let i = 0; i < axial.length; i++) {
        if (axial[i] < min) min = axial[i];
        if (axial[i] > max) max = axial[i];
      }
      if (min === max) max = min + 1;
      const preview: GzipOrthoPreview = {
        header,
        axial,
        coronal: new Float32Array(nx * header.nz),
        sagittal: new Float32Array(ny * header.nz),
        min, max,
        sliceIdx: { axial: 0, coronal: Math.floor(ny / 2), sagittal: Math.floor(nx / 2) },
        slope: header.scl_slope || 1,
        inter: header.scl_inter || 0,
      };
      this.axial0 = axial;
      this.settleZ0(preview);
    } catch {
      // Preview from the unpack sidecar is optional.
    }
  }
}

class NiftiInflateCollector {
  header: any = null;
  axial0: Float32Array | null = null;
  coronal: Float32Array | null = null;
  sagittal: Float32Array | null = null;
  lod: GzipLodVolume | null = null;
  orthoComplete = false;

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
    const header = this.header;
    const { nx, ny, nz } = header;
    return {
      header,
      axial: this.axial0 || new Float32Array(nx * ny),
      coronal: axialOnly ? new Float32Array(nx * nz) : (this.coronal || new Float32Array(nx * nz)),
      sagittal: axialOnly ? new Float32Array(ny * nz) : (this.sagittal || new Float32Array(ny * nz)),
      min: this.min === Infinity ? 0 : this.min,
      max: this.max === -Infinity || this.max === this.min ? (this.min === Infinity ? 1 : this.min + 1) : this.max,
      sliceIdx: {
        axial: 0,
        coronal: this.coMid,
        sagittal: this.saMid,
      },
      slope: header.scl_slope || 1,
      inter: header.scl_inter || 0,
    };
  }

  private allocFromHeader(): void {
    const { nx, ny, nz, bytesPerVoxel } = this.header;
    this.sliceBytes = nx * ny * Math.max(1, bytesPerVoxel);
    this.coMid = Math.floor(ny / 2);
    this.saMid = Math.floor(nx / 2);
    this.coronal = new Float32Array(nx * nz);
    this.sagittal = new Float32Array(ny * nz);
    this.outNx = Math.max(1, Math.floor(nx / this.lodFactor));
    this.outNy = Math.max(1, Math.floor(ny / this.lodFactor));
    this.outNz = Math.max(1, Math.floor(nz / this.lodFactor));
    const loHeader: any = { ...this.header };
    loHeader.nx = this.outNx;
    loHeader.ny = this.outNy;
    loHeader.nz = this.outNz;
    loHeader.dx = (this.header.dx || 1) * this.lodFactor;
    loHeader.dy = (this.header.dy || 1) * this.lodFactor;
    loHeader.dz = (this.header.dz || 1) * this.lodFactor;
    loHeader.pixDims = [loHeader.dx, loHeader.dy, loHeader.dz];
    if (Array.isArray(this.header.sform)) {
      const sform = this.header.sform.map((row: number[]) => [...row]);
      for (const row of sform) { row[0] *= this.lodFactor; row[1] *= this.lodFactor; row[2] *= this.lodFactor; }
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
    const header = this.header;
    const { nx, ny } = header;
    const bpv = Math.max(1, header.bytesPerVoxel);
    const view = new DataView(sliceBytes.buffer, sliceBytes.byteOffset, sliceBytes.byteLength);

    if (z === 0) {
      this.axial0 = extractAxialSliceFromRange(sliceBytes, header);
      for (let i = 0; i < this.axial0.length; i++) {
        const v = this.axial0[i];
        if (v < this.min) this.min = v;
        if (v > this.max) this.max = v;
      }
    }

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
  const { nx, ny, voxOffset, bytesPerVoxel } = header;
  const sliceSize = nx * ny * Math.max(1, bytesPerVoxel);
  const axialBytes = await GzipIndex.readRange(fsPath, index, voxOffset, voxOffset + sliceSize, signal);
  const axial = extractAxialSliceFromRange(axialBytes, header);
  let min = Infinity, max = -Infinity;
  for (let i = 0; i < axial.length; i++) {
    if (axial[i] < min) min = axial[i];
    if (axial[i] > max) max = axial[i];
  }
  if (min === max) max = min + 1;
  return {
    header,
    axial,
    coronal: new Float32Array(nx * header.nz),
    sagittal: new Float32Array(ny * header.nz),
    min, max,
    sliceIdx: { axial: 0, coronal: Math.floor(ny / 2), sagittal: Math.floor(nx / 2) },
    slope: header.scl_slope || 1,
    inter: header.scl_inter || 0,
  };
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
  let min = Infinity, max = -Infinity;

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

  const loHeader: any = { ...header };
  loHeader.nx = outNx;
  loHeader.ny = outNy;
  loHeader.nz = outNz;
  loHeader.dx = (header.dx || 1) * f;
  loHeader.dy = (header.dy || 1) * f;
  loHeader.dz = (header.dz || 1) * f;
  loHeader.pixDims = [loHeader.dx, loHeader.dy, loHeader.dz];
  if (Array.isArray(header.sform)) {
    const sform = header.sform.map((row: number[]) => [...row]);
    for (const row of sform) { row[0] *= f; row[1] *= f; row[2] *= f; }
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
  header: any,
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
    await GzipIndex.scanRange(fsPath, index, first, last, (abs, chunk) => {
      for (let z = 0; z < nz; z++) {
        const rowOff = base + (z * ny * nx + idx * nx) * bpv;
        const rowEnd = rowOff + rowSize;
        const a = Math.max(abs, rowOff);
        const b = Math.min(abs + chunk.length, rowEnd);
        if (a < b) Buffer.from(chunk.subarray(a - abs, b - abs)).copy(rows[z], a - rowOff);
      }
    }, signal);
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
  await GzipIndex.scanRange(fsPath, index, first, last, (abs, chunk) => {
    for (let z = 0; z < nz; z++) {
      for (let y = 0; y < ny; y++) {
        const off = base + (z * nx * ny + y * nx + idx) * bpv;
        const end = off + bpv;
        const a = Math.max(abs, off);
        const b = Math.min(abs + chunk.length, end);
        if (a < b) Buffer.from(chunk.subarray(a - abs, b - abs)).copy(voxels[z * ny + y], a - off);
      }
    }
  }, signal);
  for (let z = 0; z < nz; z++) {
    for (let y = 0; y < ny; y++) {
      const buf = voxels[z * ny + y];
      const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
      slice[z * ny + y] = decodeVoxel(buf, 0, header, view);
    }
  }
  return slice;
}

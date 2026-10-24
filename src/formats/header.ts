import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

/** NIfTI datatype → bytes per voxel. */
export const DATATYPE_BYTES: Record<number, number> = {
  2: 1,    // uint8
  4: 2,    // int16
  8: 4,    // int32
  16: 4,   // float32
  64: 8,   // float64
  256: 1,  // int8
  512: 2,  // uint16
  768: 4,  // uint32
};

export interface HeaderSpec {
  nx: number;
  ny: number;
  nz: number;
  nt?: number;
  dx?: number;
  dy?: number;
  dz?: number;
  dt?: number;
  datatype: number;
  voxOffset: number;
  littleEndian?: boolean;
  slope?: number;
  inter?: number;
  sform?: number[][];
  descrip?: string;
  orientation?: string;
}

/** Build the exact NIfTI-shaped header consumed by the viewer/proxy. */
export function makeNiftiHeader(spec: HeaderSpec): any {
  const nx = Math.max(1, Math.floor(spec.nx));
  const ny = Math.max(1, Math.floor(spec.ny));
  const nz = Math.max(1, Math.floor(spec.nz));
  const nt = Math.max(1, Math.floor(spec.nt || 1));
  const dx = spec.dx || 1;
  const dy = spec.dy || 1;
  const dz = spec.dz || 1;
  const bytes = DATATYPE_BYTES[spec.datatype] || 1;
  const sform = spec.sform && spec.sform.length === 3 ? spec.sform : null;

  return {
    version: 1,
    ndim: nt > 1 ? 4 : 3,
    nx, ny, nz, nt, nu: 1,
    dx, dy, dz, dt: spec.dt || 1,
    datatype: spec.datatype,
    bitpix: bytes * 8,
    voxOffset: spec.voxOffset,
    scl_slope: spec.slope ?? 1,
    scl_inter: spec.inter ?? 0,
    littleEndian: spec.littleEndian !== false,
    isGzip: false,
    bytesPerVoxel: bytes,
    totalVoxels3D: nx * ny * nz,
    sliceSizeXY: nx * ny,
    volumeBytes: nx * ny * nz * nt * bytes,
    qform_code: 0,
    sform_code: sform ? 1 : 0,
    quatern_b: 0, quatern_c: 0, quatern_d: 0,
    qoffset_x: 0, qoffset_y: 0, qoffset_z: 0,
    srow_x: sform ? sform[0] : [dx, 0, 0, 0],
    srow_y: sform ? sform[1] : [0, dy, 0, 0],
    srow_z: sform ? sform[2] : [0, 0, dz, 0],
    pixDims: [dx, dy, dz],
    descrip: (spec.descrip || '').slice(0, 80),
    xyzt_units: 0,
    orientation: spec.orientation || 'RAS',
  };
}

export async function readFileBytes(filePath: string): Promise<Uint8Array> {
  const buf = await fs.promises.readFile(filePath);
  return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
}

export async function readRange(filePath: string, start: number, endExclusive: number): Promise<Uint8Array> {
  const length = Math.max(0, endExclusive - start);
  const out = new Uint8Array(length);
  if (!length) return out;
  const fh = await fs.promises.open(filePath, 'r');
  try {
    let done = 0;
    while (done < length) {
      const r = await fh.read(out, done, length - done, start + done);
      if (!r.bytesRead) break;
      done += r.bytesRead;
    }
    return done === length ? out : out.subarray(0, done);
  } finally {
    await fh.close();
  }
}

/** Read the leading text header of NRRD/MetaImage and locate the data start. */
export async function readTextHeader(
  filePath: string,
  marker: RegExp,
  maxBytes = 4 * 1024 * 1024,
): Promise<{ text: string; dataStart: number }> {
  const stat = await fs.promises.stat(filePath);
  const bytes = await readRange(filePath, 0, Math.min(stat.size, maxBytes));
  const text = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString('latin1');
  const match = marker.exec(text);
  if (!match) throw new Error('unterminated text header');
  return { text, dataStart: match.index + match[0].length };
}

let tempCounter = 0;

/** Persist a materialized volume under a private temp directory. */
export async function writeTempVolume(data: Uint8Array): Promise<string> {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'niftispy-'));
  const file = path.join(dir, `volume-${process.pid}-${tempCounter++}.raw`);
  await fs.promises.writeFile(file, data);
  return file;
}

/** Remove all files produced by writeTempVolume (and their private dirs). */
export async function removeTempVolumes(files: string[] | undefined): Promise<void> {
  if (!files || files.length === 0) return;
  await Promise.all(files.map(async file => {
    try {
      const dir = path.dirname(file);
      if (path.basename(dir).startsWith('niftispy-')) {
        await fs.promises.rm(dir, { recursive: true, force: true });
      } else {
        await fs.promises.rm(file, { force: true });
      }
    } catch {
      // temp cleanup must never fail the editor
    }
  }));
}

/** In-place byte swap for 2/4/8-byte big-endian data. */
export function swapBytes(data: Uint8Array, bytes: number): Uint8Array {
  if (bytes < 2) return data;
  const copy = data.byteOffset === 0 && data.byteLength === data.buffer.byteLength
    ? data
    : new Uint8Array(data);
  for (let i = 0; i + bytes <= copy.length; i += bytes) {
    for (let a = i, b = i + bytes - 1; a < b; a++, b--) {
      const t = copy[a];
      copy[a] = copy[b];
      copy[b] = t;
    }
  }
  return copy;
}

/** Big-endian raw volume → little-endian copy (viewer/GPU assume LE). */
export function ensureLittleEndian(data: Uint8Array, bytes: number): Uint8Array {
  return swapBytes(data, bytes);
}

/** Convert a Node Buffer / typed array into an exact-size Uint8Array copy. */
export function toU8(data: Uint8Array): Uint8Array {
  if (data.byteOffset === 0 && data.byteLength === data.buffer.byteLength) return data;
  return new Uint8Array(data);
}

/** Create a raw-data view for a typed array (little-endian typed arrays). */
export function typedToU8(data: ArrayBufferView): Uint8Array {
  return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
}

/** Minimal sform from direction cosines + spacing + origin. */
export function sformFromMdc(
  mdc: number[][],
  spacing: [number, number, number],
  origin: [number, number, number],
): number[][] {
  return [
    [mdc[0][0] * spacing[0], mdc[0][1] * spacing[1], mdc[0][2] * spacing[2], origin[0]],
    [mdc[1][0] * spacing[0], mdc[1][1] * spacing[1], mdc[1][2] * spacing[2], origin[1]],
    [mdc[2][0] * spacing[0], mdc[2][1] * spacing[1], mdc[2][2] * spacing[2], origin[2]],
  ];
}

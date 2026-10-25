import type { NiiHeader } from './headerParser';
/**
 * Minimal NumPy `.npy` reader: converts an array into the NIfTI-shaped
 * header + flat voxel buffer that the existing viewer pipeline renders.
 *
 * Layout notes:
 * - C order (default) uses the last axis as X, so `(z, y, x)` maps 1:1 to
 *   NIfTI's x-fastest voxel order without copying.
 * - Fortran order already has the first axis fastest, so `(x, y, z)` maps 1:1.
 */

import { makeNiftiHeader } from '../formats/header';

const NPY_MAGIC = [0x93, 0x4e, 0x55, 0x4d, 0x50, 0x59];

const DTYPE_MAP: Record<string, { datatype: number; bytes: number }> = {
  b1: { datatype: 2, bytes: 1 }, // bool → uint8
  u1: { datatype: 2, bytes: 1 },
  i1: { datatype: 256, bytes: 1 },
  u2: { datatype: 512, bytes: 2 },
  i2: { datatype: 4, bytes: 2 },
  u4: { datatype: 768, bytes: 4 },
  i4: { datatype: 8, bytes: 4 },
  f4: { datatype: 16, bytes: 4 },
  f8: { datatype: 64, bytes: 8 },
};

export interface NpyVolume {
  /** NIfTI-compatible header (fields consumed by the webview renderer). */
  header: NiiHeader;
  /** Exact-size buffer; `header.voxOffset` is absolute within this buffer. */
  rawData: Uint8Array;
}

export interface NpyLayout {
  datatype: number;
  bytes: number;
  shape: number[];
  fortran: boolean;
  descr: string;
  order: string;
  kind: string;
  voxOffset: number;
  voxelCount: number;
  /** float16 / 64-bit ints / big-endian need a full-buffer conversion. */
  needsTransform: boolean;
}

/** Parse only the header; `totalSize` lets a partial remote read pass. */
export function parseNpyLayout(source: Uint8Array, totalSize = source.length): NpyLayout {
  if (source.length < 12) throw new Error('not a NumPy .npy file');
  for (let i = 0; i < NPY_MAGIC.length; i++) {
    if (source[i] !== NPY_MAGIC[i]) throw new Error('not a NumPy .npy file');
  }
  const major = source[6];
  const headerStart = major === 1 ? 10 : 12;
  const headerLen =
    major === 1 ? source[8] | (source[9] << 8) : source[8] | (source[9] << 8) | (source[10] << 16) | (source[11] << 24);
  if (major !== 1 && major !== 2 && major !== 3) {
    throw new Error(`unsupported .npy version ${major}`);
  }
  if (headerStart + headerLen > source.length) throw new Error('truncated .npy header');

  const text = new TextDecoder().decode(source.subarray(headerStart, headerStart + headerLen));
  const descr = /'descr'\s*:\s*'([^']+)'/.exec(text)?.[1] ?? '';
  const fortran = /'fortran_order'\s*:\s*(True|False)/.exec(text)?.[1] === 'True';
  const shapeText = /'shape'\s*:\s*\(([^)]*)\)/.exec(text)?.[1];
  if (!descr || shapeText === undefined) throw new Error('unreadable .npy header');

  const shape = shapeText
    .split(',')
    .map((v) => v.trim())
    .filter(Boolean)
    .map(Number);
  if (shape.length < 1 || shape.length > 4) throw new Error('only 1D–4D arrays are supported');
  if (shape.some((v) => !Number.isSafeInteger(v) || v < 0)) throw new Error('invalid .npy shape');

  const dtype = /^([<>|=])([biuf])(\d+)$/.exec(descr);
  if (!dtype) throw new Error(`unsupported .npy dtype ${descr}`);
  const order = dtype[1];
  const kind = dtype[2];
  const bytes = Number(dtype[3]);
  const datatype = DTYPE_MAP[`${kind}${bytes}`]?.datatype ?? 0;
  const needsWidening = (kind === 'f' && bytes === 2) || ((kind === 'i' || kind === 'u') && bytes === 8);
  if (!datatype && !needsWidening) throw new Error(`unsupported .npy dtype ${descr}`);

  const voxelCount = shape.reduce((a, b) => a * b, 1);
  if (voxelCount === 0) throw new Error('empty array');
  const voxOffset = headerStart + headerLen;
  if (voxelCount * bytes > totalSize - voxOffset) throw new Error('truncated .npy data');

  return {
    datatype,
    bytes,
    shape,
    fortran,
    descr,
    order,
    kind,
    voxOffset,
    voxelCount,
    needsTransform: needsWidening || (order === '>' && bytes > 1),
  };
}

/** Build the viewer header for a decoded/streamed `.npy` layout. */
export function npyHeaderFromLayout(layout: NpyLayout, voxOffset: number): NiiHeader {
  const axes = layout.fortran ? layout.shape : layout.shape.slice().reverse();
  const nx = axes[0] || 1;
  const ny = axes[1] || 1;
  const nz = axes[2] || 1;
  const nt = axes[3] || 1;
  const datatype = layout.datatype === 0 ? (layout.kind === 'f' && layout.bytes === 2 ? 16 : 64) : layout.datatype;
  return makeNiftiHeader({
    nx,
    ny,
    nz,
    nt,
    datatype,
    voxOffset,
    descrip: `NumPy ${layout.descr} (${layout.shape.join('×')})${layout.fortran ? ' Fortran' : ''}`,
  });
}

export function parseNpyVolume(source: Uint8Array): NpyVolume {
  // Keep the backing buffer exactly the file size so the webview can create
  // zero-copy typed-array views from (rawData.buffer, voxOffset).
  const file =
    source.byteOffset === 0 && source.byteLength === source.buffer.byteLength ? source : new Uint8Array(source);
  const layout = parseNpyLayout(file);
  const { voxOffset, bytes } = layout;

  let rawData = file;
  let outOffset = voxOffset;

  if (layout.kind === 'f' && bytes === 2) {
    // float16 → float32
    const view = new DataView(file.buffer, file.byteOffset + voxOffset, layout.voxelCount * 2);
    const out = new Float32Array(layout.voxelCount);
    const le = layout.order !== '>';
    for (let i = 0; i < layout.voxelCount; i++) out[i] = halfToFloat(view.getUint16(i * 2, le));
    rawData = new Uint8Array(out.buffer);
    outOffset = 0;
  } else if ((layout.kind === 'i' || layout.kind === 'u') && bytes === 8) {
    // 64-bit ints are uncommon in imaging; widen to float64 for display.
    const view = new DataView(file.buffer, file.byteOffset + voxOffset, layout.voxelCount * 8);
    const out = new Float64Array(layout.voxelCount);
    const le = layout.order !== '>';
    for (let i = 0; i < layout.voxelCount; i++) {
      out[i] = layout.kind === 'i' ? Number(view.getBigInt64(i * 8, le)) : Number(view.getBigUint64(i * 8, le));
    }
    rawData = new Uint8Array(out.buffer);
    outOffset = 0;
  } else if (layout.order === '>' && bytes > 1) {
    // Byte-swap into a little-endian copy.
    rawData = copyRange(file, voxOffset, voxOffset + layout.voxelCount * bytes);
    for (let i = 0; i < rawData.length; i += bytes) {
      for (let a = i, b = i + bytes - 1; a < b; a++, b--) {
        const t = rawData[a];
        rawData[a] = rawData[b];
        rawData[b] = t;
      }
    }
    outOffset = 0;
  } else if (outOffset % bytes !== 0) {
    rawData = copyRange(file, voxOffset, voxOffset + layout.voxelCount * bytes);
    outOffset = 0;
  }

  return {
    rawData,
    header: npyHeaderFromLayout(layout, outOffset),
  };
}

function copyRange(file: Uint8Array, start: number, end: number): Uint8Array {
  const out = new Uint8Array(end - start);
  out.set(file.subarray(start, end));
  return out;
}

function halfToFloat(h: number): number {
  const sign = h & 0x8000 ? -1 : 1;
  const exp = (h >> 10) & 0x1f;
  const frac = h & 0x3ff;
  if (exp === 0) return sign * 2 ** -14 * (frac / 1024);
  if (exp === 0x1f) return frac ? NaN : sign * Infinity;
  return sign * 2 ** (exp - 15) * (1 + frac / 1024);
}

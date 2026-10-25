/**
 * Single NIfTI header parser shared by the extension host and the webview.
 *
 * The host reads leniently (`parseNiiHeaderQuick` returns null on malformed
 * input) while the webview throws (`parseNiiHeader`). Both now share the same
 * field extraction, datatype table and orientation detection.
 */

export type NiiOrientation =
  | 'RAS'
  | 'LAS'
  | 'LPS'
  | 'RPS'
  | 'RSA'
  | 'LSA'
  | 'LIA'
  | 'RIA'
  | 'AIR'
  | 'PIR'
  | 'RIP'
  | 'LIP'
  | 'unknown';

export interface NiiHeader {
  version: 1 | 2;
  ndim: number;
  nx: number;
  ny: number;
  nz: number;
  nt: number;
  nu: number;
  dx: number;
  dy: number;
  dz: number;
  dt: number;
  datatype: number;
  bitpix: number;
  voxOffset: number;
  scl_slope: number;
  scl_inter: number;
  littleEndian: boolean;
  isGzip: boolean;
  bytesPerVoxel: number;
  totalVoxels3D: number;
  sliceSizeXY: number;
  volumeBytes: number;
  qform_code: number;
  sform_code: number;
  quatern_b: number;
  quatern_c: number;
  quatern_d: number;
  qoffset_x: number;
  qoffset_y: number;
  qoffset_z: number;
  srow_x: number[];
  srow_y: number[];
  srow_z: number[];
  /** Optional 3×4 voxel→world matrix attached by some format parsers. */
  sform?: number[][];
  pixDims?: number[];
  descrip: string;
  xyzt_units: number;
  orientation: NiiOrientation;
}

export type NiiDataType =
  | 'uint8'
  | 'int16'
  | 'int32'
  | 'float32'
  | 'float64'
  | 'int8'
  | 'uint16'
  | 'uint32'
  | 'int64'
  | 'uint64'
  | 'rgb24'
  | 'rgba32';

export const DATATYPE_MAP: Record<number, { type: NiiDataType; bytes: number }> = {
  1: { type: 'uint8', bytes: 1 },
  2: { type: 'uint8', bytes: 1 },
  4: { type: 'int16', bytes: 2 },
  8: { type: 'int32', bytes: 4 },
  16: { type: 'float32', bytes: 4 },
  64: { type: 'float64', bytes: 8 },
  128: { type: 'rgb24', bytes: 3 },
  256: { type: 'int8', bytes: 1 },
  512: { type: 'uint16', bytes: 2 },
  768: { type: 'uint32', bytes: 4 },
  1024: { type: 'int64', bytes: 8 },
  1280: { type: 'uint64', bytes: 8 },
  4096: { type: 'rgba32', bytes: 4 },
};

export const DATATYPE_NAMES: Record<number, string> = {
  1: 'binary',
  2: 'uint8',
  4: 'int16',
  8: 'int32',
  16: 'float32',
  64: 'float64',
  128: 'RGB24',
  256: 'int8',
  512: 'uint16',
  768: 'uint32',
  1024: 'int64',
  1280: 'uint64',
  4096: 'RGBA32',
};

export interface ParseNiiHeaderOptions {
  /** Analyze pairs store voxels in a separate .img, so voxOffset is 0. */
  separateImg?: boolean;
  isGzip?: boolean;
  /** Throw on invalid input instead of returning null (webview path). */
  strict?: boolean;
}

function invalid(opts: ParseNiiHeaderOptions, message: string): null {
  if (opts.strict) throw new Error(message);
  return null;
}

function detectOrientation(srow_x: number[], srow_y: number[], srow_z: number[]): NiiOrientation {
  // ITK-Snap style: RAI codes for cardinal directions
  const rai_start = 'RAI';
  const rai_end = 'LPS';
  let rai_out = '...';

  // Make the direction matrix (columns are the srow vectors)
  const direction_matrix: number[][] = [
    [srow_x[0], srow_y[0], srow_z[0]],
    [srow_x[1], srow_y[1], srow_z[1]],
    [srow_x[2], srow_y[2], srow_z[2]],
  ];

  for (let i = 0; i < 3; i++) {
    const dir_i = [direction_matrix[0][i], direction_matrix[1][i], direction_matrix[2][i]];
    const abs_dir_i = [Math.abs(dir_i[0]), Math.abs(dir_i[1]), Math.abs(dir_i[2])];
    const maxabs_i = Math.max(abs_dir_i[0], abs_dir_i[1], abs_dir_i[2]);

    // ITK-Snap trick: visit (i,i) first for tie-breaking
    for (let off = 0; off < 3; off++) {
      const j = (i + off) % 3;
      if (Math.abs(dir_i[j]) === maxabs_i) {
        rai_out = rai_out.substring(0, i) + (dir_i[j] > 0 ? rai_start[j] : rai_end[j]) + rai_out.substring(i + 1);
        break;
      }
    }
  }

  const knownOrientations: NiiOrientation[] = [
    'RAS',
    'LAS',
    'LPS',
    'RPS',
    'RSA',
    'LSA',
    'LIA',
    'RIA',
    'AIR',
    'PIR',
    'RIP',
    'LIP',
  ];
  return knownOrientations.includes(rai_out as NiiOrientation) ? (rai_out as NiiOrientation) : 'unknown';
}

function readDescrip(buf: Uint8Array): string {
  try {
    const descripBytes = buf.subarray(148, 228);
    let end = descripBytes.indexOf(0);
    if (end === -1) end = 80;
    return new TextDecoder().decode(descripBytes.slice(0, end));
  } catch {
    return '';
  }
}

function datatypeBytes(datatype: number, bitpix: number): number {
  return (DATATYPE_MAP[datatype] ?? { bytes: Math.max(1, bitpix / 8) }).bytes;
}

function parseNifti1(buf: Uint8Array, view: DataView, le: boolean, opts: ParseNiiHeaderOptions): NiiHeader {
  const dim = new Int16Array(8);
  for (let i = 0; i < 8; i++) dim[i] = view.getInt16(40 + i * 2, le);

  const ndim = dim[0];
  const nx = Math.max(1, dim[1]);
  const ny = Math.max(1, dim[2]);
  const nz = Math.max(1, dim[3]);
  const nt = Math.max(1, ndim >= 4 ? dim[4] : 1);
  const nu = Math.max(1, ndim >= 5 ? dim[5] : 1);

  const datatype = view.getInt16(70, le);
  const bitpix = view.getInt16(72, le);

  const pixdim = new Float32Array(8);
  for (let i = 0; i < 8; i++) pixdim[i] = view.getFloat32(76 + i * 4, le);

  const rawVoxOffset = view.getFloat32(108, le);
  const scl_slope = view.getFloat32(112, le);
  const scl_inter = view.getFloat32(116, le);

  const qform_code = view.getInt16(252, le);
  const sform_code = view.getInt16(254, le);
  const quatern_b = view.getFloat32(256, le);
  const quatern_c = view.getFloat32(260, le);
  const quatern_d = view.getFloat32(264, le);
  const qoffset_x = view.getFloat32(268, le);
  const qoffset_y = view.getFloat32(272, le);
  const qoffset_z = view.getFloat32(276, le);

  const srow_x = [
    view.getFloat32(280, le),
    view.getFloat32(284, le),
    view.getFloat32(288, le),
    view.getFloat32(292, le),
  ];
  const srow_y = [
    view.getFloat32(296, le),
    view.getFloat32(300, le),
    view.getFloat32(304, le),
    view.getFloat32(308, le),
  ];
  const srow_z = [
    view.getFloat32(312, le),
    view.getFloat32(316, le),
    view.getFloat32(320, le),
    view.getFloat32(324, le),
  ];

  const xyzt_units = view.getUint8(123);
  const descrip = readDescrip(buf);
  const bytesPerVoxel = datatypeBytes(datatype, bitpix);
  const totalVoxels3D = nx * ny * nz;
  const sliceSizeXY = nx * ny;

  const orientation = sform_code !== 0 ? detectOrientation(srow_x, srow_y, srow_z) : 'RAS';

  return {
    version: 1,
    ndim,
    nx,
    ny,
    nz,
    nt,
    nu,
    dx: Math.abs(pixdim[1]) || 1,
    dy: Math.abs(pixdim[2]) || 1,
    dz: Math.abs(pixdim[3]) || 1,
    dt: Math.abs(pixdim[4]) || 0,
    datatype,
    bitpix,
    voxOffset: opts.separateImg ? 0 : Math.max(352, rawVoxOffset),
    scl_slope: scl_slope || 1,
    scl_inter: scl_inter || 0,
    littleEndian: le,
    isGzip: opts.isGzip ?? false,
    bytesPerVoxel,
    totalVoxels3D,
    sliceSizeXY,
    volumeBytes: totalVoxels3D * bytesPerVoxel,
    qform_code,
    sform_code,
    quatern_b,
    quatern_c,
    quatern_d,
    qoffset_x,
    qoffset_y,
    qoffset_z,
    srow_x,
    srow_y,
    srow_z,
    descrip,
    xyzt_units,
    orientation,
  };
}

function parseNifti2(view: DataView, le: boolean, opts: ParseNiiHeaderOptions): NiiHeader {
  const readInt64 = (offset: number): number => {
    const lo = view.getUint32(offset, le);
    const hi = view.getInt32(offset + 4, le);
    return hi * 0x100000000 + lo;
  };

  const ndim = view.getInt8(16);
  const nx = readInt64(24);
  const ny = readInt64(32);
  const nz = readInt64(40);
  const nt = Math.max(1, ndim >= 4 ? readInt64(48) : 1);
  const nu = Math.max(1, ndim >= 5 ? readInt64(56) : 1);

  const datatype = view.getInt16(12, le);
  const bitpix = view.getInt16(14, le);

  const dx = view.getFloat64(104, le);
  const dy = view.getFloat64(112, le);
  const dz = view.getFloat64(120, le);
  const dt = view.getFloat64(128, le);

  const rawVoxOffset = readInt64(168);
  const scl_slope = view.getFloat64(176, le);
  const scl_inter = view.getFloat64(184, le);

  const qform_code = view.getInt16(196, le);
  const sform_code = view.getInt16(198, le);
  const quatern_b = view.getFloat32(200, le);
  const quatern_c = view.getFloat32(204, le);
  const quatern_d = view.getFloat32(208, le);
  const qoffset_x = view.getFloat32(212, le);
  const qoffset_y = view.getFloat32(216, le);
  const qoffset_z = view.getFloat32(220, le);

  const srow_x = [
    view.getFloat64(224, le),
    view.getFloat64(232, le),
    view.getFloat64(240, le),
    view.getFloat64(248, le),
  ];
  const srow_y = [
    view.getFloat64(256, le),
    view.getFloat64(264, le),
    view.getFloat64(272, le),
    view.getFloat64(280, le),
  ];
  const srow_z = [
    view.getFloat64(288, le),
    view.getFloat64(296, le),
    view.getFloat64(304, le),
    view.getFloat64(312, le),
  ];

  const xyzt_units = view.getInt32(496, le);
  const bytesPerVoxel = datatypeBytes(datatype, bitpix);
  const totalVoxels3D = nx * ny * nz;
  const sliceSizeXY = nx * ny;

  const orientation = sform_code !== 0 ? detectOrientation(srow_x, srow_y, srow_z) : 'RAS';

  return {
    version: 2,
    ndim,
    nx,
    ny,
    nz,
    nt,
    nu,
    dx: Math.abs(dx) || 1,
    dy: Math.abs(dy) || 1,
    dz: Math.abs(dz) || 1,
    dt: Math.abs(dt) || 0,
    datatype,
    bitpix,
    voxOffset: opts.separateImg ? 0 : Math.max(544, rawVoxOffset),
    scl_slope: scl_slope || 1,
    scl_inter: scl_inter || 0,
    littleEndian: le,
    isGzip: opts.isGzip ?? false,
    bytesPerVoxel,
    totalVoxels3D,
    sliceSizeXY,
    volumeBytes: totalVoxels3D * bytesPerVoxel,
    qform_code,
    sform_code,
    quatern_b,
    quatern_c,
    quatern_d,
    qoffset_x,
    qoffset_y,
    qoffset_z,
    srow_x,
    srow_y,
    srow_z,
    descrip: '',
    xyzt_units,
    orientation,
  };
}

/** Shared lenient/strict parser. Returns null only when `strict` is false. */
export function parseNiiHeaderBytes(buf: Uint8Array, opts: ParseNiiHeaderOptions = {}): NiiHeader | null {
  if (buf.length < 348) {
    return invalid(opts, `Buffer too small for NIfTI header: ${buf.length} bytes`);
  }

  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const sizeofHdr_le = view.getInt32(0, true);
  const sizeofHdr_be = view.getInt32(0, false);

  if (sizeofHdr_le === 348) return parseNifti1(buf, view, true, opts);
  if (sizeofHdr_be === 348) return parseNifti1(buf, view, false, opts);
  if (sizeofHdr_le === 540) return parseNifti2(view, true, opts);
  if (sizeofHdr_be === 540) return parseNifti2(view, false, opts);

  return invalid(opts, `Invalid NIfTI file (sizeof_hdr = ${sizeofHdr_le})`);
}

/**
 * Host-side lenient parse. Keeps the historical ndim guard: files with an
 * implausible dimension count are treated as "not a NIfTI".
 */
export function parseNiiHeaderQuick(buf: Uint8Array, opts?: { separateImg?: boolean }): NiiHeader | null {
  const header = parseNiiHeaderBytes(buf, opts);
  if (!header || header.ndim < 1 || header.ndim > 7) return null;
  return header;
}

/** Webview-side strict parse; throws with the same messages as before. */
export function parseNiiHeader(buffer: ArrayBuffer, isGzip: boolean): NiiHeader {
  const header = parseNiiHeaderBytes(new Uint8Array(buffer), { isGzip, strict: true });
  /* istanbul ignore next — strict mode always throws instead of returning null */
  if (!header) throw new Error('Invalid NIfTI file');
  return header;
}

/** Byte offset of timepoint `t` relative to `voxOffset` (3D frame size × t). */
export function timepointByteOffset(header: NiiHeader, t = 0): number {
  const nt = Math.max(1, header.nt || 1);
  const tClamp = Math.max(0, Math.min(nt - 1, t | 0));
  if (tClamp === 0) return 0;
  const nx = header.nx || 1;
  const ny = header.ny || 1;
  const nz = header.nz || 1;
  const bpv = Math.max(1, header.bytesPerVoxel || (header.bitpix || 8) / 8);
  return tClamp * nx * ny * nz * bpv;
}

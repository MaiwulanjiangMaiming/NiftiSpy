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
  descrip: string;
  xyzt_units: number;
  // Orientation info computed from qform/sform
  orientation: 'RAS' | 'LAS' | 'LPS' | 'RPS' | 'RSA' | 'LSA' | 'LIA' | 'RIA' | 'AIR' | 'PIR' | 'RIP' | 'LIP' | 'unknown';
}

export type NiiDataType =
  | 'uint8' | 'int16' | 'int32' | 'float32'
  | 'float64' | 'int8' | 'uint16' | 'uint32' | 'int64' | 'uint64'
  | 'rgb24' | 'rgba32';

const DATATYPE_MAP: Record<number, { type: NiiDataType; bytes: number }> = {
  1:    { type: 'uint8',   bytes: 1 },
  2:    { type: 'uint8',   bytes: 1 },
  4:    { type: 'int16',   bytes: 2 },
  8:    { type: 'int32',   bytes: 4 },
  16:   { type: 'float32', bytes: 4 },
  64:   { type: 'float64', bytes: 8 },
  128:  { type: 'rgb24',   bytes: 3 },
  256:  { type: 'int8',    bytes: 1 },
  512:  { type: 'uint16',  bytes: 2 },
  768:  { type: 'uint32',  bytes: 4 },
  1024: { type: 'int64',   bytes: 8 },
  1280: { type: 'uint64',  bytes: 8 },
  4096: { type: 'rgba32',  bytes: 4 },
};

export const DATATYPE_NAMES: Record<number, string> = {
  1: 'binary', 2: 'uint8', 4: 'int16', 8: 'int32',
  16: 'float32', 64: 'float64', 128: 'RGB24',
  256: 'int8', 512: 'uint16', 768: 'uint32',
  1024: 'int64', 1280: 'uint64', 4096: 'RGBA32',
};

export function parseNiiHeader(buffer: ArrayBuffer, isGzip: boolean): NiiHeader {
  if (buffer.byteLength < 348) {
    throw new Error(`Buffer too small for NIfTI header: ${buffer.byteLength} bytes`);
  }

  const view = new DataView(buffer);

  const sizeofHdr_le = view.getInt32(0, true);
  const sizeofHdr_be = view.getInt32(0, false);

  let version: 1 | 2;
  let le: boolean;

  if (sizeofHdr_le === 348) {
    le = true;
    version = 1;
  } else if (sizeofHdr_be === 348) {
    le = false;
    version = 1;
  } else if (sizeofHdr_le === 540) {
    le = true;
    version = 2;
  } else if (sizeofHdr_be === 540) {
    le = false;
    version = 2;
  } else {
    throw new Error(`Invalid NIfTI file (sizeof_hdr = ${sizeofHdr_le})`);
  }

  if (version === 1) {
    return parseNifti1Header(view, le, isGzip);
  } else {
    return parseNifti2Header(view, le, isGzip);
  }
}

function detectOrientation(srow_x: number[], srow_y: number[], srow_z: number[]): NiiHeader['orientation'] {
  const dx0 = srow_x[0], dx1 = srow_x[1], dx2 = srow_x[2];
  const dy0 = srow_y[0], dy1 = srow_y[1], dy2 = srow_y[2];
  const dz0 = srow_z[0], dz1 = srow_z[1], dz2 = srow_z[2];

  const domX = Math.abs(dx0) >= Math.abs(dx1) && Math.abs(dx0) >= Math.abs(dx2) ? 0 :
               Math.abs(dx1) >= Math.abs(dx0) && Math.abs(dx1) >= Math.abs(dx2) ? 1 : 2;
  const domY = Math.abs(dy0) >= Math.abs(dy1) && Math.abs(dy0) >= Math.abs(dy2) ? 0 :
               Math.abs(dy1) >= Math.abs(dy0) && Math.abs(dy1) >= Math.abs(dy2) ? 1 : 2;
  const domZ = Math.abs(dz0) >= Math.abs(dz1) && Math.abs(dz0) >= Math.abs(dz2) ? 0 :
               Math.abs(dz1) >= Math.abs(dz0) && Math.abs(dz1) >= Math.abs(dz2) ? 1 : 2;

  const signX = [dx0, dx1, dx2][domX] >= 0 ? '+' : '-';
  const signY = [dy0, dy1, dy2][domY] >= 0 ? '+' : '-';
  const signZ = [dz0, dz1, dz2][domZ] >= 0 ? '+' : '-';

  const dirMap: Record<string, string> = {
    '0+': 'R', '0-': 'L',
    '1+': 'A', '1-': 'P',
    '2+': 'S', '2-': 'I'
  };

  const code = (dirMap[domX + signX] || 'R') + (dirMap[domY + signY] || 'A') + (dirMap[domZ + signZ] || 'S');

  const knownOrientations: NiiHeader['orientation'][] = ['RAS', 'LAS', 'LPS', 'RPS', 'RSA', 'LSA', 'LIA', 'RIA', 'AIR', 'PIR', 'RIP', 'LIP'];
  if (knownOrientations.includes(code as NiiHeader['orientation'])) {
    return code as NiiHeader['orientation'];
  }

  return 'unknown';
}

function parseNifti1Header(view: DataView, le: boolean, isGzip: boolean): NiiHeader {
  const dim = new Int16Array(8);
  for (let i = 0; i < 8; i++) {
    dim[i] = view.getInt16(40 + i * 2, le);
  }

  const ndim = dim[0];
  const nx = Math.max(1, dim[1]);
  const ny = Math.max(1, dim[2]);
  const nz = Math.max(1, dim[3]);
  const nt = Math.max(1, ndim >= 4 ? dim[4] : 1);
  const nu = Math.max(1, ndim >= 5 ? dim[5] : 1);

  const datatype = view.getInt16(70, le);
  const bitpix = view.getInt16(72, le);

  const pixdim = new Float32Array(8);
  for (let i = 0; i < 8; i++) {
    pixdim[i] = view.getFloat32(76 + i * 4, le);
  }

  const voxOffset = view.getFloat32(108, le);
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

  const srow_x = [view.getFloat32(280, le), view.getFloat32(284, le), view.getFloat32(288, le), view.getFloat32(292, le)];
  const srow_y = [view.getFloat32(296, le), view.getFloat32(300, le), view.getFloat32(304, le), view.getFloat32(308, le)];
  const srow_z = [view.getFloat32(312, le), view.getFloat32(316, le), view.getFloat32(320, le), view.getFloat32(324, le)];

  const xyzt_units = view.getUint8(123);

  let descrip = '';
  try {
    const descripBytes = new Uint8Array(view.buffer, 148, 80);
    let end = descripBytes.indexOf(0);
    if (end === -1) end = 80;
    descrip = new TextDecoder().decode(descripBytes.slice(0, end));
  } catch { /* ignore */ }

  const info = DATATYPE_MAP[datatype] ?? { type: 'uint8' as NiiDataType, bytes: Math.max(1, bitpix / 8) };
  const bytesPerVoxel = info.bytes;
  const totalVoxels3D = nx * ny * nz;
  const sliceSizeXY = nx * ny;
  const volumeBytes = totalVoxels3D * bytesPerVoxel;

  // Determine orientation from sform or qform
  let orientation: NiiHeader['orientation'] = 'RAS';
  if (sform_code !== 0) {
    orientation = detectOrientation(srow_x, srow_y, srow_z);
  } else if (qform_code !== 0) {
    // For qform, we would need to compute from quaternion
    // Default to RAS as NIfTI standard when qform is used without explicit orientation
    orientation = 'RAS';
  }

  return {
    version: 1,
    ndim, nx, ny, nz, nt, nu,
    dx: Math.abs(pixdim[1]) || 1,
    dy: Math.abs(pixdim[2]) || 1,
    dz: Math.abs(pixdim[3]) || 1,
    dt: pixdim[4] || 0,
    datatype, bitpix,
    voxOffset: Math.max(352, voxOffset),
    scl_slope: scl_slope || 1,
    scl_inter: scl_inter || 0,
    littleEndian: le,
    isGzip,
    bytesPerVoxel,
    totalVoxels3D,
    sliceSizeXY,
    volumeBytes,
    qform_code, sform_code,
    quatern_b, quatern_c, quatern_d,
    qoffset_x, qoffset_y, qoffset_z,
    srow_x, srow_y, srow_z,
    descrip,
    xyzt_units,
    orientation,
  };
}

function parseNifti2Header(view: DataView, le: boolean, isGzip: boolean): NiiHeader {
  const readInt64 = (offset: number): number => {
    const lo = view.getUint32(offset, le);
    const hi = view.getInt32(offset + 4, le);
    return hi * 0x100000000 + lo;
  };

  const ndim = view.getInt8(16);
  const nx = readInt64(24);
  const ny = readInt64(32);
  const nz = readInt64(40);
  const nt = ndim >= 4 ? readInt64(48) : 1;
  const nu = ndim >= 5 ? readInt64(56) : 1;

  const datatype = view.getInt16(12, le);
  const bitpix = view.getInt16(14, le);

  const dx = view.getFloat64(104, le);
  const dy = view.getFloat64(112, le);
  const dz = view.getFloat64(120, le);
  const dt = view.getFloat64(128, le);

  const voxOffset = readInt64(168);
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

  const srow_x = [view.getFloat64(224, le), view.getFloat64(232, le), view.getFloat64(240, le), view.getFloat64(248, le)];
  const srow_y = [view.getFloat64(256, le), view.getFloat64(264, le), view.getFloat64(272, le), view.getFloat64(280, le)];
  const srow_z = [view.getFloat64(288, le), view.getFloat64(296, le), view.getFloat64(304, le), view.getFloat64(312, le)];

  const xyzt_units = view.getInt32(496, le);

  const info = DATATYPE_MAP[datatype] ?? { type: 'uint8' as NiiDataType, bytes: Math.max(1, bitpix / 8) };
  const bytesPerVoxel = info.bytes;
  const totalVoxels3D = nx * ny * nz;
  const sliceSizeXY = nx * ny;
  const volumeBytes = totalVoxels3D * bytesPerVoxel;

  // Determine orientation from sform or qform
  let orientation: NiiHeader['orientation'] = 'RAS';
  if (sform_code !== 0) {
    orientation = detectOrientation(srow_x, srow_y, srow_z);
  } else if (qform_code !== 0) {
    orientation = 'RAS';
  }

  return {
    version: 2,
    ndim, nx, ny, nz, nt, nu,
    dx: Math.abs(dx) || 1,
    dy: Math.abs(dy) || 1,
    dz: Math.abs(dz) || 1,
    dt: dt || 0,
    datatype, bitpix,
    voxOffset: Math.max(544, voxOffset),
    scl_slope: scl_slope || 1,
    scl_inter: scl_inter || 0,
    littleEndian: le,
    isGzip,
    bytesPerVoxel,
    totalVoxels3D,
    sliceSizeXY,
    volumeBytes,
    qform_code, sform_code,
    quatern_b, quatern_c, quatern_d,
    qoffset_x, qoffset_y, qoffset_z,
    srow_x, srow_y, srow_z,
    descrip: '',
    xyzt_units,
    orientation,
  };
}

export function getSliceByteRange(
  header: NiiHeader,
  axis: 'axial' | 'coronal' | 'sagittal',
  sliceIndex: number
): { start: number; end: number } | null {
  const { nx, ny, nz, bytesPerVoxel, voxOffset } = header;

  if (axis === 'axial') {
    const start = voxOffset + sliceIndex * nx * ny * bytesPerVoxel;
    const end = start + nx * ny * bytesPerVoxel;
    return { start, end: end - 1 };
  }

  return null;
}

export function getVolumeByteRange(header: NiiHeader, volumeIndex?: number): { start: number; end: number } {
  const { nx, ny, nz, nt, bytesPerVoxel, voxOffset } = header;
  const volIdx = volumeIndex ?? 0;
  const volumeSize = nx * ny * nz * bytesPerVoxel;
  const start = voxOffset + volIdx * volumeSize;
  return { start, end: start + volumeSize - 1 };
}

export function parseNiiHeaderQuick(buf: Uint8Array): any | null {
  if (buf.length < 348) return null;
  const v = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const le = v.getInt32(0, true) === 348 || v.getInt32(0, true) === 540;
  if (!le && v.getInt32(0, false) !== 348 && v.getInt32(0, false) !== 540) return null;
  const sizeofHdr = v.getInt32(0, le);
  const version = sizeofHdr === 540 ? 2 : 1;
  const ndim = version === 1 ? v.getInt16(40, le) : v.getInt8(16);
  if (ndim < 1 || ndim > 7) return null;
  let nx: number, ny: number, nz: number, dx: number, dy: number, dz: number;
  let datatype: number, bitpix: number, voxOffset: number;
  let scl_slope: number, scl_inter: number;
  let qform_code: number, sform_code: number;
  let quatern_b: number, quatern_c: number, quatern_d: number;
  let qoffset_x: number, qoffset_y: number, qoffset_z: number;
  let srow_x: number[], srow_y: number[], srow_z: number[];

  if (version === 1) {
    nx = Math.max(1, v.getInt16(42, le));
    ny = Math.max(1, v.getInt16(44, le));
    nz = Math.max(1, v.getInt16(46, le));
    datatype = v.getInt16(70, le);
    bitpix = v.getInt16(72, le);
    dx = Math.abs(v.getFloat32(76 + 4, le)) || 1;
    dy = Math.abs(v.getFloat32(76 + 8, le)) || 1;
    dz = Math.abs(v.getFloat32(76 + 12, le)) || 1;
    voxOffset = v.getFloat32(108, le);
    scl_slope = v.getFloat32(112, le);
    scl_inter = v.getFloat32(116, le);
    qform_code = v.getInt16(252, le);
    sform_code = v.getInt16(254, le);
    quatern_b = v.getFloat32(256, le);
    quatern_c = v.getFloat32(260, le);
    quatern_d = v.getFloat32(264, le);
    qoffset_x = v.getFloat32(268, le);
    qoffset_y = v.getFloat32(272, le);
    qoffset_z = v.getFloat32(276, le);
    srow_x = [v.getFloat32(280, le), v.getFloat32(284, le), v.getFloat32(288, le), v.getFloat32(292, le)];
    srow_y = [v.getFloat32(296, le), v.getFloat32(300, le), v.getFloat32(304, le), v.getFloat32(308, le)];
    srow_z = [v.getFloat32(312, le), v.getFloat32(316, le), v.getFloat32(320, le), v.getFloat32(324, le)];
    voxOffset = Math.max(352, voxOffset);
  } else {
    nx = Number(v.getBigInt64(24, le));
    ny = Number(v.getBigInt64(32, le));
    nz = Number(v.getBigInt64(40, le));
    datatype = v.getInt16(12, le);
    bitpix = v.getInt16(14, le);
    dx = Math.abs(v.getFloat64(104, le)) || 1;
    dy = Math.abs(v.getFloat64(112, le)) || 1;
    dz = Math.abs(v.getFloat64(120, le)) || 1;
    voxOffset = Number(v.getBigInt64(168, le));
    scl_slope = v.getFloat64(176, le);
    scl_inter = v.getFloat64(184, le);
    qform_code = v.getInt16(196, le);
    sform_code = v.getInt16(198, le);
    quatern_b = v.getFloat32(200, le);
    quatern_c = v.getFloat32(204, le);
    quatern_d = v.getFloat32(208, le);
    qoffset_x = v.getFloat32(212, le);
    qoffset_y = v.getFloat32(216, le);
    qoffset_z = v.getFloat32(220, le);
    srow_x = [v.getFloat64(224, le), v.getFloat64(232, le), v.getFloat64(240, le), v.getFloat64(248, le)];
    srow_y = [v.getFloat64(256, le), v.getFloat64(264, le), v.getFloat64(272, le), v.getFloat64(280, le)];
    srow_z = [v.getFloat64(288, le), v.getFloat64(296, le), v.getFloat64(304, le), v.getFloat64(312, le)];
    voxOffset = Math.max(544, voxOffset);
  }

  return {
    version, ndim, nx, ny, nz, dx, dy, dz, datatype, bitpix, voxOffset,
    scl_slope: scl_slope || 1, scl_inter: scl_inter || 0,
    littleEndian: le, qform_code, sform_code,
    quatern_b, quatern_c, quatern_d,
    qoffset_x, qoffset_y, qoffset_z,
    srow_x, srow_y, srow_z,
    nt: 1, nu: 1, dt: 0, isGzip: false,
    bytesPerVoxel: Math.max(1, bitpix / 8),
    totalVoxels3D: nx * ny * nz,
    sliceSizeXY: nx * ny,
    volumeBytes: nx * ny * nz * Math.max(1, bitpix / 8),
    descrip: '', xyzt_units: 0, orientation: 'unknown',
  };
}

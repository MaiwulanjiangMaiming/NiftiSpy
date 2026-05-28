export function computeSliceMinMax(...slices: Float32Array[]): { min: number; max: number } {
  let min = Infinity;
  let max = -Infinity;

  for (const slice of slices) {
    for (let i = 0; i < slice.length; i++) {
      const value = slice[i];
      if (value < min) min = value;
      if (value > max) max = value;
    }
  }

  if (min === max) {
    max = min + 1;
  }

  return { min, max };
}

export function encodePreviewBinary(header: any, slices: { axial: Float32Array; coronal: Float32Array; sagittal: Float32Array }, min: number, max: number): Buffer {
  const sliceIdxVal = {
    axial: Math.floor(header.nz / 2),
    coronal: Math.floor(header.ny / 2),
    sagittal: Math.floor(header.nx / 2),
  };

  const headerJson = JSON.stringify(header);
  const headerBuf = Buffer.from(headerJson, 'utf8');
  const axialBuf = Buffer.from(slices.axial.buffer, slices.axial.byteOffset, slices.axial.byteLength);
  const coronalBuf = Buffer.from(slices.coronal.buffer, slices.coronal.byteOffset, slices.coronal.byteLength);
  const sagittalBuf = Buffer.from(slices.sagittal.buffer, slices.sagittal.byteOffset, slices.sagittal.byteLength);

  const totalLen = 4 + headerBuf.length + 4 * 7 + axialBuf.length + 4 + coronalBuf.length + 4 + sagittalBuf.length;
  const buf = Buffer.alloc(totalLen);
  let offset = 0;

  buf.writeUInt32LE(headerBuf.length, offset); offset += 4;
  headerBuf.copy(buf, offset); offset += headerBuf.length;

  buf.writeFloatLE(min, offset); offset += 4;
  buf.writeFloatLE(max, offset); offset += 4;
  buf.writeUInt32LE(sliceIdxVal.axial, offset); offset += 4;
  buf.writeUInt32LE(sliceIdxVal.coronal, offset); offset += 4;
  buf.writeUInt32LE(sliceIdxVal.sagittal, offset); offset += 4;

  buf.writeUInt32LE(axialBuf.length, offset); offset += 4;
  axialBuf.copy(buf, offset); offset += axialBuf.length;

  buf.writeUInt32LE(coronalBuf.length, offset); offset += 4;
  coronalBuf.copy(buf, offset); offset += coronalBuf.length;

  buf.writeUInt32LE(sagittalBuf.length, offset); offset += 4;
  sagittalBuf.copy(buf, offset); offset += sagittalBuf.length;

  return buf;
}

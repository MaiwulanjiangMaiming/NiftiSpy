const test = require('node:test');
const assert = require('node:assert/strict');

function encodePreviewBinary(header, slices, globalMin, globalMax, sliceIdx) {
  const headerBuf = Buffer.from(JSON.stringify(header), 'utf8');
  const axialBuf = Buffer.from(slices.axial.buffer);
  const coronalBuf = Buffer.from(slices.coronal.buffer);
  const sagittalBuf = Buffer.from(slices.sagittal.buffer);
  const totalLen = 4 + headerBuf.length + 4 * 5 + 4 + axialBuf.length + 4 + coronalBuf.length + 4 + sagittalBuf.length;
  const buf = Buffer.alloc(totalLen);
  let offset = 0;
  buf.writeUInt32LE(headerBuf.length, offset); offset += 4;
  headerBuf.copy(buf, offset); offset += headerBuf.length;
  buf.writeFloatLE(globalMin, offset); offset += 4;
  buf.writeFloatLE(globalMax, offset); offset += 4;
  buf.writeUInt32LE(sliceIdx.axial, offset); offset += 4;
  buf.writeUInt32LE(sliceIdx.coronal, offset); offset += 4;
  buf.writeUInt32LE(sliceIdx.sagittal, offset); offset += 4;
  buf.writeUInt32LE(axialBuf.length, offset); offset += 4;
  axialBuf.copy(buf, offset); offset += axialBuf.length;
  buf.writeUInt32LE(coronalBuf.length, offset); offset += 4;
  coronalBuf.copy(buf, offset); offset += coronalBuf.length;
  buf.writeUInt32LE(sagittalBuf.length, offset); offset += 4;
  sagittalBuf.copy(buf, offset);
  return buf;
}

test('preview binary payload round-trips basic metadata', () => {
  const header = { nx: 4, ny: 3, nz: 2, scl_slope: 1, scl_inter: 0 };
  const slices = {
    axial: new Float32Array([1, 2, 3, 4]),
    coronal: new Float32Array([5, 6, 7, 8]),
    sagittal: new Float32Array([9, 10, 11, 12]),
  };
  const encoded = encodePreviewBinary(header, slices, 1, 12, { axial: 1, coronal: 1, sagittal: 2 });
  assert.ok(encoded.byteLength > 0);
  assert.equal(encoded.readUInt32LE(0), Buffer.from(JSON.stringify(header), 'utf8').length);
});


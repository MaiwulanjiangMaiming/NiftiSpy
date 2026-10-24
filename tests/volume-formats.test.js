const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');
const esbuild = require('esbuild');

let registry;
let ready;

async function load() {
  if (ready) return ready;
  ready = (async () => {
    const outfile = path.join(__dirname, '..', 'dist', 'volumeFormats.node.cjs');
    await esbuild.build({
      entryPoints: [path.join(__dirname, '..', 'src/formats/registry.ts')],
      bundle: true,
      platform: 'node',
      format: 'cjs',
      outfile,
    });
    registry = require(outfile);
  })();
  return ready;
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'niftispy-test-'));
function tmp(name) {
  return path.join(dir, name);
}

// ── voxel helpers ───────────────────────────────────────────────────
/** 3×2×2 float32 values in x-fastest order. */
const VALUES = Array.from({ length: 12 }, (_, i) => i + 0.5);

function floatsLE(values) {
  const b = Buffer.alloc(values.length * 4);
  values.forEach((v, i) => b.writeFloatLE(v, i * 4));
  return b;
}

function floatsBE(values) {
  const b = Buffer.alloc(values.length * 4);
  values.forEach((v, i) => b.writeFloatBE(v, i * 4));
  return b;
}

function readVoxels(parsed, Type, count) {
  const raw = parsed.rawData
    ? parsed.rawData
    : fs.readFileSync(parsed.dataPath);
  const off = raw.byteOffset + parsed.header.voxOffset;
  if (off % Type.BYTES_PER_ELEMENT !== 0) {
    const copy = Buffer.from(raw.subarray(parsed.header.voxOffset, parsed.header.voxOffset + count * Type.BYTES_PER_ELEMENT));
    return new Type(copy.buffer, copy.byteOffset, count);
  }
  return new Type(raw.buffer, off, count);
}

function assertVolume(parsed, { datatype = 16, offset } = {}) {
  const h = parsed.header;
  assert.equal(h.nx, 3);
  assert.equal(h.ny, 2);
  assert.equal(h.nz, 2);
  assert.equal(h.datatype, datatype);
  if (offset !== undefined) assert.equal(h.voxOffset, offset);
  const values = readVoxels(parsed, Float32Array, 12);
  assert.deepEqual(Array.from(values), VALUES);
}

// ── synthetic .npy ──────────────────────────────────────────────────
function npyFile({ descr = '<f4', fortran = false, shape, values }) {
  const dict = `{'descr': '${descr}', 'fortran_order': ${fortran ? 'True' : 'False'}, 'shape': (${shape.join(', ')}, ), }`;
  const raw = Buffer.from(dict, 'ascii');
  const padding = (64 - ((10 + raw.length + 1) % 64)) % 64;
  const header = Buffer.concat([raw, Buffer.alloc(padding, 0x20), Buffer.from('\n')]);
  const out = Buffer.alloc(10 + header.length + values.length);
  out.set([0x93, 0x4e, 0x55, 0x4d, 0x50, 0x59, 1, 0], 0);
  out.writeUInt16LE(header.length, 8);
  header.copy(out, 10);
  values.copy(out, 10 + header.length);
  return out;
}

// ── minimal ZIP writer for .npz ─────────────────────────────────────
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function zipFile(name, data, { deflate = true } = {}) {
  const stored = deflate ? zlib.deflateRawSync(data) : data;
  const method = deflate ? 8 : 0;
  const nameBuf = Buffer.from(name, 'latin1');
  const crc = crc32(data);

  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4);
  local.writeUInt16LE(0x800, 6);
  local.writeUInt16LE(method, 8);
  local.writeUInt32LE(crc, 14);
  local.writeUInt32LE(stored.length, 18);
  local.writeUInt32LE(data.length, 22);
  local.writeUInt16LE(nameBuf.length, 26);

  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(20, 4);
  central.writeUInt16LE(20, 6);
  central.writeUInt16LE(0x800, 8);
  central.writeUInt16LE(method, 10);
  central.writeUInt32LE(crc, 16);
  central.writeUInt32LE(stored.length, 20);
  central.writeUInt32LE(data.length, 24);
  central.writeUInt16LE(nameBuf.length, 28);
  central.writeUInt32LE(0, 42);

  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(1, 8);
  eocd.writeUInt16LE(1, 10);
  eocd.writeUInt32LE(46 + nameBuf.length, 12);
  eocd.writeUInt32LE(30 + nameBuf.length + stored.length, 16);
  eocd.writeUInt16LE(0, 20);

  return Buffer.concat([local, nameBuf, stored, central, nameBuf, eocd]);
}

test('npy: memory parse maps C-order axes and keeps an absolute offset', async () => {
  await load();
  const file = tmp('vol.npy');
  fs.writeFileSync(file, npyFile({ shape: [2, 2, 3], values: floatsLE(VALUES) }));

  const { parsed } = await registry.parseVolumeFile(file, { memory: true });
  assertVolume(parsed);
  assert.ok(!parsed.dataPath);
});

test('payload: 4D int16 keeps every frame and compacts unaligned data', async () => {
  await load();
  const header = {
    nx: 2, ny: 2, nz: 2, nt: 2,
    datatype: 4, bytesPerVoxel: 2, voxOffset: 3, volumeBytes: 0,
  };
  const raw = new Uint8Array(3 + 16 * 2);
  const source = new DataView(raw.buffer);
  for (let i = 0; i < 16; i++) source.setInt16(3 + i * 2, i + 1, true);

  const prepared = registry.prepareParsedPayload(header, raw);
  assert.equal(prepared.totalVoxels, 16);
  assert.equal(prepared.voxelBytes, 32);
  assert.equal(header.voxOffset, 0);
  assert.equal(header.volumeBytes, 32);

  const view = new DataView(prepared.payload.buffer, prepared.payload.byteOffset, prepared.payload.byteLength);
  assert.equal(view.getInt16(0, true), 1);
  assert.equal(view.getInt16(15 * 2, true), 16);
});

test('payload: Float64 4D is downcast across all timepoints', async () => {
  await load();
  const raw = new Float64Array([1.5, 9.5]);
  const header = {
    nx: 1, ny: 1, nz: 1, nt: 2,
    datatype: 64, bytesPerVoxel: 8, voxOffset: 0, volumeBytes: 0,
  };
  const prepared = registry.prepareParsedPayload(header, new Uint8Array(raw.buffer));
  assert.equal(prepared.totalVoxels, 2);
  assert.equal(prepared.voxelBytes, 8);
  assert.equal(header.datatype, 16);
  assert.equal(header.volumeBytes, 8);
  assert.equal(prepared.min, 1.5);
  assert.equal(prepared.max, 9.5);
  assert.deepEqual(
    Array.from(new Float32Array(prepared.payload.buffer, prepared.payload.byteOffset, 2)),
    [1.5, 9.5],
  );
});

test('npy: 4D array keeps nt and all timepoints', async () => {
  await load();
  const file = tmp('vol4d.npy');
  const values = Array.from({ length: 16 }, (_, i) => i + 0.5);
  fs.writeFileSync(file, npyFile({ shape: [2, 2, 2, 2], values: floatsLE(values) }));

  const { parsed } = await registry.parseVolumeFile(file, { memory: true });
  assert.equal(parsed.header.nt, 2);
  const prepared = registry.prepareParsedPayload(parsed.header, parsed.rawData);
  assert.equal(prepared.totalVoxels, 16);
  assert.equal(prepared.voxelBytes, 64);
  assert.equal(parsed.header.volumeBytes, 64);
  assert.deepEqual(
    Array.from(new Float32Array(
      prepared.payload.buffer,
      prepared.payload.byteOffset + parsed.header.voxOffset,
      16,
    )),
    values,
  );
});

test('npy: stream parse keeps the file as the data source', async () => {
  await load();
  const file = tmp('stream.npy');
  fs.writeFileSync(file, npyFile({ shape: [2, 2, 3], values: floatsLE(VALUES) }));

  const { parsed } = await registry.parseVolumeFile(file, { memory: false });
  assert.equal(parsed.dataPath, file);
  assert.equal(parsed.header.voxOffset > 0, true);
  assertVolume(parsed, { offset: parsed.header.voxOffset });
});

test('npz: reads a deflated member and supports slice materialization', async () => {
  await load();
  const file = tmp('vol.npz');
  const member = npyFile({ shape: [2, 2, 3], values: floatsLE(VALUES) });
  fs.writeFileSync(file, zipFile('vol.npy', member));

  const { parsed } = await registry.parseVolumeFile(file, { memory: true });
  assertVolume(parsed);

  const streamed = await registry.parseVolumeFile(file, { memory: false });
  assert.equal(streamed.parsed.header.voxOffset, 0);
  assertVolume(streamed.parsed, { offset: 0 });
  fs.rmSync(streamed.parsed.tempFiles[0], { force: true });
});

test('nrrd: raw attached header', async () => {
  await load();
  const file = tmp('vol.nrrd');
  const header = [
    'NRRD0004',
    'type: float',
    'dimension: 3',
    'sizes: 3 2 2',
    'encoding: raw',
    'endian: little',
    'spacings: 1 1 1',
    '',
    '',
  ].join('\n');
  fs.writeFileSync(file, Buffer.concat([Buffer.from(header, 'latin1'), floatsLE(VALUES)]));

  const { parsed } = await registry.parseVolumeFile(file, { memory: true });
  assertVolume(parsed);
  assert.equal(parsed.header.voxOffset, header.length);

  const streamed = await registry.parseVolumeFile(file, { memory: false });
  assert.equal(streamed.parsed.dataPath, file);
  assertVolume(streamed.parsed, { offset: header.length });
});

test('nrrd: space directions and origin produce an sform', async () => {
  await load();
  const file = tmp('oriented.nrrd');
  const header = [
    'NRRD0004',
    'type: float',
    'dimension: 3',
    'sizes: 3 2 2',
    'encoding: raw',
    'endian: little',
    'space: right-anterior-superior',
    'space directions: (0.7,0,0) (0,0.7,0) (0,0,0.7)',
    'space origin: (1,2,3)',
    '',
    '',
  ].join('\n');
  fs.writeFileSync(file, Buffer.concat([Buffer.from(header, 'latin1'), floatsLE(VALUES)]));

  const { parsed } = await registry.parseVolumeFile(file, { memory: true });
  assert.equal(parsed.header.sform_code, 1);
  assert.deepEqual(parsed.header.srow_x, [0.7, 0, 0, 1]);
  assert.deepEqual(parsed.header.srow_y, [0, 0.7, 0, 2]);
  assert.deepEqual(parsed.header.srow_z, [0, 0, 0.7, 3]);
  assert.equal(parsed.header.dx, 0.7);
});

test('nrrd: gzip encoding and detached .nhdr data', async () => {
  await load();
  const data = floatsLE(VALUES);

  const gz = tmp('gzip.nrrd');
  const gzHeader = 'NRRD0004\ntype: float\ndimension: 3\nsizes: 3 2 2\nencoding: gzip\nendian: little\n\n';
  fs.writeFileSync(gz, Buffer.concat([Buffer.from(gzHeader, 'latin1'), zlib.gzipSync(data)]));
  const gzParsed = (await registry.parseVolumeFile(gz, { memory: true })).parsed;
  assertVolume(gzParsed, { offset: 0 });

  const raw = tmp('det.raw');
  fs.writeFileSync(raw, data);
  const nhdr = tmp('det.nhdr');
  fs.writeFileSync(nhdr, 'NRRD0004\ntype: float\ndimension: 3\nsizes: 3 2 2\nencoding: raw\nendian: little\ndata file: det.raw\n\n');
  const det = (await registry.parseVolumeFile(nhdr, { memory: false })).parsed;
  assert.equal(det.dataPath, raw);
  assertVolume(det, { offset: 0 });
});

test('nrrd: attached ascii data skips the text header', async () => {
  await load();
  const file = tmp('ascii.nrrd');
  const header = 'NRRD0004\ntype: float\ndimension: 3\nsizes: 3 2 2\nencoding: ascii\nendian: little\n\n';
  fs.writeFileSync(file, Buffer.from(header + VALUES.join(' ') + '\n', 'latin1'));

  const { parsed } = await registry.parseVolumeFile(file, { memory: true });
  assertVolume(parsed);
});

test('mha / mhd: MetaImage attached and detached layouts', async () => {
  await load();
  const data = floatsLE(VALUES);
  const text = [
    'ObjectType = Image',
    'NDims = 3',
    'DimSize = 3 2 2',
    'ElementType = MET_FLOAT',
    'ElementSpacing = 1 1 1',
    'ElementDataFile = LOCAL',
    '',
  ].join('\n');

  const mha = tmp('vol.mha');
  fs.writeFileSync(mha, Buffer.concat([Buffer.from(text, 'latin1'), data]));
  assertVolume((await registry.parseVolumeFile(mha, { memory: true })).parsed);

  const mhd = tmp('vol.mhd');
  const mhdData = tmp('vol.raw');
  fs.writeFileSync(mhdData, data);
  fs.writeFileSync(mhd, text.replace('ElementDataFile = LOCAL', 'ElementDataFile = vol.raw'));
  const detached = (await registry.parseVolumeFile(mhd, { memory: false })).parsed;
  assert.equal(detached.dataPath, mhdData);
  assertVolume(detached, { offset: 0 });
});

test('mha: TransformMatrix and Offset produce an RAS sform', async () => {
  await load();
  const file = tmp('oriented.mha');
  const text = [
    'ObjectType = Image',
    'NDims = 3',
    'DimSize = 3 2 2',
    'ElementType = MET_FLOAT',
    'ElementSpacing = 1 1 1',
    'TransformMatrix = 1 0 0 0 1 0 0 0 1',
    'Offset = 1 2 3',
    'ElementDataFile = LOCAL',
  ].join('\n') + '\n';
  fs.writeFileSync(file, Buffer.concat([Buffer.from(text, 'latin1'), floatsLE(VALUES)]));

  const { parsed } = await registry.parseVolumeFile(file, { memory: true });
  assert.equal(parsed.header.sform_code, 1);
  assert.deepEqual(parsed.header.srow_x, [-1, 0, 0, -1]);
  assert.deepEqual(parsed.header.srow_y, [0, -1, 0, -2]);
  assert.deepEqual(parsed.header.srow_z, [0, 0, 1, 3]);
});

test('mrc: int16 cryo-EM volume', async () => {
  await load();
  const file = tmp('vol.mrc');
  const head = Buffer.alloc(1024);
  head.writeInt32LE(3, 0);
  head.writeInt32LE(2, 4);
  head.writeInt32LE(2, 8);
  head.writeInt32LE(1, 12); // mode 1 → int16
  head.writeFloatLE(3, 40);
  head.writeFloatLE(2, 44);
  head.writeFloatLE(2, 48);
  const voxels = Buffer.alloc(VALUES.length * 2);
  VALUES.forEach((v, i) => voxels.writeInt16LE(Math.round(v), i * 2));
  fs.writeFileSync(file, Buffer.concat([head, voxels]));

  const { parsed } = await registry.parseVolumeFile(file, { memory: true });
  assert.equal(parsed.header.datatype, 4);
  assert.equal(parsed.header.voxOffset, 1024);
  assert.deepEqual(
    Array.from(readVoxels(parsed, Int16Array, 12)),
    VALUES.map(v => Math.round(v)),
  );
});

// ── synthetic DICOM ────────────────────────────────────────────────
function dicomElement(group, elem, vr, value, { explicit = true, le = true } = {}) {
  const long = ['OB', 'OW', 'OF', 'SQ', 'UT', 'UN'].includes(vr);
  const hdr = Buffer.alloc(explicit ? (long ? 12 : 8) : 8);
  if (le) hdr.writeUInt16LE(group, 0); else hdr.writeUInt16BE(group, 0);
  if (le) hdr.writeUInt16LE(elem, 2); else hdr.writeUInt16BE(elem, 2);
  if (explicit) {
    hdr.write(vr, 4, 'ascii');
    if (long) {
      if (le) hdr.writeUInt32LE(value.length, 8); else hdr.writeUInt32BE(value.length, 8);
    } else if (le) hdr.writeUInt16LE(value.length, 6);
    else hdr.writeUInt16BE(value.length, 6);
  } else if (le) hdr.writeUInt32LE(value.length, 4);
  else hdr.writeUInt32BE(value.length, 4);
  return Buffer.concat([hdr, value]);
}

function dicomUS(v, le = true) {
  const b = Buffer.alloc(2);
  if (le) b.writeUInt16LE(v); else b.writeUInt16BE(v);
  return b;
}

function dicomText(s) {
  const b = Buffer.from(s, 'ascii');
  return b.length % 2 ? Buffer.concat([b, Buffer.from(' ')]) : b;
}

function dicomFile({
  rows = 2, cols = 3, frames = 2, bits = 16, signed = true, ts = '1.2.840.10008.1.2.1',
  explicit = true, le = true, values = VALUES.map(v => Math.round(v)),
  iop = [1, 0, 0, 0, 1, 0], ipp = [10, 20, 30],
} = {}) {
  const preamble = Buffer.alloc(132);
  Buffer.from('DICM').copy(preamble, 128);
  const groupLength = Buffer.alloc(4);
  const tsElem = dicomElement(0x0002, 0x0010, 'UI', dicomText(ts + '\0'));
  groupLength.writeUInt32LE(tsElem.length);
  const meta = Buffer.concat([dicomElement(0x0002, 0x0000, 'UL', groupLength), tsElem]);

  const o = { explicit, le };
  const item = (elem, len) => {
    const b = Buffer.alloc(8);
    if (le) b.writeUInt16LE(0xfffe, 0); else b.writeUInt16BE(0xfffe, 0);
    if (le) b.writeUInt16LE(elem, 2); else b.writeUInt16BE(elem, 2);
    if (le) b.writeUInt32LE(len, 4); else b.writeUInt32BE(len, 4);
    return b;
  };
  const parts = [
    dicomElement(0x0028, 0x0010, 'US', dicomUS(rows, le), o),
    dicomElement(0x0028, 0x0011, 'US', dicomUS(cols, le), o),
    dicomElement(0x0028, 0x0002, 'US', dicomUS(1, le), o),
    dicomElement(0x0028, 0x0004, 'CS', dicomText('MONOCHROME2'), o),
    dicomElement(0x0028, 0x0100, 'US', dicomUS(bits, le), o),
    dicomElement(0x0028, 0x0103, 'US', dicomUS(signed ? 1 : 0, le), o),
    dicomElement(0x0028, 0x0008, 'IS', dicomText(String(frames)), o),
    dicomElement(0x0028, 0x0030, 'DS', dicomText('1\\2'), o),
    dicomElement(0x0020, 0x0032, 'DS', dicomText(ipp.join('\\')), o),
    dicomElement(0x0020, 0x0037, 'DS', dicomText(iop.join('\\')), o),
  ];
  if (explicit) {
    // Defined-length sequence, then an undefined-length sequence with an item.
    parts.push(dicomElement(0x0008, 0x1140, 'SQ', item(0xe000, 0), o));
    const sq = dicomElement(0x0008, 0x1111, 'SQ', Buffer.alloc(0), o);
    sq.writeUInt32LE(0xffffffff, 8);
    parts.push(
      sq,
      item(0xe000, 0xffffffff),
      dicomElement(0x0008, 0x1150, 'UI', dicomText('1.2.3\0'), o),
      item(0xe00d, 0),
      item(0xe0dd, 0),
    );
  }
  const pixel = Buffer.alloc(values.length * (bits / 8));
  values.forEach((v, i) => {
    if (bits === 8) pixel.writeInt8(v, i);
    else if (le) pixel.writeInt16LE(v, i * 2); else pixel.writeInt16BE(v, i * 2);
  });
  parts.push(dicomElement(0x7fe0, 0x0010, bits === 8 ? 'OB' : 'OW', pixel, o));
  return Buffer.concat([preamble, meta, ...parts]);
}

function assertDicom(parsed) {
  const h = parsed.header;
  assert.equal(h.nx, 3);
  assert.equal(h.ny, 2);
  assert.equal(h.nz, 2);
  assert.equal(h.datatype, 4);
  assert.equal(h.dx, 2);
  assert.equal(h.dy, 1);
  assert.deepEqual(
    Array.from(readVoxels(parsed, Int16Array, 12)),
    VALUES.map(v => Math.round(v)),
  );
}

test('dicom: explicit LE parses in memory and streams from the original file', async () => {
  await load();
  const file = tmp('explicit.dcm');
  fs.writeFileSync(file, dicomFile());

  const mem = (await registry.parseVolumeFile(file, { memory: true })).parsed;
  assertDicom(mem);
  assert.ok(mem.header.voxOffset > 132);

  const streamed = (await registry.parseVolumeFile(file, { memory: false })).parsed;
  assert.equal(streamed.dataPath, file);
  assertDicom(streamed);
});

test('dicom: implicit VR dataset', async () => {
  await load();
  const file = tmp('implicit.dcm');
  fs.writeFileSync(file, dicomFile({
    ts: '1.2.840.10008.1.2',
    explicit: false,
  }));
  assertDicom((await registry.parseVolumeFile(file, { memory: true })).parsed);
});

test('dicom: IOP/IPP produce an RAS sform', async () => {
  await load();
  const file = tmp('oriented.dcm');
  fs.writeFileSync(file, dicomFile());

  const { parsed } = await registry.parseVolumeFile(file, { memory: true });
  assert.equal(parsed.header.sform_code, 1);
  assert.deepEqual(parsed.header.srow_x, [-2, 0, 0, -10]);
  assert.deepEqual(parsed.header.srow_y, [0, -1, 0, -20]);
  assert.deepEqual(parsed.header.srow_z, [0, 0, 1, 30]);
});

test('dicom: big-endian transfer syntax is swapped once', async () => {
  await load();
  const file = tmp('bigendian.dcm');
  fs.writeFileSync(file, dicomFile({
    ts: '1.2.840.10008.1.2.2',
    le: false,
  }));

  const mem = (await registry.parseVolumeFile(file, { memory: true })).parsed;
  assertDicom(mem);
  assert.equal(mem.header.voxOffset, 0);

  const streamed = (await registry.parseVolumeFile(file, { memory: false })).parsed;
  assert.equal(streamed.header.voxOffset, 0);
  assertDicom(streamed);
  fs.rmSync(streamed.tempFiles[0], { force: true });
});

test('dicom: compressed transfer syntaxes are rejected with a clear message', async () => {
  await load();
  const file = tmp('compressed.dcm');
  fs.writeFileSync(file, dicomFile({ ts: '1.2.840.10008.1.2.5' }));
  await assert.rejects(
    registry.parseVolumeFile(file, { memory: true }),
    /compressed DICOM/,
  );
});

test('mrc: mapc/mapr/maps produce an axis-mapping sform', async () => {
  await load();
  const file = tmp('mapped.mrc');
  const head = Buffer.alloc(1024);
  head.writeInt32LE(3, 0);
  head.writeInt32LE(2, 4);
  head.writeInt32LE(2, 8);
  head.writeInt32LE(1, 12);
  head.writeFloatLE(3, 40);
  head.writeFloatLE(2, 44);
  head.writeFloatLE(2, 48);
  head.writeInt32LE(2, 64); // columns → physical y
  head.writeInt32LE(1, 68); // rows → physical x
  head.writeInt32LE(3, 72);
  const voxels = Buffer.alloc(VALUES.length * 2);
  VALUES.forEach((v, i) => voxels.writeInt16LE(Math.round(v), i * 2));
  fs.writeFileSync(file, Buffer.concat([head, voxels]));

  const { parsed } = await registry.parseVolumeFile(file, { memory: true });
  assert.equal(parsed.header.sform_code, 1);
  assert.deepEqual(parsed.header.srow_x, [0, 1, 0, 0]);
  assert.deepEqual(parsed.header.srow_y, [1, 0, 0, 0]);
  assert.deepEqual(parsed.header.srow_z, [0, 0, 1, 0]);
});

test('mgh: ras_good_flag Mdc/Pxyz produce an sform', async () => {
  await load();
  const file = tmp('oriented.mgh');
  const head = Buffer.alloc(284);
  head.writeInt32BE(1, 0);
  head.writeInt32BE(3, 4);
  head.writeInt32BE(2, 8);
  head.writeInt32BE(2, 12);
  head.writeInt32BE(1, 16);
  head.writeInt32BE(3, 20);
  head.writeInt16BE(1, 28);       // ras_good_flag
  head.writeFloatBE(1, 32);
  head.writeFloatBE(1, 36);
  head.writeFloatBE(1, 40);
  [1, 0, 0, 0, 1, 0, 0, 0, 1].forEach((v, i) => head.writeFloatBE(v, 44 + i * 4));
  head.writeFloatBE(1.5, 80);     // Pxyz_c = voxel-centre of the volume
  head.writeFloatBE(1, 84);
  head.writeFloatBE(1, 88);
  fs.writeFileSync(file, Buffer.concat([head, floatsBE(VALUES)]));

  const { parsed } = await registry.parseVolumeFile(file, { memory: true });
  assert.equal(parsed.header.sform_code, 1);
  assert.deepEqual(parsed.header.srow_x, [1, 0, 0, 0]);
  assert.deepEqual(parsed.header.srow_y, [0, 1, 0, 0]);
  assert.deepEqual(parsed.header.srow_z, [0, 0, 1, 0]);
});

test('mgh / mgz: big-endian FreeSurfer volume is swapped to little-endian', async () => {
  await load();
  const head = Buffer.alloc(284);
  head.writeInt32BE(1, 0);          // version
  head.writeInt32BE(3, 4);          // width
  head.writeInt32BE(2, 8);          // height
  head.writeInt32BE(2, 12);         // depth
  head.writeInt32BE(1, 16);         // nframes
  head.writeInt32BE(3, 20);         // MRI_FLOAT
  head.writeFloatBE(1, 32);
  head.writeFloatBE(1, 36);
  head.writeFloatBE(1, 40);
  const body = floatsBE(VALUES);

  const mgh = tmp('vol.mgh');
  fs.writeFileSync(mgh, Buffer.concat([head, body]));
  const parsed = (await registry.parseVolumeFile(mgh, { memory: true })).parsed;
  assertVolume(parsed, { offset: 0 });

  const mgz = tmp('vol.mgz');
  fs.writeFileSync(mgz, zlib.gzipSync(Buffer.concat([head, body])));
  const gzParsed = (await registry.parseVolumeFile(mgz, { memory: true })).parsed;
  assertVolume(gzParsed, { offset: 0 });
});

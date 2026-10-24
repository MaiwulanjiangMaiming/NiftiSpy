const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const esbuild = require('esbuild');

let parseNpyVolume;
let ready;

async function load() {
  if (ready) return ready;
  ready = (async () => {
    const outfile = path.join(__dirname, '..', 'dist', 'npyParser.node.cjs');
    await esbuild.build({
      entryPoints: [path.join(__dirname, '..', 'src/nifti/npyParser.ts')],
      bundle: true,
      platform: 'node',
      format: 'cjs',
      outfile,
    });
    parseNpyVolume = require(outfile).parseNpyVolume;
  })();
  return ready;
}

/** Serialize a minimal NPY v1 file. `values` is already in the target byte order. */
function npyFile({ descr, fortran = false, shape, values }) {
  const dict = `{'descr': '${descr}', 'fortran_order': ${fortran ? 'True' : 'False'}, 'shape': (${shape.join(', ')}, ), }`;
  const raw = Buffer.from(dict, 'ascii');
  const padding = (64 - ((10 + raw.length + 1) % 64)) % 64;
  const header = Buffer.concat([raw, Buffer.alloc(padding, 0x20), Buffer.from('\n')]);

  const out = Buffer.alloc(10 + header.length + values.length);
  out.set([0x93, 0x4e, 0x55, 0x4d, 0x50, 0x59, 1, 0], 0);
  out.writeUInt16LE(header.length, 8);
  header.copy(out, 10);
  values.copy(out, 10 + header.length);
  return new Uint8Array(out.buffer, out.byteOffset, out.byteLength);
}

function floats(values) {
  const b = Buffer.alloc(values.length * 4);
  values.forEach((v, i) => b.writeFloatLE(v, i * 4));
  return b;
}

test('2D C-order float32 maps to an axial slice', async () => {
  await load();
  const { header, rawData } = parseNpyVolume(npyFile({
    descr: '<f4',
    shape: [2, 3],
    values: floats([1, 2, 3, 4, 5, 6]),
  }));

  assert.equal(header.nx, 3);
  assert.equal(header.ny, 2);
  assert.equal(header.nz, 1);
  assert.equal(header.nt, 1);
  assert.equal(header.datatype, 16);
  assert.equal(header.voxOffset, 128);
  const voxels = new Float32Array(rawData.buffer, rawData.byteOffset + header.voxOffset, 6);
  assert.deepEqual(Array.from(voxels), [1, 2, 3, 4, 5, 6]);
});

test('3D Fortran-order int16 keeps x-fastest axis mapping', async () => {
  await load();
  const values = Buffer.alloc(2 * 3 * 4 * 2);
  for (let i = 0; i < 24; i++) values.writeInt16LE(i + 1, i * 2);

  const { header } = parseNpyVolume(npyFile({
    descr: '<i2',
    fortran: true,
    shape: [2, 3, 4],
    values,
  }));

  assert.equal(header.nx, 2);
  assert.equal(header.ny, 3);
  assert.equal(header.nz, 4);
  assert.equal(header.datatype, 4);
});

test('big-endian data is byte-swapped for the little-endian viewer', async () => {
  await load();
  const values = Buffer.alloc(8);
  values.writeFloatBE(3.5, 0);
  values.writeFloatBE(-1.25, 4);

  const { header, rawData } = parseNpyVolume(npyFile({
    descr: '>f4',
    shape: [2],
    values,
  }));

  assert.equal(header.voxOffset, 0);
  assert.equal(header.nx, 2);
  const voxels = new Float32Array(rawData.buffer, 0, 2);
  assert.deepEqual(Array.from(voxels), [3.5, -1.25]);
});

test('float16 is widened to float32 and complex dtypes are rejected', async () => {
  await load();
  const halves = Buffer.alloc(4);
  halves.writeUInt16LE(0x3800, 0); // 0.5
  halves.writeUInt16LE(0xc000, 2); // -2

  const { header, rawData } = parseNpyVolume(npyFile({
    descr: '<f2',
    shape: [2],
    values: halves,
  }));
  assert.equal(header.datatype, 16);
  assert.deepEqual(Array.from(new Float32Array(rawData.buffer, 0, 2)), [0.5, -2]);

  assert.throws(() => parseNpyVolume(npyFile({
    descr: '<c16',
    shape: [1],
    values: Buffer.alloc(16),
  })), /unsupported \.npy dtype/);
});

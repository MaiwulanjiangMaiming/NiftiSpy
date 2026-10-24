const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const esbuild = require('esbuild');

let parseNiiHeaderQuick;
let parseNiiHeader;
let timepointByteOffset;
let ready;

async function load() {
  if (ready) return ready;
  ready = (async () => {
    const outfile = path.join(__dirname, '..', 'dist', 'headerParser.node.cjs');
    await esbuild.build({
      entryPoints: [path.join(__dirname, '..', 'src/nifti/headerParser.ts')],
      bundle: true,
      platform: 'node',
      format: 'cjs',
      outfile,
    });
    const outfileWebview = path.join(__dirname, '..', 'dist', 'nii-parser.webview.cjs');
    await esbuild.build({
      entryPoints: [path.join(__dirname, '..', 'webview/nii-parser.ts')],
      bundle: true,
      platform: 'node',
      format: 'cjs',
      outfile: outfileWebview,
    });
    const mod = require(outfile);
    parseNiiHeaderQuick = mod.parseNiiHeaderQuick;
    timepointByteOffset = mod.timepointByteOffset;
    parseNiiHeader = require(outfileWebview).parseNiiHeader;
  })();
  return ready;
}

function nifti1Header({ nx = 4, ny = 5, nz = 6, nt = 1, bitpix = 8, voxOffset = 352 } = {}) {
  const buf = Buffer.alloc(348, 0);
  buf.writeInt32LE(348, 0);
  buf.writeInt16LE(nt > 1 ? 4 : 3, 40);
  buf.writeInt16LE(nx, 42);
  buf.writeInt16LE(ny, 44);
  buf.writeInt16LE(nz, 46);
  buf.writeInt16LE(nt, 48);
  buf.writeInt16LE(2, 70); // uint8
  buf.writeInt16LE(bitpix, 72);
  buf.writeFloatLE(1, 80);
  buf.writeFloatLE(1, 84);
  buf.writeFloatLE(1, 88);
  buf.writeFloatLE(2.5, 92);
  buf.writeFloatLE(voxOffset, 108);
  buf.write('n+1\0', 344, 'ascii');
  return buf;
}

test('parseNiiHeaderQuick reads nt/dt and timepoint offsets', async () => {
  await load();
  const h3 = parseNiiHeaderQuick(nifti1Header());
  assert.equal(h3.nt, 1);
  assert.equal(timepointByteOffset(h3, 3), 0);

  const h4 = parseNiiHeaderQuick(nifti1Header({ nt: 8 }));
  assert.equal(h4.ndim, 4);
  assert.equal(h4.nt, 8);
  assert.equal(h4.dt, 2.5);
  assert.equal(timepointByteOffset(h4, 0), 0);
  assert.equal(timepointByteOffset(h4, 2), 2 * 4 * 5 * 6);
  assert.equal(timepointByteOffset(h4, 99), 7 * 4 * 5 * 6);
});

test('separateImg zeros voxOffset for a companion .img', async () => {
  await load();
  const paired = parseNiiHeaderQuick(nifti1Header({ voxOffset: 352 }), { separateImg: true });
  assert.equal(paired.voxOffset, 0);
  const nii = parseNiiHeaderQuick(nifti1Header({ voxOffset: 352 }));
  assert.equal(nii.voxOffset, 352);
});

test('host and webview parsers return identical headers', async () => {
  await load();
  const buf = nifti1Header({ nt: 8, voxOffset: 352 });
  const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  const quick = parseNiiHeaderQuick(buf);
  const strict = parseNiiHeader(ab, false);
  assert.deepEqual(strict, quick);

  const gz = parseNiiHeader(ab, true);
  assert.equal(gz.isGzip, true);
  assert.equal(quick.isGzip, false);

  assert.throws(() => parseNiiHeader(new ArrayBuffer(100), false), /Buffer too small/);
  const bad = new Uint8Array(348).fill(0);
  assert.equal(parseNiiHeaderQuick(bad), null);
  assert.throws(() => parseNiiHeader(bad.buffer, false), /Invalid NIfTI file/);
});

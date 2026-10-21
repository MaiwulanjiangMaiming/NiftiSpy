const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');
const { gzipSync } = require('node:zlib');
const esbuild = require('esbuild');
const { sourceRuntime } = require('./helpers/source-runtime');

let proxyClass;
async function loadProxy() {
  if (!proxyClass) proxyClass = (async () => {
    const built = await esbuild.build({
      entryPoints: [path.join(__dirname, '../src/LocalFileProxy.ts')],
      bundle: true, platform: 'node', format: 'cjs', write: false,
      plugins: [{ name: 'test-vscode-boundary', setup(build) {
        build.onResolve({ filter: /^vscode$/ }, () => ({ path: 'vscode', namespace: 'test' }));
        build.onLoad({ filter: /.*/, namespace: 'test' }, () => ({ contents: `
          export const env = {};
          export const workspace = { getConfiguration: () => ({ get: (_key, fallback) => fallback }) };
        ` }));
      } }],
    });
    const filename = path.join(__dirname, '../dist/proxy-test.cjs');
    const mod = new Module(filename, module);
    mod.filename = filename;
    mod.paths = Module._nodeModulePaths(path.dirname(filename));
    mod._compile(built.outputFiles[0].text, filename);
    return mod.exports.LocalFileProxy;
  })();
  return proxyClass;
}

function makeNifti() {
  const nx = 16, ny = 16, nz = 16;
  const bytes = Buffer.alloc(352 + nx * ny * nz * 2);
  bytes.writeInt32LE(348, 0);
  bytes.writeInt16LE(3, 40);
  [nx, ny, nz, 1].forEach((value, i) => bytes.writeInt16LE(value, 42 + i * 2));
  bytes.writeInt16LE(4, 70); // int16 source, Float32 preview
  bytes.writeInt16LE(16, 72);
  [1, 1, 1, 1].forEach((value, i) => bytes.writeFloatLE(value, 76 + i * 4));
  bytes.writeFloatLE(352, 108);
  bytes.writeFloatLE(2, 112); // detect double scaling
  bytes.writeFloatLE(10, 116);
  bytes.write('n+1\0', 344);
  for (let i = 0; i < nx * ny * nz; i++) bytes.writeInt16LE(i, 352 + i * 2);
  return bytes;
}

function previewReader(fetcher = fetch) {
  const messages = [];
  const context = sourceRuntime('webview/worker.ts', ['tryFetchPreviewVolume'], {
    self: { postMessage: message => messages.push(message) },
    fetchWithRetry: fetcher, earlyPreviewSent: new Set(), earlyPreviewHeaders: new Map(),
  });
  return { context, messages };
}

for (const gzip of [false, true]) {
  test(`real proxy → worker preview round trip (${gzip ? '.nii.gz' : '.nii'})`, async t => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'niftispy-preview-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const file = path.join(dir, gzip ? 'vol.nii.gz' : 'vol.nii');
    fs.writeFileSync(file, gzip ? gzipSync(makeNifti()) : makeNifti());
    const Proxy = await loadProxy();
    const proxy = new Proxy();
    await proxy.start();
    t.after(() => proxy.stop());
    const url = proxy.registerFile({ scheme: 'file', fsPath: file, toString: () => `file://${file}` });
    const { context, messages } = previewReader();
    const ok = await context.tryFetchPreviewVolume(url, 1, new AbortController().signal, 0, gzip);
    assert.equal(ok, true, 'preview payload must not be silently discarded');
    assert.equal(messages.length, 1);
    const msg = messages[0];
    const factor = gzip ? 16 : 8;
    assert.equal(msg.factor, factor);
    assert.equal(msg.voxelData.length, (16 / factor) ** 3);
    assert.equal(msg.voxelData[0], 10);
    const lastCoord = 16 - factor;
    const lastVoxel = lastCoord * 16 * 16 + lastCoord * 16 + lastCoord;
    assert.equal(msg.voxelData.at(-1), lastVoxel * 2 + 10, 'last voxel must not be truncated');
    assert.equal(msg.slope, 1);
    assert.equal(msg.inter, 0);
    assert.equal(msg.header.datatype, 16);
    assert.equal(context.earlyPreviewHeaders.has(1), false, 'low-res header cannot describe the source bytes');
  });
}

test('worker accepts unaligned JSON payload and rejects truncated preview metadata', async () => {
  const header = { nx: 1, ny: 1, nz: 2 };
  let json = JSON.stringify(header);
  while (Buffer.byteLength(json) % 4 === 0) json += ' ';
  const jsonBytes = Buffer.from(json);
  const bytes = Buffer.alloc(4 + jsonBytes.length + 32 + 8);
  bytes.writeUInt32LE(jsonBytes.length);
  jsonBytes.copy(bytes, 4);
  const base = 4 + jsonBytes.length;
  [4, 1, 1, 2].forEach((value, i) => bytes.writeUInt32LE(value, base + i * 4));
  [0, 9, 2, 10, 3, 9].forEach((value, i) => bytes.writeFloatLE(value, base + 16 + i * 4));
  const { context, messages } = previewReader(async () => ({ ok: true,
    arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) }));
  assert.equal(await context.tryFetchPreviewVolume('/file/1', 1, new AbortController().signal), true);
  assert.deepEqual([...messages[0].voxelData], [3, 9]);

  const truncated = previewReader(async () => ({ ok: true,
    arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + base + 28) }));
  assert.equal(await truncated.context.tryFetchPreviewVolume('/file/1', 1, new AbortController().signal), false);
  assert.equal(truncated.messages.length, 0);
});

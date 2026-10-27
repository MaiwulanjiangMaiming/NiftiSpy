const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const Module = require('node:module');
const esbuild = require('esbuild');
const { gzipSync } = require('node:zlib');

let ready;
async function load() {
  return ready ||= (async () => {
    const root = path.join(__dirname, '..');
    const built = await esbuild.build({
      stdin: { contents: `export { TransferEngine } from './webview/worker/transfer'; export { LocalVolumeLoader } from './src/editor/localLoader'; export { shouldUseSliceMode } from './src/remoteEnv';`, resolveDir: root, loader: 'ts' },
      bundle: true, platform: 'node', format: 'cjs', write: false,
      plugins: [{ name: 'ssh-boundary', setup(build) {
        build.onResolve({ filter: /^vscode$/ }, () => ({ path: 'vscode', namespace: 'stub' }));
        build.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({ contents: `
          export const env = { remoteName: 'ssh-remote', asExternalUri: async uri => uri };
          export const workspace = { getConfiguration: () => ({ get: (_key, fallback) => fallback }) };
          export const Uri = { parse: value => ({ toString: () => value }) };
          export const window = { createStatusBarItem: () => ({ show(){}, dispose(){}, text: '' }) };
          export const StatusBarAlignment = { Left: 1 };
        ` }));
      } }],
    });
    const filename = path.join(root, 'dist/gzip-startup.node.cjs');
    const mod = new Module(filename, module); mod.filename = filename; mod.paths = Module._nodeModulePaths(path.dirname(filename));
    mod._compile(built.outputFiles[0].text, filename);
    return mod.exports;
  })();
}

function fixture(noisy = false) {
  const nx = 64, ny = 64, nz = noisy ? 128 : 8;
  const raw = Buffer.alloc(352 + nx * ny * nz * 2);
  raw.writeInt32LE(348, 0); raw.writeInt16LE(3, 40);
  [nx, ny, nz, 1].forEach((v, i) => raw.writeInt16LE(v, 42 + 2 * i));
  raw.writeInt16LE(4, 70); raw.writeInt16LE(16, 72);
  for (let i = 0; i < 4; i++) raw.writeFloatLE(1, 76 + i * 4);
  raw.writeFloatLE(352, 108); raw.writeFloatLE(1, 112); raw.write('n+1\0', 344);
  let seed = 123456789;
  for (let i = 352; i < raw.length; i += 2) {
    seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5;
    raw.writeInt16LE(noisy ? (seed << 16) >> 16 : 100 + i % 64, i);
  }
  return { raw, compressed: gzipSync(raw) };
}

for (const noisy of [false, true]) {
  test(`Remote-SSH gzip ${noisy ? 'partial-probe' : 'probe-sized'} shows a slice before the download finishes`, async t => {
    const { TransferEngine } = await load();
    const { raw, compressed } = fixture(noisy), messages = [];
    const originalFetch = globalThis.fetch, originalSelf = globalThis.self;
    const controllers = new Map(), early = new Set(), headers = new Map(), ranges = [];
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    const host = {
      getHeadCache: () => new Map(), getVolumeControllers: () => controllers,
      getEarlyPreviewSent: () => early, getEarlyPreviewHeaders: () => headers, getHostParsedHeaders: () => new Map(),
      cancelVolumeLoad: id => controllers.get(id)?.abort(), tryFetchPreviewVolume: async () => false,
    };
    let visible;
    const preview = new Promise(resolve => { visible = resolve; });
    globalThis.self = { postMessage(message) { messages.push(message); if (message.type === 'preview') visible(message); } };
    globalThis.fetch = async (_url, init) => {
      const range = new Headers(init?.headers).get('Range');
      const match = /bytes=(\d+)-(\d+)/.exec(range);
      const start = Number(match[1]), end = Math.min(Number(match[2]), compressed.length - 1);
      ranges.push([start, end]);
      const reachesEnd = end === compressed.length - 1;
      const body = reachesEnd ? new ReadableStream({
        start(controller) {
          controller.enqueue(new Uint8Array(compressed.subarray(start, -8)));
          gate.then(() => { controller.enqueue(new Uint8Array(compressed.subarray(-8))); controller.close(); });
        },
      }) : new Uint8Array(compressed.subarray(start, end + 1));
      return new Response(body, { status: 206, headers: { 'Content-Range': `bytes ${start}-${end}/${compressed.length}`, 'Content-Length': String(end - start + 1), 'X-Remote-Source': 'true' } });
    };
    t.after(() => { release(); globalThis.fetch = originalFetch; globalThis.self = originalSelf; });
    const task = new TransferEngine(host).handleLoadVolume(1, 'http://localhost/file/1', true);
    try {
      const outcome = await Promise.race([preview, new Promise(resolve => setTimeout(() => resolve(null), 500))]);
      assert.ok(outcome, `still downloading with no visible slice before EOF; stages: ${messages.filter(m => m.type === 'progress').map(m => m.stage).join(', ')}`);
      assert.ok(outcome.slices.axial.some(value => value !== 0));
      assert.equal(messages.some(m => m.type === 'volume'), false);
    } finally { release(); await task; }
    const volume = messages.find(m => m.type === 'volume');
    assert.ok(volume, JSON.stringify(messages.filter(m => m.type === 'error')));
    assert.equal(volume.voxelData.length, (raw.length - 352) / 2);
    assert.deepEqual(Buffer.from(volume.voxelData.buffer, volume.voxelData.byteOffset, volume.voxelData.byteLength), raw.subarray(352));
    assert.equal(ranges.reduce((bytes, [start, end]) => bytes + end - start + 1, 0), compressed.length, 'streaming must not re-download the probe');
  });
}

test('a highly compressed remote gzip volume gets a host preview instead of a preview-less full download', async () => {
  const { LocalVolumeLoader } = await load();
  const { compressed } = fixture(), messages = [];
  const proxy = {
    registerFile: () => 'http://localhost/file/1', startGzipIndex() {}, whenGzipIndexReady: async () => null,
    extractPreviewForWebview: async () => ({ header: { nx: 64, ny: 64, nz: 8 }, slices: { axial: new Float32Array([100]), coronal: new Float32Array(), sagittal: new Float32Array() }, sliceIdx: { axial: 0, coronal: 32, sagittal: 32 }, globalMin: 0, globalMax: 100 }),
    subscribeGzipPreview: () => () => {},
  };
  const host = { context: { subscriptions: [] }, remoteHttpFallbacks: new Map(), gzipIndexStatusItems: new Map(), getProxy: () => proxy, logPerf() {} };
  const uri = { scheme: 'file', fsPath: '/remote/volume.nii.gz', toString: () => 'file:///remote/volume.nii.gz' };
  const ok = await new LocalVolumeLoader(host).tryRemoteSshHttpLoad({ postMessage: async m => { messages.push(m); return true; } }, 'wv', 'load', uri, uri.fsPath, compressed.length, 'v1', new AbortController().signal);
  assert.equal(ok, true);
  assert.equal(messages[0].type, 'remoteSliceMode', 'compressed byte size must not suppress the first host preview');
  assert.ok(messages[0].axialSlice.length > 0);
});

function transferHost() {
  return { getHostParsedHeaders: () => new Map(), getEarlyPreviewSent: () => new Set(), getEarlyPreviewHeaders: () => new Map() };
}

test('streaming gzip cancellation aborts a pending body read after the first slice', async t => {
  const { TransferEngine } = await load(), { compressed } = fixture();
  const originalSelf = globalThis.self;
  t.after(() => { globalThis.self = originalSelf; });
  let visible, cancelled = false;
  const preview = new Promise(resolve => { visible = resolve; });
  globalThis.self = { postMessage(message) { if (message.type === 'preview') visible(); } };
  const response = new Response(new ReadableStream({
    start(controller) { controller.enqueue(new Uint8Array(compressed.subarray(0, -8))); },
    cancel() { cancelled = true; },
  }));
  const ac = new AbortController();
  const task = new TransferEngine(transferHost()).streamingGzipRanges('http://localhost/file/1', response, compressed.length, compressed.length, 1, ac.signal, 1000);
  await preview;
  ac.abort();
  await assert.rejects(task, error => error.name === 'AbortError');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(cancelled, true);
});

test('streaming gzip rejects a truncated range rather than accepting an incomplete volume', async t => {
  const { TransferEngine } = await load(), { compressed } = fixture();
  const originalSelf = globalThis.self;
  t.after(() => { globalThis.self = originalSelf; });
  globalThis.self = { postMessage() {} };
  const response = new Response(new Uint8Array(compressed.subarray(0, -8)));
  await assert.rejects(new TransferEngine(transferHost()).streamingGzipRanges('http://localhost/file/1', response, compressed.length, compressed.length, 1, new AbortController().signal, 1000), /Short gzip range/);
});

test('the proxy streams original gzip bytes even while its disk-cache scan is pending', async t => {
  const fs = require('node:fs'), os = require('node:os');
  const { productionRuntime } = require('./helpers/production-runtime');
  const { LocalFileProxy } = await productionRuntime(), { compressed } = fixture();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'niftispy-gzip-startup-'));
  const file = path.join(dir, 'volume.nii.gz'); fs.writeFileSync(file, compressed);
  const proxy = new LocalFileProxy();
  t.after(() => { proxy.stop(); fs.rmSync(dir, { recursive: true, force: true }); });
  await proxy.start();
  const url = proxy.registerFile({ scheme: 'file', fsPath: file, toString: () => `file://${file}` });
  const entry = proxy.getEntry(url.split('/').pop());
  entry.size = compressed.length;
  entry.gzipScan = { done: new Promise(() => {}) };
  const response = await fetch(url, { signal: AbortSignal.timeout(1000), headers: { Range: `bytes=0-${compressed.length - 1}` } });
  assert.equal(response.status, 206);
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), compressed);
});


test('gzip preview-first routing is limited to WAN hosts and leaves other formats unchanged', async () => {
  const { shouldUseSliceMode } = await load();
  assert.equal(shouldUseSliceMode(1024, 'ssh-remote', true), true);
  assert.equal(shouldUseSliceMode(1024, 'ssh-remote', false), false);
  assert.equal(shouldUseSliceMode(1024, undefined, true), true, 'stub host is SSH');
  for (const remote of [null, '', 'wsl', 'dev-container', 'attached-container']) {
    assert.equal(shouldUseSliceMode(1024, remote, true), false);
  }
  assert.equal(shouldUseSliceMode(4 * 1024 * 1024, 'ssh-remote', false), true);
});

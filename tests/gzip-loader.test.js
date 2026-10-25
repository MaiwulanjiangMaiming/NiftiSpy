const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');
const esbuild = require('esbuild');

const ROOT = path.join(__dirname, '..');
const OUTFILE = path.join(ROOT, 'dist', 'gzipLoader.node.cjs');

// The extension-host boundary (`vscode`) has no runtime outside VS Code, and
// this machine can actually resolve the shipped napi binary from `dist/..`.
// Stub both so the "no native bindings" transports are deterministic.
const VSCODE_STUB = `
  export const env = { remoteName: undefined };
  export const workspace = {
    getConfiguration: () => ({ get: (_key, fallback) => fallback }),
    fs: {
      stat: async () => { throw new Error('stub fs'); },
      readFile: async () => { throw new Error('stub fs'); },
    },
  };
`;
const NATIVE_STUB = 'export function getNativeBindings() { return null; }';

let bundle;
async function load() {
  if (bundle) return bundle;
  await esbuild.build({
    stdin: {
      contents: `
        export { GzipVolumeLoader } from './src/editor/gzipLoader';
        export { parseNiiHeaderQuick } from './src/nifti/headerParser';
      `,
      resolveDir: ROOT,
      sourcefile: 'gzip-loader.entry.ts',
      loader: 'ts',
    },
    bundle: true,
    platform: 'node',
    format: 'cjs',
    outfile: OUTFILE,
    logLevel: 'silent',
    plugins: [
      {
        name: 'host-stubs',
        setup(build) {
          build.onResolve({ filter: /^vscode$/ }, () => ({ path: 'vscode-stub', namespace: 'stub' }));
          build.onResolve({ filter: /nativeBridge$/ }, () => ({ path: 'native-stub', namespace: 'stub' }));
          build.onLoad({ filter: /^vscode-stub$/, namespace: 'stub' }, () => ({
            contents: VSCODE_STUB,
            loader: 'js',
          }));
          build.onLoad({ filter: /^native-stub$/, namespace: 'stub' }, () => ({
            contents: NATIVE_STUB,
            loader: 'js',
          }));
        },
      },
    ],
  });
  bundle = require(OUTFILE);
  return bundle;
}

/** 8×8×8 int16 volume; voxel value = x + 10*y + 100*z (min 0, max 777). */
function makeNifti() {
  const n = 8;
  const bytes = Buffer.alloc(352 + n * n * n * 2);
  bytes.writeInt32LE(348, 0);
  bytes.writeInt16LE(3, 40);
  [n, n, n, 1].forEach((value, i) => bytes.writeInt16LE(value, 42 + i * 2));
  bytes.writeInt16LE(4, 70); // int16
  bytes.writeInt16LE(16, 72);
  [1, 1, 1, 1].forEach((value, i) => bytes.writeFloatLE(value, 76 + i * 4));
  bytes.writeFloatLE(352, 108);
  bytes.writeFloatLE(1, 112);
  bytes.writeFloatLE(0, 116);
  bytes.write('n+1\0', 344);

  let offset = 352;
  for (let z = 0; z < n; z++) {
    for (let y = 0; y < n; y++) {
      for (let x = 0; x < n; x++) {
        bytes.writeInt16LE(x + 10 * y + 100 * z, offset);
        offset += 2;
      }
    }
  }
  return bytes;
}

function makeHost(parseNiiHeaderQuick) {
  const previews = [];
  const host = {
    parseHeader: (buf) => parseNiiHeaderQuick(buf),
    sendEarlyPreviewFromBuffer: (webview, header, rawData, signal) => {
      previews.push({ webview, header, rawData, signal });
    },
  };
  return { host, previews };
}

function tempFile(t, name, data) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'niftispy-gzip-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, name);
  fs.writeFileSync(file, data);
  return file;
}

test('jsOneshotLocalGzLoad decompresses a gzipped NIfTI and reports exact stats', async (t) => {
  const { GzipVolumeLoader, parseNiiHeaderQuick } = await load();
  const fixture = makeNifti();
  const file = tempFile(t, 'vol.nii.gz', zlib.gzipSync(fixture));
  const { host, previews } = makeHost(parseNiiHeaderQuick);
  const loader = new GzipVolumeLoader(host);

  const result = await loader.jsOneshotLocalGzLoad({}, file, new AbortController().signal);

  assert.ok(result, 'a valid volume must produce a result');
  assert.equal(result.rawData.byteLength, 352 + 8 * 8 * 8 * 2);
  assert.deepEqual(Buffer.from(result.rawData), fixture);
  assert.equal(result.header.nx, 8);
  assert.equal(result.header.ny, 8);
  assert.equal(result.header.nz, 8);
  assert.equal(result.header.voxOffset, 352);
  assert.equal(result.header.datatype, 4);
  assert.deepEqual(result.stats, { min: 0, max: 777 });
  assert.equal(result.timing.decompressedBytes, 352 + 8 * 8 * 8 * 2);
  assert.equal(result.timing.nativeBackend, 'system-zlib');
  assert.equal(previews.length, 0, 'the js one-shot path intentionally skips the preview');
});

test('jsOneshotLocalGzLoad returns null when the signal is already aborted', async (t) => {
  const { GzipVolumeLoader, parseNiiHeaderQuick } = await load();
  const file = tempFile(t, 'vol.nii.gz', zlib.gzipSync(makeNifti()));
  const { host, previews } = makeHost(parseNiiHeaderQuick);
  const loader = new GzipVolumeLoader(host);
  const controller = new AbortController();
  controller.abort();

  const result = await loader.jsOneshotLocalGzLoad({}, file, controller.signal);

  assert.equal(result, null);
  assert.equal(previews.length, 0);
});

test('streamingLocalGzLoad sends exactly one z=0 preview and matches the full volume', async (t) => {
  const { GzipVolumeLoader, parseNiiHeaderQuick } = await load();
  const fixture = makeNifti();
  const file = tempFile(t, 'vol.nii.gz', zlib.gzipSync(fixture));
  const { host, previews } = makeHost(parseNiiHeaderQuick);
  const loader = new GzipVolumeLoader(host);

  const result = await loader.streamingLocalGzLoad({}, file, new AbortController().signal);

  assert.ok(result);
  assert.equal(previews.length, 1, 'exactly one early preview is sent');
  const preview = previews[0];
  assert.equal(preview.header, result.header);
  assert.equal(preview.header.nx, 8);
  assert.ok(Buffer.isBuffer(preview.rawData));
  assert.ok(preview.rawData.length >= 352 + 8 * 8 * 2, 'preview must cover at least the z=0 slice');

  assert.deepEqual(Buffer.from(result.rawData), fixture);
  assert.deepEqual(result.stats, { min: 0, max: 777 });
  assert.equal(result.timing.decompressedBytes, fixture.byteLength);
});

test('streamingLocalGzLoad rejects a corrupt gzip file', async (t) => {
  const { GzipVolumeLoader, parseNiiHeaderQuick } = await load();
  // Valid gzip magic + empty deflate stream body: fails inflation cleanly and
  // leaves ISIZE = 0 so the pre-allocation path cannot request a huge buffer.
  const corrupt = Buffer.from([0x1f, 0x8b, 0x08, 0x00, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
  const file = tempFile(t, 'corrupt.nii.gz', corrupt);
  const { host } = makeHost(parseNiiHeaderQuick);
  const loader = new GzipVolumeLoader(host);

  await assert.rejects(loader.streamingLocalGzLoad({}, file, new AbortController().signal));
});

test('streamingLocalGzLoad rejects a valid gzip whose payload is not NIfTI', async (t) => {
  const { GzipVolumeLoader, parseNiiHeaderQuick } = await load();
  const file = tempFile(t, 'not-nifti.nii.gz', zlib.gzipSync(Buffer.alloc(352 + 8 * 8 * 8 * 2)));
  const { host, previews } = makeHost(parseNiiHeaderQuick);
  const loader = new GzipVolumeLoader(host);

  await assert.rejects(
    loader.streamingLocalGzLoad({}, file, new AbortController().signal),
    /Failed to parse NIfTI header/,
  );
  assert.equal(previews.length, 0);
});

test('native transports reject when no native bindings are available', async (t) => {
  const { GzipVolumeLoader, parseNiiHeaderQuick } = await load();
  const file = tempFile(t, 'vol.nii.gz', zlib.gzipSync(makeNifti()));
  const { host } = makeHost(parseNiiHeaderQuick);
  const loader = new GzipVolumeLoader(host);
  const signal = new AbortController().signal;

  await assert.rejects(loader.parallelLocalGzLoad({}, file, signal), /unavailable/);
  await assert.rejects(loader.oneshotLocalGzLoad({}, file, signal), /unavailable/);
});

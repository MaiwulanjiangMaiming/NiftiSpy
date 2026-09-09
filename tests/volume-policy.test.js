const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const esbuild = require('esbuild');

let shouldAutoloadFullVolume;
let SLICE_MODE_MIN_BYTES;
let LARGE_FILE_BYTES;
let ready;

async function load() {
  if (ready) return ready;
  ready = (async () => {
    const outfile = path.join(__dirname, '..', 'dist', 'volumePolicy.node.cjs');
    await esbuild.build({
      entryPoints: [path.join(__dirname, '..', 'src/volumePolicy.ts')],
      bundle: true,
      platform: 'node',
      format: 'cjs',
      outfile,
    });
    const mod = require(outfile);
    shouldAutoloadFullVolume = mod.shouldAutoloadFullVolume;
    SLICE_MODE_MIN_BYTES = mod.SLICE_MODE_MIN_BYTES;
    LARGE_FILE_BYTES = mod.LARGE_FILE_BYTES;
  })();
  return ready;
}

test('adaptive: small and local files autoload; large/slow stay on slices', async () => {
  await load();
  assert.equal(SLICE_MODE_MIN_BYTES, 8 * 1024 * 1024);
  assert.equal(LARGE_FILE_BYTES, 80 * 1024 * 1024);

  assert.equal(shouldAutoloadFullVolume({
    policy: 'manual', fileSize: 1e6, sliceMode: false, quality: 'high',
  }), false);
  assert.equal(shouldAutoloadFullVolume({
    policy: 'eager', fileSize: 200e6, sliceMode: true, quality: 'low',
  }), true);
  assert.equal(shouldAutoloadFullVolume({
    policy: 'debounced', fileSize: 20e6, sliceMode: true, quality: 'high',
  }), false);
  assert.equal(shouldAutoloadFullVolume({
    policy: 'adaptive', fileSize: 4e6, sliceMode: true, quality: 'low',
  }), true);
  assert.equal(shouldAutoloadFullVolume({
    policy: 'adaptive', fileSize: 20e6, sliceMode: true, quality: 'high',
  }), true);
  assert.equal(shouldAutoloadFullVolume({
    policy: 'adaptive', fileSize: 20e6, sliceMode: true, quality: 'low',
  }), false);
  assert.equal(shouldAutoloadFullVolume({
    policy: 'adaptive', fileSize: 120e6, sliceMode: true, quality: 'high',
  }), false);
  assert.equal(shouldAutoloadFullVolume({
    policy: 'adaptive', fileSize: 20e6, sliceMode: false, quality: 'low',
  }), true);
});

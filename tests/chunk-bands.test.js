const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const esbuild = require('esbuild');

let computeChunkBands;
let ready;

async function load() {
  if (ready) return ready;
  ready = (async () => {
    const outfile = path.join(__dirname, '..', 'dist', 'chunkBands.node.cjs');
    await esbuild.build({
      entryPoints: [path.join(__dirname, '..', 'webview/viewer/chunkBands.ts')],
      bundle: true,
      platform: 'node',
      format: 'cjs',
      outfile,
    });
    computeChunkBands = require(outfile).computeChunkBands;
  })();
  return ready;
}

function assertCoverage(bands, nz) {
  let expectedZ = 0;
  for (const band of bands) {
    assert.equal(band.zStart, expectedZ);
    expectedZ += band.chunkDepth;
    assert.ok(band.ty0 >= 0 && band.ty1 <= 1, 'texture coords stay in [0,1]');
    assert.ok(band.ty1 > band.ty0, 'band must have positive height');
  }
  assert.equal(expectedZ, nz, 'z intervals must cover the whole volume');

  // Map each band to its top-down screen interval [1-ty1, 1-ty0] and verify
  // that the union covers [0,1] without gaps or overlaps.
  const intervals = bands
    .map(b => [1 - b.ty1, 1 - b.ty0])
    .sort((a, b) => a[0] - b[0]);
  let expected = 0;
  for (const [start, end] of intervals) {
    assert.ok(Math.abs(start - expected) < 1e-12, `screen gap at ${expected}`);
    expected = end;
  }
  assert.ok(Math.abs(expected - 1) < 1e-12, 'screen bands must cover the whole quad');
}

test('chunk bands cover every z interval and every screen pixel', async () => {
  await load();
  for (const flipY of [false, true]) {
    const bands = computeChunkBands(1000, 400, flipY);
    assert.deepEqual(bands.map(b => b.chunkDepth), [400, 400, 200]);
    assertCoverage(bands, 1000);
  }

  const normal = computeChunkBands(1000, 400, false);
  assert.ok(normal[0].ty0 === 0 && normal[0].ty1 === 0.4, 'unflipped chunk 0 occupies the bottom');
  const flipped = computeChunkBands(1000, 400, true);
  assert.ok(flipped[0].ty0 === 0.6 && flipped[0].ty1 === 1, 'flipped chunk 0 occupies the top');
});

test('chunk bands handle a single chunk and degenerate inputs', async () => {
  await load();
  const single = computeChunkBands(300, 512, false);
  assert.equal(single.length, 1);
  assert.deepEqual(single[0], { zStart: 0, chunkDepth: 300, ty0: 0, ty1: 1 });
  assert.deepEqual(computeChunkBands(0, 256, false), []);
  assert.deepEqual(computeChunkBands(100, 0, false), []);
});

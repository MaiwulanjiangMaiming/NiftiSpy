const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const esbuild = require('esbuild');

let VolumeRaycaster;
let ready;

async function load() {
  if (ready) return ready;
  ready = (async () => {
    const outfile = path.join(__dirname, '..', 'dist', 'volumeRaycaster.node.cjs');
    await esbuild.build({
      entryPoints: [path.join(__dirname, '..', 'webview/volumeRaycaster.ts')],
      bundle: true,
      platform: 'node',
      format: 'cjs',
      outfile,
    });
    VolumeRaycaster = require(outfile).VolumeRaycaster;
  })();
  return ready;
}

// Column-major 3x3 part of the 4x4 matrix (WebGL layout).
function columns(m) {
  return [
    [m[0], m[1], m[2]],
    [m[4], m[5], m[6]],
    [m[8], m[9], m[10]],
  ];
}

function det3(m) {
  const [a, b, c] = columns(m);
  return a[0] * (b[1] * c[2] - b[2] * c[1]) - a[1] * (b[0] * c[2] - b[2] * c[0]) + a[2] * (b[0] * c[1] - b[1] * c[0]);
}

function assertOrthonormal(m) {
  const [c0, c1, c2] = columns(m);
  const dot = (u, v) => u[0] * v[0] + u[1] * v[1] + u[2] * v[2];
  assert.ok(Math.abs(dot(c0, c0) - 1) < 1e-5, 'column 0 has unit length');
  assert.ok(Math.abs(dot(c1, c1) - 1) < 1e-5, 'column 1 has unit length');
  assert.ok(Math.abs(dot(c2, c2) - 1) < 1e-5, 'column 2 has unit length');
  assert.ok(Math.abs(dot(c0, c1)) < 1e-5, 'columns 0 and 1 are orthogonal');
  assert.ok(Math.abs(dot(c0, c2)) < 1e-5, 'columns 0 and 2 are orthogonal');
  assert.ok(Math.abs(dot(c1, c2)) < 1e-5, 'columns 1 and 2 are orthogonal');
  assert.ok(Math.abs(det3(m) - 1) < 1e-5, 'rotation determinant is +1');
}

test('arcballRotation returns identity for a zero drag', async () => {
  await load();
  const m = VolumeRaycaster.arcballRotation(0.1, -0.2, 0.1, -0.2);
  const identity = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
  for (let i = 0; i < 16; i++) {
    assert.ok(Math.abs(m[i] - identity[i]) < 1e-6, `element ${i} is identity`);
  }
});

test('arcballRotation produces a rigid rotation for a real drag', async () => {
  await load();
  const m = VolumeRaycaster.arcballRotation(0.2, 0.1, -0.35, 0.4);
  assert.equal(m.length, 16);
  assertOrthonormal(m);
});

test('arcballRotation is invertible: dragging back undoes the rotation', async () => {
  await load();
  const forward = VolumeRaycaster.arcballRotation(0.2, 0.1, -0.35, 0.4);
  const backward = VolumeRaycaster.arcballRotation(-0.35, 0.4, 0.2, 0.1);

  // backward must be the transpose of forward (column-major, rotation only).
  for (let row = 0; row < 3; row++) {
    for (let col = 0; col < 3; col++) {
      const f = forward[col * 4 + row];
      const b = backward[row * 4 + col];
      assert.ok(Math.abs(f - b) < 1e-5, `transpose element r${row}c${col}`);
    }
  }

  // Composing them yields identity.
  const composed = new Float32Array(16);
  for (let row = 0; row < 3; row++) {
    for (let col = 0; col < 3; col++) {
      let sum = 0;
      for (let k = 0; k < 3; k++) sum += backward[k * 4 + row] * forward[col * 4 + k];
      composed[col * 4 + row] = sum;
    }
  }
  assert.ok(Math.abs(composed[0] - 1) < 1e-5, 'composition returns identity (0,0)');
  assert.ok(Math.abs(composed[5] - 1) < 1e-5, 'composition returns identity (1,1)');
  assert.ok(Math.abs(composed[10] - 1) < 1e-5, 'composition returns identity (2,2)');
  assert.ok(Math.abs(composed[1]) < 1e-5, 'composition has no shear');
});

test('arcballRotation handles drags outside the virtual sphere', async () => {
  await load();
  const m = VolumeRaycaster.arcballRotation(2, 0.5, -1.5, 2.5);
  assertOrthonormal(m);
});

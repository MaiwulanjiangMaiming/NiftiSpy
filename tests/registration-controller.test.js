const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const esbuild = require('esbuild');

let RegistrationController;
let ready;

async function load() {
  if (ready) return ready;
  ready = (async () => {
    const outfile = path.join(__dirname, '..', 'dist', 'registrationController.node.cjs');
    await esbuild.build({
      entryPoints: [path.join(__dirname, '..', 'webview/viewer/registration.ts')],
      bundle: true,
      platform: 'node',
      format: 'cjs',
      outfile,
    });
    RegistrationController = require(outfile).RegistrationController;
  })();
  return ready;
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

function makeElement() {
  const classes = new Set();
  return {
    textContent: '',
    disabled: false,
    style: {},
    display: '',
    classList: {
      add: (...names) => names.forEach((n) => classes.add(n)),
      remove: (...names) => names.forEach((n) => classes.delete(n)),
      contains: (n) => classes.has(n),
    },
  };
}

function makeHeader() {
  return {
    nx: 4,
    ny: 5,
    nz: 6,
    dx: 1,
    dy: 1,
    dz: 1,
    nt: 1,
    nu: 1,
    ndim: 3,
    datatype: 16,
    bitpix: 32,
    bytesPerVoxel: 4,
    scl_slope: 1,
    scl_inter: 0,
    srow_x: [1, 0, 0, -2],
    srow_y: [0, 1, 0, -3],
    srow_z: [0, 0, 1, -4],
    voxOffset: 352,
    isGzip: false,
    totalVoxels3D: 120,
    sliceSizeXY: 20,
    volumeBytes: 480,
    littleEndian: true,
  };
}

function makeImage(name, offset) {
  return {
    header: makeHeader(),
    data: new Float32Array(120).map((_v, i) => i + offset),
    min: 0,
    max: 1,
    slope: 1,
    inter: 0,
    name,
    url: '',
    directUrl: '',
    colormap: 'gray',
    state: 'ready',
    lastAccess: 0,
    selected: false,
  };
}

class FakeWorker {
  static instances = [];

  constructor(url) {
    this.url = url;
    this.messages = [];
    this.terminated = false;
    this.onmessage = null;
    this.onerror = null;
    FakeWorker.instances.push(this);
  }

  postMessage(message) {
    this.messages.push(message);
  }

  terminate() {
    this.terminated = true;
  }
}

function setup(t) {
  FakeWorker.instances = [];

  const ids = ['reg-status', 'reg-status-text', 'reg-fill', 'btn-reg-mni', 'btn-reg-custom', 'btn-align', 'btn-reg-cancel'];
  const els = new Map(ids.map((id) => [id, makeElement()]));
  const originalDocument = globalThis.document;
  globalThis.document = { getElementById: (id) => els.get(id) ?? null };

  const originalWorker = globalThis.Worker;
  globalThis.Worker = FakeWorker;

  let fetchCount = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    fetchCount++;
    return { ok: true, text: async () => '// worker' };
  };

  const originalCreateObjectURL = URL.createObjectURL;
  URL.createObjectURL = () => 'blob:reg';

  t.after(() => {
    globalThis.Worker = originalWorker;
    globalThis.fetch = originalFetch;
    URL.createObjectURL = originalCreateObjectURL;
    if (originalDocument === undefined) delete globalThis.document;
    else globalThis.document = originalDocument;
  });

  const images = [makeImage('src.nii', 0), makeImage('ref.nii', 1000)];
  const calls = {
    clearCompareCaches: 0,
    enterCompareOverlayUI: 0,
    setCompareIndices: [],
    ensureImage: [],
  };
  const host = {
    images,
    posts: [],
    toasts: [],
    cached: undefined,
    ensureFull: true,
    compare: { a: 0, b: 1 },
    calls,
    getImages: () => images,
    getActiveIndex: () => 0,
    getHeader: () => images[0].header,
    getVolumeData: () => images[0].data,
    isFullVolumeLoaded: () => true,
    ensureFullVolume: async () => host.ensureFull,
    ensureImage: async (index, priority, reason) => calls.ensureImage.push([index, priority, reason]),
    getComparedImage: (which) => images[which === 0 ? host.compare.a : host.compare.b] ?? null,
    getCompareIndices: () => ({ ...host.compare }),
    setCompareIndices: (a, b) => {
      host.compare = { a, b };
      calls.setCompareIndices.push([a, b]);
    },
    enterCompareOverlayUI: () => {
      calls.enterCompareOverlayUI++;
    },
    clearCompareCaches: () => {
      calls.clearCompareCaches++;
    },
    showToast: (text) => host.toasts.push(text),
    postMessage: (message) => host.posts.push(message),
    getRegWorkerUrl: () => 'vscode-resource://regWorker.js',
    getCachedRegWorkerUrl: () => host.cached,
    setCachedRegWorkerUrl: (url) => {
      host.cached = url;
    },
  };
  const controller = new RegistrationController(host);
  return { els, host, controller, workers: FakeWorker.instances, fetchCount: () => fetchCount };
}

function regResult(overrides = {}) {
  return {
    type: 'regResult',
    alignM: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],
    tplName: 'MNI.nii.gz',
    nx: 4,
    ny: 5,
    nz: 6,
    dx: 1,
    dy: 1,
    dz: 1,
    srow_x: [1, 0, 0, -2],
    srow_y: [0, 1, 0, -3],
    srow_z: [0, 0, 1, -4],
    tplData: new Float32Array(120).fill(2).buffer,
    tplMin: 0,
    tplMax: 2,
    durationMs: 1200,
    ...overrides,
  };
}

test('startRegistration fails cleanly when the full volume is unavailable', async (t) => {
  await load();
  const { els, host, controller } = setup(t);
  host.ensureFull = false;

  controller.startRegistration('mni');
  await tick();

  assert.equal(controller.isBusy(), false);
  assert.equal(host.posts.length, 0);
  assert.equal(
    els.get('reg-status-text').textContent,
    'Could not load the full volume — registration needs all voxels.',
  );
  assert.equal(els.get('reg-status').classList.contains('fail'), true);
});

test('startRegistration requests the template and disables the action buttons', async (t) => {
  await load();
  const { els, host, controller } = setup(t);

  controller.startRegistration('mni');
  await tick();

  assert.deepEqual(host.posts, [{ type: 'getTemplate', mode: 'mni' }]);
  assert.equal(controller.isBusy(), true);
  assert.equal(els.get('reg-status').classList.contains('busy'), true);
  assert.equal(els.get('btn-reg-cancel').style.display, 'inline-block');
  for (const id of ['btn-reg-mni', 'btn-reg-custom', 'btn-align']) {
    assert.equal(els.get(id).disabled, true, `${id} should be disabled while busy`);
  }
});

test('handleTemplateData launches the worker with the moving volume and caches its URL', async (t) => {
  await load();
  const { host, controller, workers, fetchCount } = setup(t);

  controller.startRegistration('mni');
  await tick();
  controller.handleTemplateData({ mode: 'mni', name: 'MNI', bytes: 8 });
  await tick();

  assert.equal(workers.length, 1);
  assert.equal(workers[0].url, 'blob:reg');
  assert.equal(fetchCount(), 1);

  const msg = workers[0].messages[0];
  assert.equal(msg.type, 'initReg');
  assert.equal(msg.mode, 'mni');
  const moving = new Float32Array(msg.moving.data);
  assert.equal(moving.length, 120);
  assert.equal(moving[5], 5);
  assert.equal(msg.moving.datatype, 16);
  assert.deepEqual(msg.moving.dims, [4, 5, 6]);
  assert.deepEqual(msg.moving.srow_x, host.images[0].header.srow_x);
  assert.deepEqual(msg.moving.srow_y, host.images[0].header.srow_y);
  assert.deepEqual(msg.moving.srow_z, host.images[0].header.srow_z);
  assert.equal(msg.template.length, 8);

  // Second launch reuses the object URL instead of fetching the worker again.
  await controller.cancel();
  controller.startRegistration('custom');
  await tick();
  controller.handleTemplateData({ mode: 'custom', name: 'X' });
  await tick();

  assert.equal(workers.length, 2);
  assert.equal(workers[1].url, 'blob:reg');
  assert.equal(fetchCount(), 1);
});

test('template registration result attaches the transform and opens the overlay', async (t) => {
  await load();
  const { els, host, controller, workers } = setup(t);

  controller.startRegistration('mni');
  await tick();
  controller.handleTemplateData({ mode: 'mni', name: 'MNI', bytes: 8 });
  await tick();

  const worker = workers[0];
  worker.onmessage({ data: regResult() });

  const expectedM = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
  assert.deepEqual(host.images[0].align, { m: expectedM, ref: 'MNI.nii.gz' });
  assert.equal(host.calls.clearCompareCaches, 1);
  assert.equal(host.images.length, 3);
  assert.equal(host.images[2].name, 'MNI');
  assert.equal(host.images[2].data.length, 120);
  assert.deepEqual(host.calls.setCompareIndices, [[2, 0]]);
  assert.equal(host.calls.enterCompareOverlayUI, 1);
  assert.equal(worker.terminated, true);
  assert.equal(controller.isBusy(), false);
  assert.match(els.get('reg-status-text').textContent, /^Aligned to MNI in 1\.2s/);
  assert.equal(els.get('reg-status').classList.contains('ok'), true);
});

test('align flow ships the reference volume and stores the transform on the moving image', async (t) => {
  await load();
  const { host, controller, workers } = setup(t);

  await controller.startAlign(1);
  await tick();

  assert.deepEqual(host.calls.ensureImage, [
    [0, 'active', 'user'],
    [1, 'active', 'user'],
  ]);
  assert.equal(workers.length, 1);

  const msg = workers[0].messages[0];
  assert.equal(msg.type, 'initReg');
  assert.equal(msg.mode, 'custom');
  assert.equal(msg.tplName, 'ref.nii');
  assert.ok(msg.templateVolume);
  const refFloats = new Float32Array(msg.templateVolume.data);
  assert.equal(refFloats.length, 120);
  assert.equal(refFloats[0], 1000);
  assert.deepEqual(msg.templateVolume.dims, [4, 5, 6]);
  assert.equal(host.images[0].align, undefined);

  workers[0].onmessage({ data: regResult({ tplName: 'ref.nii' }) });

  assert.ok(host.images[0].align, 'moving image receives the transform');
  assert.equal(host.images[0].align.ref, 'ref.nii');
  assert.deepEqual(host.calls.setCompareIndices, [[1, 0]]);
  assert.equal(host.calls.enterCompareOverlayUI, 1);
  assert.equal(host.images.length, 2);
  assert.equal(controller.isBusy(), false);
});

test('cancel terminates the worker and reports cancellation', async (t) => {
  await load();
  const { els, controller, workers } = setup(t);

  controller.startRegistration('mni');
  await tick();
  controller.handleTemplateData({ mode: 'mni', name: 'MNI', bytes: 8 });
  await tick();
  assert.equal(workers.length, 1);

  await controller.cancel();

  assert.equal(workers[0].terminated, true);
  assert.equal(controller.isBusy(), false);
  assert.match(els.get('reg-status-text').textContent, /cancelled/i);
});

test('startAlign without two compared images only shows a toast', async (t) => {
  await load();
  const { host, controller, workers } = setup(t);
  host.getComparedImage = () => null;

  await controller.startAlign(0);

  assert.equal(workers.length, 0);
  assert.equal(host.posts.length, 0);
  assert.equal(controller.isBusy(), false);
  assert.equal(host.toasts.length, 1);
  assert.match(host.toasts[0], /compare mode/);
});

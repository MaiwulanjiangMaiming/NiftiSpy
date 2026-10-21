const test = require('node:test');
const assert = require('node:assert/strict');
const { sourceRuntime } = require('./helpers/source-runtime');

const noop = () => {};
const hdr = { nx: 8, ny: 6, nz: 4, datatype: 16 };
function image(overrides = {}) {
  return {
    header: null, data: null, min: 0, max: 1, slope: 1, inter: 0,
    name: 'remote.nii.gz', url: 'http://localhost/file/1', directUrl: '',
    state: 'loading', lastAccess: 0, colormap: 'gray', ...overrides,
  };
}

function viewer(overrides = {}) {
  return sourceRuntime('webview/viewer.ts', [
    'ensureImageData', 'applyImageState', 'showPartialPreviewFromMessage',
    'setPrimaryImageFromDirectPreview', 'toFloat32Array', 'sliceHasSignal',
    'setCurrentSlice', 'updateProgress', 'displayLoadedImage',
  ], {
    images: [image()], activeImageIdx: 0, header: null, volumeData: null,
    fullVolumeLoaded: false, fileName: 'remote.nii.gz', fileUrl: 'http://localhost/file/1',
    directUrl: '', dataSlope: 1, dataInter: 0, globalMin: 0, globalMax: 1,
    colormap: 'gray', sliceIdx: { axial: 0, coronal: 0, sagittal: 0 },
    currentSlices: { axial: null, coronal: null, sagittal: null },
    loading: { style: { display: 'flex' } }, progress: { style: {} },
    loadingText: { textContent: 'Streaming volume (fast path)...' },
    loadingDetail: { textContent: 'Stream' },
    isLowResPreview: false, lowResFactor: 1, deferFullVolume: false,
    headerPanelVisible: false, sliceRenderCache: new Map(),
    glRenderers: {}, webgpuRenderers: {},
    perfMonitor: { fullLoads: [], failures: 0 },
    window: { setTimeout, clearTimeout },
    reprioritizeVolumeLoad: async () => {}, queueVolumeLoad: (_key, task) => task(),
    getVolumeCacheDB: () => ({ get: async () => null, put: async () => {} }),
    makeTypedArrayFromBuffer: buffer => new Float32Array(buffer),
    hideLowResBadge: noop, updateFileInfo: noop, updateSliderValues: noop,
    renderAllViews: noop, updateImagePicker: noop, setupInteraction: noop,
    evictInactiveImageData: noop, scheduleNextImagePreload: noop,
    publishPerfMonitor: noop, computeViewFlips: noop, tryUploadVolume3D: noop,
    showSliceModeBadge: noop, refreshSlices: async () => {},
    ...overrides,
  });
}

function result(header = hdr) {
  return {
    header, voxelData: new Float32Array(header.nx * header.ny * header.nz).fill(7),
    globalMin: 0, globalMax: 7, slope: 1, inter: 0,
  };
}

test('remote fast path completes the UI after worker done + volume', async () => {
  let renders = 0;
  const ctx = viewer({
    renderAllViews: () => { renders++; },
    loadVolumeViaWorker: async (_key, _url, _gz, progress) => {
      progress({ type: 'progress', value: 1, stage: 'done' });
      return result();
    },
  });
  await ctx.ensureImageData(0, 'active');
  assert.ok(renders > 0);
  assert.equal(ctx.images[0].state, 'ready');
  assert.equal(ctx.fullVolumeLoaded, true);
  assert.equal(ctx.loading.style.display, 'none');
  assert.equal(ctx.loadingText.textContent, '');
  assert.equal(ctx.loadingDetail.textContent, '');
  assert.equal(ctx.progress.style.width, '100%');
  assert.deepEqual(ctx.sliceIdx, { axial: 2, coronal: 3, sagittal: 4 });
});

test('IndexedDB restore completes the UI without a worker or preview', async () => {
  const data = result();
  const ctx = viewer({ getVolumeCacheDB: () => ({ get: async () => ({
    ...data, voxelData: data.voxelData.buffer, datatype: 16, min: 0, max: 7,
  }) }) });
  await ctx.ensureImageData(0, 'active');
  assert.equal(ctx.loading.style.display, 'none');
  assert.equal(ctx.fullVolumeLoaded, true);
  assert.deepEqual(ctx.sliceIdx, { axial: 2, coronal: 3, sagittal: 4 });
});

test('early partial preview preserves the pending image and its loadPromise', async () => {
  let finish;
  const ctx = viewer({
    loadVolumeViaWorker: async (_key, _url, _gz, progress) => {
      await new Promise(resolve => { finish = () => {
        progress({ type: 'preview', partialPreview: true, header: hdr,
          slices: { axial: new Float32Array(48).fill(1) },
          sliceIdx: { axial: 0, coronal: 3, sagittal: 4 }, globalMin: 0, globalMax: 7 });
        resolve();
      }; });
      return result();
    },
  });
  const original = ctx.images[0];
  const pending = ctx.ensureImageData(0, 'active');
  await new Promise(resolve => setImmediate(resolve));
  assert.ok(original.loadPromise);
  finish();
  assert.equal(ctx.images[0], original, 'preview must update the existing image in place');
  assert.ok(ctx.images[0].loadPromise, 'pending load remains deduplicated');
  await pending;
  assert.equal(ctx.images[0].data, ctx.volumeData);
  assert.equal(ctx.images[0].state, 'ready');
  assert.equal(ctx.images[0].loadPromise, undefined);
});

test('partial preview of an added image preserves the image list and active index', () => {
  const first = image({ header: hdr, data: result().voxelData });
  const second = image({ name: 'second.nii.gz', url: '/file/2' });
  const ctx = viewer({ images: [first, second], activeImageIdx: 1, fileUrl: '/file/2' });
  ctx.showPartialPreviewFromMessage({ header: hdr, slices: { axial: new Float32Array(48) } });
  assert.equal(ctx.images.length, 2);
  assert.equal(ctx.activeImageIdx, 1);
  assert.equal(ctx.images[1], second);
});

test('a fully loaded image rejects late previews, and switching to preview resets readiness', () => {
  const ctx = viewer();
  const loaded = image({ header: hdr, data: result().voxelData, state: 'ready' });
  ctx.applyImageState(loaded);
  ctx.showPartialPreviewFromMessage({ header: { ...hdr, nx: 1 } });
  assert.equal(ctx.header, hdr);
  assert.equal(ctx.fullVolumeLoaded, true);
  ctx.applyImageState(image({ header: hdr, state: 'preview' }));
  assert.equal(ctx.fullVolumeLoaded, false);
});

test('background completion cannot hide the active image loading overlay', async () => {
  const ctx = viewer({ images: [image(), image({ url: '/file/background' })],
    loadVolumeViaWorker: async () => result() });
  await ctx.ensureImageData(1, 'background');
  assert.equal(ctx.loading.style.display, 'flex');
  assert.equal(ctx.volumeData, null);
});

test('a complete worker preview becomes visible before the full volume arrives', async () => {
  const ctx = viewer({ loadVolumeViaWorker: async (_key, _url, _gz, progress) => {
    progress({ type: 'preview', header: hdr, slices: { axial: new Float32Array(48).fill(7) },
      sliceIdx: { axial: 2, coronal: 3, sagittal: 4 }, globalMin: 0, globalMax: 7 });
    assert.equal(ctx.loading.style.display, 'none');
    assert.equal(ctx.images[0].header, hdr);
    return result();
  } });
  await ctx.ensureImageData(0, 'active');
  assert.equal(ctx.fullVolumeLoaded, true);
});

test('restoring a volume after low-res preview scales the current slice positions', async () => {
  const ctx = viewer({ header: { nx: 2, ny: 2, nz: 1 },
    isLowResPreview: true, lowResFactor: 4, sliceIdx: { axial: 0, coronal: 1, sagittal: 1 },
    loadVolumeViaWorker: async () => result() });
  await ctx.ensureImageData(0, 'active');
  assert.deepEqual(ctx.sliceIdx, { axial: 0, coronal: 4, sagittal: 4 });
  assert.equal(ctx.fullVolumeLoaded, true);
});

test('terminating a volume worker settles the pending promise as AbortError', async () => {
  let worker;
  const ctx = sourceRuntime('webview/viewer.ts', [
    'loadVolumeViaWorker', 'cancelVolumeLoadByKey',
  ], {
    Worker: class { constructor() { worker = this; } postMessage() {} terminate() { this.terminated = true; } },
    ensureWorkerBlobUrl: async () => 'blob:worker',
    nextStreamRequestId: 2000, volumeWorkers: new Map(), volumeWorkerCancels: new Map(),
    volumeLoadReasons: new Map(), activeVolumeLoadKey: 'remote',
    publishPerfMonitor: noop, bandwidthEstimator: {},
    makeAbortError: () => Object.assign(new Error('Cancelled'), { name: 'AbortError' }),
  });
  const pending = ctx.loadVolumeViaWorker('remote', '/file/1', true);
  await new Promise(resolve => setImmediate(resolve));
  ctx.cancelVolumeLoadByKey('remote');
  const outcome = await Promise.race([
    pending.then(() => 'resolved', err => err.name),
    new Promise(resolve => setTimeout(() => resolve('still pending'), 50)),
  ]);
  assert.equal(outcome, 'AbortError');
  assert.equal(worker.terminated, true);
  assert.equal(ctx.volumeWorkers.size, 0);
});

test('cancelling a full-volume download frees a queue slot for the next image', async () => {
  const workers = [];
  const ctx = sourceRuntime('webview/viewer.ts', [
    'queueVolumeLoad', 'loadVolumeViaWorker', 'cancelVolumeLoadByKey',
  ], {
    Worker: class {
      constructor() { workers.push(this); }
      postMessage(message) { this.requestId = message.id; }
      terminate() {}
    },
    ensureWorkerBlobUrl: async () => 'blob:worker', nextStreamRequestId: 2000,
    volumeWorkers: new Map(), volumeWorkerCancels: new Map(), volumeLoadReasons: new Map(),
    activeVolumeLoadKey: null, activeVolumeLoads: 0, MAX_PARALLEL_VOLUME_LOADS: 1,
    volumeLoadQueue: [], publishPerfMonitor: noop, bandwidthEstimator: {},
    makeAbortError: () => Object.assign(new Error('Cancelled'), { name: 'AbortError' }),
  });
  const first = ctx.queueVolumeLoad('one', () => ctx.loadVolumeViaWorker('one', '/one', true));
  const rejected = assert.rejects(first, { name: 'AbortError' });
  const second = ctx.queueVolumeLoad('two', () => ctx.loadVolumeViaWorker('two', '/two', true));
  await new Promise(resolve => setImmediate(resolve));
  ctx.cancelVolumeLoadByKey('one');
  await rejected;
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(workers.length, 2);
  workers[1].onmessage({ data: { id: workers[1].requestId, type: 'volume' } });
  await second;
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(ctx.activeVolumeLoads, 0);
  assert.equal(ctx.volumeLoadQueue.length, 0);
});

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const esbuild = require('esbuild');

const VSCODE_STUB = `
export const env = { remoteName: undefined };
export const workspace = {
  getConfiguration: () => ({ get: (_k, d) => d }),
  fs: {
    stat: async () => { throw new Error('stub fs'); },
    readFile: async () => { throw new Error('stub fs'); },
  },
};
export const Uri = {
  file: (p) => ({ scheme: 'file', fsPath: p, path: p, toString: () => 'file://' + p }),
  parse: (s) => ({ scheme: s.split(':')[0], fsPath: '', path: '', toString: () => s }),
};
export const window = { createStatusBarItem: () => ({ show(){}, hide(){}, dispose(){}, text: '' }) };
export const StatusBarAlignment = { Left: 1, Right: 2 };
`;

let LocalVolumeLoader;
let ready;

async function load() {
  if (ready) return ready;
  ready = (async () => {
    const outfile = path.join(__dirname, '..', 'dist', 'localLoader.node.cjs');
    await esbuild.build({
      entryPoints: [path.join(__dirname, '..', 'src/editor/localLoader.ts')],
      bundle: true,
      platform: 'node',
      format: 'cjs',
      outfile,
      plugins: [
        {
          name: 'vscode-stub',
          setup(build) {
            build.onResolve({ filter: /^vscode$/ }, () => ({ path: 'vscode', namespace: 'vscode-stub' }));
            build.onLoad({ filter: /.*/, namespace: 'vscode-stub' }, () => ({
              contents: VSCODE_STUB,
              loader: 'js',
            }));
          },
        },
      ],
    });
    LocalVolumeLoader = require(outfile).LocalVolumeLoader;
  })();
  return ready;
}

function makeUri() {
  return {
    toString: () => 'file:///tmp/a.nii',
    fsPath: '/tmp/a.nii',
    scheme: 'file',
    path: '/tmp/a.nii',
  };
}

function makeCachedVolume() {
  return {
    header: { nx: 4, ny: 5, nz: 6, voxOffset: 352, datatype: 16 },
    voxelData: new Uint8Array(4 * 5 * 6 * 2),
    min: 0,
    max: 1,
    slope: 1,
    inter: 0,
  };
}

function makeLoader({ cached = null, isActive = true } = {}) {
  const messages = [];
  const cacheCalls = { setActive: [], set: [] };
  const enqueued = [];
  const host = {
    context: {},
    volumeCache: {
      get: () => cached,
      setActive: (key, webviewId) => cacheCalls.setActive.push([key, webviewId]),
      set: (key, value) => cacheCalls.set.push([key, value]),
    },
    loadQueue: {
      enqueue: (job) => enqueued.push(job),
    },
    remoteHttpFallbacks: new Map(),
    gzipIndexStatusItems: new Map(),
    isWebviewActive: () => isActive,
    logPerf: () => {},
    updateCacheStatusBar: () => {},
    getProxy: () => null,
    setProxy: () => {},
  };
  const webview = {
    postMessage: async (message) => {
      messages.push(message);
      return true;
    },
  };
  return { loader: new LocalVolumeLoader(host), webview, messages, cacheCalls, enqueued };
}

test('cache hit posts cachedVolume with offsets and slice centers', async () => {
  await load();
  const ctx = makeLoader({ cached: makeCachedVolume() });

  await ctx.loader.startLocalLoad(ctx.webview, 'wv1', 'load1', makeUri(), new AbortController().signal, 1024);

  assert.equal(ctx.enqueued.length, 0, 'cache hit must not enqueue a load');
  assert.equal(ctx.messages.length, 1);

  const msg = ctx.messages[0];
  assert.equal(msg.type, 'cachedVolume');
  assert.equal(msg.voxOffset, 352);
  assert.equal(msg.voxelLength, 4 * 5 * 6 * 2);
  assert.equal(msg.voxelData.byteLength, 4 * 5 * 6 * 2);
  assert.equal(msg.datatype, 16);
  assert.equal(msg.globalMin, 0);
  assert.equal(msg.globalMax, 1);
  assert.deepEqual(msg.sliceIdx, { axial: 3, coronal: 2, sagittal: 2 });
  assert.deepEqual(ctx.cacheCalls.setActive, [['file:///tmp/a.nii', 'wv1']]);
});

test('queue path enqueues once and an aborted task posts nothing', async () => {
  await load();
  const ctx = makeLoader({ cached: null });
  const controller = new AbortController();

  await ctx.loader.startLocalLoad(ctx.webview, 'wv1', 'load1', makeUri(), controller.signal, 1024);

  assert.equal(ctx.enqueued.length, 1);
  const job = ctx.enqueued[0];
  assert.equal(job.webviewId, 'wv1');
  assert.equal(job.isRemote, false);

  controller.abort();
  await job.execute();

  assert.equal(ctx.messages.length, 0, 'aborted load must not post a volume');
});

test('enqueue priority follows webview activity', async () => {
  await load();

  const active = makeLoader({ cached: null, isActive: true });
  await active.loader.startLocalLoad(active.webview, 'wv-active', 'l1', makeUri(), new AbortController().signal, 1024);
  assert.equal(active.enqueued.length, 1);
  assert.equal(active.enqueued[0].priority, 100);
  assert.equal(active.enqueued[0].isRemote, false);

  const inactive = makeLoader({ cached: null, isActive: false });
  await inactive.loader.startLocalLoad(
    inactive.webview,
    'wv-inactive',
    'l2',
    makeUri(),
    new AbortController().signal,
    1024,
  );
  assert.equal(inactive.enqueued.length, 1);
  assert.equal(inactive.enqueued[0].priority, 1);
  assert.equal(inactive.enqueued[0].isRemote, false);
});

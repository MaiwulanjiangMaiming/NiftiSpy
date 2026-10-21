const test = require('node:test');
const assert = require('node:assert/strict');
const { sourceRuntime } = require('./helpers/source-runtime');

function poolRuntime(overrides = {}) {
  const sent = [];
  const ctx = sourceRuntime('webview/viewer.ts', ['SliceWorkerPool', 'getSlicePool'], {
    Worker: class {
      constructor(url) { assert.equal(url, 'blob:ready'); }
      postMessage(message) {
        assert.equal('signal' in message, false, 'AbortSignal must stay in the main thread');
        sent.push(message);
      }
      terminate() {}
    },
    navigator: { hardwareConcurrency: 1 }, slicePool: null, slicePoolInit: null,
    ensureWorkerBlobUrl: async () => 'blob:ready', attachWorkerRouter: () => {},
    makeAbortError: () => Object.assign(new Error('Cancelled'), { name: 'AbortError' }),
    nextWorkerRequestId: 1, workerRequests: new Map(), ...overrides,
  });
  return { ctx, sent };
}

function respond(ctx, message) {
  const request = ctx.workerRequests.get(message.id);
  ctx.workerRequests.delete(message.id);
  request.resolve({ type: 'slice', index: message.index });
}

test('three concurrent first slices wait for the same pool initialization', async () => {
  let ready;
  const { ctx, sent } = poolRuntime({ ensureWorkerBlobUrl: () => new Promise(resolve => { ready = resolve; }) });
  const requests = [0, 1, 2].map(async index => {
    const pool = await ctx.getSlicePool();
    return pool.dispatch({ type: 'fetchSlice', index, signal: new AbortController().signal });
  });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(sent.length, 0);
  ready('blob:ready');
  await new Promise(resolve => setImmediate(resolve));
  for (let i = 0; i < 3; i++) {
    assert.equal(sent[i].index, i);
    respond(ctx, sent[i]);
  }
  assert.deepEqual((await Promise.all(requests)).map(reply => reply.index), [0, 1, 2]);
});

test('an aborted queued slice is skipped and the next request still runs', async () => {
  const { ctx, sent } = poolRuntime();
  const pool = await ctx.getSlicePool();
  const first = pool.dispatch({ type: 'fetchSlice', index: 0 });
  const controller = new AbortController();
  const second = pool.dispatch({ type: 'fetchSlice', index: 1, signal: controller.signal });
  const rejected = assert.rejects(second, { name: 'AbortError' });
  const third = pool.dispatch({ type: 'fetchSlice', index: 2 });
  controller.abort();
  respond(ctx, sent[0]);
  assert.equal(sent[1].index, 2);
  respond(ctx, sent[1]);
  await Promise.all([first, rejected, third]);
  assert.equal(ctx.workerRequests.size, 0);
});

test('a failed postMessage releases its worker instead of exhausting the pool', async () => {
  let fail = true;
  const { ctx } = poolRuntime({ Worker: class {
    postMessage() { if (fail) throw new Error('Clone failed'); }
    terminate() {}
  } });
  const pool = await ctx.getSlicePool();
  await assert.rejects(pool.dispatch({ type: 'fetchSlice' }), /Clone failed/);
  assert.equal(ctx.workerRequests.size, 0);
  fail = false;
  const pending = pool.dispatch({ type: 'fetchSlice' });
  const id = [...ctx.workerRequests.keys()][0];
  assert.ok(id);
  respond(ctx, { id, index: 2 });
  await pending;
});

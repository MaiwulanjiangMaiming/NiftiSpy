const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const esbuild = require('esbuild');

let net;
let ready;

async function load() {
  if (ready) return ready;
  ready = (async () => {
    const outfile = path.join(__dirname, '..', 'dist', 'workerNet.node.cjs');
    await esbuild.build({
      entryPoints: [path.join(__dirname, '..', 'webview/worker/net.ts')],
      bundle: true,
      platform: 'node',
      format: 'cjs',
      outfile,
    });
    net = require(outfile);
  })();
  return ready;
}

function installFetch(t, impl) {
  const original = globalThis.fetch;
  globalThis.fetch = impl;
  t.after(() => {
    globalThis.fetch = original;
  });
}

function textResponse(body, status) {
  return new Response(body, { status });
}

test('fetchWithRetry sends the current priority header', async (t) => {
  await load();
  const seen = [];
  installFetch(t, async (_url, init) => {
    seen.push(init.headers.get('X-NiftiSpy-Priority'));
    return textResponse('ok', 200);
  });
  t.after(() => net.setVolumeFetchPriority('background'));

  const resp = await net.fetchWithRetry('http://127.0.0.1:1234/f');
  assert.equal(resp.status, 200);
  assert.deepEqual(seen, ['background']);

  net.setVolumeFetchPriority('user');
  await net.fetchWithRetry('http://127.0.0.1:1234/f');
  assert.deepEqual(seen, ['background', 'user']);
});

test('fetchWithRetry retries a 500 and succeeds', async (t) => {
  await load();
  let calls = 0;
  installFetch(t, async () => {
    calls++;
    return calls === 1 ? textResponse('boom', 500) : textResponse('ok', 200);
  });

  const resp = await net.fetchWithRetry('http://example.test/f', undefined, 2);
  assert.equal(resp.status, 200);
  assert.equal(calls, 2);
});

test('fetchWithRetry returns a non-retryable 404 after one call', async (t) => {
  await load();
  let calls = 0;
  installFetch(t, async () => {
    calls++;
    return textResponse('missing', 404);
  });

  const resp = await net.fetchWithRetry('http://example.test/f', undefined, 3);
  assert.equal(resp.status, 404);
  assert.equal(calls, 1);
});

test('fetchWithRetry throws AbortError without calling fetch for an aborted signal', async (t) => {
  await load();
  let calls = 0;
  installFetch(t, async () => {
    calls++;
    return textResponse('ok', 200);
  });

  await assert.rejects(net.fetchWithRetry('http://example.test/f', undefined, 3, AbortSignal.abort()), (err) => {
    assert.equal(err.name, 'AbortError');
    return true;
  });
  assert.equal(calls, 0);
});

test('readBodyWithWatchdog concatenates chunks and reports cumulative progress', async () => {
  await load();
  const chunks = [new Uint8Array([1, 2, 3]), new Uint8Array([4, 5])];
  let i = 0;
  const body = new ReadableStream({
    pull(controller) {
      if (i < chunks.length) controller.enqueue(chunks[i++]);
      else controller.close();
    },
  });
  const progress = [];

  const bytes = await net.readBodyWithWatchdog({ body }, 1000, undefined, (n) => progress.push(n));
  assert.deepEqual(Array.from(bytes), [1, 2, 3, 4, 5]);
  assert.deepEqual(progress, [3, 5]);
});

test('readBodyWithWatchdog rejects a stalled stream with TimeoutError', async () => {
  await load();
  const body = new ReadableStream({});

  await assert.rejects(net.readBodyWithWatchdog({ body }, 40), (err) => {
    assert.equal(err.name, 'TimeoutError');
    return true;
  });
});

test('readStreamChunkWithWatchdog reports done and times out on silence', async () => {
  await load();
  const doneReader = new ReadableStream({
    start(controller) {
      controller.close();
    },
  }).getReader();
  const result = await net.readStreamChunkWithWatchdog(doneReader, 1000);
  assert.equal(result.done, true);

  const stalledReader = new ReadableStream({}).getReader();
  await assert.rejects(net.readStreamChunkWithWatchdog(stalledReader, 30), (err) => {
    assert.equal(err.name, 'TimeoutError');
    return true;
  });
});

test('fetchHeadersWatchdog turns a stalled header phase into TimeoutError', async (t) => {
  await load();
  installFetch(t, (_url, init) => {
    return new Promise((_resolve, reject) => {
      const fail = () => reject(Object.assign(new Error('signal is aborted'), { name: 'AbortError' }));
      if (init.signal.aborted) fail();
      else init.signal.addEventListener('abort', fail, { once: true });
    });
  });

  await assert.rejects(net.fetchHeadersWatchdog('http://example.test/f', {}, 30), (err) => {
    assert.equal(err.name, 'TimeoutError');
    return true;
  });
});

test('fetchHeadersWatchdog propagates an external abort', async (t) => {
  await load();
  installFetch(t, (_url, init) => {
    return new Promise((_resolve, reject) => {
      const fail = () => reject(Object.assign(new Error('signal is aborted'), { name: 'AbortError' }));
      if (init.signal.aborted) fail();
      else init.signal.addEventListener('abort', fail, { once: true });
    });
  });

  const external = new AbortController();
  const pending = net.fetchHeadersWatchdog('http://example.test/f', {}, 5000, external.signal);
  setTimeout(() => external.abort(), 10);

  await assert.rejects(pending, (err) => {
    assert.equal(err.name, 'AbortError');
    return true;
  });
});

test('clampIdleTimeout clamps RTT-derived timeouts', async () => {
  await load();
  assert.equal(net.clampIdleTimeout(100), 5000);
  assert.equal(net.clampIdleTimeout(1000), 8000);
  assert.equal(net.clampIdleTimeout(10000), 30000);
});

test('chunk sizing prefers loopback and keeps exported constants stable', async () => {
  await load();
  assert.equal(net.CHUNK_SIZE, 16 * 1024 * 1024);
  assert.equal(net.MAX_RETRIES, 3);
  assert.equal(net.RETRY_DELAY_BASE, 500);
  assert.equal(net.DEFAULT_IDLE_TIMEOUT_MS, 20000);

  assert.equal(net.getPreferredChunkSize('http://127.0.0.1:1234/file'), 128 * 1024 * 1024);
  assert.equal(net.getPreferredChunkSize('http://example.test/file'), 16 * 1024 * 1024);
  assert.equal(net.getPreferredConcurrency('http://127.0.0.1:1234/file'), 16);
  assert.equal(net.getPreferredConcurrency('http://example.test/file'), 16);
});

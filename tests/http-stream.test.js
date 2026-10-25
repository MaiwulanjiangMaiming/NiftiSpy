const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const zlib = require('node:zlib');
const esbuild = require('esbuild');

const ROOT = path.join(__dirname, '..');
const OUTFILE = path.join(ROOT, 'dist', 'httpStream.node.cjs');

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

let bundle;
async function load() {
  if (bundle) return bundle;
  await esbuild.build({
    stdin: {
      contents: `
        export { handleFile, getHttpRemoteSize, streamHttpRangeToResponse, streamHttpToResponse, downloadHttpFileInChunks } from './src/proxy/httpStream';
        export { env as vscodeEnv } from 'vscode';
      `,
      resolveDir: ROOT,
      sourcefile: 'http-stream.entry.ts',
      loader: 'ts',
    },
    bundle: true,
    platform: 'node',
    format: 'cjs',
    outfile: OUTFILE,
    logLevel: 'silent',
    plugins: [
      {
        name: 'vscode-stub',
        setup(build) {
          build.onResolve({ filter: /^vscode$/ }, () => ({ path: 'vscode-stub', namespace: 'stub' }));
          build.onLoad({ filter: /^vscode-stub$/, namespace: 'stub' }, () => ({
            contents: VSCODE_STUB,
            loader: 'js',
          }));
        },
      },
    ],
  });
  bundle = require(OUTFILE);
  return bundle;
}

function makeCtx() {
  return { inflightFileStreams: new Set(), remoteSizeCache: new Map() };
}

function makePattern(size) {
  const buf = Buffer.alloc(size);
  for (let i = 0; i < size; i++) buf[i] = (i * 31 + 7) & 0xff;
  return buf;
}

function listen(server) {
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
  });
}

function stop(server) {
  return new Promise((resolve) => {
    server.closeAllConnections();
    server.close(() => resolve());
  });
}

/** Range-capable origin, mimicking a remote HTTP source. */
function makeOrigin(buffer) {
  const counters = { head: 0, get: 0 };
  const server = http.createServer((req, res) => {
    if (req.method === 'HEAD') {
      counters.head++;
      res.writeHead(200, { 'Content-Length': buffer.length, 'Accept-Ranges': 'bytes' });
      res.end();
      return;
    }
    counters.get++;
    const range = (req.headers['range'] || '').match(/bytes=(\d+)-(\d*)/);
    if (range) {
      const start = parseInt(range[1], 10);
      const end = range[2] ? Math.min(parseInt(range[2], 10), buffer.length - 1) : buffer.length - 1;
      res.writeHead(206, {
        'Content-Range': `bytes ${start}-${end}/${buffer.length}`,
        'Content-Length': end - start + 1,
        'Accept-Ranges': 'bytes',
      });
      res.end(buffer.subarray(start, end + 1));
      return;
    }
    res.writeHead(200, { 'Content-Length': buffer.length, 'Accept-Ranges': 'bytes' });
    res.end(buffer);
  });
  return { server, counters };
}

/** Proxy-side server that delegates every request to the production handleFile. */
function makeProxy(entry, ctx, handleFile) {
  return http.createServer((req, res) => {
    handleFile(entry, res, req, ctx).catch((err) => {
      if (!res.headersSent) res.writeHead(500, { 'Content-Type': 'text/plain' });
      res.end(String((err && err.message) || err));
    });
  });
}

function request(url, options = {}) {
  const { method = 'GET', headers = {} } = options;
  return new Promise((resolve, reject) => {
    const req = http.request(url, { method, headers, agent: false }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.on('error', reject);
    req.end();
  });
}

async function serve(t, entry, ctx, handleFile) {
  const server = makeProxy(entry, ctx, handleFile);
  const port = await listen(server);
  t.after(() => stop(server));
  return `http://127.0.0.1:${port}/file/1`;
}

function localEntry(fsPath, size) {
  return {
    uri: { scheme: 'file', fsPath, path: fsPath, toString: () => `file://${fsPath}` },
    dataUri: undefined,
    separateImg: false,
    id: '1',
    size,
  };
}

function remoteEntry(url) {
  const parsed = new URL(url);
  const uri = { scheme: parsed.protocol.slice(0, -1), fsPath: '', path: parsed.pathname, toString: () => url };
  return { uri, dataUri: uri, separateImg: false, id: 'remote' };
}

test('handleFile serves local files: range, full body, HEAD and 416', async (t) => {
  const { handleFile } = await load();
  const src = makePattern(1000);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'niftispy-http-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'vol.nii');
  fs.writeFileSync(file, src);
  const url = await serve(t, localEntry(file, src.length), makeCtx(), handleFile);

  const ranged = await request(url, { headers: { Range: 'bytes=100-199' } });
  assert.equal(ranged.status, 206);
  assert.equal(ranged.headers['content-range'], 'bytes 100-199/1000');
  assert.equal(ranged.headers['content-length'], '100');
  assert.deepEqual(ranged.body, src.subarray(100, 200));

  const full = await request(url);
  assert.equal(full.status, 200);
  assert.equal(full.headers['content-length'], '1000');
  assert.deepEqual(full.body, src);

  const head = await request(url, { method: 'HEAD' });
  assert.equal(head.status, 200);
  assert.equal(head.headers['content-length'], '1000');
  assert.equal(head.headers['accept-ranges'], 'bytes');
  assert.equal(head.body.length, 0);

  const invalid = await request(url, { headers: { Range: 'bytes=abc' } });
  assert.equal(invalid.status, 416);
  assert.equal(invalid.headers['content-range'], 'bytes */1000');
});

test('handleFile never gzip-compresses an already compressed .gz payload', async (t) => {
  const { handleFile, vscodeEnv } = await load();
  const src = makePattern(1000);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'niftispy-http-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const plain = path.join(dir, 'vol.nii');
  const gzipped = path.join(dir, 'vol.nii.gz');
  fs.writeFileSync(plain, src);
  fs.writeFileSync(gzipped, src);

  // A WAN remote makes shouldCompress() eligible, so the `.gz` extension rule
  // is what actually decides the outcome.
  vscodeEnv.remoteName = 'ssh-remote';
  t.after(() => {
    vscodeEnv.remoteName = undefined;
  });

  const gzUrl = await serve(t, localEntry(gzipped, src.length), makeCtx(), handleFile);
  const gz = await request(gzUrl, { headers: { 'Accept-Encoding': 'gzip' } });
  assert.equal(gz.status, 200);
  assert.equal(gz.headers['content-encoding'], undefined);
  assert.deepEqual(gz.body, src);

  const plainUrl = await serve(t, localEntry(plain, src.length), makeCtx(), handleFile);
  const compressed = await request(plainUrl, { headers: { 'Accept-Encoding': 'gzip' } });
  assert.equal(compressed.status, 200);
  assert.equal(compressed.headers['content-encoding'], 'gzip');
  assert.deepEqual(zlib.gunzipSync(compressed.body), src, 'positive control: plain files still compress');
});

test('getHttpRemoteSize returns Content-Length and caches it after one HEAD', async (t) => {
  const { getHttpRemoteSize } = await load();
  const src = makePattern(1000);
  const { server, counters } = makeOrigin(src);
  const port = await listen(server);
  t.after(() => stop(server));
  const url = `http://127.0.0.1:${port}/vol.nii`;
  const ctx = makeCtx();

  assert.equal(await getHttpRemoteSize(url, ctx), 1000);
  assert.equal(ctx.remoteSizeCache.get(url), 1000);
  assert.equal(await getHttpRemoteSize(url, ctx), 1000);
  assert.equal(counters.head, 1, 'the second lookup must be served from the cache');
});

test('handleFile forwards remote range and full requests without buffering', async (t) => {
  const { handleFile } = await load();
  const src = makePattern(1000);
  const { server } = makeOrigin(src);
  const port = await listen(server);
  t.after(() => stop(server));
  const remoteUrl = `http://127.0.0.1:${port}/vol.nii`;

  const rangeEntry = remoteEntry(remoteUrl);
  const rangeUrl = await serve(t, rangeEntry, makeCtx(), handleFile);
  const ranged = await request(rangeUrl, { headers: { Range: 'bytes=10-19' } });
  assert.equal(ranged.status, 206);
  assert.equal(ranged.headers['x-remote-source'], 'true');
  assert.equal(ranged.headers['content-range'], 'bytes 10-19/1000');
  assert.deepEqual(ranged.body, src.subarray(10, 20));
  assert.equal(rangeEntry.size, 1000, 'entry size is learned from Content-Range');

  const fullEntry = remoteEntry(remoteUrl);
  const fullUrl = await serve(t, fullEntry, makeCtx(), handleFile);
  const full = await request(fullUrl);
  assert.equal(full.status, 200);
  assert.equal(full.headers['x-remote-source'], 'true');
  assert.equal(full.headers['content-length'], '1000');
  assert.deepEqual(full.body, src);
  assert.equal(fullEntry.size, 1000, 'entry size is learned from Content-Length');
});

test('downloadHttpFileInChunks returns the exact bytes for a single-chunk file', async (t) => {
  const { downloadHttpFileInChunks } = await load();
  const src = makePattern(1000);
  const { server } = makeOrigin(src);
  const port = await listen(server);
  t.after(() => stop(server));
  const url = `http://127.0.0.1:${port}/vol.nii`;

  const data = await downloadHttpFileInChunks(url, src.length);
  assert.equal(data.byteLength, 1000);
  assert.deepEqual(Buffer.from(data), src);
});

test('downloadHttpFileInChunks reassembles a multi-chunk (>32MB) file', async (t) => {
  const { downloadHttpFileInChunks } = await load();
  const total = 33 * 1024 * 1024 + 123;
  const src = makePattern(total);
  const { server, counters } = makeOrigin(src);
  const port = await listen(server);
  t.after(() => stop(server));
  const url = `http://127.0.0.1:${port}/vol.nii`;

  const data = await downloadHttpFileInChunks(url, total);

  assert.equal(data.byteLength, total);
  assert.ok(counters.get >= 2, 'a >32MB payload must use several range requests');
  const boundary = 32 * 1024 * 1024;
  for (const index of [0, 1, 999, boundary - 1, boundary, total - 1]) {
    assert.equal(data[index], (index * 31 + 7) & 0xff, `byte ${index} must come from the right chunk`);
  }
});

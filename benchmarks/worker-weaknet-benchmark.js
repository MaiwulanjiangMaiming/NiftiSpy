#!/usr/bin/env node
/**
 * End-to-end benchmark of the built Worker under simulated weak network.
 *
 * Uses the actual dist/worker.js bundle in a Node.js Worker thread with
 * minimal polyfills. Serves a synthetic NIfTI volume with throttled bandwidth
 * and RTT, then measures:
 *   - time to first preview
 *   - time to full volume ready
 *   - effective throughput
 *
 * Usage:
 *   node benchmarks/worker-weaknet-benchmark.js [sizeMB] [gzip] [bandwidthMBps] [rttMs]
 */
const fs = require('fs');
const path = require('path');
const http = require('http');
const zlib = require('zlib');
const { Worker } = require('worker_threads');
const { promisify } = require('util');
const gzipAsync = promisify(zlib.gzip);

const SIZE_MB = Number(process.argv[2] || 50);
const USE_GZIP = process.argv[3] !== 'false';
const BW_MBPS = Number(process.argv[4] || 5);
const RTT_MS = Number(process.argv[5] || 500);
const OUT_DIR = path.join(__dirname, '..', 'benchmarks', 'tmp');

const NX = 256;
const NY = 256;
const NZ = Math.ceil((SIZE_MB * 1024 * 1024) / (NX * NY * 4));
const N = NX * NY * NZ;
const HEADER_SIZE = 348;

function writeNiftiHeader(buf) {
  const view = new DataView(buf.buffer, buf.byteOffset, HEADER_SIZE);
  view.setInt16(0, 348, true);
  view.setInt16(40, 3, true);
  view.setInt16(42, NX, true);
  view.setInt16(44, NY, true);
  view.setInt16(46, NZ, true);
  view.setInt16(70, 16, true);
  view.setInt16(72, 32, true);
  view.setFloat32(108, 352, true); // vox_offset: NIfTI-1 minimum (header + 4-byte padding)
  view.setFloat32(76, 1, true);
  view.setFloat32(80, 1, true);
  view.setFloat32(84, 1, true);
  view.setFloat32(88, 1, true);
  view.setFloat32(112, 1, true);
  view.setFloat32(116, 0, true);
  view.setFloat32(120, 0, true);
  view.setFloat32(124, 0, true);
  view.setFloat32(252, 1, true);
}

async function ensureFixture() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const baseName = `weaknet_${NX}x${NY}x${NZ}_${SIZE_MB}MB`;
  const niiPath = path.join(OUT_DIR, baseName + '.nii');
  const gzPath = niiPath + '.gz';

  if (!fs.existsSync(niiPath)) {
    console.log(`[fixture] Creating uncompressed ${SIZE_MB}MB NIfTI`);
    const fd = fs.openSync(niiPath, 'w');
    const header = Buffer.alloc(HEADER_SIZE);
    writeNiftiHeader(header);
    fs.writeSync(fd, header);
    // NIfTI-1 requires vox_offset >= 352, so pad 4 bytes between header and data.
    fs.writeSync(fd, Buffer.alloc(4));
    const CHUNK_VOXELS = 1024 * 1024;
    const chunk = Buffer.alloc(CHUNK_VOXELS * 4);
    let written = 0;
    while (written < N) {
      const batch = Math.min(CHUNK_VOXELS, N - written);
      const dv = new DataView(chunk.buffer, chunk.byteOffset, batch * 4);
      for (let i = 0; i < batch; i++) {
        const v = ((Math.sin((written + i) * 0.001) + 1) * 500 + ((written + i) % 137));
        dv.setFloat32(i * 4, v, true);
      }
      fs.writeSync(fd, chunk.subarray(0, batch * 4));
      written += batch;
    }
    fs.closeSync(fd);
  }

  if (USE_GZIP && !fs.existsSync(gzPath)) {
    console.log('[fixture] Gzipping...');
    const data = fs.readFileSync(niiPath);
    const compressed = await gzipAsync(data, { level: 6 });
    fs.writeFileSync(gzPath, compressed);
  }

  return USE_GZIP ? gzPath : niiPath;
}

function startServer(filePath) {
  const file = fs.readFileSync(filePath);
  const totalSize = file.length;
  const throttleEnabled = BW_MBPS > 0;
  const bytesPerMsGlobal = throttleEnabled ? (BW_MBPS * 1024 * 1024) / 1000 : Infinity;
  let totalBytesSent = 0;
  let throttleStartTime = 0;
  let throttleQueue = Promise.resolve();

  async function sendThrottled(res, data, status, headers) {
    if (RTT_MS > 0) await new Promise(r => setTimeout(r, RTT_MS));
    res.writeHead(status, headers);
    if (!throttleEnabled) {
      res.end(data);
      return;
    }
    const CHUNK = 64 * 1024;
    for (let off = 0; off < data.length; off += CHUNK) {
      const chunk = data.subarray(off, Math.min(off + CHUNK, data.length));
      const waitForTurn = throttleQueue;
      let resolveNext = () => {};
      throttleQueue = new Promise(r => { resolveNext = r; });
      await waitForTurn;
      if (throttleStartTime === 0) throttleStartTime = performance.now();
      const elapsedMs = performance.now() - throttleStartTime;
      const expectedBytes = elapsedMs * bytesPerMsGlobal;
      const delayMs = totalBytesSent > expectedBytes ? (totalBytesSent - expectedBytes) / bytesPerMsGlobal : 0;
      if (delayMs > 0) await new Promise(r => setTimeout(r, delayMs));
      totalBytesSent += chunk.length;
      res.write(chunk);
      resolveNext();
    }
    res.end();
  }

  const server = http.createServer((req, res) => {
    const range = req.headers.range || '';
    const m = range.match(/bytes=(\d+)-(\d*)/);
    if (m) {
      const start = parseInt(m[1], 10);
      const end = m[2] ? parseInt(m[2], 10) : totalSize - 1;
      void sendThrottled(res, file.subarray(start, end + 1), 206, {
        'Content-Range': `bytes ${start}-${end}/${totalSize}`,
        'Content-Length': end - start + 1,
        'Accept-Ranges': 'bytes',
        'Access-Control-Allow-Origin': '*',
        'X-Remote-Source': 'true',
      });
    } else {
      void sendThrottled(res, file, 200, {
        'Content-Length': totalSize,
        'Accept-Ranges': 'bytes',
        'Access-Control-Allow-Origin': '*',
        'X-Remote-Source': 'true',
      });
    }
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      resolve({ server, port, url: `http://127.0.0.1:${port}/vol${USE_GZIP ? '.nii.gz' : '.nii'}`, totalSize });
    });
  });
}

// Bootstrap code injected into the worker before importing dist/worker.js.
// It provides browser globals that the bundle expects (fetch, DecompressionStream).
const WORKER_BOOTSTRAP = `
// Node 18+ fetch is available on the global object in workers too; if not,
// this benchmark is not supported.
if (typeof fetch === 'undefined') {
  throw new Error('global fetch is required (Node.js 18+)');
}

// The worker bundle uses "self" as its global and expects onmessage/postMessage.
// Node.js Worker threads expose globalThis but not self; alias it and wire up
// parentPort so the browser-style messaging API works.
globalThis.self = globalThis;
const { parentPort } = require('worker_threads');
if (parentPort) {
  globalThis.postMessage = (...args) => parentPort.postMessage(...args);
  let messageHandler = null;
  Object.defineProperty(globalThis, 'onmessage', {
    get() { return messageHandler; },
    set(fn) {
      if (messageHandler) parentPort.off('message', messageHandler);
      messageHandler = (msg) => fn({ data: msg });
      if (fn) parentPort.on('message', messageHandler);
    },
  });
}

const zlib = require('zlib');
globalThis.DecompressionStream = class DecompressionStream {
  constructor(format) {
    const nodeStream = format === 'gzip' ? zlib.createGunzip() : zlib.createInflate();
    const writable = new WritableStream({
      write(chunk) { nodeStream.write(chunk); },
      close() { nodeStream.end(); },
      abort() { nodeStream.destroy(); },
    });
    const readable = new ReadableStream({
      start(controller) {
        nodeStream.on('data', (d) => controller.enqueue(new Uint8Array(d.buffer, d.byteOffset, d.byteLength)));
        nodeStream.on('end', () => controller.close());
        nodeStream.on('error', (err) => controller.error(err));
      },
      cancel() { nodeStream.destroy(); },
    });
    this.readable = readable;
    this.writable = writable;
  }
};

require(require('worker_threads').workerData.workerPath);
`;

async function main() {
  const filePath = await ensureFixture();
  const { server, url, totalSize } = await startServer(filePath);
  console.log(`\n[server] Serving ${USE_GZIP ? 'gzipped' : 'uncompressed'} file at ${url}`);
  console.log(`[server] Total on-wire size: ${(totalSize / 1024 / 1024).toFixed(1)}MB`);
  console.log(`[network] Simulated bandwidth: ${BW_MBPS} MB/s, RTT: ${RTT_MS}ms\n`);

  const workerPath = path.join(__dirname, '..', 'dist', 'worker.js');
  const worker = new Worker(WORKER_BOOTSTRAP, {
    eval: true,
    workerData: { workerPath },
  });

  let previewMs = null;
  let volumeMs = null;
  const startedAt = performance.now();

  const resultPromise = new Promise((resolve, reject) => {
    worker.on('message', (msg) => {
      const now = performance.now();
      if (msg.type === 'preview' && previewMs === null) {
        previewMs = now - startedAt;
      }
      if (msg.type === 'progress' && previewMs === null && msg.stage?.includes('decompressing')) {
        previewMs = now - startedAt;
      }
      if (msg.type === 'volume') {
        volumeMs = now - startedAt;
        resolve(msg);
      }
      if (msg.type === 'error') {
        reject(new Error(msg.error));
      }
    });
    worker.on('error', reject);
  });

  worker.postMessage({
    id: 1,
    type: 'loadVolume',
    url,
    isGzip: USE_GZIP,
    directUrl: '',
    estimatedBps: BW_MBPS * 8 * 1024 * 1024,
    estimatedRttMs: RTT_MS,
  });

  try {
    await resultPromise;
    console.log('========== Worker Weak-Net Benchmark ==========');
    console.log(`Volume dimensions:     ${NX} x ${NY} x ${NZ}`);
    console.log(`Uncompressed size:     ${SIZE_MB.toFixed(1)} MB`);
    console.log(`On-wire size:          ${(totalSize / 1024 / 1024).toFixed(1)} MB`);
    console.log(`Time to first preview: ${previewMs?.toFixed(2) ?? 'N/A'} ms`);
    console.log(`Time to volume ready:  ${volumeMs?.toFixed(2) ?? 'N/A'} ms`);
    console.log(`Effective throughput:  ${((totalSize / 1024 / 1024) / (volumeMs / 1000)).toFixed(2)} MB/s`);
    console.log('===============================================');
  } catch (err) {
    console.error('Benchmark failed:', err);
  } finally {
    await worker.terminate();
    server.close();
  }
}

main().catch(console.error);

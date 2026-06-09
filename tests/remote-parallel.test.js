const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');

// ---------------------------------------------------------------------------
// Mirror of the bounded-concurrency parallel download pool implemented in
// webview/worker.ts (downloadChunked). Kept in sync here so the reassembly
// invariants are testable without the browser/worker runtime.
// ---------------------------------------------------------------------------
async function parallelDownload(totalSize, chunkSize, concurrency, fetchRange) {
  const numChunks = Math.ceil(totalSize / chunkSize);
  const slots = new Array(numChunks).fill(null);
  let nextIndex = 0;
  let maxInFlight = 0;
  let inFlight = 0;

  const downloadChunkAt = async (chunkIndex) => {
    const offset = chunkIndex * chunkSize;
    const end = Math.min(offset + chunkSize - 1, totalSize - 1);
    inFlight++;
    maxInFlight = Math.max(maxInFlight, inFlight);
    try {
      slots[chunkIndex] = await fetchRange(offset, end);
    } finally {
      inFlight--;
    }
  };

  const poolWorker = async () => {
    while (true) {
      const idx = nextIndex++;
      if (idx >= numChunks) return;
      await downloadChunkAt(idx);
    }
  };

  const workers = [];
  const c = Math.min(concurrency, numChunks);
  for (let i = 0; i < c; i++) workers.push(poolWorker());
  await Promise.all(workers);

  const result = new Uint8Array(totalSize);
  let pos = 0;
  for (const chunk of slots) {
    assert.ok(chunk, 'every chunk slot must be filled');
    result.set(chunk, pos);
    pos += chunk.byteLength;
  }
  return { result, maxInFlight, numChunks };
}

function makeSource(totalSize) {
  const src = new Uint8Array(totalSize);
  for (let i = 0; i < totalSize; i++) src[i] = (i * 2654435761) & 0xff; // deterministic
  return src;
}

test('parallel download reassembles bytes in order despite out-of-order completion', async () => {
  const totalSize = 7 * 1024 * 1024 + 123; // not a chunk multiple
  const chunkSize = 1024 * 1024;
  const src = makeSource(totalSize);

  // Randomized per-chunk latency forces chunks to complete out of order.
  const fetchRange = async (start, end) => {
    await new Promise((r) => setTimeout(r, Math.floor(Math.random() * 12)));
    return src.subarray(start, end + 1);
  };

  const { result, maxInFlight, numChunks } = await parallelDownload(totalSize, chunkSize, 6, fetchRange);

  assert.equal(result.byteLength, totalSize);
  assert.deepEqual(Buffer.from(result), Buffer.from(src), 'reassembled buffer must equal source');
  assert.ok(maxInFlight > 1, 'pool must actually run requests concurrently');
  assert.ok(maxInFlight <= 6, 'pool must respect the concurrency cap');
  assert.equal(numChunks, Math.ceil(totalSize / chunkSize));
});

test('parallel download is correct when concurrency exceeds chunk count', async () => {
  const totalSize = 3000;
  const chunkSize = 1024;
  const src = makeSource(totalSize);
  const fetchRange = async (start, end) => src.subarray(start, end + 1);
  const { result, maxInFlight } = await parallelDownload(totalSize, chunkSize, 16, fetchRange);
  assert.deepEqual(Buffer.from(result), Buffer.from(src));
  assert.ok(maxInFlight <= 3, 'never more in-flight than there are chunks');
});

// ---------------------------------------------------------------------------
// readHttpPartial mirror (io/fileReader.ts) — validates that ranged GETs
// against a real origin return exactly the requested bytes, and that issuing
// the ranges concurrently still reassembles the full payload correctly. This
// is the behavior the proxy now relies on for true range passthrough.
// ---------------------------------------------------------------------------
function readHttpPartial(urlStr, start, end) {
  return new Promise((resolve, reject) => {
    const url = new URL(urlStr);
    const req = http.request(
      { hostname: url.hostname, port: url.port, path: url.pathname, method: 'GET', headers: { Range: `bytes=${start}-${end}` } },
      (res) => {
        if (res.statusCode !== 206 && res.statusCode !== 200) { reject(new Error(`HTTP ${res.statusCode}`)); return; }
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => resolve(new Uint8Array(Buffer.concat(chunks))));
      }
    );
    req.on('error', reject);
    req.end();
  });
}

test('range passthrough: concurrent ranged GETs reassemble the full origin file', async () => {
  const totalSize = 2 * 1024 * 1024 + 777;
  const src = Buffer.from(makeSource(totalSize));

  // Minimal range-capable origin, mimicking what the proxy fetches from.
  const origin = http.createServer((req, res) => {
    if (req.method === 'HEAD') {
      res.writeHead(200, { 'Content-Length': totalSize, 'Accept-Ranges': 'bytes' });
      res.end();
      return;
    }
    const m = (req.headers['range'] || '').match(/bytes=(\d+)-(\d*)/);
    if (m) {
      const start = parseInt(m[1]);
      const end = m[2] ? parseInt(m[2]) : totalSize - 1;
      res.writeHead(206, {
        'Content-Range': `bytes ${start}-${end}/${totalSize}`,
        'Content-Length': end - start + 1,
        'Accept-Ranges': 'bytes',
      });
      res.end(src.subarray(start, end + 1));
    } else {
      res.writeHead(200, { 'Content-Length': totalSize, 'Accept-Ranges': 'bytes' });
      res.end(src);
    }
  });

  await new Promise((r) => origin.listen(0, '127.0.0.1', r));
  const port = origin.address().port;
  const base = `http://127.0.0.1:${port}/vol.nii`;

  try {
    // Single ranged read returns exactly the requested window.
    const mid = await readHttpPartial(base, 1000, 1099);
    assert.equal(mid.byteLength, 100);
    assert.deepEqual(Buffer.from(mid), src.subarray(1000, 1100));

    // Concurrent ranged reads via the parallel pool reassemble the whole file.
    const chunkSize = 256 * 1024;
    const { result } = await parallelDownload(totalSize, chunkSize, 6, (s, e) => readHttpPartial(base, s, e));
    assert.deepEqual(Buffer.from(result), src, 'parallel ranged download must equal origin file');
  } finally {
    await new Promise((r) => origin.close(r));
  }
});

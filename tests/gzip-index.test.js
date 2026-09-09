const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');
const esbuild = require('esbuild');

let GzipIndex;
let loadCachedIndex;
let saveCachedIndex;
let tmpDir;
let ready;

async function ensureModule() {
  if (ready) return ready;
  ready = (async () => {
    const outfile = path.join(__dirname, '..', 'dist', 'gzipIndex.node.cjs');
    await esbuild.build({
      entryPoints: [path.join(__dirname, '..', 'src/io/gzipIndex.ts')],
      bundle: true,
      platform: 'node',
      format: 'cjs',
      outfile,
    });
    const mod = require(outfile);
    GzipIndex = mod.GzipIndex;
    loadCachedIndex = mod.loadCachedIndex;
    saveCachedIndex = mod.saveCachedIndex;
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'niftispy-gzip-'));
  })();
  return ready;
}

function writeGzip(name, raw) {
  const gzPath = path.join(tmpDir, name);
  fs.writeFileSync(gzPath, zlib.gzipSync(raw, { level: 6 }));
  return gzPath;
}

test('gzip index round-trips random ranges', async () => {
  await ensureModule();
  const raw = Buffer.alloc(2 * 1024 * 1024);
  for (let i = 0; i < raw.length; i++) raw[i] = (i * 13 + (i >> 8)) & 0xff;
  const gzPath = writeGzip('random.nii.gz', raw);
  const index = await GzipIndex.buildIndex(gzPath);
  assert.ok(index.entries.length >= 1);
  assert.equal(index.entries[0].decompressedOffset, 0);
  assert.equal(index.entries[0].bits, 0);

  const ranges = [
    [0, 64],
    [1000, 1250],
    [1024 * 1024, 1024 * 1024 + 512],
    [raw.length - 100, raw.length],
  ];
  for (const [start, end] of ranges) {
    const got = Buffer.from(await GzipIndex.readRange(gzPath, index, start, end));
    assert.equal(got.length, end - start);
    assert.ok(got.equals(raw.subarray(start, end)), `mismatch ${start}-${end}`);
  }
});

test('gzip index handles leftover bits on compressible data', async () => {
  await ensureModule();
  const raw = Buffer.alloc(3 * 1024 * 1024, 0);
  for (let i = 0; i < 400; i++) raw[i] = i & 0xff;
  for (let z = 0; z < 40; z++) {
    for (let i = 0; i < 128; i++) raw[1024 + z * 65536 + i] = (z + i) & 0xff;
  }
  const gzPath = writeGzip('sparse.nii.gz', raw);
  const index = await GzipIndex.buildIndex(gzPath);
  const withBits = index.entries.filter(e => e.bits > 0);
  assert.ok(index.entries.length >= 1);
  const start = 2 * 1024 * 1024;
  const got = Buffer.from(await GzipIndex.readRange(gzPath, index, start, start + 4096));
  assert.ok(got.equals(raw.subarray(start, start + 4096)));
  void withBits;
});

test('gzip index sidecar round-trips and rejects the old format', async () => {
  await ensureModule();
  const raw = Buffer.alloc(256 * 1024, 7);
  const gzPath = writeGzip('cache.nii.gz', raw);
  const index = await GzipIndex.buildIndex(gzPath);
  await saveCachedIndex(gzPath, index);
  const loaded = await loadCachedIndex(gzPath);
  assert.ok(loaded);
  assert.equal(loaded.gzipHeaderLength, index.gzipHeaderLength);
  assert.equal(loaded.entries.length, index.entries.length);
  assert.equal(loaded.entries[0].compressedOffset, index.entries[0].compressedOffset);

  const stale = path.join(tmpDir, 'stale.nii.gz');
  fs.writeFileSync(stale, zlib.gzipSync(raw));
  const oldCache = Buffer.alloc(32);
  oldCache.writeUInt32LE(fs.statSync(stale).size, 0);
  oldCache.writeDoubleLE(fs.statSync(stale).mtimeMs, 4);
  oldCache.writeUInt32LE(0, 12);
  fs.writeFileSync(stale + '.niftispy-index', oldCache);
  assert.equal(await loadCachedIndex(stale), null);
});

test('gzip scanRange visits the same bytes as readRange', async () => {
  await ensureModule();
  const raw = Buffer.alloc(512 * 1024);
  for (let i = 0; i < raw.length; i++) raw[i] = (i * 17) & 0xff;
  const gzPath = writeGzip('scan.nii.gz', raw);
  const index = await GzipIndex.buildIndex(gzPath);
  const start = 1000;
  const end = 1000 + 8000;
  const fromRead = Buffer.from(await GzipIndex.readRange(gzPath, index, start, end));
  const chunks = [];
  await GzipIndex.scanRange(gzPath, index, start, end, (abs, chunk) => {
    chunks.push({ abs, buf: Buffer.from(chunk) });
  });
  const assembled = Buffer.alloc(end - start);
  for (const { abs, buf } of chunks) {
    buf.copy(assembled, abs - start);
  }
  assert.ok(assembled.equals(fromRead));
  assert.ok(assembled.equals(raw.subarray(start, end)));
});

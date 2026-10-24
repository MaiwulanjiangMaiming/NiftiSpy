const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { gzipSync } = require('node:zlib');
const { productionRuntime } = require('./helpers/production-runtime');
const { sourceRuntime } = require('./helpers/source-runtime');

function fixture({ nx = 32, ny = 32, nz = 32, nt = 1, big = false, blank = false } = {}) {
  const raw = Buffer.alloc(352 + nx * ny * nz * nt * 2);
  const i16 = (v, off) => raw[big ? 'writeInt16BE' : 'writeInt16LE'](v, off);
  const i32 = (v, off) => raw[big ? 'writeInt32BE' : 'writeInt32LE'](v, off);
  const f32 = (v, off) => raw[big ? 'writeFloatBE' : 'writeFloatLE'](v, off);
  i32(348, 0); i16(nt > 1 ? 4 : 3, 40);
  [nx, ny, nz, nt].forEach((v, i) => i16(v, 42 + i * 2));
  i16(4, 70); i16(16, 72);
  [1, 1, 1, 1].forEach((v, i) => f32(v, 76 + i * 4));
  f32(352, 108); f32(2, 112); f32(10, 116);
  raw.write('n+1\0', 344);
  for (let t = 0; t < nt; t++) for (let z = 0; z < nz; z++) for (let y = 0; y < ny; y++) for (let x = 0; x < nx; x++) {
    const v = blank || z < 3 ? 0 : t * 500 + z * 10 + y + x;
    i16(v, 352 + 2 * (((t * nz + z) * ny + y) * nx + x));
  }
  return raw;
}
function setup(t, raw = fixture()) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'niftispy-p0-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const file = path.join(directory, 'volume.nii'), gz = file + '.gz';
  fs.writeFileSync(file, raw); fs.writeFileSync(gz, gzipSync(raw));
  return { directory, file, gz, cache: path.join(directory, 'cache'), raw };
}

test('all local axes preserve endian/scaling/4D values and sample on the server', async t => {
  const p = await productionRuntime();
  for (const big of [false, true]) {
    const f = setup(t, fixture({ nx: 9, ny: 11, nz: 13, nt: 2, big }));
    const h = p.parseNiiHeaderQuick(f.raw);
    for (const axis of ['axial', 'coronal', 'sagittal']) {
      const full = p.extractSingleSlice(f.raw, h, axis, 5, 1);
      for (const factor of [1, 2, 4, 32]) {
        const actual = await p.extractLocalSlice(f.file, h, axis, 5, 1, factor);
        const expected = p.sampleSlice(full, axis === 'sagittal' ? h.ny : h.nx, axis === 'axial' ? h.ny : h.nz, factor);
        assert.deepEqual(actual, expected, `${axis} f${factor} endian=${big}`);
      }
      assert.equal(await p.extractLocalSlice(f.file, h, axis, -1), null);
    }
    fs.truncateSync(f.file, 360);
    await assert.rejects(p.extractLocalSlice(f.file, h, 'sagittal', 5), /Truncated/);
  }
});

test('seekable cache is atomic, single-flight, and invalidated by same-size source rewrites', async t => {
  const p = await productionRuntime(), f = setup(t);
  let decoded = 0;
  const options = { directory: f.cache, onChunk: b => { decoded += b.length; } };
  const paths = await Promise.all(Array.from({ length: 8 }, () => p.unpackGzipToCache(f.gz, options)));
  assert.ok(paths[0]); assert.equal(new Set(paths).size, 1); assert.equal(decoded, f.raw.length);
  assert.deepEqual(fs.readFileSync(paths[0]), f.raw);
  assert.equal(fs.readdirSync(f.cache).some(n => n.includes('.tmp')), false);
  assert.equal(await p.unpackGzipToCache(f.gz, options), paths[0]); assert.equal(decoded, f.raw.length);
  // Preserve length and mtime: ctime/inode must still invalidate the source identity.
  const st = fs.statSync(f.gz), next = Buffer.from(f.raw); next.writeInt16LE(777, 352 + 2 * 10 * 32 * 32);
  fs.writeFileSync(f.gz, gzipSync(next)); fs.utimesSync(f.gz, st.atime, st.mtime);
  const rebuilt = await p.unpackGzipToCache(f.gz, { directory: f.cache });
  assert.notEqual(rebuilt, paths[0]); assert.deepEqual(fs.readFileSync(rebuilt), next);
});

test('quota fallback, LRU eviction, cancellation, corruption and source changes clean temporary output', async t => {
  const p = await productionRuntime(), f = setup(t, fixture({ nx: 64, ny: 64, nz: 64 }));
  assert.equal(await p.unpackGzipToCache(f.gz, { directory: f.cache, budgetBytes: 1 }), null);
  const options = { directory: f.cache, budgetBytes: f.raw.length + 1024 };
  const first = await p.unpackGzipToCache(f.gz, options);
  const secondGz = path.join(f.directory, 'second.nii.gz'); fs.copyFileSync(f.gz, secondGz);
  const originalUnlink = fs.promises.unlink;
  fs.promises.unlink = async file => {
    if (file === first) throw Object.assign(new Error('in use'), { code: 'EPERM' });
    return originalUnlink.call(fs.promises, file);
  };
  try { assert.equal(await p.unpackGzipToCache(secondGz, options), null, 'failed eviction must not bypass the disk quota'); }
  finally { fs.promises.unlink = originalUnlink; }
  const second = await p.unpackGzipToCache(secondGz, options);
  assert.ok(second); assert.equal(fs.existsSync(first), false); assert.equal(fs.existsSync(first + '.json'), false);
  const ac = new AbortController();
  fs.unlinkSync(second); fs.unlinkSync(second + '.json');
  await assert.rejects(p.unpackGzipToCache(secondGz, { ...options, signal: ac.signal, onChunk: () => ac.abort() }), e => e.name === 'AbortError');
  assert.equal(fs.readdirSync(f.cache).some(n => n.includes('.tmp')), false);
  let changed = false;
  assert.equal(await p.unpackGzipToCache(secondGz, { ...options, onChunk: () => { if (!changed) { changed = true; const st = fs.statSync(secondGz); fs.utimesSync(secondGz, st.atime, new Date(st.mtimeMs + 1000)); } } }), null);
  fs.truncateSync(secondGz, 50);
  assert.equal(await p.unpackGzipToCache(secondGz, options), null);
  assert.equal(fs.readdirSync(f.cache).some(n => n.includes('.tmp')), false);
});

test('cold preview skips background; warm preview and lowres volume persist without rebuilding', async t => {
  const p = await productionRuntime(), f = setup(t);
  const session = p.GzipScanSession.start(f.gz, undefined, undefined, { directory: f.cache });
  assert.equal(p.GzipScanSession.start(f.gz), session, 'same source shares one scan');
  const first = await session.z0;
  assert.equal(first.sliceIdx.axial, 3); assert.ok(first.axial.some(v => v !== 10));
  const final = await session.ortho; await session.done;
  assert.equal(final.sliceIdx.axial, 16);
  for (const plane of [final.axial, final.coronal, final.sagittal]) assert.ok(plane.some(v => v !== 10 && v !== 0));
  assert.ok(fs.existsSync(session.unpackPath + '.preview'));
  const warm = p.GzipScanSession.start(f.gz, undefined, undefined, { directory: f.cache });
  const restored = await warm.ortho; await warm.done;
  assert.deepEqual(restored, final); assert.deepEqual(warm.lod, session.lod);
  assert.equal(warm.index, null); assert.equal(warm.unpackPath, session.unpackPath);
  fs.writeFileSync(session.unpackPath + '.preview', 'broken cache');
  const repaired = p.GzipScanSession.start(f.gz, undefined, undefined, { directory: f.cache });
  assert.deepEqual((await repaired.ortho).axial, final.axial); await repaired.done;
  assert.deepEqual(repaired.lod.volume, session.lod.volume);
});

test('empty volumes settle a center preview; a read-only cache retains the indexed fallback', async t => {
  const p = await productionRuntime(), f = setup(t, fixture({ blank: true }));
  const cacheFile = path.join(f.directory, 'not-a-directory'); fs.writeFileSync(cacheFile, 'x');
  const session = p.GzipScanSession.start(f.gz, undefined, undefined, { directory: cacheFile });
  const preview = await session.ortho;
  assert.equal(preview.sliceIdx.axial, 16);
  assert.ok(await session.done);
  const warm = p.GzipScanSession.start(f.gz, undefined, undefined, { budgetBytes: 0 });
  const restored = await warm.ortho; await warm.done;
  assert.deepEqual(restored.axial, preview.axial);
  assert.deepEqual(restored.coronal, preview.coronal);
  assert.deepEqual(restored.sagittal, preview.sagittal);
});

test('SSH forwarded localhost slices expose dimensions, compress losslessly, and separate factor/time caches', async t => {
  const p = await productionRuntime(), f = setup(t, fixture({ nx: 64, ny: 64, nz: 64, nt: 2 }));
  p.testConfig.remoteCacheDirectory = f.cache;
  const proxy = new p.LocalFileProxy(); await proxy.start(); t.after(() => proxy.stop());
  const url = proxy.registerFile({ scheme: 'file', fsPath: f.gz, toString: () => `file://${f.gz}` });
  const header = p.parseNiiHeaderQuick(f.raw);
  for (const axis of ['axial', 'coronal', 'sagittal']) for (const factor of [1, 4, 1]) {
    const response = await fetch(url.replace('/file/', '/slice/') + `/${axis}/32?factor=${factor}&t=1`);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('X-Width'), String(64 / factor)); assert.equal(response.headers.get('X-Height'), String(64 / factor));
    assert.match(response.headers.get('Access-Control-Expose-Headers'), /X-Width/);
    assert.match(response.headers.get('Server-Timing'), /slice;dur=/);
    assert.equal(response.headers.get('X-NiftiSpy-Slice-Format'), 'raw');
    assert.equal(response.headers.get('X-NiftiSpy-Dtype'), '4');
    const bytes = await response.arrayBuffer();
    assert.equal(bytes.byteLength, (64 / factor) * (64 / factor) * 2);
    if (bytes.byteLength >= 1024) assert.equal(response.headers.get('Content-Encoding'), 'gzip');
    const actual = p.decodeRawSlice(
      bytes,
      Number(response.headers.get('X-NiftiSpy-Dtype')),
      Number(response.headers.get('X-NiftiSpy-Slope')),
      Number(response.headers.get('X-NiftiSpy-Inter')),
      64 / factor,
      64 / factor,
    );
    assert.deepEqual(actual, p.sampleSlice(p.extractSingleSlice(f.raw, header, axis, 32, 1), 64, 64, factor));
    assert.ok(Number(response.headers.get('Content-Length')) <= bytes.byteLength);
  }
  assert.ok(proxy.getEntry(url.split('/').pop()).unpackPath);
  const entry = proxy.getEntry(url.split('/').pop());
  fs.unlinkSync(entry.unpackPath); // LRU eviction is repaired before the next slice.
  const again = await fetch(url.replace('/file/', '/slice/') + '/axial/33'); assert.equal(again.status, 200); await again.arrayBuffer();
  assert.equal(p.shouldCompress({ headers: { 'accept-encoding': 'gzip;q=0', host: 'localhost' } }), false);
});

test('proxy routes require the session capability token and restrict CORS', async t => {
  const p = await productionRuntime(), f = setup(t);
  const proxy = new p.LocalFileProxy(); await proxy.start(); t.after(() => proxy.stop());
  const url = proxy.registerFile({ scheme: 'file', fsPath: f.file, toString: () => `file://${f.file}` });
  const sliceUrl = url.replace('/file/', '/slice/') + '/axial/16';

  const good = await fetch(sliceUrl);
  assert.equal(good.status, 200);
  assert.equal(good.headers.get('X-Content-Type-Options'), 'nosniff');
  await good.arrayBuffer();

  const stripped = sliceUrl.replace(/\/[^/]+\/slice\//, '/slice/');
  const forbidden = await fetch(stripped);
  assert.equal(forbidden.status, 403);

  const evil = await fetch(sliceUrl, { headers: { Origin: 'https://evil.example' } });
  assert.equal(evil.status, 200);
  assert.equal(evil.headers.get('Access-Control-Allow-Origin'), null);
  await evil.arrayBuffer();

  const webview = await fetch(sliceUrl, { headers: { Origin: 'vscode-webview://test' } });
  assert.equal(webview.headers.get('Access-Control-Allow-Origin'), 'vscode-webview://test');
  assert.match(webview.headers.get('Vary'), /Origin/);
  await webview.arrayBuffer();
});

test('decodeRawSlice applies native dtype and slope/inter', async () => {
  const p = await productionRuntime();
  const bytes = new Int16Array([1, -2, 3]).buffer;
  assert.deepEqual([...p.decodeRawSlice(bytes, 4, 2, 10, 3, 1)], [12, 6, 16]);
  assert.deepEqual([...p.decodeRawSlice(new Uint8Array([1, 255]).buffer, 2, 1, 0, 2, 1)], [1, 255]);
  assert.equal(p.decodeRawSlice(bytes, 16, 1, 0, 3, 1), null);
});

test('persistent slice frames retain exact dimensions and reject mixed factors/truncation', async () => {
  const p = await productionRuntime();
  const data = new Float32Array([1, -2, 3, 4, 5, 6]);
  const bytes = p.encodeSliceFrame(data, 3, 2, 4), frame = p.decodeSliceFrame(bytes, 4);
  assert.deepEqual(frame, { data, width: 3, height: 2 });
  assert.equal(p.decodeSliceFrame(bytes, 1), null); assert.equal(p.decodeSliceFrame(bytes.slice(0, -4), 4), null);
  assert.notEqual(p.makeSliceCacheKey('file', 'axial', 1, 0, 1), p.makeSliceCacheKey('file', 'axial', 1, 0, 4));
  assert.notEqual(p.makeSliceCacheKey('file', 'axial', 1, 0, 1), p.makeSliceCacheKey('file', 'axial', 1, 1, 1));
});

test('late orthogonal previews cannot override scrolling, file identity or full-volume completion', () => {
  const planes = new Float32Array([1, 2, 3, 4]), updated = [];
  const context = sourceRuntime('webview/viewer.ts', ['applyRemoteOrthoPreview'], {
    volumeData: null, fullVolumeLoaded: false, fileUrl: 'current', remotePreviewToken: 'v1', lastScrollTime: 0, remotePreviewStartedAt: 100,
    header: { nx: 2, ny: 2, nz: 2 }, toFloat32Array: a => a,
    setCurrentSlice: (axis, data) => { updated.push(axis); context.currentSlices[axis] = { data }; },
    sliceIdx: { axial: 0, coronal: 0, sagittal: 0 }, globalMin: 0, globalMax: 1,
    images: [{}], activeImageIdx: 0, currentSlices: {}, updateSliderValues() {}, renderAllViews() {},
  });
  const msg = { url: 'current', validationToken: 'v1', sliceIdx: { axial: 1, coronal: 1, sagittal: 1 }, axialSlice: planes, coronalSlice: planes, sagittalSlice: planes, globalMin: 1, globalMax: 4 };
  context.applyRemoteOrthoPreview({ ...msg, url: 'other' }); assert.equal(updated.length, 0);
  context.applyRemoteOrthoPreview({ ...msg, validationToken: 'old' }); assert.equal(updated.length, 0);
  context.lastScrollTime = 101; context.applyRemoteOrthoPreview(msg); assert.equal(updated.length, 0);
  context.lastScrollTime = 0; context.applyRemoteOrthoPreview(msg); assert.equal(updated.length, 3); assert.equal(context.sliceIdx.axial, 1);
  context.volumeData = planes; context.fullVolumeLoaded = true; context.applyRemoteOrthoPreview(msg); assert.equal(updated.length, 3);
});

test('orthogonal reads keep one descriptor and bound scratch memory independently of volume depth', async t => {
  const p = await productionRuntime(), f = setup(t, fixture({ nx: 512, ny: 512, nz: 64, blank: true }));
  const h = p.parseNiiHeaderQuick(f.raw), original = fs.promises.open;
  let handles = 0, peakHandles = 0, maxRead = 0, readBytes = 0;
  fs.promises.open = async (...args) => {
    const fd = await original.apply(fs.promises, args), read = fd.read, close = fd.close;
    handles++; peakHandles = Math.max(peakHandles, handles);
    fd.read = async function (buffer, offset, length, position) {
      maxRead = Math.max(maxRead, length); readBytes += length;
      return read.call(this, buffer, offset, length, position);
    };
    fd.close = async function () { handles--; return close.call(this); };
    return fd;
  };
  try { await p.extractLocalSlice(f.file, h, 'sagittal', 256, 0, 4); }
  finally { fs.promises.open = original; }
  assert.equal(peakHandles, 1); assert.equal(handles, 0); assert.ok(maxRead <= 8 * 1024 ** 2);
  assert.ok(readBytes <= (f.raw.length - 352) / 4, 'coarse slices skip unsampled z planes');
});

test('actual worker restores dimensioned frames and tolerates unavailable IndexedDB', async () => {
  const p = await productionRuntime(), db = new Map(), ram = new Map();
  let fetches = 0, dbUnavailable = false;
  const context = sourceRuntime('webview/worker.ts', ['fetchSlice', 'buildSliceUrl', 'getSliceCacheKey', 'getCachedSlice', 'setCachedSlice'], {
    currentFileHash: 'identity-one', sliceCache: ram, pendingSliceFetches: new Map(), MAX_SLICE_CACHE: 50, MAX_RETRIES: 1, URL,
    makeSliceCacheKey: p.makeSliceCacheKey, encodeSliceFrame: p.encodeSliceFrame, decodeSliceFrame: p.decodeSliceFrame,
    ensureSliceCacheDB: async () => { if (dbUnavailable) throw new Error('disabled'); return { get: async key => db.get(key), put: async (key, val) => db.set(key, val), evictLRU: async () => {} }; },
    getCachedChunk: async () => null, setCachedChunk: async () => {}, makeCacheKey: (...v) => v.join('|'),
    recordCacheHit() {}, recordCacheMiss() {}, recordL4Fetch() {}, self: { postMessage() {} },
    fetchWithRetry: async url => {
      fetches++;
      const factor = Number(new URL(url).searchParams.get('factor')) || 1, w = 8 / factor;
      return new Response(new Float32Array(w * w).fill(fetches).buffer, { headers: { 'X-Width': String(w), 'X-Height': String(w), 'Content-Length': String(w * w * 4) } });
    },
  });
  const url = 'http://localhost/file/1';
  await context.fetchSlice(url, 'axial', 2, 4); ram.clear();
  const restored = await context.fetchSlice(url, 'axial', 2, 4);
  assert.equal(fetches, 1); assert.equal(restored.width, 2); assert.equal(restored.height, 2); assert.equal(restored.data.length, 4);
  const full = await context.fetchSlice(url, 'axial', 2, 1); assert.equal(fetches, 2); assert.equal(full.width, 8);
  context.currentFileHash = 'identity-two';
  await context.fetchSlice(url, 'axial', 2, 4); assert.equal(fetches, 3, 'memory and disk entries cannot cross file identities');
  dbUnavailable = true;
  assert.equal((await context.fetchSlice(url, 'axial', 3, 1)).width, 8);
});

test('one cancelled consumer does not abort another consumer of the shared disk build', async t => {
  const p = await productionRuntime(), f = setup(t, fixture({ nx: 64, ny: 64, nz: 64 }));
  const ac = new AbortController();
  const first = p.unpackGzipToCache(f.gz, { directory: f.cache, signal: ac.signal, onChunk: () => ac.abort() });
  const second = p.unpackGzipToCache(f.gz, { directory: f.cache });
  const [cancelled, completed] = await Promise.allSettled([first, second]);
  assert.equal(cancelled.status, 'rejected'); assert.equal(cancelled.reason.name, 'AbortError');
  assert.equal(completed.status, 'fulfilled'); assert.ok(completed.value);
  assert.deepEqual(fs.readFileSync(completed.value), f.raw);
  assert.equal(fs.readdirSync(f.cache).some(n => n.includes('.tmp')), false);
});

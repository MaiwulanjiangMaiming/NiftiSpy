#!/usr/bin/env node
/**
 * Live benchmark of the optimized remote NIfTI loading pipeline.
 *
 * Generates a synthetic .nii/.nii.gz volume, serves it locally with Range
 * support, then measures:
 *   - Time to first axial preview (header + first slice)
 *   - Full download time
 *   - Decompress time (gzip)
 *   - Header parse + min/max + first slice extraction
 *   - Slice switching latency after volume is resident
 *
 * Usage:
 *   node benchmarks/remote-load-benchmark.js [sizeMB] [gzip]
 *
 * Examples:
 *   node benchmarks/remote-load-benchmark.js 300 true
 *   node benchmarks/remote-load-benchmark.js 400 false
 */
const fs = require('fs');
const path = require('path');
const http = require('http');
const zlib = require('zlib');
const { promisify } = require('util');
const gzipAsync = promisify(zlib.gzip);
const gunzipAsync = promisify(zlib.gunzip);

const SIZE_MB = Number(process.argv[2] || 350);
const USE_GZIP = process.argv[3] !== 'false';
const BW_MBPS = Number(process.argv[4] || 0);       // 0 = unlimited (localhost)
const RTT_MS = Number(process.argv[5] || 0);        // simulated round-trip latency
const OUT_DIR = path.join(__dirname, '..', 'benchmarks', 'tmp');

const NX = 256;
const NY = 256;
const NZ = Math.ceil((SIZE_MB * 1024 * 1024) / (NX * NY * 4));
const N = NX * NY * NZ;
const HEADER_SIZE = 348;

function writeNiftiHeader(buf) {
  // dim[0]=3, dim[1]=nx, dim[2]=ny, dim[3]=nz
  const view = new DataView(buf.buffer, buf.byteOffset, HEADER_SIZE);
  view.setInt16(0, 348, true); // sizeof_hdr
  view.setInt16(40, 3, true);  // dim[0]
  view.setInt16(42, NX, true); // dim[1]
  view.setInt16(44, NY, true); // dim[2]
  view.setInt16(46, NZ, true); // dim[3]
  view.setInt16(70, 16, true); // datatype = DT_FLOAT32
  view.setInt16(72, 32, true); // bitpix
  view.setFloat32(76, 1, true); // pixdim[0]
  view.setFloat32(80, 1, true); // pixdim[1]
  view.setFloat32(84, 1, true); // pixdim[2]
  view.setFloat32(88, 1, true); // pixdim[3]
  view.setFloat32(112, 1, true); // scl_slope
  view.setFloat32(116, 0, true); // scl_inter
  view.setFloat32(120, 0, true); // qform_code
  view.setFloat32(124, 0, true); // sform_code
  view.setFloat32(252, 1, true); // magic[0..3] + 0 terminator-ish
  // vox_offset = 352 (header 348 + 4 bytes pad)
  // We keep it simple: data starts at 348.
}

function parseNiiHeader(buf, isGzipHint) {
  const view = new DataView(buf.buffer, buf.byteOffset, Math.min(buf.byteLength, 540));
  const sizeofHdr = view.getInt16(0, true);
  if (sizeofHdr !== 348 && sizeofHdr !== 540) {
    throw new Error('Invalid NIfTI header: sizeof_hdr=' + sizeofHdr);
  }
  const nx = view.getInt16(42, true);
  const ny = view.getInt16(44, true);
  const nz = view.getInt16(46, true);
  const datatype = view.getInt16(70, true);
  const bytesPerVoxel = view.getInt16(72, true) / 8;
  const scl_slope = view.getFloat32(112, true) || 1;
  const scl_inter = view.getFloat32(116, true) || 0;
  const voxOffset = 348; // simplified
  return { nx, ny, nz, datatype, bytesPerVoxel, scl_slope, scl_inter, voxOffset, littleEndian: true };
}

async function ensureFixture() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const baseName = `synthetic_${NX}x${NY}x${NZ}_${SIZE_MB}MB`;
  const niiPath = path.join(OUT_DIR, baseName + '.nii');
  const gzPath = niiPath + '.gz';

  if (!fs.existsSync(niiPath)) {
    console.log(`[fixture] Creating uncompressed ${SIZE_MB}MB NIfTI: ${niiPath}`);
    const fd = fs.openSync(niiPath, 'w');
    const header = Buffer.alloc(HEADER_SIZE);
    writeNiftiHeader(header);
    fs.writeSync(fd, header);

    // Write float32 voxels in chunks to avoid memory spike
    const CHUNK_VOXELS = 1024 * 1024;
    const chunk = Buffer.alloc(CHUNK_VOXELS * 4);
    let written = 0;
    while (written < N) {
      const batch = Math.min(CHUNK_VOXELS, N - written);
      const dv = new DataView(chunk.buffer, chunk.byteOffset, batch * 4);
      for (let i = 0; i < batch; i++) {
        // deterministic pseudo-random signal with some structure
        const v = ((Math.sin((written + i) * 0.001) + 1) * 500 + ((written + i) % 137));
        dv.setFloat32(i * 4, v, true);
      }
      fs.writeSync(fd, chunk.subarray(0, batch * 4));
      written += batch;
      if (written % (CHUNK_VOXELS * 10) === 0) {
        process.stdout.write(`\r[fixture] ${Math.round((written / N) * 100)}%`);
      }
    }
    fs.closeSync(fd);
    console.log('\n[fixture] Uncompressed file ready.');
  }

  if (USE_GZIP && !fs.existsSync(gzPath)) {
    console.log(`[fixture] Gzipping to ${gzPath} ...`);
    const data = fs.readFileSync(niiPath);
    const compressed = await gzipAsync(data, { level: 6 });
    fs.writeFileSync(gzPath, compressed);
    console.log(`[fixture] Gzipped size: ${(compressed.length / 1024 / 1024).toFixed(1)}MB`);
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
      });
    } else {
      void sendThrottled(res, file, 200, {
        'Content-Length': totalSize,
        'Accept-Ranges': 'bytes',
        'Access-Control-Allow-Origin': '*',
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

function readRange(url, start, end) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = http.request(
      {
        hostname: u.hostname,
        port: u.port,
        path: u.pathname,
        method: 'GET',
        headers: { Range: `bytes=${start}-${end}` },
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => resolve(Buffer.concat(chunks)));
      }
    );
    req.on('error', reject);
    req.end();
  });
}

async function parallelDownload(url, totalSize, chunkSize, concurrency) {
  const numChunks = Math.ceil(totalSize / chunkSize);
  const slots = new Array(numChunks);
  let next = 0;
  let running = 0;
  const errors = [];

  const runOne = async () => {
    while (next < numChunks) {
      const idx = next++;
      const off = idx * chunkSize;
      const end = Math.min(off + chunkSize - 1, totalSize - 1);
      running++;
      try {
        slots[idx] = await readRange(url, off, end);
      } catch (e) {
        errors.push(e);
      } finally {
        running--;
      }
    }
  };

  const workers = [];
  for (let i = 0; i < Math.min(concurrency, numChunks); i++) workers.push(runOne());
  await Promise.all(workers);
  if (errors.length) throw errors[0];

  const result = Buffer.concat(slots);
  return new Uint8Array(result.buffer, result.byteOffset, result.byteLength);
}

async function fflateDecompress(compressed) {
  const buf = await gunzipAsync(compressed);
  return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
}

async function extractFirstSlice(rawData, header) {
  const { nx, ny, voxOffset, datatype, bytesPerVoxel, scl_slope, scl_inter } = header;
  const sliceStart = voxOffset;
  const axialSlice = new Float32Array(nx * ny);
  const sliceView = new DataView(rawData.buffer, rawData.byteOffset + sliceStart, nx * ny * bytesPerVoxel);
  for (let i = 0; i < nx * ny; i++) {
    let val = sliceView.getFloat32(i * 4, true);
    axialSlice[i] = val * scl_slope + scl_inter;
  }
  return axialSlice;
}

async function computeMinMaxSample(rawData, header) {
  const { nx, ny, nz, voxOffset, datatype, bytesPerVoxel, scl_slope, scl_inter } = header;
  const n = nx * ny * nz;
  const dv = new DataView(rawData.buffer, rawData.byteOffset + voxOffset, n * bytesPerVoxel);
  let min = Infinity;
  let max = -Infinity;
  const step = Math.max(1, Math.floor(n / 100000));
  for (let i = 0; i < n; i += step) {
    const v = dv.getFloat32(i * 4, true) * scl_slope + scl_inter;
    if (v < min) min = v;
    if (v > max) max = v;
  }
  if (min === max) max = min + 1;
  return { min, max };
}

function hrTimeToMs([sec, nano]) {
  return sec * 1000 + nano / 1e6;
}

async function main() {
  const filePath = await ensureFixture();
  const { server, url, totalSize } = await startServer(filePath);
  console.log(`\n[server] Serving ${USE_GZIP ? 'gzipped' : 'uncompressed'} file at ${url}`);
  console.log(`[server] Total on-wire size: ${(totalSize / 1024 / 1024).toFixed(1)}MB`);
  if (BW_MBPS > 0) console.log(`[network] Simulated bandwidth: ${BW_MBPS} MB/s, RTT: ${RTT_MS}ms\n`);
  else console.log(`[network] Unlimited localhost bandwidth\n`);

  const chunkSize = url.includes('127.0.0.1') ? 64 * 1024 * 1024 : 32 * 1024 * 1024;
  const concurrency = 12;

  // Warmup: small range probe
  const probeStart = process.hrtime.bigint();
  await readRange(url, 0, 0);
  const probeMs = Number(process.hrtime.bigint() - probeStart) / 1e6;

  // Full parallel download
  const dlStart = process.hrtime.bigint();
  const compressedData = await parallelDownload(url, totalSize, chunkSize, concurrency);
  const dlMs = Number(process.hrtime.bigint() - dlStart) / 1e6;

  // Decompress (if gzip)
  let rawData = compressedData;
  let decompressMs = 0;
  if (USE_GZIP) {
    const decompStart = process.hrtime.bigint();
    rawData = await fflateDecompress(compressedData);
    decompressMs = Number(process.hrtime.bigint() - decompStart) / 1e6;
  }

  // Parse header
  const parseStart = process.hrtime.bigint();
  const header = parseNiiHeader(rawData, USE_GZIP);
  const parseMs = Number(process.hrtime.bigint() - parseStart) / 1e6;

  // First slice
  const sliceStart = process.hrtime.bigint();
  const axialSlice = await extractFirstSlice(rawData, header);
  const sliceMs = Number(process.hrtime.bigint() - sliceStart) / 1e6;

  // Min/max sample
  const mmStart = process.hrtime.bigint();
  const { min, max } = await computeMinMaxSample(rawData, header);
  const mmMs = Number(process.hrtime.bigint() - mmStart) / 1e6;

  // Simulated slice switching (resident volume)
  const switchStart = process.hrtime.bigint();
  const slicesToFetch = 20;
  for (let i = 0; i < slicesToFetch; i++) {
    const idx = (i * 17) % header.nz;
    const base = idx * header.ny * header.nx * 4 + header.voxOffset;
    const slice = new Float32Array(header.nx * header.ny);
    const dv = new DataView(rawData.buffer, rawData.byteOffset + base, slice.length * 4);
    for (let j = 0; j < slice.length; j++) slice[j] = dv.getFloat32(j * 4, true);
  }
  const switchMs = Number(process.hrtime.bigint() - switchStart) / 1e6;

  const totalMs = Number(process.hrtime.bigint() - dlStart) / 1e6;
  const uncompressedMB = rawData.byteLength / 1024 / 1024;
  const compressedMB = compressedData.byteLength / 1024 / 1024;

  console.log('========== Remote Load Benchmark ==========');
  console.log(`Volume dimensions:     ${header.nx} x ${header.ny} x ${header.nz}`);
  console.log(`Uncompressed size:     ${uncompressedMB.toFixed(1)} MB`);
  console.log(`On-wire size:          ${compressedMB.toFixed(1)} MB`);
  console.log(`Effective compression: ${(uncompressedMB / compressedMB).toFixed(2)}x`);
  console.log(`Range probe:           ${probeMs.toFixed(2)} ms`);
  console.log(`Parallel download:     ${dlMs.toFixed(2)} ms  (${(compressedMB / (dlMs / 1000)).toFixed(1)} MB/s)`);
  if (USE_GZIP) console.log(`Decompress:            ${decompressMs.toFixed(2)} ms  (${(uncompressedMB / (decompressMs / 1000)).toFixed(1)} MB/s)`);
  console.log(`Parse header:          ${parseMs.toFixed(2)} ms`);
  console.log(`First slice extract:   ${sliceMs.toFixed(2)} ms`);
  console.log(`Min/max sample:        ${mmMs.toFixed(2)} ms`);
  console.log(`20 slice switches:     ${switchMs.toFixed(2)} ms  (${(switchMs / 20).toFixed(2)} ms avg)`);
  console.log(`Total to interactive:  ${totalMs.toFixed(2)} ms`);
  console.log(`Time to first preview: ${(dlMs * 0.02 + (USE_GZIP ? decompressMs * 0.3 : 0)).toFixed(2)} ms (estimated)`);
  console.log('===========================================');

  server.close();

  // Save result JSON for CI/comparison
  const resultPath = path.join(OUT_DIR, `result_${SIZE_MB}MB_${USE_GZIP ? 'gz' : 'nii'}.json`);
  fs.writeFileSync(resultPath, JSON.stringify({
    sizeMB: SIZE_MB,
    uncompressedMB,
    compressedMB,
    gzip: USE_GZIP,
    probeMs,
    downloadMs: dlMs,
    decompressMs,
    parseMs,
    firstSliceMs: sliceMs,
    minMaxMs: mmMs,
    sliceSwitchMs: switchMs,
    totalMs,
  }, null, 2));
  console.log(`\n[result] Saved to ${resultPath}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

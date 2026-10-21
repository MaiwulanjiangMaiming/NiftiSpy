#!/usr/bin/env node
/**
 * Profile the actual host-side gzip/slice implementation, without packaging
 * or changing the extension. Run: node benchmarks/remote-gzip-profile.js 64 256
 * Uses synthetic uint16 NIfTI data; timings are local, not SSH measurements.
 */
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const zlib = require('node:zlib');
const { pipeline } = require('node:stream/promises');
const { monitorEventLoopDelay } = require('node:perf_hooks');
const esbuild = require('esbuild');

const root = path.join(__dirname, '..');
const out = path.join(__dirname, 'tmp');
const sizeMiB = Number(process.argv[2] || 64);
const nx = Number(process.argv[3] || 256), ny = nx;
const nz = Math.ceil(sizeMiB * 1024 * 1024 / (nx * ny * 2));
const results = { date: new Date().toISOString(), environment: {
  platform: process.platform, arch: process.arch, node: process.version,
}, shape: [nx, ny, nz], measurements: {} };

async function loadProduction() {
  const built = await esbuild.build({
    stdin: { contents: `
      export * from './src/io/gzipScan';
      export * from './src/io/gzipIndex';
      export * from './src/nifti/sliceExtractor';
      export * from './src/LocalFileProxy';
      export * from './src/remoteEnv';
      export { profileConfig } from 'vscode';
    `, resolveDir: root, loader: 'ts' },
    bundle: true, platform: 'node', format: 'cjs', write: false,
    plugins: [{ name: 'vscode-boundary', setup(build) {
      build.onResolve({ filter: /^vscode$/ }, () => ({ path: 'vscode', namespace: 'stub' }));
      build.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({ contents: `
        import * as fs from 'node:fs';
        export const env = { remoteName: 'ssh-remote' };
        export const profileConfig = {};
        export const workspace = {
          getConfiguration: () => ({ get: (key, fallback) => profileConfig[key] ?? fallback }),
          fs: { stat: uri => fs.promises.stat(uri.fsPath), readFile: uri => fs.promises.readFile(uri.fsPath) }
        };
      ` }));
    } }],
  });
  const filename = path.join(out, 'profile-runtime.cjs');
  const mod = new Module(filename, module);
  mod.filename = filename;
  mod.paths = Module._nodeModulePaths(path.dirname(filename));
  mod._compile(built.outputFiles[0].text, filename);
  return mod.exports;
}

async function measure(name, action) {
  const delay = monitorEventLoopDelay({ resolution: 10 });
  delay.enable();
  const started = performance.now();
  const value = await action();
  const ms = performance.now() - started;
  delay.disable();
  results.measurements[name] = { ms: +ms.toFixed(2), maxEventLoopDelayMs: +(delay.max / 1e6).toFixed(2) };
  console.log(`${name}: ${ms.toFixed(1)}ms`);
  return value;
}

function signalPresent(array) { return array.some(value => value !== 0); }

async function main() {
  fs.mkdirSync(out, { recursive: true });
  const prod = await loadProduction();
  const base = path.join(out, `host-profile-${nx}x${ny}x${nz}`);
  const nii = base + '.nii', gz = nii + '.gz';
  if (!fs.existsSync(gz)) {
    console.log(`Generating synthetic ${sizeMiB}MiB fixture...`);
    const data = Buffer.alloc(352 + nx * ny * nz * 2);
    data.writeInt32LE(348, 0);
    data.writeInt16LE(3, 40);
    [nx, ny, nz, 1].forEach((value, i) => data.writeInt16LE(value, 42 + i * 2));
    data.writeInt16LE(512, 70); data.writeInt16LE(16, 72);
    [1, 1, 1, 1].forEach((value, i) => data.writeFloatLE(value, 76 + i * 4));
    data.writeFloatLE(352, 108); data.writeFloatLE(1, 112); data.write('n+1\0', 344);
    let seed = 123456789;
    for (let z = 0; z < nz; z++) for (let y = 0; y < ny; y++) for (let x = 0; x < nx; x++) {
      const radius = ((x - nx / 2) / (nx * .44)) ** 2 +
        ((y - ny / 2) / (ny * .44)) ** 2 + ((z - nz / 2) / (nz * .44)) ** 2;
      if (radius >= 1) continue;
      seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5;
      const value = 1000 + Math.floor((1 - radius) * 2000) + (seed & 255);
      data.writeUInt16LE(value, 352 + 2 * (z * nx * ny + y * nx + x));
    }
    fs.writeFileSync(nii, data);
    await pipeline(fs.createReadStream(nii), zlib.createGzip(), fs.createWriteStream(gz));
  }
  // Regenerate only this benchmark's disposable index to measure a cold open.
  const sidecar = prod.getIndexCachePath(gz);
  fs.rmSync(sidecar, { force: true });
  results.rawBytes = fs.statSync(nii).size;
  results.compressedBytes = fs.statSync(gz).size;
  const cacheDirectory = base + '.cache';
  fs.rmSync(cacheDirectory, { recursive: true, force: true });
  prod.profileConfig.remoteCacheDirectory = cacheDirectory;
  const cacheOptions = { directory: cacheDirectory };
  const start = performance.now();
  const session = prod.GzipScanSession.start(gz, undefined, undefined, cacheOptions);
  const z0 = await measure('coldZ0', () => session.z0);
  results.z0HasSignal = signalPresent(z0.axial);
  const ortho = await measure('remainingUntilOrtho', () => session.ortho);
  results.coldOrthoFromOpenMs = +(performance.now() - start).toFixed(2);
  await session.done;
  results.seekableCachePath = session.unpackPath;
  const index = await measure('fallbackIndexBuild', () => prod.GzipIndex.buildIndex(gz));
  await prod.saveCachedIndex(gz, index);
  results.indexEntries = index.entries.length;
  results.sidecarBytes = fs.statSync(sidecar).size;
  const warm = await measure('warmSessionReady', async () => {
    const next = prod.GzipScanSession.start(gz, undefined, undefined, cacheOptions);
    const preview = await next.ortho;
    await next.done;
    return preview;
  });
  results.warmOrthoHasSignal = { axial: signalPresent(warm.axial),
    coronal: signalPresent(warm.coronal), sagittal: signalPresent(warm.sagittal) };

  const scan = prod.GzipIndex.scanRange;
  let decoded = 0;
  prod.GzipIndex.scanRange = async (...args) => {
    const visit = args[4];
    args[4] = (abs, bytes) => { decoded += bytes.byteLength; return visit(abs, bytes); };
    return scan.apply(prod.GzipIndex, args);
  };
  for (const [axis, position] of [['axial', Math.floor(nz / 2)], ['coronal', ny / 2], ['sagittal', nx / 2]]) {
    decoded = 0;
    const slice = await measure(`indexed_${axis}`, () => prod.extractSliceFromGzipIndex(gz, index, ortho.header, axis, position));
    results.measurements[`indexed_${axis}`].visitedDecodedBytes = decoded;
    results.measurements[`indexed_${axis}`].responseBytes = slice.byteLength;
  }

  const unpacked = base + '.native-unpacked.nii';
  await measure('nativeStreamUnpack', () => pipeline(fs.createReadStream(gz), zlib.createGunzip(), fs.createWriteStream(unpacked)));
  for (const [axis, extract, position] of [
    ['coronal', prod.extractCoronalSliceFromRange, ny / 2],
    ['sagittal', prod.extractSagittalSliceFromRange, nx / 2],
  ]) {
    await measure(`unpacked_${axis}`, () => extract(unpacked, ortho.header, position));
  }

  const proxy = new prod.LocalFileProxy();
  await proxy.start();
  try {
    const url = proxy.registerFile({ scheme: 'file', fsPath: nii, toString: () => `file://${nii}` });
    const sliceUrl = url.replace('/file/', '/slice/') + `/axial/${Math.floor(nz / 2)}`;
    const bytes = [];
    const encodings = [];
    for (const factor of [1, 4]) {
      const response = await fetch(sliceUrl + `?factor=${factor}`);
      if (!response.ok) throw new Error(`Slice HTTP ${response.status}`);
      const data = Buffer.from(await response.arrayBuffer());
      bytes.push(data.byteLength);
      encodings.push(response.headers.get('Content-Encoding'));
      if (factor === 1) results.sliceGzipLevel1Bytes = zlib.gzipSync(data, { level: 1 }).byteLength;
    }
    results.sliceFactorResponseBytes = { factor1: bytes[0], factor4: bytes[1] };
    results.sliceContentEncoding = encodings;
    const gzipUrl = proxy.registerFile({ scheme: 'file', fsPath: gz, toString: () => `file://${gz}` });
    for (const axis of ['axial', 'coronal', 'sagittal']) {
      const requestUrl = gzipUrl.replace('/file/', '/slice/') + `/${axis}/${Math.floor((axis === 'coronal' ? ny : axis === 'sagittal' ? nx : nz) / 2)}`;
      const samples = [];
      for (let i = 0; i < 10; i++) {
        const response = await fetch(requestUrl + `?factor=${i % 2 ? 4 : 1}`);
        const data = await response.arrayBuffer();
        if (!response.ok) throw new Error(`Gzip ${axis} failed: ${response.status}`);
        samples.push({ server: response.headers.get('Server-Timing'), decodedBytes: data.byteLength, wireBytes: Number(response.headers.get('Content-Length')) });
      }
      results.measurements[`proxyGzip_${axis}`] = { samples };
    }
  } finally { proxy.stop(); }

  // Highly compressible large masks can be tiny on disk. The current routing
  // policy sees only compressed bytes, even when the voxel volume is large.
  const maskGzipBytes = zlib.gzipSync(Buffer.alloc(64 * 1024 * 1024)).byteLength;
  results.compressibleMaskRouting = { rawMiB: 64, compressedBytes: maskGzipBytes,
    sliceMode: prod.shouldUseSliceMode(maskGzipBytes, 'ssh-remote') };
  const report = base + '.json';
  fs.writeFileSync(report, JSON.stringify(results, null, 2) + '\n');
  console.log(`Report: ${report}`);
  console.log(JSON.stringify(results, null, 2));
}

main().catch(error => { console.error(error); process.exitCode = 1; });

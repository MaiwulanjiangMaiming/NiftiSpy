const path = require('path');
const native = require(path.join(__dirname, '..', 'niftispy_native.darwin-arm64.node'));

const TEST_FILE = '/Users/rock/Documents/PKU_projects/GRAFT-MRI/graft_v2.1/results/recon_hr.nii.gz';

function formatMB(bytes) {
  return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
}

function formatTime(ms) {
  return ms.toFixed(1) + ' ms';
}

async function benchParallel(n = 5) {
  console.log('═══ Parallel (rusty-rapidgzip, all cores) ═══');
  const times = [];
  let totalBytes = 0;

  // warm up
  const warmup = await native.fastDecompressGzipParallelAsync(TEST_FILE);
  totalBytes = warmup.length;

  for (let i = 0; i < n; i++) {
    const t0 = Date.now();
    const result = await native.fastDecompressGzipParallelAsync(TEST_FILE);
    const elapsed = Date.now() - t0;
    const mb = result.length / (1024 * 1024);
    const throughput = mb / (elapsed / 1000);
    times.push(elapsed);
    console.log(`  run ${i + 1}: ${formatTime(elapsed)}, ${throughput.toFixed(0)} MB/s`);
  }

  const avg = times.reduce((a, b) => a + b, 0) / times.length;
  const mb = totalBytes / (1024 * 1024);
  const throughput = mb / (avg / 1000);
  console.log(`  avg: ${formatTime(avg)}, ${throughput.toFixed(0)} MB/s\n`);
  return avg;
}

async function benchOneshot(n = 5) {
  console.log('═══ Oneshot (libdeflate, single core) ═══');
  const times = [];
  let totalBytes = 0;

  // warm up
  const warmup = await native.fastDecompressGzipFileAsync(TEST_FILE);
  totalBytes = warmup.length;

  for (let i = 0; i < n; i++) {
    const t0 = Date.now();
    const result = await native.fastDecompressGzipFileAsync(TEST_FILE);
    const elapsed = Date.now() - t0;
    const mb = result.length / (1024 * 1024);
    const throughput = mb / (elapsed / 1000);
    times.push(elapsed);
    console.log(`  run ${i + 1}: ${formatTime(elapsed)}, ${throughput.toFixed(0)} MB/s`);
  }

  const avg = times.reduce((a, b) => a + b, 0) / times.length;
  const mb = totalBytes / (1024 * 1024);
  const throughput = mb / (avg / 1000);
  console.log(`  avg: ${formatTime(avg)}, ${throughput.toFixed(0)} MB/s\n`);
  return avg;
}

async function main() {
  console.log(`Test file: ${TEST_FILE}`);
  console.log(`Decompressed size: ${formatMB(465 * 1024 * 1024)}\n`);

  const par = await benchParallel(5);
  const one = await benchOneshot(5);

  console.log('═══ Summary ═══');
  console.log(`  Parallel (rusty-rapidgzip): ${formatTime(par)}`);
  console.log(`  Oneshot (libdeflate):       ${formatTime(one)}`);
  console.log(`  Speedup: ${(one / par).toFixed(2)}x`);
}

main().catch(console.error);

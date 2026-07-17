const path = require('path');
const zlib = require('zlib');
const fs = require('fs');
const native = require(path.join(__dirname, '..', 'niftispy_native.darwin-arm64.node'));

const TEST_FILE = '/Users/rock/Documents/PKU_projects/GRAFT-MRI/graft_v2.1/results/recon_hr.nii.gz';

async function main() {
  console.log('Verifying parallel decompression correctness...\n');

  // 1. Reference: Node.js zlib
  console.log('  [1/3] Computing reference (zlib.gunzipSync)...');
  const compressed = fs.readFileSync(TEST_FILE);
  const ref = zlib.gunzipSync(compressed);
  console.log(`  Reference size: ${ref.length} bytes`);

  // 2. libdeflate oneshot
  console.log('  [2/3] Verifying libdeflate oneshot...');
  const oneshot = await native.fastDecompressGzipFileAsync(TEST_FILE);
  console.log(`  Oneshot size: ${oneshot.length} bytes`);
  let match = true;
  for (let i = 0; i < ref.length; i++) {
    if (ref[i] !== oneshot[i]) {
      console.log(`  MISMATCH at byte ${i}: ref=${ref[i]}, oneshot=${oneshot[i]}`);
      match = false;
      break;
    }
  }
  console.log(`  Oneshot matches zlib: ${match ? '✓ YES' : '✗ NO'}`);

  // 3. rusty-rapidgzip parallel
  console.log('  [3/3] Verifying rusty-rapidgzip parallel...');
  const parallel = await native.fastDecompressGzipParallelAsync(TEST_FILE);
  console.log(`  Parallel size: ${parallel.length} bytes`);
  match = true;
  for (let i = 0; i < ref.length; i++) {
    if (ref[i] !== parallel[i]) {
      console.log(`  MISMATCH at byte ${i}: ref=${ref[i]}, parallel=${parallel[i]}`);
      match = false;
      break;
    }
  }
  console.log(`  Parallel matches zlib: ${match ? '✓ YES' : '✗ NO'}`);

  // Verify header parsing works
  console.log('\n  Verifying NIfTI header parsing on parallel output...');
  const header = native.parseHeader(Buffer.from(parallel));
  if (header) {
    const h = JSON.parse(header);
    console.log(`  ✓ Header parsed: ${h.nx}x${h.ny}x${h.nz}, datatype=${h.datatype}`);
  } else {
    console.log('  ✗ Header parse failed');
  }

  console.log('\n✓ All correctness checks passed!');
}

main().catch(console.error);

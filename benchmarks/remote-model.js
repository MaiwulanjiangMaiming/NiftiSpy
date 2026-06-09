#!/usr/bin/env node
/*
 * Back-of-envelope model (NOT a live measurement) comparing remote load timing
 * before vs after the streaming/parallel optimizations. Adjust BW_MBPS and
 * RTT_MS to your link to get projections for your environment.
 *
 *   node benchmarks/remote-model.js [fileMB] [bwMBps] [rttMs] [gzRatio]
 */
const fileMB = Number(process.argv[2] || 300);   // compressed-on-wire size (MB)
const BW_MBPS = Number(process.argv[3] || 20);    // effective throughput per connection (MB/s)
const RTT_MS = Number(process.argv[4] || 40);     // round-trip latency (ms)
const GZ_RATIO = Number(process.argv[5] || 0.45); // fraction of stream to reach center axial slice

const CHUNK_MB = 4;
const CONCURRENCY = 6;
const ms = (s) => Math.round(s * 1000);

// --- transfer-time helpers -------------------------------------------------
const xfer = (mb, conns = 1) => mb / (BW_MBPS * conns); // seconds, bandwidth term
const numChunks = Math.ceil(fileMB / CHUNK_MB);

// OLD: serial chunked download — every chunk pays a full RTT before the next.
const oldSerial = numChunks * (RTT_MS / 1000) + xfer(fileMB);

// NEW: bounded-concurrency pool — RTTs overlap across `CONCURRENCY` streams and
// the bandwidth term is split across connections (until the pipe saturates).
const newParallel = (numChunks / CONCURRENCY) * (RTT_MS / 1000) + xfer(fileMB, CONCURRENCY);

// First-image (TTFS):
//   OLD = whole file downloaded + (if gz) fully decompressed before any pixel.
//   NEW(.nii) = header range + one slice range = 2 RTTs + a few hundred KB.
//   NEW(.gz)  = stream-decompress until center slice (~GZ_RATIO of the stream).
const oldTTFS = oldSerial; // display blocked on full load in the old path
const newTTFS_nii = 2 * (RTT_MS / 1000) + xfer(0.3); // ~300KB header+slice
const newTTFS_gz = RTT_MS / 1000 + xfer(fileMB * GZ_RATIO);

const row = (label, sec) => `  ${label.padEnd(34)} ${(sec).toFixed(2)}s (${ms(sec)}ms)`;

console.log(`Remote load model — file=${fileMB}MB  bw=${BW_MBPS}MB/s  rtt=${RTT_MS}ms`);
console.log(`(${numChunks} chunks @ ${CHUNK_MB}MB, concurrency=${CONCURRENCY})\n`);
console.log('Full volume (interactive, all slices):');
console.log(row('OLD serial chunked', oldSerial));
console.log(row('NEW parallel pool', newParallel));
console.log(`  -> ${(oldSerial / newParallel).toFixed(1)}x faster full load\n`);
console.log('Time to first image (TTFS):');
console.log(row('OLD (full load blocks display)', oldTTFS));
console.log(row('NEW .nii (header+slice ranges)', newTTFS_nii));
console.log(row('NEW .nii.gz (stream to center)', newTTFS_gz));
console.log(`  -> .nii first image ${(oldTTFS / newTTFS_nii).toFixed(0)}x sooner; ` +
            `.gz ${(oldTTFS / newTTFS_gz).toFixed(1)}x sooner`);

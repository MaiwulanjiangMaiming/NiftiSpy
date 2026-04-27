#!/usr/bin/env node
const fs = require('fs');
const path = require('path');

const target = process.argv[2];
if (!target) {
  console.error('Usage: node benchmarks/load-benchmark.js <file>');
  process.exit(1);
}

const stat = fs.statSync(target);
console.log(JSON.stringify({
  scenario: 'single-load',
  file: path.basename(target),
  bytes: stat.size,
  startedAt: new Date().toISOString(),
  note: 'Use with VS Code performance monitor to correlate preview/full-volume timings.',
}, null, 2));


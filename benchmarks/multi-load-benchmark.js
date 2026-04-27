#!/usr/bin/env node
const fs = require('fs');
const path = require('path');

const dir = process.argv[2];
if (!dir) {
  console.error('Usage: node benchmarks/multi-load-benchmark.js <directory>');
  process.exit(1);
}

const files = fs.readdirSync(dir).filter(name => name.endsWith('.nii') || name.endsWith('.nii.gz'));
const stats = files.map(name => {
  const stat = fs.statSync(path.join(dir, name));
  return { name, bytes: stat.size };
});

console.log(JSON.stringify({
  scenario: 'multi-load',
  count: stats.length,
  files: stats,
  recommendation: 'Open these files sequentially and record window.__niftiPerf after file 1/5/10/20.',
}, null, 2));


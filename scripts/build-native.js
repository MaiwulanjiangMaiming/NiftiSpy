#!/usr/bin/env node
const { spawnSync } = require('child_process');
const fs = require('fs');
const { join } = require('path');

const nativeDir = join(__dirname, '..', 'native');
const result = spawnSync('cargo', ['build', '--release'], {
  cwd: nativeDir,
  stdio: 'inherit',
});

if (result.status !== 0) {
  process.exit(result.status || 1);
}

const releaseDir = join(nativeDir, 'target', 'release');
const outputFile = join(nativeDir, 'index.node');
const candidates = [
  join(releaseDir, 'niftispy_native.node'),
  join(releaseDir, 'libniftispy_native.dylib'),
  join(releaseDir, 'libniftispy_native.so'),
  join(releaseDir, 'niftispy_native.dll'),
];

const builtArtifact = candidates.find((file) => fs.existsSync(file));

if (!builtArtifact) {
  console.error('Native build finished, but no N-API artifact was found in target/release.');
  process.exit(1);
}

fs.copyFileSync(builtArtifact, outputFile);
console.log(`Copied native binding to ${outputFile}`);

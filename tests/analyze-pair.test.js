const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

function isAnalyzeHeaderPath(p) {
  return /\.hdr(\.gz)?$/i.test(p);
}

function companionImagePaths(headerPath) {
  if (/\.hdr\.gz$/i.test(headerPath)) {
    return [
      headerPath.replace(/\.hdr\.gz$/i, '.img.gz'),
      headerPath.replace(/\.hdr\.gz$/i, '.IMG.gz'),
    ];
  }
  return [
    headerPath.replace(/\.hdr$/i, '.img'),
    headerPath.replace(/\.hdr$/i, '.IMG'),
  ];
}

test('companion .img paths next to a .hdr', () => {
  assert.equal(isAnalyzeHeaderPath('/data/sub-01_T1w.hdr'), true);
  assert.equal(isAnalyzeHeaderPath('/data/sub-01_T1w.nii'), false);
  const paths = companionImagePaths('/data/sub-01_T1w.hdr');
  assert.ok(paths.some(p => p.endsWith('.img')));
  assert.ok(paths.some(p => p.endsWith('.IMG')));
  const gz = companionImagePaths('/data/vol.hdr.gz');
  assert.ok(gz.some(p => p.endsWith('.img.gz')));
});

test('src/io/analyzePair.ts keeps the same companion naming', () => {
  const src = fs.readFileSync(path.join(__dirname, '../src/io/analyzePair.ts'), 'utf8');
  assert.match(src, /function isAnalyzeHeaderPath/);
  assert.match(src, /function companionImagePaths/);
  assert.match(src, /\.img/);
});

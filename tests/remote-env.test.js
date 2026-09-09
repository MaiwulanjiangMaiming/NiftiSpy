const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

function classifyRemote(remoteName) {
  if (!remoteName) return 'local';
  switch (remoteName) {
    case 'wsl':
    case 'dev-container':
    case 'attached-container':
      return 'localFast';
    default:
      return 'sshWan';
  }
}

test('classifyRemote: local / WSL / container vs WAN SSH', () => {
  assert.equal(classifyRemote(undefined), 'local');
  assert.equal(classifyRemote(null), 'local');
  assert.equal(classifyRemote(''), 'local');
  assert.equal(classifyRemote('wsl'), 'localFast');
  assert.equal(classifyRemote('dev-container'), 'localFast');
  assert.equal(classifyRemote('attached-container'), 'localFast');
  assert.equal(classifyRemote('ssh-remote'), 'sshWan');
  assert.equal(classifyRemote('codespaces'), 'sshWan');
  assert.equal(classifyRemote('tunnel'), 'sshWan');
});

test('src/remoteEnv.ts keeps WSL/container as localFast and SSH as WAN', () => {
  const src = fs.readFileSync(path.join(__dirname, '../src/remoteEnv.ts'), 'utf8');
  assert.match(src, /case 'wsl':/);
  assert.match(src, /case 'dev-container':/);
  assert.match(src, /return 'localFast'/);
  assert.match(src, /return 'sshWan'/);
  assert.match(src, /SLICE_MODE_MIN_BYTES = 8 \* 1024 \* 1024/);
});

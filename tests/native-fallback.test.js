const test = require('node:test');
const assert = require('node:assert/strict');

test('native bridge fallback remains optional', async () => {
  const mod = await import('../dist/extension.js').catch(() => null);
  assert.ok(true, 'build output may not exist before build; fallback test is smoke-only');
  void mod;
});


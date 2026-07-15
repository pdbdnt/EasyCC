const test = require('node:test');
const assert = require('node:assert/strict');
const { isCodexType, getCodexRuntime, getCodexIdentityKey } = require('../backend/codexCliTypes');

test('Codex CLI types keep WSL and Windows identities separate', () => {
  assert.equal(isCodexType('codex'), true);
  assert.equal(isCodexType('codex-windows'), true);
  assert.equal(getCodexRuntime('codex'), 'wsl');
  assert.equal(getCodexRuntime('codex-windows'), 'windows');
  assert.equal(getCodexIdentityKey('codex', 'abc'), 'wsl:abc');
  assert.equal(getCodexIdentityKey('codex-windows', 'abc'), 'windows:abc');
});

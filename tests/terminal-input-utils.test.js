const test = require('node:test');
const assert = require('node:assert/strict');

test('encodeSoftNewline preserves LF inside bracketed paste', async () => {
  const { encodeSoftNewline } = await import('../ui/src/utils/terminalInputUtils.js');

  assert.equal(encodeSoftNewline(true), '\x1b[200~\n\x1b[201~');
});

test('encodeSoftNewline falls back to bare LF when bracketed paste is disabled', async () => {
  const { encodeSoftNewline } = await import('../ui/src/utils/terminalInputUtils.js');

  assert.equal(encodeSoftNewline(false), '\n');
});

test('Codex runtimes force bracketed soft newlines even before xterm reports the mode', async () => {
  const { shouldUseBracketedSoftNewline } = await import('../ui/src/utils/terminalInputUtils.js');

  assert.equal(shouldUseBracketedSoftNewline('codex', false), true);
  assert.equal(shouldUseBracketedSoftNewline('codex-windows', false), true);
  assert.equal(shouldUseBracketedSoftNewline('claude', false), false);
  assert.equal(shouldUseBracketedSoftNewline('claude', true), true);
});

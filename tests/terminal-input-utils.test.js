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

test('soft-newline encoding preserves existing runtime-specific paste behavior', async () => {
  const {
    shouldUseBracketedSoftNewline
  } = await import('../ui/src/utils/terminalInputUtils.js');

  assert.equal(shouldUseBracketedSoftNewline('codex', false), true);
  assert.equal(shouldUseBracketedSoftNewline('codex-windows', false), false);
  assert.equal(shouldUseBracketedSoftNewline('codex-windows', true), false);
  assert.equal(shouldUseBracketedSoftNewline('claude', false), false);
  assert.equal(shouldUseBracketedSoftNewline('claude', true), true);
  assert.equal(shouldUseBracketedSoftNewline('terminal', false), false);
  assert.equal(shouldUseBracketedSoftNewline('terminal', true), true);
});

test('exact Ctrl+Enter excludes other modifier combinations', async () => {
  const { isExactCtrlEnter } = await import('../ui/src/utils/terminalInputUtils.js');

  assert.equal(isExactCtrlEnter({ key: 'Enter', ctrlKey: true }), true);
  assert.equal(isExactCtrlEnter({ key: 'Enter', ctrlKey: true, shiftKey: true }), false);
  assert.equal(isExactCtrlEnter({ key: 'Enter', ctrlKey: true, altKey: true }), false);
  assert.equal(isExactCtrlEnter({ key: 'Enter', ctrlKey: true, metaKey: true }), false);
  assert.equal(isExactCtrlEnter({ key: 'Enter', metaKey: true }), false);
  assert.equal(isExactCtrlEnter({ key: 'Enter' }), false);
});

test('Codex Windows soft newline is a bare LF byte', async () => {
  const {
    encodeSoftNewline,
    shouldUseBracketedSoftNewline
  } = await import('../ui/src/utils/terminalInputUtils.js');

  for (const bracketedPasteMode of [false, true]) {
    const encoded = encodeSoftNewline(
      shouldUseBracketedSoftNewline('codex-windows', bracketedPasteMode)
    );
    assert.equal(Buffer.from(encoded).toString('hex'), '0a');
    assert.equal(encoded.includes('\x1b[200~'), false);
    assert.equal(encoded.includes('\x1b[201~'), false);
  }
});

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

test('Codex Windows soft-newline chords preserve modifier identity with CSI-u', async () => {
  const { encodeCodexWindowsSoftNewline } = await import('../ui/src/utils/terminalInputUtils.js');

  assert.equal(
    encodeCodexWindowsSoftNewline({ key: 'Enter', shiftKey: true }),
    '\x1b[13;2u'
  );
  assert.equal(
    encodeCodexWindowsSoftNewline({ key: 'Enter', altKey: true }),
    '\x1b[13;3u'
  );
  assert.equal(
    encodeCodexWindowsSoftNewline({ key: 'Enter', ctrlKey: true }),
    '\x1b[13;5u'
  );
  assert.equal(
    encodeCodexWindowsSoftNewline({ key: 'j', ctrlKey: true }),
    '\x1b[106;5u'
  );
  assert.equal(
    encodeCodexWindowsSoftNewline({ key: 'M', ctrlKey: true }),
    '\x1b[109;5u'
  );
});

test('Codex Windows soft-newline encoding rejects ordinary or ambiguous chords', async () => {
  const { encodeCodexWindowsSoftNewline } = await import('../ui/src/utils/terminalInputUtils.js');

  for (const event of [
    { key: 'Enter' },
    { key: 'Enter', ctrlKey: true, shiftKey: true },
    { key: 'Enter', ctrlKey: true, altKey: true },
    { key: 'Enter', ctrlKey: true, metaKey: true },
    { key: 'j', shiftKey: true },
    { key: 'x', ctrlKey: true }
  ]) {
    assert.equal(encodeCodexWindowsSoftNewline(event), null);
  }
});

const BRACKETED_PASTE_START = '\x1b[200~';
const BRACKETED_PASTE_END = '\x1b[201~';
const CODEX_WINDOWS_SOFT_NEWLINE_CHORDS = new Set([
  'shift-enter',
  'alt-enter',
  'ctrl-enter',
  'ctrl-j',
  'ctrl-m'
]);

export function shouldUseBracketedSoftNewline(cliType, bracketedPasteMode) {
  if (cliType === 'codex-windows') return false;
  return cliType === 'codex' || bracketedPasteMode;
}

export function encodeSoftNewline(bracketedPasteMode) {
  return bracketedPasteMode
    ? `${BRACKETED_PASTE_START}\n${BRACKETED_PASTE_END}`
    : '\n';
}

export function isExactCtrlEnter(event) {
  return event?.key === 'Enter' &&
    event.ctrlKey === true &&
    event.altKey !== true &&
    event.shiftKey !== true &&
    event.metaKey !== true;
}

export function encodeCodexWindowsSoftNewline(event) {
  if (!event || event.metaKey === true) return null;

  const modifiers = [
    event.ctrlKey === true ? 'ctrl' : null,
    event.altKey === true ? 'alt' : null,
    event.shiftKey === true ? 'shift' : null
  ].filter(Boolean);
  if (modifiers.length !== 1) return null;

  const eventKey = String(event.key || '').toLowerCase();
  const eventCode = String(event.code || '').toLowerCase();
  const legacyKeyCode = Number(event.keyCode || event.which || 0);
  let key = eventKey;
  if (eventKey === 'enter' || eventCode === 'enter' || eventCode === 'numpadenter' || legacyKeyCode === 13) {
    key = 'enter';
  } else if (eventCode === 'keyj' || legacyKeyCode === 74) {
    key = 'j';
  } else if (eventCode === 'keym' || legacyKeyCode === 77) {
    key = 'm';
  }
  return CODEX_WINDOWS_SOFT_NEWLINE_CHORDS.has(`${modifiers[0]}-${key}`)
    ? '\n'
    : null;
}

export function getTerminalInputIntent(cliType, data) {
  return cliType === 'codex-windows' && data === '\n'
    ? 'soft_newline'
    : null;
}

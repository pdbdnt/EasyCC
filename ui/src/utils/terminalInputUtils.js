const BRACKETED_PASTE_START = '\x1b[200~';
const BRACKETED_PASTE_END = '\x1b[201~';

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

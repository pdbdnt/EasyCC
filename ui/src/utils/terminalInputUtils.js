const BRACKETED_PASTE_START = '\x1b[200~';
const BRACKETED_PASTE_END = '\x1b[201~';

export function shouldUseBracketedSoftNewline(cliType, bracketedPasteMode) {
  return cliType === 'codex' || cliType === 'codex-windows' || bracketedPasteMode;
}

export function encodeSoftNewline(bracketedPasteMode) {
  return bracketedPasteMode
    ? `${BRACKETED_PASTE_START}\n${BRACKETED_PASTE_END}`
    : '\n';
}

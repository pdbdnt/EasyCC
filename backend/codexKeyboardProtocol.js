const CODEX_WINDOWS_SOFT_NEWLINE_SEQUENCES = new Set([
  '\x1b[13;2u',  // Shift+Enter
  '\x1b[13;3u',  // Alt+Enter
  '\x1b[13;5u',  // Ctrl+Enter
  '\x1b[106;5u', // Ctrl+J
  '\x1b[109;5u'  // Ctrl+M
]);

function isCodexWindowsSoftNewlineSequence(value) {
  return typeof value === 'string' &&
    CODEX_WINDOWS_SOFT_NEWLINE_SEQUENCES.has(value);
}

module.exports = {
  isCodexWindowsSoftNewlineSequence
};

// LF is the browser-to-server soft-newline payload. SessionManager translates
// this validated intent to native Alt+Enter (ESC + CR) for WinPTY; standalone
// LF is ignored by Codex outside its paste window.
const CODEX_WINDOWS_SOFT_NEWLINE_INPUT = '\n';

function isCodexWindowsSoftNewlineInput(value) {
  return value === CODEX_WINDOWS_SOFT_NEWLINE_INPUT;
}

module.exports = {
  isCodexWindowsSoftNewlineInput
};

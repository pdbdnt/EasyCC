// Native Codex runs behind WinPTY, which translates byte input into Windows
// console key events. LF is delivered as Codex's Ctrl+J/insert_newline action;
// CSI-u remains literal text because this path is not a VT keyboard stream.
const CODEX_WINDOWS_SOFT_NEWLINE_INPUT = '\n';

function isCodexWindowsSoftNewlineInput(value) {
  return value === CODEX_WINDOWS_SOFT_NEWLINE_INPUT;
}

module.exports = {
  isCodexWindowsSoftNewlineInput
};

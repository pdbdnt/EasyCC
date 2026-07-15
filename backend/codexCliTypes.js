const CODEX_WSL = 'codex';
const CODEX_WINDOWS = 'codex-windows';

function isCodexType(cliType) {
  return cliType === CODEX_WSL || cliType === CODEX_WINDOWS;
}

function getCodexRuntime(cliType) {
  if (cliType === CODEX_WINDOWS) return 'windows';
  if (cliType === CODEX_WSL) return 'wsl';
  return null;
}

function getCodexIdentityKey(cliType, sessionId) {
  const runtime = getCodexRuntime(cliType);
  return runtime && sessionId ? `${runtime}:${sessionId}` : null;
}

module.exports = { CODEX_WSL, CODEX_WINDOWS, isCodexType, getCodexRuntime, getCodexIdentityKey };

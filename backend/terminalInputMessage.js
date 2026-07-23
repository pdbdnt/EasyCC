function forwardTerminalInputMessage(sessionManager, sessionId, parsed) {
  if (parsed?.type !== 'input' || typeof parsed.data !== 'string' || parsed.data.length === 0) {
    return false;
  }

  if (parsed.inputIntent === 'soft_newline' && parsed.data === '\n') {
    return sessionManager.sendInput(sessionId, parsed.data, {
      inputIntent: 'soft_newline'
    });
  }

  return sessionManager.sendInput(sessionId, parsed.data);
}

module.exports = {
  forwardTerminalInputMessage
};

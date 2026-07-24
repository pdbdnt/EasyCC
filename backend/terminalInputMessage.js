const {
  isCodexWindowsSoftNewlineSequence
} = require('./codexKeyboardProtocol');

function forwardTerminalInputMessage(sessionManager, sessionId, parsed) {
  if (parsed?.type !== 'input' || typeof parsed.data !== 'string' || parsed.data.length === 0) {
    return false;
  }

  if (parsed.inputIntent === 'soft_newline' &&
      isCodexWindowsSoftNewlineSequence(parsed.data)) {
    return sessionManager.sendInput(sessionId, parsed.data, {
      inputIntent: 'soft_newline'
    });
  }

  return sessionManager.sendInput(sessionId, parsed.data);
}

module.exports = {
  forwardTerminalInputMessage
};

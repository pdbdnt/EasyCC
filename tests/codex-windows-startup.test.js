const test = require('node:test');
const assert = require('node:assert/strict');

const SessionManager = require('../backend/sessionManager');

function stalledSession(overrides = {}) {
  return {
    id: 'codex-windows-stalled',
    cliType: 'codex-windows',
    status: 'active',
    runtimeState: 'live',
    pty: { kill() {} },
    ptyGeneration: 1,
    codexSessionId: null,
    codexIdentityState: 'verifying',
    lastSubmittedInputAtMs: 0,
    promptBuffer: '',
    startupSequence: null,
    outputBuffer: {
      getAll: () => ['\x1b[0m\x1b[0K']
    },
    ...overrides
  };
}

test('Codex Windows startup watchdog treats ANSI-only startup output as stalled', () => {
  const manager = {
    cleanTerminalText: SessionManager.prototype.cleanTerminalText
  };
  const session = stalledSession();

  assert.equal(
    SessionManager.prototype.isCodexWindowsStartupStalled.call(manager, session, 1),
    true
  );
  assert.equal(
    SessionManager.prototype.isCodexWindowsStartupStalled.call(
      manager,
      stalledSession({ outputBuffer: { getAll: () => ['\x1b[0mReady'] } }),
      1
    ),
    false
  );
});

test('Codex Windows startup watchdog does not retry a touched or superseded session', () => {
  const manager = {
    cleanTerminalText: SessionManager.prototype.cleanTerminalText
  };

  assert.equal(
    SessionManager.prototype.isCodexWindowsStartupStalled.call(
      manager,
      stalledSession({ lastSubmittedInputAtMs: Date.now() }),
      1
    ),
    false
  );
  assert.equal(
    SessionManager.prototype.isCodexWindowsStartupStalled.call(manager, stalledSession(), 2),
    false
  );
});

test('Codex Windows startup watchdog retries once through the existing lifecycle', () => {
  const session = stalledSession();
  const calls = [];
  const manager = {
    sessions: new Map([[session.id, session]]),
    cleanTerminalText: SessionManager.prototype.cleanTerminalText,
    isCodexWindowsStartupStalled: SessionManager.prototype.isCodexWindowsStartupStalled,
    pauseSession(id) {
      calls.push(['pause', id]);
      session.status = 'paused';
      return true;
    },
    resumeSession(id, options) {
      calls.push(['resume', id, options]);
      return true;
    }
  };

  assert.equal(
    SessionManager.prototype.handleCodexWindowsStartupWatchdog.call(manager, session.id, 1),
    true
  );
  assert.equal(session.codexWindowsStartupRetryCount, 1);
  assert.deepEqual(calls, [
    ['pause', session.id],
    ['resume', session.id, { fresh: true, startupRetry: true }]
  ]);
});

test('Codex Windows startup watchdog stops a second blank launch with an explicit error', () => {
  const session = stalledSession({ codexWindowsStartupRetryCount: 1 });
  const events = [];
  const manager = {
    sessions: new Map([[session.id, session]]),
    cleanTerminalText: SessionManager.prototype.cleanTerminalText,
    isCodexWindowsStartupStalled: SessionManager.prototype.isCodexWindowsStartupStalled,
    pauseSession() {
      session.status = 'paused';
      return true;
    },
    dataStore: {
      saveSession(saved) {
        events.push(['saved', saved.recoveryError]);
      }
    },
    emit(type) {
      events.push(['emitted', type]);
    },
    getSessionSnapshot(saved) {
      return { id: saved.id, recoveryError: saved.recoveryError };
    }
  };

  assert.equal(
    SessionManager.prototype.handleCodexWindowsStartupWatchdog.call(manager, session.id, 1),
    true
  );
  assert.equal(session.status, 'paused');
  assert.equal(session.codexIdentityState, 'unresolved');
  assert.match(session.recoveryError, /did not render/);
  assert.deepEqual(events, [
    ['saved', session.recoveryError],
    ['emitted', 'sessionUpdated']
  ]);
});

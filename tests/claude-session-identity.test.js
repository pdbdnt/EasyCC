const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const SessionManager = require('../backend/sessionManager');
const DataStore = require('../backend/dataStore');
const claudeProcessRegistry = require('../backend/claudeProcessRegistry');

const ID_A = '11111111-1111-4111-8111-111111111111';
const ID_B = '22222222-2222-4222-8222-222222222222';

function makeManager(sessions = []) {
  const manager = Object.create(SessionManager.prototype);
  manager.sessions = new Map(sessions.map((session) => [session.id, session]));
  manager.events = [];
  manager.saved = [];
  manager.deleted = [];
  manager.emit = (type, payload) => manager.events.push({ type, payload });
  manager.dataStore = {
    saveSession: (session) => manager.saved.push(session.id),
    deleteSession: (id) => manager.deleted.push(id)
  };
  manager.planManager = { getPlansForClaudeSession: () => [] };
  manager.getSessionSnapshot = (session) => ({ id: session.id, status: session.status });
  manager.finalizeCodexTurnTiming = () => {};
  manager.clearCodexStatusSampler = () => {};
  manager.clearCodexSessionCapture = () => {};
  manager._clearWriteQueue = () => {};
  return manager;
}

function withSessionsDir(run) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'easycc-claude-registry-'));
  const sessionsDir = path.join(home, '.claude', 'sessions');
  fs.mkdirSync(sessionsDir, { recursive: true });
  const originalRead = claudeProcessRegistry.readClaudeProcessEntry;
  claudeProcessRegistry.readClaudeProcessEntry = (pid) => originalRead(pid, { sessionsDir });
  try {
    return run(sessionsDir);
  } finally {
    claudeProcessRegistry.readClaudeProcessEntry = originalRead;
    fs.rmSync(home, { recursive: true, force: true });
  }
}

test('a crashed Claude session stays in the list as paused; a clean exit still ends it', () => {
  const manager = makeManager();
  const crashed = { id: 'crashed', cliType: 'claude', status: 'idle', pty: {}, claudeSessionId: ID_A };

  assert.equal(manager.shouldKeepSessionAfterExit(crashed, 0), false);
  assert.equal(manager.shouldKeepSessionAfterExit(crashed, 1073807364), true);
  assert.equal(manager.shouldKeepSessionAfterExit({ cliType: 'terminal' }, 1), false);

  manager.pauseSessionAfterUnexpectedExit(crashed, { exitCode: 1073807364, signal: undefined });
  assert.equal(crashed.status, 'paused');
  assert.equal(crashed.pauseReason, 'process_exited');
  assert.equal(crashed.pty, null);
  assert.equal(crashed.claudeSessionId, ID_A);
  assert.deepEqual(manager.saved, ['crashed']);
  assert.deepEqual(manager.deleted, []);
  assert.equal(manager.events.some((event) => event.type === 'sessionEnded'), false);
  assert.match(manager.events.find((event) => event.type === 'statusChange').payload.error, /exited unexpectedly/);
});

test('a session follows the conversation its own Claude process reports', () => withSessionsDir((sessionsDir) => {
  const session = {
    id: 'one', cliType: 'claude', status: 'idle', pty: {}, workingDir: '/work',
    claudeSessionId: ID_A, claudePid: 4242, claudePtySpawnedAtMs: 1000
  };
  const manager = makeManager([session]);
  const write = (entry) => fs.writeFileSync(path.join(sessionsDir, '4242.json'), JSON.stringify(entry));

  write({ pid: 4242, sessionId: ID_A, startedAt: 2000 });
  assert.equal(manager.syncClaudeIdentityFromProcess(session), false);

  // /clear or /resume inside the terminal moves the process to another conversation
  write({ pid: 4242, sessionId: ID_B, startedAt: 2000 });
  assert.equal(manager.syncClaudeIdentityFromProcess(session), true);
  assert.equal(session.claudeSessionId, ID_B);
  assert.deepEqual(session.previousClaudeSessionIds, [ID_A]);
}));

test('registry entries from another process or another session are not adopted', () => withSessionsDir((sessionsDir) => {
  const owner = { id: 'owner', cliType: 'claude', status: 'paused', claudeSessionId: ID_B };
  const session = {
    id: 'one', cliType: 'claude', status: 'idle', pty: {}, workingDir: '/work',
    claudeSessionId: ID_A, claudePid: 4242, claudePtySpawnedAtMs: 100000
  };
  const manager = makeManager([owner, session]);
  const write = (entry) => fs.writeFileSync(path.join(sessionsDir, '4242.json'), JSON.stringify(entry));

  // Conversation already held by another EasyCC session
  write({ pid: 4242, sessionId: ID_B, startedAt: 100500 });
  assert.equal(manager.syncClaudeIdentityFromProcess(session), false);

  // Stale file from an earlier process that had the same pid
  manager.sessions.delete('owner');
  write({ pid: 4242, sessionId: ID_B, startedAt: 5 });
  assert.equal(manager.syncClaudeIdentityFromProcess(session), false);
  assert.equal(session.claudeSessionId, ID_A);
}));

test('the Claude pid is found below the cmd.exe PTY root', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'easycc-claude-registry-'));
  const sessionsDir = path.join(home, 'sessions');
  fs.mkdirSync(sessionsDir, { recursive: true });
  fs.writeFileSync(path.join(sessionsDir, '300.json'), JSON.stringify({ pid: 300, sessionId: ID_A }));
  try {
    const listProcessParents = async () => new Map([[200, 100], [300, 200], [400, 300], [999, 1]]);
    assert.equal(await claudeProcessRegistry.findClaudePidForPty(100, { sessionsDir, listProcessParents }), 300);
    assert.equal(await claudeProcessRegistry.findClaudePidForPty(999, { sessionsDir, listProcessParents }), null);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('terminal output only yields real conversation IDs', () => {
  const session = { id: 'one', claudeSessionId: null };
  const manager = makeManager([session]);
  manager.detectClaudeSessionId('Your session expired, please log in', session);
  assert.equal(session.claudeSessionId, null);
  manager.detectClaudeSessionId(`Resuming ${ID_A}`, session);
  assert.equal(session.claudeSessionId, ID_A);
});

test('sessions.json is replaced atomically', () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'easycc-datastore-'));
  try {
    const store = new DataStore(dataDir);
    store.writeSessionsFile({ one: { id: 'one' } });
    assert.deepEqual(store.loadSessions(), { one: { id: 'one' } });
    assert.deepEqual(fs.readdirSync(dataDir).filter((name) => name.endsWith('.tmp')), []);
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

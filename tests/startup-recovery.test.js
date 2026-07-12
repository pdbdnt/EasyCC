const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const SessionManager = require('../backend/sessionManager');
const registerRecoveryRoutes = require('../backend/recoveryRoutes');

const CODEX_ID = '019f4a56-26a5-7440-bbc6-54b00447d986';

function baseSession(overrides = {}) {
  return {
    id: 'session-one',
    name: 'Saved name',
    status: 'paused',
    cliType: 'claude',
    workingDir: '/work/project',
    groupKey: '/work/project',
    repoName: 'project',
    createdAt: new Date('2026-07-10T00:00:00Z'),
    lastActivity: new Date('2026-07-10T00:00:00Z'),
    claudeSessionId: 'claude-one',
    codexSessionId: null,
    currentTask: '',
    role: 'Worker role',
    outputBuffer: { push() {} },
    ...overrides
  };
}

test('recovery summary reconciles Codex rename titles and separates totals', async () => {
  const exact = baseSession({ id: 'codex-exact', cliType: 'codex', codexSessionId: CODEX_ID, name: 'Old name' });
  const unresolved = baseSession({ id: 'codex-unresolved', cliType: 'codex', codexSessionId: null });
  const terminal = baseSession({ id: 'terminal-one', cliType: 'terminal', claudeSessionId: null });
  const manager = Object.create(SessionManager.prototype);
  manager.sessions = new Map([[exact.id, exact], [unresolved.id, unresolved], [terminal.id, terminal]]);
  manager.validateRecoveryWorkingDir = async () => ({ ok: true });
  manager.codexSessionService = {
    getThreadsByIds: async () => new Map([[CODEX_ID, {
      codexSessionId: CODEX_ID,
      threadName: 'Renamed in Codex',
      workingDir: '/work/project'
    }]]),
    scanProcesses: async () => ({ liveRootIds: new Set() })
  };
  manager.dataStore = { saveSession() {} };
  manager.emit = () => {};
  manager.getSessionSnapshot = (session) => ({ ...session });

  const summary = await manager.prepareRecoverySummary();
  assert.equal(exact.name, 'Renamed in Codex');
  assert.deepEqual(summary.totals, {
    candidateTotal: 3,
    launchableTotal: 2,
    requiresSelectionTotal: 1,
    disabledTotal: 0,
    projectTotal: 1
  });
  assert.equal(summary.sessions.find((row) => row.id === unresolved.id).category, 'requiresSelection');
  assert.equal(summary.sessions.find((row) => row.id === terminal.id).code, 'fresh_shell');
});

test('recovery summary assigns one deterministic owner for duplicate Codex IDs', async () => {
  const first = baseSession({ id: 'a-card', cliType: 'codex', codexSessionId: CODEX_ID, createdAt: new Date('2026-07-09') });
  const second = baseSession({ id: 'b-card', cliType: 'codex', codexSessionId: CODEX_ID, createdAt: new Date('2026-07-10') });
  const manager = Object.create(SessionManager.prototype);
  manager.sessions = new Map([[second.id, second], [first.id, first]]);
  manager.validateRecoveryWorkingDir = async () => ({ ok: true });
  manager.codexSessionService = {
    getThreadsByIds: async () => new Map([[CODEX_ID, { codexSessionId: CODEX_ID, threadName: 'Thread', workingDir: '/work/project' }]]),
    scanProcesses: async () => ({ liveRootIds: new Set() })
  };
  manager.dataStore = { saveSession() {} };
  manager.emit = () => {};
  manager.getSessionSnapshot = (session) => ({ ...session });

  const summary = await manager.prepareRecoverySummary();
  assert.equal(summary.sessions.find((row) => row.id === first.id).category, 'launchable');
  assert.equal(summary.sessions.find((row) => row.id === second.id).code, 'duplicate_owner');
});

test('active EasyCC Codex ownership blocks a paused duplicate before process discovery', async () => {
  const paused = baseSession({ id: 'paused-card', cliType: 'codex', codexSessionId: CODEX_ID });
  const active = baseSession({ id: 'active-card', cliType: 'codex', codexSessionId: CODEX_ID, status: 'active', name: 'Active owner' });
  const manager = Object.create(SessionManager.prototype);
  manager.sessions = new Map([[paused.id, paused], [active.id, active]]);
  manager.validateRecoveryWorkingDir = async () => ({ ok: true });
  manager.codexSessionService = {
    getThreadsByIds: async () => new Map([[CODEX_ID, { codexSessionId: CODEX_ID, threadName: 'Thread', workingDir: '/work/project' }]]),
    scanProcesses: async () => ({ liveRootIds: new Set() })
  };
  manager.dataStore = { saveSession() {} };
  manager.emit = () => {};
  manager.getSessionSnapshot = (session) => ({ ...session });

  const summary = await manager.prepareRecoverySummary();
  assert.equal(summary.sessions[0].code, 'already_active');
  assert.equal(summary.totals.launchableTotal, 0);
});

test('working-directory validation uses WSL probe for Codex paths', async () => {
  const manager = Object.create(SessionManager.prototype);
  manager.platform = 'win32';
  manager.normalizeWorkingDirForCli = (value) => value;
  manager.quoteForPosixShell = SessionManager.prototype.quoteForPosixShell;
  let command = '';
  manager.codexSessionService = { runShell: async (value) => { command = value; return 'ok'; } };

  const result = await manager.validateRecoveryWorkingDir({ cliType: 'codex', workingDir: '/home/denni/project' });
  assert.equal(result.ok, true);
  assert.match(command, /test -d '\/home\/denni\/project'/);
});

test('working-directory validation distinguishes unavailable WSL from probe failure', async () => {
  const manager = Object.create(SessionManager.prototype);
  manager.platform = 'win32';
  manager.normalizeWorkingDirForCli = (value) => value;
  manager.quoteForPosixShell = SessionManager.prototype.quoteForPosixShell;
  const missingExecutable = Object.assign(new Error('spawn wsl.exe ENOENT'), { code: 'ENOENT' });
  manager.codexSessionService = { runShell: async () => { throw missingExecutable; } };
  assert.equal((await manager.validateRecoveryWorkingDir({ cliType: 'codex', workingDir: '/home/project' })).code, 'wsl_unavailable');
  manager.codexSessionService = { runShell: async () => { throw new Error('command timed out while running wsl.exe'); } };
  assert.equal((await manager.validateRecoveryWorkingDir({ cliType: 'codex', workingDir: '/home/project' })).code, 'directory_check_failed');
  manager.codexSessionService = { runShell: async () => { throw new Error('WSL_E_DEFAULT_DISTRO_NOT_FOUND: no installed distributions'); } };
  assert.equal((await manager.validateRecoveryWorkingDir({ cliType: 'codex', workingDir: '/home/project' })).code, 'wsl_unavailable');
});

test('host working-directory validation distinguishes missing paths', async () => {
  const manager = Object.create(SessionManager.prototype);
  manager.platform = 'linux';
  manager.normalizeWorkingDirForCli = (value) => value;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'easycc-recovery-'));
  try {
    assert.equal((await manager.validateRecoveryWorkingDir({ cliType: 'terminal', workingDir: dir })).ok, true);
    assert.equal((await manager.validateRecoveryWorkingDir({ cliType: 'terminal', workingDir: path.join(dir, 'missing') })).code, 'missing_working_dir');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('batch recovery revalidates and uses recovery mode', async () => {
  const session = baseSession();
  const manager = Object.create(SessionManager.prototype);
  manager.sessions = new Map([[session.id, session]]);
  manager.recoveryInFlight = new Set();
  manager.prepareRecoverySummary = async () => ({
    sessions: [{ id: session.id, category: 'launchable', code: 'exact' }],
    totals: { candidateTotal: 1, launchableTotal: 1, requiresSelectionTotal: 0, disabledTotal: 0 }
  });
  let options = null;
  manager.resumeSession = (id, value) => { options = value; session.status = 'active'; return true; };
  manager.getSessionSnapshot = (value) => ({ id: value.id, status: value.status });

  const result = await manager.recoverSessions([session.id, session.id]);
  assert.deepEqual(options, { recovery: true });
  assert.deepEqual(result.launchStarted, [{ id: session.id, status: 'active' }]);
});

test('Claude recovery suppresses role automation and never falls back to fresh', () => {
  const session = baseSession();
  const manager = Object.create(SessionManager.prototype);
  manager.sessions = new Map([[session.id, session]]);
  manager.applyRepoContext = () => {};
  manager.sanitizeRole = (value) => value;
  manager.dataStore = { saveSession() {} };
  manager.getSessionSnapshot = (value) => ({ id: value.id, status: value.status, recoveryError: value.recoveryError });
  manager.emit = () => {};
  manager.startIdleDetection = () => {};
  manager.scanExistingPlansForSession = () => {};
  manager.watchClaudeSessionForUpdates = () => {};
  manager.appendToTranscript = () => {};
  manager.detectClaudeSessionId = () => {};
  manager._clearWriteQueue = () => {};
  let roleWorkflowCalls = 0;
  manager.setupRoleInjectionWorkflow = () => { roleWorkflowCalls += 1; };
  manager.clearRoleInjectionWorkflow = () => {};
  let dataHandler = null;
  let spawnOptions = null;
  const processRef = {
    onData(handler) { dataHandler = handler; },
    onExit() {},
    kill() {}
  };
  manager.spawnClaudeProcess = (workingDir, options) => {
    spawnOptions = options;
    return processRef;
  };

  const started = manager.resumeSession(session.id, { recovery: true });
  assert.equal(started, true);
  assert.equal(spawnOptions.role, '');
  assert.equal(roleWorkflowCalls, 0);

  dataHandler('No conversation found with session ID');
  assert.equal(session.status, 'paused');
  assert.equal(session.claudeSessionId, 'claude-one');
  assert.equal(session.recoveryError, 'Saved Claude conversation could not be found');
});

test('immediate clean exit during recovery retains the paused card', () => {
  const session = baseSession();
  const manager = Object.create(SessionManager.prototype);
  manager.sessions = new Map([[session.id, session]]);
  manager.applyRepoContext = () => {};
  manager.sanitizeRole = (value) => value;
  manager.dataStore = { saveSession() {}, deleteSession() { throw new Error('must not delete'); } };
  manager.getSessionSnapshot = (value) => ({ id: value.id, status: value.status });
  manager.emit = () => {};
  manager.startIdleDetection = () => {};
  manager.scanExistingPlansForSession = () => {};
  manager.watchClaudeSessionForUpdates = () => {};
  manager.clearRoleInjectionWorkflow = () => {};
  manager._clearWriteQueue = () => {};
  manager.clearCodexSessionCapture = () => {};
  let exitHandler = null;
  manager.spawnClaudeProcess = () => ({
    onData() {},
    onExit(handler) { exitHandler = handler; },
    kill() {}
  });

  assert.equal(manager.resumeSession(session.id, { recovery: true }), true);
  exitHandler({ exitCode: 0, signal: null });
  assert.equal(session.status, 'paused');
  assert.equal(session.recoveryError, 'Session recovery exited before it was ready');
});

test('recovery routes validate input and return manager results', async () => {
  const routes = new Map();
  const app = {
    get(pathname, handler) { routes.set(`GET ${pathname}`, handler); },
    post(pathname, handler) { routes.set(`POST ${pathname}`, handler); }
  };
  registerRecoveryRoutes(app, {
    sessionManager: {
      prepareRecoverySummary: async () => ({ sessions: [], totals: { candidateTotal: 0 } }),
      recoverSessions: async (ids) => ({ launchStarted: ids, skipped: [], requiresSelection: [] })
    }
  });
  const reply = { statusCode: 200, status(code) { this.statusCode = code; return this; }, send(value) { this.payload = value; return value; } };
  await routes.get('POST /api/sessions/recover')({ body: { sessionIds: 'bad' } }, reply);
  assert.equal(reply.statusCode, 400);
  const result = await routes.get('POST /api/sessions/recover')({ body: { sessionIds: ['one'] } }, reply);
  assert.deepEqual(result.launchStarted, ['one']);
});

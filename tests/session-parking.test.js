const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const EventEmitter = require('events');
const SessionManager = require('../backend/sessionManager');
const DataStore = require('../backend/dataStore');
const SettingsManager = require('../backend/settingsManager');
const { ByteRingBuffer } = require('../backend/byteRingBuffer');
const { ParkingCoordinator } = require('../backend/parkingCoordinator');

test('byte ring stays within 512 KiB and preserves Unicode code points', () => {
  const ring = new ByteRingBuffer(13);
  ring.push('prefix-');
  ring.push('😀😀😀😀');
  const value = ring.getAll().join('');
  assert.ok(Buffer.byteLength(value, 'utf8') <= 13);
  assert.equal(value.includes('\ufffd'), false);
  assert.equal([...value].join(''), value);
});

test('byte ring retains the exact newest byte tail across chunk boundaries', () => {
  const ring = new ByteRingBuffer(10);
  ring.push('abcdefgh');
  ring.push('ijklmnop');
  assert.equal(ring.getAll().join(''), 'ghijklmnop');
  assert.equal(ring.byteLength, 10);
});

test('settings v1 migrates inherited scrollback and validates parking bounds', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'easycc-parking-settings-'));
  try {
    const manager = new SettingsManager(dir);
    const migrated = manager.mergeWithDefaults({
      version: 1,
      terminal: { scrollback: 20000 },
      session: { autoParking: { maxLiveAiSessions: 999, idleMinutes: 0 } }
    });
    assert.equal(migrated.version, 2);
    assert.equal(migrated.terminal.scrollback, 5000);
    assert.equal(migrated.session.autoParking.maxLiveAiSessions, 20);
    assert.equal(migrated.session.autoParking.idleMinutes, 15);
    assert.equal(manager.mergeWithDefaults({ version: 2, terminal: { scrollback: 20000 } }).terminal.scrollback, 20000);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('parking audit retains newest 500 valid events and ignores malformed lines', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'easycc-parking-log-'));
  try {
    const store = new DataStore(dir);
    const now = Date.now();
    const lines = ['not-json'];
    for (let index = 0; index < 510; index += 1) {
      lines.push(JSON.stringify({
        timestamp: new Date(now - (509 - index) * 1000).toISOString(),
        eventType: 'parking_proposed',
        sessionId: `s${index}`
      }));
    }
    fs.writeFileSync(store.parkingEventsFile, `${lines.join('\n')}\n`, 'utf8');
    store.compactParkingEvents(now);
    const events = store.getRecentParkingEvents(500);
    assert.equal(events.length, 500);
    assert.equal(events[0].sessionId, 's509');
    assert.equal(events.at(-1).sessionId, 's10');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('in-flight delayed queue delivery persists as recoverable queued input', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'easycc-delivering-queue-'));
  try {
    const store = new DataStore(dir);
    store.saveSession({
      id: 'delivering-session',
      name: 'Delivering session',
      workingDir: 'C:\\repo',
      cliType: 'codex-windows',
      status: 'idle',
      messageQueue: [{
        id: 'pending-enter',
        text: 'continue\r',
        status: 'delivering',
        queuedAt: new Date().toISOString()
      }]
    });

    const restored = store.loadSessions()['delivering-session'];
    assert.equal(restored.messageQueue.length, 1);
    assert.equal(restored.messageQueue[0].status, 'queued');
    assert.equal(restored.messageQueue[0].text, 'continue\r');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function liveSession(id, overrides = {}) {
  const readyAt = new Date(Date.now() - 20 * 60_000).toISOString();
  return {
    id,
    name: id,
    cliType: 'claude',
    status: 'idle',
    runtimeState: 'live',
    pty: {},
    claudeSessionId: `${id}-claude`,
    idleEvidence: 'claude_stop_hook',
    readySince: readyAt,
    lastActivity: new Date(readyAt),
    lastUserOrOrchestratorActivityAt: readyAt,
    parkingProposalState: 'none',
    ...overrides
  };
}

test('coordinator protects visible sessions and elects one modal owner', () => {
  const manager = new EventEmitter();
  manager.sessions = new Map([
    ['visible', liveSession('visible')],
    ['hidden', liveSession('hidden')]
  ]);
  manager.isParkingEligible = () => true;
  manager.getSessionSnapshot = session => ({ ...session, pty: undefined });
  manager.dataStore = { logParkingEvent() {} };
  const settingsManager = {
    loadSettings: () => ({
      session: { autoParking: { enabled: true, maxLiveAiSessions: 6, idleMinutes: 15, snoozeMinutes: 15 } }
    })
  };
  const coordinator = new ParkingCoordinator({ sessionManager: manager, settingsManager, broadcast() {} });
  const socket = { close() {} };
  const clientId = coordinator.registerClient(socket);
  coordinator.updatePresence(clientId, {
    focused: true,
    minimized: false,
    visibleSessionIds: ['visible']
  });
  const summary = coordinator.evaluate();
  assert.equal(manager.sessions.get('visible').parkingProposalState, 'none');
  assert.equal(manager.sessions.get('hidden').parkingProposalState, 'pending_review');
  assert.equal(summary.modalOwnerClientId, clientId);
  coordinator.stop();
});

test('disabled parking clears proposals and rejects stale confirmations', async () => {
  const session = liveSession('disabled', { parkingProposalState: 'pending_review' });
  const manager = new EventEmitter();
  manager.sessions = new Map([[session.id, session]]);
  manager.isParkingEligible = () => true;
  manager.getSessionSnapshot = value => ({ ...value, pty: undefined });
  manager.dataStore = { logParkingEvent() {} };
  manager.parkSession = async () => {
    throw new Error('parkSession must not run while parking is disabled');
  };
  const settingsManager = {
    loadSettings: () => ({
      session: { autoParking: { enabled: false, maxLiveAiSessions: 6, idleMinutes: 15, snoozeMinutes: 15 } }
    })
  };
  const coordinator = new ParkingCoordinator({ sessionManager: manager, settingsManager, broadcast() {} });

  coordinator.evaluate();
  const summary = coordinator.getSummary();
  const result = await coordinator.confirm([session.id]);

  assert.equal(session.parkingProposalState, 'none');
  assert.equal(summary.review, 0);
  assert.deepEqual(result.parked, []);
  assert.deepEqual(result.skipped, [{ id: session.id, reason: 'parking_disabled' }]);
});

test('confirmed parking persists auto_park only after matching PTY exit', async () => {
  const manager = Object.create(SessionManager.prototype);
  const handlers = [];
  const pty = {
    onExit(handler) { handlers.push(handler); },
    kill() { queueMicrotask(() => handlers.forEach(handler => handler({ exitCode: 0 }))); }
  };
  const session = liveSession('one', {
    pty,
    ptyGeneration: 3,
    outputBuffer: new ByteRingBuffer(1024)
  });
  session.outputBuffer.push('transcript');
  manager.sessions = new Map([[session.id, session]]);
  manager.parkingTransitions = new Map();
  manager.isShuttingDown = false;
  manager.isParkingEligible = () => true;
  manager.cancelPendingStatusTransition = () => {};
  manager.flushTranscriptStrict = () => true;
  manager.getSessionSnapshot = value => ({
    id: value.id,
    status: value.status,
    runtimeState: value.runtimeState,
    pauseReason: value.pauseReason
  });
  const saved = [];
  manager.dataStore = {
    saveSession(value) { saved.push({ status: value.status, pauseReason: value.pauseReason }); }
  };
  manager.emit = () => {};

  const result = await manager.parkSession(session.id);
  assert.equal(result.ok, true);
  assert.deepEqual(saved, [{ status: 'paused', pauseReason: 'auto_park' }]);
  assert.equal(session.runtimeState, 'auto_parked');
  assert.equal(session.pty, null);
  assert.equal(session.outputBuffer.getAll().length, 0);
});

test('Codex wake rejects an observed conversation that differs from the expected target', () => {
  const manager = Object.create(SessionManager.prototype);
  const session = liveSession('codex-one', {
    cliType: 'codex',
    runtimeState: 'resuming',
    workingDir: 'C:\\repo',
    codexSessionId: 'expected-id',
    expectedCodexWakeId: 'expected-id',
    codexIdentityState: 'verifying'
  });
  manager.sessions = new Map([[session.id, session]]);
  manager.dataStore = { saveSession() {} };
  manager.emit = () => {};
  manager.getSessionSnapshot = value => ({ id: value.id });

  manager.applyCodexIdentityObservation({
    sessionId: session.id,
    state: 'verified',
    candidateId: 'wrong-id',
    workingDir: 'C:\\repo'
  });

  assert.equal(session.codexSessionId, 'expected-id');
  assert.equal(session.codexIdentityState, 'unresolved');
  assert.match(session.codexIdentityError, /expected-id.*wrong-id/);
});

test('Claude elicitation remains protected across Stop and PreToolUse ordering', () => {
  const manager = Object.create(SessionManager.prototype);
  const session = liveSession('claude-one', {
    workingDir: 'C:\\repo',
    interactionPending: false
  });
  manager.sessions = new Map([[session.id, session]]);
  manager.dataStore = { saveSession() {} };
  manager.emit = () => {};
  manager.getSessionSnapshot = value => ({ id: value.id });
  manager.startIdleDetection = () => {};

  manager.applyHookStatus({
    cwd: session.workingDir,
    claudeSessionId: session.claudeSessionId,
    hookEvent: 'Notification',
    status: 'waiting',
    notificationType: 'elicitation_dialog'
  });
  manager.applyHookStatus({
    cwd: session.workingDir,
    claudeSessionId: session.claudeSessionId,
    hookEvent: 'Stop',
    status: 'idle'
  });
  manager.applyHookStatus({
    cwd: session.workingDir,
    claudeSessionId: session.claudeSessionId,
    hookEvent: 'PreToolUse',
    status: 'editing'
  });

  assert.equal(session.interactionPending, true);
  assert.equal(session.status, 'waiting');
  assert.equal(session.idleEvidence, null);
});

test('AskUserQuestion tool evidence remains protected after Stop', () => {
  const manager = Object.create(SessionManager.prototype);
  const session = liveSession('claude-question', { workingDir: 'C:\\repo' });
  manager.sessions = new Map([[session.id, session]]);
  manager.dataStore = { saveSession() {} };
  manager.emit = () => {};
  manager.getSessionSnapshot = value => ({ id: value.id });
  manager.startIdleDetection = () => {};

  manager.applyHookStatus({
    cwd: session.workingDir,
    claudeSessionId: session.claudeSessionId,
    hookEvent: 'PreToolUse',
    status: 'editing',
    toolName: 'AskUserQuestion'
  });
  manager.applyHookStatus({
    cwd: session.workingDir,
    claudeSessionId: session.claudeSessionId,
    hookEvent: 'Stop',
    status: 'idle'
  });

  assert.equal(session.interactionPending, true);
  assert.equal(session.interactionPendingKind, 'elicitation_dialog');
  assert.equal(session.status, 'waiting');
});

test('parking reports persistence failure and retains replay bytes', async () => {
  const manager = Object.create(SessionManager.prototype);
  const handlers = [];
  const pty = {
    onExit(handler) { handlers.push(handler); },
    kill() { queueMicrotask(() => handlers.forEach(handler => handler({ exitCode: 0 }))); }
  };
  const session = liveSession('save-failure', {
    pty,
    ptyGeneration: 1,
    outputBuffer: new ByteRingBuffer(1024)
  });
  session.outputBuffer.push('recoverable output');
  manager.sessions = new Map([[session.id, session]]);
  manager.isParkingEligible = () => true;
  manager.cancelPendingStatusTransition = () => {};
  manager.flushTranscriptStrict = () => true;
  manager.getSessionSnapshot = value => ({
    id: value.id,
    runtimeState: value.runtimeState,
    pauseReason: value.pauseReason
  });
  manager.dataStore = {
    saveSession(_value, options) {
      if (options?.throwOnError) throw new Error('disk full');
    }
  };
  manager.emit = () => {};

  const result = await manager.parkSession(session.id);
  assert.equal(result.ok, false);
  assert.equal(result.error, 'persistence_failed');
  assert.equal(session.runtimeState, 'paused');
  assert.equal(session.outputBuffer.getAll().join(''), 'recoverable output');
});

test('strict transcript flush retains the pending batch when append fails', () => {
  const manager = Object.create(SessionManager.prototype);
  manager.transcriptWriteBuffers = new Map([['one', {
    data: 'pending transcript',
    bytes: 18,
    timer: null
  }]]);
  manager.getTranscriptPath = () => os.tmpdir();

  assert.throws(() => manager.flushTranscriptStrict('one'));
  assert.equal(manager.transcriptWriteBuffers.get('one').data, 'pending transcript');
});

test('manual pause is rejected while a lifecycle transition owns the session', () => {
  const manager = Object.create(SessionManager.prototype);
  const session = liveSession('locked');
  manager.sessions = new Map([[session.id, session]]);
  manager.lifecycleTransitions = new Map([[session.id, 'parking']]);
  assert.equal(manager.pauseSession(session.id), false);
});

test('duplicate lifecycle requests join the existing transition promise', () => {
  const manager = Object.create(SessionManager.prototype);
  const inFlight = Promise.resolve({ ok: true });
  manager.lifecycleTransitions = new Map([['one', { kind: 'parking', promise: inFlight }]]);
  assert.equal(manager.parkSession('one'), inFlight);
});

test('Retry Kill retains replay bytes when durable cleanup persistence fails', async () => {
  const manager = Object.create(SessionManager.prototype);
  const session = liveSession('retry-save-failure', {
    runtimeState: 'parking_failed_live',
    ptyGeneration: 4,
    lastPtyExitGeneration: 4,
    outputBuffer: new ByteRingBuffer(1024)
  });
  session.outputBuffer.push('retain me');
  manager.sessions = new Map([[session.id, session]]);
  manager.getSessionSnapshot = value => ({
    id: value.id,
    runtimeState: value.runtimeState,
    pauseReason: value.pauseReason
  });
  manager.dataStore = {
    saveSession(_value, options) {
      if (options?.throwOnError) throw new Error('disk full');
    }
  };
  manager.emit = () => {};

  const result = await manager.retryTerminateSession(session.id);
  assert.equal(result.ok, false);
  assert.equal(result.error, 'persistence_failed');
  assert.equal(session.runtimeState, 'paused');
  assert.equal(session.outputBuffer.getAll().join(''), 'retain me');
});

function createCodexWakeHarness({ identityState = 'verifying', attemptError = null } = {}) {
  const manager = Object.create(SessionManager.prototype);
  const delivered = [];
  const pty = {
    writes: [],
    kill() {},
    write(value) { this.writes.push(value); }
  };
  const session = liveSession('codex-wake', {
    cliType: 'codex-windows',
    status: 'paused',
    runtimeState: 'auto_parked',
    pauseReason: 'auto_park',
    pty: null,
    ptyGeneration: 4,
    workingDir: 'C:\\repo',
    codexSessionId: '11111111-1111-4111-8111-111111111111',
    codexIdentityState: identityState,
    codexIdentityError: null,
    messageQueue: [{ id: 'queued-one', text: 'continue\r', status: 'queued' }]
  });
  manager.sessions = new Map([[session.id, session]]);
  manager.lifecycleTransitions = new Map();
  manager.codexWindowsHookTokens = new Map();
  manager.dataStore = { saveSession() {} };
  manager.emit = () => {};
  manager.getSessionSnapshot = value => ({
    id: value.id,
    runtimeState: value.runtimeState,
    codexIdentityState: value.codexIdentityState,
    wakeError: value.wakeError,
    wakeWarning: value.wakeWarning
  });
  manager.getCodexWindowsWakeCollision = () => null;
  manager.wakeTimeoutMs = 50;
  manager.wakePollMs = 1;
  manager.wakeSleep = () => Promise.resolve();
  manager.codexHookCorroborationTimeoutMs = 5;
  manager.waitForPtyExit = async () => ({ exited: true });
  manager.resumeSession = () => {
    session.pty = pty;
    session.ptyGeneration += 1;
    session.status = 'idle';
    session.idleEvidence = 'codex_ready_prompt';
    session.readySince = new Date(Date.now() - 3_000).toISOString();
    session.codexIdentityState = identityState;
    const token = 'wake-token';
    manager.codexWindowsHookTokens.set(session.id, {
      token,
      generation: session.ptyGeneration,
      resumeTarget: session.expectedCodexWakeId
    });
    session.codexWakeAttempt = {
      expectedId: session.expectedCodexWakeId,
      launchTarget: session.expectedCodexWakeId,
      cliType: 'codex-windows',
      token,
      ptyGeneration: session.ptyGeneration,
      startedAt: Date.now(),
      fallbackAt: null,
      startupOutput: '',
      error: attemptError,
      corroborationTimer: null
    };
    return true;
  };
  manager.drainMessageQueue = value => {
    const queued = value.messageQueue.filter(message => message.status === 'queued');
    delivered.push(...queued.map(message => message.text));
    value.messageQueue = [];
  };
  return { manager, session, pty, delivered };
}

test('exact Codex Windows wake drains once after ready prompt without waiting for SessionStart', async () => {
  const { manager, session, delivered } = createCodexWakeHarness();
  const result = await manager.wakeSession(session.id);

  assert.equal(result.ok, true);
  assert.equal(session.runtimeState, 'live');
  assert.equal(session.codexIdentityState, 'resume_verified');
  assert.deepEqual(delivered, ['continue\r']);
  assert.ok(session.codexWakeAttempt);
  manager.clearCodexWindowsWakeAttempt(session, { clearToken: true });
});

test('mismatched or failed Codex Windows wake never drains queued input', async () => {
  const { manager, session, delivered } = createCodexWakeHarness({
    attemptError: { code: 'identity_mismatch', message: 'Exact Codex wake resumed a different ID' }
  });
  const result = await manager.wakeSession(session.id);

  assert.equal(result.ok, false);
  assert.equal(result.error, 'identity_mismatch');
  assert.deepEqual(delivered, []);
  assert.equal(session.runtimeState, 'auto_parked');
  assert.match(session.wakeError, /different ID/);
});

test('Codex Windows collision preflight never spawns or drains', async () => {
  const { manager, session, delivered } = createCodexWakeHarness();
  let spawned = false;
  manager.getCodexWindowsWakeCollision = () => 'Codex conversation is already open';
  manager.resumeSession = () => { spawned = true; return true; };

  const result = await manager.wakeSession(session.id);
  assert.equal(result.error, 'identity_conflict');
  assert.equal(spawned, false);
  assert.deepEqual(delivered, []);
  assert.equal(session.runtimeState, 'auto_parked');
});

test('Codex Windows collision preflight rechecks EasyCC ownership after async scan', async () => {
  const { manager, session } = createCodexWakeHarness();
  manager.getCodexWindowsWakeCollision = SessionManager.prototype.getCodexWindowsWakeCollision;
  manager.findCodexWindowsResumeOwners = async () => {
    manager.sessions.set('racing-owner', liveSession('racing-owner', {
      name: 'Racing owner',
      cliType: 'codex-windows',
      status: 'idle',
      runtimeState: 'live',
      pty: {},
      codexSessionId: session.codexSessionId
    }));
    return [];
  };

  const collision = await manager.getCodexWindowsWakeCollision(session, session.codexSessionId);
  assert.match(collision, /Racing owner/);
});

test('timely and late Windows SessionStart callbacks corroborate the exact wake', async () => {
  const timely = createCodexWakeHarness({ identityState: 'verified' });
  const timelyResult = await timely.manager.wakeSession(timely.session.id);
  assert.equal(timelyResult.ok, true);
  assert.equal(timely.session.codexIdentityState, 'verified');
  assert.equal(timely.session.codexWakeAttempt, null);

  const late = createCodexWakeHarness();
  await late.manager.wakeSession(late.session.id);
  const accepted = late.manager.acceptCodexWindowsSessionStart(
    late.session.id,
    'wake-token',
    { session_id: late.session.codexSessionId, cwd: late.session.workingDir }
  );
  assert.equal(accepted, true);
  assert.equal(late.session.codexIdentityState, 'verified');
  assert.equal(late.session.codexWakeAttempt, null);
  assert.equal(late.session.wakeWarning, null);
  assert.deepEqual(late.delivered, ['continue\r']);
});

test('late mismatched SessionStart makes an already-ready wake recoverable', async () => {
  const { manager, session, delivered } = createCodexWakeHarness();
  await manager.wakeSession(session.id);
  const accepted = manager.acceptCodexWindowsSessionStart(
    session.id,
    'wake-token',
    { session_id: '22222222-2222-4222-8222-222222222222', cwd: session.workingDir }
  );
  assert.equal(accepted, true);
  assert.equal(session.runtimeState, 'wake_failed_live');
  assert.equal(session.codexIdentityState, 'unresolved');
  assert.match(session.wakeError, /expected.*11111111.*22222222/i);
  assert.deepEqual(delivered, ['continue\r']);
});

test('stale SessionStart callback from an older PTY generation is ignored', async () => {
  const { manager, session } = createCodexWakeHarness();
  await manager.wakeSession(session.id);
  const originalGeneration = session.ptyGeneration;
  session.ptyGeneration += 1;

  const accepted = manager.acceptCodexWindowsSessionStart(
    session.id,
    'wake-token',
    { session_id: session.codexSessionId, cwd: session.workingDir }
  );
  assert.equal(accepted, false);
  assert.equal(session.codexIdentityState, 'resume_verified');
  session.ptyGeneration = originalGeneration;
  manager.clearCodexWindowsWakeAttempt(session, { clearToken: true });
});

test('missing callback produces a live warning and does not block future parking', async () => {
  const { manager, session } = createCodexWakeHarness();
  await manager.wakeSession(session.id);
  await new Promise(resolve => setTimeout(resolve, 15));

  assert.match(session.wakeWarning, /callback did not arrive/i);
  assert.equal(manager.isParkingEligible(session), true);
  manager.clearCodexWindowsWakeAttempt(session, { clearToken: true });
});

test('brand-new Codex Windows ready prompt cannot use exact-resume fallback', () => {
  const manager = Object.create(SessionManager.prototype);
  const pty = {};
  const session = liveSession('new-codex-windows', {
    cliType: 'codex-windows',
    pty,
    ptyGeneration: 1,
    status: 'idle',
    runtimeState: 'live',
    codexSessionId: null,
    expectedCodexWakeId: null,
    codexIdentityState: 'verifying',
    idleEvidence: 'codex_ready_prompt',
    readySince: new Date(Date.now() - 3_000).toISOString()
  });
  assert.equal(manager.evaluateWakeReadiness(session, pty, 1).ready, false);
});

test('a transient Codex Windows startup prompt is not resume-ready', () => {
  const { manager, session, pty } = createCodexWakeHarness();
  session.runtimeState = 'resuming';
  session.expectedCodexWakeId = session.codexSessionId;
  manager.resumeSession();
  session.readySince = new Date().toISOString();

  assert.equal(
    manager.evaluateWakeReadiness(session, pty, session.ptyGeneration).ready,
    false
  );
});

test('Codex Windows wake timeout returns to recoverable parked state with queue intact', async () => {
  const { manager, session, delivered } = createCodexWakeHarness();
  const resume = manager.resumeSession;
  manager.wakeTimeoutMs = 1;
  manager.resumeSession = () => {
    const started = resume();
    session.status = 'active';
    session.idleEvidence = null;
    session.readySince = null;
    return started;
  };

  const result = await manager.wakeSession(session.id);
  assert.equal(result.ok, false);
  assert.equal(result.error, 'wake_timeout');
  assert.equal(session.runtimeState, 'auto_parked');
  assert.equal(session.status, 'paused');
  assert.equal(session.pty, null);
  assert.match(session.wakeError, /did not become ready/i);
  assert.equal(session.messageQueue.length, 1);
  assert.deepEqual(delivered, []);
});

test('startup errors split across PTY chunks fail the current wake generation', () => {
  const { manager, session } = createCodexWakeHarness();
  session.runtimeState = 'resuming';
  session.expectedCodexWakeId = session.codexSessionId;
  manager.resumeSession();

  assert.equal(manager.observeCodexWakeStartupOutput(session, 'Error: conversation already ', session.ptyGeneration), false);
  assert.equal(manager.observeCodexWakeStartupOutput(session, 'in use', session.ptyGeneration), true);
  assert.equal(session.codexWakeAttempt.error.code, 'identity_conflict');
});

test('ordinary resumed conversation text cannot become a startup collision', () => {
  const { manager, session } = createCodexWakeHarness();
  session.runtimeState = 'resuming';
  session.expectedCodexWakeId = session.codexSessionId;
  manager.resumeSession();

  assert.equal(manager.observeCodexWakeStartupOutput(
    session,
    'The likely failure is a circular dependency: the conversation may already be open.\n' +
      'We previously failed to resume because queued input stayed blocked.',
    session.ptyGeneration
  ), false);
  assert.equal(session.codexWakeAttempt.error, null);
});

test('a second exact wake replaces attempt state and delivers no duplicate prompt', async () => {
  const { manager, session, delivered } = createCodexWakeHarness();
  await manager.wakeSession(session.id);
  const firstAttempt = session.codexWakeAttempt;
  manager.clearCodexWindowsWakeAttempt(session, { clearToken: true });
  session.runtimeState = 'auto_parked';
  session.pauseReason = 'auto_park';
  session.status = 'paused';
  session.pty = null;
  session.messageQueue = [{ id: 'queued-two', text: 'continue again\r', status: 'queued' }];

  await manager.wakeSession(session.id);
  assert.notEqual(session.codexWakeAttempt, firstAttempt);
  assert.deepEqual(delivered, ['continue\r', 'continue again\r']);
  manager.clearCodexWindowsWakeAttempt(session, { clearToken: true });
});

test('Codex Windows submits queued text with a generation-scoped Enter keypress', () => {
  const writes = [];
  const timers = [];
  const pty = {};
  const session = {
    cliType: 'codex-windows',
    pty,
    ptyGeneration: 7,
    runtimeState: 'live'
  };
  const manager = {
    _writeToPty(current, text) {
      assert.equal(current, session);
      writes.push(text);
    },
    setTimeoutFn(callback, delay) {
      timers.push({ callback, delay });
    }
  };

  SessionManager.prototype._writeInputToPty.call(
    manager,
    session,
    'continue\r',
    { submitDelayMs: 2_000 }
  );
  assert.deepEqual(writes, ['continue']);
  assert.equal(timers.length, 1);
  assert.equal(timers[0].delay, 2_000);

  timers[0].callback();
  assert.deepEqual(writes, ['continue', '\r']);

  SessionManager.prototype._writeInputToPty.call(
    manager,
    session,
    'next\r',
    { submitDelayMs: 2_000 }
  );
  session.pty = {};
  session.ptyGeneration += 1;
  timers[1].callback();
  assert.deepEqual(writes, ['continue', '\r', 'next']);

  SessionManager.prototype._writeInputToPty.call(manager, session, 'fresh\r');
  assert.deepEqual(writes, ['continue', '\r', 'next', 'fresh\r']);
  assert.equal(timers.length, 2);
});

test('cancelled delayed resume Enter preserves the queued message for recovery', () => {
  const callbacks = [];
  const message = {
    id: 'pending-enter',
    text: 'continue\r',
    status: 'queued',
    queuedAt: new Date().toISOString()
  };
  const session = liveSession('delayed-enter', {
    cliType: 'codex-windows',
    status: 'idle',
    runtimeState: 'live',
    pty: {},
    messageQueue: [message]
  });
  const manager = {
    canAcceptOrchestratorInput: () => true,
    _sweepExpiredQueueMessages: SessionManager.prototype._sweepExpiredQueueMessages,
    finishDelayedQueueDelivery: SessionManager.prototype.finishDelayedQueueDelivery,
    sendInput(_id, _text, options) {
      callbacks.push(options.onCodexWindowsSubmitted);
      return true;
    },
    dataStore: { saveSession() {} },
    emit() {},
    getSessionSnapshot: value => value
  };

  SessionManager.prototype.drainMessageQueue.call(
    manager,
    session,
    { codexWindowsResume: true }
  );
  assert.equal(message.status, 'delivering');
  assert.equal(session.messageQueue.length, 1);

  callbacks[0](false);
  assert.equal(message.status, 'queued');
  assert.equal(session.messageQueue.length, 1);

  SessionManager.prototype.drainMessageQueue.call(
    manager,
    session,
    { codexWindowsResume: true }
  );
  callbacks[1](true);
  assert.equal(session.messageQueue.length, 0);
});

test('killing a session during delayed resume submission suppresses Enter safely', () => {
  const timers = [];
  const submitted = [];
  const writes = [];
  const session = {
    id: 'killed-delay',
    cliType: 'codex-windows',
    pty: {},
    ptyGeneration: 3,
    runtimeState: 'live',
    status: 'idle'
  };
  const manager = {
    sessions: new Map([[session.id, session]]),
    _writeToPty(_session, text) { writes.push(text); },
    setTimeoutFn(callback) { timers.push(callback); }
  };

  SessionManager.prototype._writeInputToPty.call(
    manager,
    session,
    'continue\r',
    { submitDelayMs: 2_000, onSubmitted: value => submitted.push(value) }
  );
  manager.sessions.delete(session.id);
  session.status = 'killed';
  timers[0]();

  assert.deepEqual(writes, ['continue']);
  assert.deepEqual(submitted, [false]);
});

test('delayed resume delivery waits for large body chunks before acknowledging Enter', () => {
  const timers = [];
  const submitted = [];
  const writes = [];
  const session = {
    id: 'large-delay',
    cliType: 'codex-windows',
    pty: {},
    ptyGeneration: 4,
    runtimeState: 'live',
    status: 'idle',
    _writeDraining: false
  };
  const manager = {
    sessions: new Map([[session.id, session]]),
    _writeToPty(_session, text) {
      writes.push(text);
      if (text !== '\r') session._writeDraining = true;
    },
    setTimeoutFn(callback, delay) { timers.push({ callback, delay }); }
  };

  SessionManager.prototype._writeInputToPty.call(
    manager,
    session,
    `${'x'.repeat(2048)}\r`,
    { submitDelayMs: 2_000, onSubmitted: value => submitted.push(value) }
  );
  timers.shift().callback();
  assert.deepEqual(submitted, []);
  assert.equal(timers[0].delay, 10);

  session._writeDraining = false;
  timers.shift().callback();
  assert.equal(writes.at(-1), '\r');
  assert.deepEqual(submitted, [true]);
});

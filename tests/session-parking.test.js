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

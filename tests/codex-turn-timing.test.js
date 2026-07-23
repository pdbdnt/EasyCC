const test = require('node:test');
const assert = require('node:assert/strict');

const SessionManager = require('../backend/sessionManager');

function createHarness() {
  const manager = Object.create(SessionManager.prototype);
  const session = {
    id: 'easycc-session',
    name: 'Codex timer',
    cliType: 'codex-windows',
    workingDir: 'C:\\repo',
    codexSessionId: '11111111-1111-4111-8111-111111111111',
    pty: {},
    ptyGeneration: 3,
    runtimeState: 'live',
    status: 'thinking',
    codexTurnTiming: null
  };
  const saved = [];
  const emitted = [];

  manager.sessions = new Map([[session.id, session]]);
  manager.codexWindowsHookTokens = new Map([[
    session.id,
    { token: 'timing-token', generation: session.ptyGeneration }
  ]]);
  manager.dataStore = { saveSession: value => saved.push(value.codexTurnTiming && { ...value.codexTurnTiming }) };
  manager.emit = (event, value) => emitted.push({ event, value });
  manager.getSessionSnapshot = value => ({
    id: value.id,
    codexTurnTiming: value.codexTurnTiming && { ...value.codexTurnTiming }
  });

  return { manager, session, saved, emitted };
}

function payload(hookEvent, turnId = 'turn-1') {
  return {
    hook_event_name: hookEvent,
    session_id: '11111111-1111-4111-8111-111111111111',
    turn_id: turnId,
    cwd: 'C:\\repo'
  };
}

test('Codex Windows timing records prompt start and exact normal completion', () => {
  const { manager, session, saved, emitted } = createHarness();
  const startedAt = Date.parse('2026-07-23T00:00:00.000Z');

  assert.equal(manager.acceptCodexWindowsTurnTiming(
    session.id,
    'timing-token',
    payload('UserPromptSubmit'),
    startedAt
  ), true);
  assert.deepEqual(session.codexTurnTiming, {
    codexSessionId: '11111111-1111-4111-8111-111111111111',
    turnId: 'turn-1',
    status: 'running',
    startedAt: '2026-07-23T00:00:00.000Z',
    completedAt: null,
    elapsedMs: null,
    stopObservedAt: null
  });

  assert.equal(manager.acceptCodexWindowsTurnTiming(
    session.id,
    'timing-token',
    payload('Stop'),
    startedAt + 323_456
  ), true);
  assert.equal(session.codexTurnTiming.status, 'running');
  manager.reconcileCodexTurnTimingAtReady(session);
  assert.equal(session.codexTurnTiming.status, 'completed');
  assert.equal(session.codexTurnTiming.elapsedMs, 323_456);
  assert.equal(session.codexTurnTiming.completedAt, '2026-07-23T00:05:23.456Z');
  assert.equal(saved.length, 3);
  assert.equal(emitted.filter(entry => entry.event === 'sessionUpdated').length, 3);
});

test('Codex Windows timing callbacks are idempotent and reject mismatched turns', () => {
  const { manager, session, saved } = createHarness();
  const startedAt = Date.parse('2026-07-23T00:00:00.000Z');

  assert.equal(manager.acceptCodexWindowsTurnTiming(
    session.id,
    'timing-token',
    payload('UserPromptSubmit'),
    startedAt
  ), true);
  assert.equal(manager.acceptCodexWindowsTurnTiming(
    session.id,
    'timing-token',
    payload('UserPromptSubmit'),
    startedAt + 1_000
  ), true);
  assert.equal(saved.length, 1);
  assert.equal(manager.acceptCodexWindowsTurnTiming(
    session.id,
    'timing-token',
    payload('Stop', 'another-turn'),
    startedAt + 5_000
  ), false);
  assert.equal(session.codexTurnTiming.status, 'running');

  assert.equal(manager.acceptCodexWindowsTurnTiming(
    session.id,
    'timing-token',
    payload('Stop'),
    startedAt + 10_000
  ), true);
  assert.equal(manager.acceptCodexWindowsTurnTiming(
    session.id,
    'timing-token',
    payload('Stop'),
    startedAt + 20_000
  ), true);
  assert.equal(saved.length, 3);
  assert.equal(session.codexTurnTiming.stopObservedAt, '2026-07-23T00:00:20.000Z');
  manager.reconcileCodexTurnTimingAtReady(session);
  assert.equal(session.codexTurnTiming.elapsedMs, 20_000);
});

test('Codex Windows timing clears a prompt rejected by another hook', () => {
  const { manager, session } = createHarness();
  const startedAt = Date.parse('2026-07-23T00:00:00.000Z');

  assert.equal(manager.acceptCodexWindowsTurnTiming(
    session.id,
    'timing-token',
    payload('UserPromptSubmit'),
    startedAt
  ), true);
  manager.reconcileCodexTurnTimingAtReady(session);
  assert.equal(session.codexTurnTiming, null);
});

test('Codex Windows timing rejects events from a switched conversation', () => {
  const { manager, session } = createHarness();
  manager.acceptCodexWindowsTurnTiming(
    session.id,
    'timing-token',
    payload('UserPromptSubmit'),
    Date.parse('2026-07-23T00:00:00.000Z')
  );

  session.codexSessionId = '22222222-2222-4222-8222-222222222222';
  assert.equal(manager.acceptCodexWindowsTurnTiming(
    session.id,
    'timing-token',
    payload('Stop')
  ), false);
  assert.equal(
    session.codexTurnTiming.codexSessionId,
    '11111111-1111-4111-8111-111111111111'
  );
});

test('Codex Windows timing rejects stale authentication and conversation identity', () => {
  const { manager, session } = createHarness();

  assert.equal(manager.acceptCodexWindowsTurnTiming(
    session.id,
    'wrong-token',
    payload('UserPromptSubmit')
  ), false);
  assert.equal(manager.acceptCodexWindowsTurnTiming(
    session.id,
    'timing-token',
    { ...payload('UserPromptSubmit'), session_id: '22222222-2222-4222-8222-222222222222' }
  ), false);
  assert.equal(session.codexTurnTiming, null);
});

test('restoring a running timer converts it to a finite stopped duration', () => {
  const { manager } = createHarness();
  const restored = manager.restoreCodexTurnTiming({
    turnId: 'turn-1',
    status: 'running',
    startedAt: '2026-07-23T00:00:00.000Z'
  }, '2026-07-23T00:02:30.000Z');

  assert.deepEqual(restored, {
    codexSessionId: null,
    turnId: 'turn-1',
    status: 'stopped',
    startedAt: '2026-07-23T00:00:00.000Z',
    completedAt: '2026-07-23T00:02:30.000Z',
    elapsedMs: 150_000,
    stopObservedAt: null
  });
});

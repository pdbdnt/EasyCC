const test = require('node:test');
const assert = require('node:assert/strict');

const SessionManager = require('../backend/sessionManager');

function createHarness({ cliType = 'codex-windows', promptBuffer = 'first line' } = {}) {
  const writes = [];
  const promptHistory = [];
  let semanticSubmissions = 0;
  const pendingStatusTimer = setTimeout(() => {}, 60_000);
  const promptFlushTimer = setTimeout(() => {}, 60_000);
  const session = {
    id: 'soft-newline-session',
    cliType,
    runtimeState: 'live',
    status: 'waiting',
    stage: 'in_progress',
    currentTask: '',
    promptBuffer,
    promptHistory,
    promptFlushTimer,
    inEscapeSeq: false,
    isComposingPrompt: promptBuffer.length > 0,
    statusDetectionContext: 'ready context',
    pendingStatus: 'idle',
    statusDebounceTimer: pendingStatusTimer,
    lastSubmittedInputAtMs: 123,
    lastUserOrOrchestratorActivityAt: '2026-07-23T00:00:00.000Z',
    readySince: '2026-07-23T00:00:00.000Z',
    idleEvidence: 'codex_ready_prompt',
    interactionPending: true,
    interactionPendingSource: 'test',
    manuallyPlaced: true,
    placementLocked: false,
    manualPlacedAt: '2026-07-23T00:00:00.000Z',
    parkingProposalState: 'proposed',
    parkingProposalReason: 'idle',
    parkingDetectedAt: '2026-07-23T00:00:00.000Z'
  };
  const manager = {
    sessions: new Map([[session.id, session]]),
    _writeInputToPty(_session, text) {
      writes.push(text);
    },
    clearPromptFlushTimer: SessionManager.prototype.clearPromptFlushTimer,
    flushPromptBuffer: SessionManager.prototype.flushPromptBuffer,
    cancelPendingStatusTransition: SessionManager.prototype.cancelPendingStatusTransition,
    markSemanticSubmission(current, options) {
      semanticSubmissions++;
      return SessionManager.prototype.markSemanticSubmission.call(this, current, options);
    },
    addPromptToHistory(_session, text) {
      promptHistory.push(text);
    },
    emit() {}
  };

  function cleanup() {
    clearTimeout(pendingStatusTimer);
    if (session.statusDebounceTimer) clearTimeout(session.statusDebounceTimer);
    if (session.promptFlushTimer) clearTimeout(session.promptFlushTimer);
  }

  return {
    cleanup,
    manager,
    promptHistory,
    session,
    semanticSubmissionCount: () => semanticSubmissions,
    writes
  };
}

function preservedState(session) {
  return {
    status: session.status,
    statusDetectionContext: session.statusDetectionContext,
    pendingStatus: session.pendingStatus,
    statusDebounceTimer: session.statusDebounceTimer,
    lastSubmittedInputAtMs: session.lastSubmittedInputAtMs,
    lastUserOrOrchestratorActivityAt: session.lastUserOrOrchestratorActivityAt,
    readySince: session.readySince,
    idleEvidence: session.idleEvidence,
    interactionPending: session.interactionPending,
    interactionPendingSource: session.interactionPendingSource,
    manuallyPlaced: session.manuallyPlaced,
    manualPlacedAt: session.manualPlacedAt,
    parkingProposalState: session.parkingProposalState,
    parkingProposalReason: session.parkingProposalReason,
    parkingDetectedAt: session.parkingDetectedAt
  };
}

test('Codex Windows soft newline stays an unsubmitted draft', () => {
  const harness = createHarness();
  const before = preservedState(harness.session);
  const ctrlEnter = '\x1b[13;5u';

  try {
    assert.equal(SessionManager.prototype.sendInput.call(
      harness.manager,
      harness.session.id,
      ctrlEnter,
      { inputIntent: 'soft_newline' }
    ), true);

    assert.deepEqual(harness.writes, [ctrlEnter]);
    assert.equal(harness.session.promptBuffer, 'first line\n');
    assert.equal(harness.session.promptFlushTimer, null);
    assert.equal(harness.session.isComposingPrompt, true);
    assert.equal(harness.semanticSubmissionCount(), 0);
    assert.deepEqual(harness.promptHistory, []);
    assert.deepEqual(preservedState(harness.session), before);
  } finally {
    harness.cleanup();
  }
});

test('soft newline in an empty composer remains a composing draft', () => {
  const harness = createHarness({ promptBuffer: '' });

  try {
    assert.equal(SessionManager.prototype.sendInput.call(
      harness.manager,
      harness.session.id,
      '\x1b[13;2u',
      { inputIntent: 'soft_newline' }
    ), true);
    assert.equal(harness.session.promptBuffer, '\n');
    assert.equal(harness.session.isComposingPrompt, true);
    assert.equal(harness.semanticSubmissionCount(), 0);
  } finally {
    harness.cleanup();
  }
});

test('ordinary Enter submits the complete multiline prompt once', () => {
  const harness = createHarness();

  try {
    assert.equal(SessionManager.prototype.sendInput.call(
      harness.manager,
      harness.session.id,
      '\x1b[106;5u',
      { inputIntent: 'soft_newline' }
    ), true);
    assert.equal(SessionManager.prototype.sendInput.call(
      harness.manager,
      harness.session.id,
      'second line'
    ), true);
    assert.equal(SessionManager.prototype.sendInput.call(
      harness.manager,
      harness.session.id,
      '\r'
    ), true);

    assert.deepEqual(harness.writes, ['\x1b[106;5u', 'second line', '\r']);
    assert.equal(harness.semanticSubmissionCount(), 1);
    assert.deepEqual(harness.promptHistory, ['first line\nsecond line']);
    assert.equal(harness.session.promptBuffer, '');
    assert.equal(harness.session.isComposingPrompt, false);
  } finally {
    harness.cleanup();
  }
});

test('invalid soft-newline combinations do not receive privileged draft handling', () => {
  for (const scenario of [
    {
      cliType: 'codex-windows',
      text: '\n',
      options: {},
      semanticSubmissions: 1
    },
    {
      cliType: 'codex',
      text: '\x1b[13;5u',
      options: { inputIntent: 'soft_newline' },
      semanticSubmissions: 0
    },
    {
      cliType: 'codex-windows',
      text: '\n',
      options: { inputIntent: 'soft_newline' },
      semanticSubmissions: 1
    },
    {
      cliType: 'codex-windows',
      text: '\x1b[120;5u',
      options: { inputIntent: 'soft_newline' },
      semanticSubmissions: 0
    }
  ]) {
    const harness = createHarness({ cliType: scenario.cliType, promptBuffer: '' });
    try {
      assert.equal(SessionManager.prototype.sendInput.call(
        harness.manager,
        harness.session.id,
        scenario.text,
        scenario.options
      ), true);
      assert.equal(harness.semanticSubmissionCount(), scenario.semanticSubmissions);
      assert.deepEqual(harness.writes, [scenario.text]);
      assert.notEqual(harness.session.promptBuffer, '\n');
    } finally {
      harness.cleanup();
    }
  }
});

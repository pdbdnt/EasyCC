const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const pty = require('../backend/node_modules/node-pty');

const {
  hasSubmittedInput,
  isLikelyLocalEchoOutput,
  shouldCountOutputAsActivity
} = require('../backend/sessionInputUtils');
const { generateSessionName, ensureUniqueSessionName } = require('../backend/sessionNaming');
const {
  DEFAULT_STAGES,
  sessionStatusToStage,
  isCodexMidWorkApprovalPrompt,
  isCodexFinalDecisionPrompt,
  decideKanbanAutoSync
} = require('../backend/stagesConfig');
const SessionManager = require('../backend/sessionManager');

function git(args, cwd) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return result.stdout.trim();
}

function createStatusHarness(initialStatus = 'thinking', cliType = 'codex') {
  const events = [];
  const session = {
    id: 'status-session',
    status: initialStatus,
    cliType,
    stage: 'in_progress',
    currentTask: '',
    statusDetectionContext: '',
    pendingStatus: null,
    statusDebounceTimer: null
  };
  const manager = {
    events,
    dataStore: { saveSession() {} },
    emit(type, payload) {
      events.push({ type, payload });
    },
    canAcceptOrchestratorInput() {
      return false;
    },
    drainMessageQueue() {},
    tryRoleInjectionOnOutput() {
      return false;
    },
    processStartupSequenceOnOutput() {
      return false;
    },
    cleanTerminalText: SessionManager.prototype.cleanTerminalText,
    updateStatusDetectionContext: SessionManager.prototype.updateStatusDetectionContext,
    detectStatus: SessionManager.prototype.detectStatus,
    cancelPendingStatusTransition: SessionManager.prototype.cancelPendingStatusTransition,
    updateSessionStatus: SessionManager.prototype.updateSessionStatus,
    processSessionOutputState: SessionManager.prototype.processSessionOutputState
  };
  return { manager, session, events };
}

function waitForStatusDebounce() {
  return new Promise(resolve => setTimeout(resolve, 575));
}

test('hasSubmittedInput: typing without Enter is not submitted input', () => {
  assert.equal(hasSubmittedInput('hello world'), false);
  assert.equal(hasSubmittedInput('abc123'), false);
});

test('hasSubmittedInput: Enter/newline is submitted input', () => {
  assert.equal(hasSubmittedInput('\r'), true);
  assert.equal(hasSubmittedInput('\n'), true);
  assert.equal(hasSubmittedInput('run tests\r'), true);
});

test('isLikelyLocalEchoOutput: short single-line output is treated as echo', () => {
  assert.equal(isLikelyLocalEchoOutput('abc'), true);
  assert.equal(isLikelyLocalEchoOutput('\x1b[32mabc\x1b[0m'), true);
});

test('isLikelyLocalEchoOutput: multiline output is not treated as echo', () => {
  assert.equal(isLikelyLocalEchoOutput('line1\nline2'), false);
});

test('shouldCountOutputAsActivity: composing prompt suppresses echo-like output', () => {
  const result = shouldCountOutputAsActivity({
    data: 'typed draft',
    isComposingPrompt: true,
    lastSubmittedInputAtMs: 0,
    nowMs: 10_000
  });
  assert.equal(result, false);
});

test('shouldCountOutputAsActivity: composing prompt allows non-echo output', () => {
  const result = shouldCountOutputAsActivity({
    data: 'Tool output:\nDone',
    isComposingPrompt: true,
    lastSubmittedInputAtMs: 0,
    nowMs: 10_000
  });
  assert.equal(result, true);
});

test('shouldCountOutputAsActivity: suppresses local echo right after Enter', () => {
  const result = shouldCountOutputAsActivity({
    data: 'npm test',
    isComposingPrompt: false,
    lastSubmittedInputAtMs: 9_000,
    nowMs: 10_000
  });
  assert.equal(result, false);
});

test('shouldCountOutputAsActivity: counts output after submit window', () => {
  const result = shouldCountOutputAsActivity({
    data: 'npm test',
    isComposingPrompt: false,
    lastSubmittedInputAtMs: 7_000,
    nowMs: 10_000
  });
  assert.equal(result, true);
});

test('ensureUniqueSessionName: adds numeric suffix for collisions', () => {
  const base = 'Session 2026-02-11-2145';
  const existing = [base, `${base} (2)`];
  assert.equal(ensureUniqueSessionName(base, existing), `${base} (3)`);
});

test('generateSessionName: uses expected prefix by cli type', () => {
  const fixed = new Date(2026, 1, 11, 21, 45, 0); // local time
  assert.match(generateSessionName(fixed, 'terminal'), /^Terminal 2026-02-11-\d{4}$/);
  assert.match(generateSessionName(fixed, 'wsl'), /^WSL 2026-02-11-\d{4}$/);
  assert.match(generateSessionName(fixed, 'codex'), /^Codex 2026-02-11-\d{4}$/);
  assert.match(generateSessionName(fixed, 'claude'), /^Session 2026-02-11-\d{4}$/);
});

test('session status mapping keeps idle in in_review', () => {
  assert.equal(sessionStatusToStage('idle'), 'in_review');
  assert.equal(sessionStatusToStage('active'), 'in_progress');
});

test('detectStatus: codex footer prompt is treated as idle', () => {
  const status = SessionManager.prototype.detectStatus.call(
    {},
    '? for shortcuts',
    'active',
    'codex'
  );
  assert.equal(status, 'idle');
});

test('detectStatus: codex input prompt line is treated as idle', () => {
  const status = SessionManager.prototype.detectStatus.call(
    {},
    '› Summarize recent commits',
    'thinking',
    'codex'
  );
  assert.equal(status, 'idle');
});

test('detectStatus: Codex draft prompt text does not trigger broad thinking words', () => {
  for (const draft of ['› Thinking through the next step', '› Processing CSV files']) {
    assert.equal(
      SessionManager.prototype.detectStatus.call({}, draft, 'idle', 'codex'),
      'idle',
      draft
    );
  }
});

test('detectStatus: real Codex activity still beats a draft prompt in the same redraw', () => {
  const redraw = '› Thinking through the next step\n• Working (5s · esc to interrupt)';
  assert.equal(
    SessionManager.prototype.detectStatus.call({}, redraw, 'idle', 'codex'),
    'thinking'
  );
});

test('detectStatus: ansi-wrapped codex prompt line is treated as idle', () => {
  const status = SessionManager.prototype.detectStatus.call(
    {},
    '\x1b[1m\n›\x1b[22m \x1b[2mImplement {feature}\x1b[22m\r\n\x1b[2m\n  gpt-5.4 high · ~/apps/specsket · Context 37% used\x1b[22m',
    'thinking',
    'codex'
  );
  assert.equal(status, 'idle');
});

test('detectStatus: single codex prompt marker is treated as idle', () => {
  const status = SessionManager.prototype.detectStatus.call(
    {},
    '›',
    'thinking',
    'codex'
  );
  assert.equal(status, 'idle');
});

test('detectStatus: codex prompt beats hidden title-spinner noise', () => {
  const status = SessionManager.prototype.detectStatus.call(
    {},
    '\x1b]0;⠙ specsket\x07\x1b[1m\n›\x1b[22m \x1b[2mImplement {feature}\x1b[22m',
    'thinking',
    'codex'
  );
  assert.equal(status, 'idle');
});

test('detectStatus: codex menu redraw uses context to stay waiting', () => {
  const status = SessionManager.prototype.detectStatus.call(
    {},
    '› 1. Yes, implement this plan\n  2. No, keep researching',
    'thinking',
    'codex',
    'Would you like to run this command?\n› 1. Yes, implement this plan\n  2. No, keep researching'
  );
  assert.equal(status, 'waiting');
});

test('detectStatus: codex approval prompt is treated as waiting', () => {
  const status = SessionManager.prototype.detectStatus.call(
    {},
    'Would you like to run this command?',
    'active',
    'codex'
  );
  assert.equal(status, 'waiting');
});

test('detectStatus: codex ready suggestion ending in question mark is idle', () => {
  const prompt = '\n› Ask why?\n';
  const promptStatus = SessionManager.prototype.detectStatus.call(
    {},
    prompt,
    'thinking',
    'codex'
  );
  const footerStatus = SessionManager.prototype.detectStatus.call(
    {},
    'gpt-5.6-sol high · ~/apps/specsket · Context 78% used · webclippeer',
    'thinking',
    'codex',
    `${prompt}gpt-5.6-sol high · ~/apps/specsket · Context 78% used · webclippeer`,
    'idle'
  );

  assert.equal(promptStatus, 'idle');
  assert.equal(footerStatus, 'idle');
});

test('status transition: split codex prompt and footer settle thinking to idle', async () => {
  const { manager, session, events } = createStatusHarness('thinking');
  const prompt = '\x1b[1m\n›\x1b[22m \x1b[2mImplement {feature}\x1b[22m\r\n';
  const footer = 'gpt-5.6-sol high · ~/apps/specsket · Context 78% used · webclippeer';

  manager.processSessionOutputState(session, prompt);
  manager.processSessionOutputState(session, footer);
  assert.equal(session.pendingStatus, 'idle');

  await waitForStatusDebounce();

  assert.equal(session.status, 'idle');
  assert.equal(
    events.filter(event => event.type === 'statusChange' && event.payload.status === 'idle').length,
    1
  );
});

test('status transition: split codex prompt and footer settle active to idle', async () => {
  const { manager, session, events } = createStatusHarness('active');
  const prompt = '\n› Implement {feature}\n';
  const footer = 'gpt-5.6-sol high · ~/apps/specsket · Context 78% used · webclippeer';

  manager.processSessionOutputState(session, prompt);
  manager.processSessionOutputState(session, footer);
  await waitForStatusDebounce();

  assert.equal(session.status, 'idle');
  assert.equal(
    events.filter(event => event.type === 'statusChange' && event.payload.status === 'idle').length,
    1
  );
});

test('status transition: current codex working signal cancels pending idle', async () => {
  const { manager, session, events } = createStatusHarness('thinking');

  manager.processSessionOutputState(session, '\n› Implement {feature}\n');
  assert.equal(session.pendingStatus, 'idle');
  manager.processSessionOutputState(session, '• Working (5s · esc to interrupt)');

  assert.equal(session.pendingStatus, null);
  assert.equal(session.statusDebounceTimer, null);
  await waitForStatusDebounce();
  assert.equal(session.status, 'thinking');
  assert.equal(events.some(event => event.payload?.status === 'idle'), false);
});

test('detectStatus: codex current signals beat contextual ready prompt', () => {
  const context = '\n› Implement {feature}\n';
  const fixtures = [
    ['Would you like to run this command?', 'waiting'],
    ['• Edited backend/sessionManager.js (+2 -1)', 'editing'],
    ['• Working (5s · esc to interrupt)', 'thinking'],
    ['command output completed successfully', 'active']
  ];

  for (const [data, expected] of fixtures) {
    const status = SessionManager.prototype.detectStatus.call(
      {},
      data,
      'thinking',
      'codex',
      `${context}${data}`,
      'idle'
    );
    assert.equal(status, expected, data);
  }
});

test('detectStatus: codex passive footer variants preserve pending idle', () => {
  const prompt = '\n› Implement {feature}\n';
  const footers = [
    '\x1b[?25h\x1b[48;1H',
    'gpt-5.6-sol high · ~/apps/specsket · Context 78% used',
    'gpt-5.6-sol high · ~/apps/specsket · Context 78% used · webclippeer · Main [default]',
    'gpt-5.6-sol high · ~/apps/specsket · Context 78% used · Fix WSL folder create · Main [default]',
    '\x1b[2m\n  gpt-5.6-sol high · ~/apps/specsket · Context 78% used · webclippeer · Main [default]          Plan mode (shift+tab to cycle)\x1b[22m\x1b[?25h'
  ];

  for (const footer of footers) {
    const status = SessionManager.prototype.detectStatus.call(
      {},
      footer,
      'thinking',
      'codex',
      `${prompt}${footer}`,
      'idle'
    );
    assert.equal(status, 'idle', footer);
  }
});

test('detectStatus: codex footer prefix does not hide substantive output', () => {
  const prompt = '\n› Implement {feature}\n';
  const fixtures = [
    'gpt-5.6-sol high · ~/apps/specsket · Context 78% used\ncommand output completed',
    'gpt-5.6-sol high · ~/apps/specsket · Context 78% used command output completed'
  ];

  for (const data of fixtures) {
    const status = SessionManager.prototype.detectStatus.call(
      {},
      data,
      'thinking',
      'codex',
      `${prompt}${data}`,
      'idle'
    );
    assert.equal(status, 'active', data);
  }
});

test('statusDetectionContext: remains capped at 4000 code units', () => {
  const manager = { cleanTerminalText: SessionManager.prototype.cleanTerminalText };
  const session = { statusDetectionContext: 'a'.repeat(3995) };
  const context = SessionManager.prototype.updateStatusDetectionContext.call(
    manager,
    session,
    'b'.repeat(5000)
  );

  assert.equal(context.length, 4000);
  assert.equal(context, 'b'.repeat(4000));
});

test('submitted input: cancels pending idle before its debounce fires', async () => {
  const { manager, session, events } = createStatusHarness('thinking');
  manager.markSemanticSubmission = SessionManager.prototype.markSemanticSubmission;

  manager.processSessionOutputState(session, '\n› Implement {feature}\n');
  assert.equal(session.pendingStatus, 'idle');
  assert.notEqual(session.statusDebounceTimer, null);

  manager.markSemanticSubmission(session, { source: 'input' });
  assert.equal(session.status, 'active');
  assert.equal(session.statusDetectionContext, '');
  assert.equal(session.pendingStatus, null);
  assert.equal(session.statusDebounceTimer, null);

  await waitForStatusDebounce();
  assert.equal(session.status, 'active');
  assert.equal(events.some(event => event.payload?.status === 'idle'), false);
});

test('submitted input: draft typing keeps context while CR, LF, and multiline clear it', () => {
  const makeHarness = () => {
    const session = {
      id: 'input-session',
      status: 'active',
      stage: 'in_progress',
      cliType: 'codex',
      currentTask: '',
      statusDetectionContext: 'ready prompt context',
      pendingStatus: null,
      statusDebounceTimer: null,
      promptBuffer: '',
      promptHistory: [],
      promptFlushTimer: null,
      inEscapeSeq: false,
      isComposingPrompt: false,
      manuallyPlaced: false,
      placementLocked: false
    };
    const manager = {
      sessions: new Map([[session.id, session]]),
      _writeToPty() {},
      emit() {},
      addPromptToHistory() {},
      cancelPendingStatusTransition: SessionManager.prototype.cancelPendingStatusTransition,
      markSemanticSubmission: SessionManager.prototype.markSemanticSubmission,
      clearPromptFlushTimer: SessionManager.prototype.clearPromptFlushTimer,
      flushPromptBuffer: SessionManager.prototype.flushPromptBuffer
    };
    return { manager, session };
  };

  const draft = makeHarness();
  assert.equal(SessionManager.prototype.sendInput.call(draft.manager, draft.session.id, 'draft'), true);
  assert.equal(draft.session.statusDetectionContext, 'ready prompt context');

  for (const input of ['\r', '\n', 'multiline prompt\n']) {
    const { manager, session } = makeHarness();
    assert.equal(SessionManager.prototype.sendInput.call(manager, session.id, input), true);
    assert.equal(session.statusDetectionContext, '', JSON.stringify(input));
  }
});

test('Codex role automation skips ready-prompt status detection in the same callback', () => {
  const writes = [];
  const events = [];
  const pendingTimer = setTimeout(() => {}, 10_000);
  const session = {
    id: 'role-session',
    status: 'thinking',
    stage: 'in_progress',
    cliType: 'codex',
    currentTask: '',
    statusDetectionContext: 'stale prompt',
    pendingStatus: 'idle',
    statusDebounceTimer: pendingTimer,
    startupSequence: null,
    roleInjection: { cliType: 'codex', role: 'Review architecture carefully.' },
    pty: { write(value) { writes.push(value); } }
  };
  const manager = {
    emit(type, payload) { events.push({ type, payload }); },
    isCodexReadyForInput: SessionManager.prototype.isCodexReadyForInput,
    injectCodexRole: SessionManager.prototype.injectCodexRole,
    tryRoleInjectionOnOutput: SessionManager.prototype.tryRoleInjectionOnOutput,
    processStartupSequenceOnOutput: SessionManager.prototype.processStartupSequenceOnOutput,
    clearRoleInjectionWorkflow: SessionManager.prototype.clearRoleInjectionWorkflow,
    cancelPendingStatusTransition: SessionManager.prototype.cancelPendingStatusTransition,
    markSemanticSubmission: SessionManager.prototype.markSemanticSubmission,
    cleanTerminalText: SessionManager.prototype.cleanTerminalText,
    updateStatusDetectionContext: SessionManager.prototype.updateStatusDetectionContext,
    detectStatus: SessionManager.prototype.detectStatus,
    updateSessionStatus() {
      assert.fail('same-callback status detection should be skipped');
    },
    processSessionOutputState: SessionManager.prototype.processSessionOutputState
  };

  manager.processSessionOutputState(session, '\n› Implement {feature}\n');

  assert.equal(writes.length, 1);
  assert.equal(session.status, 'active');
  assert.equal(session.statusDetectionContext, '');
  assert.equal(session.pendingStatus, null);
  assert.equal(session.statusDebounceTimer, null);
  assert.equal(events.some(event => event.payload?.source === 'automation'), true);
});

test('Codex startup automation skips ready-prompt status detection in the same callback', () => {
  const writes = [];
  const session = {
    id: 'startup-session',
    status: 'thinking',
    stage: 'in_progress',
    cliType: 'codex',
    currentTask: '',
    statusDetectionContext: 'stale prompt',
    pendingStatus: 'idle',
    statusDebounceTimer: setTimeout(() => {}, 10_000),
    roleInjection: null,
    startupSequence: {
      active: true,
      queue: ['/skills'],
      sentCount: 0,
      lastSentAt: 0,
      completedAt: null
    },
    pty: { write(value) { writes.push(value); } }
  };
  const manager = {
    emit() {},
    tryRoleInjectionOnOutput: SessionManager.prototype.tryRoleInjectionOnOutput,
    processStartupSequenceOnOutput: SessionManager.prototype.processStartupSequenceOnOutput,
    canAcceptOrchestratorInput() { return false; },
    drainMessageQueue() {},
    getSessionSnapshot(current) { return { ...current }; },
    cancelPendingStatusTransition: SessionManager.prototype.cancelPendingStatusTransition,
    markSemanticSubmission: SessionManager.prototype.markSemanticSubmission,
    cleanTerminalText: SessionManager.prototype.cleanTerminalText,
    updateStatusDetectionContext: SessionManager.prototype.updateStatusDetectionContext,
    detectStatus: SessionManager.prototype.detectStatus,
    updateSessionStatus() {
      assert.fail('same-callback status detection should be skipped');
    },
    processSessionOutputState: SessionManager.prototype.processSessionOutputState
  };

  manager.processSessionOutputState(session, '\n› Implement {feature}\n');

  assert.deepEqual(writes, ['/skills\r']);
  assert.equal(session.status, 'active');
  assert.equal(session.statusDetectionContext, '');
  assert.equal(session.pendingStatus, null);
  assert.equal(session.statusDebounceTimer, null);
});

test('status transition: non-Codex current-status guard remains unchanged', () => {
  const { manager, session } = createStatusHarness('thinking', 'claude');
  const pendingTimer = setTimeout(() => {}, 10_000);
  session.pendingStatus = 'idle';
  session.statusDebounceTimer = pendingTimer;

  manager.processSessionOutputState(session, 'Thinking');

  assert.equal(session.pendingStatus, 'idle');
  assert.equal(session.statusDebounceTimer, pendingTimer);
  clearTimeout(pendingTimer);
  session.statusDebounceTimer = null;
  session.pendingStatus = null;
});

test('isCodexMidWorkApprovalPrompt: only matches mid-run approvals', () => {
  assert.equal(isCodexMidWorkApprovalPrompt('Would you like to run this command?'), true);
  assert.equal(
    isCodexMidWorkApprovalPrompt('Implement this plan?\n1. Yes, implement this plan'),
    false
  );
});

test('isCodexFinalDecisionPrompt: matches final plan decision prompt', () => {
  assert.equal(
    isCodexFinalDecisionPrompt('Implement this plan?\n1. Yes, implement this plan'),
    true
  );
  assert.equal(isCodexFinalDecisionPrompt('Would you like to run this command?'), false);
});

test('decideKanbanAutoSync: keeps pending review for transient thinking redraw', () => {
  const decision = decideKanbanAutoSync({
    session: {
      cliType: 'codex',
      stage: 'in_review',
      lastSubmittedInputAtMs: 1
    },
    status: 'thinking',
    existingTargetStage: 'in_review'
  });

  assert.deepEqual(decision, { action: 'keep', targetStage: 'in_review' });
});

test('decideKanbanAutoSync: keeps final codex plan prompt in review during active redraw', () => {
  const decision = decideKanbanAutoSync({
    session: {
      cliType: 'codex',
      stage: 'in_review',
      stageEnteredAt: '2026-05-19T04:16:37.345Z',
      lastSubmittedInputAtMs: new Date('2026-05-19T04:16:02.731Z').getTime()
    },
    status: 'active',
    existingTargetStage: 'in_review',
    recentOutput: 'Implement this plan?\n1. Yes, implement this plan'
  });

  assert.deepEqual(decision, { action: 'keep', targetStage: 'in_review' });
});

test('decideKanbanAutoSync: resumes progress after final plan prompt submission', () => {
  const decision = decideKanbanAutoSync({
    session: {
      cliType: 'codex',
      stage: 'in_review',
      stageEnteredAt: '2026-05-19T04:16:37.345Z',
      lastSubmittedInputAtMs: new Date('2026-05-19T04:17:00.000Z').getTime()
    },
    status: 'active',
    existingTargetStage: 'in_review',
    recentOutput: 'Implement this plan?\n1. Yes, implement this plan'
  });

  assert.deepEqual(decision, { action: 'schedule', targetStage: 'in_progress' });
});

test('decideKanbanAutoSync: codex command approval after review follow-up resumes progress', () => {
  const decision = decideKanbanAutoSync({
    session: {
      cliType: 'codex',
      stage: 'in_review',
      stageEnteredAt: '2026-05-19T04:16:37.345Z',
      lastSubmittedInputAtMs: new Date('2026-05-19T04:17:00.000Z').getTime()
    },
    status: 'waiting',
    existingTargetStage: 'in_review',
    recentOutput: 'Would you like to run this command?'
  });

  assert.deepEqual(decision, { action: 'schedule', targetStage: 'in_progress' });
});

test('decideKanbanAutoSync: transient thinking after review follow-up resumes progress', () => {
  const decision = decideKanbanAutoSync({
    session: {
      cliType: 'codex',
      stage: 'in_review',
      stageEnteredAt: '2026-05-19T04:16:37.345Z',
      lastSubmittedInputAtMs: new Date('2026-05-19T04:17:00.000Z').getTime()
    },
    status: 'thinking',
    existingTargetStage: 'in_review'
  });

  assert.deepEqual(decision, { action: 'schedule', targetStage: 'in_progress' });
});

test('decideKanbanAutoSync: schedules in_progress when real work resumes from review', () => {
  const decision = decideKanbanAutoSync({
    session: {
      cliType: 'codex',
      stage: 'in_review',
      lastSubmittedInputAtMs: 1
    },
    status: 'active',
    existingTargetStage: 'in_review'
  });

  assert.deepEqual(decision, { action: 'schedule', targetStage: 'in_progress' });
});

test('decideKanbanAutoSync: clears stale pending review when stage is already in progress', () => {
  const decision = decideKanbanAutoSync({
    session: {
      cliType: 'codex',
      stage: 'in_progress',
      lastSubmittedInputAtMs: 1
    },
    status: 'active',
    existingTargetStage: 'in_review'
  });

  assert.deepEqual(decision, { action: 'clear' });
});

test('decideKanbanAutoSync: mid-work codex approval clears review scheduling', () => {
  const decision = decideKanbanAutoSync({
    session: {
      cliType: 'codex',
      stage: 'in_progress',
      lastSubmittedInputAtMs: 1
    },
    status: 'waiting',
    recentOutput: 'Would you like to run this command?'
  });

  assert.deepEqual(decision, { action: 'clear' });
});

test('moveSession: auto-sync does not override manually placed sessions', () => {
  let saved = false;
  const session = {
    id: 'session-1',
    name: 'Manual card',
    stage: 'in_review',
    manuallyPlaced: true,
    placementLocked: false
  };
  const manager = {
    sessions: new Map([[session.id, session]]),
    stages: DEFAULT_STAGES,
    dataStore: {
      saveSession() {
        saved = true;
      }
    },
    emit() {},
    getSessionSnapshot(current) {
      return { ...current };
    }
  };

  const snapshot = SessionManager.prototype.moveSession.call(
    manager,
    session.id,
    'in_progress',
    { source: 'auto' }
  );

  assert.equal(snapshot.stage, 'in_review');
  assert.equal(session.stage, 'in_review');
  assert.equal(saved, false);
});

test('canTransitionToIdle: codex false, non-codex true', () => {
  assert.equal(SessionManager.prototype.canTransitionToIdle.call({}, { cliType: 'codex' }), false);
  assert.equal(SessionManager.prototype.canTransitionToIdle.call({}, { cliType: 'claude' }), true);
  assert.equal(SessionManager.prototype.canTransitionToIdle.call({}, { cliType: 'terminal' }), true);
});

test('getOutputBufferSize: terminal/codex larger than claude', () => {
  assert.equal(SessionManager.prototype.getOutputBufferSize.call({}, 'terminal'), 12000);
  assert.equal(SessionManager.prototype.getOutputBufferSize.call({}, 'wsl'), 12000);
  assert.equal(SessionManager.prototype.getOutputBufferSize.call({}, 'codex'), 12000);
  assert.equal(SessionManager.prototype.getOutputBufferSize.call({}, 'claude'), 750);
  assert.equal(SessionManager.prototype.getOutputBufferSize.call({}, 'unknown'), 750);
});

test('getRecentSessionOutputText: reads bounded recent tail only', () => {
  const manager = {
    sessions: new Map([[
      'session-1',
      {
        outputBuffer: {
          getAll() {
            return [
              'stale Implement this plan?',
              '\nworking output\n',
              'Would you like to run this command?'
            ];
          }
        }
      }
    ]])
  };

  const text = SessionManager.prototype.getRecentSessionOutputText.call(
    manager,
    'session-1',
    { maxChunks: 2, maxChars: 1000 }
  );

  assert.equal(text.includes('stale Implement this plan?'), false);
  assert.equal(text.includes('Would you like to run this command?'), true);

  const capped = SessionManager.prototype.getRecentSessionOutputText.call(
    manager,
    'session-1',
    { maxChunks: 3, maxChars: 12 }
  );
  assert.equal(capped, 'his command?');
});

test('extractSessionRename: detects Claude rename output', () => {
  const manager = {
    cleanTerminalText: SessionManager.prototype.cleanTerminalText,
    stripCodexResumeHint: SessionManager.prototype.stripCodexResumeHint,
    extractSessionRename: SessionManager.prototype.extractSessionRename
  };

  assert.equal(
    SessionManager.prototype.extractSessionRename.call(manager, '\x1b[32mSession renamed to: "Billing polish"\x1b[0m\r\n'),
    'Billing polish'
  );
});

test('extractSessionRename: detects Codex conversation rename output', () => {
  const manager = {
    cleanTerminalText: SessionManager.prototype.cleanTerminalText,
    stripCodexResumeHint: SessionManager.prototype.stripCodexResumeHint,
    extractSessionRename: SessionManager.prototype.extractSessionRename
  };

  assert.equal(
    SessionManager.prototype.extractSessionRename.call(manager, 'Renamed conversation to "Fix WSL folder create"\r\n'),
    'Fix WSL folder create'
  );
  assert.equal(
    SessionManager.prototype.extractSessionRename.call(manager, 'Codex conversation renamed to: Session sync\r\n'),
    'Session sync'
  );
  assert.equal(
    SessionManager.prototype.extractSessionRename.call(
      manager,
      '\u2022 Thread renamed to https, to resume this thread run codex resume https\r\n'
    ),
    'https'
  );
  assert.equal(
    SessionManager.prototype.extractSessionRename.call(
      manager,
      'Thread renamed to cutsheetfont-etc. To resume this thread run codex resume, then select cutsheetfont-etc (019e43b8-5674-7002-8ff3-b301c72d3c04)\r\n'
    ),
    'cutsheetfont-etc'
  );
  assert.equal(
    SessionManager.prototype.extractSessionRename.call(
      manager,
      'Session renamed to cutsheetdesignerhorizontaalscrollbar. To resume this session run codex resume, then select cutsheetdesignerhorizontaalscrollbar (019e95bd-9c65-7313-b0f1-5e58a16617bb)\r\n'
    ),
    'cutsheetdesignerhorizontaalscrollbar'
  );
});

test('loadPersistedSessions: strips Codex resume hint from restored session names', () => {
  let savedSession = null;
  const manager = Object.create(SessionManager.prototype);

  manager.dataStore = {
    loadSessions() {
      return {
        'session-1': {
          id: 'session-1',
          name: 'cutsheetdesignerhorizontaalscrollbar. To resume this session run codex resume, then select cutsheetdesignerhorizontaalscrollbar (019e95bd-9c65-7313-b0f1-5e58a16617bb)',
          workingDir: '/home/denni/apps/specsket',
          cliType: 'codex',
          createdAt: '2026-06-05T00:00:00.000Z',
          lastActivity: '2026-06-05T00:01:00.000Z',
          status: 'active',
          promptHistory: [],
          tags: [],
          plans: [],
          blockedBy: [],
          blocks: [],
          rejectionHistory: [],
          comments: [],
          messageQueue: []
        }
      };
    },
    saveSession(session) {
      savedSession = session;
    },
    deleteSession() {
      throw new Error('deleteSession should not be called');
    }
  };
  manager.sessions = new Map();
  manager.deleteSessionTranscript = () => {};
  manager.normalizeWorkingDirForCli = (value) => value;
  manager.getOutputBufferSize = () => 12000;
  manager.deriveRepoContext = () => ({
    repoRoot: null,
    repoName: null,
    gitBranch: null,
    groupKey: '/home/denni/apps/specsket'
  });
  manager.sanitizeRole = () => '';
  manager._sweepExpiredQueueMessages = () => {};
  manager.selectCodexResumeTarget = () => null;

  manager.loadPersistedSessions();

  const restored = manager.sessions.get('session-1');
  assert.equal(restored.name, 'cutsheetdesignerhorizontaalscrollbar');
  assert.equal(savedSession.name, 'cutsheetdesignerhorizontaalscrollbar');
});

test('convertToWslPath: converts Windows drive paths', () => {
  assert.equal(
    SessionManager.prototype.convertToWslPath('C:\\Users\\denni\\apps\\EasyCC'),
    '/mnt/c/Users/denni/apps/EasyCC'
  );
});

test('convertToWslPath: converts WSL UNC paths', () => {
  assert.equal(
    SessionManager.prototype.convertToWslPath('\\\\wsl$\\Ubuntu\\home\\denni\\apps\\EasyCC'),
    '/home/denni/apps/EasyCC'
  );
});

test('convertToWslPath: passes through non-Windows paths', () => {
  assert.equal(
    SessionManager.prototype.convertToWslPath('/home/denni/apps/EasyCC'),
    '/home/denni/apps/EasyCC'
  );
});

test('buildCodexBootstrapScript: prefers npm prefix Codex before PATH lookup', () => {
  const script = SessionManager.prototype.buildCodexBootstrapScript.call(
    { quoteForPosixShell: SessionManager.prototype.quoteForPosixShell },
    '/mnt/c/Users/denni/apps/EasyCC',
    { resume: false, easyccSessionId: 'easycc-session-1' }
  );

  assert.match(script, /"\$HOME\/\.profile"/);
  assert.match(script, /"\$HOME\/\.bashrc"/);
  assert.match(script, /codex_prefix="\$\(npm prefix -g 2>\/dev\/null \|\| true\)"/);
  assert.match(script, /if \[ -n "\$codex_prefix" \] && \[ -x "\$codex_prefix\/bin\/codex" \]; then/);
  assert.ok(
    script.indexOf('if [ -n "$codex_prefix" ] && [ -x "$codex_prefix/bin/codex" ]; then') <
      script.indexOf('exec codex '),
    'npm-prefix Codex should be checked before generic PATH lookup'
  );
  assert.match(script, /export EASYCC_SESSION_ID='easycc-session-1'/);
  assert.doesNotMatch(script, /resume --last/);

  const syntaxCheck = process.platform === 'win32'
    ? spawnSync('wsl.exe', ['bash', '--noprofile', '--norc', '-n', '-c', script], { encoding: 'utf8' })
    : spawnSync('/bin/bash', ['-n', '-c', script], { encoding: 'utf8' });
  assert.equal(syntaxCheck.status, 0, syntaxCheck.stderr);
});

test('buildCodexBootstrapScript: rejects resume without an exact target', () => {
  assert.throws(
    () => SessionManager.prototype.buildCodexBootstrapScript.call(
      { quoteForPosixShell: SessionManager.prototype.quoteForPosixShell },
      '/mnt/c/Users/denni/apps/EasyCC',
      { resume: true }
    ),
    /Exact Codex resume target is required/
  );
});

test('buildCodexBootstrapScript: uses explicit resume target when available', () => {
  const script = SessionManager.prototype.buildCodexBootstrapScript.call(
    { quoteForPosixShell: SessionManager.prototype.quoteForPosixShell },
    '/mnt/c/Users/denni/apps/EasyCC',
    { resume: true, resumeTarget: '019dbd34-7fd7-7ec3-b5b8-838be24ac567' }
  );

  assert.match(script, /resume '019dbd34-7fd7-7ec3-b5b8-838be24ac567'/);
  assert.doesNotMatch(script, /resume --last/);
});

test('selectCodexResumeTarget: prefers captured session ID only', () => {
  assert.equal(
    SessionManager.prototype.selectCodexResumeTarget.call({}, {
      codexSessionId: 'session-123',
      codexThreadName: 'thread-name'
    }),
    'session-123'
  );

  assert.equal(
    SessionManager.prototype.selectCodexResumeTarget.call({}, {
      codexSessionId: null,
      codexThreadName: 'thread-name'
    }),
    null
  );
});

test('deriveRepoContext: git worktree uses repo root as group key', () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'easycc-git-'));
  const repoDir = path.join(tempRoot, 'repo');
  fs.mkdirSync(repoDir, { recursive: true });

  try {
    git(['init', '-b', 'main'], repoDir);
    git(['config', 'user.name', 'EasyCC Test'], repoDir);
    git(['config', 'user.email', 'easycc@example.com'], repoDir);
    fs.writeFileSync(path.join(repoDir, 'README.md'), 'hello\n', 'utf8');
    git(['add', 'README.md'], repoDir);
    git(['commit', '-m', 'init'], repoDir);

    const nestedDir = path.join(repoDir, 'packages', 'ui');
    fs.mkdirSync(nestedDir, { recursive: true });

    const context = SessionManager.prototype.deriveRepoContext.call(
      { normalizeGroupPath: SessionManager.prototype.normalizeGroupPath },
      nestedDir
    );

    assert.equal(context.repoRoot, repoDir.replace(/\\/g, '/'));
    assert.equal(context.repoName, 'repo');
    assert.equal(context.gitBranch, 'main');
    assert.equal(context.groupKey, repoDir.replace(/\\/g, '/'));
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('deriveRepoContext: non-git folder falls back to workingDir group key', () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'easycc-nongit-'));

  try {
    const workingDir = path.join(tempRoot, 'plain-folder');
    fs.mkdirSync(workingDir, { recursive: true });

    const context = SessionManager.prototype.deriveRepoContext.call(
      { normalizeGroupPath: SessionManager.prototype.normalizeGroupPath },
      workingDir
    );

    assert.equal(context.repoRoot, null);
    assert.equal(context.repoName, null);
    assert.equal(context.gitBranch, null);
    assert.equal(context.groupKey, workingDir.replace(/\\/g, '/'));
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('deriveRepoContext: failed git lookup clears stale repo metadata', () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'easycc-stale-'));

  try {
    const workingDir = path.join(tempRoot, 'plain-folder');
    fs.mkdirSync(workingDir, { recursive: true });

    const context = SessionManager.prototype.deriveRepoContext.call(
      { normalizeGroupPath: SessionManager.prototype.normalizeGroupPath },
      workingDir,
      {
        repoRoot: '/tmp/old-repo',
        repoName: 'old-repo',
        gitBranch: 'feature/old',
        groupKey: '/tmp/old-repo'
      }
    );

    assert.equal(context.repoRoot, null);
    assert.equal(context.repoName, null);
    assert.equal(context.gitBranch, null);
    assert.equal(context.groupKey, workingDir.replace(/\\/g, '/'));
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('getSessionSnapshot: includes repo metadata fields', () => {
  const snapshot = SessionManager.prototype.getSessionSnapshot.call(
    { normalizeGroupPath: SessionManager.prototype.normalizeGroupPath },
    {
      id: 'session-1',
      name: 'Repo Session',
      status: 'active',
      currentTask: '',
      createdAt: '2026-01-01T00:00:00.000Z',
      lastActivity: '2026-01-01T00:01:00.000Z',
      workingDir: '/tmp/repo/worktree',
      repoRoot: '/tmp/repo',
      repoName: 'repo',
      gitBranch: 'feature/test',
      groupKey: '/tmp/repo',
      cliType: 'codex',
      previousClaudeSessionIds: [],
      tags: [],
      plans: [],
      promptHistory: [],
      blockedBy: [],
      blocks: [],
      rejectionHistory: [],
      comments: [],
      messageQueue: []
    }
  );

  assert.equal(snapshot.repoRoot, '/tmp/repo');
  assert.equal(snapshot.repoName, 'repo');
  assert.equal(snapshot.gitBranch, 'feature/test');
  assert.equal(snapshot.groupKey, '/tmp/repo');
});

test('spawnCodexProcess: on Windows launches WSL bash bootstrap', () => {
  const originalSpawn = pty.spawn;
  const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform');
  const calls = [];

  pty.spawn = (...args) => {
    calls.push(args);
    return { pid: 1 };
  };
  Object.defineProperty(process, 'platform', { value: 'win32' });

  try {
    SessionManager.prototype.spawnCodexProcess.call(
      {
        getEasyccEnv: () => ({
          TEST_ENV: '1',
          BASH_ENV: '/tmp/bad-bash-env',
          ENV: '/tmp/bad-env',
          SHELLOPTS: 'braceexpand',
          PROMPT_COMMAND: 'bad-prompt'
        }),
        getWslLaunchEnv: SessionManager.prototype.getWslLaunchEnv,
        convertToWslPath: SessionManager.prototype.convertToWslPath,
        quoteForPosixShell: SessionManager.prototype.quoteForPosixShell,
        buildCodexBootstrapScript: SessionManager.prototype.buildCodexBootstrapScript
      },
      'C:\\Users\\denni\\apps\\EasyCC',
      { resume: false, easyccSessionId: 'session-1', meta: {} }
    );
  } finally {
    pty.spawn = originalSpawn;
    Object.defineProperty(process, 'platform', originalPlatform);
  }

  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], 'wsl.exe');
  assert.deepEqual(calls[0][1].slice(0, 3), ['--cd', '/mnt/c/Users/denni/apps/EasyCC', 'bash']);
  assert.deepEqual(calls[0][1].slice(3, 6), ['--noprofile', '--norc', '-c']);
  assert.match(calls[0][1][6], /exec codex --dangerously-bypass-approvals-and-sandbox -C '\/mnt\/c\/Users\/denni\/apps\/EasyCC'/);
  assert.equal(calls[0][2].env.TEST_ENV, '1');
  assert.equal(calls[0][2].env.BASH_ENV, undefined);
  assert.equal(calls[0][2].env.ENV, undefined);
  assert.equal(calls[0][2].env.SHELLOPTS, undefined);
  assert.equal(calls[0][2].env.PROMPT_COMMAND, undefined);
});

test('spawnCodexProcess: on Linux launches bash bootstrap in cwd', () => {
  const originalSpawn = pty.spawn;
  const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform');
  const calls = [];

  pty.spawn = (...args) => {
    calls.push(args);
    return { pid: 1 };
  };
  Object.defineProperty(process, 'platform', { value: 'linux' });

  try {
    SessionManager.prototype.spawnCodexProcess.call(
      {
        getEasyccEnv: () => ({ TEST_ENV: '1' }),
        quoteForPosixShell: SessionManager.prototype.quoteForPosixShell,
        buildCodexBootstrapScript: SessionManager.prototype.buildCodexBootstrapScript
      },
      '/mnt/c/Users/denni/apps/EasyCC',
      { resume: false, easyccSessionId: 'session-1', meta: {} }
    );
  } finally {
    pty.spawn = originalSpawn;
    Object.defineProperty(process, 'platform', originalPlatform);
  }

  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], '/bin/bash');
  assert.deepEqual(calls[0][1].slice(0, 2), ['-lc', calls[0][1][1]]);
  assert.equal(calls[0][2].cwd, '/mnt/c/Users/denni/apps/EasyCC');
  assert.match(calls[0][1][1], /"\$codex_prefix\/bin\/codex"/);
});

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  hasSubmittedInput,
  isLikelyLocalEchoOutput,
  shouldCountOutputAsActivity
} = require('../backend/sessionInputUtils');
const { generateSessionName, ensureUniqueSessionName } = require('../backend/sessionNaming');
const { sessionStatusToStage } = require('../backend/stagesConfig');

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
  assert.match(generateSessionName(fixed, 'codex'), /^Codex 2026-02-11-\d{4}$/);
  assert.match(generateSessionName(fixed, 'claude'), /^Session 2026-02-11-\d{4}$/);
});

test('session status mapping keeps idle in in_review', () => {
  assert.equal(sessionStatusToStage('idle'), 'in_review');
  assert.equal(sessionStatusToStage('active'), 'in_progress');
});

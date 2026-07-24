const test = require('node:test');
const assert = require('node:assert/strict');

const { forwardTerminalInputMessage } = require('../backend/terminalInputMessage');

function createHarness() {
  const calls = [];
  return {
    calls,
    sessionManager: {
      sendInput(...args) {
        calls.push(args);
        return true;
      }
    }
  };
}

test('forwards exact Codex CSI-u soft newlines once with the validated intent', () => {
  for (const data of [
    '\x1b[13;2u',
    '\x1b[13;3u',
    '\x1b[13;5u',
    '\x1b[106;5u',
    '\x1b[109;5u'
  ]) {
    const { calls, sessionManager } = createHarness();

    assert.equal(forwardTerminalInputMessage(sessionManager, 'session-1', {
      type: 'input',
      data,
      inputIntent: 'soft_newline'
    }), true);
    assert.deepEqual(calls, [[
      'session-1',
      data,
      { inputIntent: 'soft_newline' }
    ]]);
  }
});

test('ordinary and mismatched input omit the privileged intent', () => {
  for (const parsed of [
    { type: 'input', data: 'draft' },
    { type: 'input', data: '\n', inputIntent: 'unknown' },
    { type: 'input', data: '\n', inputIntent: 'soft_newline' },
    { type: 'input', data: 'draft\n', inputIntent: 'soft_newline' },
    { type: 'input', data: '\x1b[120;5u', inputIntent: 'soft_newline' }
  ]) {
    const { calls, sessionManager } = createHarness();
    assert.equal(forwardTerminalInputMessage(sessionManager, 'session-1', parsed), true);
    assert.deepEqual(calls, [['session-1', parsed.data]]);
  }
});

test('invalid input messages are not forwarded', () => {
  for (const parsed of [
    null,
    { type: 'resize', data: '\n', inputIntent: 'soft_newline' },
    { type: 'input', data: '' },
    { type: 'input', data: null },
    { type: 'input', data: 42 }
  ]) {
    const { calls, sessionManager } = createHarness();
    assert.equal(forwardTerminalInputMessage(sessionManager, 'session-1', parsed), false);
    assert.deepEqual(calls, []);
  }
});

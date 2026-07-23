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

test('forwards exact soft newline once with the validated intent', () => {
  const { calls, sessionManager } = createHarness();

  assert.equal(forwardTerminalInputMessage(sessionManager, 'session-1', {
    type: 'input',
    data: '\n',
    inputIntent: 'soft_newline'
  }), true);
  assert.deepEqual(calls, [[
    'session-1',
    '\n',
    { inputIntent: 'soft_newline' }
  ]]);
});

test('ordinary and mismatched input omit the privileged intent', () => {
  for (const parsed of [
    { type: 'input', data: 'draft' },
    { type: 'input', data: '\n', inputIntent: 'unknown' },
    { type: 'input', data: 'draft\n', inputIntent: 'soft_newline' }
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

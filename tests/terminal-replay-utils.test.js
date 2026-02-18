const test = require('node:test');
const assert = require('node:assert/strict');

const { prepareTerminalReplayPayload } = require('../backend/terminalReplayUtils');

test('prepareTerminalReplayPayload: returns full content when under limit', () => {
  const payload = prepareTerminalReplayPayload(['hello', ' world'], 1024);
  assert.equal(payload.truncated, false);
  assert.equal(payload.data, 'hello world');
});

test('prepareTerminalReplayPayload: truncates to tail and prepends notice when over limit', () => {
  const payload = prepareTerminalReplayPayload(['1234567890abcdef'], 8);
  assert.equal(payload.truncated, true);
  assert.match(payload.data, /\[replay truncated to last/);
  assert.ok(payload.data.endsWith('90abcdef'));
});


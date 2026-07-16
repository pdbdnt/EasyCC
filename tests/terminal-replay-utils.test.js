const test = require('node:test');
const assert = require('node:assert/strict');

const {
  DEFAULT_TERMINAL_REPLAY_MAX_BYTES,
  prepareTerminalReplayPayload
} = require('../backend/terminalReplayUtils');

test('prepareTerminalReplayPayload: returns full content when under limit', () => {
  const payload = prepareTerminalReplayPayload(['hello', ' world'], 1024);
  assert.equal(payload.truncated, false);
  assert.equal(payload.data, 'hello world');
  assert.equal(payload.replayBytes, 11);
});

test('prepareTerminalReplayPayload: truncates to tail and prepends notice when over limit', () => {
  const payload = prepareTerminalReplayPayload(['1234567890abcdef'], 8);
  assert.equal(payload.truncated, true);
  assert.match(payload.data, /\[replay truncated to last/);
  assert.ok(payload.data.endsWith('90abcdef'));
  assert.equal(payload.replayBytes, 8);
});

test('prepareTerminalReplayPayload: keeps the default replay small enough for responsive terminal mounting', () => {
  const oversized = 'x'.repeat(DEFAULT_TERMINAL_REPLAY_MAX_BYTES + 1024);
  const payload = prepareTerminalReplayPayload([oversized]);

  assert.equal(DEFAULT_TERMINAL_REPLAY_MAX_BYTES, 512 * 1024);
  assert.equal(payload.truncated, true);
  assert.equal(payload.replayBytes, DEFAULT_TERMINAL_REPLAY_MAX_BYTES);
});

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const SessionManager = require('../backend/sessionManager');
const { DEFAULT_TERMINAL_REPLAY_MAX_BYTES } = require('../backend/terminalReplayUtils');

function createHarness(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'easycc-transcript-buffer-'));
  const file = path.join(dir, 'session.log');
  const manager = Object.create(SessionManager.prototype);
  manager.transcriptWriteBuffers = new Map();
  manager.getTranscriptPath = () => file;
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return { manager, file };
}

test('appendToTranscript batches adjacent output until one flush', (t) => {
  const { manager, file } = createHarness(t);

  manager.appendToTranscript('session', 'a');
  manager.appendToTranscript('session', 'b');
  assert.equal(fs.existsSync(file), false);

  manager.flushTranscript('session');
  assert.equal(fs.readFileSync(file, 'utf8'), 'ab');
  assert.equal(manager.transcriptWriteBuffers.size, 0);
});

test('appendToTranscript flushes the batch on its short timer', async (t) => {
  const { manager, file } = createHarness(t);

  manager.appendToTranscript('session', 'echo');
  await new Promise((resolve) => setTimeout(resolve, 25));

  assert.equal(fs.readFileSync(file, 'utf8'), 'echo');
  assert.equal(manager.transcriptWriteBuffers.size, 0);
});

test('resetSessionTranscript discards a pending append before truncating', async (t) => {
  const { manager, file } = createHarness(t);
  fs.writeFileSync(file, 'old', 'utf8');

  manager.appendToTranscript('session', 'pending');
  manager.resetSessionTranscript('session');
  await new Promise((resolve) => setTimeout(resolve, 25));

  assert.equal(fs.readFileSync(file, 'utf8'), '');
});

test('deleteSessionTranscript cancels a pending append without recreating the file', async (t) => {
  const { manager, file } = createHarness(t);
  fs.writeFileSync(file, 'old', 'utf8');

  manager.appendToTranscript('session', 'pending');
  manager.deleteSessionTranscript('session');
  await new Promise((resolve) => setTimeout(resolve, 25));

  assert.equal(fs.existsSync(file), false);
});

test('getSessionTranscript exposes output omitted by the bounded live replay as older history', (t) => {
  const { manager, file } = createHarness(t);
  const omittedFromReplay = 'o'.repeat(1024);
  const replayTail = 'r'.repeat(DEFAULT_TERMINAL_REPLAY_MAX_BYTES);
  fs.writeFileSync(file, omittedFromReplay + replayTail, 'utf8');
  manager.sessions = new Map([[
    'session',
    { outputBuffer: { getAll: () => [omittedFromReplay, replayTail] } }
  ]]);

  const transcript = manager.getSessionTranscript('session', { limitBytes: 2048 });

  assert.equal(transcript.olderBytesAvailable, Buffer.byteLength(omittedFromReplay));
  assert.equal(transcript.data, omittedFromReplay);
});

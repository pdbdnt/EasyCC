const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  getTranscriptWindow,
  readTranscriptWindow
} = require('../backend/terminalTranscriptUtils');

test('getTranscriptWindow excludes current live replay from older-history window', () => {
  const window = getTranscriptWindow({
    totalBytes: 1000,
    liveReplayBytes: 300,
    limitBytes: 200
  });

  assert.equal(window.olderBytesAvailable, 700);
  assert.equal(window.startByte, 500);
  assert.equal(window.endByte, 700);
  assert.equal(window.hasMore, true);
});

test('readTranscriptWindow returns the older slice before the live replay tail', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'easycc-transcript-test-'));
  const filePath = path.join(dir, 'session.log');
  const transcript = 'oldest\nolder\nrecent-live-tail';
  fs.writeFileSync(filePath, transcript, 'utf8');

  const liveReplayBytes = Buffer.byteLength('recent-live-tail', 'utf8');
  const result = readTranscriptWindow(filePath, {
    liveReplayBytes,
    limitBytes: 1024
  });

  assert.equal(result.data, 'oldest\nolder\n');
  assert.equal(result.olderBytesAvailable, Buffer.byteLength('oldest\nolder\n', 'utf8'));
  assert.equal(result.hasMore, false);

  fs.rmSync(dir, { recursive: true, force: true });
});

test('readTranscriptWindow pages older transcript content without overlap', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'easycc-transcript-page-'));
  const filePath = path.join(dir, 'session.log');
  fs.writeFileSync(filePath, 'AAAAABBBBBCCCCCDDDDDEEEEEtail', 'utf8');

  const first = readTranscriptWindow(filePath, {
    liveReplayBytes: Buffer.byteLength('tail', 'utf8'),
    limitBytes: 10
  });
  const second = readTranscriptWindow(filePath, {
    liveReplayBytes: Buffer.byteLength('tail', 'utf8'),
    beforeBytes: first.startByte,
    limitBytes: 10
  });

  assert.equal(first.data, 'DDDDDEEEEE');
  assert.equal(second.data, 'BBBBBCCCCC');
  assert.equal(second.endByte, first.startByte);

  fs.rmSync(dir, { recursive: true, force: true });
});

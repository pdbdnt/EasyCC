const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const SessionManager = require('../backend/sessionManager');
const { CodexSessionService } = require('../backend/codexSessionService');
const { CODEX_WINDOWS } = require('../backend/codexCliTypes');

test('native rename sync follows exact IDs, persists and emits without terminal output', (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'easycc-rename-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const index = path.join(home, 'session_index.jsonl');
  const id = '019f4a56-26a5-7440-bbc6-54b00447d986';
  const otherId = '019f4a56-26a5-7440-bbc6-54b00447d987';
  const manager = Object.create(SessionManager.prototype);
  manager.codexSessionService = new CodexSessionService();
  manager.codexSessionService.resolveWindowsCodexHome = () => home;
  let reads = 0;
  const load = manager.codexSessionService.loadWindowsIndex.bind(manager.codexSessionService);
  manager.codexSessionService.loadWindowsIndex = () => { reads++; return load(); };
  const saved = [];
  const emitted = [];
  manager.dataStore = { saveSession: s => saved.push({ ...s }) };
  manager.getSessionSnapshot = s => ({ ...s });
  manager.emit = (type, value) => emitted.push({ type, value });
  const session = { id: 'card', cliType: CODEX_WINDOWS, codexSessionId: id,
    codexIdentityState: 'verified', name: 'Session default', codexThreadName: null };
  manager.syncCodexWindowsThreadName(session); // File not created yet.
  assert.equal(saved.length, 0);
  const row = (threadId, name) => JSON.stringify({ id: threadId, thread_name: name, updated_at: '2026-09-11T05:00:00Z' }) + '\n';
  fs.writeFileSync(index, row(id, 'old') + row(otherId, 'unrelated') + row(id, 'test') + '{partial');
  manager.syncCodexWindowsThreadName(session, 'not yet saved');
  assert.equal(session.name, 'Session default');
  manager.syncCodexWindowsThreadName(session, 'test');
  assert.equal(session.name, 'test');
  assert.equal(session.codexThreadName, 'test');
  assert.equal(saved.length, 1);
  assert.equal(emitted[0].type, 'sessionUpdated');
  assert.equal(emitted[0].value.name, 'test');
  manager.syncCodexWindowsThreadName(session);
  assert.equal(saved.length, 1);
  assert.equal(reads, 1);
  session.name = 'Custom EasyCC title';
  manager.syncCodexWindowsThreadName(session, 'pending rename');
  assert.equal(session.name, 'Custom EasyCC title');
  fs.appendFileSync(index, '\n' + row(id, 'second rename'));
  manager.syncCodexWindowsThreadName(session);
  assert.equal(session.name, 'second rename');
  assert.equal(reads, 2);
  for (const overrides of [
    { codexIdentityState: 'unresolved' }, { codexIdentityState: 'conflict' },
    { codexSessionId: otherId, codexIdentityState: 'unverified' },
    { codexSessionId: null }, { cliType: 'codex' }, { cliType: 'claude' }
  ]) {
    const untouched = { ...session, name: 'untouched', ...overrides };
    manager.syncCodexWindowsThreadName(untouched);
    assert.equal(untouched.name, 'untouched');
  }
});

test('rename confirmation retries are bounded and stop on success or conversation change', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const manager = Object.create(SessionManager.prototype);
  const session = { cliType: CODEX_WINDOWS, codexSessionId: 'exact', ptyGeneration: 1, status: 'idle' };
  let reads = 0;
  let success = false;
  manager.syncCodexWindowsThreadName = (s, name) => {
    assert.equal(name, 'test');
    reads++;
    return success;
  };
  manager.scheduleCodexRenameSync(session, 'ordinary prompt');
  t.mock.timers.tick(1000);
  assert.equal(reads, 0);
  manager.scheduleCodexRenameSync(session, '/rename test\r');
  for (let i = 0; i < 20; i++) t.mock.timers.tick(250);
  assert.equal(reads, 10);
  success = true;
  manager.scheduleCodexRenameSync(session, '/rename test\r');
  for (let i = 0; i < 20; i++) t.mock.timers.tick(250);
  assert.equal(reads, 11);
  manager.scheduleCodexRenameSync(session, '/rename test\r');
  session.ptyGeneration++;
  t.mock.timers.tick(250);
  assert.equal(reads, 11);
});

test('typing a rename starts confirmation only after Enter, and soft newline does not', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const manager = Object.create(SessionManager.prototype);
  const session = { id: 'card', cliType: CODEX_WINDOWS, status: 'idle', promptBuffer: '' };
  manager.sessions = new Map([[session.id, session]]);
  manager._writeInputToPty = () => {};
  manager.markSemanticSubmission = () => {};
  manager.addPromptToHistory = () => {};
  manager.flushPromptBuffer = s => { s.promptBuffer = ''; };
  const submitted = [];
  manager.scheduleCodexRenameSync = (s, text) => submitted.push(text);
  for (const char of '/rename test') assert.equal(manager.sendInput(session.id, char), true);
  assert.deepEqual(submitted, []);
  assert.equal(manager.sendInput(session.id, '\r'), true);
  assert.deepEqual(submitted, ['/rename test\r']);
  manager.sendInput(session.id, '/rename draft');
  manager.sendInput(session.id, '\n', { inputIntent: 'soft_newline' });
  assert.equal(submitted.length, 1);
});

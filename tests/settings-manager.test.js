const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const SettingsManager = require('../backend/settingsManager');

function withManager(run) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'easycc-settings-'));
  try {
    return run(new SettingsManager(dir), dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('startup recovery mode defaults and invalid values normalize to ask', () => withManager((manager) => {
  assert.equal(manager.getDefaults().session.startupRecoveryMode, 'ask');
  for (const value of [null, true, 'unknown', 42]) {
    const settings = manager.mergeWithDefaults({ session: { startupRecoveryMode: value } });
    assert.equal(settings.session.startupRecoveryMode, 'ask');
  }
  for (const value of ['ask', 'auto-resume', 'restore-paused']) {
    assert.equal(manager.mergeWithDefaults({ session: { startupRecoveryMode: value } }).session.startupRecoveryMode, value);
  }
}));

test('legacy autoResumeOnStart is ignored and stripped on save', () => withManager((manager, dir) => {
  fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify({
    session: { autoResumeOnStart: true }
  }));

  const loaded = manager.loadSettings();
  assert.equal(loaded.session.startupRecoveryMode, 'ask');
  assert.equal('autoResumeOnStart' in loaded.session, false);

  const updated = manager.updateSettings({ session: { startupRecoveryMode: 'restore-paused', autoResumeOnStart: false } });
  assert.equal(updated.session.startupRecoveryMode, 'restore-paused');
  assert.equal('autoResumeOnStart' in updated.session, false);
  const persisted = JSON.parse(fs.readFileSync(path.join(dir, 'settings.json'), 'utf8'));
  assert.equal('autoResumeOnStart' in persisted.session, false);
}));

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { ensureProfile } = require('../backend/codexWindowsRuntime');

test('Windows Codex profile mirrors the WSL status line including context usage', () => {
  const codexHome = fs.mkdtempSync(path.join(os.tmpdir(), 'easycc-codex-profile-'));
  const previousCodexHome = process.env.CODEX_HOME;

  try {
    process.env.CODEX_HOME = codexHome;
    const profile = fs.readFileSync(ensureProfile(), 'utf8');

    assert.match(profile, /\[tui\]/);
    assert.match(
      profile,
      /status_line = \["model-with-reasoning", "current-dir", "context-used", "thread-title"\]/
    );
  } finally {
    if (previousCodexHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = previousCodexHome;
    fs.rmSync(codexHome, { recursive: true, force: true });
  }
});

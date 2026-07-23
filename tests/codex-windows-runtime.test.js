const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  ensureProfile,
  extractExplicitResumeTarget,
  findExplicitResumeOwners
} = require('../backend/codexWindowsRuntime');

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
    assert.match(profile, /\[\[hooks\.UserPromptSubmit\]\]/);
    assert.match(profile, /\[\[hooks\.Stop\]\]/);
    assert.match(profile, /turn-timing\.ps1/);
    assert.match(profile, /command_windows = .*turn-timing\.ps1/);
  } finally {
    if (previousCodexHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = previousCodexHome;
    fs.rmSync(codexHome, { recursive: true, force: true });
  }
});

test('Windows Codex profile upgrades schema 1 but refuses unmanaged profiles', () => {
  const codexHome = fs.mkdtempSync(path.join(os.tmpdir(), 'easycc-codex-profile-upgrade-'));
  const previousCodexHome = process.env.CODEX_HOME;
  const profilePath = path.join(codexHome, 'easycc-windows.config.toml');

  try {
    process.env.CODEX_HOME = codexHome;
    fs.writeFileSync(
      profilePath,
      '# EASYCC_OWNED_CODEX_WINDOWS_PROFILE schema=1\n[tui]\n',
      'utf8'
    );
    const upgraded = fs.readFileSync(ensureProfile(), 'utf8');
    assert.match(upgraded, /EASYCC_OWNED_CODEX_WINDOWS_PROFILE schema=2/);
    assert.match(upgraded, /\[\[hooks\.UserPromptSubmit\]\]/);

    fs.writeFileSync(profilePath, '[tui]\nstatus_line = []\n', 'utf8');
    assert.throws(
      () => ensureProfile(),
      /Refusing to overwrite non-EasyCC Codex profile/
    );
  } finally {
    if (previousCodexHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = previousCodexHome;
    fs.rmSync(codexHome, { recursive: true, force: true });
  }
});

test('Windows command-line parser finds only an explicit exact resume UUID', () => {
  const id = '11111111-1111-4111-8111-111111111111';
  assert.equal(extractExplicitResumeTarget(`codex.exe --profile easycc resume ${id}`), id);
  assert.equal(extractExplicitResumeTarget(`codex.exe resume "${id}"`), id);
  assert.equal(extractExplicitResumeTarget(`codex.exe -C C:\\repo`), null);
  assert.equal(extractExplicitResumeTarget(`codex.exe resume not-a-uuid`), null);
});

test('Windows explicit-resume scan returns matching owners and fails open on scan errors', async () => {
  if (process.platform !== 'win32') return;
  const id = '11111111-1111-4111-8111-111111111111';
  const rows = JSON.stringify([
    { ProcessId: 12, CommandLine: `codex.exe resume ${id}` },
    { ProcessId: 13, CommandLine: 'codex.exe -C C:\\repo' },
    { ProcessId: 14, CommandLine: 'codex.exe resume malformed' }
  ]);
  const owners = await findExplicitResumeOwners(id, {
    run: (_file, _args, _options, callback) => callback(null, rows)
  });
  assert.deepEqual(owners.map(owner => owner.processId), [12]);
  assert.deepEqual(await findExplicitResumeOwners(id, {
    run: (_file, _args, _options, callback) => callback(new Error('denied'))
  }), []);
  assert.deepEqual(await findExplicitResumeOwners(id, {
    run: () => { throw new Error('spawn failed'); }
  }), []);
});

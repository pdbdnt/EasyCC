const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { DEFAULT_DATA_DIR, getDataDir, getDataPath } = require('../backend/dataPaths');

function withDataDir(value, run) {
  const previous = process.env.EASYCC_DATA_DIR;
  if (value === undefined) delete process.env.EASYCC_DATA_DIR;
  else process.env.EASYCC_DATA_DIR = value;
  try {
    return run();
  } finally {
    if (previous === undefined) delete process.env.EASYCC_DATA_DIR;
    else process.env.EASYCC_DATA_DIR = previous;
  }
}

test('data root defaults to the repository data directory', () => {
  withDataDir(undefined, () => assert.equal(getDataDir(), DEFAULT_DATA_DIR));
  withDataDir('   ', () => assert.equal(getDataDir(), DEFAULT_DATA_DIR));
});

test('data root resolves an explicit path containing spaces and Unicode', () => {
  const configured = path.join(os.tmpdir(), 'EasyCC data ☃');
  withDataDir(configured, () => {
    assert.equal(getDataDir(), path.resolve(configured));
    assert.equal(getDataPath('transcripts', 'one.log'), path.join(path.resolve(configured), 'transcripts', 'one.log'));
  });
});

test('data child paths cannot escape the configured root', () => {
  const configured = fs.mkdtempSync(path.join(os.tmpdir(), 'easycc-paths-'));
  try {
    withDataDir(configured, () => {
      assert.throws(() => getDataPath('..', 'outside.json'), /escapes/);
      assert.throws(() => getDataPath(path.resolve(configured, '..', 'absolute.json')), /relative strings/);
      assert.equal(getDataPath('nested', '..', 'inside.json'), path.join(configured, 'inside.json'));
    });
  } finally {
    fs.rmSync(configured, { recursive: true, force: true });
  }
});

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  pathsEqual,
  verifyWritableDirectory,
  copyFileAtomicNoOverwrite,
  migrateLegacyData,
  configurePackagedData
} = require('../electron/packagedData');

function makeRoot(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

test('packaged data bootstrap selects userData and migrates recognized state additively', () => {
  const root = makeRoot('easycc-packaged-data-');
  const appPath = path.join(root, 'installed app');
  const userData = path.join(root, 'user data');
  const legacy = path.join(appPath, 'data');
  fs.mkdirSync(path.join(legacy, 'transcripts'), { recursive: true });
  fs.writeFileSync(path.join(legacy, 'sessions.json'), 'legacy sessions');
  fs.writeFileSync(path.join(legacy, 'transitions.log'), 'legacy transition');
  fs.writeFileSync(path.join(legacy, 'transcripts', 'one.log'), 'legacy transcript');
  fs.mkdirSync(userData, { recursive: true });
  fs.mkdirSync(path.join(userData, 'data'), { recursive: true });
  fs.writeFileSync(path.join(userData, 'data', 'sessions.json'), 'new sessions');
  const processRef = { env: {}, pid: 42, platform: process.platform };

  try {
    const result = configurePackagedData({
      app: {
        isPackaged: true,
        getPath: name => name === 'userData' ? userData : null,
        getAppPath: () => appPath
      },
      processRef,
      logger: { log() {}, warn() {} }
    });

    assert.equal(processRef.env.EASYCC_DATA_DIR, path.join(userData, 'data'));
    assert.equal(fs.readFileSync(path.join(userData, 'data', 'sessions.json'), 'utf8'), 'new sessions');
    assert.equal(fs.readFileSync(path.join(userData, 'data', 'transitions.log'), 'utf8'), 'legacy transition');
    assert.equal(fs.readFileSync(path.join(userData, 'data', 'transcripts', 'one.log'), 'utf8'), 'legacy transcript');
    assert.equal(result.migration.copied, 2);
    assert.equal(result.migration.skipped, 1);

    const repeat = migrateLegacyData(legacy, path.join(userData, 'data'), {
      processRef,
      logger: { warn() {} }
    });
    assert.equal(repeat.copied, 0);
    assert.equal(repeat.skipped, 3);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('explicit data override is preserved and development without one is a no-op', () => {
  const root = makeRoot('easycc-packaged-override-');
  try {
    const processRef = { env: { EASYCC_DATA_DIR: root }, pid: 1, platform: process.platform };
    const result = configurePackagedData({
      app: { isPackaged: false },
      processRef,
      logger: { log() {} }
    });
    assert.equal(result.dataDir, path.resolve(root));

    const noOverride = { env: {}, pid: 2, platform: process.platform };
    assert.equal(configurePackagedData({ app: { isPackaged: false }, processRef: noOverride }), null);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('writability probe reports the selected directory and original code', () => {
  const root = makeRoot('easycc-probe-');
  const fsRef = Object.create(fs);
  fsRef.openSync = () => { throw Object.assign(new Error('denied'), { code: 'EPERM', path: root }); };
  try {
    assert.throws(
      () => verifyWritableDirectory(root, { fsRef, processRef: { pid: 1 } }),
      error => error.code === 'EPERM' && error.path === root && /cannot write/.test(error.message)
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('atomic legacy copy never overwrites and cleans temporary files after failure', () => {
  const root = makeRoot('easycc-atomic-copy-');
  const source = path.join(root, 'source.json');
  const target = path.join(root, 'target', 'state.json');
  fs.writeFileSync(source, 'old');
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, 'new');

  try {
    assert.equal(copyFileAtomicNoOverwrite(source, target), 'skipped');
    assert.equal(fs.readFileSync(target, 'utf8'), 'new');

    fs.rmSync(target);
    const fsRef = Object.create(fs);
    fsRef.linkSync = () => { throw Object.assign(new Error('interrupted'), { code: 'EIO' }); };
    assert.throws(() => copyFileAtomicNoOverwrite(source, target, { fsRef }), /interrupted/);
    assert.deepEqual(fs.readdirSync(path.dirname(target)), []);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('Windows path equality is case-insensitive', () => {
  assert.equal(pathsEqual('C:\\Users\\Rose\\Data', 'c:\\users\\rose\\data', 'win32', path.win32), true);
});

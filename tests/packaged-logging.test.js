const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { configurePackagedLogging } = require('../electron/packagedLogging');

test('packaged logging redirects console, backend, and stdio errors to files', () => {
  const logsDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'easycc-logs-'));
  const stdout = new EventEmitter();
  const stderr = new EventEmitter();
  const processRef = { env: {}, stdout, stderr };
  const consoleRef = {};

  try {
    const paths = configurePackagedLogging({
      app: { isPackaged: true, getPath: name => {
        assert.equal(name, 'logs');
        return logsDirectory;
      } },
      processRef,
      consoleRef
    });

    consoleRef.log('started', { port: 5010 });
    consoleRef.error('failed', new Error('example'));
    stdout.emit('error', Object.assign(new Error('bad descriptor'), { code: 'EBADF' }));

    const contents = fs.readFileSync(paths.mainLogFile, 'utf8');
    assert.match(contents, /Packaged logging initialized/);
    assert.match(contents, /started \{ port: 5010 \}/);
    assert.match(contents, /failed Error: example/);
    assert.match(contents, /stdout write failed: Error: bad descriptor/);
    assert.equal(processRef.env.EASYCC_BACKEND_LOG_FILE, paths.backendLogFile);
  } finally {
    fs.rmSync(logsDirectory, { recursive: true, force: true });
  }
});

test('development logging is left unchanged', () => {
  const processRef = { env: {} };
  const consoleRef = { log() {} };

  const result = configurePackagedLogging({
    app: { isPackaged: false },
    processRef,
    consoleRef
  });

  assert.equal(result, null);
  assert.equal(processRef.env.EASYCC_BACKEND_LOG_FILE, undefined);
});

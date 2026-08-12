const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

test('synchronous backend logging writes immediately and closes idempotently', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'easycc-backend-log-'));
  const logFile = path.join(root, 'backend.log');
  const modulePath = path.resolve(__dirname, '..', 'backend', 'backendLogging.js');
  const script = `
    const fastify = require('fastify');
    const { createBackendLogging } = require(${JSON.stringify(modulePath)});
    (async () => {
      const logging = createBackendLogging(${JSON.stringify(logFile)});
      const app = fastify(logging.fastifyOptions);
      app.log.info('immediate packaged log');
      await app.close();
      await logging.close();
      await logging.close();
    })().catch(error => { console.error(error); process.exit(1); });
  `;

  try {
    const child = spawnSync(process.execPath, ['-e', script], { encoding: 'utf8', timeout: 10_000 });
    assert.equal(child.status, 0, child.stderr);
    assert.doesNotMatch(child.stderr, /sonic boom is not ready yet/i);
    assert.match(fs.readFileSync(logFile, 'utf8'), /immediate packaged log/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

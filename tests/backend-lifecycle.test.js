const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
}

test('standalone backend exits nonzero promptly when its port is occupied', { timeout: 20_000 }, async () => {
  const blocker = net.createServer();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'easycc-lifecycle-'));
  await listen(blocker);
  const port = blocker.address().port;
  const startedAt = Date.now();

  try {
    const child = spawn(process.execPath, [path.resolve(__dirname, '..', 'backend', 'server.js')], {
      cwd: path.resolve(__dirname, '..'),
      env: {
        ...process.env,
        PORT: String(port),
        EASYCC_DATA_DIR: path.join(root, 'data'),
        HOME: root,
        USERPROFILE: root,
        WSL_FOLDERS_BROWSE_ROOT: path.join(root, 'wsl-disabled')
      },
      stdio: ['ignore', 'pipe', 'pipe']
    });

    let output = '';
    child.stdout.on('data', chunk => { output += chunk; });
    child.stderr.on('data', chunk => { output += chunk; });
    const result = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        child.kill();
        reject(new Error(`backend did not terminate after listen failure:\n${output}`));
      }, 12_000);
      child.once('error', reject);
      child.once('close', (code, signal) => {
        clearTimeout(timer);
        resolve({ code, signal });
      });
    });

    assert.equal(result.signal, null, output);
    assert.equal(result.code, 1, output);
    assert.match(output, /EADDRINUSE|address already in use/i);
    assert.ok(Date.now() - startedAt < 12_000, 'backend shutdown exceeded the bounded timeout');
  } finally {
    await new Promise(resolve => blocker.close(resolve));
    fs.rmSync(root, { recursive: true, force: true });
  }
});

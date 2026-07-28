const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const pty = require('../backend/node_modules/node-pty');

const CODEX_EXE = path.join(
  process.env.APPDATA || '',
  'npm',
  'node_modules',
  '@openai',
  'codex',
  'node_modules',
  '@openai',
  'codex-win32-x64',
  'vendor',
  'x86_64-pc-windows-msvc',
  'bin',
  'codex.exe'
);

const REQUEST_TIMEOUT_MS = 10_000;

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function waitFor(predicate, timeoutMs, description) {
  const startedAt = Date.now();
  return new Promise((resolve, reject) => {
    const timer = setInterval(() => {
      if (predicate()) {
        clearInterval(timer);
        resolve();
      } else if (Date.now() - startedAt >= timeoutMs) {
        clearInterval(timer);
        reject(new Error(`Timed out waiting for ${description}`));
      }
    }, 25);
  });
}

async function main() {
  assert.equal(process.platform, 'win32', 'This probe requires native Windows');
  assert.equal(fs.existsSync(CODEX_EXE), true, `Codex executable not found: ${CODEX_EXE}`);
  const { encodeCodexWindowsSoftNewline } = await import(
    '../ui/src/utils/terminalInputUtils.js'
  );
  const softNewline = encodeCodexWindowsSoftNewline({
    key: 'Enter',
    ctrlKey: true
  });
  assert.equal(softNewline, '\n', 'Ctrl+Enter must map to one LF byte');

  const requests = [];
  const server = http.createServer((request, response) => {
    let body = '';
    request.setEncoding('utf8');
    request.on('data', (chunk) => {
      body += chunk;
    });
    request.on('end', () => {
      requests.push({ method: request.method, url: request.url, body });
      response.writeHead(500, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ error: { message: 'Expected probe stop' } }));
    });
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });

  const address = server.address();
  assert.equal(typeof address, 'object');
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'easycc-codex-newline-'));
  const codexHome = path.join(tempRoot, 'codex-home');
  const workspaceRoot = path.resolve(__dirname, '..');
  fs.mkdirSync(codexHome);
  fs.writeFileSync(path.join(codexHome, '.sandbox_migration'), 'v1\n');
  fs.writeFileSync(path.join(codexHome, '.personality_migration'), 'v1\n');
  fs.writeFileSync(
    path.join(codexHome, 'config.toml'),
    [
      `[projects.'${workspaceRoot}']`,
      'trust_level = "trusted"',
      '',
      '[notice]',
      'hide_full_access_warning = true',
      '',
      '[windows]',
      'sandbox = "elevated"',
      ''
    ].join('\n')
  );

  const args = [
    '--no-alt-screen',
    '-C',
    workspaceRoot,
    '-s',
    'read-only',
    '-a',
    'never',
    '-c',
    'model="easycc-probe-model"',
    '-c',
    'model_provider="easycc_probe"',
    '-c',
    'model_providers.easycc_probe.name="EasyCC Probe"',
    '-c',
    `model_providers.easycc_probe.base_url="http://127.0.0.1:${address.port}/v1"`,
    '-c',
    'model_providers.easycc_probe.env_key="EASYCC_PROBE_KEY"',
    '-c',
    'model_providers.easycc_probe.wire_api="responses"',
    '-c',
    'model_providers.easycc_probe.request_max_retries=0',
    '-c',
    'model_providers.easycc_probe.stream_max_retries=0',
    '-c',
    'model_providers.easycc_probe.requires_openai_auth=false'
  ];

  const output = [];
  const child = pty.spawn(CODEX_EXE, args, {
    cols: 100,
    rows: 30,
    cwd: workspaceRoot,
    env: {
      ...process.env,
      CODEX_HOME: codexHome,
      EASYCC_PROBE_KEY: 'local-probe-only',
      TERM: 'xterm-256color'
    },
    useConpty: false
  });
  const childExit = new Promise((resolve) => child.onExit(resolve));
  child.onData((data) => output.push(data));

  try {
    await wait(1_500);
    child.write('EASYCC_ALPHA');
    child.write(softNewline);
    child.write('EASYCC_OMEGA');

    await wait(1_000);
    assert.equal(
      requests.length,
      0,
      'Soft newline submitted a request before ordinary Enter'
    );

    child.write('\r');
    await waitFor(
      () => requests.length > 0,
      REQUEST_TIMEOUT_MS,
      'ordinary Enter to submit the probe prompt'
    );

    assert.equal(requests.length, 1, 'Ordinary Enter should produce one request');
    const payload = JSON.parse(requests[0].body);
    const serializedPayload = JSON.stringify(payload);
    assert.match(
      serializedPayload,
      /EASYCC_ALPHA\\nEASYCC_OMEGA/,
      'Submitted request did not preserve the soft newline'
    );

    process.stdout.write(JSON.stringify({
      codexExe: CODEX_EXE,
      pty: 'winpty',
      browserChord: 'Ctrl+Enter',
      softNewlineBytes: Buffer.from(softNewline).toString('hex'),
      requestsBeforeEnter: 0,
      requestsAfterEnter: requests.length,
      submittedMultilinePrompt: true
    }, null, 2));
    process.stdout.write('\n');
  } catch (error) {
    const escapedOutput = output.join('').replace(/\x1b/g, '<ESC>');
    process.stderr.write(`${escapedOutput.slice(-8_000)}\n`);
    throw error;
  } finally {
    child.kill();
    await Promise.race([childExit, wait(2_000)]);
    server.closeAllConnections();
    server.close();
    try {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    } catch (error) {
      if (error.code !== 'EPERM') throw error;
    }
  }
}

main().then(
  () => process.exit(0),
  (error) => {
    process.stderr.write(`${error.stack || error}\n`);
    process.exit(1);
  }
);

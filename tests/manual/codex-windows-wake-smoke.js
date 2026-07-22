const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');

function parseArgs(argv) {
  const result = { port: 5097, workingDir: '' };
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === '--port') result.port = Number(argv[++index]);
    else if (argv[index] === '--working-dir') result.workingDir = argv[++index];
  }
  return result;
}

function waitFor(predicate, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const check = () => {
      if (predicate()) return resolve();
      if (Date.now() >= deadline) return reject(new Error(`Timed out waiting for ${label}`));
      setTimeout(check, 100);
    };
    check();
  });
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const ownedDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'easycc-wake-smoke-data-'));
  const ownedWorkingDir = options.workingDir
    ? path.resolve(options.workingDir)
    : fs.mkdtempSync(path.join(os.tmpdir(), 'easycc-wake-smoke-work-'));
  fs.mkdirSync(ownedWorkingDir, { recursive: true });
  process.env.EASYCC_DATA_DIR = ownedDataDir;

  const SessionManager = require('../../backend/sessionManager');
  const manager = new SessionManager();
  manager.port = options.port;
  const output = [];
  manager.on('output', event => output.push(String(event.data || '')));

  const server = http.createServer((request, response) => {
    if (request.method !== 'POST' || request.url !== '/api/codex-windows/session-start') {
      response.writeHead(404).end();
      return;
    }
    let body = '';
    request.setEncoding('utf8');
    request.on('data', chunk => { body += chunk; });
    request.on('end', () => {
      let payload = {};
      try { payload = JSON.parse(body || '{}'); } catch {}
      const accepted = manager.acceptCodexWindowsSessionStart(
        request.headers['x-easycc-session-id'],
        request.headers['x-easycc-hook-token'],
        payload
      );
      response.writeHead(accepted ? 200 : 403, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ accepted }));
    });
  });

  let session = null;
  try {
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(options.port, '127.0.0.1', resolve);
    });
    process.stdout.write(`smoke: hook receiver listening on ${options.port}\n`);
    const snapshot = manager.createSession(
      'EasyCC wake smoke',
      ownedWorkingDir,
      'codex-windows'
    );
    session = manager.sessions.get(snapshot.id);
    process.stdout.write(`smoke: disposable EasyCC session ${session.id}\n`);
    await waitFor(
      () => session.status === 'idle' &&
        session.idleEvidence === 'codex_ready_prompt' &&
        Date.now() - Date.parse(session.readySince || '') >= 2_000,
      30_000,
      'stable initial ready prompt'
    );
    await waitFor(
      () => output.join('').includes('Starting MCP servers'),
      30_000,
      'initial MCP startup'
    );
    await waitFor(
      () => session.status === 'idle' &&
        session.idleEvidence === 'codex_ready_prompt' &&
        Date.now() - Date.parse(session.readySince || '') >= 2_000,
      30_000,
      'post-MCP ready prompt'
    );
    manager.sendInput(
      session.id,
      'Reply exactly EASYCC_PARK_READY now. When my next message is continue, reply exactly EASYCC_RESUME_READY and do nothing else.'
    );
    await new Promise(resolve => setTimeout(resolve, 2_000));
    manager.sendInput(session.id, '\r');
    await waitFor(
      () => output.join('').includes('EASYCC_PARK_READY') &&
        session.status === 'idle' &&
        session.codexIdentityState === 'verified',
      60_000,
      'initial response and SessionStart identity'
    );
    const threadId = session.codexSessionId;
    process.stdout.write('smoke: initial response and identity verified\n');

    await waitFor(
      () => manager.isParkingEligible(session),
      60_000,
      'verified idle parking eligibility'
    );

    const parked = await manager.parkSession(session.id, { reason: 'manual_smoke' });
    if (!parked.ok) {
      throw new Error(`Parking failed: ${parked.error} (${JSON.stringify({
        status: session.status,
        runtimeState: session.runtimeState,
        idleEvidence: session.idleEvidence,
        readySince: session.readySince,
        identityState: session.codexIdentityState,
        identityError: session.codexIdentityError,
        interactionPending: session.interactionPending,
        queued: session.messageQueue?.length || 0
      })})`);
    }
    process.stdout.write('smoke: disposable session parked\n');
    let continueDeliveries = 0;
    const originalSendInput = manager.sendInput.bind(manager);
    manager.sendInput = (id, text, sendOptions) => {
      if (id === session.id && text === 'continue\r') continueDeliveries += 1;
      return originalSendInput(id, text, sendOptions);
    };
    const queued = manager.sendOrEnqueue(session.id, 'continue\r');
    if (!queued.queued || !queued.waking) throw new Error('Continue was not queued into exact wake');
    process.stdout.write('smoke: queued continue and exact wake started\n');
    await waitFor(
      () => session.runtimeState === 'live' && continueDeliveries === 1,
      30_000,
      'exact wake and one queued delivery'
    );
    await waitFor(
      () => session.messageQueue.length === 0,
      10_000,
      'queued Enter keypress delivery'
    );
    const responseStart = output.join('').length;
    await waitFor(
      () => output.join('').slice(responseStart).includes('EASYCC_RESUME_READY'),
      60_000,
      'resumed model response'
    );
    await waitFor(
      () => session.status === 'idle' && session.idleEvidence === 'codex_ready_prompt',
      60_000,
      'resumed model response and final ready prompt'
    );
    await waitFor(
      () => ['verified', 'resume_verified'].includes(session.codexIdentityState),
      15_000,
      'exact resumed identity'
    );
    if (String(session.codexSessionId).toLowerCase() !== threadId.toLowerCase()) {
      throw new Error(`Identity changed from ${threadId} to ${session.codexSessionId}`);
    }
    if (continueDeliveries !== 1) throw new Error(`Continue delivered ${continueDeliveries} times`);

    process.stdout.write(`${JSON.stringify({
      ok: true,
      easyccSessionId: session.id,
      codexSessionId: session.codexSessionId,
      identityState: session.codexIdentityState,
      continueDeliveries,
      runtimeState: session.runtimeState,
      status: session.status,
      wakeWarning: session.wakeWarning || null
    }, null, 2)}\n`);
  } catch (error) {
    const cleanTail = output.join('')
      .replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, '')
      .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
      .slice(-3000);
    process.stderr.write(`smoke output tail:\n${cleanTail}\n`);
    throw error;
  } finally {
    if (session && manager.sessions.has(session.id)) manager.killSession(session.id);
    manager.cleanup();
    await new Promise(resolve => server.close(resolve));
    fs.rmSync(ownedDataDir, { recursive: true, force: true });
    if (!options.workingDir) fs.rmSync(ownedWorkingDir, { recursive: true, force: true });
  }
}

main().then(() => {
  process.exit(0);
}).catch(error => {
  process.stderr.write(`${error.stack || error.message}\n`);
  process.exit(1);
});

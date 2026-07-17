const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  CodexSessionService,
  buildProcessScanProbe,
  decodeCursor,
  encodeCursor,
  getLocalDate,
  normalizePreview,
  pathsEqual
} = require('../backend/codexSessionService');
const registerCodexResumeRoutes = require('../backend/codexResumeRoutes');
const SessionManager = require('../backend/sessionManager');

const IDS = {
  first: '019f4a56-26a5-7440-bbc6-54b00447d986',
  second: '019f49d3-a29a-72e1-9c67-d7046b6f8a40',
  third: '019f4972-2155-7d33-9755-3beb3589323e',
  subagent: '019f4a75-e98b-79f2-996a-1b9870b59b56'
};

function b64(value) {
  return Buffer.from(String(value), 'utf8').toString('base64');
}

function sessionMeta(id, cwd, extra = {}) {
  return JSON.stringify({
    timestamp: extra.timestamp || '2026-07-10T01:00:00.000Z',
    type: 'session_meta',
    payload: {
      id,
      session_id: id,
      timestamp: extra.timestamp || '2026-07-10T01:00:00.000Z',
      cwd,
      source: extra.source === undefined ? 'cli' : extra.source,
      thread_source: extra.threadSource || 'user'
    }
  });
}

function rolloutRow(id, cwd, modifiedSeconds, extra = {}) {
  const file = `/home/test/.codex/sessions/2026/07/10/rollout-test-${id}.jsonl`;
  const metadata = { timestamp: new Date(modifiedSeconds * 1000).toISOString(), ...extra };
  return `${b64(file)}\t${modifiedSeconds}\t${b64(sessionMeta(id, cwd, metadata))}`;
}

function rolloutMetadataLine(id, cwd, modifiedSeconds, extra = {}) {
  const metadata = { timestamp: new Date(modifiedSeconds * 1000).toISOString(), ...extra };
  const record = JSON.parse(sessionMeta(id, cwd, metadata));
  return JSON.stringify({
    file: `/home/test/.codex/sessions/2026/07/10/rollout-test-${id}.jsonl`,
    modifiedAtMs: modifiedSeconds * 1000,
    timestamp: record.timestamp,
    payload: record.payload
  });
}

function processRow(pid, easyccSessionId, id, cwd, extra = {}) {
  const file = `/home/test/.codex/sessions/2026/07/10/rollout-test-${id}.jsonl`;
  const record = JSON.parse(sessionMeta(id, cwd, extra));
  return JSON.stringify({
    pid,
    sid: easyccSessionId,
    file,
    payload: record.payload
  });
}

function previewContent(message) {
  return [
    JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Injected AGENTS content' }] } }),
    JSON.stringify({ type: 'event_msg', payload: { type: 'user_message', message } })
  ].join('\n');
}

function makeCatalogRunner() {
  const index = [
    JSON.stringify({ id: IDS.first, thread_name: 'old-title', updated_at: '2026-07-09T01:00:00.000Z' }),
    JSON.stringify({ id: IDS.first, thread_name: 'resume-one', updated_at: '2026-07-10T03:00:00.000Z' }),
    JSON.stringify({ id: IDS.second, thread_name: 'resume-two', updated_at: '2026-07-09T03:00:00.000Z' }),
    JSON.stringify({ id: IDS.third, thread_name: 'resume-three', updated_at: '2026-07-08T03:00:00.000Z' }),
    '{bad json'
  ].join('\n');
  const rollouts = [
    rolloutMetadataLine(IDS.first, '/mnt/c/work/project-a', Date.parse('2026-07-10T03:00:00.000Z') / 1000),
    rolloutMetadataLine(IDS.second, '/mnt/c/work/project-a', Date.parse('2026-07-09T03:00:00.000Z') / 1000),
    rolloutMetadataLine(IDS.third, '/home/test/project-b', Date.parse('2026-07-08T03:00:00.000Z') / 1000),
    rolloutMetadataLine(IDS.subagent, '/mnt/c/work/project-a', Date.parse('2026-07-10T04:00:00.000Z') / 1000, {
      threadSource: 'subagent',
      source: { subagent: { thread_spawn: { parent_thread_id: IDS.first } } }
    })
  ].join('\n');
  const contexts = [
    `${b64('/mnt/c/work/project-a')}\t${b64('/mnt/c/work/project-a')}\t${b64('main')}`,
    `${b64('/home/test/project-b')}\t${b64('/home/test/project-b')}\t${b64('main')}`
  ].join('\n');
  return (command) => {
    if (command.includes('session_index.jsonl')) return index;
    if (command.includes('node -e') && command.includes('modifiedAtMs')) return rollouts;
    if (command.includes('git -C')) return contexts;
    if (command.includes('/proc') && command.includes('readlinkSync')) return '';
    if (command.includes('node -e') && command.includes('2097152')) {
      const rows = [];
      if (command.includes(IDS.first)) rows.push(`${IDS.first}\t${b64('Latest prompt for one')}`);
      if (command.includes(IDS.second)) rows.push(`${IDS.second}\t${b64('Latest prompt for two')}`);
      if (command.includes(IDS.third)) rows.push(`${IDS.third}\t${b64('Latest prompt for three')}`);
      return rows.join('\n');
    }
    return '';
  };
}

function createWindowsHistory(t, { id = IDS.first, cwd = 'C:\\Users\\denni\\apps\\specsket-ph2.5' } = {}) {
  const codexHome = fs.mkdtempSync(path.join(os.tmpdir(), 'easycc-codex-windows-'));
  t.after(() => fs.rmSync(codexHome, { recursive: true, force: true }));
  const sessionsDir = path.join(codexHome, 'sessions', '2026', '07', '17');
  fs.mkdirSync(sessionsDir, { recursive: true });
  fs.writeFileSync(path.join(codexHome, 'session_index.jsonl'), `${JSON.stringify({
    id,
    thread_name: 'Windows Specsket conversation',
    updated_at: '2026-07-17T01:00:00.000Z'
  })}\n`);
  const rolloutPath = path.join(sessionsDir, `rollout-test-${id}.jsonl`);
  fs.writeFileSync(rolloutPath, [
    sessionMeta(id, cwd, { timestamp: '2026-07-17T01:00:00.000Z' }),
    JSON.stringify({ type: 'event_msg', payload: { type: 'user_message', message: 'Continue native Specsket work' } })
  ].join('\n'));
  return codexHome;
}

test('normalizePreview removes controls and truncates by Unicode code point', () => {
  const value = `\x1b[31mhello\x1b[0m ${'😀'.repeat(200)}`;
  const preview = normalizePreview(value, 12);
  assert.equal(Array.from(preview).length, 12);
  assert.match(preview, /^hello /);
  assert.equal(preview.endsWith('…'), true);
});

test('date cursors are opaque and complete-date based', () => {
  const cursor = encodeCursor({ beforeDate: '2026-07-09' });
  assert.deepEqual(decodeCursor(cursor), { beforeDate: '2026-07-09' });
  assert.equal(decodeCursor('broken'), null);
  assert.equal(getLocalDate('2026-07-09T16:30:00.000Z', 'Asia/Singapore'), '2026-07-10');
});

test('Windows shell execution bypasses WSL command re-parsing', async () => {
  let invocation = null;
  const service = new CodexSessionService({
    platform: 'win32',
    execFile(executable, args, options, callback) {
      invocation = { executable, args, options };
      callback(null, 'ok');
    }
  });

  const command = 'codex_root="$HOME/.codex"; printf %s "$codex_root"';
  const output = await service.runShell(command);
  assert.equal(output, 'ok');
  assert.equal(invocation.executable, 'wsl.exe');
  assert.deepEqual(invocation.args, [
    '--exec',
    'bash',
    '--noprofile',
    '--norc',
    '-lc',
    command
  ]);
});

test('Windows shell execution retries once and does not expose generated commands', async () => {
  let attempts = 0;
  const service = new CodexSessionService({
    platform: 'win32',
    wslRetryDelayMs: 0,
    execFile(executable, args, options, callback) {
      attempts += 1;
      if (attempts === 1) {
        const error = new Error(`Command failed: ${args.join(' ')}`);
        error.code = 1;
        callback(error, '');
        return;
      }
      callback(null, 'recovered');
    }
  });

  assert.equal(await service.runShell('node -e generated-history-probe'), 'recovered');
  assert.equal(attempts, 2);

  attempts = 0;
  service.execFile = (executable, args, options, callback) => {
    attempts += 1;
    const error = new Error(`Command failed: ${args.join(' ')}`);
    error.code = 1;
    callback(error, '');
  };
  await assert.rejects(
    service.runShell('node -e generated-history-probe'),
    (error) => error.message === 'Could not read Codex data from WSL. Please retry.' &&
      !error.message.includes('generated-history-probe')
  );
  assert.equal(attempts, 2);
});

test('path equality normalizes Windows, WSL mount, and WSL UNC forms without folding Linux paths', () => {
  assert.equal(pathsEqual('C:\\Users\\denni\\apps\\EasyCC', '/mnt/c/Users/denni/apps/EasyCC'), true);
  assert.equal(pathsEqual('c:/users/DENNI/apps/easycc/', '/mnt/c/Users/denni/apps/EasyCC'), true);
  assert.equal(pathsEqual('\\\\wsl.localhost\\Ubuntu\\home\\denni\\apps\\EasyCC', '/home/denni/apps/EasyCC'), true);
  assert.equal(pathsEqual('/home/denni/apps/EasyCC', '/home/denni/apps/easycc'), false);
});

test('resume catalog deduplicates titles, excludes subagents, pages by two complete dates, and uses direct prompt events', async () => {
  const service = new CodexSessionService({
    platform: 'linux',
    codexHome: '/home/test/.codex',
    commandRunner: makeCatalogRunner()
  });
  const sessions = [{
    id: 'easycc-one',
    name: 'Saved one',
    cliType: 'codex',
    status: 'paused',
    workingDir: '/mnt/c/work/project-a',
    groupKey: '/mnt/c/work/project-a',
    codexSessionId: IDS.first
  }];

  const firstPage = await service.getResumeCatalog({ sessions, timeZone: 'UTC' });
  assert.deepEqual(firstPage.page.dates, ['2026-07-10', '2026-07-09']);
  assert.equal(firstPage.page.hasOlder, true);
  assert.ok(firstPage.page.nextCursor);
  assert.deepEqual(firstPage.threads.map((item) => item.codexSessionId), [IDS.first, IDS.second]);
  assert.equal(firstPage.threads[0].threadName, 'resume-one');
  assert.equal(firstPage.threads[0].preview, 'Latest prompt for one');
  assert.equal(firstPage.threads.some((item) => item.codexSessionId === IDS.subagent), false);
  assert.equal(firstPage.savedSessions[0].mappingState, 'exact');
  assert.equal(firstPage.savedSessions[0].selectedByDefault, true);

  const older = await service.getResumeCatalog({
    sessions,
    timeZone: 'UTC',
    cursor: firstPage.page.nextCursor
  });
  assert.deepEqual(older.page.dates, ['2026-07-08']);
  assert.deepEqual(older.threads.map((item) => item.codexSessionId), [IDS.third]);
});

test('resume catalog applies server-side title/id/cwd search before date bucketing', async () => {
  const service = new CodexSessionService({
    platform: 'linux',
    codexHome: '/home/test/.codex',
    commandRunner: makeCatalogRunner()
  });
  const byTitle = await service.getResumeCatalog({ query: 'resume-three', timeZone: 'UTC' });
  assert.deepEqual(byTitle.page.dates, ['2026-07-08']);
  assert.deepEqual(byTitle.threads.map((item) => item.codexSessionId), [IDS.third]);

  const byCwd = await service.getResumeCatalog({ query: '/mnt/c/work/project-a', timeZone: 'UTC' });
  assert.deepEqual(byCwd.threads.map((item) => item.codexSessionId), [IDS.first, IDS.second]);
});

test('sorted resume catalog globally orders groups and conversations with stable cursors', async () => {
  const service = new CodexSessionService({
    platform: 'linux',
    codexHome: '/home/test/.codex',
    commandRunner: makeCatalogRunner()
  });

  const byFolder = await service.getResumeCatalog({
    groupBy: 'folder',
    groupSort: 'folder-asc',
    threadSort: 'updated-asc',
    timeZone: 'UTC'
  });
  assert.deepEqual(byFolder.groups.map((group) => group.name), ['project-a', 'project-b']);
  assert.deepEqual(byFolder.threads.map((thread) => thread.threadName), ['resume-two', 'resume-one', 'resume-three']);
  assert.deepEqual(byFolder.sort, {
    groupBy: 'folder',
    groupSort: 'folder-asc',
    threadSort: 'updated-asc'
  });
  assert.equal(byFolder.page.total, 3);
  assert.equal(byFolder.groups[0].selectableSelections.length, 2);

  const flatNewest = await service.getResumeCatalog({
    groupBy: 'none',
    groupSort: 'count-desc',
    threadSort: 'updated-desc',
    timeZone: 'UTC'
  });
  assert.deepEqual(flatNewest.threads.map((thread) => thread.threadName), ['resume-one', 'resume-two', 'resume-three']);
  assert.equal(flatNewest.sort.groupBy, 'none');
});

test('an empty Windows cold-start history scan retries and remains stale when still empty', async () => {
  let indexReads = 0;
  let rolloutReads = 0;
  const service = new CodexSessionService({
    platform: 'win32',
    codexHome: '/home/test/.codex',
    emptyHistoryRetryDelayMs: 0,
    commandRunner: (command) => {
      if (command.includes('session_index.jsonl')) indexReads += 1;
      if (command.includes('modifiedAtMs')) rolloutReads += 1;
      return '';
    }
  });

  const history = await service.getHistorySnapshot();
  assert.equal(indexReads, 2);
  assert.equal(rolloutReads, 2);
  assert.equal(history.empty, true);
  const cached = await service.getHistorySnapshot({ allowStale: true });
  assert.equal(cached.stale, true);
});

test('group and card scopes read only the Codex history for their Windows or WSL runtime', async (t) => {
  const windowsCwd = 'C:\\Users\\denni\\apps\\specsket-ph2.5';
  const windowsCodexHome = createWindowsHistory(t, { cwd: windowsCwd });
  const baseRunner = makeCatalogRunner();
  let wslHistoryReads = 0;
  const service = new CodexSessionService({
    platform: 'linux',
    codexHome: '/home/test/.codex',
    windowsCodexHome,
    commandRunner: (command) => {
      if (command.includes('session_index.jsonl') || (command.includes('node -e') && command.includes('modifiedAtMs'))) {
        wslHistoryReads += 1;
      }
      return baseRunner(command);
    }
  });
  const windowsSession = {
    id: 'easycc-windows',
    name: 'Windows Specsket',
    cliType: 'codex-windows',
    status: 'paused',
    workingDir: windowsCwd,
    groupKey: windowsCwd,
    codexSessionId: null
  };

  const windowsGroup = await service.getResumeCatalog({
    sessions: [windowsSession],
    groupKey: windowsCwd,
    timeZone: 'UTC'
  });
  assert.equal(windowsGroup.cache.diagnostics.runtime, 'windows');
  assert.equal(windowsGroup.cache.diagnostics.codexHome, path.resolve(windowsCodexHome));
  assert.deepEqual(windowsGroup.threads.map((thread) => thread.codexSessionId), [IDS.first]);
  assert.equal(windowsGroup.threads[0].preview, 'Continue native Specsket work');
  assert.equal(wslHistoryReads, 0);

  const windowsCard = await service.getResumeCatalog({
    sessions: [windowsSession],
    easyccSessionId: windowsSession.id,
    timeZone: 'UTC'
  });
  assert.equal(windowsCard.cache.diagnostics.runtime, 'windows');
  assert.deepEqual(windowsCard.savedSessions.map((session) => session.easyccSessionId), [windowsSession.id]);
  assert.deepEqual(windowsCard.threads.map((thread) => thread.codexSessionId), [IDS.first]);
  assert.equal(wslHistoryReads, 0);

  const wslGroup = await service.getResumeCatalog({
    sessions: [{
      id: 'easycc-wsl',
      name: 'WSL project',
      cliType: 'codex',
      status: 'paused',
      workingDir: '/mnt/c/work/project-a',
      groupKey: '/mnt/c/work/project-a',
      codexSessionId: null
    }],
    groupKey: '/mnt/c/work/project-a',
    timeZone: 'UTC'
  });
  assert.equal(wslGroup.cache.diagnostics.runtime, 'wsl');
  assert.deepEqual(wslGroup.threads.map((thread) => thread.codexSessionId), [IDS.first, IDS.second]);
  assert.ok(wslHistoryReads >= 2);
});

test('a mixed-runtime folder scope refuses to combine Windows and WSL history', async () => {
  const service = new CodexSessionService({ platform: 'linux', commandRunner: () => '' });
  const groupKey = 'C:\\work\\mixed';
  await assert.rejects(service.getResumeCatalog({
    groupKey,
    sessions: [
      { id: 'windows', cliType: 'codex-windows', status: 'paused', workingDir: groupKey, groupKey },
      { id: 'wsl', cliType: 'codex', status: 'paused', workingDir: '/mnt/c/work/mixed', groupKey }
    ]
  }), /both Windows and WSL Codex cards/);
});

test('card-scoped resume catalog returns only the requested paused card and its exact folder', async () => {
  const service = new CodexSessionService({
    platform: 'linux',
    codexHome: '/home/test/.codex',
    commandRunner: makeCatalogRunner()
  });
  const catalog = await service.getResumeCatalog({
    easyccSessionId: 'easycc-target',
    sessions: [{
      id: 'easycc-target',
      name: 'Needs mapping',
      cliType: 'codex',
      status: 'paused',
      workingDir: 'C:\\work\\project-a',
      groupKey: 'C:\\work\\project-a',
      codexSessionId: null
    }, {
      id: 'easycc-other',
      name: 'Other paused card',
      cliType: 'codex',
      status: 'paused',
      workingDir: '/mnt/c/work/project-a',
      groupKey: '/mnt/c/work/project-a',
      codexSessionId: IDS.first
    }],
    timeZone: 'UTC'
  });

  assert.deepEqual(catalog.savedSessions.map((item) => item.easyccSessionId), ['easycc-target']);
  assert.deepEqual(catalog.threads.map((item) => item.codexSessionId), [IDS.first, IDS.second]);
  assert.equal(catalog.threads.every((item) => pathsEqual(item.workingDir, 'C:\\work\\project-a')), true);
  assert.equal(catalog.threads[0].selectable, false);
  assert.equal(catalog.threads[0].disabledReason, 'Already linked to another EasyCC card');
  assert.equal(catalog.threads[1].selectable, true);
});

test('resume catalog does not offer a paused card whose Codex thread is still live', async () => {
  const baseRunner = makeCatalogRunner();
  const service = new CodexSessionService({
    platform: 'linux',
    codexHome: '/home/test/.codex',
    commandRunner: (command) => command.includes('/proc') && command.includes('readlinkSync')
      ? processRow(100, '', IDS.first, '/mnt/c/work/project-a')
      : baseRunner(command)
  });
  const catalog = await service.getResumeCatalog({
    sessions: [{
      id: 'easycc-one',
      name: 'Saved one',
      cliType: 'codex',
      status: 'paused',
      workingDir: '/mnt/c/work/project-a',
      groupKey: '/mnt/c/work/project-a',
      codexSessionId: IDS.first
    }],
    timeZone: 'UTC'
  });

  assert.equal(catalog.threads[0].selectable, false);
  assert.equal(catalog.threads[0].disabledReason, 'The linked conversation is still running');
  assert.equal(catalog.savedSessions[0].selectedByDefault, false);
  assert.equal(catalog.savedSessions[0].selectable, false);
});

test('process scan associates EasyCC roots and excludes subagents from global live inventory', async () => {
  const output = [
    processRow(100, 'easycc-one', IDS.first, '/mnt/c/work/project-a'),
    processRow(100, 'easycc-one', IDS.subagent, '/mnt/c/work/project-a', {
      threadSource: 'subagent',
      source: { subagent: { thread_spawn: { parent_thread_id: IDS.first } } }
    }),
    processRow(200, '', IDS.second, '/mnt/c/work/project-a')
  ].join('\n');
  const service = new CodexSessionService({
    platform: 'linux',
    codexHome: '/home/test/.codex',
    commandRunner: (command) => command.includes('/proc') && command.includes('readlinkSync') ? output : ''
  });
  const scan = await service.scanProcesses();
  assert.deepEqual(scan.roots.map((root) => root.id), [IDS.first, IDS.second]);
  assert.equal(scan.roots[0].easyccSessionId, 'easycc-one');
  assert.equal(scan.liveRootIds.has(IDS.subagent), false);
});

test('process scan probe is valid JavaScript', () => {
  assert.doesNotThrow(() => new Function(buildProcessScanProbe()));
});

test('process scan yields the event loop while the shell probe runs', async () => {
  let timerFired = false;
  const service = new CodexSessionService({
    platform: 'linux',
    codexHome: '/home/test/.codex',
    execFile: (...args) => {
      const callback = args.at(-1);
      setTimeout(() => callback(null, ''), 20);
    }
  });
  setTimeout(() => { timerFired = true; }, 0);

  await service.scanProcesses();
  assert.equal(timerFired, true);
});

test('process scan uses the configured Codex home instead of a hard-coded .codex path', async () => {
  let observedCommand = '';
  const service = new CodexSessionService({
    platform: 'linux',
    codexHome: '/srv/custom-codex',
    commandRunner: (command) => {
      observedCommand = command;
      return '';
    }
  });

  await service.scanProcesses();
  assert.match(observedCommand, /codex_root='\/srv\/custom-codex'/);
  assert.match(observedCommand, /"\$codex_root"/);
  assert.doesNotMatch(observedCommand, /includes\('\\''\/\.codex\/sessions/);
});

test('repository context encoding is portable to BSD base64', async () => {
  let observedCommand = '';
  const service = new CodexSessionService({
    platform: 'darwin',
    codexHome: '/Users/test/.codex',
    commandRunner: (command) => {
      observedCommand = command;
      return `${b64('/Users/test/project')}\t${b64('/Users/test/project')}\t${b64('main')}`;
    }
  });

  const contexts = await service.resolveRepoContexts(['/Users/test/project']);
  assert.equal(contexts.get('/Users/test/project').groupKey, '/Users/test/project');
  assert.doesNotMatch(observedCommand, /base64 -w0/);
  assert.match(observedCommand, /base64 \| tr -d/);
});

test('batch thread lookup scans index and rollout history only once', async () => {
  let indexScans = 0;
  let rolloutScans = 0;
  const baseRunner = makeCatalogRunner();
  const service = new CodexSessionService({
    platform: 'linux',
    codexHome: '/home/test/.codex',
    commandRunner: (command) => {
      if (command.includes('session_index.jsonl')) indexScans += 1;
      if (command.includes('modifiedAtMs')) rolloutScans += 1;
      return baseRunner(command);
    }
  });

  const threads = await service.getThreadsByIds([IDS.first, IDS.second]);
  assert.deepEqual([...threads.keys()], [IDS.first, IDS.second]);
  assert.equal(indexScans, 1);
  assert.equal(rolloutScans, 1);
});

test('expired history is served stale while one background refresh is shared', async () => {
  let now = 0;
  let indexScans = 0;
  let rolloutScans = 0;
  const baseRunner = makeCatalogRunner();
  const service = new CodexSessionService({
    platform: 'linux',
    codexHome: '/home/test/.codex',
    historyCacheTtlMs: 100,
    clock: () => now,
    commandRunner: async (command) => {
      if (command.includes('session_index.jsonl')) indexScans += 1;
      if (command.includes('modifiedAtMs')) rolloutScans += 1;
      await new Promise((resolve) => setTimeout(resolve, 5));
      return baseRunner(command);
    }
  });

  const fresh = await service.getHistorySnapshot();
  assert.equal(fresh.stale, false);
  now = 200;
  const [firstStale, secondStale] = await Promise.all([
    service.getHistorySnapshot({ allowStale: true }),
    service.getHistorySnapshot({ allowStale: true })
  ]);
  assert.equal(firstStale.stale, true);
  assert.equal(secondStale.stale, true);
  await service.historyLoadPromise;
  assert.equal(indexScans, 2);
  assert.equal(rolloutScans, 2);
});

test('preview cache rereads only rollout files whose modification time changed', async () => {
  let previewReads = 0;
  const service = new CodexSessionService({
    platform: 'linux',
    commandRunner: (command) => {
      if (!command.includes('2097152')) return '';
      previewReads += 1;
      return `${IDS.first}\t${b64(`Preview ${previewReads}`)}`;
    }
  });
  const item = {
    id: IDS.first,
    filePath: `/home/test/rollout-${IDS.first}.jsonl`,
    modifiedAtMs: 100
  };

  assert.equal((await service.readPreviews([item])).get(IDS.first), 'Preview 1');
  assert.equal((await service.readPreviews([item])).get(IDS.first), 'Preview 1');
  assert.equal(previewReads, 1);
  assert.equal((await service.readPreviews([{ ...item, modifiedAtMs: 101 }])).get(IDS.first), 'Preview 2');
  assert.equal(previewReads, 2);
});

test('repository and process snapshots use their bounded caches', async () => {
  let now = 0;
  let contextReads = 0;
  let processReads = 0;
  const service = new CodexSessionService({
    platform: 'linux',
    contextCacheTtlMs: 100,
    processCacheTtlMs: 100,
    clock: () => now,
    commandRunner: (command) => {
      if (command.includes('git -C')) {
        contextReads += 1;
        return `${b64('/mnt/c/work/project-a')}\t${b64('/mnt/c/work/project-a')}\t${b64('main')}`;
      }
      if (command.includes('/proc') && command.includes('readlinkSync')) processReads += 1;
      return '';
    }
  });

  await service.resolveRepoContexts(['/mnt/c/work/project-a']);
  await service.resolveRepoContexts(['/mnt/c/work/project-a']);
  await service.getProcessSnapshot();
  await service.getProcessSnapshot();
  assert.equal(contextReads, 1);
  assert.equal(processReads, 1);

  now = 101;
  await service.resolveRepoContexts(['/mnt/c/work/project-a']);
  await service.getProcessSnapshot();
  assert.equal(contextReads, 2);
  assert.equal(processReads, 2);
});

test('identity monitor requires two stable scans before verification', async () => {
  let now = 0;
  const observations = [];
  const output = processRow(100, 'easycc-one', IDS.first, '/mnt/c/work/project-a');
  const service = new CodexSessionService({
    platform: 'linux',
    codexHome: '/home/test/.codex',
    clock: () => now,
    scanIntervalMs: 60_000,
    commandRunner: (command) => command.includes('/proc') && command.includes('readlinkSync') ? output : ''
  });
  const session = {
    id: 'easycc-one',
    cliType: 'codex',
    status: 'active',
    pty: {},
    codexSessionId: null
  };
  service.monitorHooks = {
    getSessions: () => new Map([[session.id, session]]),
    onObservation: (value) => observations.push(value)
  };
  await service.runMonitorScan();
  assert.equal(observations.some((item) => item.state === 'verified'), false);
  now = 600;
  await service.runMonitorScan();
  assert.equal(observations.some((item) => item.state === 'verified' && item.candidateId === IDS.first), true);
  service.stopMonitor();
});

test('Codex resume API validates selections and returns accepted work', async () => {
  const routes = new Map();
  const app = {
    get: (url, handler) => routes.set(`GET ${url}`, handler),
    post: (url, handler) => routes.set(`POST ${url}`, handler)
  };
  const sessionManager = {
    getCodexResumeCatalog: (query) => ({ query, threads: [] }),
    resumeCodexSelections: (selections) => ({ accepted: selections, skipped: [] })
  };
  registerCodexResumeRoutes(app, { sessionManager });

  const makeReply = () => ({
    statusCode: 200,
    payload: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    send(payload) {
      this.payload = payload;
      return payload;
    }
  });

  const catalog = await routes.get('GET /api/codex/resume-catalog')(
    { query: { groupKey: '/work/repo', refresh: '1' } },
    makeReply()
  );
  assert.equal(catalog.query.groupKey, '/work/repo');
  assert.equal(catalog.query.refresh, '1');

  const invalidReply = makeReply();
  await routes.get('POST /api/codex/resume-selection')({ body: { selections: [] } }, invalidReply);
  assert.equal(invalidReply.statusCode, 400);

  const acceptedReply = makeReply();
  await routes.get('POST /api/codex/resume-selection')({
    body: {
      historyRuntime: 'wsl',
      selections: [{ codexSessionId: IDS.first, easyccSessionId: 'easycc-one' }]
    }
  }, acceptedReply);
  assert.equal(acceptedReply.statusCode, 202);
  assert.deepEqual(acceptedReply.payload.accepted, [{ codexSessionId: IDS.first, easyccSessionId: 'easycc-one' }]);
});

test('card-scoped resume API binds the choice to the requested EasyCC card', async () => {
  const routes = new Map();
  let observedSelections = null;
  let observedOptions = null;
  const app = {
    get: (url, handler) => routes.set(`GET ${url}`, handler),
    post: (url, handler) => routes.set(`POST ${url}`, handler)
  };
  registerCodexResumeRoutes(app, {
    sessionManager: {
      resumeCodexSelections(selections, options) {
        observedSelections = selections;
        observedOptions = options;
        return { accepted: [{ id: 'easycc-target' }], skipped: [] };
      }
    }
  });
  const reply = {
    statusCode: 200,
    status(code) { this.statusCode = code; return this; },
    send(payload) { this.payload = payload; return payload; }
  };

  await routes.get('POST /api/codex/resume-selection')({
    body: {
      easyccSessionId: 'easycc-target',
      selections: [{ codexSessionId: IDS.first }]
    }
  }, reply);

  assert.equal(reply.statusCode, 202);
  assert.deepEqual(observedSelections, [{ codexSessionId: IDS.first, easyccSessionId: 'easycc-target' }]);
  assert.deepEqual(observedOptions, { targetEasyccSessionId: 'easycc-target' });
});

test('batch resume asks the service for all selected threads once', async () => {
  let batchLookups = 0;
  const manager = {
    sessions: new Map(),
    codexSessionService: {
      scanProcesses: async () => ({ roots: [], liveRootIds: new Set() }),
      getThreadsByIds: async (ids) => {
        batchLookups += 1;
        assert.deepEqual(ids, [IDS.first, IDS.second]);
        return new Map();
      }
    }
  };

  const result = await SessionManager.prototype.resumeCodexSelections.call(manager, [
    { codexSessionId: IDS.first },
    { codexSessionId: IDS.second }
  ], { historyRuntime: 'wsl' });
  assert.equal(batchLookups, 1);
  assert.deepEqual(result.accepted, []);
  assert.deepEqual(result.skipped.map((item) => item.code), ['not_found', 'not_found']);
});

test('card-scoped resume reuses the paused card and never creates a duplicate', async () => {
  const target = {
    id: 'easycc-target',
    name: 'Needs mapping',
    cliType: 'codex-windows',
    status: 'paused',
    workingDir: 'C:\\work\\project-a',
    groupKey: 'C:\\work\\project-a',
    codexSessionId: null
  };
  let created = false;
  const manager = {
    sessions: new Map([[target.id, target]]),
    codexSessionService: {
      scanProcesses: async () => ({ roots: [], liveRootIds: new Set() }),
      getProcessSnapshotForRuntime: async (runtime) => {
        assert.equal(runtime, 'windows');
        return { roots: [], liveRootIds: new Set() };
      },
      getThreadsByIds: async (ids, history, options) => {
        assert.equal(options.runtime, 'windows');
        return new Map([[IDS.first, {
        codexSessionId: IDS.first,
        threadName: 'Chosen conversation',
        workingDir: 'C:\\work\\project-a'
        }]]);
      }
    },
    dataStore: { saveSession() {} },
    createBoundCodexSession() { created = true; throw new Error('must not create a card'); },
    resumeSession(id) { this.sessions.get(id).status = 'active'; return true; },
    getSessionSnapshot: (session) => ({ id: session.id, status: session.status, codexSessionId: session.codexSessionId })
  };

  const result = await SessionManager.prototype.resumeCodexSelections.call(
    manager,
    [{ codexSessionId: IDS.first, easyccSessionId: target.id }],
    { targetEasyccSessionId: target.id }
  );

  assert.equal(created, false);
  assert.equal(manager.sessions.size, 1);
  assert.equal(target.codexSessionId, IDS.first);
  assert.equal(target.name, 'Chosen conversation');
  assert.equal(target.status, 'active');
  assert.deepEqual(result.accepted.map((item) => item.id), [target.id]);
});

test('missing Codex identity is never inferred from folder, title, transcript, or recency', () => {
  const session = {
    id: 'easycc-target',
    name: 'Only matching title',
    cliType: 'codex',
    workingDir: '/mnt/c/work/project-a',
    codexSessionId: null,
    outputBuffer: { getAll: () => [IDS.first] }
  };
  const linked = SessionManager.prototype.ensureCodexSessionLinked.call({}, session);
  assert.equal(linked, false);
  assert.equal(session.codexSessionId, null);
});

test('verified Codex thread switch updates the saved ID and EasyCC card name', () => {
  const saved = [];
  const emitted = [];
  const session = {
    id: 'easycc-one',
    name: 'Old thread name',
    cliType: 'codex',
    workingDir: '/mnt/c/work/project-a',
    codexSessionId: IDS.first,
    codexThreadName: 'Old thread name',
    currentTask: 'Old task'
  };
  const manager = {
    sessions: new Map([[session.id, session]]),
    dataStore: { saveSession: (value) => saved.push(value.id) },
    emit: (event, value) => emitted.push({ event, value }),
    getSessionSnapshot: (value) => ({ id: value.id, name: value.name, codexSessionId: value.codexSessionId }),
    codexSessionService: {
      loadIndex: () => new Map([[IDS.second, { threadName: 'Resumed conversation name' }]])
    }
  };

  const changed = SessionManager.prototype.applyCodexIdentityObservation.call(manager, {
    sessionId: session.id,
    state: 'verified',
    candidateId: IDS.second,
    workingDir: '/mnt/c/work/project-a',
    threadName: 'Resumed conversation name'
  });

  assert.equal(changed, true);
  assert.equal(session.codexSessionId, IDS.second);
  assert.equal(session.codexThreadName, 'Resumed conversation name');
  assert.equal(session.name, 'Resumed conversation name');
  assert.equal(session.currentTask, '');
  assert.equal(session.codexIdentityState, 'verified');
  assert.deepEqual(saved, ['easycc-one']);
  assert.equal(emitted.some(({ event }) => event === 'sessionUpdated'), true);

  const unchanged = SessionManager.prototype.applyCodexIdentityObservation.call(manager, {
    sessionId: session.id,
    state: 'verified',
    candidateId: IDS.second,
    workingDir: '/mnt/c/work/project-a',
    threadName: 'Resumed conversation name'
  });
  assert.equal(unchanged, false);
  assert.deepEqual(saved, ['easycc-one']);
});

test('Codex thread switch takes ownership from a paused card without killing the active PTY', () => {
  let killed = false;
  const active = {
    id: 'easycc-active',
    name: 'First card fallback',
    cliType: 'codex',
    status: 'active',
    pty: { kill: () => { killed = true; } },
    workingDir: '/mnt/c/work/project-a',
    codexSessionId: IDS.first,
    codexThreadName: null,
    currentTask: ''
  };
  const pausedOwner = {
    id: 'easycc-paused',
    name: 'Paused owner',
    cliType: 'codex',
    status: 'paused',
    pty: null,
    workingDir: '/mnt/c/work/project-a',
    codexSessionId: IDS.second,
    codexThreadName: 'Second thread'
  };
  const manager = {
    sessions: new Map([[active.id, active], [pausedOwner.id, pausedOwner]]),
    dataStore: { saveSession() {} },
    emit() {},
    getSessionSnapshot: (value) => ({ id: value.id, codexSessionId: value.codexSessionId }),
    codexSessionService: { loadIndex: () => new Map([[IDS.second, { threadName: 'Second thread' }]]) }
  };

  const changed = SessionManager.prototype.applyCodexIdentityObservation.call(manager, {
    sessionId: active.id,
    state: 'verified',
    candidateId: IDS.second,
    workingDir: active.workingDir,
    threadName: 'Second thread'
  });

  assert.equal(changed, true);
  assert.equal(killed, false);
  assert.equal(active.codexSessionId, IDS.second);
  assert.equal(active.name, 'Second thread');
  assert.equal(pausedOwner.codexSessionId, IDS.first);
  assert.equal(pausedOwner.codexThreadName, 'First card fallback');
  assert.equal(pausedOwner.name, 'First card fallback');
  assert.equal(pausedOwner.codexIdentityState, 'unverified');
});

test('Codex bootstrap exports a configured WSL Codex home', () => {
  const script = SessionManager.prototype.buildCodexBootstrapScript.call({
    quoteForPosixShell: SessionManager.prototype.quoteForPosixShell,
    codexSessionService: { resolveShellCodexHome: () => '/srv/custom-codex' }
  }, '/mnt/c/work/project-a', { easyccSessionId: 'easycc-one' });

  assert.match(script, /export CODEX_HOME='\/srv\/custom-codex'/);
});

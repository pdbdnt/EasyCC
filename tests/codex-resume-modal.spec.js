const { test, expect } = require('@playwright/test');

const BASE_URL = process.env.CM_BASE_URL || 'http://localhost:5010';
const THREAD_ID = '019f4a56-26a5-7440-bbc6-54b00447d986';

test.beforeEach(async ({ page }) => {
  await page.route('**/api/settings', (route) => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({ settings: { session: { startupRecoveryMode: 'ask' } } })
  }));
});

function catalogFixture() {
  return {
    savedSessions: [{
      easyccSessionId: 'easycc-paused-one',
      name: 'Saved exact thread',
      workingDir: '/mnt/c/work/easycc',
      codexSessionId: THREAD_ID,
      mappingState: 'exact',
      selectedByDefault: true
    }],
    threads: [{
      codexSessionId: THREAD_ID,
      threadName: 'Fix session recovery',
      workingDir: '/mnt/c/work/easycc',
      lastActivity: '2026-07-10T06:30:00.000Z',
      preview: 'Continue implementing exact Codex resume recovery.',
      groupKey: '/mnt/c/work/easycc',
      linkedEasyccSessionId: 'easycc-paused-one',
      live: false,
      selectable: true,
      disabledReason: null
    }],
    page: {
      dates: ['2026-07-10'],
      nextCursor: null,
      hasOlder: false
    }
  };
}

async function mockRecoverySummary(page, { candidate = true } = {}) {
  await page.route('**/api/sessions/recovery-summary', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(candidate ? {
        sessions: [{
          id: 'easycc-paused-one',
          name: 'Saved exact thread',
          cliType: 'codex',
          workingDir: '/mnt/c/work/easycc',
          groupKey: '/mnt/c/work/easycc',
          category: 'launchable',
          code: 'exact'
        }],
        totals: { candidateTotal: 1, launchableTotal: 1, requiresSelectionTotal: 0, disabledTotal: 0, projectTotal: 1 }
      } : {
        sessions: [],
        totals: { candidateTotal: 0, launchableTotal: 0, requiresSelectionTotal: 0, disabledTotal: 0, projectTotal: 0 }
      })
    });
  });
}

async function mockDashboardSocket(page, sessions) {
  await page.addInitScript((initialSessions) => {
    class MockWebSocket {
      static CONNECTING = 0;
      static OPEN = 1;
      static CLOSING = 2;
      static CLOSED = 3;

      constructor() {
        this.readyState = MockWebSocket.CONNECTING;
        setTimeout(() => {
          this.readyState = MockWebSocket.OPEN;
          this.onopen?.();
          this.onmessage?.({
            data: JSON.stringify({ type: 'init', sessions: initialSessions, agents: [], tasks: [] })
          });
        }, 0);
      }

      send() {}
      close() { this.readyState = MockWebSocket.CLOSED; }
    }

    window.WebSocket = MockWebSocket;
  }, sessions);
}

test('paused recovery choice selects and submits the exact saved Codex thread', async ({ page }) => {
  let submittedBody = null;
  await mockRecoverySummary(page);
  await page.route('**/api/codex/resume-catalog?**', async (route) => {
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(catalogFixture()) });
  });
  await page.route('**/api/codex/resume-selection', async (route) => {
    submittedBody = route.request().postDataJSON();
    await route.fulfill({
      status: 202,
      contentType: 'application/json',
      body: JSON.stringify({ accepted: [{ id: 'easycc-paused-one' }], skipped: [] })
    });
  });

  await page.goto(BASE_URL, { waitUntil: 'domcontentloaded' });
  await page.getByRole('dialog', { name: 'Previous workspace found' })
    .getByRole('button', { name: 'Restore paused and choose Codex' }).click();
  const dialog = page.getByRole('dialog', { name: 'Resume exact conversations' });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByText('Saved exact thread')).toBeVisible();
  await expect(dialog.getByText('Continue implementing exact Codex resume recovery.')).toBeVisible();
  await expect(dialog.getByRole('checkbox').first()).toBeChecked();

  await dialog.getByRole('button', { name: 'Resume 1' }).click();
  await expect(dialog).toBeHidden();
  expect(submittedBody).toEqual({
    selections: [{ easyccSessionId: 'easycc-paused-one', codexSessionId: THREAD_ID }]
  });
});

test('History action opens the exact-thread chooser and search stays server-backed', async ({ page }) => {
  const requestedQueries = [];
  await mockRecoverySummary(page, { candidate: false });
  await page.route('**/api/codex/resume-catalog?**', async (route) => {
    requestedQueries.push(new URL(route.request().url()).searchParams.get('query') || '');
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(catalogFixture()) });
  });

  await page.goto(BASE_URL, { waitUntil: 'domcontentloaded' });
  await page.getByRole('button', { name: 'History' }).click();

  const dialog = page.getByRole('dialog', { name: 'Resume exact conversations' });
  await dialog.getByRole('textbox', { name: 'Search Codex history' }).fill('recovery');
  await dialog.getByRole('button', { name: 'Search' }).click();
  await expect.poll(() => requestedQueries).toContain('recovery');
  await expect(dialog.getByText('Fix session recovery')).toBeVisible();
});

test('global History switches between WSL and Windows conversation storage', async ({ page }) => {
  await mockRecoverySummary(page, { candidate: false });
  const requestedRuntimes = [];
  let submittedBody = null;
  await page.route('**/api/codex/resume-catalog?**', async (route) => {
    const historyRuntime = new URL(route.request().url()).searchParams.get('historyRuntime');
    requestedRuntimes.push(historyRuntime);
    const windows = historyRuntime === 'windows';
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        savedSessions: [],
        threads: [{
          ...catalogFixture().threads[0],
          threadName: windows ? 'Native Windows conversation' : 'WSL conversation',
          workingDir: windows ? 'C:\\Users\\denni\\apps\\EasyCC' : '/mnt/c/Users/denni/apps/EasyCC',
          groupKey: windows ? 'C:\\Users\\denni\\apps\\EasyCC' : '/mnt/c/Users/denni/apps/EasyCC',
          linkedEasyccSessionId: null
        }],
        groups: [],
        page: { dates: ['2026-07-10'], nextCursor: null, hasOlder: false },
        cache: {
          historyStale: false,
          generatedAt: '2026-07-10T07:00:00.000Z',
          diagnostics: { runtime: historyRuntime }
        }
      })
    });
  });
  await page.route('**/api/codex/resume-selection', async (route) => {
    submittedBody = route.request().postDataJSON();
    await route.fulfill({
      status: 202,
      contentType: 'application/json',
      body: JSON.stringify({ accepted: [{ id: 'new-windows-session' }], skipped: [] })
    });
  });

  await page.goto(BASE_URL, { waitUntil: 'domcontentloaded' });
  await page.getByRole('button', { name: 'History' }).click();

  const dialog = page.getByRole('dialog', { name: 'Resume exact conversations' });
  const source = dialog.getByRole('combobox', { name: 'Scan Codex history from' });
  await expect(source).toHaveValue('wsl');
  await expect(dialog.getByText('WSL conversation')).toBeVisible();

  await source.selectOption('windows');
  await expect.poll(() => requestedRuntimes).toContain('windows');
  await expect(dialog.getByText('Native Windows conversation')).toBeVisible();
  await dialog.getByRole('checkbox', { name: /Native Windows conversation/ }).check();
  await dialog.getByRole('button', { name: 'Resume 1' }).click();

  await expect.poll(() => submittedBody?.historyRuntime).toBe('windows');
});

test('global History selects visible conversations and clears selections retained across pages', async ({ page }) => {
  const SECOND_ID = '019f49d3-a29a-72e1-9c67-d7046b6f8a40';
  const THIRD_ID = '019f4972-2155-7d33-9755-3beb3589323e';
  await mockRecoverySummary(page, { candidate: false });
  await page.route('**/api/codex/resume-catalog?**', async (route) => {
    const params = new URL(route.request().url()).searchParams;
    const older = !!params.get('cursor');
    const threads = older ? [{
      codexSessionId: THIRD_ID,
      threadName: 'Older available conversation',
      workingDir: '/mnt/c/work/easycc',
      lastActivity: '2026-07-08T06:30:00.000Z',
      preview: '',
      groupKey: '/mnt/c/work/easycc',
      linkedEasyccSessionId: null,
      live: false,
      selectable: true,
      disabledReason: null
    }] : [{
      ...catalogFixture().threads[0],
      linkedEasyccSessionId: null
    }, {
      ...catalogFixture().threads[0],
      codexSessionId: SECOND_ID,
      threadName: 'Second available conversation',
      linkedEasyccSessionId: null
    }, {
      ...catalogFixture().threads[0],
      codexSessionId: THIRD_ID,
      threadName: 'Already live conversation',
      linkedEasyccSessionId: null,
      live: true,
      selectable: false,
      disabledReason: 'Already open outside EasyCC'
    }];
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        savedSessions: [],
        threads,
        page: older
          ? { dates: ['2026-07-08'], nextCursor: null, hasOlder: false }
          : { dates: ['2026-07-10'], nextCursor: 'older-page', hasOlder: true },
        cache: { historyStale: false, generatedAt: '2026-07-10T07:00:00.000Z' }
      })
    });
  });

  await page.goto(BASE_URL, { waitUntil: 'domcontentloaded' });
  await page.getByRole('button', { name: 'History' }).click();
  const dialog = page.getByRole('dialog', { name: 'Resume exact conversations' });
  await dialog.getByRole('button', { name: 'Select visible' }).click();
  await expect(dialog.getByText('2 selected')).toBeVisible();
  await expect(dialog.getByRole('checkbox', { name: /Already live conversation/ })).not.toBeChecked();

  await dialog.getByRole('button', { name: 'Next' }).click();
  await expect(dialog.getByText('Older available conversation')).toBeVisible();
  await dialog.getByRole('button', { name: 'Select visible' }).click();
  await expect(dialog.getByText('3 selected')).toBeVisible();

  await dialog.getByRole('button', { name: 'Unselect all' }).click();
  await expect(dialog.getByText('0 selected')).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'Resume', exact: true })).toBeDisabled();
  await expect(dialog.getByRole('button', { name: 'Unselect all' })).toHaveCount(0);
});

test('Select visible stops at the 100-conversation API limit', async ({ page }) => {
  await mockRecoverySummary(page, { candidate: false });
  const threads = Array.from({ length: 101 }, (_, index) => ({
    codexSessionId: `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
    threadName: `Available conversation ${index + 1}`,
    workingDir: '/mnt/c/work/easycc',
    lastActivity: '2026-07-10T06:30:00.000Z',
    preview: '',
    groupKey: '/mnt/c/work/easycc',
    linkedEasyccSessionId: null,
    live: false,
    selectable: true,
    disabledReason: null
  }));
  await page.route('**/api/codex/resume-catalog?**', (route) => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({
      savedSessions: [],
      threads,
      page: { dates: ['2026-07-10'], nextCursor: null, hasOlder: false },
      cache: { historyStale: false, generatedAt: '2026-07-10T07:00:00.000Z' }
    })
  }));

  await page.goto(BASE_URL, { waitUntil: 'domcontentloaded' });
  await page.getByRole('button', { name: 'History' }).click();
  const dialog = page.getByRole('dialog', { name: 'Resume exact conversations' });
  await dialog.getByRole('button', { name: 'Select visible' }).click();

  await expect(dialog.getByText('100 selected')).toBeVisible();
  await expect(dialog.getByText('A maximum of 100 conversations can be selected.')).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'Select visible' })).toBeDisabled();
});

test('reopening History renders cached conversations while stale history refreshes', async ({ page }) => {
  await mockRecoverySummary(page, { candidate: false });
  let normalRequests = 0;
  await page.route('**/api/codex/resume-catalog?**', async (route) => {
    const params = new URL(route.request().url()).searchParams;
    const fixture = catalogFixture();
    fixture.savedSessions = [];
    if (params.get('refresh') === '1') {
      fixture.threads[0].threadName = 'Fresh conversation title';
      fixture.cache = { historyStale: false, generatedAt: '2026-07-10T07:02:00.000Z' };
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(fixture) });
      return;
    }
    normalRequests += 1;
    if (normalRequests > 1) await new Promise((resolve) => setTimeout(resolve, 250));
    fixture.cache = {
      historyStale: normalRequests > 1,
      generatedAt: '2026-07-10T07:00:00.000Z'
    };
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(fixture) });
  });

  await page.goto(BASE_URL, { waitUntil: 'domcontentloaded' });
  await page.getByRole('button', { name: 'History' }).click();
  let dialog = page.getByRole('dialog', { name: 'Resume exact conversations' });
  await expect(dialog.getByText('Fix session recovery')).toBeVisible();
  await dialog.getByRole('button', { name: 'Close resume dialog' }).click();

  await page.getByRole('button', { name: 'History' }).click();
  dialog = page.getByRole('dialog', { name: 'Resume exact conversations' });
  await expect(dialog.getByText('Fix session recovery')).toBeVisible();
  await expect(dialog.getByText('Refreshing…')).toBeVisible();
  await expect(dialog.getByText('Fresh conversation title')).toBeVisible();
  await expect(dialog.getByText('Refreshing…')).toBeHidden();
});

test('History groups by folder, applies independent sorts, and keeps UUID selections', async ({ page }) => {
  await mockRecoverySummary(page, { candidate: false });
  const requests = [];
  const rows = [
    {
      codexSessionId: THREAD_ID,
      threadName: 'Zulu newer',
      workingDir: '/home/denni/apps/specsket',
      groupKey: '/home/denni/apps/specsket',
      createdAt: '2026-07-09T06:30:00.000Z',
      lastActivity: '2026-07-12T06:30:00.000Z',
      preview: '', linkedEasyccSessionId: null, live: false, selectable: true, disabledReason: null
    },
    {
      codexSessionId: '019f49d3-a29a-72e1-9c67-d7046b6f8a40',
      threadName: 'Alpha older',
      workingDir: '/home/denni/apps/specsket',
      groupKey: '/home/denni/apps/specsket',
      createdAt: '2026-07-08T06:30:00.000Z',
      lastActivity: '2026-07-10T06:30:00.000Z',
      preview: '', linkedEasyccSessionId: null, live: false, selectable: true, disabledReason: null
    },
    {
      codexSessionId: '019f4972-2155-7d33-9755-3beb3589323e',
      threadName: 'CLQ conversation',
      workingDir: '/home/denni/apps/CLQ-agentic',
      groupKey: '/home/denni/apps/CLQ-agentic',
      createdAt: '2026-07-07T06:30:00.000Z',
      lastActivity: '2026-07-11T06:30:00.000Z',
      preview: '', linkedEasyccSessionId: null, live: false, selectable: true, disabledReason: null
    }
  ];
  await page.route('**/api/codex/resume-catalog?**', async (route) => {
    const params = new URL(route.request().url()).searchParams;
    const groupSort = params.get('groupSort') || 'recent';
    const threadSort = params.get('threadSort') || 'updated-desc';
    requests.push({ groupSort, threadSort, groupBy: params.get('groupBy') });
    const specsketRows = rows.slice(0, 2).sort((left, right) => threadSort === 'title-asc'
      ? left.threadName.localeCompare(right.threadName)
      : Date.parse(right.lastActivity) - Date.parse(left.lastActivity));
    const orderedGroups = groupSort === 'folder-asc'
      ? [
          { key: '/home/denni/apps/CLQ-agentic', name: 'CLQ-agentic', path: '/home/denni/apps/CLQ-agentic', count: 1, selectableCount: 1, lastActivity: rows[2].lastActivity, selectableSelections: [{ codexSessionId: rows[2].codexSessionId }] },
          { key: '/home/denni/apps/specsket', name: 'specsket', path: '/home/denni/apps/specsket', count: 2, selectableCount: 2, lastActivity: rows[0].lastActivity, selectableSelections: specsketRows.map(({ codexSessionId }) => ({ codexSessionId })) }
        ]
      : [
          { key: '/home/denni/apps/specsket', name: 'specsket', path: '/home/denni/apps/specsket', count: 2, selectableCount: 2, lastActivity: rows[0].lastActivity, selectableSelections: specsketRows.map(({ codexSessionId }) => ({ codexSessionId })) },
          { key: '/home/denni/apps/CLQ-agentic', name: 'CLQ-agentic', path: '/home/denni/apps/CLQ-agentic', count: 1, selectableCount: 1, lastActivity: rows[2].lastActivity, selectableSelections: [{ codexSessionId: rows[2].codexSessionId }] }
        ];
    const threads = orderedGroups.flatMap((group) => group.key.includes('specsket') ? specsketRows : [rows[2]]);
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        savedSessions: [], threads, groups: orderedGroups,
        sort: { groupBy: 'folder', groupSort, threadSort },
        page: { dates: ['2026-07-12'], nextCursor: null, hasOlder: false, total: 3 },
        cache: { historyStale: false, generatedAt: '2026-07-12T07:00:00.000Z' }
      })
    });
  });

  await page.goto(BASE_URL, { waitUntil: 'domcontentloaded' });
  await page.getByRole('button', { name: 'History' }).click();
  const dialog = page.getByRole('dialog', { name: 'Resume exact conversations' });
  const specsketGroup = dialog.getByRole('region', { name: 'specsket conversations' });
  await specsketGroup.getByRole('button', { name: 'Select folder' }).click();
  await expect(dialog.getByText('2 selected', { exact: true })).toBeVisible();
  await specsketGroup.getByRole('button', { name: 'Unselect folder' }).click();
  const zulu = dialog.getByRole('checkbox', { name: /Zulu newer/ });
  await zulu.check();
  await dialog.getByRole('combobox', { name: 'Sort folder groups' }).selectOption('folder-asc');
  await expect.poll(() => requests.at(-1)?.groupSort).toBe('folder-asc');
  await expect(dialog.getByRole('region', { name: /conversations$/ }).first()).toHaveAttribute('aria-label', 'CLQ-agentic conversations');
  await expect(zulu).toBeChecked();

  await dialog.getByRole('combobox', { name: 'Sort conversations' }).selectOption('title-asc');
  await expect.poll(() => requests.at(-1)?.threadSort).toBe('title-asc');
  const specsket = dialog.getByRole('region', { name: 'specsket conversations' });
  await expect(specsket.getByRole('checkbox')).toHaveCount(2);
  await expect(specsket.getByRole('checkbox').first()).toHaveAccessibleName(/Alpha older/);
  await expect(zulu).toBeChecked();

  await dialog.getByRole('combobox', { name: 'Group conversations by' }).selectOption('none');
  await expect.poll(() => requests.at(-1)?.groupBy).toBe('none');
  await expect(dialog.getByRole('combobox', { name: 'Sort folder groups' })).toBeDisabled();
  await expect(zulu).toBeChecked();
});

test('unresolved cards cannot choose a thread owned by another paused card', async ({ page }) => {
  await mockRecoverySummary(page);
  const fixture = catalogFixture();
  fixture.savedSessions = [{
    easyccSessionId: 'easycc-unresolved',
    name: 'Needs mapping',
    workingDir: '/mnt/c/work/easycc',
    codexSessionId: null,
    mappingState: 'unresolved',
    selectedByDefault: false
  }];
  fixture.threads = [
    {
      ...fixture.threads[0],
      threadName: 'Owned by another card',
      linkedEasyccSessionId: 'easycc-other-paused'
    },
    {
      ...fixture.threads[0],
      codexSessionId: '019f49d3-a29a-72e1-9c67-d7046b6f8a40',
      threadName: 'Available conversation',
      linkedEasyccSessionId: null
    }
  ];
  await page.route('**/api/codex/resume-catalog?**', async (route) => {
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(fixture) });
  });

  await page.goto(BASE_URL, { waitUntil: 'domcontentloaded' });
  await page.getByRole('dialog', { name: 'Previous workspace found' })
    .getByRole('button', { name: 'Restore paused and choose Codex' }).click();
  const dialog = page.getByRole('dialog', { name: 'Resume exact conversations' });
  const mappingSelect = dialog.getByRole('combobox', { name: 'Choose a Codex conversation for Needs mapping' });

  await expect(mappingSelect.getByRole('option', { name: 'Owned by another card' })).toHaveCount(0);
  await expect(mappingSelect.getByRole('option', { name: 'Available conversation' })).toHaveCount(1);
  await mappingSelect.selectOption({ label: 'Available conversation' });
  await expect(mappingSelect).toHaveValue('019f49d3-a29a-72e1-9c67-d7046b6f8a40');
});

test('card Resume scopes history and binds the chosen conversation to the same paused card', async ({ page }) => {
  const target = {
    id: 'easycc-target',
    name: 'resumepicker',
    cliType: 'codex',
    status: 'paused',
    workingDir: '/mnt/c/Users/denni/apps/EasyCC',
    groupKey: 'C:\\Users\\denni\\apps\\EasyCC',
    repoName: 'EasyCC',
    codexSessionId: null,
    stage: 'todo',
    createdAt: '2026-07-12T13:27:36.853Z',
    lastActivity: '2026-07-12T15:33:58.973Z'
  };
  await mockDashboardSocket(page, [target]);
  await mockRecoverySummary(page, { candidate: false });

  let catalogParams = null;
  let submittedBody = null;
  let rawResumeCalled = false;
  await page.route('**/api/codex/resume-catalog?**', async (route) => {
    catalogParams = new URL(route.request().url()).searchParams;
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        savedSessions: [{
          easyccSessionId: target.id,
          name: target.name,
          workingDir: target.workingDir,
          codexSessionId: null,
          mappingState: 'unresolved',
          selectedByDefault: false
        }],
        threads: [{
          codexSessionId: THREAD_ID,
          threadName: 'resumepicker',
          workingDir: target.workingDir,
          lastActivity: '2026-07-12T16:26:21.894Z',
          preview: 'Continue the EasyCC recovery work.',
          groupKey: target.workingDir,
          linkedEasyccSessionId: null,
          live: false,
          selectable: true,
          disabledReason: null
        }],
        page: { dates: ['2026-07-12'], nextCursor: null, hasOlder: false }
      })
    });
  });
  await page.route('**/api/sessions/easycc-target/resume', async (route) => {
    rawResumeCalled = true;
    await route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: 'should not be called' }) });
  });
  await page.route('**/api/codex/resume-selection', async (route) => {
    submittedBody = route.request().postDataJSON();
    await route.fulfill({
      status: 202,
      contentType: 'application/json',
      body: JSON.stringify({ accepted: [{ id: target.id }], skipped: [] })
    });
  });

  await page.goto(BASE_URL, { waitUntil: 'domcontentloaded' });
  await page.getByRole('button', { name: 'Resume', exact: true }).click();

  const dialog = page.getByRole('dialog', { name: 'Resume exact conversations' });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByText('Choose the saved threads that should return in EasyCC.')).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'Select visible' })).toHaveCount(0);
  expect(catalogParams.get('easyccSessionId')).toBe(target.id);
  expect(catalogParams.get('groupKey')).toBe(target.groupKey);
  expect(rawResumeCalled).toBe(false);

  await dialog.getByRole('checkbox').click();
  await expect(dialog.getByRole('button', { name: 'Unselect all' })).toBeVisible();
  await dialog.getByRole('button', { name: 'Unselect all' }).click();
  await expect(dialog.getByText('0 selected')).toBeVisible();
  await dialog.getByRole('checkbox').click();
  await dialog.getByRole('button', { name: 'Resume 1' }).click();
  await expect(dialog).toBeHidden();
  expect(submittedBody).toEqual({
    easyccSessionId: target.id,
    selections: [{ easyccSessionId: target.id, codexSessionId: THREAD_ID }]
  });
});

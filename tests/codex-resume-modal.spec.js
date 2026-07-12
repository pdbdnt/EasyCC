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

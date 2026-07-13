const { test, expect } = require('@playwright/test');

const BASE_URL = process.env.CM_BASE_URL || 'http://localhost:5010';

test.beforeEach(async ({ page }) => {
  await page.route('**/api/settings', (route) => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({ settings: { session: { startupRecoveryMode: 'ask' } } })
  }));
});

function recoveryFixture() {
  return {
    sessions: [
      {
        id: 'codex-one',
        name: 'Fix startup recovery',
        cliType: 'codex',
        workingDir: '/mnt/c/work/easycc',
        groupKey: '/mnt/c/work/easycc',
        projectName: 'EasyCC',
        category: 'launchable',
        code: 'exact',
        message: null
      },
      {
        id: 'terminal-one',
        name: 'Project terminal',
        cliType: 'terminal',
        workingDir: 'C:/work/tools',
        groupKey: 'C:/work/tools',
        projectName: 'Tools',
        category: 'launchable',
        code: 'fresh_shell',
        message: 'Starts a fresh shell'
      },
      {
        id: 'codex-unresolved',
        name: 'Needs conversation',
        cliType: 'codex',
        workingDir: '/mnt/c/work/easycc',
        groupKey: '/mnt/c/work/easycc',
        projectName: 'EasyCC',
        category: 'requiresSelection',
        code: 'requires_selection',
        message: 'Choose an exact Codex conversation'
      }
    ],
    totals: {
      candidateTotal: 3,
      launchableTotal: 2,
      requiresSelectionTotal: 1,
      disabledTotal: 0,
      projectTotal: 2
    }
  };
}

test('ask mode shows recovery summary and starts only launchable sessions', async ({ page }) => {
  let submitted = null;
  await page.route('**/api/sessions/recovery-summary', (route) => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify(recoveryFixture())
  }));
  await page.route('**/api/sessions/recover', async (route) => {
    submitted = route.request().postDataJSON();
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        launchStarted: [{ id: 'codex-one' }, { id: 'terminal-one' }],
        skipped: [],
        requiresSelection: [{ id: 'codex-unresolved' }]
      })
    });
  });
  await page.route('**/api/codex/resume-catalog?**', (route) => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({ savedSessions: [], threads: [], page: { dates: [], nextCursor: null, hasOlder: false } })
  }));

  await page.goto(BASE_URL, { waitUntil: 'domcontentloaded' });
  const dialog = page.getByRole('dialog', { name: 'Previous workspace found' });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByText('Fix startup recovery')).toBeVisible();
  await expect(dialog.getByText('2 ready')).toBeVisible();
  await expect(dialog.getByText('1 need selection')).toBeVisible();
  const easyccGroup = dialog.getByRole('group', { name: 'EasyCC — /mnt/c/work/easycc' });
  const toolsGroup = dialog.getByRole('group', { name: 'Tools — C:/work/tools' });
  await expect(easyccGroup.getByText('Fix startup recovery')).toBeVisible();
  await expect(easyccGroup.getByText('Needs conversation')).toBeVisible();
  await expect(toolsGroup.getByText('Project terminal')).toBeVisible();

  const restartCheckboxes = dialog.getByRole('checkbox', { name: /Restart/ });
  await expect(restartCheckboxes).toHaveCount(3);
  await expect(dialog.getByRole('checkbox', { name: 'Restart Fix startup recovery' })).toBeChecked();
  await expect(dialog.getByRole('checkbox', { name: 'Restart Project terminal' })).toBeChecked();
  await expect(dialog.getByRole('checkbox', { name: 'Restart Needs conversation' })).toBeDisabled();
  await easyccGroup.getByRole('button', { name: 'Unselect project' }).click();
  await expect(dialog.getByRole('checkbox', { name: 'Restart Fix startup recovery' })).not.toBeChecked();
  await expect(dialog.getByRole('checkbox', { name: 'Restart Project terminal' })).toBeChecked();
  await easyccGroup.getByRole('button', { name: 'Select project' }).click();
  await dialog.getByRole('button', { name: 'Unselect all' }).click();
  await expect(dialog.getByRole('button', { name: 'Restart selected sessions (0)' })).toBeDisabled();
  await dialog.getByRole('button', { name: 'Select all' }).click();

  await dialog.getByRole('button', { name: 'Restart selected sessions (2)' }).click();
  await expect(dialog).toBeHidden();
  expect(submitted).toEqual({ sessionIds: ['codex-one', 'terminal-one'] });
  await expect(page.getByRole('dialog', { name: 'Resume exact conversations' })).toBeVisible();
});

test('restore paused opens Codex picker without starting sessions', async ({ page }) => {
  let recoverCalls = 0;
  await page.route('**/api/sessions/recovery-summary', (route) => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify(recoveryFixture())
  }));
  await page.route('**/api/sessions/recover', (route) => {
    recoverCalls += 1;
    return route.abort();
  });
  await page.route('**/api/codex/resume-catalog?**', (route) => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({ savedSessions: [], threads: [], page: { dates: [], nextCursor: null, hasOlder: false } })
  }));

  await page.goto(BASE_URL, { waitUntil: 'domcontentloaded' });
  await page.getByRole('dialog', { name: 'Previous workspace found' })
    .getByRole('button', { name: 'Restore paused and choose Codex' }).click();

  await expect(page.getByRole('dialog', { name: 'Resume exact conversations' })).toBeVisible();
  expect(recoverCalls).toBe(0);
});

test('closing recovery dialog leaves sessions paused and performs no launch', async ({ page }) => {
  let recoverCalls = 0;
  await page.route('**/api/sessions/recovery-summary', (route) => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify(recoveryFixture())
  }));
  await page.route('**/api/sessions/recover', (route) => {
    recoverCalls += 1;
    return route.abort();
  });

  await page.goto(BASE_URL, { waitUntil: 'domcontentloaded' });
  const dialog = page.getByRole('dialog', { name: 'Previous workspace found' });
  await dialog.getByRole('button', { name: 'Close recovery dialog' }).click();
  await expect(dialog).toBeHidden();
  expect(recoverCalls).toBe(0);
});

test('remembered auto-resume stays silent while summary loads', async ({ page }) => {
  let recoverCalls = 0;
  await page.route('**/api/settings', (route) => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({ settings: { session: { startupRecoveryMode: 'auto-resume' } } })
  }));
  await page.route('**/api/sessions/recovery-summary', async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 250));
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(recoveryFixture()) });
  });
  await page.route('**/api/sessions/recover', async (route) => {
    recoverCalls += 1;
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ launchStarted: [{ id: 'codex-one' }, { id: 'terminal-one' }], skipped: [], requiresSelection: [] })
    });
  });
  await page.route('**/api/codex/resume-catalog?**', (route) => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({ savedSessions: [], threads: [], page: { dates: [], nextCursor: null, hasOlder: false } })
  }));

  await page.goto(BASE_URL, { waitUntil: 'domcontentloaded' });
  await expect(page.getByRole('dialog', { name: 'Previous workspace found' })).toHaveCount(0);
  await expect.poll(() => recoverCalls).toBe(1);
});

const { test, expect } = require('@playwright/test');

const BASE_URL = process.env.CM_BASE_URL || 'http://localhost:5010';

test.describe('New session folder browser', () => {
  test('loads the initial folder list with one request', async ({ page }) => {
    let folderRequests = 0;

    await page.addInitScript(() => {
      window.localStorage.setItem('easycc:lastCliType', 'claude');
    });

    await page.route('**/api/sessions/recovery-summary', (route) => route.fulfill({
      json: {
        sessions: [],
        totals: { candidateTotal: 0, launchableTotal: 0, requiresSelectionTotal: 0, disabledTotal: 0, projectTotal: 0 }
      }
    }));

    await page.route('**/api/folders**', async (route) => {
      folderRequests += 1;
      const url = new URL(route.request().url());
      const base = url.searchParams.get('base') || 'C:\\Users\\testuser\\apps';

      await route.fulfill({
        json: {
          folders: ['EasyCC', 'Specsket'],
          base,
          root: 'C:\\Users\\testuser',
          rootId: 'windows',
          roots: [
            { id: 'windows', label: 'Windows', path: 'C:\\Users\\testuser' },
            { id: 'wsl', label: 'WSL', path: '\\\\wsl$\\Ubuntu\\home\\testuser\\apps' }
          ],
          defaultRoot: 'C:\\Users\\testuser'
        }
      });
    });

    await page.goto(BASE_URL, { waitUntil: 'domcontentloaded' });
    await page.getByRole('button', { name: '+ New' }).click();
    const dialog = page.getByRole('dialog', { name: 'New Session' });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByText('EasyCC', { exact: true })).toBeVisible();
    await expect.poll(() => folderRequests).toBe(1);

    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
  });

  test('keeps browse sources available after a folder request fails', async ({ page }) => {
    await page.addInitScript(() => {
      window.localStorage.setItem('easycc:lastCliType', 'codex');
    });

    await page.route('**/api/sessions/recovery-summary', (route) => route.fulfill({
      json: {
        sessions: [],
        totals: { candidateTotal: 0, launchableTotal: 0, requiresSelectionTotal: 0, disabledTotal: 0, projectTotal: 0 }
      }
    }));

    await page.route('**/api/folders**', async (route) => {
      const url = new URL(route.request().url());
      const roots = [
        { id: 'windows', label: 'Windows', path: 'C:\\Users\\testuser' },
        { id: 'wsl', label: 'WSL', path: '\\\\wsl$\\Ubuntu\\home\\missing\\apps' }
      ];

      if (url.searchParams.get('rootId') === 'wsl') {
        await route.fulfill({
          status: 400,
          json: {
            error: 'Requested path is not a directory',
            roots,
            root: roots[1].path,
            defaultRoot: roots[0].path
          }
        });
        return;
      }

      await route.fulfill({
        json: {
          folders: ['EasyCC'],
          base: roots[0].path,
          root: roots[0].path,
          rootId: 'windows',
          roots,
          defaultRoot: roots[0].path
        }
      });
    });

    await page.goto(BASE_URL, { waitUntil: 'domcontentloaded' });
    await page.getByRole('button', { name: '+ New' }).click();
    const dialog = page.getByRole('dialog', { name: 'New Session' });

    await expect(dialog.getByText('Requested path is not a directory')).toBeVisible();
    await dialog.getByRole('button', { name: 'Windows' }).click();
    await expect(dialog.getByText('EasyCC', { exact: true })).toBeVisible();
  });

  test('sorts folder metadata by last activity, modified date, and name', async ({ page }) => {
    await page.addInitScript(() => {
      window.localStorage.setItem('easycc:lastCliType', 'claude');
    });

    await page.route('**/api/sessions/recovery-summary', (route) => route.fulfill({
      json: {
        sessions: [],
        totals: { candidateTotal: 0, launchableTotal: 0, requiresSelectionTotal: 0, disabledTotal: 0, projectTotal: 0 }
      }
    }));

    await page.route('**/api/folders**', async (route) => {
      const url = new URL(route.request().url());
      const base = url.searchParams.get('base') || 'C:\\Users\\testuser\\apps';
      await route.fulfill({
        json: {
          folders: [
            {
              name: 'Alpha',
              lastActive: '2026-07-20T10:00:00.000Z',
              modifiedAt: '2026-07-28T10:00:00.000Z',
              isGitRepo: true
            },
            {
              name: 'Bravo',
              lastActive: '2026-07-28T10:00:00.000Z',
              modifiedAt: '2026-07-21T10:00:00.000Z',
              isGitRepo: false
            },
            {
              name: 'Charlie',
              lastActive: null,
              modifiedAt: null,
              isGitRepo: false
            }
          ],
          base,
          root: 'C:\\Users\\testuser\\apps',
          rootId: 'windows',
          roots: [{ id: 'windows', label: 'Windows', path: 'C:\\Users\\testuser\\apps' }],
          defaultRoot: 'C:\\Users\\testuser\\apps'
        }
      });
    });

    await page.goto(BASE_URL, { waitUntil: 'domcontentloaded' });
    await page.getByRole('button', { name: '+ New' }).click();
    const dialog = page.getByRole('dialog', { name: 'New Session' });
    const rows = dialog.getByRole('row');

    await expect(rows).toHaveCount(4);
    await expect(rows.nth(1)).toContainText('Bravo');
    await expect(rows.nth(2)).toContainText('Alpha');
    await expect(rows.nth(3)).toContainText('Charlie');

    await dialog.getByRole('columnheader', { name: /Date modified/ }).click();
    await expect(rows.nth(1)).toContainText('Alpha');
    await expect(rows.nth(2)).toContainText('Bravo');
    await expect(rows.nth(3)).toContainText('Charlie');

    await dialog.getByRole('columnheader', { name: /^Name/ }).click();
    await expect(rows.nth(1)).toContainText('Alpha');
    await expect(rows.nth(2)).toContainText('Bravo');
    await expect(rows.nth(3)).toContainText('Charlie');
  });

  test('dismisses the modal while four sessions start in the background', async ({ page }) => {
    let createRequests = 0;
    let releaseFirstRequest;
    const firstRequestBlocked = new Promise(resolve => {
      releaseFirstRequest = resolve;
    });

    await page.addInitScript(() => {
      window.localStorage.setItem('easycc:lastCliType', 'claude');
    });

    await page.route('**/api/sessions/recovery-summary', (route) => route.fulfill({
      json: {
        sessions: [],
        totals: { candidateTotal: 0, launchableTotal: 0, requiresSelectionTotal: 0, disabledTotal: 0, projectTotal: 0 }
      }
    }));

    await page.route('**/api/folders**', (route) => route.fulfill({
      json: {
        folders: [],
        base: 'C:\\Users\\testuser\\apps',
        root: 'C:\\Users\\testuser\\apps',
        rootId: 'windows',
        roots: [{ id: 'windows', label: 'Windows', path: 'C:\\Users\\testuser\\apps' }],
        defaultRoot: 'C:\\Users\\testuser\\apps'
      }
    }));

    await page.route('**/api/sessions', async (route) => {
      if (route.request().method() !== 'POST') {
        await route.continue();
        return;
      }
      createRequests += 1;
      if (createRequests === 1) {
        await firstRequestBlocked;
      }
      await route.fulfill({
        status: 201,
        json: {
          session: {
            id: `background-session-${createRequests}`,
            name: 'Background session',
            status: 'active',
            workingDir: 'C:\\Users\\testuser\\apps',
            cliType: 'claude',
            createdAt: new Date().toISOString(),
            lastActivity: new Date().toISOString()
          }
        }
      });
    });

    await page.goto(BASE_URL, { waitUntil: 'domcontentloaded' });
    const newButton = page.getByRole('button', { name: '+ New' });
    await newButton.click();
    const dialog = page.getByRole('dialog', { name: 'New Session' });
    await dialog.getByLabel('Count').fill('4');
    await dialog.getByRole('button', { name: 'Create Session' }).click();

    await expect(dialog).toBeHidden();
    await expect(newButton).toBeEnabled();
    await newButton.click();
    await expect(page.getByRole('dialog', { name: 'New Session' })).toBeVisible();
    await page.getByRole('button', { name: 'Cancel' }).click();

    releaseFirstRequest();
    await expect.poll(() => createRequests).toBe(4);
    await expect(page.getByText('Started 4 of 4 sessions')).toBeVisible();
  });
});

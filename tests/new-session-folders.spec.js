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
});

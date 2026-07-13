const { test, expect } = require('@playwright/test');

const BASE_URL = process.env.CM_BASE_URL || 'http://localhost:5010';

const sessions = [
  { id: 'easycc-paused-one', name: 'Paused one', status: 'paused', cliType: 'claude', workingDir: 'C:/work/easycc' },
  { id: 'easycc-active', name: 'Active session', status: 'active', cliType: 'claude', workingDir: 'C:/work/easycc' },
  { id: 'easycc-paused-two', name: 'Paused two', status: 'paused', cliType: 'codex', workingDir: 'C:/work/easycc' },
  { id: 'tools-paused', name: 'Other project paused', status: 'paused', cliType: 'claude', workingDir: 'C:/work/tools' }
];

async function mockDashboard(page) {
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

  await page.route('**/api/settings', route => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({ settings: { session: { startupRecoveryMode: 'ask' } } })
  }));
  await page.route('**/api/stages', route => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({ stages: [] })
  }));
  await page.route('**/api/sessions/recovery-summary', route => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({
      sessions: [],
      totals: { candidateTotal: 0, launchableTotal: 0, requiresSelectionTotal: 0, disabledTotal: 0, projectTotal: 0 }
    })
  }));
}

test('kills only paused sessions in the selected project', async ({ page }) => {
  const deletedSessionIds = [];
  await mockDashboard(page);
  await page.route('**/api/sessions/*', async route => {
    if (route.request().method() !== 'DELETE') {
      await route.fallback();
      return;
    }
    deletedSessionIds.push(route.request().url().split('/').pop());
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ success: true }) });
  });

  await page.goto(BASE_URL, { waitUntil: 'domcontentloaded' });
  await page.getByRole('button', { name: 'Kill all paused sessions in easycc' }).click();

  const dialog = page.getByRole('heading', { name: 'Kill All Paused Sessions?' }).locator('..');
  await expect(dialog).toContainText('This will kill 2 paused sessions in easycc.');
  await dialog.getByRole('button', { name: 'Kill 2 Paused Sessions' }).click();

  await expect.poll(() => deletedSessionIds.sort()).toEqual(['easycc-paused-one', 'easycc-paused-two']);
  await expect(page.getByRole('button', { name: 'Collapse easycc (1 sessions)' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Collapse tools (1 sessions)' })).toBeVisible();
});

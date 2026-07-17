const { test, expect } = require('@playwright/test');

const BASE_URL = process.env.CM_BASE_URL || 'http://localhost:5010';

const reviewSession = {
  id: 'parking-review-one',
  name: 'Review candidate',
  status: 'idle',
  runtimeState: 'live',
  cliType: 'claude',
  workingDir: 'C:/work/easycc',
  repoName: 'easycc',
  readySince: new Date(Date.now() - 20 * 60_000).toISOString(),
  parkingProposalState: 'pending_review',
  parkingProposalReason: 'idle_timeout'
};

async function mockParkingDashboard(page, snoozedIds) {
  await page.addInitScript((session) => {
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
            data: JSON.stringify({
              type: 'init',
              clientId: 'client-test',
              sessions: [session],
              agents: [],
              tasks: [],
              parkingSummary: {
                live: 1,
                parked: 0,
                review: 1,
                currentParked: [],
                reviewSessions: [session],
                modalOwnerClientId: 'client-test'
              }
            })
          });
        }, 0);
      }

      send() {}
      close() { this.readyState = MockWebSocket.CLOSED; }
    }

    window.WebSocket = MockWebSocket;
  }, reviewSession);

  await page.route('**/api/settings', route => route.fulfill({
    json: { settings: { session: { startupRecoveryMode: 'ask' } } }
  }));
  await page.route('**/api/stages', route => route.fulfill({ json: { stages: [] } }));
  await page.route('**/api/sessions/recovery-summary', route => route.fulfill({
    json: {
      sessions: [],
      totals: {
        candidateTotal: 0,
        launchableTotal: 0,
        requiresSelectionTotal: 0,
        disabledTotal: 0,
        projectTotal: 0
      }
    }
  }));
  await page.route('**/api/session-parking/snooze', async route => {
    const body = route.request().postDataJSON();
    snoozedIds.push(...body.sessionIds);
    await route.fulfill({ json: { snoozed: body.sessionIds } });
  });
  await page.route('**/api/session-parking/events**', route => route.fulfill({ json: { events: [] } }));
}

test('confirmation is owned by one dashboard and Escape snoozes without parking', async ({ page }) => {
  const snoozedIds = [];
  await mockParkingDashboard(page, snoozedIds);
  await page.goto(BASE_URL, { waitUntil: 'domcontentloaded' });

  await expect(page.getByRole('heading', { name: 'Park idle sessions?' })).toBeVisible();
  await expect(page.getByText('Nothing is parked without confirmation.')).toBeVisible();

  await page.keyboard.press('Escape');

  await expect.poll(() => snoozedIds).toEqual(['parking-review-one']);
  await expect(page.getByRole('button', { name: /Live 1.*Parked 0.*Review 1/ })).toBeVisible();
});

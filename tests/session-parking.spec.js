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

async function mockParkingDashboard(page, snoozedIds, { parkingEnabled = true } = {}) {
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
    json: {
      settings: {
        session: {
          startupRecoveryMode: 'ask',
          autoParking: { enabled: parkingEnabled }
        }
      }
    }
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

test('disabled parking suppresses stale review UI', async ({ page }) => {
  await mockParkingDashboard(page, [], { parkingEnabled: false });
  await page.goto(BASE_URL, { waitUntil: 'domcontentloaded' });

  await expect(page.getByRole('heading', { name: 'Park idle sessions?' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: /Live 1.*Parked 0.*Review 1/ })).toHaveCount(0);
});

test('General settings can disable session parking', async ({ page }) => {
  let savedSettings = null;
  await page.addInitScript(() => {
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
              clientId: 'settings-client',
              sessions: [],
              agents: [],
              tasks: [],
              parkingSummary: {
                live: 0,
                parked: 0,
                review: 0,
                currentParked: [],
                reviewSessions: [],
                modalOwnerClientId: null
              }
            })
          });
        }, 0);
      }

      send() {}
      close() { this.readyState = MockWebSocket.CLOSED; }
    }

    window.WebSocket = MockWebSocket;
  });
  await page.route('**/api/settings', async route => {
    if (route.request().method() === 'PUT') {
      savedSettings = route.request().postDataJSON();
      await route.fulfill({ json: { settings: savedSettings } });
      return;
    }
    await route.fulfill({
      json: {
        settings: {
          starredFolders: [],
          session: {
            defaultWorkingDir: '',
            startupRecoveryMode: 'ask',
            autoParking: {
              enabled: true,
              maxLiveAiSessions: 6,
              idleMinutes: 15
            }
          }
        }
      }
    });
  });
  await page.route('**/api/settings/hooks-status', route => route.fulfill({ json: { installed: false } }));
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

  await page.goto(BASE_URL, { waitUntil: 'domcontentloaded' });
  await page.getByTitle('Settings').click();
  await page.getByRole('button', { name: 'General' }).click();

  const parkingToggle = page.getByRole('checkbox', { name: 'Enable session parking' });
  await expect(parkingToggle).toBeChecked();
  await parkingToggle.uncheck();
  await expect(
    page.locator('.form-group', { hasText: 'Maximum live AI sessions' }).getByRole('spinbutton')
  ).toBeDisabled();
  await page.getByRole('button', { name: 'Save' }).click();

  await expect.poll(() => savedSettings?.session?.autoParking?.enabled).toBe(false);
  await expect(page.getByRole('heading', { name: 'Settings' })).toHaveCount(0);
});

test('live Codex Windows session shows delayed identity callback warning', async ({ page }) => {
  const warningSession = {
    id: 'warning-session',
    name: 'Wake warning session',
    status: 'idle',
    runtimeState: 'live',
    cliType: 'codex-windows',
    workingDir: 'C:/work/easycc',
    groupKey: 'C:/work/easycc',
    stage: 'todo',
    wakeWarning: 'Exact resume is active, but the SessionStart identity callback did not arrive.'
  };
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
              clientId: 'warning-client',
              sessions: [session],
              agents: [],
              tasks: [],
              parkingSummary: {
                live: 1,
                parked: 0,
                review: 0,
                currentParked: [],
                reviewSessions: [],
                modalOwnerClientId: null
              }
            })
          });
        }, 0);
      }
      send() {}
      close() { this.readyState = MockWebSocket.CLOSED; }
    }
    window.WebSocket = MockWebSocket;
  }, warningSession);
  await page.route('**/api/settings', route => route.fulfill({
    json: { settings: { session: { startupRecoveryMode: 'ask', autoParking: { enabled: true } } } }
  }));
  await page.route('**/api/stages', route => route.fulfill({ json: { stages: [] } }));
  await page.route('**/api/sessions/recovery-summary', route => route.fulfill({
    json: { sessions: [], totals: { candidateTotal: 0, launchableTotal: 0, requiresSelectionTotal: 0, disabledTotal: 0, projectTotal: 0 } }
  }));
  await page.route('**/api/sessions/warning-session/transcript**', route => route.fulfill({
    json: { chunks: [], hasMore: false, nextBeforeBytes: null }
  }));

  await page.goto(BASE_URL, { waitUntil: 'domcontentloaded' });
  await page.locator('.session-card').filter({ hasText: 'Wake warning session' }).click();

  await expect(page.getByRole('status')).toContainText('Identity callback delayed');
  await expect(page.getByRole('status')).toContainText('SessionStart identity callback did not arrive');
});

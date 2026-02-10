const { test, expect } = require('@playwright/test');
const { launchApp, teardownApp } = require('./helpers/electron-setup');
const { createTestSession, killTestSession } = require('./helpers/api');
const AppPage = require('./pages/app.page');

test.describe('View Toggle (Ctrl+O)', () => {
  let app, page, appPage;
  let testSessionId;

  test.beforeAll(async () => {
    ({ app, page } = await launchApp());
    appPage = new AppPage(page);

    const res = await createTestSession(page, { name: 'ViewToggle-Test' });
    testSessionId = res.session?.id;
    await page.waitForTimeout(2000);
  });

  test.afterAll(async () => {
    if (testSessionId) await killTestSession(page, testSessionId).catch(() => {});
    // Reset to sessions view
    if (await appPage.isInKanbanView()) await appPage.switchToSessions();
    await teardownApp(app);
  });

  test('starts in sessions view by default', async () => {
    // sessions-list is inside the sidebar
    await expect(appPage.sessionsList).toBeVisible();
    await expect(appPage.activeViewBtn).toHaveText('Sessions');
  });

  test('Ctrl+O switches to kanban view', async () => {
    await appPage.pressCtrlO();
    await expect(appPage.kanbanBoard).toBeVisible({ timeout: 10000 });
    await expect(appPage.activeViewBtn).toHaveText('Kanban');
  });

  test('Ctrl+O again switches back to sessions', async () => {
    await appPage.pressCtrlO();
    await expect(appPage.sessionsList).toBeVisible({ timeout: 5000 });
    await expect(appPage.activeViewBtn).toHaveText('Sessions');
  });

  test('view toggle buttons work', async () => {
    await appPage.switchToKanban();
    await expect(appPage.kanbanBoard).toBeVisible();
    await expect(appPage.activeViewBtn).toHaveText('Kanban');

    await appPage.switchToSessions();
    await expect(appPage.sessionsList).toBeVisible();
    await expect(appPage.activeViewBtn).toHaveText('Sessions');
  });

  test('selectedId preserved across view switches', async () => {
    const card = page.locator('.session-card').filter({ hasText: 'ViewToggle-Test' });
    if (await card.isVisible()) {
      await card.click();
      await expect(card).toHaveClass(/selected/);

      await appPage.pressCtrlO();
      await appPage.pressCtrlO();

      await expect(page.locator('.session-card.selected')).toContainText('ViewToggle-Test');
    }
  });
});

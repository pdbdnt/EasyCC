const { test, expect } = require('@playwright/test');
const { launchApp, teardownApp } = require('./helpers/electron-setup');
const { createTestSession, killTestSession, getTask, getStages, moveTask } = require('./helpers/api');
const AppPage = require('./pages/app.page');

test.describe('Session-Task Auto-Linking', () => {
  let app, page, appPage;
  let testSessionId, linkedTaskId;
  let firstStageId, firstStageName;

  test.beforeAll(async () => {
    ({ app, page } = await launchApp());
    appPage = new AppPage(page);
    if (await appPage.isInKanbanView()) await appPage.switchToSessions();

    const { stages } = await getStages(page);
    const firstStage = stages.sort((a, b) => a.order - b.order)[0];
    firstStageId = firstStage.id;
    firstStageName = firstStage.name;

    const res = await createTestSession(page, { name: 'AutoLink-Test' });
    testSessionId = res.session?.id;
    linkedTaskId = res.session?.linkedTaskId;

    await page.waitForTimeout(2000);
  });

  test.afterAll(async () => {
    if (testSessionId) await killTestSession(page, testSessionId).catch(() => {});
    if (await appPage.isInKanbanView()) await appPage.switchToSessions();
    await teardownApp(app);
  });

  test('new session has linkedTaskId in response', async () => {
    expect(linkedTaskId).toBeTruthy();
  });

  test('linked task exists with session assigned', async () => {
    // Check BEFORE any move — the task was just created with assignment
    const { task } = await getTask(page, linkedTaskId);
    expect(task).toBeTruthy();
    expect(task.assignedSessionId).toBe(testSessionId);
  });

  test('linked task appears in kanban after move to real stage', async () => {
    // Move to first real stage (move clears assignment, that's expected API behavior)
    await moveTask(page, linkedTaskId, firstStageId);
    await page.waitForTimeout(1000);

    await appPage.switchToKanban();
    await page.waitForTimeout(1500);

    const col = page.locator('.kanban-column').filter({
      has: page.locator('.column-title', { hasText: firstStageName })
    });
    await expect(col).toBeVisible({ timeout: 10000 });

    // Use .first() in case leftovers from previous runs
    const card = col.locator('.task-card').filter({ hasText: 'AutoLink-Test' }).first();
    await expect(card).toBeVisible({ timeout: 5000 });
  });
});

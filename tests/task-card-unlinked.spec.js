const { test, expect } = require('@playwright/test');
const { launchApp, teardownApp } = require('./helpers/electron-setup');
const { createTask, deleteTask, getStages } = require('./helpers/api');
const AppPage = require('./pages/app.page');
const KanbanPage = require('./pages/kanban.page');

test.describe('Unlinked TaskCard', () => {
  let app, page, appPage, kanbanPage;
  let testTaskId;

  test.beforeAll(async () => {
    ({ app, page } = await launchApp());
    appPage = new AppPage(page);
    kanbanPage = new KanbanPage(page);
    if (await appPage.isInKanbanView()) await appPage.switchToSessions();

    // Get actual first stage
    const { stages } = await getStages(page);
    const firstStageId = stages.sort((a, b) => a.order - b.order)[0].id;

    // Create an unlinked task in the first real stage
    const res = await createTask(page, {
      title: 'Unlinked-Test-Task',
      project: 'C:\\Users\\testuser\\apps\\TestProject',
      stage: firstStageId
    });
    testTaskId = res.task?.id;

    await appPage.switchToKanban();
    await page.waitForTimeout(2000);
  });

  test.afterAll(async () => {
    if (testTaskId) await deleteTask(page, testTaskId).catch(() => {});
    if (await appPage.isInKanbanView()) await appPage.switchToSessions();
    await teardownApp(app);
  });

  test('unlinked card does not have task-card-linked class', async () => {
    const card = kanbanPage.unlinkedCard('Unlinked-Test-Task');
    await expect(card).toBeVisible({ timeout: 10000 });
    await expect(card).not.toHaveClass(/task-card-linked/);
    await expect(card).toHaveClass(/task-card/);
  });

  test('unlinked card shows task title', async () => {
    const card = kanbanPage.unlinkedCard('Unlinked-Test-Task');
    await expect(card.locator('.task-title')).toHaveText('Unlinked-Test-Task');
  });

  test('unlinked card shows project name', async () => {
    const card = kanbanPage.unlinkedCard('Unlinked-Test-Task');
    await expect(card.locator('.task-project')).toHaveText('TestProject');
  });

  test('clicking unlinked card opens task view modal', async () => {
    const card = kanbanPage.unlinkedCard('Unlinked-Test-Task');
    await card.click();
    await expect(page.locator('.task-view-modal')).toBeVisible({ timeout: 5000 });
    await page.keyboard.press('Escape');
    await page.waitForTimeout(500);
  });
});

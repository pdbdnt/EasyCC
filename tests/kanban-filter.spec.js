const { test, expect } = require('@playwright/test');
const { launchApp, teardownApp } = require('./helpers/electron-setup');
const { createTestSession, killTestSession, pauseTestSession, getStages, moveTask } = require('./helpers/api');
const AppPage = require('./pages/app.page');
const KanbanPage = require('./pages/kanban.page');
const SessionsPage = require('./pages/sessions.page');

test.describe('Kanban → Sessions Filter Navigation', () => {
  let app, page, appPage, kanbanPage, sessionsPage;
  const sessionIds = [];
  let firstStageId;

  test.beforeAll(async () => {
    ({ app, page } = await launchApp());
    appPage = new AppPage(page);
    kanbanPage = new KanbanPage(page);
    sessionsPage = new SessionsPage(page);
    if (await appPage.isInKanbanView()) await appPage.switchToSessions();

    // Get actual stages
    const { stages } = await getStages(page);
    const sorted = stages.sort((a, b) => a.order - b.order);
    firstStageId = sorted[0].id;

    // Create 3 sessions and move their tasks to the first stage so they appear in kanban
    const s1 = await createTestSession(page, { name: 'Filter-Active1' });
    sessionIds.push(s1.session?.id);
    if (s1.session?.linkedTaskId) await moveTask(page, s1.session.linkedTaskId, firstStageId);

    const s2 = await createTestSession(page, { name: 'Filter-Active2' });
    sessionIds.push(s2.session?.id);
    if (s2.session?.linkedTaskId) await moveTask(page, s2.session.linkedTaskId, firstStageId);

    const s3 = await createTestSession(page, { name: 'Filter-Paused1' });
    sessionIds.push(s3.session?.id);
    if (s3.session?.linkedTaskId) await moveTask(page, s3.session.linkedTaskId, firstStageId);

    await page.waitForTimeout(3000);

    // Pause the third session
    await pauseTestSession(page, s3.session.id);
    await page.waitForTimeout(1500);
  });

  test.afterAll(async () => {
    for (const id of sessionIds) {
      if (id) await killTestSession(page, id).catch(() => {});
    }
    if (await sessionsPage.filterChip.isVisible().catch(() => false)) {
      await sessionsPage.filterChipClear.click();
    }
    if (await appPage.isInKanbanView()) await appPage.switchToSessions();
    await teardownApp(app);
  });

  test('clicking linked card navigates to sessions with filter chip', async () => {
    await appPage.switchToKanban();
    await page.waitForTimeout(1500);

    const card = kanbanPage.linkedCard('Filter-Active1');
    await expect(card).toBeVisible({ timeout: 10000 });
    await card.click();

    await expect(appPage.sessionsList).toBeVisible({ timeout: 5000 });
    await expect(sessionsPage.filterChip).toBeVisible({ timeout: 5000 });
  });

  test('filter chip shows correct stage name', async () => {
    const chipText = await sessionsPage.filterChipText.textContent();
    // Should contain some stage name
    expect(chipText.toLowerCase()).toMatch(/backlog|planning|coding|testing|review|done|todo|in.progress|in.review/);
  });

  test('clearing filter chip shows all sessions', async () => {
    await expect(sessionsPage.filterChip).toBeVisible();
    await sessionsPage.filterChipClear.click();
    await expect(sessionsPage.filterChip).not.toBeVisible();

    const count = await sessionsPage.sessionCards.count();
    expect(count).toBeGreaterThanOrEqual(3);
  });

  test('Ctrl+O from filtered sessions to kanban preserves selectedId', async () => {
    // Set up filter again
    await appPage.switchToKanban();
    await page.waitForTimeout(1000);

    const card = kanbanPage.linkedCard('Filter-Active1');
    await expect(card).toBeVisible({ timeout: 10000 });
    await card.click();
    await expect(appPage.sessionsList).toBeVisible({ timeout: 5000 });

    const selected = sessionsPage.selectedCard;
    await expect(selected).toBeVisible();
    await expect(selected).toContainText('Filter-Active1');

    await appPage.pressCtrlO();
    await expect(appPage.kanbanBoard).toBeVisible();
    await appPage.pressCtrlO();
    await expect(appPage.sessionsList).toBeVisible();

    await expect(sessionsPage.selectedCard).toContainText('Filter-Active1');
  });
});

const { test, expect } = require('@playwright/test');
const { launchApp, teardownApp } = require('./helpers/electron-setup');
const {
  createTestSession, killTestSession, pauseTestSession,
  patchSession, moveTask, getStages
} = require('./helpers/api');
const AppPage = require('./pages/app.page');
const KanbanPage = require('./pages/kanban.page');

test.describe('Linked TaskCard Visual Parity', () => {
  let app, page, appPage, kanbanPage;
  const sessionIds = [];
  let firstStageId;

  test.beforeAll(async () => {
    ({ app, page } = await launchApp());
    appPage = new AppPage(page);
    kanbanPage = new KanbanPage(page);
    if (await appPage.isInKanbanView()) await appPage.switchToSessions();

    // Get actual first stage
    const { stages } = await getStages(page);
    firstStageId = stages.sort((a, b) => a.order - b.order)[0].id;

    // Create sessions
    const s1 = await createTestSession(page, { name: 'Linked-Claude', cliType: 'claude' });
    sessionIds.push(s1.session?.id);
    if (s1.session?.linkedTaskId) await moveTask(page, s1.session.linkedTaskId, firstStageId);

    const s2 = await createTestSession(page, { name: 'Linked-Terminal', cliType: 'terminal' });
    sessionIds.push(s2.session?.id);
    if (s2.session?.linkedTaskId) await moveTask(page, s2.session.linkedTaskId, firstStageId);

    const s3 = await createTestSession(page, { name: 'Linked-Paused', cliType: 'claude' });
    sessionIds.push(s3.session?.id);
    if (s3.session?.linkedTaskId) await moveTask(page, s3.session.linkedTaskId, firstStageId);

    const s4 = await createTestSession(page, { name: 'Linked-Notes', cliType: 'claude' });
    sessionIds.push(s4.session?.id);
    if (s4.session?.linkedTaskId) await moveTask(page, s4.session.linkedTaskId, firstStageId);

    await page.waitForTimeout(3000);

    // Set notes on s4
    await patchSession(page, s4.session.id, {
      notes: 'This is a very long note that should be truncated after sixty characters because it exceeds limit'
    });
    // Set tags on s4
    await patchSession(page, s4.session.id, {
      tags: ['tag1', 'tag2', 'tag3', 'tag4', 'tag5']
    });

    // Pause s3
    await pauseTestSession(page, s3.session.id);
    await page.waitForTimeout(1000);

    // Move s3's task manually to a different stage
    if (s3.session.linkedTaskId) {
      const secondStageId = stages.sort((a, b) => a.order - b.order)[1]?.id || firstStageId;
      await moveTask(page, s3.session.linkedTaskId, secondStageId);
      await page.waitForTimeout(500);
    }

    // Switch to kanban
    await appPage.switchToKanban();
    await page.waitForTimeout(2000);
  });

  test.afterAll(async () => {
    for (const id of sessionIds) {
      if (id) await killTestSession(page, id).catch(() => {});
    }
    if (await appPage.isInKanbanView()) await appPage.switchToSessions();
    await teardownApp(app);
  });

  test('linked card has task-card-linked class', async () => {
    const card = kanbanPage.linkedCard('Linked-Claude');
    await expect(card).toBeVisible({ timeout: 10000 });
    await expect(card).toHaveClass(/task-card-linked/);
  });

  test('linked card shows session name as title', async () => {
    const card = kanbanPage.linkedCard('Linked-Claude');
    await expect(card.locator('.task-title')).toHaveText('Linked-Claude');
  });

  test('linked card shows CLI badge CC for claude', async () => {
    const card = kanbanPage.linkedCard('Linked-Claude');
    await expect(kanbanPage.cardCliBadge(card)).toHaveText('CC');
  });

  test('linked card shows CLI badge TRM for terminal', async () => {
    const card = kanbanPage.linkedCard('Linked-Terminal');
    await expect(card).toBeVisible({ timeout: 10000 });
    await expect(kanbanPage.cardCliBadge(card)).toHaveText('TRM');
  });

  test('linked card shows status indicator', async () => {
    const card = kanbanPage.linkedCard('Linked-Claude');
    await expect(card.locator('.status-indicator')).toBeVisible();
  });

  test('linked card shows status emoji and text', async () => {
    const card = kanbanPage.linkedCard('Linked-Claude');
    const status = kanbanPage.cardStatus(card);
    await expect(status).toBeVisible();
    const text = await status.textContent();
    expect(text.length).toBeGreaterThan(0);
  });

  test('linked card with notes shows truncated preview', async () => {
    const card = kanbanPage.linkedCard('Linked-Notes');
    await expect(card).toBeVisible({ timeout: 10000 });
    const notes = kanbanPage.cardNotes(card);
    await expect(notes).toBeVisible();
    const text = await notes.textContent();
    expect(text).toContain('...');
    expect(text.length).toBeLessThanOrEqual(64);
  });

  test('linked card shows tags (max 3 + overflow)', async () => {
    const card = kanbanPage.linkedCard('Linked-Notes');
    await expect(kanbanPage.cardTags(card)).toHaveCount(3);
    const overflow = kanbanPage.cardTagOverflow(card);
    await expect(overflow).toBeVisible();
    await expect(overflow).toHaveText('+2');
  });

  test('linked card shows activity time', async () => {
    const card = kanbanPage.linkedCard('Linked-Claude');
    const time = kanbanPage.cardTime(card);
    await expect(time).toBeVisible();
  });

  test('paused linked card shows PAUSED overlay', async () => {
    const card = kanbanPage.linkedCard('Linked-Paused');
    await expect(card).toBeVisible({ timeout: 10000 });
    await expect(kanbanPage.cardPausedOverlay(card)).toBeVisible();
    await expect(kanbanPage.cardPausedBadge(card)).toHaveText('PAUSED');
  });

  test('paused card hides current task', async () => {
    const card = kanbanPage.linkedCard('Linked-Paused');
    await expect(kanbanPage.cardCurrentTask(card)).not.toBeVisible();
  });

  test('manually placed card shows pin badge', async () => {
    const card = kanbanPage.linkedCard('Linked-Paused');
    await expect(kanbanPage.cardManualBadge(card)).toBeVisible();
  });

  test('details button opens task modal not navigation', async () => {
    const card = kanbanPage.linkedCard('Linked-Claude');
    await kanbanPage.cardDetailsBtn(card).click();
    await expect(page.locator('.task-view-modal')).toBeVisible({ timeout: 5000 });
    await page.keyboard.press('Escape');
    await page.waitForTimeout(500);
  });
});

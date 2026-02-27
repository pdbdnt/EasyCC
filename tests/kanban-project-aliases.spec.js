const { test, expect } = require('@playwright/test');
const { launchApp, teardownApp } = require('./helpers/electron-setup');
const {
  createTestSession,
  killTestSession,
  getStages,
  moveTask,
  getSettings,
  updateSettings
} = require('./helpers/api');
const AppPage = require('./pages/app.page');
const KanbanPage = require('./pages/kanban.page');

test.describe('Kanban Project Alias Display', () => {
  let app, page, appPage, kanbanPage;
  const sessionIds = [];
  let firstStageId;
  let firstStageName;
  let originalAliases = {};

  const projectDirCm = 'C:\\Users\\testuser\\apps\\EasyCC';
  const projectDirZw = 'C:\\Users\\testuser\\apps\\zwoofi';
  const aliasCm = 'cm-spec';
  const aliasZw = 'zw-spec';

  test.beforeAll(async () => {
    ({ app, page } = await launchApp());
    appPage = new AppPage(page);
    kanbanPage = new KanbanPage(page);

    if (await appPage.isInKanbanView()) await appPage.switchToSessions();

    const settingsRes = await getSettings(page);
    originalAliases = settingsRes?.settings?.projectAliases || {};
    await updateSettings(page, {
      projectAliases: {
        ...originalAliases,
        [projectDirCm]: aliasCm,
        [projectDirZw]: aliasZw
      }
    });

    const { stages } = await getStages(page);
    const sortedStages = stages.sort((a, b) => a.order - b.order);
    firstStageId = sortedStages[0].id;
    firstStageName = sortedStages[0].name;

    const cmSession = await createTestSession(page, {
      name: 'Alias-CM-Session',
      workingDir: projectDirCm
    });
    sessionIds.push(cmSession.session?.id);
    if (cmSession.session?.linkedTaskId) {
      await moveTask(page, cmSession.session.linkedTaskId, firstStageId);
    }

    const zwSession = await createTestSession(page, {
      name: 'Alias-ZW-Session',
      workingDir: projectDirZw
    });
    sessionIds.push(zwSession.session?.id);
    if (zwSession.session?.linkedTaskId) {
      await moveTask(page, zwSession.session.linkedTaskId, firstStageId);
    }

    await page.waitForTimeout(2000);
    await appPage.switchToKanban();
    await page.waitForTimeout(1000);
  });

  test.afterAll(async () => {
    if (!page) return;

    for (const id of sessionIds) {
      if (id) await killTestSession(page, id).catch(() => {});
    }

    await updateSettings(page, { projectAliases: originalAliases }).catch(() => {});

    if (appPage && await appPage.isInKanbanView().catch(() => false)) {
      await appPage.switchToSessions().catch(() => {});
    }
    await teardownApp(app);
  });

  test('shows alias in project subheaders instead of raw folder names', async () => {
    const column = kanbanPage.column(firstStageName);
    await expect(column).toBeVisible({ timeout: 10000 });

    const subheaders = column.locator('.kanban-project-subheader');
    await expect(subheaders.filter({ hasText: aliasCm })).toBeVisible();
    await expect(subheaders.filter({ hasText: aliasZw })).toBeVisible();

    await expect(subheaders.filter({ hasText: 'easycc' })).toHaveCount(0);
    await expect(subheaders.filter({ hasText: 'zwoofi' })).toHaveCount(0);
  });
});

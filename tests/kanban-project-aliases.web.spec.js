const { test, expect } = require('@playwright/test');

const BASE_URL = process.env.CM_BASE_URL || 'http://localhost:5010';
const SLOW_MS = Number.parseInt(process.env.CM_TEST_SLOWMO_MS || '0', 10);

test.describe('Kanban Project Alias Display (Web)', () => {
  const sessionIds = [];
  let originalAliases = {};
  let firstStageName = 'In Review';

  const projectDirCm = 'C:\\Users\\denni\\apps\\CLIOverlord\\claude-manager';
  const projectDirZw = 'C:\\Users\\denni\\apps\\zwoofi';
  const aliasCm = 'cm-web';
  const aliasZw = 'zw-web';

  async function maybePause(page) {
    if (SLOW_MS > 0) {
      await page.waitForTimeout(SLOW_MS);
    }
  }

  async function api(path, method = 'GET', body) {
    const res = await fetch(`${BASE_URL}${path}`, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined
    });
    return res.json();
  }

  test.beforeAll(async () => {
    try {
      const res = await fetch(BASE_URL);
      if (!res.ok) {
        test.skip(true, `App returned ${res.status} at ${BASE_URL}`);
      }
    } catch {
      test.skip(true, `App is not reachable at ${BASE_URL}`);
    }

    const settingsRes = await api('/api/settings');
    originalAliases = settingsRes?.settings?.projectAliases || {};

    await api('/api/settings', 'PUT', {
      projectAliases: {
        ...originalAliases,
        [projectDirCm]: aliasCm,
        [projectDirZw]: aliasZw
      }
    });

    const stagesRes = await api('/api/stages');
    const stages = (stagesRes?.stages || []).sort((a, b) => a.order - b.order);
    const firstStageId = stages[0]?.id || 'in_review';
    firstStageName = stages[0]?.name || 'In Review';

    const s1 = await api('/api/sessions', 'POST', {
      name: 'Alias-Web-CM',
      workingDir: projectDirCm,
      cliType: 'claude'
    });
    if (s1?.session?.id) sessionIds.push(s1.session.id);
    if (s1?.session?.linkedTaskId) {
      await api(`/api/tasks/${s1.session.linkedTaskId}/move`, 'POST', { stage: firstStageId });
    }

    const s2 = await api('/api/sessions', 'POST', {
      name: 'Alias-Web-ZW',
      workingDir: projectDirZw,
      cliType: 'claude'
    });
    if (s2?.session?.id) sessionIds.push(s2.session.id);
    if (s2?.session?.linkedTaskId) {
      await api(`/api/tasks/${s2.session.linkedTaskId}/move`, 'POST', { stage: firstStageId });
    }
  });

  test.afterAll(async () => {
    for (const id of sessionIds) {
      await api(`/api/sessions/${id}`, 'DELETE').catch(() => {});
    }
    await api('/api/settings', 'PUT', { projectAliases: originalAliases }).catch(() => {});
  });

  test('renders aliases in kanban project subheaders', async ({ page }) => {
    await page.goto(BASE_URL, { waitUntil: 'domcontentloaded' });
    await maybePause(page);
    await page.getByRole('button', { name: 'Kanban' }).click();
    await maybePause(page);

    const column = page.locator('.kanban-column').filter({
      has: page.locator('.column-title', { hasText: firstStageName })
    });
    await expect(column).toBeVisible();
    await maybePause(page);

    const subheaders = column.locator('.kanban-project-subheader');
    await expect(subheaders.filter({ hasText: aliasCm })).toBeVisible();
    await maybePause(page);
    await expect(subheaders.filter({ hasText: aliasZw })).toBeVisible();
    await maybePause(page);
    await expect(subheaders.filter({ hasText: 'claude-manager' })).toHaveCount(0);
    await expect(subheaders.filter({ hasText: 'zwoofi' })).toHaveCount(0);
    await maybePause(page);
  });
});

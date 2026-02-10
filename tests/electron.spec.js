const { test, expect } = require('@playwright/test');
const { launchApp, teardownApp } = require('./helpers/electron-setup');

test.describe('Electron App', () => {
  let app;
  let win;

  test.beforeAll(async () => {
    ({ app, page: win } = await launchApp());
  });

  test.afterAll(async () => {
    await teardownApp(app);
  });

  test('window opens without ERR_CONNECTION_REFUSED', async () => {
    const title = await win.title();
    console.log('Window title:', title);

    const body = await win.locator('body').textContent();
    expect(body).not.toContain('ERR_CONNECTION_REFUSED');
    expect(body).not.toContain('This site can\u2019t be reached');
  });

  test('backend API is reachable from renderer', async () => {
    const response = await win.evaluate(async () => {
      const res = await fetch('/api/sessions');
      return { status: res.status, ok: res.ok };
    });

    expect(response.ok).toBe(true);
    expect(response.status).toBe(200);
  });

  test('UI renders session dashboard', async () => {
    await win.waitForSelector('#root', { timeout: 10000 });
    const root = win.locator('#root');
    await expect(root).toBeVisible();
  });
});

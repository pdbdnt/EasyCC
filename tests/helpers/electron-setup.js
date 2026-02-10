const { _electron: electron } = require('@playwright/test');
const path = require('path');

// Shared singleton — one Electron instance for ALL spec files
let sharedApp = null;
let sharedPage = null;
let refCount = 0;

async function launchApp() {
  refCount++;

  if (sharedApp && sharedPage) {
    // Reuse existing instance
    return { app: sharedApp, page: sharedPage };
  }

  const app = await electron.launch({
    args: [path.join(__dirname, '..', '..', 'electron', 'main.js')],
    timeout: 30000,
  });

  const page = await app.firstWindow();

  // Auto-accept all dialogs (beforeunload, confirm, etc.)
  page.on('dialog', async (dialog) => {
    await dialog.accept().catch(() => {});
  });

  await page.waitForLoadState('domcontentloaded');
  await page.waitForSelector('#root', { timeout: 15000 });

  sharedApp = app;
  sharedPage = page;

  return { app, page };
}

async function teardownApp(app) {
  refCount--;
  // Only kill when last consumer tears down
  if (refCount > 0) return;

  if (sharedApp) {
    try {
      const pid = sharedApp.process().pid;
      // Kill entire process tree on Windows
      require('child_process').execSync(`taskkill /PID ${pid} /T /F`, { stdio: 'ignore' });
    } catch {}
    sharedApp = null;
    sharedPage = null;
  }
}

module.exports = { launchApp, teardownApp };

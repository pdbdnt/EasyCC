const { defineConfig } = require('@playwright/test');

module.exports = defineConfig({
  testDir: './tests',
  timeout: 60000,
  globalTimeout: 600000,
  retries: 0,
  reporter: process.env.CI ? 'line' : 'list',
  outputDir: './test-results',
  workers: 1,
  // Electron's tray + beforeunload dialog prevent clean teardown
  // Keep teardown short so tests don't hang
  expect: { timeout: 10000 },
});

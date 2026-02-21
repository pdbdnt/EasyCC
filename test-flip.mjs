import { chromium } from 'playwright';

const browser = await chromium.launch({ headless: false });
const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });

page.on('pageerror', err => console.log('[ERROR]', err.message));

await page.goto('http://localhost:5010');
await page.waitForTimeout(3000);

// Set animation speed to Super Slow via API
await page.evaluate(async () => {
  const res = await fetch('/api/settings');
  const { settings } = await res.json();
  settings.ui.flipAnimationSpeed = 0.1;
  await fetch('/api/settings', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(settings)
  });
});
console.log('Set speed to Super Slow (0.1)');

// Reload to pick up settings
await page.reload();
await page.waitForTimeout(3000);

// Navigate to Kanban view
await page.locator('button').filter({ hasText: /^Kanban$/ }).click();
await page.waitForTimeout(2000);

const taskCards = await page.locator('.task-card').count();
console.log(`Kanban task cards: ${taskCards}`);
await page.screenshot({ path: 'test-screenshots/01-kanban-before.png' });

// Trigger Ctrl+O
await page.locator('body').click({ position: { x: 960, y: 10 } });
await page.waitForTimeout(200);
console.log('Pressing Ctrl+O (super slow - should take ~3.5s now)...');
await page.keyboard.down('Control');
await page.keyboard.press('o');
await page.keyboard.up('Control');

// Super slow: flipDuration=3500ms, stagger=400ms
// Take screenshots spanning the full animation
await page.screenshot({ path: 'test-screenshots/02-0ms.png' });
await page.waitForTimeout(500);
await page.screenshot({ path: 'test-screenshots/03-500ms.png' });
await page.waitForTimeout(500);
await page.screenshot({ path: 'test-screenshots/04-1000ms.png' });
await page.waitForTimeout(1000);
await page.screenshot({ path: 'test-screenshots/05-2000ms.png' });
await page.waitForTimeout(1000);
await page.screenshot({ path: 'test-screenshots/06-3000ms.png' });
await page.waitForTimeout(1500);
await page.screenshot({ path: 'test-screenshots/07-4500ms.png' });
await page.waitForTimeout(2000);
await page.screenshot({ path: 'test-screenshots/08-6500ms.png' });
await page.waitForTimeout(2000);
await page.screenshot({ path: 'test-screenshots/09-8500ms.png' });

// Reset speed
await page.evaluate(async () => {
  const res = await fetch('/api/settings');
  const { settings } = await res.json();
  settings.ui.flipAnimationSpeed = 1;
  await fetch('/api/settings', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(settings)
  });
});
console.log('Reset speed to Normal');

await browser.close();
console.log('Done!');

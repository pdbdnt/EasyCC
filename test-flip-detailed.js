const { chromium } = require('playwright');
const path = require('path');

(async () => {
  const browser = await chromium.launch({ headless: false, slowMo: 100 });
  const context = await browser.newContext({
    viewport: { width: 1920, height: 1080 },
    recordVideo: {
      dir: path.join(__dirname, 'flip-animation-screenshots'),
      size: { width: 1920, height: 1080 }
    }
  });
  const page = await context.newPage();

  const screenshotsDir = path.join(__dirname, 'flip-animation-screenshots');

  console.log('Navigating to http://localhost:5010');
  await page.goto('http://localhost:5010');
  await page.waitForLoadState('networkidle');
  await page.waitForTimeout(1000);

  console.log('Taking screenshot of initial Sessions view');
  await page.screenshot({ path: path.join(screenshotsDir, '01-sessions-initial.png'), fullPage: true });

  console.log('Clicking Kanban view');
  await page.click('button:has-text("Kanban")');
  await page.waitForTimeout(1500);

  console.log('Taking screenshot of Kanban view');
  await page.screenshot({ path: path.join(screenshotsDir, '02-kanban-loaded.png'), fullPage: true });

  console.log('Clicking a session card in Kanban');
  const card = page.locator('.session-card').first();
  await card.click();
  await page.waitForTimeout(500);

  console.log('Taking screenshot of selected card');
  await page.screenshot({ path: path.join(screenshotsDir, '03-card-selected-kanban.png'), fullPage: true });

  console.log('\n=== PRESSING Ctrl+O - CAPTURING ANIMATION ===\n');

  // Take screenshot of sidebar only (left 280px)
  const sidebarClip = { x: 0, y: 0, width: 300, height: 1080 };

  await page.keyboard.press('Control+O');

  // Immediate capture (0ms)
  await page.screenshot({
    path: path.join(screenshotsDir, '04-sidebar-0ms.png'),
    clip: sidebarClip
  });
  console.log('Captured at 0ms');

  // Capture at 100ms (early animation)
  await page.waitForTimeout(100);
  await page.screenshot({
    path: path.join(screenshotsDir, '05-sidebar-100ms.png'),
    clip: sidebarClip
  });
  console.log('Captured at 100ms');

  // Capture at 300ms (mid animation)
  await page.waitForTimeout(200);
  await page.screenshot({
    path: path.join(screenshotsDir, '06-sidebar-300ms.png'),
    clip: sidebarClip
  });
  console.log('Captured at 300ms');

  // Capture at 600ms (staggered cards)
  await page.waitForTimeout(300);
  await page.screenshot({
    path: path.join(screenshotsDir, '07-sidebar-600ms.png'),
    clip: sidebarClip
  });
  console.log('Captured at 600ms');

  // Capture at 1000ms (most animation done)
  await page.waitForTimeout(400);
  await page.screenshot({
    path: path.join(screenshotsDir, '08-sidebar-1000ms.png'),
    clip: sidebarClip
  });
  console.log('Captured at 1000ms');

  // Capture at 1700ms (all animation complete)
  await page.waitForTimeout(700);
  await page.screenshot({
    path: path.join(screenshotsDir, '09-sidebar-1700ms.png'),
    clip: sidebarClip
  });
  console.log('Captured at 1700ms');

  // Full page final state
  await page.waitForTimeout(500);
  await page.screenshot({
    path: path.join(screenshotsDir, '10-final-state.png'),
    fullPage: true
  });
  console.log('Captured final state');

  console.log(`\nScreenshots saved to: ${screenshotsDir}`);
  console.log('Waiting for video recording...');
  await page.waitForTimeout(2000);

  await context.close();
  await browser.close();
  console.log('Done!');
})();

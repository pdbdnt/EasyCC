const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');

(async () => {
  const browser = await chromium.launch({ headless: false });
  const context = await browser.newContext({
    viewport: { width: 1920, height: 1080 }
  });
  const page = await context.newPage();

  // Create screenshots directory
  const screenshotsDir = path.join(__dirname, 'flip-animation-screenshots');
  if (!fs.existsSync(screenshotsDir)) {
    fs.mkdirSync(screenshotsDir);
  }

  console.log('Step 1: Navigating to http://localhost:5010');
  await page.goto('http://localhost:5010');

  console.log('Step 2: Waiting for page to load');
  await page.waitForLoadState('networkidle');
  await page.waitForTimeout(1000);

  console.log('Step 3: Looking for kanban view toggle button');
  // Look for the view switcher - could be a button with grid/kanban icon
  // Common selectors: button with data-testid, aria-label, or class containing "kanban", "grid", "view"
  const viewToggleSelectors = [
    'button[aria-label*="kanban" i]',
    'button[aria-label*="grid" i]',
    'button[title*="kanban" i]',
    'button[title*="grid" i]',
    'button:has-text("Kanban")',
    'button:has-text("Grid")',
    '[data-view="kanban"]',
    '.view-switcher button:last-child',
    '.view-toggle button:last-child'
  ];

  let viewToggle = null;
  for (const selector of viewToggleSelectors) {
    try {
      viewToggle = await page.locator(selector).first();
      if (await viewToggle.count() > 0) {
        console.log(`Found view toggle with selector: ${selector}`);
        break;
      }
    } catch (e) {
      // Try next selector
    }
  }

  if (!viewToggle || await viewToggle.count() === 0) {
    console.log('Could not find kanban toggle button, taking screenshot of current state');
    await page.screenshot({ path: path.join(screenshotsDir, '01-no-kanban-toggle.png'), fullPage: true });

    // Try to find any buttons that might be view toggles
    const allButtons = await page.locator('button').all();
    console.log(`Found ${allButtons.length} buttons on page`);
    for (let i = 0; i < Math.min(allButtons.length, 10); i++) {
      const text = await allButtons[i].textContent();
      const ariaLabel = await allButtons[i].getAttribute('aria-label');
      console.log(`Button ${i}: text="${text}", aria-label="${ariaLabel}"`);
    }
  } else {
    console.log('Step 4: Clicking kanban view toggle');
    await viewToggle.click();
    await page.waitForTimeout(1000);

    console.log('Waiting for kanban board to load');
    await page.screenshot({ path: path.join(screenshotsDir, '02-kanban-view-loaded.png'), fullPage: true });

    console.log('Step 5: Looking for session cards in kanban view');
    // Try to find a session card to click
    const cardSelectors = [
      '.kanban-card',
      '[data-card]',
      '.session-card',
      '.card'
    ];

    let sessionCard = null;
    for (const selector of cardSelectors) {
      try {
        sessionCard = await page.locator(selector).first();
        if (await sessionCard.count() > 0) {
          console.log(`Found session card with selector: ${selector}`);
          break;
        }
      } catch (e) {
        // Try next selector
      }
    }

    if (sessionCard && await sessionCard.count() > 0) {
      console.log('Step 6: Clicking on a session card');
      await sessionCard.click();
      await page.waitForTimeout(500);
      await page.screenshot({ path: path.join(screenshotsDir, '03-card-selected.png'), fullPage: true });

      console.log('Step 7: Pressing Ctrl+O to switch to sessions view');
      await page.keyboard.press('Control+O');

      console.log('Step 8: Taking screenshot immediately after Ctrl+O');
      await page.screenshot({ path: path.join(screenshotsDir, '04-immediate-after-ctrl-o.png'), fullPage: true });

      console.log('Step 9: Waiting 500ms and taking screenshot mid-animation');
      await page.waitForTimeout(500);
      await page.screenshot({ path: path.join(screenshotsDir, '05-mid-animation-500ms.png'), fullPage: true });

      console.log('Step 10: Waiting 2000ms for animation to complete');
      await page.waitForTimeout(2000);
      await page.screenshot({ path: path.join(screenshotsDir, '06-animation-complete.png'), fullPage: true });
    } else {
      console.log('No session cards found in kanban view');
      await page.screenshot({ path: path.join(screenshotsDir, '03-no-cards-found.png'), fullPage: true });
    }
  }

  console.log('Step 11: Checking browser console for FLIP or animation messages');
  const consoleLogs = [];
  page.on('console', msg => {
    const text = msg.text();
    consoleLogs.push(text);
    if (text.toLowerCase().includes('flip') || text.toLowerCase().includes('animation')) {
      console.log(`[BROWSER CONSOLE] ${text}`);
    }
  });

  // Get console messages
  await page.waitForTimeout(1000);

  console.log('\n=== All Console Messages ===');
  const allLogs = await page.evaluate(() => {
    return window.console.history || [];
  });

  if (allLogs.length > 0) {
    allLogs.forEach(log => console.log(`[CONSOLE] ${log}`));
  }

  console.log(`\nScreenshots saved to: ${screenshotsDir}`);

  await page.waitForTimeout(3000);
  await browser.close();
})();

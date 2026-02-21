const { test, expect } = require('@playwright/test');
const fs = require('fs');
const path = require('path');

test('Debug FLIP animation - capture console logs', async ({ page }) => {
  // Set viewport size
  await page.setViewportSize({ width: 1400, height: 900 });

  const consoleMessages = [];
  const flipMessages = [];
  const screenshotsDir = path.join(__dirname, 'flip-test-screenshots');

  // Create screenshots directory
  if (!fs.existsSync(screenshotsDir)) {
    fs.mkdirSync(screenshotsDir, { recursive: true });
  }

  // Set up console message capture BEFORE navigation
  page.on('console', msg => {
    const text = msg.text();
    consoleMessages.push({
      type: msg.type(),
      text: text,
      timestamp: new Date().toISOString()
    });

    if (text.includes('[FLIP DEBUG]')) {
      flipMessages.push({
        text: text,
        timestamp: new Date().toISOString()
      });
      console.log('>>> [FLIP DEBUG CAPTURED]:', text);
    }
  });

  // Also capture errors
  page.on('pageerror', error => {
    console.log('>>> PAGE ERROR:', error.message);
    consoleMessages.push({
      type: 'error',
      text: `PAGE ERROR: ${error.message}`,
      timestamp: new Date().toISOString()
    });
  });

  // Step 1-2: Navigate and take initial screenshot
  console.log('\n=== STEP 1-2: Navigating to http://localhost:5010 ===');
  await page.goto('http://localhost:5010', { waitUntil: 'networkidle' });
  await page.waitForTimeout(1000); // Wait for any animations
  await page.screenshot({ path: path.join(screenshotsDir, '1-initial-state.png'), fullPage: true });
  console.log('Screenshot saved: 1-initial-state.png');

  // Step 3-4: Find and click Kanban button
  console.log('\n=== STEP 4: Looking for Kanban button ===');

  // Look for Kanban button - try multiple selectors
  let kanbanButton = null;
  try {
    // Try text-based selector first
    kanbanButton = await page.getByText('Kanban', { exact: false }).first();
    await kanbanButton.waitFor({ timeout: 5000 });
    console.log('Found Kanban button by text');
  } catch (e) {
    console.log('Could not find Kanban button by text, trying other selectors...');
    // Try button with kanban in it
    kanbanButton = await page.locator('button:has-text("Kanban")').first();
  }

  console.log('Clicking Kanban button...');
  await kanbanButton.click();
  await page.waitForTimeout(1000);

  // Step 5: Screenshot kanban view
  console.log('\n=== STEP 5: Taking screenshot of Kanban view ===');
  await page.screenshot({ path: path.join(screenshotsDir, '2-kanban-view.png'), fullPage: true });
  console.log('Screenshot saved: 2-kanban-view.png');

  // Step 6-7: Find and click a card
  console.log('\n=== STEP 6: Looking for cards in Kanban view ===');

  // Wait for kanban cards to appear
  await page.waitForSelector('[class*="kanban"]', { timeout: 5000 });

  // Try to find a card - look for common card patterns
  const cardSelectors = [
    '[class*="card"]',
    '[class*="session-card"]',
    '[class*="kanban-card"]',
    '.card',
    '[data-session-id]'
  ];

  let card = null;
  for (const selector of cardSelectors) {
    try {
      const cards = await page.locator(selector).all();
      if (cards.length > 0) {
        card = cards[0];
        console.log(`Found ${cards.length} cards using selector: ${selector}`);
        break;
      }
    } catch (e) {
      continue;
    }
  }

  if (card) {
    console.log('Clicking on first card...');
    await card.click();
    await page.waitForTimeout(500);

    console.log('\n=== STEP 7: Taking screenshot of selected card ===');
    await page.screenshot({ path: path.join(screenshotsDir, '3-selected-card.png'), fullPage: true });
    console.log('Screenshot saved: 3-selected-card.png');
  } else {
    console.log('WARNING: Could not find any cards to click');
    await page.screenshot({ path: path.join(screenshotsDir, '3-no-cards-found.png'), fullPage: true });
  }

  // Step 8-9: Press Ctrl+O to trigger FLIP animation
  console.log('\n=== STEP 8: Pressing Ctrl+O to switch back to sessions view ===');
  console.log('FLIP DEBUG messages BEFORE Ctrl+O:', flipMessages.length);

  await page.keyboard.press('Control+O');
  await page.waitForTimeout(1500); // Wait for animation

  console.log('\n=== STEP 9: Taking screenshot after Ctrl+O ===');
  await page.screenshot({ path: path.join(screenshotsDir, '4-after-ctrl-o.png'), fullPage: true });
  console.log('Screenshot saved: 4-after-ctrl-o.png');
  console.log('FLIP DEBUG messages AFTER first Ctrl+O:', flipMessages.length);

  // Step 11: Toggle back and forth
  console.log('\n=== STEP 11: Toggling Ctrl+O again (to Kanban) ===');
  await page.keyboard.press('Control+O');
  await page.waitForTimeout(1500);
  await page.screenshot({ path: path.join(screenshotsDir, '5-back-to-kanban.png'), fullPage: true });
  console.log('Screenshot saved: 5-back-to-kanban.png');
  console.log('FLIP DEBUG messages after second Ctrl+O:', flipMessages.length);

  console.log('\n=== Pressing Ctrl+O again (to Sessions) ===');
  await page.keyboard.press('Control+O');
  await page.waitForTimeout(1500);
  await page.screenshot({ path: path.join(screenshotsDir, '6-back-to-sessions.png'), fullPage: true });
  console.log('Screenshot saved: 6-back-to-sessions.png');
  console.log('FLIP DEBUG messages after third Ctrl+O:', flipMessages.length);

  // Save all console messages to a file
  const reportPath = path.join(__dirname, 'flip-test-console-report.json');
  fs.writeFileSync(reportPath, JSON.stringify({
    allMessages: consoleMessages,
    flipMessages: flipMessages,
    totalMessages: consoleMessages.length,
    totalFlipMessages: flipMessages.length
  }, null, 2));

  console.log('\n=== FINAL REPORT ===');
  console.log(`Total console messages captured: ${consoleMessages.length}`);
  console.log(`Total FLIP DEBUG messages: ${flipMessages.length}`);
  console.log(`Full report saved to: ${reportPath}`);

  console.log('\n=== ALL [FLIP DEBUG] MESSAGES ===');
  flipMessages.forEach((msg, idx) => {
    console.log(`\n[${idx + 1}] ${msg.timestamp}`);
    console.log(msg.text);
  });

  if (flipMessages.length === 0) {
    console.log('\nWARNING: NO [FLIP DEBUG] MESSAGES WERE CAPTURED!');
  }
});

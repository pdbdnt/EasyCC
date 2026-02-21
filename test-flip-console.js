const { chromium } = require('playwright');

(async () => {
  const browser = await chromium.launch({ headless: false });
  const context = await browser.newContext({
    viewport: { width: 1920, height: 1080 }
  });
  const page = await context.newPage();

  // Capture all console messages
  const consoleMessages = [];
  page.on('console', msg => {
    const text = msg.text();
    const type = msg.type();
    consoleMessages.push({ type, text });
    console.log(`[${type.toUpperCase()}] ${text}`);
  });

  console.log('Navigating to http://localhost:5010');
  await page.goto('http://localhost:5010');
  await page.waitForLoadState('networkidle');
  await page.waitForTimeout(1000);

  console.log('\n=== Clicking Kanban View ===');
  await page.click('button:has-text("Kanban")');
  await page.waitForTimeout(1500);

  console.log('\n=== Clicking a session card ===');
  const card = page.locator('.session-card').first();
  await card.click();
  await page.waitForTimeout(500);

  console.log('\n=== Pressing Ctrl+O to switch to Sessions view ===');
  consoleMessages.length = 0; // Clear previous messages

  await page.keyboard.press('Control+O');

  // Wait for animation to complete
  await page.waitForTimeout(2500);

  console.log('\n=== Console Messages During Transition ===');
  const flipMessages = consoleMessages.filter(msg =>
    msg.text.toLowerCase().includes('flip') ||
    msg.text.toLowerCase().includes('animation') ||
    msg.text.toLowerCase().includes('kanban') ||
    msg.text.toLowerCase().includes('transition')
  );

  if (flipMessages.length === 0) {
    console.log('No FLIP/animation related messages found');
    console.log('\nAll console messages during transition:');
    consoleMessages.forEach(msg => {
      console.log(`  [${msg.type}] ${msg.text}`);
    });
  } else {
    flipMessages.forEach(msg => {
      console.log(`  [${msg.type}] ${msg.text}`);
    });
  }

  await page.waitForTimeout(2000);
  await browser.close();
})();

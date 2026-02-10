// Quick script to launch Electron, create a session, and dump DOM snapshots of both views
const { _electron: electron } = require('@playwright/test');
const path = require('path');

(async () => {
  console.log('Launching Electron...');
  const app = await electron.launch({
    args: [path.join(__dirname, '..', 'electron', 'main.js')],
    timeout: 30000,
  });

  const page = await app.firstWindow();
  page.on('dialog', async (d) => d.accept().catch(() => {}));
  await page.waitForLoadState('domcontentloaded');
  await page.waitForSelector('#root', { timeout: 15000 });
  console.log('App loaded. Creating test session...');

  // Create a test session via API
  const res = await page.evaluate(async () => {
    const r = await fetch('http://localhost:5010/api/sessions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Snapshot-Test', workingDir: 'C:\\Users\\denni\\apps\\CLIOverlord', cliType: 'claude' })
    });
    return r.json();
  });
  console.log('Session created:', res.session?.id, 'linkedTaskId:', res.session?.linkedTaskId);

  await page.waitForTimeout(3000);

  // Snapshot sessions view
  console.log('\n=== SESSIONS VIEW ===');
  const sessionsHTML = await page.evaluate(() => {
    const sidebar = document.querySelector('.sessions-sidebar');
    return sidebar ? sidebar.innerHTML.substring(0, 3000) : 'NO .sessions-sidebar found';
  });
  console.log(sessionsHTML.substring(0, 2000));

  // Check view toggle buttons
  const viewBtns = await page.locator('.view-toggle-btn').allTextContents();
  console.log('\nView toggle buttons:', viewBtns);

  // Switch to kanban
  await page.locator('.view-toggle-btn').filter({ hasText: 'Kanban' }).click();
  await page.waitForTimeout(2000);

  console.log('\n=== KANBAN VIEW ===');
  const kanbanExists = await page.locator('.kanban-board').isVisible();
  console.log('kanban-board visible:', kanbanExists);

  if (kanbanExists) {
    const columns = await page.locator('.kanban-column').count();
    console.log('Column count:', columns);

    for (let i = 0; i < columns; i++) {
      const col = page.locator('.kanban-column').nth(i);
      const title = await col.locator('.column-title').textContent().catch(() => 'N/A');
      const cards = await col.locator('.task-card').count();
      const linkedCards = await col.locator('.task-card-linked').count();
      console.log(`  Column ${i}: "${title}" — ${cards} cards (${linkedCards} linked)`);
    }

    // Dump first task-card-linked HTML
    const firstLinked = page.locator('.task-card-linked').first();
    if (await firstLinked.isVisible().catch(() => false)) {
      const html = await firstLinked.evaluate(el => el.outerHTML);
      console.log('\nFirst linked card HTML:');
      console.log(html.substring(0, 2000));
    } else {
      console.log('\nNo .task-card-linked visible!');
      // Check if any task-card exists at all
      const anyCard = page.locator('.task-card').first();
      if (await anyCard.isVisible().catch(() => false)) {
        const html = await anyCard.evaluate(el => el.outerHTML);
        console.log('First .task-card HTML:');
        console.log(html.substring(0, 2000));
      }
    }
  }

  // Check filter chip in sessions view
  await page.locator('.view-toggle-btn').filter({ hasText: 'Sessions' }).click();
  await page.waitForTimeout(500);
  const chipVisible = await page.locator('.kanban-filter-chip').isVisible();
  console.log('\nFilter chip visible in sessions:', chipVisible);

  // Cleanup
  if (res.session?.id) {
    await page.evaluate(async (id) => {
      await fetch(`http://localhost:5010/api/sessions/${id}`, { method: 'DELETE' });
    }, res.session.id);
  }

  try { process.kill(app.process().pid, 'SIGKILL'); } catch {}
  console.log('\nDone.');
})();

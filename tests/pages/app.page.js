class AppPage {
  constructor(page) {
    this.page = page;
    this.sessionsViewBtn = page.locator('.view-toggle-btn').filter({ hasText: 'Sessions' });
    this.kanbanViewBtn = page.locator('.view-toggle-btn').filter({ hasText: 'Kanban' });
    this.activeViewBtn = page.locator('.view-toggle-btn.active');
    this.sessionsList = page.locator('.sessions-list');
    this.kanbanBoard = page.locator('.kanban-board');
  }

  async switchToKanban() {
    await this.kanbanViewBtn.click();
    await this.kanbanBoard.waitFor({ state: 'visible', timeout: 5000 });
  }

  async switchToSessions() {
    await this.sessionsViewBtn.click();
    await this.sessionsList.waitFor({ state: 'visible', timeout: 5000 });
  }

  async pressCtrlO() {
    await this.page.keyboard.press('Control+o');
    // Small wait for view transition
    await this.page.waitForTimeout(300);
  }

  async isInSessionsView() {
    return this.sessionsList.isVisible();
  }

  async isInKanbanView() {
    return this.kanbanBoard.isVisible();
  }
}

module.exports = AppPage;

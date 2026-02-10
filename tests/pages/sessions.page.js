class SessionsPage {
  constructor(page) {
    this.page = page;
    this.filterChip = page.locator('.kanban-filter-chip');
    this.filterChipText = page.locator('.kanban-filter-chip span').first();
    this.filterChipClear = page.locator('.kanban-filter-chip button');
    this.sessionCards = page.locator('.session-card');
    this.selectedCard = page.locator('.session-card.selected');
  }

  sessionByName(name) {
    return this.page.locator('.session-card').filter({ hasText: name });
  }
}

module.exports = SessionsPage;

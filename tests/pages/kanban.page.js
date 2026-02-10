class KanbanPage {
  constructor(page) {
    this.page = page;
  }

  column(stageName) {
    return this.page.locator('.kanban-column').filter({
      has: this.page.locator('.column-title').filter({ hasText: stageName })
    });
  }

  linkedCard(name) {
    return this.page.locator('.task-card-linked').filter({ hasText: name });
  }

  unlinkedCard(title) {
    return this.page.locator('.task-card:not(.task-card-linked)').filter({ hasText: title });
  }

  cardCliBadge(card) {
    return card.locator('.cli-type-badge');
  }

  cardStatus(card) {
    return card.locator('.task-card-status');
  }

  cardCurrentTask(card) {
    return card.locator('.task-card-current-task');
  }

  cardNotes(card) {
    return card.locator('.task-card-notes');
  }

  cardTags(card) {
    return card.locator('.session-tag');
  }

  cardTagOverflow(card) {
    return card.locator('.session-tag-more');
  }

  cardPausedOverlay(card) {
    return card.locator('.paused-overlay');
  }

  cardPausedBadge(card) {
    return card.locator('.paused-badge');
  }

  cardManualBadge(card) {
    return card.locator('.task-manual-badge');
  }

  cardDetailsBtn(card) {
    return card.locator('.task-card-details-btn');
  }

  cardTime(card) {
    return card.locator('.task-card-time');
  }

  projectSubheader(name) {
    return this.page.locator('.kanban-project-subheader').filter({ hasText: name });
  }
}

module.exports = KanbanPage;

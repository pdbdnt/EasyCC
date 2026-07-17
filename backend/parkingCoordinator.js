const { randomUUID } = require('crypto');

const DEFAULTS = {
  enabled: true,
  confirmBeforeParking: true,
  maxLiveAiSessions: 6,
  idleMinutes: 15,
  snoozeMinutes: 15
};
const AI_TYPES = new Set(['claude', 'codex', 'codex-windows']);

class ParkingCoordinator {
  constructor({ sessionManager, settingsManager, broadcast, now = () => Date.now() }) {
    this.sessionManager = sessionManager;
    this.settingsManager = settingsManager;
    this.broadcast = broadcast;
    this.now = now;
    this.clients = new Map();
    this.snoozedUntil = new Map();
    this.timer = null;
  }

  start() {
    if (this.timer) return;
    this.timer = setInterval(() => this.evaluate(), 30_000);
    this.timer.unref?.();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    for (const client of this.clients.values()) {
      if (client.initTimer) clearTimeout(client.initTimer);
    }
    this.clients.clear();
  }

  settings() {
    return {
      ...DEFAULTS,
      ...(this.settingsManager.loadSettings().session?.autoParking || {})
    };
  }

  registerClient(socket) {
    const clientId = randomUUID();
    const record = {
      clientId,
      socket,
      initialized: false,
      focused: false,
      minimized: false,
      visibleSessionIds: new Set(),
      lastSeenAt: this.now(),
      focusedAt: 0,
      initTimer: null
    };
    record.initTimer = setTimeout(() => {
      const current = this.clients.get(clientId);
      if (current && !current.initialized) {
        try { current.socket.close(4000, 'presence_required'); } catch {}
        this.removeClient(clientId);
      }
    }, 5000);
    record.initTimer.unref?.();
    this.clients.set(clientId, record);
    return clientId;
  }

  updatePresence(clientId, payload = {}) {
    const client = this.clients.get(clientId);
    if (!client) return false;
    if (client.initTimer) clearTimeout(client.initTimer);
    client.initTimer = null;
    client.initialized = true;
    client.focused = payload.focused === true;
    client.minimized = payload.minimized === true;
    client.visibleSessionIds = new Set(
      Array.isArray(payload.visibleSessionIds)
        ? payload.visibleSessionIds.filter(value => typeof value === 'string')
        : []
    );
    client.lastSeenAt = this.now();
    if (client.focused && !client.minimized) client.focusedAt = client.lastSeenAt;
    this.evaluate();
    return true;
  }

  removeClient(clientId) {
    const client = this.clients.get(clientId);
    if (client?.initTimer) clearTimeout(client.initTimer);
    this.clients.delete(clientId);
    this.evaluate();
  }

  pruneClients() {
    const cutoff = this.now() - 45_000;
    for (const [clientId, client] of this.clients) {
      if (client.initialized && client.lastSeenAt < cutoff) this.clients.delete(clientId);
    }
  }

  isVisible(sessionId) {
    this.pruneClients();
    for (const client of this.clients.values()) {
      if (!client.initialized) return true;
      if (client.visibleSessionIds.has(sessionId)) return true;
    }
    return false;
  }

  modalOwnerClientId() {
    return [...this.clients.values()]
      .filter(client => client.initialized && client.focused && !client.minimized)
      .sort((a, b) => b.focusedAt - a.focusedAt || a.clientId.localeCompare(b.clientId))[0]?.clientId || null;
  }

  getLiveAiSessions() {
    return [...this.sessionManager.sessions.values()].filter(session =>
      AI_TYPES.has(session.cliType || 'claude') &&
      session.pty &&
      ['live', 'parking', 'resuming', 'parking_failed_live', 'wake_failed_live']
        .includes(session.runtimeState || 'live')
    );
  }

  getCandidateReason(session, config, forceCap = false) {
    const now = this.now();
    const snoozedUntil = this.snoozedUntil.get(session.id) || 0;
    if (snoozedUntil > now) return null;
    if (!this.sessionManager.isParkingEligible(session) || this.isVisible(session.id)) return null;
    const readySinceMs = new Date(session.readySince || 0).getTime();
    if (forceCap) return 'live_cap';
    if (readySinceMs && now - readySinceMs >= config.idleMinutes * 60_000) return 'idle_timeout';
    return null;
  }

  evaluate() {
    const config = this.settings();
    const sessions = [...this.sessionManager.sessions.values()];
    for (const session of sessions) {
      if (session.parkingProposalState === 'pending_review' &&
          (!config.enabled || !this.sessionManager.isParkingEligible(session) || this.isVisible(session.id))) {
        this.clearProposal(session);
      }
    }
    if (!config.enabled) return this.publish();

    const live = this.getLiveAiSessions();
    const ordered = live
      .filter(session => this.sessionManager.isParkingEligible(session) && !this.isVisible(session.id))
      .sort((a, b) => {
        const aTime = new Date(a.lastUserOrOrchestratorActivityAt || a.lastActivity || 0).getTime();
        const bTime = new Date(b.lastUserOrOrchestratorActivityAt || b.lastActivity || 0).getTime();
        return aTime - bTime || a.id.localeCompare(b.id);
      });

    let capNeeded = Math.max(0, live.length - config.maxLiveAiSessions);
    for (const session of ordered) {
      const reason = this.getCandidateReason(session, config, capNeeded > 0);
      if (!reason) continue;
      if (reason === 'live_cap' && capNeeded <= 0) continue;
      if (session.parkingProposalState !== 'pending_review') {
        session.parkingProposalState = 'pending_review';
        session.parkingProposalReason = reason;
        session.parkingDetectedAt = new Date(this.now()).toISOString();
        session.parkingSnoozedUntil = null;
        this.sessionManager.emit('sessionUpdated', this.sessionManager.getSessionSnapshot(session));
        this.log('parking_proposed', session, reason);
      }
      if (reason === 'live_cap') capNeeded -= 1;
    }
    this.publish();
    return this.getSummary();
  }

  clearProposal(session) {
    session.parkingProposalState = 'none';
    session.parkingProposalReason = null;
    session.parkingDetectedAt = null;
    session.parkingSnoozedUntil = null;
    this.sessionManager.emit('sessionUpdated', this.sessionManager.getSessionSnapshot(session));
  }

  snooze(sessionIds) {
    const until = this.now() + this.settings().snoozeMinutes * 60_000;
    const snoozed = [];
    for (const id of new Set(sessionIds || [])) {
      const session = this.sessionManager.sessions.get(id);
      if (!session) continue;
      this.snoozedUntil.set(id, until);
      session.parkingProposalState = 'snoozed';
      session.parkingSnoozedUntil = new Date(until).toISOString();
      session.parkingProposalReason = null;
      session.parkingDetectedAt = null;
      snoozed.push(id);
      this.sessionManager.emit('sessionUpdated', this.sessionManager.getSessionSnapshot(session));
      this.log('parking_snoozed', session, 'not_now');
    }
    this.publish();
    return snoozed;
  }

  async confirm(sessionIds) {
    const parked = [];
    const parkedSessions = [];
    const skipped = [];
    for (const id of new Set(sessionIds || [])) {
      const session = this.sessionManager.sessions.get(id);
      if (!session || session.parkingProposalState !== 'pending_review' ||
          !this.sessionManager.isParkingEligible(session) || this.isVisible(id)) {
        skipped.push({ id, reason: 'no_longer_eligible' });
        continue;
      }
      const reason = session.parkingProposalReason;
      const result = await this.sessionManager.parkSession(id, { reason });
      if (result.ok) {
        parked.push(id);
        parkedSessions.push(result.session);
        this.log('parked', session, reason);
      }
      else skipped.push({ id, reason: result.error || 'parking_failed' });
    }
    this.evaluate();
    return { parked, parkedSessions, skipped, summary: this.getSummary() };
  }

  getSummary() {
    const sessions = [...this.sessionManager.sessions.values()];
    const currentParked = sessions
      .filter(session => session.runtimeState === 'auto_parked')
      .map(session => this.sessionManager.getSessionSnapshot(session));
    const review = sessions
      .filter(session => session.parkingProposalState === 'pending_review')
      .map(session => this.sessionManager.getSessionSnapshot(session));
    return {
      live: this.getLiveAiSessions().length,
      parked: currentParked.length,
      review: review.length,
      currentParked,
      reviewSessions: review,
      modalOwnerClientId: this.modalOwnerClientId()
    };
  }

  publish() {
    this.broadcast({ type: 'parkingSummary', summary: this.getSummary() });
  }

  log(eventType, session, reason, result = 'ok') {
    const summary = this.getSummary();
    this.sessionManager.dataStore.logParkingEvent({
      timestamp: new Date(this.now()).toISOString(),
      eventType,
      sessionId: session.id,
      sessionName: session.name,
      project: session.repoName || session.groupKey || session.workingDir,
      cliType: session.cliType || 'claude',
      reason,
      result,
      live: summary.live,
      parked: summary.parked,
      review: summary.review
    });
  }
}

module.exports = { ParkingCoordinator, DEFAULTS };

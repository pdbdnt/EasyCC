const fs = require('fs');
const path = require('path');

/**
 * Handles persistent storage of session data to disk
 */
class DataStore {
  constructor(dataDir = path.join(__dirname, '..', 'data')) {
    this.dataDir = dataDir;
    this.sessionsFile = path.join(dataDir, 'sessions.json');
    this.ensureDataDir();
  }

  /**
   * Ensure the data directory exists
   */
  ensureDataDir() {
    if (!fs.existsSync(this.dataDir)) {
      fs.mkdirSync(this.dataDir, { recursive: true });
    }
  }

  /**
   * Load all sessions from disk
   * @returns {object} Sessions object with session IDs as keys
   */
  loadSessions() {
    try {
      if (!fs.existsSync(this.sessionsFile)) {
        return {};
      }

      const data = fs.readFileSync(this.sessionsFile, 'utf8');
      const parsed = JSON.parse(data);
      return parsed.sessions || {};
    } catch (error) {
      console.error('Error loading sessions:', error.message);
      return {};
    }
  }

  /**
   * Save a session to disk
   * @param {object} session - Session object to save
   */
  saveSession(session) {
    try {
      const sessions = this.loadSessions();

      // Extract serializable data (exclude PTY reference)
      sessions[session.id] = {
        id: session.id,
        name: session.name,
        workingDir: session.workingDir,
        cliType: session.cliType || 'claude',
        createdAt: session.createdAt instanceof Date
          ? session.createdAt.toISOString()
          : session.createdAt,
        lastActivity: session.lastActivity instanceof Date
          ? session.lastActivity.toISOString()
          : session.lastActivity,
        status: session.status,
        claudeSessionId: session.claudeSessionId || null,
        claudeSessionName: session.claudeSessionName || null,
        notes: session.notes || '',
        tags: session.tags || [],
        plans: session.plans || [],
        currentTask: session.currentTask || '',
        promptHistory: session.promptHistory || []
      };

      this.writeSessionsFile(sessions);
    } catch (error) {
      console.error('Error saving session:', error.message);
    }
  }

  /**
   * Delete a session from disk
   * @param {string} id - Session ID to delete
   * @returns {boolean} Success status
   */
  deleteSession(id) {
    try {
      const sessions = this.loadSessions();

      if (!sessions[id]) {
        return false;
      }

      delete sessions[id];
      this.writeSessionsFile(sessions);
      return true;
    } catch (error) {
      console.error('Error deleting session:', error.message);
      return false;
    }
  }

  /**
   * Update session metadata (notes, tags, etc.)
   * @param {string} id - Session ID
   * @param {object} meta - Metadata to update
   * @returns {object|null} Updated session or null if not found
   */
  updateSessionMeta(id, meta) {
    try {
      const sessions = this.loadSessions();

      if (!sessions[id]) {
        return null;
      }

      // Update allowed metadata fields
      const allowedFields = ['name', 'notes', 'tags', 'plans', 'claudeSessionId', 'status', 'lastActivity'];

      for (const field of allowedFields) {
        if (meta[field] !== undefined) {
          sessions[id][field] = meta[field];
        }
      }

      this.writeSessionsFile(sessions);
      return sessions[id];
    } catch (error) {
      console.error('Error updating session meta:', error.message);
      return null;
    }
  }

  /**
   * Get a single session by ID
   * @param {string} id - Session ID
   * @returns {object|null} Session object or null
   */
  getSession(id) {
    const sessions = this.loadSessions();
    return sessions[id] || null;
  }

  /**
   * Add a plan to a session
   * @param {string} sessionId - Session ID
   * @param {string} planPath - Path to the plan file
   * @returns {boolean} Success status
   */
  addPlanToSession(sessionId, planPath) {
    try {
      const sessions = this.loadSessions();

      if (!sessions[sessionId]) {
        return false;
      }

      if (!sessions[sessionId].plans) {
        sessions[sessionId].plans = [];
      }

      // Don't add duplicates
      if (!sessions[sessionId].plans.includes(planPath)) {
        sessions[sessionId].plans.push(planPath);
        this.writeSessionsFile(sessions);
      }

      return true;
    } catch (error) {
      console.error('Error adding plan to session:', error.message);
      return false;
    }
  }

  /**
   * Write sessions to file
   * @param {object} sessions - Sessions object
   */
  writeSessionsFile(sessions) {
    const data = JSON.stringify({ sessions }, null, 2);
    fs.writeFileSync(this.sessionsFile, data, 'utf8');
  }
}

module.exports = DataStore;

const fs = require('fs');
const path = require('path');

/**
 * Handles persistent storage of session, task, and stage data to disk
 */
class DataStore {
  constructor(dataDir = path.join(__dirname, '..', 'data')) {
    this.dataDir = dataDir;
    this.sessionsFile = path.join(dataDir, 'sessions.json');
    this.tasksFile = path.join(dataDir, 'tasks.json');
    this.stagesFile = path.join(dataDir, 'stages.json');
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
        promptHistory: session.promptHistory || [],
        // Kanban stage fields
        stage: session.stage || 'todo',
        priority: session.priority || 0,
        description: session.description || '',
        blockedBy: session.blockedBy || [],
        blocks: session.blocks || [],
        manuallyPlaced: session.manuallyPlaced || false,
        manualPlacedAt: session.manualPlacedAt || null,
        rejectionHistory: session.rejectionHistory || [],
        completedAt: session.completedAt || null,
        updatedAt: session.updatedAt || null,
        comments: session.comments || []
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
      const allowedFields = ['name', 'notes', 'tags', 'plans', 'claudeSessionId', 'status', 'lastActivity',
        'stage', 'priority', 'description', 'blockedBy', 'blocks', 'manuallyPlaced', 'manualPlacedAt',
        'rejectionHistory', 'completedAt', 'updatedAt', 'comments'];

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

  // ============================================
  // Task Persistence Methods
  // ============================================

  /**
   * Load all tasks from disk
   * @returns {object} Tasks data with tasks object and stages array
   */
  loadTasks() {
    try {
      if (!fs.existsSync(this.tasksFile)) {
        return { tasks: {}, stages: [] };
      }

      const data = fs.readFileSync(this.tasksFile, 'utf8');
      const parsed = JSON.parse(data);
      return {
        tasks: parsed.tasks || {},
        stages: parsed.stages || []
      };
    } catch (error) {
      console.error('Error loading tasks:', error.message);
      return { tasks: {}, stages: [] };
    }
  }

  /**
   * Save tasks and stages to disk
   * @param {object} data - Object with tasks and stages
   */
  saveTasks(data) {
    try {
      const fileData = JSON.stringify({
        tasks: data.tasks || {},
        stages: data.stages || []
      }, null, 2);
      fs.writeFileSync(this.tasksFile, fileData, 'utf8');
    } catch (error) {
      console.error('Error saving tasks:', error.message);
    }
  }

  /**
   * Save a single task (updates the tasks file)
   * @param {object} task - Task object to save
   */
  saveTask(task) {
    try {
      const data = this.loadTasks();
      data.tasks[task.id] = task;
      this.saveTasks(data);
    } catch (error) {
      console.error('Error saving task:', error.message);
    }
  }

  /**
   * Delete a task from disk
   * @param {string} taskId - Task ID to delete
   * @returns {boolean} Success status
   */
  deleteTask(taskId) {
    try {
      const data = this.loadTasks();
      if (!data.tasks[taskId]) {
        return false;
      }
      delete data.tasks[taskId];
      this.saveTasks(data);
      return true;
    } catch (error) {
      console.error('Error deleting task:', error.message);
      return false;
    }
  }

  /**
   * Get a single task by ID
   * @param {string} taskId - Task ID
   * @returns {object|null} Task object or null
   */
  getTask(taskId) {
    const data = this.loadTasks();
    return data.tasks[taskId] || null;
  }

  // ============================================
  // Stages Persistence Methods
  // ============================================

  /**
   * Load stages configuration from disk
   * @returns {array} Stages array
   */
  loadStages() {
    try {
      if (!fs.existsSync(this.stagesFile)) {
        return [];
      }

      const data = fs.readFileSync(this.stagesFile, 'utf8');
      const parsed = JSON.parse(data);
      return parsed.stages || [];
    } catch (error) {
      console.error('Error loading stages:', error.message);
      return [];
    }
  }

  /**
   * Save stages configuration to disk
   * @param {array} stages - Stages array
   */
  saveStages(stages) {
    try {
      const data = JSON.stringify({ stages }, null, 2);
      fs.writeFileSync(this.stagesFile, data, 'utf8');
    } catch (error) {
      console.error('Error saving stages:', error.message);
    }
  }

  /**
   * Log a task transition (for audit/analytics)
   * @param {object} transition - Transition details
   */
  async logTransition(transition) {
    try {
      const transitionsFile = path.join(this.dataDir, 'transitions.log');
      const logEntry = JSON.stringify(transition) + '\n';
      fs.appendFileSync(transitionsFile, logEntry, 'utf8');
    } catch (error) {
      console.error('Error logging transition:', error.message);
    }
  }

  /**
   * Get recent transitions (last N entries)
   * @param {number} limit - Number of transitions to retrieve
   * @returns {Array} Recent transitions
   */
  getRecentTransitions(limit = 100) {
    try {
      const transitionsFile = path.join(this.dataDir, 'transitions.log');
      if (!fs.existsSync(transitionsFile)) {
        return [];
      }

      const data = fs.readFileSync(transitionsFile, 'utf8');
      const lines = data.trim().split('\n');
      const transitions = lines
        .slice(-limit)
        .map(line => {
          try {
            return JSON.parse(line);
          } catch {
            return null;
          }
        })
        .filter(Boolean);

      return transitions.reverse(); // Most recent first
    } catch (error) {
      console.error('Error reading transitions:', error.message);
      return [];
    }
  }
}

module.exports = DataStore;

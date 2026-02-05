const EventEmitter = require('events');
const pty = require('node-pty');
const { v4: uuidv4 } = require('uuid');
const fs = require('fs');
const path = require('path');
const os = require('os');
const DataStore = require('./dataStore');
const PlanManager = require('./planManager');

/**
 * Ring buffer for storing terminal output with a maximum size
 */
class RingBuffer {
  constructor(maxSize = 500) {
    this.buffer = [];
    this.maxSize = maxSize;
  }

  push(item) {
    this.buffer.push(item);
    if (this.buffer.length > this.maxSize) {
      this.buffer.shift();
    }
  }

  getAll() {
    return [...this.buffer];
  }

  clear() {
    this.buffer = [];
  }
}

/**
 * Manages multiple Claude CLI sessions using pseudo-terminals
 */
class SessionManager extends EventEmitter {
  constructor() {
    super();
    this.sessions = new Map();
    this.dataStore = new DataStore();
    this.planManager = new PlanManager();
    this.isShuttingDown = false;  // Prevents onExit handlers from deleting sessions during shutdown

    // Load persisted sessions on startup
    this.loadPersistedSessions();

    // Start watching for new plans
    this.setupPlanWatcher();
  }

  /**
   * Load persisted sessions from disk
   * - Restores any session with a claudeSessionId (can be resumed)
   * - Cleans up completed sessions or sessions without claudeSessionId
   */
  loadPersistedSessions() {
    const persistedSessions = this.dataStore.loadSessions();

    for (const [id, sessionData] of Object.entries(persistedSessions)) {
      // Clean up completed sessions
      if (sessionData.status === 'completed') {
        this.dataStore.deleteSession(id);
        console.log(`Cleaned up completed session: ${sessionData.name} (${id})`);
        continue;
      }

      // Restore sessions that can be resumed:
      // - Claude sessions with claudeSessionId
      // - Codex sessions (which use 'resume --last' and don't need a session ID)
      const cliType = sessionData.cliType || 'claude';
      const canResume = cliType === 'codex' || sessionData.claudeSessionId;

      if (canResume) {
        const session = {
          id: sessionData.id,
          name: sessionData.name,
          // Mark previously active sessions as paused (since they have no PTY now)
          status: 'paused',
          currentTask: sessionData.currentTask || '',
          createdAt: new Date(sessionData.createdAt),
          lastActivity: new Date(sessionData.lastActivity),
          outputBuffer: new RingBuffer(500),
          pty: null,
          workingDir: sessionData.workingDir,
          cliType: cliType,
          claudeSessionId: sessionData.claudeSessionId,
          claudeSessionName: sessionData.claudeSessionName || null,
          notes: sessionData.notes || '',
          tags: sessionData.tags || [],
          plans: sessionData.plans || [],
          promptBuffer: '',
          promptHistory: sessionData.promptHistory || [],
          inEscapeSeq: false
        };

        this.sessions.set(id, session);
        // Update persisted status to paused
        this.dataStore.saveSession(session);
        const resumeInfo = cliType === 'codex' ? 'Codex (resume --last)' : `Claude session ${session.claudeSessionId}`;
        console.log(`Restored session: ${session.name} (${id}) - can be resumed with ${resumeInfo}`);
      } else {
        // No claudeSessionId for Claude session = can't resume, clean up
        this.dataStore.deleteSession(id);
        console.log(`Cleaned up orphaned session (no claudeSessionId): ${sessionData.name} (${id})`);
      }
    }
  }

  /**
   * Get the Claude projects directory path for a working directory
   * @param {string} workingDir - Working directory path
   * @returns {string} Path to the Claude project directory
   */
  getClaudeProjectPath(workingDir) {
    // Convert path to Claude's format: C:\Users\denni\apps\foo -> C--Users-denni-apps-foo
    // Colon and backslashes both become dashes (colon becomes a dash, not removed)
    const normalizedPath = workingDir.replace(/[\\:]/g, '-');
    return path.join(os.homedir(), '.claude', 'projects', normalizedPath);
  }

  /**
   * Read Claude's sessions-index.json to get session metadata
   * Falls back to scanning JSONL files if index doesn't exist
   * @param {string} workingDir - Working directory path
   * @returns {Array} Array of Claude session entries
   */
  getClaudeSessions(workingDir) {
    try {
      const projectPath = this.getClaudeProjectPath(workingDir);
      const indexPath = path.join(projectPath, 'sessions-index.json');

      // Try to read from sessions-index.json first
      if (fs.existsSync(indexPath)) {
        const data = JSON.parse(fs.readFileSync(indexPath, 'utf8'));
        return data.entries || [];
      }

      // Fallback: scan for JSONL files directly
      if (!fs.existsSync(projectPath)) {
        return [];
      }

      const files = fs.readdirSync(projectPath);
      const sessions = [];

      for (const file of files) {
        if (file.endsWith('.jsonl')) {
          const sessionId = file.replace('.jsonl', '');
          const filePath = path.join(projectPath, file);
          const stats = fs.statSync(filePath);

          sessions.push({
            sessionId,
            fullPath: filePath,
            modified: stats.mtime.toISOString(),
            created: stats.birthtime.toISOString()
          });
        }
      }

      return sessions;
    } catch (error) {
      console.error('Error reading Claude sessions:', error.message);
      return [];
    }
  }

  /**
   * Find the most recent Claude session for a working directory
   * @param {string} workingDir - Working directory path
   * @returns {object|null} Most recent session entry or null
   */
  getMostRecentClaudeSession(workingDir) {
    const sessions = this.getClaudeSessions(workingDir);
    if (sessions.length === 0) return null;

    // Sort by modified date descending
    sessions.sort((a, b) => new Date(b.modified) - new Date(a.modified));
    return sessions[0];
  }

  /**
   * Watch Claude's sessions directory for updates
   * @param {string} workingDir - Working directory
   * @param {function} callback - Called when sessions change
   */
  watchClaudeSessionsIndex(workingDir, callback) {
    try {
      const projectPath = this.getClaudeProjectPath(workingDir);

      // Check if directory exists
      if (!fs.existsSync(projectPath)) {
        return null;
      }

      const indexPath = path.join(projectPath, 'sessions-index.json');

      // Prefer watching sessions-index.json if it exists
      if (fs.existsSync(indexPath)) {
        const watcher = fs.watch(indexPath, { persistent: false }, (eventType) => {
          if (eventType === 'change') {
            const sessions = this.getClaudeSessions(workingDir);
            if (callback) {
              callback(sessions);
            }
          }
        });
        return watcher;
      }

      // Fallback: watch the directory for new JSONL files
      const watcher = fs.watch(projectPath, { persistent: false }, (eventType, filename) => {
        if (filename && filename.endsWith('.jsonl')) {
          const sessions = this.getClaudeSessions(workingDir);
          if (callback) {
            callback(sessions);
          }
        }
      });

      return watcher;
    } catch (error) {
      console.error('Error watching Claude sessions:', error.message);
      return null;
    }
  }

  /**
   * Setup watcher for new and updated plan files
   */
  setupPlanWatcher() {
    this.planManager.watchPlans((plan) => {
      console.log('Plan change detected:', plan.filename);

      // Try to match plan with active session - use Claude session ID for exact matching
      const activeSessions = [...this.sessions.values()]
        .filter(s => s.status !== 'paused' && s.status !== 'completed')
        .sort((a, b) => new Date(b.lastActivity) - new Date(a.lastActivity)); // Most recent first

      for (const session of activeSessions) {
        // Check if plan's working dir EXACTLY matches session's working dir
        if (plan.workingDir && session.workingDir) {
          const normalizedPlanDir = plan.workingDir.toLowerCase().replace(/\\/g, '/').replace(/\/$/, '');
          const normalizedSessionDir = session.workingDir.toLowerCase().replace(/\\/g, '/').replace(/\/$/, '');

          // Exact match only - don't allow parent/child directory matches
          if (normalizedPlanDir === normalizedSessionDir) {
            this.addOrUpdatePlanInSession(session.id, plan.path);
            break;
          }
        }
      }
    });
  }

  /**
   * Add a plan to a session or notify of update if already exists
   * @param {string} sessionId - Session ID
   * @param {string} planPath - Path to plan file
   */
  addOrUpdatePlanInSession(sessionId, planPath) {
    const session = this.sessions.get(sessionId);
    if (!session) return;

    if (!session.plans) {
      session.plans = [];
    }

    const isNew = !session.plans.includes(planPath);

    if (isNew) {
      session.plans.push(planPath);
      this.dataStore.addPlanToSession(sessionId, planPath);
    }

    // Always emit sessionUpdated (for both new and updated plans)
    // Include a timestamp so frontend knows something changed
    this.emit('sessionUpdated', {
      sessionId,
      plans: session.plans,
      plansUpdatedAt: Date.now()
    });
  }

  /**
   * Scan for plans tracked by Claude's session
   * Uses Claude's session transcript to find plans that were edited during that session
   * @param {string} sessionId - Our session ID
   */
  scanExistingPlansForSession(sessionId) {
    const session = this.sessions.get(sessionId);
    if (!session) return;

    // If we have a Claude session ID, get plans from Claude's tracking
    if (session.claudeSessionId && session.workingDir) {
      const planPaths = this.planManager.getPlansForClaudeSession(
        session.claudeSessionId,
        session.workingDir
      );

      for (const planPath of planPaths) {
        this.addPlanToSession(sessionId, planPath);
      }
    }
  }

  /**
   * Add a plan to a session
   * @param {string} sessionId - Session ID
   * @param {string} planPath - Path to plan file
   */
  addPlanToSession(sessionId, planPath) {
    const session = this.sessions.get(sessionId);
    if (!session) return;

    if (!session.plans) {
      session.plans = [];
    }

    if (!session.plans.includes(planPath)) {
      session.plans.push(planPath);
      this.dataStore.addPlanToSession(sessionId, planPath);

      this.emit('sessionUpdated', {
        sessionId,
        plans: session.plans
      });
    }
  }

  /**
   * Convert Windows path to WSL path
   * @param {string} windowsPath - Windows path (e.g., C:\Users\foo)
   * @returns {string} WSL path (e.g., /mnt/c/Users/foo)
   */
  convertToWslPath(windowsPath) {
    const normalized = windowsPath.replace(/\\/g, '/');
    const match = normalized.match(/^([A-Za-z]):(.*)/);
    if (match) {
      return `/mnt/${match[1].toLowerCase()}${match[2]}`;
    }
    return windowsPath;
  }

  /**
   * Create a new Claude CLI session
   * @param {string} name - Session name
   * @param {string} workingDir - Working directory for the session
   * @param {string} cliType - CLI type ('claude' or 'codex')
   * @returns {object} Session snapshot
   */
  createSession(name, workingDir = process.cwd(), cliType = 'claude') {
    const id = uuidv4();
    const claudeSessionId = uuidv4(); // Generate Claude session ID upfront
    const now = new Date();

    // Determine shell and command based on platform and CLI type
    const isWindows = process.platform === 'win32';
    let ptyProcess;

    try {
      if (isWindows) {
        if (cliType === 'codex') {
          // Codex via WSL with path conversion - use bash -ic to load user's PATH
          const wslPath = this.convertToWslPath(workingDir);
          const codexCommand = `wsl bash -ic 'codex --dangerously-bypass-approvals-and-sandbox -C ${wslPath}'`;
          ptyProcess = pty.spawn('cmd.exe', ['/c', codexCommand], {
            name: 'xterm-color',
            cols: 120,
            rows: 30,
            env: process.env
          });
        } else {
          // Claude (existing logic)
          const claudeCommand = `claude --dangerously-skip-permissions --session-id ${claudeSessionId}`;
          ptyProcess = pty.spawn('cmd.exe', ['/c', claudeCommand], {
            name: 'xterm-color',
            cols: 120,
            rows: 30,
            cwd: workingDir,
            env: process.env
          });
        }
      } else {
        // Unix - spawn directly
        if (cliType === 'codex') {
          ptyProcess = pty.spawn('codex', [
            '--dangerously-bypass-approvals-and-sandbox',
            '-C', workingDir
          ], {
            name: 'xterm-color',
            cols: 120,
            rows: 30,
            cwd: workingDir,
            env: process.env
          });
        } else {
          ptyProcess = pty.spawn('claude', ['--dangerously-skip-permissions', '--session-id', claudeSessionId], {
            name: 'xterm-color',
            cols: 120,
            rows: 30,
            cwd: workingDir,
            env: process.env
          });
        }
      }
    } catch (error) {
      throw new Error(`Failed to spawn ${cliType === 'codex' ? 'Codex' : 'Claude'} CLI: ${error.message}`);
    }

    const session = {
      id,
      name,
      status: 'active',
      currentTask: '',
      createdAt: now,
      lastActivity: now,
      outputBuffer: new RingBuffer(500),
      pty: ptyProcess,
      workingDir,
      cliType,  // 'claude' or 'codex'
      claudeSessionId: cliType === 'claude' ? claudeSessionId : null, // Only for Claude
      notes: '',
      tags: [],
      plans: [],
      promptBuffer: '',      // Characters accumulated until Enter
      promptHistory: [],     // Last 10 prompts [{text, timestamp}]
      inEscapeSeq: false,    // Track if we're inside an escape sequence
      statusDebounceTimer: null,  // Timer for debouncing status changes
      pendingStatus: null         // Status waiting to be applied
    };

    // Handle PTY output
    ptyProcess.onData((data) => {
      session.outputBuffer.push(data);
      session.lastActivity = new Date();

      // Try to detect Claude session ID from output
      this.detectClaudeSessionId(data, session);

      // Detect status from output (debounced to avoid flickering)
      const newStatus = this.detectStatus(data, session.status);
      if (newStatus !== session.status) {
        this.updateSessionStatus(session, newStatus);
      }

      // Detect current task
      const task = this.detectTask(data);
      if (task && task !== session.currentTask) {
        session.currentTask = task;
        this.dataStore.saveSession(session);
        this.emit('statusChange', {
          sessionId: id,
          status: session.status,
          currentTask: task
        });
      }

      // Detect plan updates from terminal output
      this.detectPlanActivity(data, session);

      this.emit('output', { sessionId: id, data });
    });

    // Handle PTY exit
    ptyProcess.onExit(({ exitCode, signal }) => {
      // Don't process if shutting down (cleanup handles this)
      if (this.isShuttingDown) return;

      // Don't mark as completed if intentionally paused
      if (session.status === 'paused') {
        return;
      }

      // If session just started and immediately exited with error, keep it paused (don't delete)
      // This preserves sessions that fail to start
      const sessionAge = Date.now() - new Date(session.createdAt).getTime();
      if (sessionAge < 10000 && exitCode !== 0) {
        session.status = 'paused';
        session.pty = null;
        this.dataStore.saveSession(session);
        this.emit('statusChange', {
          sessionId: id,
          status: 'paused',
          currentTask: session.currentTask,
          error: 'Failed to start session'
        });
        return;
      }

      session.status = 'completed';
      this.dataStore.deleteSession(id);
      this.emit('statusChange', {
        sessionId: id,
        status: 'completed',
        currentTask: session.currentTask,
        exitCode,
        signal
      });
      this.emit('sessionEnded', { sessionId: id, exitCode, signal });
    });

    this.sessions.set(id, session);

    // Save to persistent storage
    this.dataStore.saveSession(session);

    // Start idle detection timer
    this.startIdleDetection(session);

    // Scan for existing plans that match this session
    this.scanExistingPlansForSession(id);

    return this.getSessionSnapshot(session);
  }

  /**
   * Watch Claude's sessions index for updates to this session
   * @param {object} session - Session object
   */
  watchClaudeSessionForUpdates(session) {
    // Retry sync periodically until we get a Claude session ID
    const attemptSync = (attemptNum = 1) => {
      if (session.claudeSessionId || attemptNum > 10) {
        return; // Stop if we have an ID or exceeded max attempts
      }

      this.syncWithClaudeSession(session);

      // If still no ID, try again with exponential backoff
      if (!session.claudeSessionId) {
        const delay = Math.min(2000 * attemptNum, 10000); // 2s, 4s, 6s... max 10s
        setTimeout(() => attemptSync(attemptNum + 1), delay);
      }
    };

    // Start initial sync attempts after 2 seconds
    setTimeout(() => attemptSync(1), 2000);

    // Also try to set up file watcher (may fail if file doesn't exist yet)
    const setupWatcher = (retryCount = 0) => {
      const watcher = this.watchClaudeSessionsIndex(session.workingDir, (claudeSessions) => {
        this.syncWithClaudeSession(session, claudeSessions);
      });

      if (watcher) {
        session.claudeIndexWatcher = watcher;
      } else if (retryCount < 5) {
        // Retry setting up watcher after a delay
        setTimeout(() => setupWatcher(retryCount + 1), 3000);
      }
    };

    setupWatcher();
  }

  /**
   * Sync our session with Claude's session data
   * @param {object} session - Our session object
   * @param {Array} claudeSessions - Optional pre-loaded Claude sessions
   */
  syncWithClaudeSession(session, claudeSessions = null) {
    const sessions = claudeSessions || this.getClaudeSessions(session.workingDir);
    if (sessions.length === 0) return;

    // Find the most recently modified session
    sessions.sort((a, b) => new Date(b.modified) - new Date(a.modified));
    const latestClaudeSession = sessions[0];

    // Check if this is a new/different Claude session
    if (latestClaudeSession && latestClaudeSession.sessionId !== session.claudeSessionId) {
      const oldId = session.claudeSessionId;
      session.claudeSessionId = latestClaudeSession.sessionId;

      // Also update the session name from Claude's summary if set
      if (latestClaudeSession.summary && latestClaudeSession.summary !== 'No prompt') {
        session.claudeSessionName = latestClaudeSession.summary;
      }

      this.dataStore.saveSession(session);

      console.log(`Synced Claude session: ${session.claudeSessionId} (${session.claudeSessionName || 'unnamed'})`);

      this.emit('sessionUpdated', {
        sessionId: session.id,
        claudeSessionId: session.claudeSessionId,
        claudeSessionName: session.claudeSessionName
      });
    }
  }

  /**
   * Detect Claude session ID from terminal output
   * @param {string} data - Terminal output
   * @param {object} session - Session object
   */
  detectClaudeSessionId(data, session) {
    if (session.claudeSessionId) return;

    // Look for session ID patterns in Claude output
    // Claude might show session ID in format: "Session: abc123" or similar
    const patterns = [
      /session[:\s]+([a-z0-9-]+)/i,
      /resuming\s+([a-z0-9-]+)/i,
      /conversation\s+([a-z0-9-]+)/i
    ];

    for (const pattern of patterns) {
      const match = data.match(pattern);
      if (match && match[1] && match[1].length >= 6) {
        session.claudeSessionId = match[1];
        this.dataStore.saveSession(session);
        console.log(`Detected Claude session ID: ${match[1]}`);
        break;
      }
    }
  }

  /**
   * Pause a session (kill PTY but keep metadata)
   * @param {string} id - Session ID
   * @returns {boolean} Success status
   */
  pauseSession(id) {
    const session = this.sessions.get(id);
    if (!session) {
      return false;
    }

    if (session.status === 'paused' || session.status === 'completed') {
      return false;
    }

    // Clear idle timer
    if (session.idleTimer) {
      clearInterval(session.idleTimer);
      session.idleTimer = null;
    }

    // Clear status debounce timer
    if (session.statusDebounceTimer) {
      clearTimeout(session.statusDebounceTimer);
      session.statusDebounceTimer = null;
    }

    // Kill the PTY process
    try {
      if (session.pty) {
        session.pty.kill();
        session.pty = null;
      }
    } catch (error) {
      console.error(`Error killing PTY for session ${id}:`, error.message);
    }

    session.status = 'paused';
    session.lastActivity = new Date();

    // Save to persistent storage
    this.dataStore.saveSession(session);

    this.emit('statusChange', {
      sessionId: id,
      status: 'paused',
      currentTask: session.currentTask
    });

    return true;
  }

  /**
   * Resume a paused session
   * @param {string} id - Session ID
   * @returns {boolean} Success status
   */
  resumeSession(id) {
    const session = this.sessions.get(id);
    if (!session) {
      return false;
    }

    if (session.status !== 'paused') {
      return false;
    }

    const isWindows = process.platform === 'win32';
    const cliType = session.cliType || 'claude';
    let ptyProcess;

    try {
      if (cliType === 'codex') {
        // Codex uses `codex resume --last` to resume the most recent session
        if (isWindows) {
          ptyProcess = pty.spawn('cmd.exe', ['/c', "wsl bash -ic 'codex resume --last'"], {
            name: 'xterm-color',
            cols: 120,
            rows: 30,
            env: process.env
          });
        } else {
          ptyProcess = pty.spawn('codex', ['resume', '--last'], {
            name: 'xterm-color',
            cols: 120,
            rows: 30,
            cwd: session.workingDir,
            env: process.env
          });
        }
      } else {
        // Claude: use --resume to continue an existing session, or --continue for continuation
        const args = session.claudeSessionId
          ? ['--dangerously-skip-permissions', '--resume', session.claudeSessionId]
          : ['--dangerously-skip-permissions'];

        if (isWindows) {
          const claudeCommand = session.claudeSessionId
            ? `claude --dangerously-skip-permissions --resume ${session.claudeSessionId}`
            : 'claude --dangerously-skip-permissions';
          ptyProcess = pty.spawn('cmd.exe', ['/c', claudeCommand], {
            name: 'xterm-color',
            cols: 120,
            rows: 30,
            cwd: session.workingDir,
            env: process.env
          });
        } else {
          ptyProcess = pty.spawn('claude', args, {
            name: 'xterm-color',
            cols: 120,
            rows: 30,
            cwd: session.workingDir,
            env: process.env
          });
        }
      }
    } catch (error) {
      console.error(`Failed to resume session ${id}:`, error.message);
      return false;
    }

    session.pty = ptyProcess;
    session.status = 'active';
    session.lastActivity = new Date();

    // Re-setup PTY handlers
    ptyProcess.onData((data) => {
      session.outputBuffer.push(data);
      session.lastActivity = new Date();

      this.detectClaudeSessionId(data, session);

      // Detect status from output (debounced to avoid flickering)
      const newStatus = this.detectStatus(data, session.status);
      if (newStatus !== session.status && newStatus !== 'paused') {
        this.updateSessionStatus(session, newStatus);
      }

      const task = this.detectTask(data);
      if (task && task !== session.currentTask) {
        session.currentTask = task;
        this.dataStore.saveSession(session);
        this.emit('statusChange', {
          sessionId: id,
          status: session.status,
          currentTask: task
        });
      }

      // Detect plan updates from terminal output
      this.detectPlanActivity(data, session);

      this.emit('output', { sessionId: id, data });
    });

    ptyProcess.onExit(({ exitCode, signal }) => {
      // Don't process if shutting down (cleanup handles this)
      if (this.isShuttingDown) return;

      // Don't mark as completed if intentionally paused
      if (session.status === 'paused') {
        return;
      }

      // If session just started and immediately exited with error, keep it paused (don't delete)
      // This preserves sessions that fail to resume (e.g., "Session ID already in use")
      const sessionAge = Date.now() - new Date(session.lastActivity).getTime();
      if (sessionAge < 10000 && exitCode !== 0) {
        session.status = 'paused';
        session.pty = null;
        this.dataStore.saveSession(session);
        this.emit('statusChange', {
          sessionId: id,
          status: 'paused',
          currentTask: session.currentTask,
          error: 'Failed to resume session'
        });
        return;
      }

      session.status = 'completed';
      this.dataStore.deleteSession(id);
      this.emit('statusChange', {
        sessionId: id,
        status: 'completed',
        currentTask: session.currentTask,
        exitCode,
        signal
      });
      this.emit('sessionEnded', { sessionId: id, exitCode, signal });
    });

    // Save to persistent storage
    this.dataStore.saveSession(session);

    // Start idle detection timer
    this.startIdleDetection(session);

    // Scan for existing plans that match this session
    this.scanExistingPlansForSession(id);

    this.emit('statusChange', {
      sessionId: id,
      status: 'active',
      currentTask: session.currentTask
    });

    return true;
  }

  /**
   * Update session metadata
   * @param {string} id - Session ID
   * @param {object} meta - Metadata to update
   * @returns {object|null} Updated session snapshot or null
   */
  updateSessionMeta(id, meta) {
    const session = this.sessions.get(id);
    if (!session) {
      return null;
    }

    // Update allowed fields
    if (meta.name !== undefined) session.name = meta.name;
    if (meta.notes !== undefined) session.notes = meta.notes;
    if (meta.tags !== undefined) session.tags = meta.tags;

    session.lastActivity = new Date();

    // Save to persistent storage
    this.dataStore.saveSession(session);

    this.emit('sessionUpdated', {
      sessionId: id,
      ...this.getSessionSnapshot(session)
    });

    return this.getSessionSnapshot(session);
  }

  /**
   * Start idle detection for a session
   * @param {object} session - Session object
   */
  startIdleDetection(session) {
    if (session.idleTimer) {
      clearInterval(session.idleTimer);
    }

    session.idleTimer = setInterval(() => {
      if (session.status === 'completed' || session.status === 'paused') {
        clearInterval(session.idleTimer);
        return;
      }

      const idleTime = Date.now() - session.lastActivity.getTime();
      if (idleTime > 5000 && session.status === 'active') {
        session.status = 'idle';
        this.emit('statusChange', {
          sessionId: session.id,
          status: 'idle',
          currentTask: session.currentTask
        });
      }
    }, 1000);
  }

  /**
   * Detect session status from terminal output
   * @param {string} data - Terminal output data
   * @param {string} currentStatus - Current session status
   * @returns {string} Detected status
   */
  detectStatus(data, currentStatus) {
    // Don't change status if paused
    if (currentStatus === 'paused') {
      return 'paused';
    }

    // Detect thinking/processing indicators
    const thinkingPatterns = [
      /Thinking/i,
      /Processing/i,
      /\u280B|\u2819|\u2839|\u2838|\u283C|\u2834|\u2826|\u2827|\u2807|\u280F/,  // Spinner characters
      /\u280B|\u2819|\u2839|\u2838|\u283C|\u2834|\u2826|\u2827|\u2807|\u280F/  // Unicode spinners
    ];

    for (const pattern of thinkingPatterns) {
      if (pattern.test(data)) {
        return 'thinking';
      }
    }

    // Detect editing patterns
    const editingPatterns = [
      /Writing to/i,
      /Editing/i,
      /Creating file/i,
      /Updating/i,
      /^\s*\+\s+/m,  // Diff additions
      /^\s*-\s+/m    // Diff removals
    ];

    for (const pattern of editingPatterns) {
      if (pattern.test(data)) {
        return 'editing';
      }
    }

    // Detect waiting for input
    const waitingPatterns = [
      />\s*$/,
      /\?\s*$/,
      /Enter.*:/i,
      /Press.*to continue/i,
      /\[Y\/n\]/i,
      /\[y\/N\]/i
    ];

    for (const pattern of waitingPatterns) {
      if (pattern.test(data)) {
        return 'waiting';
      }
    }

    // Default to active if there's output
    return 'active';
  }

  /**
   * Detect current task from terminal output
   * @param {string} data - Terminal output data
   * @returns {string|null} Detected task or null
   */
  detectTask(data) {
    // Look for common task patterns
    const taskPatterns = [
      /Working on[:\s]+(.+)/i,
      /Task[:\s]+(.+)/i,
      /Analyzing[:\s]+(.+)/i,
      /Reading[:\s]+(.+)/i,
      /Searching[:\s]+(.+)/i
    ];

    for (const pattern of taskPatterns) {
      const match = data.match(pattern);
      if (match && match[1]) {
        return match[1].trim().substring(0, 100);
      }
    }

    return null;
  }

  /**
   * Detect plan activity from terminal output and trigger plan refresh
   * @param {string} data - Terminal output data
   * @param {object} session - Session object
   */
  detectPlanActivity(data, session) {
    // Look for plan-related output patterns from Claude
    const planPatterns = [
      /Updated plan/i,
      /plan.*updated/i,
      /Created.*plan/i,
      /Entered plan mode/i,
      /Exited plan mode/i,
      /wrote.*plan.*\.md/i
    ];

    for (const pattern of planPatterns) {
      if (pattern.test(data)) {
        // Debounce: don't emit more than once per 2 seconds
        const now = Date.now();
        if (!session.lastPlanEmit || now - session.lastPlanEmit > 2000) {
          session.lastPlanEmit = now;

          // Emit sessionUpdated to trigger frontend refresh
          this.emit('sessionUpdated', {
            sessionId: session.id,
            plans: session.plans || [],
            plansUpdatedAt: now
          });
        }
        break;
      }
    }
  }

  /**
   * Update session status with debouncing to avoid flickering
   * Status changes are only applied after 500ms of stability
   * @param {object} session - Session object
   * @param {string} newStatus - New status to apply
   */
  updateSessionStatus(session, newStatus) {
    // Clear existing timer
    if (session.statusDebounceTimer) {
      clearTimeout(session.statusDebounceTimer);
      session.statusDebounceTimer = null;
    }

    // If same status, nothing to do
    if (newStatus === session.status) {
      session.pendingStatus = null;
      return;
    }

    // Store pending status
    session.pendingStatus = newStatus;

    // Debounce: only emit after 500ms of stability
    session.statusDebounceTimer = setTimeout(() => {
      if (session.pendingStatus && session.pendingStatus !== session.status) {
        session.status = session.pendingStatus;
        session.pendingStatus = null;
        this.dataStore.saveSession(session);
        this.emit('statusChange', {
          sessionId: session.id,
          status: session.status,
          currentTask: session.currentTask
        });
      }
      session.statusDebounceTimer = null;
    }, 500);
  }

  /**
   * Kill a session
   * @param {string} id - Session ID
   * @returns {boolean} Success status
   */
  killSession(id) {
    const session = this.sessions.get(id);
    if (!session) {
      return false;
    }

    // Clear idle timer
    if (session.idleTimer) {
      clearInterval(session.idleTimer);
    }

    // Clear status debounce timer
    if (session.statusDebounceTimer) {
      clearTimeout(session.statusDebounceTimer);
    }

    // Close Claude sessions watcher
    if (session.claudeIndexWatcher) {
      try {
        session.claudeIndexWatcher.close();
      } catch (e) {
        // Ignore
      }
    }

    // Kill the PTY process
    try {
      if (session.pty) {
        session.pty.kill();
      }
    } catch (error) {
      console.error(`Error killing session ${id}:`, error.message);
    }

    // Remove from persistent storage
    this.dataStore.deleteSession(id);

    this.sessions.delete(id);
    this.emit('sessionKilled', { sessionId: id });

    return true;
  }

  /**
   * Send input to a session
   * @param {string} id - Session ID
   * @param {string} text - Text to send
   * @returns {boolean} Success status
   */
  sendInput(id, text) {
    const session = this.sessions.get(id);
    if (!session || session.status === 'completed' || session.status === 'paused') {
      return false;
    }

    try {
      session.pty.write(text);
      session.lastActivity = new Date();

      // Prompt detection - buffer until Enter
      for (const char of text) {
        const code = char.charCodeAt(0);

        // Detect start of escape sequence (ESC = 0x1b)
        if (code === 0x1b) {
          session.inEscapeSeq = true;
          continue;
        }

        // If in escape sequence, wait for terminating character
        if (session.inEscapeSeq) {
          // Escape sequences end with a letter (A-Z, a-z) or ~
          if ((code >= 65 && code <= 90) || (code >= 97 && code <= 122) || code === 126) {
            session.inEscapeSeq = false;
          }
          continue;
        }

        if (char === '\r' || char === '\n') {
          const promptText = session.promptBuffer.trim();
          if (promptText.length > 3) {  // Skip short confirmations like "y"
            this.addPromptToHistory(session, promptText);
          }
          session.promptBuffer = '';
        } else if (char === '\x7f' || char === '\b') {
          // Handle backspace
          session.promptBuffer = session.promptBuffer.slice(0, -1);
        } else if (code >= 32 && code < 127) {
          // Only add printable ASCII characters
          session.promptBuffer += char;
        }
      }

      // Update status to active on input
      if (session.status === 'idle' || session.status === 'waiting') {
        session.status = 'active';
        this.emit('statusChange', {
          sessionId: id,
          status: 'active',
          currentTask: session.currentTask
        });
      }

      return true;
    } catch (error) {
      console.error(`Error sending input to session ${id}:`, error.message);
      return false;
    }
  }

  /**
   * Add a prompt to a session's history
   * @param {object} session - Session object
   * @param {string} promptText - The prompt text
   */
  addPromptToHistory(session, promptText) {
    // Clean up any remaining escape sequences or control characters
    const cleanText = promptText
      .replace(/\x1b\[[0-9;]*[A-Za-z~]/g, '')  // ANSI escape sequences
      .replace(/\[[A-Z]\]/g, '')                // Stray bracket sequences like [I] [O]
      .replace(/[\x00-\x1f\x7f]/g, '')          // Control characters
      .trim();

    if (cleanText.length <= 3) return;  // Skip if too short after cleanup

    const prompt = { text: cleanText, timestamp: new Date().toISOString() };
    session.promptHistory.push(prompt);
    if (session.promptHistory.length > 10) {
      session.promptHistory.shift();
    }
    this.dataStore.saveSession(session);
    this.emit('promptAdded', {
      sessionId: session.id,
      prompt,
      promptHistory: session.promptHistory
    });
  }

  /**
   * Resize a session's terminal
   * @param {string} id - Session ID
   * @param {number} cols - Number of columns
   * @param {number} rows - Number of rows
   * @returns {boolean} Success status
   */
  resizeSession(id, cols, rows) {
    const session = this.sessions.get(id);
    if (!session || session.status === 'completed' || session.status === 'paused') {
      return false;
    }

    try {
      session.pty.resize(cols, rows);
      return true;
    } catch (error) {
      console.error(`Error resizing session ${id}:`, error.message);
      return false;
    }
  }

  /**
   * Get all sessions
   * @returns {array} Array of session snapshots
   */
  getAllSessions() {
    const snapshots = [];
    for (const session of this.sessions.values()) {
      snapshots.push(this.getSessionSnapshot(session));
    }
    return snapshots;
  }

  /**
   * Get a single session
   * @param {string} id - Session ID
   * @returns {object|null} Session snapshot or null
   */
  getSession(id) {
    const session = this.sessions.get(id);
    if (!session) {
      return null;
    }
    return this.getSessionSnapshot(session);
  }

  /**
   * Get the output buffer for a session
   * @param {string} id - Session ID
   * @returns {array|null} Output buffer or null
   */
  getSessionOutput(id) {
    const session = this.sessions.get(id);
    if (!session) {
      return null;
    }
    return session.outputBuffer.getAll();
  }

  /**
   * Create a safe serializable snapshot of a session
   * @param {object} session - Session object
   * @returns {object} Session snapshot (without PTY reference)
   */
  getSessionSnapshot(session) {
    return {
      id: session.id,
      name: session.name,
      status: session.status,
      currentTask: session.currentTask,
      createdAt: session.createdAt instanceof Date
        ? session.createdAt.toISOString()
        : session.createdAt,
      lastActivity: session.lastActivity instanceof Date
        ? session.lastActivity.toISOString()
        : session.lastActivity,
      workingDir: session.workingDir,
      cliType: session.cliType || 'claude',
      claudeSessionId: session.claudeSessionId || null,
      claudeSessionName: session.claudeSessionName || null,
      notes: session.notes || '',
      tags: session.tags || [],
      plans: session.plans || [],
      promptHistory: session.promptHistory || []
    };
  }

  /**
   * Get plans for a session
   * Uses Claude's session transcript to get ONLY plans that were actually edited in that session
   * @param {string} id - Session ID
   * @returns {array} Array of plan info objects
   */
  getSessionPlans(id) {
    const session = this.sessions.get(id);
    if (!session) {
      return [];
    }

    // If we have a Claude session ID, get plans from Claude's tracking (authoritative source)
    if (session.claudeSessionId && session.workingDir) {
      const planPaths = this.planManager.getPlansForClaudeSession(
        session.claudeSessionId,
        session.workingDir
      );

      const plans = [];
      for (const planPath of planPaths) {
        const plan = this.planManager.getPlanContent(planPath);
        if (plan) {
          plans.push(plan);
        }
      }
      // Sort by modified time (newest first)
      plans.sort((a, b) => new Date(b.modifiedAt) - new Date(a.modifiedAt));
      return plans;
    }

    // Fallback for non-Claude sessions: use stored plans but filter by exact directory match
    const normalizedSessionDir = session.workingDir?.toLowerCase().replace(/\\/g, '/').replace(/\/$/, '') || '';
    const plans = [];

    for (const planPath of (session.plans || [])) {
      const plan = this.planManager.getPlanContent(planPath);
      if (plan) {
        if (plan.workingDir) {
          const normalizedPlanDir = plan.workingDir.toLowerCase().replace(/\\/g, '/').replace(/\/$/, '');
          if (normalizedPlanDir === normalizedSessionDir) {
            plans.push(plan);
          }
        }
      }
    }
    // Sort by modified time (newest first)
    plans.sort((a, b) => new Date(b.modifiedAt) - new Date(a.modifiedAt));
    return plans;
  }

  /**
   * Cleanup all sessions
   * Pauses sessions instead of killing them so they can be resumed after restart
   */
  cleanup() {
    this.isShuttingDown = true;  // Prevent onExit handlers from deleting sessions
    this.planManager.stopWatching();

    for (const [id, session] of this.sessions) {
      if (session.pty) {
        session.pty.kill();  // Kill PTY process only
      }
      session.status = 'paused';
      session.pty = null;
      this.dataStore.saveSession(session);  // Persist for restart
    }
    this.sessions.clear();
  }
}

module.exports = SessionManager;

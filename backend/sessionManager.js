const EventEmitter = require('events');
const pty = require('node-pty');
const { v4: uuidv4 } = require('uuid');
const fs = require('fs');
const path = require('path');
const os = require('os');
const DataStore = require('./dataStore');
const PlanManager = require('./planManager');
const { DEFAULT_STAGES, TASK_STATUS, getNextStage, getPreviousStage, sessionStatusToStage } = require('./stagesConfig');
const { hasSubmittedInput, shouldCountOutputAsActivity } = require('./sessionInputUtils');
const MAX_PROMPT_HISTORY_CHARS = 4000;
const MAX_PROMPT_HISTORY_COUNT = 25;
const DEFAULT_OUTPUT_BUFFER_CHUNKS = 750;
const MEDIUM_OUTPUT_BUFFER_CHUNKS = 3000;

// Debug logger that writes to file
const DEBUG_LOG_FILE = path.join(__dirname, '..', 'data', 'debug.log');
function debugLog(message) {
  const timestamp = new Date().toISOString();
  const line = `[${timestamp}] ${message}\n`;
  fs.appendFileSync(DEBUG_LOG_FILE, line);
  console.log(`[DEBUG] ${message}`);
}

/**
 * Ring buffer for storing terminal output with a maximum size
 */
class RingBuffer {
  constructor(maxSize = DEFAULT_OUTPUT_BUFFER_CHUNKS) {
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
    this.stages = [...DEFAULT_STAGES];
    this.isShuttingDown = false;  // Prevents onExit handlers from deleting sessions during shutdown

    // Load persisted stages
    const savedStages = this.dataStore.loadStages();
    if (savedStages && savedStages.length > 0) {
      this.stages = savedStages;
    }

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
      if (sessionData.status === 'completed' || sessionData.status === 'killed') {
        this.dataStore.deleteSession(id);
        console.log(`Cleaned up completed session: ${sessionData.name} (${id})`);
        continue;
      }

      // Restore sessions that can be resumed:
      // - Claude sessions with claudeSessionId
      // - Codex sessions (which use 'resume --last' and don't need a session ID)
      // - Terminal sessions (just re-launch a fresh shell)
      const cliType = sessionData.cliType || 'claude';
      const canResume = cliType === 'codex' || cliType === 'terminal' || sessionData.claudeSessionId;

      if (canResume) {
        const outputBufferSize = this.getOutputBufferSize(cliType);
        const session = {
          id: sessionData.id,
          name: sessionData.name,
          // Mark previously active sessions as paused (since they have no PTY now)
          status: 'paused',
          currentTask: sessionData.currentTask || '',
          createdAt: new Date(sessionData.createdAt),
          lastActivity: new Date(sessionData.lastActivity),
          outputBuffer: new RingBuffer(outputBufferSize),
          pty: null,
          workingDir: sessionData.workingDir,
          cliType: cliType,
          claudeSessionId: sessionData.claudeSessionId,
          previousClaudeSessionIds: sessionData.previousClaudeSessionIds || [],
          claudeSessionName: sessionData.claudeSessionName || null,
          notes: sessionData.notes || '',
          role: this.sanitizeRole(sessionData.role || ''),
          agentId: sessionData.agentId || null,
          taskId: sessionData.taskId || null,
          tags: sessionData.tags || [],
          plans: sessionData.plans || [],
          promptBuffer: '',
          promptHistory: sessionData.promptHistory || [],
          promptFlushTimer: null,
          inEscapeSeq: false,
          // Kanban stage fields
          stage: sessionData.stage || 'todo',
          priority: sessionData.priority || 0,
          description: sessionData.description || '',
          blockedBy: sessionData.blockedBy || [],
          blocks: sessionData.blocks || [],
          manuallyPlaced: sessionData.manuallyPlaced || false,
          manualPlacedAt: sessionData.manualPlacedAt || null,
          placementLocked: sessionData.placementLocked || false,
          rejectionHistory: sessionData.rejectionHistory || [],
          completedAt: sessionData.completedAt || null,
          updatedAt: sessionData.updatedAt || null,
          comments: sessionData.comments || []
        };

        this.sessions.set(id, session);
        // Update persisted status to paused
        this.dataStore.saveSession(session);
        debugLog(`Session ${id} (${session.name}) marked PAUSED during server startup (loadSessions)`);
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
   * Determine output replay buffer size by CLI type.
   * Terminal and Codex sessions can emit long plan/output blocks and benefit from larger replay.
   * @param {string} cliType
   * @returns {number}
   */
  getOutputBufferSize(cliType) {
    if (cliType === 'terminal' || cliType === 'codex') {
      return MEDIUM_OUTPUT_BUFFER_CHUNKS;
    }
    return DEFAULT_OUTPUT_BUFFER_CHUNKS;
  }

  /**
   * Get the Claude projects directory path for a working directory
   * @param {string} workingDir - Working directory path
   * @returns {string} Path to the Claude project directory
   */
  getClaudeProjectPath(workingDir) {
    // Convert path to Claude's format: C:\Users\user\apps\foo -> C--Users-user-apps-foo
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
      id: sessionId,
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
        id: sessionId,
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

  sanitizeRole(role) {
    if (typeof role !== 'string') {
      return '';
    }
    const normalized = role.replace(/\0/g, '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
    return normalized.slice(0, 4096);
  }

  spawnTerminalProcess(workingDir) {
    const isWindows = process.platform === 'win32';
    if (isWindows) {
      return pty.spawn('powershell.exe', ['-NoLogo'], {
        name: 'xterm-color',
        cols: 120,
        rows: 30,
        cwd: workingDir,
        env: process.env
      });
    }

    const shell = process.env.SHELL || '/bin/bash';
    return pty.spawn(shell, [], {
      name: 'xterm-color',
      cols: 120,
      rows: 30,
      cwd: workingDir,
      env: process.env
    });
  }

  spawnCodexProcess(workingDir, { resume = false } = {}) {
    const isWindows = process.platform === 'win32';
    if (isWindows) {
      const wslPath = this.convertToWslPath(workingDir).replace(/'/g, "'\\''").replace(/"/g, '\\"');
      const codexCommand = resume
        ? `wsl bash -ic 'codex -C \"${wslPath}\" resume --last'`
        : `wsl bash -ic 'codex --dangerously-bypass-approvals-and-sandbox -C \"${wslPath}\"'`;
      return pty.spawn('cmd.exe', ['/c', codexCommand], {
        name: 'xterm-color',
        cols: 120,
        rows: 30,
        env: process.env
      });
    }

    const args = resume
      ? ['-C', workingDir, 'resume', '--last']
      : ['--dangerously-bypass-approvals-and-sandbox', '-C', workingDir];
    return pty.spawn('codex', args, {
      name: 'xterm-color',
      cols: 120,
      rows: 30,
      cwd: workingDir,
      env: process.env
    });
  }

  spawnClaudeProcess(workingDir, { sessionId = null, resumeId = null, role = '' } = {}) {
    const args = ['--dangerously-skip-permissions'];
    if (resumeId) {
      args.push('--resume', resumeId);
    } else if (sessionId) {
      args.push('--session-id', sessionId);
    }
    const sanitizedRole = this.sanitizeRole(role);
    if (sanitizedRole) {
      args.push('--append-system-prompt', sanitizedRole);
    }

    const isWindows = process.platform === 'win32';
    if (isWindows) {
      return pty.spawn('cmd.exe', ['/c', 'claude', ...args], {
        name: 'xterm-color',
        cols: 120,
        rows: 30,
        cwd: workingDir,
        env: process.env
      });
    }
    return pty.spawn('claude', args, {
      name: 'xterm-color',
      cols: 120,
      rows: 30,
      cwd: workingDir,
      env: process.env
    });
  }

  clearRoleInjectionWorkflow(session) {
    if (!session || !session.roleInjection) return;
    if (session.roleInjection.retryTimer) {
      clearTimeout(session.roleInjection.retryTimer);
    }
    if (session.roleInjection.timeoutTimer) {
      clearTimeout(session.roleInjection.timeoutTimer);
    }
    session.roleInjection = null;
  }

  isCodexReadyForInput(data) {
    return /Ask Codex to do anything/i.test(data) ||
      /\?\s*for shortcuts/i.test(data) ||
      /Would you like to run/i.test(data) ||
      /Implement this plan\?/i.test(data);
  }

  injectCodexRole(session, reason = 'ready') {
    if (!session?.pty || !session.roleInjection || session.roleInjection.injected) {
      return false;
    }

    const role = session.roleInjection.role;
    if (!role) {
      this.clearRoleInjectionWorkflow(session);
      return false;
    }

    const instruction = `System role instruction:\n${role}\n\nAcknowledge and continue following this role.`;
    session.pty.write(`${instruction}\r`);
    debugLog(`Session ${session.id}: injected Codex role (${reason})`);
    this.clearRoleInjectionWorkflow(session);
    session.startupSequence = null;
    return true;
  }

  injectClaudeRoleReminder(session, reason = 'ready') {
    if (!session?.pty || !session.roleInjection || session.roleInjection.injected) {
      return false;
    }

    const role = session.roleInjection.role;
    if (!role) {
      this.clearRoleInjectionWorkflow(session);
      return false;
    }

    const instruction = `Role reminder for this resumed session:\n${role}\n\nPlease continue following this role for all responses.`;
    session.pty.write(`${instruction}\r`);
    debugLog(`Session ${session.id}: injected Claude resume role reminder (${reason})`);
    this.clearRoleInjectionWorkflow(session);
    session.startupSequence = null;
    return true;
  }

  setupRoleInjectionWorkflow(session, phase = 'create') {
    this.clearRoleInjectionWorkflow(session);
    const role = this.sanitizeRole(session?.role || '');
    if (!role || !session?.pty) {
      return;
    }

    if (session.cliType === 'codex') {
      session.roleInjection = {
        cliType: 'codex',
        phase,
        role,
        retryTimer: setTimeout(() => {
          if (session.roleInjection && !session.roleInjection.injected) {
            this.injectCodexRole(session, 'retry-5s');
          }
        }, 5000),
        timeoutTimer: setTimeout(() => {
          if (session.roleInjection && !session.roleInjection.injected) {
            debugLog(`Session ${session.id}: role injection skipped (Codex readiness timeout after 30s)`);
            this.clearRoleInjectionWorkflow(session);
          }
        }, 30000)
      };
      return;
    }

    if (session.cliType === 'claude' && phase === 'resume') {
      session.roleInjection = {
        cliType: 'claude',
        phase,
        role,
        retryTimer: setTimeout(() => {
          if (session.roleInjection && !session.roleInjection.injected) {
            this.injectClaudeRoleReminder(session, 'fallback-5s');
          }
        }, 5000),
        timeoutTimer: setTimeout(() => {
          if (session.roleInjection && !session.roleInjection.injected) {
            debugLog(`Session ${session.id}: role reminder skipped (Claude resume timeout after 30s)`);
            this.clearRoleInjectionWorkflow(session);
          }
        }, 30000)
      };
    }
  }

  tryRoleInjectionOnOutput(session, data) {
    if (!session?.roleInjection) return;
    if (session.roleInjection.cliType === 'codex' && this.isCodexReadyForInput(data)) {
      this.injectCodexRole(session, 'prompt-detected');
      return;
    }
    if (session.roleInjection.cliType === 'claude') {
      const nextStatus = this.detectStatus(data, session.status, session.cliType);
      if (nextStatus === 'idle') {
        this.injectClaudeRoleReminder(session, 'prompt-detected');
      }
    }
  }

  runStartupSequence(session, agent, { force = false } = {}) {
    if (!session || !agent || !session.pty) {
      return;
    }
    if (session.startupSequence?.active && !force) {
      return;
    }

    const commands = [];
    if (Array.isArray(agent.skills)) {
      for (const skill of agent.skills) {
        if (typeof skill !== 'string' || !skill.trim()) continue;
        commands.push(skill.trim().startsWith('/') ? skill.trim() : `/${skill.trim()}`);
      }
    }
    if (agent.memoryEnabled !== false && Array.isArray(agent.memory) && agent.memory.length > 0) {
      const memoryText = agent.memory
        .filter((entry) => typeof entry === 'string' && entry.trim())
        .slice(-10)
        .map((entry) => `- ${entry.trim()}`)
        .join('\n');
      if (memoryText) {
        commands.push(`Use this persistent agent memory context:\n${memoryText}`);
      }
    }
    if (typeof agent.startupPrompt === 'string' && agent.startupPrompt.trim()) {
      commands.push(agent.startupPrompt.trim());
    }

    if (commands.length === 0) {
      return;
    }

    session.startupSequence = {
      active: true,
      queue: [...commands],
      waitingForIdle: true,
      sentCount: 0,
      lastSentAt: 0,
      completedAt: null
    };
  }

  appendTaskContext(sessionId, taskContext) {
    const session = this.sessions.get(sessionId);
    if (!session || !session.pty) return;

    let prompt = `You have been assigned a task:\n\nTitle: ${taskContext.title}`;
    if (taskContext.description) {
      prompt += `\n\nDescription:\n${taskContext.description}`;
    }
    if (taskContext.comments?.length) {
      prompt += `\n\nRecent comments:\n` +
        taskContext.comments.map(c => `- ${c.author}: ${c.text}`).join('\n');
    }
    prompt += '\n\nPlease begin working on this task.';

    if (session.startupSequence?.active && session.startupSequence.queue) {
      session.startupSequence.queue.push(prompt);
    } else {
      session.startupSequence = {
        active: true,
        queue: [prompt],
        waitingForIdle: true,
        sentCount: 0,
        lastSentAt: 0,
        completedAt: null
      };
    }
  }

  processStartupSequenceOnOutput(session, data) {
    if (!session?.startupSequence?.active || !session.pty) {
      return;
    }
    const startup = session.startupSequence;
    if (!startup.queue.length) {
      startup.active = false;
      startup.completedAt = new Date().toISOString();
      this.emit('sessionUpdated', this.getSessionSnapshot(session));
      return;
    }

    const nextStatus = this.detectStatus(data, session.status, session.cliType);
    const ready = nextStatus === 'idle' || /Would you like to proceed/i.test(data) || /Ask Codex to do anything/i.test(data);
    const now = Date.now();
    if (!ready) return;
    if (now - startup.lastSentAt < 1200) return;

    const nextCommand = startup.queue.shift();
    if (!nextCommand) {
      startup.active = false;
      startup.completedAt = new Date().toISOString();
      return;
    }

    session.pty.write(`${nextCommand}\r`);
    startup.sentCount += 1;
    startup.lastSentAt = now;
    this.emit('output', {
      sessionId: session.id,
      data: `\r\n\x1b[36m[startup] sent: ${nextCommand.slice(0, 64)}${nextCommand.length > 64 ? '...' : ''}\x1b[0m\r\n`
    });

    if (!startup.queue.length) {
      startup.active = false;
      startup.completedAt = new Date().toISOString();
      this.emit('sessionUpdated', this.getSessionSnapshot(session));
    }
  }

  rewarmSession(id, agent) {
    const session = this.sessions.get(id);
    if (!session || !session.pty) {
      return false;
    }
    this.runStartupSequence(session, agent, { force: true });
    return true;
  }

  /**
   * Create a new Claude CLI session
   * @param {string} name - Session name
   * @param {string} workingDir - Working directory for the session
   * @param {string} cliType - CLI type ('claude' or 'codex')
   * @returns {object} Session snapshot
   */
  createSession(name, workingDir = process.cwd(), cliType = 'claude', stageOpts = {}, role = '', sessionMeta = {}) {
    const id = uuidv4();
    const claudeSessionId = uuidv4(); // Generate Claude session ID upfront
    const now = new Date();
    const sanitizedRole = this.sanitizeRole(role);

    let ptyProcess;

    try {
      if (cliType === 'terminal') {
        ptyProcess = this.spawnTerminalProcess(workingDir);
      } else if (cliType === 'codex') {
        ptyProcess = this.spawnCodexProcess(workingDir, { resume: false });
      } else {
        ptyProcess = this.spawnClaudeProcess(workingDir, { sessionId: claudeSessionId, role: sanitizedRole });
      }
    } catch (error) {
      const cliName = cliType === 'codex' ? 'Codex' : cliType === 'terminal' ? 'Terminal' : 'Claude';
      throw new Error(`Failed to spawn ${cliName} CLI: ${error.message}`);
    }

    const session = {
      id,
      name,
      status: 'active',
      currentTask: '',
      createdAt: now,
      lastActivity: now,
      outputBuffer: new RingBuffer(this.getOutputBufferSize(cliType)),
      pty: ptyProcess,
      workingDir,
      cliType,  // 'claude' or 'codex'
      claudeSessionId: cliType === 'claude' ? claudeSessionId : null, // Only for Claude sessions
      previousClaudeSessionIds: [],
      notes: '',
      role: sanitizedRole,
      agentId: sessionMeta.agentId || null,
      taskId: sessionMeta.taskId || null,
      tags: [],
      plans: [],
      promptBuffer: '',      // Characters accumulated until Enter
      promptHistory: [],     // Recent prompts [{text, timestamp}]
      promptFlushTimer: null,
      inEscapeSeq: false,    // Track if we're inside an escape sequence
      isComposingPrompt: false, // True while user types draft text without Enter
      lastSubmittedInputAtMs: 0, // Timestamp of last submitted input (Enter/newline)
      statusDebounceTimer: null,  // Timer for debouncing status changes
      pendingStatus: null,        // Status waiting to be applied
      roleInjection: null,
      startupSequence: null,
      // Kanban stage fields
      stage: stageOpts.stage || 'todo',
      stageEnteredAt: now.toISOString(),
      priority: stageOpts.priority || 0,
      description: stageOpts.description || '',
      blockedBy: stageOpts.blockedBy || [],
      blocks: stageOpts.blocks || [],
      manuallyPlaced: false,
      manualPlacedAt: null,
      placementLocked: false,
      rejectionHistory: [],
      completedAt: null,
      updatedAt: now.toISOString(),
      comments: []
    };

    // Handle PTY output
    ptyProcess.onData((data) => {
      session.outputBuffer.push(data);
      if (shouldCountOutputAsActivity({
        data,
        isComposingPrompt: !!session.isComposingPrompt,
        lastSubmittedInputAtMs: session.lastSubmittedInputAtMs || 0,
        nowMs: Date.now()
      })) {
        session.lastActivity = new Date();
      }

      // Try to detect Claude session ID from output
      this.detectClaudeSessionId(data, session);
      this.tryRoleInjectionOnOutput(session, data);
      this.processStartupSequenceOnOutput(session, data);

      // Detect status from output (skip during resize — PTY redraws old content)
      if (!session.resizingUntil || Date.now() > session.resizingUntil) {
        const newStatus = this.detectStatus(data, session.status, session.cliType);
        if (newStatus !== session.status) {
          this.updateSessionStatus(session, newStatus);
        }
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

      // Don't process if session was intentionally killed
      if (session.status === 'killed') return;

      // Don't mark as completed if intentionally paused
      if (session.status === 'paused') {
        return;
      }

      // If session just started and immediately exited with error, keep it paused (don't delete)
      // This preserves sessions that fail to start
      const sessionAge = Date.now() - new Date(session.createdAt).getTime();
      debugLog(`PTY onExit for session ${id}: exitCode=${exitCode}, signal=${signal}, sessionAge=${sessionAge}ms`);
      if (sessionAge < 10000 && exitCode !== 0) {
        debugLog(`Session ${id} PAUSED due to early exit (age=${sessionAge}ms, exitCode=${exitCode})`);
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
      const endedSnapshot = this.getSessionSnapshot(session);
      this.dataStore.deleteSession(id);
      this.emit('statusChange', {
        sessionId: id,
        status: 'completed',
        currentTask: session.currentTask,
        exitCode,
        signal
      });
      this.emit('sessionEnded', { sessionId: id, exitCode, signal, session: endedSnapshot });
    });

    this.sessions.set(id, session);
    this.setupRoleInjectionWorkflow(session, 'create');

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
      const oldClaudeSessionId = session.claudeSessionId;

      // Before updating claudeSessionId, snapshot plans from the old transcript
      // so they survive the ID switch (e.g. after /clear)
      if (oldClaudeSessionId) {
        // Save old ID to history
        const history = Array.isArray(session.previousClaudeSessionIds)
          ? session.previousClaudeSessionIds
          : [];
        const withoutCurrent = history.filter(v => v !== oldClaudeSessionId);
        withoutCurrent.push(oldClaudeSessionId);
        session.previousClaudeSessionIds = withoutCurrent.slice(-20);

        // Snapshot transcript-tracked plans so they survive the ID switch
        const trackedPlanPaths = this.planManager.getPlansForClaudeSession(
          oldClaudeSessionId,
          session.workingDir
        );
        if (trackedPlanPaths.length > 0) {
          const existingPlans = new Set(session.plans || []);
          for (const p of trackedPlanPaths) existingPlans.add(p);
          session.plans = [...existingPlans];
        }
      }

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
    if (session.promptFlushTimer) {
      clearTimeout(session.promptFlushTimer);
      session.promptFlushTimer = null;
    }
    this.clearRoleInjectionWorkflow(session);

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

    debugLog(`Session ${id} PAUSED via pauseSession(). Stack: ${new Error().stack}`);

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
   * @param {object} options - Resume options
   * @param {boolean} options.fresh - Start a fresh CLI session instead of resuming
   * @returns {boolean} Success status
   */
  resumeSession(id, { fresh = false } = {}) {
    const session = this.sessions.get(id);
    if (!session) {
      return false;
    }

    if (session.status !== 'paused') {
      return false;
    }

    const cliType = session.cliType || 'claude';
    let ptyProcess;
    let claudeFallbackAttempted = false;
    let codexFallbackAttempted = false;
    let suppressNextExit = false;
    let shouldResyncClaudeSession = false;

    const createFreshClaudeProcess = ({ sessionId = null } = {}) => {
      return this.spawnClaudeProcess(session.workingDir, {
        sessionId,
        role: this.sanitizeRole(session.role || '')
      });
    };

    const createFreshCodexProcess = () => {
      return this.spawnCodexProcess(session.workingDir, { resume: false });
    };

    const handleClaudeResumeFallback = () => {
      if (cliType !== 'claude' || claudeFallbackAttempted) {
        return;
      }

      claudeFallbackAttempted = true;
      const oldClaudeSessionId = session.claudeSessionId;
      session.claudeSessionId = null;
      session.claudeSessionName = null;
      this.dataStore.saveSession(session);
      this.emit('sessionUpdated', {
        sessionId: id,
        claudeSessionId: null,
        claudeSessionName: null
      });

      this.emit('output', {
        sessionId: id,
        data: '\r\n\x1b[33mResume target not found. Starting a fresh Claude terminal so you can run /resume manually.\x1b[0m\r\n'
      });
      debugLog(`Session ${id}: Claude resume failed for ID ${oldClaudeSessionId || 'none'}, falling back to fresh Claude shell`);

      try {
        suppressNextExit = true;
        if (session.pty) {
          session.pty.kill();
        }
        const freshProcess = createFreshClaudeProcess();
        wirePtyHandlers(freshProcess);
      } catch (error) {
        this.emit('output', {
          sessionId: id,
          data: `\r\n\x1b[31mFallback launch failed: ${error.message}\x1b[0m\r\n`
        });
      }
    };

    const handleCodexResumeFallback = () => {
      if (cliType !== 'codex' || codexFallbackAttempted) {
        return false;
      }

      codexFallbackAttempted = true;

      this.emit('output', {
        sessionId: id,
        data: '\r\n\x1b[33mScoped Codex resume failed. Starting a fresh Codex session in this folder.\x1b[0m\r\n'
      });
      debugLog(`Session ${id}: Codex scoped resume failed, falling back to fresh Codex shell in ${session.workingDir}`);

      try {
        const freshProcess = createFreshCodexProcess();
        wirePtyHandlers(freshProcess);
        return true;
      } catch (error) {
        this.emit('output', {
          sessionId: id,
          data: `\r\n\x1b[31mFallback launch failed: ${error.message}\x1b[0m\r\n`
        });
        return false;
      }
    };

    const wirePtyHandlers = (processRef) => {
      session.pty = processRef;

      processRef.onData((data) => {
        session.outputBuffer.push(data);
        if (shouldCountOutputAsActivity({
          data,
          isComposingPrompt: !!session.isComposingPrompt,
          lastSubmittedInputAtMs: session.lastSubmittedInputAtMs || 0,
          nowMs: Date.now()
        })) {
          session.lastActivity = new Date();
        }

        this.detectClaudeSessionId(data, session);
        this.tryRoleInjectionOnOutput(session, data);
        this.processStartupSequenceOnOutput(session, data);

        if (cliType === 'claude' && /No conversation found with session ID/i.test(data)) {
          handleClaudeResumeFallback();
          this.emit('output', { sessionId: id, data });
          return;
        }

        // Detect status from output (skip during resize — PTY redraws old content)
        if (!session.resizingUntil || Date.now() > session.resizingUntil) {
          const newStatus = this.detectStatus(data, session.status, session.cliType);
          if (newStatus !== session.status && newStatus !== 'paused') {
            this.updateSessionStatus(session, newStatus);
          }
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

      processRef.onExit(({ exitCode, signal }) => {
        // Expected exit from fallback transition (old process killed intentionally)
        if (suppressNextExit) {
          suppressNextExit = false;
          return;
        }

        // Don't process if shutting down (cleanup handles this)
        if (this.isShuttingDown) return;

        // Don't process if session was intentionally killed
        if (session.status === 'killed') return;

        // Don't mark as completed if intentionally paused
        if (session.status === 'paused') {
          return;
        }

        // If session just started and immediately exited with error, keep it paused (don't delete)
        // This preserves sessions that fail to resume (e.g., "Session ID already in use")
        const sessionAge = Date.now() - new Date(session.lastActivity).getTime();
        debugLog(`PTY onExit (resume) for session ${id}: exitCode=${exitCode}, signal=${signal}, sessionAge=${sessionAge}ms`);
        if (cliType === 'codex' && sessionAge < 10000 && exitCode !== 0 && handleCodexResumeFallback()) {
          return;
        }

        if (sessionAge < 10000 && exitCode !== 0) {
          debugLog(`Session ${id} PAUSED due to early exit after resume (age=${sessionAge}ms, exitCode=${exitCode})`);
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

        debugLog(`Session ${id} marked COMPLETED (exitCode=${exitCode}, signal=${signal})`);
        session.status = 'completed';
        const endedSnapshot = this.getSessionSnapshot(session);
        this.dataStore.deleteSession(id);
        this.emit('statusChange', {
          sessionId: id,
          status: 'completed',
          currentTask: session.currentTask,
          exitCode,
          signal
        });
        this.emit('sessionEnded', { sessionId: id, exitCode, signal, session: endedSnapshot });
      });
    };

    if (fresh) {
      session.outputBuffer = new RingBuffer(this.getOutputBufferSize(cliType));

      if (cliType === 'claude') {
        const oldClaudeSessionId = session.claudeSessionId;
        if (oldClaudeSessionId) {
          const history = Array.isArray(session.previousClaudeSessionIds)
            ? session.previousClaudeSessionIds
            : [];
          const withoutCurrent = history.filter((value) => value !== oldClaudeSessionId);
          withoutCurrent.push(oldClaudeSessionId);
          session.previousClaudeSessionIds = withoutCurrent.slice(-20);

          // Snapshot transcript-tracked plans so they survive the fresh start
          const trackedPlanPaths = this.planManager.getPlansForClaudeSession(
            oldClaudeSessionId,
            session.workingDir
          );
          if (trackedPlanPaths.length > 0) {
            const existingPlans = new Set(session.plans || []);
            for (const p of trackedPlanPaths) existingPlans.add(p);
            session.plans = [...existingPlans];
          }
        }

        session.claudeSessionId = uuidv4();
        session.claudeSessionName = null;
        shouldResyncClaudeSession = true;
      }
    }

    try {
      if (cliType === 'terminal') {
        ptyProcess = this.spawnTerminalProcess(session.workingDir);
      } else if (cliType === 'codex') {
        // Resume Codex in the same working directory to avoid cross-project jumps.
        ptyProcess = this.spawnCodexProcess(session.workingDir, { resume: !fresh });
      } else {
        if (fresh) {
          ptyProcess = createFreshClaudeProcess({ sessionId: session.claudeSessionId });
        } else {
          // Claude: resume existing session when possible, and append role for consistency.
          ptyProcess = this.spawnClaudeProcess(session.workingDir, {
            resumeId: session.claudeSessionId || null,
            role: this.sanitizeRole(session.role || '')
          });
        }
      }
    } catch (error) {
      console.error(`Failed to resume session ${id}:`, error.message);
      return false;
    }

    session.status = 'active';
    session.lastActivity = new Date();

    // Re-setup PTY handlers
    wirePtyHandlers(ptyProcess);
    this.setupRoleInjectionWorkflow(session, 'resume');

    if (cliType === 'claude') {
      if (session.claudeIndexWatcher) {
        try {
          session.claudeIndexWatcher.close();
        } catch (e) {
          // Ignore watcher close errors
        }
        session.claudeIndexWatcher = null;
      }
      this.watchClaudeSessionForUpdates(session);
      if (shouldResyncClaudeSession) {
        this.syncWithClaudeSession(session);
      }
    }

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
    if (meta.role !== undefined) session.role = this.sanitizeRole(meta.role);
    if (meta.tags !== undefined) session.tags = meta.tags;
    if (meta.taskId !== undefined) session.taskId = meta.taskId || null;
    if (meta.cliType !== undefined && ['claude', 'codex', 'terminal'].includes(meta.cliType)) {
      session.cliType = meta.cliType;
    }
    if (meta.priority !== undefined) session.priority = meta.priority;
    if (meta.description !== undefined) session.description = meta.description;

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
      const canGoIdle = ['active', 'editing', 'waiting', 'thinking'].includes(session.status) &&
        this.canTransitionToIdle(session);
      if (idleTime > 5000 && canGoIdle) {
        const oldStatus = session.status;
        session.status = 'idle';
        this.emit('statusChange', {
          sessionId: session.id,
          status: 'idle',
          currentTask: session.currentTask
        });
        // Reconcile prompts from transcript when going idle
        if (['active', 'thinking', 'editing'].includes(oldStatus)) {
          this.reconcilePromptsFromTranscript(session);
        }
      }
    }, 1000);
  }

  /**
   * Whether inactivity should auto-transition this session to idle.
   * Codex can run long silent commands, so output silence is not a reliable idle signal.
   * @param {object} session - Session object
   * @returns {boolean}
   */
  canTransitionToIdle(session) {
    return (session?.cliType || 'claude') !== 'codex';
  }

  /**
   * Detect session status from terminal output
   * @param {string} data - Terminal output data
   * @param {string} currentStatus - Current session status
   * @param {string} cliType - CLI type ('claude', 'codex', 'terminal')
   * @returns {string} Detected status
   */
  detectStatus(data, currentStatus, cliType = 'claude') {
    // Don't change status if paused
    if (currentStatus === 'paused') {
      return 'paused';
    }

    // Strip ANSI escape sequences for pattern matching
    const stripped = data.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '').replace(/\x1b\][^\x07]*\x07/g, '').trim();

    // Sticky waiting: don't let single-char spinner output override waiting status.
    // Once a prompt like "Would you like to proceed?" is detected, only substantive
    // output (>= 3 chars) can transition away from waiting.
    if (currentStatus === 'waiting' && stripped.length < 3) {
      return 'waiting';
    }

    // Detect Claude Code thinking spinner before length guard.
    // Spinner chars (✻ ✢ ✽ *) arrive as single-char PTY chunks during animation.
    // Anchors ensure entire stripped output is just one spinner char — no false positives.
    if (/^[\u2721-\u2749\u002A]$/.test(stripped)) {
      return 'thinking';
    }

    // Skip trivial output (escape sequences, cursor movements, single chars)
    if (stripped.length < 3) {
      return currentStatus;
    }

    // Detect thinking/processing indicators
    const thinkingPatterns = [
      // Claude Code patterns
      /Thinking/i,
      /Processing/i,
      /\u2726/,                        // ✦ Claude Code thinking icon
      /Scampering/i,
      /Pondering/i,
      /Reasoning/i,
      /Contemplating/i,
      /Analyzing/i,
      /Researching/i,
      /Investigating/i,
      /Examining/i,
      /Considering/i,
      /\(thought for \d+/i,            // "(thought for 2s)" pattern
      /[\u2800-\u28FF]/,               // Braille spinners (all 256 variants)
      /[\u2721-\u2749]/,               // Dingbat stars/asterisks: ✳✻✱✶ etc.
      /\b[A-Z][a-z]+ing\s*\.{3}/,     // "Doing...", "Reading..." with ASCII dots
      /\b[A-Z][a-z]+ing\s*\u2026/,    // "Doing…", "Reading…" with Unicode ellipsis
      // Codex CLI patterns
      /\u2022\s*Working\s*\(/,         // • Working (Xs . esc to interrupt)
      /esc to interrupt/i,             // Generic Codex working indicator
      /\u2022\s*\w+ing\s.*\(\d+s/     // • Investigating... (0s — contextual thinking
    ];

    for (const pattern of thinkingPatterns) {
      if (pattern.test(data)) {
        return 'thinking';
      }
    }

    // Detect editing patterns (must match actual tool-call output, not generic words)
    const editingPatterns = [
      // Claude Code tool-call patterns
      /Write\(.+\)/,                  // Write(path/to/file)
      /Edit\(.+\)/,                   // Edit(path/to/file)
      /MultiEdit\(.+\)/,             // MultiEdit(path/to/file)
      /Creating file/i,
      // Codex CLI patterns
      /\u2022\s*Edited/i,             // • Edited <file> (+N -N)
      /\u2022\s*Added/i,              // • Added <file>
      /\u2022\s*Deleted/i,            // • Deleted <file>
      /\u2714.*approved.*to run/i     // ✔ You approved codex to run
    ];

    for (const pattern of editingPatterns) {
      if (pattern.test(data)) {
        return 'editing';
      }
    }

    // Codex-specific prompt footer means work is done and user input is expected.
    // This is a stronger signal than inactivity for Codex runs.
    if (cliType === 'codex') {
      const codexPromptReadyPatterns = [
        /Ask Codex to do anything/i,
        /\?\s*for shortcuts/i
      ];
      for (const pattern of codexPromptReadyPatterns) {
        if (pattern.test(data)) {
          return 'idle';
        }
      }
    }

    // Detect waiting for input
    const waitingPatterns = [
      /^\s*>\s*$/m,
      /\?\s*$/,
      /Enter.*:/i,
      /Press.*to continue/i,
      /\[Y\/n\]/i,
      /\[y\/N\]/i,
      // Codex CLI patterns
      /Would you like to run/i,       // Codex approval prompt
      /Implement this plan\?/i,       // Codex plan mode prompt
      // Claude multi-choice prompts
      /^\s*>\s*\d+\./m,               // "> 1." — cursor on numbered option line
      /Would you like to proceed/i,   // Claude plan approval prompt
      /Type .* to (change|tell)/i     // "Type here to tell Claude what to change"
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
    // Strip ANSI escape sequences first (matching detectStatus pattern)
    const stripped = data.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '')
                         .replace(/\x1b\][^\x07]*\x07/g, '')
                         .trim();

    // Look for common task patterns
    const taskPatterns = [
      /Working on[:\s]+(.+)/i,
      /Task[:\s]+(.+)/i,
      /Analyzing[:\s]+(.+)/i,
      /Reading[:\s]+(.+)/i,
      /Searching[:\s]+(.+)/i
    ];

    for (const pattern of taskPatterns) {
      const match = stripped.match(pattern);
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
      /wrote.*plan.*\.md/i,
      /Saved.*plan/i,
      /plan.*saved/i,
      /\.claude[/\\]plans[/\\].*\.md/i,
      /written up a plan/i,
      /ready to execute/i
    ];

    for (const pattern of planPatterns) {
      if (pattern.test(data)) {
        // Debounce: don't emit more than once per 2 seconds
        const now = Date.now();
        if (!session.lastPlanEmit || now - session.lastPlanEmit > 2000) {
          session.lastPlanEmit = now;

          // Emit sessionUpdated to trigger frontend refresh
          this.emit('sessionUpdated', {
            id: session.id,
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
    // If same as current status, cancel any pending transition
    if (newStatus === session.status) {
      session.pendingStatus = null;
      if (session.statusDebounceTimer) {
        clearTimeout(session.statusDebounceTimer);
        session.statusDebounceTimer = null;
      }
      return;
    }

    // If already pending the same status, let existing timer run (don't reset).
    // This prevents continuous output from starving the debounce timer.
    if (session.pendingStatus === newStatus && session.statusDebounceTimer) {
      return;
    }

    // Different pending status — clear old timer and start new one
    if (session.statusDebounceTimer) {
      clearTimeout(session.statusDebounceTimer);
      session.statusDebounceTimer = null;
    }

    session.pendingStatus = newStatus;

    // Debounce: only emit after 500ms of stability
    session.statusDebounceTimer = setTimeout(() => {
      if (session.pendingStatus && session.pendingStatus !== session.status) {
        const oldStatus = session.status;
        session.status = session.pendingStatus;
        session.pendingStatus = null;
        debugLog(`Status change for session ${session.id}: ${oldStatus} -> ${session.status}`);
        this.dataStore.saveSession(session);
        this.emit('statusChange', {
          sessionId: session.id,
          status: session.status,
          currentTask: session.currentTask
        });

        // When transitioning to idle or waiting, reconcile prompts from JSONL transcript
        // to catch any missed by keystroke-based detection (e.g. slash commands)
        if (['idle', 'waiting'].includes(session.status) && ['active', 'thinking', 'editing'].includes(oldStatus)) {
          this.reconcilePromptsFromTranscript(session);
        }
      }
      session.statusDebounceTimer = null;
    }, 500);
  }

  clearPromptFlushTimer(session) {
    if (!session?.promptFlushTimer) {
      return;
    }
    clearTimeout(session.promptFlushTimer);
    session.promptFlushTimer = null;
  }

  flushPromptBuffer(session) {
    if (!session) {
      return;
    }

    this.clearPromptFlushTimer(session);
    const promptText = session.promptBuffer.trim();
    if (promptText.length > 3) {
      this.addPromptToHistory(session, promptText);
    }
    session.promptBuffer = '';
    session.isComposingPrompt = false;
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
    this.clearPromptFlushTimer(session);
    this.clearRoleInjectionWorkflow(session);

    // Close Claude sessions watcher
    if (session.claudeIndexWatcher) {
      try {
        session.claudeIndexWatcher.close();
      } catch (e) {
        // Ignore
      }
    }

    // Mark as intentionally killed so onExit handler won't re-persist
    session.status = 'killed';

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

    const endedSnapshot = this.getSessionSnapshot(session);
    this.sessions.delete(id);
    this.emit('sessionKilled', { sessionId: id, session: endedSnapshot });

    return true;
  }

  /**
   * Apply a status change from a Claude Code lifecycle hook.
   * Hook events provide authoritative signals (e.g. Stop = Claude finished)
   * that bypass the noisy PTY regex detection.
   */
  applyHookStatus({ cwd, claudeSessionId, status, hookEvent }) {
    // Find session: prefer exact claudeSessionId match, fall back to workingDir
    let session = claudeSessionId
      ? [...this.sessions.values()].find(s => s.claudeSessionId === claudeSessionId)
      : null;
    if (!session) {
      session = [...this.sessions.values()].find(
        s => s.workingDir === cwd && s.cliType === 'claude' && s.status !== 'paused'
      );
    }
    if (!session) return;

    const prev = session.status;

    if (hookEvent === 'Stop' || hookEvent === 'Notification') {
      // Claude finished or waiting for user input (e.g. AskUserQuestion) — force idle
      if (session.idleTimer) {
        clearInterval(session.idleTimer);
        session.idleTimer = null;
      }
      session.lastActivity = new Date(0);
      session.status = 'idle';
    } else if (hookEvent === 'UserPromptSubmit') {
      session.status = 'active';
      session.lastActivity = new Date();
    } else if (hookEvent === 'PreToolUse' && session.status !== 'idle') {
      session.status = 'editing';
      session.lastActivity = new Date();
    }

    if (session.status !== prev) {
      this.dataStore.saveSession(session);
      this.emit('statusChange', {
        sessionId: session.id,
        status: session.status,
        source: 'hook',
      });
      // Restart idle detection after non-Stop events
      if (hookEvent !== 'Stop') this.startIdleDetection(session);
    }
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
      // Filter out focus reporting sequences that xterm.js may send
      // These can interfere with Claude CLI
      const filteredText = text.replace(/\x1b\[[IO]/g, '');
      if (!filteredText) {
        return true; // Nothing left to send after filtering
      }

      session.pty.write(filteredText);
      const isSubmittedInput = hasSubmittedInput(filteredText);
      if (isSubmittedInput) {
        session.lastSubmittedInputAtMs = Date.now();
        session.isComposingPrompt = false;

        // Resume auto-sync when user submits input (unless explicitly locked)
        if (session.manuallyPlaced && !session.placementLocked) {
          session.manuallyPlaced = false;
          session.manualPlacedAt = null;
        }
      }

      // Prompt detection - buffer until Enter.
      // Treat multiline paste chunks as a single prompt entry.
      const hasNewline = filteredText.includes('\r') || filteredText.includes('\n');
      const isMultilineChunk = hasNewline && filteredText.length > 1;

      if (isMultilineChunk) {
        const combined = `${session.promptBuffer}${filteredText}`
          .replace(/\r\n/g, '\n')
          .replace(/\r/g, '\n')
          .trim();
        if (combined.length > 3) {
          this.addPromptToHistory(session, combined);
        }
        session.promptBuffer = '';
        this.clearPromptFlushTimer(session);
        session.lastActivity = new Date();
        session.isComposingPrompt = false;
      } else {
        for (const char of filteredText) {
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
            this.clearPromptFlushTimer(session);
            session.promptBuffer += '\n';
            session.promptFlushTimer = setTimeout(() => {
              this.flushPromptBuffer(session);
            }, 250);
            session.lastActivity = new Date();
            session.isComposingPrompt = session.promptBuffer.trim().length > 0;
          } else if (char === '\x7f' || char === '\b') {
            // Handle backspace
            session.promptBuffer = session.promptBuffer.slice(0, -1);
            if (session.promptBuffer.length === 0) {
              session.isComposingPrompt = false;
            }
          } else if (code >= 32 && code < 127) {
            // Only add printable ASCII characters
            session.promptBuffer += char;
            session.isComposingPrompt = true;
          }
        }
      }

      if (isSubmittedInput) {
        this.flushPromptBuffer(session);
      }

      // Only submitted input (Enter/newline) flips state back to active.
      if (isSubmittedInput && (session.status === 'idle' || session.status === 'waiting')) {
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
      .replace(/\r\n/g, '\n')
      .replace(/\r/g, '\n')
      .replace(/\n{3,}/g, '\n\n')
      .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '') // Control chars except \n and \t
      .replace(/\t/g, '  ')
      .trim();

    if (cleanText.length <= 3) return;  // Skip if too short after cleanup

    const trimmedForCheck = cleanText.trimStart();
    if (
      trimmedForCheck.startsWith('<task-notification') ||
      trimmedForCheck.startsWith('<tool-use-') ||
      trimmedForCheck.startsWith('<system-') ||
      trimmedForCheck.startsWith('<command-') ||
      trimmedForCheck.startsWith('<environment-')
    ) {
      return;
    }

    const last = session.promptHistory[session.promptHistory.length - 1];
    if (last && last.text.slice(0, 50) === cleanText.slice(0, 50)) {
      return;
    }

    const truncatedText = cleanText.length > MAX_PROMPT_HISTORY_CHARS
      ? `${cleanText.slice(0, MAX_PROMPT_HISTORY_CHARS)}\n...[truncated]`
      : cleanText;

    const prompt = { text: truncatedText, timestamp: new Date().toISOString() };
    session.promptHistory.push(prompt);
    if (session.promptHistory.length > MAX_PROMPT_HISTORY_COUNT) {
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
   * Reconcile promptHistory with the Claude session JSONL transcript.
   * The transcript is the authoritative source — this catches prompts
   * missed by keystroke-based detection (e.g. slash command autocomplete).
   * @param {object} session - Session object
   */
  reconcilePromptsFromTranscript(session) {
    if (!session.claudeSessionId || (session.cliType && session.cliType !== 'claude')) {
      return;
    }

    try {
      const transcript = this.getClaudeSessionTranscript(session.claudeSessionId, session.workingDir);
      if (!transcript || !transcript.userPrompts || transcript.userPrompts.length === 0) {
        return;
      }

      const existingTexts = new Set(
        session.promptHistory.map(p => p.text.slice(0, 100))
      );

      let added = false;
      for (const tp of transcript.userPrompts) {
        // Check if this transcript prompt is already in our history
        // Compare by prefix to handle truncation differences
        const prefix = tp.text.slice(0, 100);
        if (existingTexts.has(prefix)) {
          continue;
        }

        // Also check if any existing prompt starts with the same text (fuzzy match)
        let found = false;
        for (const existing of session.promptHistory) {
          if (existing.text.slice(0, 50) === tp.text.slice(0, 50)) {
            found = true;
            break;
          }
        }
        if (found) continue;

        const truncatedText = tp.text.length > MAX_PROMPT_HISTORY_CHARS
          ? `${tp.text.slice(0, MAX_PROMPT_HISTORY_CHARS)}\n...[truncated]`
          : tp.text;

        let replaced = false;
        if (tp.timestamp) {
          const tpTime = new Date(tp.timestamp).getTime();
          for (const existing of session.promptHistory) {
            const existingTime = new Date(existing.timestamp).getTime();
            if (Number.isNaN(tpTime) || Number.isNaN(existingTime)) {
              continue;
            }
            if (Math.abs(tpTime - existingTime) < 5000) {
              if (existing.text.slice(0, 50) !== truncatedText.slice(0, 50)) {
                existing.text = truncatedText;
                existing.timestamp = tp.timestamp;
                existingTexts.add(truncatedText.slice(0, 100));
                replaced = true;
                added = true;
              }
              break;
            }
          }
        }

        if (!replaced) {
          session.promptHistory.push({
            text: truncatedText,
            timestamp: tp.timestamp || new Date().toISOString()
          });
          existingTexts.add(truncatedText.slice(0, 100));
          added = true;
        }
      }

      if (added) {
        // Sort by timestamp and trim to the configured history window.
        session.promptHistory.sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));
        while (session.promptHistory.length > MAX_PROMPT_HISTORY_COUNT) {
          session.promptHistory.shift();
        }

        this.dataStore.saveSession(session);
        this.emit('promptAdded', {
          sessionId: session.id,
          prompt: session.promptHistory[session.promptHistory.length - 1],
          promptHistory: session.promptHistory
        });
      }
    } catch (error) {
      debugLog(`Prompt reconciliation failed for session ${session.id}: ${error.message}`);
    }
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
      // Cancel any pending status change queued before resize
      if (session.statusDebounceTimer) {
        clearTimeout(session.statusDebounceTimer);
        session.statusDebounceTimer = null;
      }
      session.pendingStatus = null;
      // Suppress status detection for 2s (PTY redraws old content on resize)
      session.resizingUntil = Date.now() + 2000;
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
      previousClaudeSessionIds: session.previousClaudeSessionIds || [],
      claudeSessionName: session.claudeSessionName || null,
      notes: session.notes || '',
      role: session.role || '',
      agentId: session.agentId || null,
      taskId: session.taskId || null,
      tags: session.tags || [],
      plans: session.plans || [],
      promptHistory: session.promptHistory || [],
      lastSubmittedInputAtMs: session.lastSubmittedInputAtMs || 0,
      // Kanban stage fields
      stage: session.stage || 'todo',
      stageEnteredAt: session.stageEnteredAt || null,
      priority: session.priority || 0,
      description: session.description || '',
      blockedBy: session.blockedBy || [],
      blocks: session.blocks || [],
      manuallyPlaced: session.manuallyPlaced || false,
      manualPlacedAt: session.manualPlacedAt || null,
      placementLocked: session.placementLocked || false,
      rejectionHistory: session.rejectionHistory || [],
      completedAt: session.completedAt || null,
      updatedAt: session.updatedAt || null,
      comments: session.comments || []
      ,
      startupSequence: session.startupSequence
        ? {
            active: !!session.startupSequence.active,
            remaining: session.startupSequence.queue?.length || 0,
            sentCount: session.startupSequence.sentCount || 0,
            completedAt: session.startupSequence.completedAt || null
          }
        : null
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

    // If we have a Claude session ID, combine Claude-tracked plans with manually associated plans.
    // Manual associations come from the "+" context flow and must appear immediately.
    if (session.claudeSessionId && session.workingDir) {
      const trackedPlanPaths = this.planManager.getPlansForClaudeSession(
        session.claudeSessionId,
        session.workingDir
      );

      const allPlanRefs = [...trackedPlanPaths, ...(session.plans || [])];
      const seen = new Set();
      const plans = [];

      for (const planRef of allPlanRefs) {
        const plan = this.planManager.getPlanContent(planRef);
        if (plan) {
          const key = plan.path || plan.filename;
          if (!seen.has(key)) {
            seen.add(key);
            plans.push(plan);
          }
        }
      }

      // Sort by modified time (newest first)
      plans.sort((a, b) => new Date(b.modifiedAt) - new Date(a.modifiedAt));
      return plans;
    }

    // Fallback for non-Claude sessions: return plans explicitly associated with this session.
    // These come from direct user actions such as pasting or manually attaching a plan,
    // so they must remain visible even when the plan body references a different path format.
    const plans = [];

    for (const planPath of (session.plans || [])) {
      const plan = this.planManager.getPlanContent(planPath);
      if (!plan) {
        console.warn(`getSessionPlans: getPlanContent returned null for path="${planPath}" session=${id} cliType=${session.cliType}`);
        continue;
      }
      plans.push(plan);
    }
    // Sort by modified time (newest first)
    plans.sort((a, b) => new Date(b.modifiedAt) - new Date(a.modifiedAt));
    return plans;
  }

  /**
   * Read a Claude session transcript (JSONL) and extract user prompts
   * @param {string} claudeSessionId - The Claude session UUID
   * @param {string} workingDir - Working directory to locate the project folder
   * @returns {object|null} Transcript summary with user prompts
   */
  getClaudeSessionTranscript(claudeSessionId, workingDir) {
    try {
      const projectPath = this.getClaudeProjectPath(workingDir);
      const jsonlPath = path.join(projectPath, `${claudeSessionId}.jsonl`);

      if (!fs.existsSync(jsonlPath)) {
        return null;
      }

      const data = fs.readFileSync(jsonlPath, 'utf8');
      const lines = data.trim().split('\n');
      const userPrompts = [];
      let sessionInfo = {};

      for (const line of lines) {
        try {
          const entry = JSON.parse(line);

          // Extract session metadata from first user message
          if (entry.type === 'user' && entry.message?.role === 'user') {
            const content = entry.message.content;
            const text = typeof content === 'string' ? content :
              Array.isArray(content) ? content.filter(c => c.type === 'text').map(c => c.text).join('\n') :
              '';
            const trimmedText = text.trimStart();

            if (
              text &&
              !trimmedText.startsWith('<task-notification') &&
              !trimmedText.startsWith('<tool-use-') &&
              !trimmedText.startsWith('<system-') &&
              !trimmedText.startsWith('<command-') &&
              !trimmedText.startsWith('<environment-')
            ) {
              userPrompts.push({
                text: text.length > 500 ? text.slice(0, 500) + '...' : text,
                timestamp: entry.timestamp,
                uuid: entry.uuid
              });
            }

            if (!sessionInfo.cwd) {
              sessionInfo.cwd = entry.cwd;
              sessionInfo.version = entry.version;
              sessionInfo.gitBranch = entry.gitBranch;
            }
          }
        } catch {
          // Skip malformed lines
        }
      }

      return {
        claudeSessionId,
        jsonlPath,
        ...sessionInfo,
        userPrompts,
        totalLines: lines.length,
        lastModified: fs.statSync(jsonlPath).mtime.toISOString()
      };
    } catch (error) {
      console.error('Error reading Claude session transcript:', error.message);
      return null;
    }
  }

  /**
   * List all Claude sessions available for a working directory
   * Returns session IDs with summaries for manual linking
   * @param {string} workingDir - Working directory
   * @returns {Array} Array of session summaries
   */
  listClaudeSessionsForLinking(workingDir) {
    const sessions = this.getClaudeSessions(workingDir);
    const results = [];

    for (const session of sessions) {
      const sessionId = session.sessionId;
      const transcript = this.getClaudeSessionTranscript(sessionId, workingDir);

      results.push({
        sessionId,
        modified: session.modified,
        created: session.created,
        summary: session.summary || null,
        firstPrompt: transcript?.userPrompts?.[0]?.text || null,
        lastPrompt: transcript?.userPrompts?.slice(-1)[0]?.text || null,
        promptCount: transcript?.userPrompts?.length || 0
      });
    }

    // Sort by modified desc
    results.sort((a, b) => new Date(b.modified) - new Date(a.modified));
    return results;
  }

  /**
   * Generate a new Claude session ID, link it, auto-tag, and inject the launch command into the terminal
   * Used for terminal sessions where the user wants to launch Claude Code CLI with a known session ID
   * @param {string} sessionId - Our session ID
   * @returns {string|null} The generated Claude session ID, or null if session not found
   */
  generateAndInjectClaudeSession(sessionId) {
    const session = this.sessions.get(sessionId);
    if (!session) return null;

    const claudeSessionId = uuidv4();

    // Link it
    session.claudeSessionId = claudeSessionId;

    // Auto-tag
    if (!session.tags) session.tags = [];
    if (!session.tags.includes('claude-code')) session.tags.push('claude-code');

    const command = `cc --session-id ${claudeSessionId}`;

    // Persist & notify
    this.dataStore.saveSession(session);
    this.emit('sessionUpdated', { sessionId, claudeSessionId, tags: session.tags });

    // Start watching for Claude session updates
    this.watchClaudeSessionForUpdates(session);

    return { claudeSessionId, command };
  }

  /**
   * Manually link a Claude session ID to one of our sessions
   * @param {string} sessionId - Our session ID
   * @param {string} claudeSessionId - The Claude session UUID to link
   * @returns {boolean} Success
   */
  linkClaudeSession(sessionId, claudeSessionId) {
    const session = this.sessions.get(sessionId);
    if (!session) return false;

    session.claudeSessionId = claudeSessionId;
    this.dataStore.saveSession(session);

    this.emit('sessionUpdated', {
      sessionId,
      claudeSessionId
    });

    return true;
  }

  // ============================================
  // Kanban Stage Methods
  // ============================================

  /**
   * Move a session to a different stage
   */
  moveSession(id, targetStageId, { reason = null, source = 'system' } = {}) {
    const session = this.sessions.get(id);
    if (!session) throw new Error(`Session not found: ${id}`);

    // Auto-sync must not override manual placement
    if (source === 'auto' && session.manuallyPlaced) return this.getSessionSnapshot(session);

    const targetStage = this.stages.find(s => s.id === targetStageId);
    if (!targetStage) throw new Error(`Stage not found: ${targetStageId}`);

    if (session.stage === targetStageId) return this.getSessionSnapshot(session);

    const previousStage = session.stage;
    const currentOrder = this.stages.find(s => s.id === session.stage)?.order ?? 0;
    const targetOrder = targetStage.order;

    // Record rejection history for backward moves
    if (targetOrder < currentOrder && reason) {
      session.rejectionHistory.push({
        from: previousStage,
        to: targetStageId,
        reason,
        at: new Date().toISOString()
      });
    }

    session.stage = targetStageId;
    session.stageEnteredAt = new Date().toISOString();
    console.log(`[Kanban] Session ${session.name || id} moved: ${previousStage} → ${targetStageId} (source: ${source}${reason ? ', reason: ' + reason : ''})`);
    session.updatedAt = new Date().toISOString();
    if (targetStageId === 'done') {
      session.completedAt = new Date().toISOString();
    }

    if (source === 'manual') {
      session.manuallyPlaced = true;
      session.manualPlacedAt = new Date().toISOString();
    }

    this.dataStore.saveSession(session);
    this.emit('sessionMoved', {
      sessionId: id,
      fromStage: previousStage,
      toStage: targetStageId,
      reason
    });
    this.emit('sessionUpdated', this.getSessionSnapshot(session));

    return this.getSessionSnapshot(session);
  }

  /**
   * Advance session to next stage
   */
  advanceSession(id) {
    const session = this.sessions.get(id);
    if (!session) throw new Error(`Session not found: ${id}`);

    const nextStage = getNextStage(this.stages, session.stage);
    if (!nextStage) throw new Error(`No next stage from: ${session.stage}`);

    return this.moveSession(id, nextStage.id);
  }

  /**
   * Reject session back to previous stage
   */
  rejectSession(id, reason, targetStageId = null) {
    const session = this.sessions.get(id);
    if (!session) throw new Error(`Session not found: ${id}`);

    let targetStage;
    if (targetStageId) {
      targetStage = this.stages.find(s => s.id === targetStageId);
    } else {
      targetStage = getPreviousStage(this.stages, session.stage);
    }

    if (!targetStage) throw new Error(`No valid rejection target from: ${session.stage}`);

    return this.moveSession(id, targetStage.id, { reason });
  }

  /**
   * Add a dependency between sessions
   */
  addDependency(sessionId, blockerId) {
    const session = this.sessions.get(sessionId);
    const blocker = this.sessions.get(blockerId);
    if (!session) throw new Error(`Session not found: ${sessionId}`);
    if (!blocker) throw new Error(`Blocker session not found: ${blockerId}`);

    if (!session.blockedBy.includes(blockerId)) {
      session.blockedBy.push(blockerId);
    }
    if (!blocker.blocks.includes(sessionId)) {
      blocker.blocks.push(sessionId);
    }

    session.updatedAt = new Date().toISOString();
    blocker.updatedAt = new Date().toISOString();

    this.dataStore.saveSession(session);
    this.dataStore.saveSession(blocker);
    this.emit('sessionUpdated', this.getSessionSnapshot(session));
    this.emit('sessionUpdated', this.getSessionSnapshot(blocker));

    return this.getSessionSnapshot(session);
  }

  /**
   * Remove a dependency between sessions
   */
  removeDependency(sessionId, blockerId) {
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error(`Session not found: ${sessionId}`);

    session.blockedBy = session.blockedBy.filter(id => id !== blockerId);
    const blocker = this.sessions.get(blockerId);
    if (blocker) {
      blocker.blocks = blocker.blocks.filter(id => id !== sessionId);
      blocker.updatedAt = new Date().toISOString();
      this.dataStore.saveSession(blocker);
    }

    session.updatedAt = new Date().toISOString();
    this.dataStore.saveSession(session);
    this.emit('sessionUpdated', this.getSessionSnapshot(session));

    return this.getSessionSnapshot(session);
  }

  /**
   * Lock session to its current column (prevent auto-sync)
   */
  lockPlacement(id) {
    const session = this.sessions.get(id);
    if (!session) throw new Error(`Session not found: ${id}`);

    session.manuallyPlaced = true;
    session.placementLocked = true;
    session.manualPlacedAt = new Date().toISOString();
    session.updatedAt = new Date().toISOString();

    this.dataStore.saveSession(session);
    this.emit('sessionUpdated', this.getSessionSnapshot(session));
    return this.getSessionSnapshot(session);
  }

  /**
   * Reset manual placement lock
   */
  resetManualPlacement(id) {
    const session = this.sessions.get(id);
    if (!session) throw new Error(`Session not found: ${id}`);

    session.manuallyPlaced = false;
    session.placementLocked = false;
    session.manualPlacedAt = null;
    session.updatedAt = new Date().toISOString();

    this.dataStore.saveSession(session);
    this.emit('sessionUpdated', this.getSessionSnapshot(session));
    return this.getSessionSnapshot(session);
  }

  /**
   * Add a comment to a session
   */
  addComment(sessionId, text, author = 'user') {
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error(`Session not found: ${sessionId}`);

    const comment = {
      id: uuidv4().slice(0, 8),
      text,
      author,
      createdAt: new Date().toISOString()
    };

    session.comments.push(comment);
    session.updatedAt = new Date().toISOString();
    this.dataStore.saveSession(session);
    this.emit('sessionUpdated', this.getSessionSnapshot(session));

    return comment;
  }

  /**
   * Get sessions grouped by stage
   */
  getSessionsByStage() {
    const grouped = {};
    for (const stage of this.stages) {
      grouped[stage.id] = [];
    }
    for (const session of this.sessions.values()) {
      const stageId = session.stage || 'todo';
      if (!grouped[stageId]) grouped[stageId] = [];
      grouped[stageId].push(this.getSessionSnapshot(session));
    }
    return grouped;
  }

  /**
   * Get stage statistics
   */
  getStageStats() {
    const stats = {};
    for (const stage of this.stages) {
      const stageSessions = [...this.sessions.values()].filter(s => s.stage === stage.id);
      stats[stage.id] = {
        total: stageSessions.length,
        active: stageSessions.filter(s => ['active', 'thinking', 'editing'].includes(s.status)).length,
        paused: stageSessions.filter(s => s.status === 'paused').length,
        idle: stageSessions.filter(s => s.status === 'idle').length
      };
    }
    return stats;
  }

  /**
   * Get all stages
   */
  getStages() {
    return [...this.stages].sort((a, b) => a.order - b.order);
  }

  /**
   * Update stages configuration
   */
  updateStages(stages) {
    this.stages = [...stages];
    this.dataStore.saveStages(this.stages);
    this.emit('stagesUpdated', this.stages);
    return this.stages;
  }

  /**
   * Cleanup all sessions
   * Pauses sessions instead of killing them so they can be resumed after restart
   */
  cleanup() {
    this.isShuttingDown = true;  // Prevent onExit handlers from deleting sessions
    this.planManager.stopWatching();

    for (const [id, session] of this.sessions) {
      if (session.status === 'killed') {
        continue;
      }
      this.clearRoleInjectionWorkflow(session);
      session.startupSequence = null;
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

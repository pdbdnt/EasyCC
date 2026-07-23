const EventEmitter = require('events');
const pty = require('node-pty');
const { v4: uuidv4 } = require('uuid');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');
const DataStore = require('./dataStore');
const PlanManager = require('./planManager');
const { DEFAULT_STAGES, TASK_STATUS, getNextStage, getPreviousStage, sessionStatusToStage } = require('./stagesConfig');
const { hasSubmittedInput, shouldCountOutputAsActivity } = require('./sessionInputUtils');
const { createComment, addReactionToComment } = require('./commentUtils');
const { readTranscriptWindow } = require('./terminalTranscriptUtils');
const { prepareTerminalReplayPayload } = require('./terminalReplayUtils');
const { normalizePathKey, resolvePlanRefForHost } = require('./planPathUtils');
const { CodexSessionService, pathsEqual: codexPathsEqual } = require('./codexSessionService');
const codexWindowsRuntime = require('./codexWindowsRuntime');
const { CODEX_WINDOWS, getCodexRuntime, isCodexType } = require('./codexCliTypes');
const { ByteRingBuffer } = require('./byteRingBuffer');
const MAX_PROMPT_HISTORY_CHARS = 4000;
const MAX_PROMPT_HISTORY_COUNT = 25;
const OUTPUT_BUFFER_MAX_BYTES = 512 * 1024;
const CODEX_PLAN_PATH_PATTERNS = [
  /(?:~|\/home\/[^/\s"'`<>]+)\/\.codex\/plans\/[^\s"'`<>]+\.md/gi,
  /[A-Za-z]:\\(?:[^\\\r\n"'`<>]+\\)*\.codex\\plans\\[^\\\r\n"'`<>]+?\.md/gi
];
const CODEX_STATUS_SAMPLE_INTERVAL_MS = 3000;
const CODEX_STATUS_SAMPLE_MAX_CHARS = 8 * 1024;
const CODEX_STATUS_SAMPLE_HOLD_MS = 1500;
const CODEX_STATUS_SCREEN_MAX_ROWS = 32;
const CODEX_STATUS_SCREEN_MAX_COORDINATE = 500;
const SESSION_TRANSCRIPTS_DIR = path.join(__dirname, '..', 'data', 'transcripts');
const TRANSCRIPT_FLUSH_INTERVAL_MS = 16;
const TRANSCRIPT_FLUSH_MAX_BYTES = 64 * 1024;

// Message queue constants
const MAX_MESSAGE_QUEUE_SIZE = 20;
const MESSAGE_QUEUE_EXPIRY_MS = 30 * 60 * 1000; // 30 minutes
const CODEX_WAKE_TIMEOUT_MS = 60_000;
const CODEX_WAKE_POLL_MS = 100;
const CODEX_WAKE_READY_STABLE_MS = 2_000;
const CODEX_HOOK_CORROBORATION_TIMEOUT_MS = 10_000;
const CODEX_WINDOWS_SUBMIT_DELAY_MS = 2_000;
const CODEX_WAKE_OUTPUT_MAX_CHARS = 4096;

// Debug logger that writes to file
const DEBUG_LOG_FILE = path.join(__dirname, '..', 'data', 'debug.log');
function debugLog(message) {
  const timestamp = new Date().toISOString();
  const line = `[${timestamp}] ${message}\n`;
  fs.appendFileSync(DEBUG_LOG_FILE, line);
  console.log(`[DEBUG] ${message}`);
}

const CODEX_PASSIVE_FOOTER_PATTERN = /^\s*gpt-[^·\r\n]+\s+·\s+[^·\r\n]+\s+·\s+Context\s+\d+%\s+used(?:\s+·\s+(?!Main\s+\[default\](?:\s|$))[^·\r\n]+?)?(?:\s+·\s+Main\s+\[default\])?(?:[ \t]{2,}(?:Plan(?:\s+mode)?)(?:\s*\([^\r\n)]*\))?)?\s*$/i;

/**
 * Whether a Codex output chunk is only terminal chrome that may safely
 * preserve an already detected ready prompt.
 * @param {string} data
 * @returns {boolean}
 */
function isCodexPassiveReadyRedraw(data) {
  const cleanData = String(data || '')
    .replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, '')
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/\r/g, '\n');

  const lines = cleanData
    .split('\n')
    .map(line => line.trim())
    .filter(Boolean);

  if (lines.length === 0) return true;
  if (lines.length !== 1) return false;
  return CODEX_PASSIVE_FOOTER_PATTERN.test(lines[0]);
}

function createCodexStatusScreen() {
  return {
    row: 1,
    column: 1,
    rows: new Map()
  };
}

function getCodexStatusScreenRow(screen, row) {
  const safeRow = Math.max(1, Math.min(CODEX_STATUS_SCREEN_MAX_COORDINATE, row || 1));
  let line = screen.rows.get(safeRow);
  if (!line) {
    line = [];
    screen.rows.set(safeRow, line);
    while (screen.rows.size > CODEX_STATUS_SCREEN_MAX_ROWS) {
      screen.rows.delete(screen.rows.keys().next().value);
    }
  }
  return line;
}

function applyCodexStatusScreenSample(screen, data) {
  const cursorHits = new Map();
  const raw = String(data || '');
  let index = 0;

  const clampCursor = () => {
    screen.row = Math.max(1, Math.min(CODEX_STATUS_SCREEN_MAX_COORDINATE, screen.row || 1));
    screen.column = Math.max(1, Math.min(CODEX_STATUS_SCREEN_MAX_COORDINATE, screen.column || 1));
  };

  const writeCharacter = (character) => {
    clampCursor();
    const line = getCodexStatusScreenRow(screen, screen.row);
    line[screen.column - 1] = character;
    screen.column += 1;
  };

  while (index < raw.length) {
    const character = raw[index];

    if (character === '\x1b') {
      const next = raw[index + 1];
      if (next === '[') {
        let end = index + 2;
        while (end < raw.length && !/[\x40-\x7e]/.test(raw[end])) end += 1;
        if (end >= raw.length) break;

        const final = raw[end];
        const body = raw.slice(index + 2, end).replace(/^[?!>]/, '');
        const params = body.split(';').map(value => {
          const parsed = Number.parseInt(value, 10);
          return Number.isFinite(parsed) ? parsed : 0;
        });
        const first = params[0] || 1;

        if (final === 'H' || final === 'f') {
          screen.row = first;
          screen.column = params[1] || 1;
          clampCursor();
          cursorHits.set(screen.row, (cursorHits.get(screen.row) || 0) + 1);
        } else if (final === 'A') {
          screen.row -= first;
        } else if (final === 'B') {
          screen.row += first;
        } else if (final === 'C') {
          screen.column += first;
        } else if (final === 'D') {
          screen.column -= first;
        } else if (final === 'G') {
          screen.column = first;
        } else if (final === 'K') {
          const line = getCodexStatusScreenRow(screen, screen.row);
          const mode = params[0] || 0;
          if (mode === 2) {
            line.length = 0;
          } else if (mode === 1) {
            for (let column = 0; column < screen.column; column += 1) line[column] = ' ';
          } else {
            line.length = Math.min(line.length, Math.max(0, screen.column - 1));
          }
        } else if (final === 'J' && (params[0] === 2 || params[0] === 3)) {
          screen.rows.clear();
        }
        clampCursor();
        index = end + 1;
        continue;
      }

      if (next === ']') {
        let end = index + 2;
        while (end < raw.length && raw[end] !== '\x07' && !(raw[end] === '\x1b' && raw[end + 1] === '\\')) {
          end += 1;
        }
        index = end < raw.length && raw[end] === '\x1b' ? end + 2 : end + 1;
        continue;
      }

      index += 2;
      continue;
    }

    if (character === '\r') {
      screen.column = 1;
      index += 1;
      continue;
    }
    if (character === '\n') {
      screen.row += 1;
      clampCursor();
      index += 1;
      continue;
    }
    if (character === '\b') {
      screen.column -= 1;
      clampCursor();
      index += 1;
      continue;
    }
    if (character < ' ' || character === '\x7f') {
      index += 1;
      continue;
    }

    const codePoint = raw.codePointAt(index);
    const printable = String.fromCodePoint(codePoint);
    writeCharacter(printable);
    index += printable.length;
  }

  const workingRows = [];
  for (const [row, line] of screen.rows) {
    const text = line.join('').replace(/\s+/g, ' ').trim();
    if (/\bWorking\b/i.test(text) && (cursorHits.get(row) || 0) >= 4) {
      workingRows.push({ row, text, cursorHits: cursorHits.get(row) });
    }
  }

  return { workingRows };
}

/**
 * Manages multiple Claude CLI sessions using pseudo-terminals
 */
class SessionManager extends EventEmitter {
  constructor() {
    super();
    this.sessions = new Map();
    this.platform = process.platform;
    this.dataStore = new DataStore();
    this.planManager = new PlanManager();
    this.codexSessionService = new CodexSessionService();
    this.codexWindowsHookTokens = new Map();
    this.wakeTimeoutMs = CODEX_WAKE_TIMEOUT_MS;
    this.wakePollMs = CODEX_WAKE_POLL_MS;
    this.wakeReadyStableMs = CODEX_WAKE_READY_STABLE_MS;
    this.codexHookCorroborationTimeoutMs = CODEX_HOOK_CORROBORATION_TIMEOUT_MS;
    this.wakeSleep = ms => new Promise(resolve => setTimeout(resolve, ms));
    this.recoveryInFlight = new Set();
    this.lifecycleTransitions = new Map();
    this.stages = [...DEFAULT_STAGES];
    this.isShuttingDown = false;  // Prevents onExit handlers from deleting sessions during shutdown

    // Load persisted stages
    const savedStages = this.dataStore.loadStages();
    if (savedStages && savedStages.length > 0) {
      this.stages = savedStages;
    }

    // Load persisted sessions on startup
    this.loadPersistedSessions();

    this.codexSessionService.startMonitor({
      getSessions: () => this.sessions,
      onObservation: (observation) => this.applyCodexIdentityObservation(observation)
    });
    this.codexSessionService.warmHistoryCache();

  }

  ensureTranscriptDir() {
    if (!fs.existsSync(SESSION_TRANSCRIPTS_DIR)) {
      fs.mkdirSync(SESSION_TRANSCRIPTS_DIR, { recursive: true });
    }
  }

  getTranscriptPath(sessionId) {
    this.ensureTranscriptDir();
    return path.join(SESSION_TRANSCRIPTS_DIR, `${sessionId}.log`);
  }

  resetSessionTranscript(sessionId) {
    this.discardPendingTranscript(sessionId);
    const transcriptPath = this.getTranscriptPath(sessionId);
    fs.writeFileSync(transcriptPath, '', 'utf8');
  }

  appendToTranscript(sessionId, data) {
    if (typeof data !== 'string' || data.length === 0) {
      return;
    }

    if (!this.transcriptWriteBuffers) {
      this.transcriptWriteBuffers = new Map();
    }

    let state = this.transcriptWriteBuffers.get(sessionId);
    if (!state) {
      state = { data: '', bytes: 0, timer: null };
      this.transcriptWriteBuffers.set(sessionId, state);
    }

    state.data += data;
    state.bytes += Buffer.byteLength(data, 'utf8');

    if (state.bytes >= TRANSCRIPT_FLUSH_MAX_BYTES) {
      this.flushTranscript(sessionId);
      return;
    }

    if (!state.timer) {
      state.timer = setTimeout(() => {
        state.timer = null;
        this.flushTranscript(sessionId);
      }, TRANSCRIPT_FLUSH_INTERVAL_MS);
    }
  }

  flushTranscript(sessionId) {
    const state = this.transcriptWriteBuffers?.get(sessionId);
    if (!state) return;

    if (state.timer) {
      clearTimeout(state.timer);
      state.timer = null;
    }
    this.transcriptWriteBuffers.delete(sessionId);
    if (!state.data) return;

    try {
      fs.appendFileSync(this.getTranscriptPath(sessionId), state.data, 'utf8');
    } catch (error) {
      console.error(`Error appending transcript for session ${sessionId}:`, error.message);
    }
  }

  flushTranscriptStrict(sessionId) {
    const state = this.transcriptWriteBuffers?.get(sessionId);
    if (!state) return true;
    if (state.timer) clearTimeout(state.timer);
    if (!state.data) {
      this.transcriptWriteBuffers.delete(sessionId);
      return true;
    }
    fs.appendFileSync(this.getTranscriptPath(sessionId), state.data, 'utf8');
    this.transcriptWriteBuffers.delete(sessionId);
    return true;
  }

  discardPendingTranscript(sessionId) {
    const state = this.transcriptWriteBuffers?.get(sessionId);
    if (state?.timer) {
      clearTimeout(state.timer);
    }
    this.transcriptWriteBuffers?.delete(sessionId);
  }

  deleteSessionTranscript(sessionId) {
    this.discardPendingTranscript(sessionId);
    const transcriptPath = this.getTranscriptPath(sessionId);
    if (!fs.existsSync(transcriptPath)) {
      return;
    }

    try {
      fs.unlinkSync(transcriptPath);
    } catch (error) {
      console.error(`Error deleting transcript for session ${sessionId}:`, error.message);
    }
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
        this.deleteSessionTranscript(id);
        console.log(`Cleaned up completed session: ${sessionData.name} (${id})`);
        continue;
      }

      // Restore sessions that can be resumed:
      // - Claude sessions with claudeSessionId
      // - Codex sessions (which resume only by their captured session ID)
      // - Terminal sessions (just re-launch a fresh shell)
      const cliType = sessionData.cliType || 'claude';
      const normalizedWorkingDir = this.normalizeWorkingDirForCli(sessionData.workingDir, cliType);
      const canResume = isCodexType(cliType) || cliType === 'terminal' || cliType === 'wsl' || sessionData.claudeSessionId;

      if (canResume) {
        const outputBufferSize = this.getOutputBufferSize(cliType);
        const repoContext = isCodexType(cliType)
          ? {
              repoRoot: sessionData.repoRoot
                ? this.normalizeWorkingDirForCli(sessionData.repoRoot, cliType)
                : null,
              repoName: sessionData.repoName || null,
              gitBranch: sessionData.gitBranch || null,
              groupKey: this.normalizeWorkingDirForCli(sessionData.groupKey || normalizedWorkingDir, cliType)
            }
          : this.deriveRepoContext(normalizedWorkingDir, sessionData);
        const restoredName = isCodexType(cliType)
          ? this.stripCodexResumeHint(sessionData.name) || sessionData.name
          : sessionData.name;
        const session = {
          id: sessionData.id,
          name: restoredName,
          // Mark previously active sessions as paused (since they have no PTY now)
          status: 'paused',
          currentTask: sessionData.currentTask || '',
          createdAt: new Date(sessionData.createdAt),
          lastActivity: new Date(sessionData.lastActivity),
          outputBuffer: new ByteRingBuffer(outputBufferSize),
          pty: null,
          workingDir: normalizedWorkingDir,
          repoRoot: repoContext.repoRoot,
          repoName: repoContext.repoName,
          gitBranch: repoContext.gitBranch,
          groupKey: repoContext.groupKey,
          cliType: cliType,
          claudeSessionId: sessionData.claudeSessionId,
          previousClaudeSessionIds: sessionData.previousClaudeSessionIds || [],
          claudeSessionName: sessionData.claudeSessionName || null,
          codexSessionId: sessionData.codexSessionId || null,
          codexThreadName: sessionData.codexThreadName || null,
          codexLaunchStartedAt: sessionData.codexLaunchStartedAt || null,
          codexIdentityState: isCodexType(cliType)
            ? (sessionData.codexIdentityState || 'unverified')
            : null,
          codexIdentityVerifiedAt: sessionData.codexIdentityVerifiedAt || null,
          codexIdentityError: sessionData.codexIdentityError || null,
          codexTranscriptPath: sessionData.codexTranscriptPath || null,
          recoveryError: sessionData.recoveryError || null,
          notes: sessionData.notes || '',
          role: this.sanitizeRole(sessionData.role || ''),
          agentId: sessionData.agentId || null,
          taskId: sessionData.taskId || null,
          tags: sessionData.tags || [],
          plans: sessionData.plans || [],
          promptBuffer: '',
          statusDetectionContext: '',
          promptHistory: sessionData.promptHistory || [],
          promptFlushTimer: null,
          inEscapeSeq: false,
          // Kanban stage fields
          stage: sessionData.stage || 'todo',
          stageEnteredAt: sessionData.stageEnteredAt || sessionData.createdAt || null,
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
          comments: sessionData.comments || [],
          // Message queue
          messageQueue: sessionData.messageQueue || [],
          // Orchestrator fields
          isOrchestrator: sessionData.isOrchestrator || false,
          parentSessionId: sessionData.parentSessionId || null,
          teamInstanceId: sessionData.teamInstanceId || null,
          codexCaptureTimer: null,
          codexCaptureAttempts: 0
        };

        // Sweep expired queue messages on restart
        this._sweepExpiredQueueMessages(session);
        this.ensureParkingFields(session, sessionData);

        this.sessions.set(id, session);
        // Update persisted status to paused
        this.dataStore.saveSession(session);
        debugLog(`Session ${id} (${session.name}) marked PAUSED during server startup (loadSessions)`);
        const resumeInfo = isCodexType(cliType)
          ? `Codex (${this.selectCodexResumeTarget(session) || 'exact target required'})`
          : `Claude session ${session.claudeSessionId}`;
        console.log(`Restored session: ${session.name} (${id}) - can be resumed with ${resumeInfo}`);
      } else {
        // No claudeSessionId for Claude session = can't resume, clean up
        this.dataStore.deleteSession(id);
        this.deleteSessionTranscript(id);
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
    return OUTPUT_BUFFER_MAX_BYTES;
  }

  getLifecycleTransitions() {
    if (!this.lifecycleTransitions) this.lifecycleTransitions = new Map();
    return this.lifecycleTransitions;
  }

  ensureParkingFields(session, persisted = null) {
    if (!session) return session;
    const pauseReason = session.pauseReason || persisted?.pauseReason ||
      (session.status === 'paused' ? 'startup_restore' : null);
    session.pauseReason = pauseReason;
    session.parkedAt = session.parkedAt || persisted?.parkedAt || null;
    session.keepAwake = session.keepAwake ?? !!persisted?.keepAwake;
    session.lastUserOrOrchestratorActivityAt =
      session.lastUserOrOrchestratorActivityAt ||
      persisted?.lastUserOrOrchestratorActivityAt ||
      (session.lastActivity instanceof Date ? session.lastActivity.toISOString() : session.lastActivity) ||
      new Date().toISOString();
    if (!session.runtimeState) {
      session.runtimeState = pauseReason === 'auto_park'
        ? 'auto_parked'
        : session.status === 'paused' || !session.pty
          ? 'paused'
          : 'live';
    }
    session.interactionPending = !!session.interactionPending;
    session.interactionPendingSource = session.interactionPendingSource || null;
    session.idleEvidence = session.idleEvidence || null;
    session.readySince = session.readySince || null;
    session.parkingProposalState = session.parkingProposalState || 'none';
    session.parkingProposalReason = session.parkingProposalReason || null;
    session.parkingDetectedAt = session.parkingDetectedAt || null;
    session.parkingSnoozedUntil = session.parkingSnoozedUntil || null;
    session.wakeError = session.wakeError || persisted?.wakeError || null;
    session.wakeWarning = session.wakeWarning || null;
    session.ptyGeneration = Number(session.ptyGeneration) || (session.pty ? 1 : 0);
    return session;
  }

  isParkingEligible(session) {
    this.ensureParkingFields(session);
    if (!session.pty || session.runtimeState !== 'live') return false;
    if (!['claude', 'codex', CODEX_WINDOWS].includes(session.cliType || 'claude')) return false;
    if (session.status !== 'idle' || !session.idleEvidence || !session.readySince) return false;
    if (session.keepAwake || session.interactionPending || this.isShuttingDown) return false;
    if (session.pendingStatus || session.statusDebounceTimer || session.startupSequence?.active ||
        session.roleInjection?.active || session._writeDraining || session._queueDraining ||
        (session.messageQueue || []).some(message => message.status === 'queued')) return false;
    if (session.cliType === 'claude') return !!session.claudeSessionId;
    return !!session.codexSessionId &&
      ['verified', 'resume_verified'].includes(session.codexIdentityState) &&
      !session.codexIdentityError;
  }

  setKeepAwake(id, keepAwake) {
    const session = this.sessions.get(id);
    if (!session) return null;
    this.ensureParkingFields(session);
    session.keepAwake = !!keepAwake;
    if (session.keepAwake) {
      session.parkingProposalState = 'none';
      session.parkingProposalReason = null;
      session.parkingDetectedAt = null;
      session.parkingSnoozedUntil = null;
    }
    this.dataStore.saveSession(session);
    const snapshot = this.getSessionSnapshot(session);
    this.emit('sessionUpdated', snapshot);
    return snapshot;
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

    const normalizedPlanPath = resolvePlanRefForHost(planPath);
    const existingKeys = new Set(session.plans.map((existingPlanPath) => normalizePathKey(resolvePlanRefForHost(existingPlanPath))));
    const isNew = !existingKeys.has(normalizePathKey(normalizedPlanPath));

    if (isNew) {
      session.plans.push(normalizedPlanPath);
      this.dataStore.addPlanToSession(sessionId, normalizedPlanPath);
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

    if (isCodexType(session.cliType)) {
      const planPaths = this.backfillCodexPlansForSession(session);
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

    const normalizedPlanPath = resolvePlanRefForHost(planPath);
    const existingKeys = new Set(session.plans.map((existingPlanPath) => normalizePathKey(resolvePlanRefForHost(existingPlanPath))));

    if (!existingKeys.has(normalizePathKey(normalizedPlanPath))) {
      session.plans.push(normalizedPlanPath);
      this.dataStore.addPlanToSession(sessionId, normalizedPlanPath);

      this.emit('sessionUpdated', {
        id: sessionId,
        plans: session.plans
      });
    }
  }

  planMatchesSessionWorkingDir(session, planRef, plan = null) {
    if (!session?.workingDir || !planRef) {
      return true;
    }

    if (!plan && !this.planManager?.getPlanContent) {
      return true;
    }

    const planContent = plan || this.planManager.getPlanContent(planRef);
    if (!planContent) {
      return false;
    }

    if (!this.planHasExplicitWorkingDir(planContent)) {
      return true;
    }

    if (!planContent.workingDir) {
      return true;
    }

    return this.normalizeGroupPath(planContent.workingDir).toLowerCase() ===
      this.normalizeGroupPath(session.workingDir).toLowerCase();
  }

  planHasExplicitWorkingDir(plan) {
    if (!plan || typeof plan.content !== 'string') {
      return false;
    }

    return /(?:^|\n)\s*(?:Working Directory|Project|Path)[:\s]+[^\n]+/i.test(plan.content);
  }

  /**
   * Convert Windows or WSL UNC path to WSL path.
   * @param {string} windowsPath - Windows path (e.g., C:\Users\foo) or WSL UNC path
   * @returns {string} WSL path (e.g., /mnt/c/Users/foo or /home/foo)
   */
  convertToWslPath(windowsPath) {
    if (!windowsPath || typeof windowsPath !== 'string') return windowsPath;
    const normalized = windowsPath.trim().replace(/\\/g, '/');
    const uncMatch = normalized.match(/^\/\/wsl(?:\$|\.localhost)?\/[^/]+(\/.*)?$/i);
    if (uncMatch) {
      return uncMatch[1] || '/';
    }
    const driveMatch = normalized.match(/^([A-Za-z]):(.*)/);
    if (driveMatch) {
      return `/mnt/${driveMatch[1].toLowerCase()}${driveMatch[2]}`;
    }
    return windowsPath;
  }

  normalizeWorkingDirForCli(workingDir, cliType = 'claude') {
    if (!workingDir || typeof workingDir !== 'string') return workingDir;
    const trimmed = workingDir.trim();
    if ((cliType === 'wsl' || cliType === 'codex') && process.platform === 'win32') {
      return this.convertToWslPath(trimmed);
    }
    return trimmed;
  }

  normalizeGroupPath(value) {
    if (!value || typeof value !== 'string') return '';
    return value.trim().replace(/\\/g, '/').replace(/\/$/, '');
  }

  getCodexHomeDir() {
    return path.join(os.homedir(), '.codex');
  }

  getCodexSessionIndexPath() {
    return path.join(this.getCodexHomeDir(), 'session_index.jsonl');
  }

  getCodexSessionsDir() {
    return path.join(this.getCodexHomeDir(), 'sessions');
  }

  runWslCodexCommand(command) {
    if (process.platform !== 'win32') {
      return '';
    }

    try {
      return execFileSync('wsl.exe', ['bash', '--noprofile', '--norc', '-lc', command], {
        encoding: 'utf8',
        timeout: 15000,
        stdio: ['ignore', 'pipe', 'ignore']
      });
    } catch (error) {
      console.error('Error running WSL Codex command:', error.message);
      return '';
    }
  }

  loadCodexSessionIndex() {
    let contents = '';

    if (process.platform === 'win32') {
      contents = this.runWslCodexCommand('cat "$HOME/.codex/session_index.jsonl" 2>/dev/null || true');
    } else {
      const indexPath = this.getCodexSessionIndexPath();
      if (!fs.existsSync(indexPath)) {
        return [];
      }

      try {
        contents = fs.readFileSync(indexPath, 'utf8');
      } catch (error) {
        console.error('Error loading Codex session index:', error.message);
        return [];
      }
    }

    const entries = [];
    for (const line of contents.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const entry = JSON.parse(trimmed);
        if (!entry?.id) continue;
        entries.push({
          id: entry.id,
          threadName: entry.thread_name || null,
          updatedAt: entry.updated_at || null,
          updatedAtMs: entry.updated_at ? Date.parse(entry.updated_at) : 0
        });
      } catch {
        // Ignore malformed index rows.
      }
    }

    return entries;
  }

  findCodexSessionFileById(sessionId) {
    if (!sessionId) {
      return null;
    }

    if (process.platform === 'win32') {
      const pattern = this.quoteForPosixShell(`*${sessionId}.jsonl`);
      const output = this.runWslCodexCommand(
        `find "$HOME/.codex/sessions" -type f -name ${pattern} -print -quit 2>/dev/null || true`
      ).trim();
      return output || null;
    }

    const rootDir = this.getCodexSessionsDir();
    if (!fs.existsSync(rootDir)) {
      return null;
    }

    const stack = [rootDir];
    while (stack.length > 0) {
      const dirPath = stack.pop();
      let entries = [];
      try {
        entries = fs.readdirSync(dirPath, { withFileTypes: true });
      } catch {
        continue;
      }

      for (const entry of entries) {
        const fullPath = path.join(dirPath, entry.name);
        if (entry.isDirectory()) {
          stack.push(fullPath);
          continue;
        }
        if (entry.isFile() && entry.name.endsWith(`${sessionId}.jsonl`)) {
          return fullPath;
        }
      }
    }

    return null;
  }

  findCodexWindowsSessionFileById(sessionId) {
    if (!sessionId) return null;
    const rootDir = path.join(codexWindowsRuntime.getCodexHome(), 'sessions');
    if (!fs.existsSync(rootDir)) return null;
    const stack = [rootDir];
    while (stack.length) {
      const current = stack.pop();
      let entries = [];
      try { entries = fs.readdirSync(current, { withFileTypes: true }); } catch { continue; }
      for (const entry of entries) {
        const fullPath = path.join(current, entry.name);
        if (entry.isDirectory()) stack.push(fullPath);
        else if (entry.isFile() && entry.name.endsWith(`${sessionId}.jsonl`)) return fullPath;
      }
    }
    return null;
  }

  readCodexSessionMetaById(sessionId) {
    const filePath = this.findCodexSessionFileById(sessionId);
    if (!filePath) {
      return null;
    }

    let firstLine = '';
    if (process.platform === 'win32') {
      firstLine = this.runWslCodexCommand(`head -n 1 ${this.quoteForPosixShell(filePath)} 2>/dev/null || true`).trim();
    } else {
      try {
        const contents = fs.readFileSync(filePath, 'utf8');
        firstLine = (contents.split('\n')[0] || '').trim();
      } catch {
        return null;
      }
    }

    if (!firstLine) {
      return null;
    }

    try {
      const record = JSON.parse(firstLine);
      if (record?.type !== 'session_meta' || !record?.payload?.id || !record?.payload?.cwd) {
        return null;
      }

      return {
        sessionId: record.payload.id,
        cwd: this.normalizeGroupPath(record.payload.cwd),
        createdAt: record.payload.timestamp || record.timestamp || null,
        filePath
      };
    } catch {
      return null;
    }
  }

  normalizePlanPath(planPath) {
    if (typeof planPath !== 'string') {
      return '';
    }

    const trimmed = planPath.trim().replace(/[),.;:]+$/g, '');
    if (!trimmed) {
      return '';
    }

    const hostPath = resolvePlanRefForHost(trimmed);
    if (hostPath.startsWith('~/')) {
      return path.join(os.homedir(), hostPath.slice(2));
    }

    return path.resolve(hostPath);
  }

  isAllowedSessionPlanPath(planPath) {
    if (!planPath || typeof planPath !== 'string') {
      return false;
    }

    const resolved = path.resolve(planPath);
    if (!resolved.toLowerCase().endsWith('.md')) {
      return false;
    }
    if (!fs.existsSync(resolved)) {
      return false;
    }

    const parentName = path.basename(path.dirname(resolved)).toLowerCase();
    if (parentName !== 'plans') {
      return false;
    }

    const normalized = resolved.replace(/\\/g, '/').toLowerCase();
    const codexPlansDir = path.join(os.homedir(), '.codex', 'plans').replace(/\\/g, '/').toLowerCase();
    const claudePlansDir = path.join(os.homedir(), '.claude', 'plans').replace(/\\/g, '/').toLowerCase();

    return normalized.startsWith(`${codexPlansDir}/`) ||
      normalized.startsWith(`${claudePlansDir}/`) ||
      normalized.includes('/plans/');
  }

  extractCodexPlanPathsFromText(text) {
    if (typeof text !== 'string' || !text || !text.includes('.codex')) {
      return [];
    }

    const cleanText = this.cleanTerminalText(text);
    const paths = new Set();
    for (const pattern of CODEX_PLAN_PATH_PATTERNS) {
      const searchableText = pattern === CODEX_PLAN_PATH_PATTERNS[1]
        ? cleanText.replace(/\\\\/g, '\\')
        : cleanText;
      for (const match of searchableText.matchAll(pattern)) {
        const normalized = this.normalizePlanPath(match[0]);
        if (normalized && this.isAllowedSessionPlanPath(normalized)) {
          paths.add(normalized);
        }
      }
    }

    return [...paths];
  }

  readCodexSessionTranscriptText(sessionId) {
    const filePath = this.findCodexSessionFileById(sessionId);
    if (!filePath) {
      return '';
    }

    if (process.platform === 'win32') {
      return this.runWslCodexCommand(`cat ${this.quoteForPosixShell(filePath)} 2>/dev/null || true`);
    }

    try {
      return fs.readFileSync(filePath, 'utf8');
    } catch (error) {
      console.error('Error reading Codex session transcript:', error.message);
      return '';
    }
  }

  getPlansForCodexSession(codexSessionId, cliType = 'codex') {
    if (!codexSessionId) {
      return [];
    }

    let transcript = '';
    if (cliType === CODEX_WINDOWS) {
      const filePath = this.findCodexWindowsSessionFileById(codexSessionId);
      try { transcript = filePath ? fs.readFileSync(filePath, 'utf8') : ''; } catch { transcript = ''; }
    } else {
      transcript = this.readCodexSessionTranscriptText(codexSessionId);
    }
    return this.extractCodexPlanPathsFromText(transcript);
  }

  extractCodexSessionIdsFromText(text) {
    if (typeof text !== 'string' || !text) {
      return [];
    }

    const ids = new Set();
    const matches = text.matchAll(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi);
    for (const match of matches) {
      ids.add(match[0].toLowerCase());
    }
    return [...ids];
  }

  getOwnedCodexSessionIds(currentSessionId = null) {
    const ownedIds = new Set();
    for (const [id, candidate] of this.sessions) {
      if (id !== currentSessionId && candidate.codexSessionId) {
        ownedIds.add(candidate.codexSessionId);
      }
    }
    return ownedIds;
  }

  linkCodexSessionById(session, codexSessionId) {
    if (!session || !isCodexType(session.cliType) || !codexSessionId) {
      return false;
    }

    const ownedIds = this.getOwnedCodexSessionIds(session.id);
    if (ownedIds.has(codexSessionId)) {
      return false;
    }

    const meta = this.readCodexSessionMetaById(codexSessionId);
    if (!meta || meta.cwd !== this.normalizeGroupPath(session.workingDir)) {
      return false;
    }

    const indexEntry = this.loadCodexSessionIndex()
      .filter((entry) => entry.id === codexSessionId)
      .sort((a, b) => (b.updatedAtMs || 0) - (a.updatedAtMs || 0))[0] || null;

    let changed = false;
    if (session.codexSessionId !== codexSessionId) {
      session.codexSessionId = codexSessionId;
      changed = true;
    }
    if (indexEntry?.threadName && session.codexThreadName !== indexEntry.threadName) {
      session.codexThreadName = indexEntry.threadName;
      changed = true;
    }

    if (changed) {
      this.dataStore.saveSession(session);
      this.emit('sessionUpdated', this.getSessionSnapshot(session));
    }

    return true;
  }

  readSessionTerminalTranscriptText(sessionId) {
    if (!sessionId) {
      return '';
    }

    const transcriptPath = this.getTranscriptPath(sessionId);
    if (!fs.existsSync(transcriptPath)) {
      return '';
    }

    try {
      return fs.readFileSync(transcriptPath, 'utf8');
    } catch (error) {
      console.error('Error reading session terminal transcript:', error.message);
      return '';
    }
  }

  ensureCodexSessionLinked(session) {
    if (!session || !isCodexType(session.cliType)) {
      return false;
    }
    // Never infer a conversation identity from folder, title, transcript text,
    // or recency. Missing IDs are established only by the process monitor's
    // EASYCC_SESSION_ID observation or by an explicit picker selection.
    return !!session.codexSessionId;
  }

  backfillCodexPlansForSession(session) {
    if (!session || (!isCodexType(session.cliType) && session.cliType !== 'wsl')) {
      return [];
    }

    if (isCodexType(session.cliType)) {
      this.ensureCodexSessionLinked(session);
    }

    const planPaths = new Set();
    const terminalText = [
      ...(session.outputBuffer?.getAll?.() || []),
      this.readSessionTerminalTranscriptText(session.id)
    ].join('\n');

    for (const planPath of this.extractCodexPlanPathsFromText(terminalText)) {
      planPaths.add(planPath);
    }

    const codexSessionIds = new Set();
    if (isCodexType(session.cliType) && session.codexSessionId) {
      codexSessionIds.add(session.codexSessionId);
    }
    for (const codexSessionId of codexSessionIds) {
      for (const planPath of this.getPlansForCodexSession(codexSessionId, session.cliType)) {
        planPaths.add(planPath);
      }
    }

    const attachedPlanPaths = [];
    for (const planPath of planPaths) {
      if (this.planMatchesSessionWorkingDir(session, planPath)) {
        this.addPlanToSession(session.id, planPath);
        attachedPlanPaths.push(planPath);
      }
    }

    return attachedPlanPaths;
  }

  attachCodexPlansFromOutput(session, data) {
    if (!session || (!isCodexType(session.cliType) && session.cliType !== 'wsl')) {
      return [];
    }

    const planPaths = this.extractCodexPlanPathsFromText(data);
    const attachedPlanPaths = [];
    for (const planPath of planPaths) {
      if (this.planMatchesSessionWorkingDir(session, planPath)) {
        this.addOrUpdatePlanInSession(session.id, planPath);
        attachedPlanPaths.push(planPath);
      }
    }
    return attachedPlanPaths;
  }

  selectCodexResumeTarget(session) {
    if (!session) return null;
    return session.codexSessionId || null;
  }

  syncWithCodexSession(session) {
    // Identity synchronization is asynchronous and process-owned. Do not use
    // launch time, folder, or title heuristics to mutate codexSessionId.
    if (isCodexType(session?.cliType) && !session.codexSessionId) {
      this.codexSessionService?.kickMonitor?.();
    }
    return false;
  }

  clearCodexSessionCapture(session) {
    if (!session) return;
    if (session.codexCaptureTimer) {
      clearTimeout(session.codexCaptureTimer);
      session.codexCaptureTimer = null;
    }
    session.codexCaptureAttempts = 0;
  }

  scheduleCodexSessionCapture(session) {
    if (!session || !isCodexType(session.cliType)) {
      return;
    }
    this.clearCodexSessionCapture(session);
    this.codexSessionService?.kickMonitor?.();
  }

  applyCodexIdentityObservation(observation) {
    const session = this.sessions.get(observation?.sessionId);
    if (!session || !isCodexType(session.cliType)) return false;

    if (observation.state === 'conflict') {
      if (session.pty) {
        try {
          session.pty.kill();
        } catch {
          // The process may have already exited during collision handling.
        }
      }
      session.pty = null;
      this.clearCodexStatusSampler(session);
      session.status = 'paused';
      session.codexIdentityState = 'conflict';
      session.codexIdentityError = observation.error || 'Codex conversation is already open';
      this.dataStore.saveSession(session);
      this.emit('sessionUpdated', this.getSessionSnapshot(session));
      this.emit('statusChange', {
        sessionId: session.id,
        status: 'paused',
        currentTask: session.currentTask,
        error: session.codexIdentityError
      });
      return true;
    }

    if (observation.state !== 'verified' || !observation.candidateId) {
      const error = observation.error || 'Codex identity could not be verified';
      if (session.codexIdentityState === 'unresolved' && session.codexIdentityError === error) return false;
      session.codexIdentityState = 'unresolved';
      session.codexIdentityError = error;
      this.dataStore.saveSession(session);
      this.emit('sessionUpdated', this.getSessionSnapshot(session));
      return true;
    }

    if (observation.workingDir && !codexPathsEqual(observation.workingDir, session.workingDir)) {
      session.codexIdentityState = 'unresolved';
      session.codexIdentityError = 'Codex conversation belongs to a different folder';
      this.dataStore.saveSession(session);
      this.emit('sessionUpdated', this.getSessionSnapshot(session));
      return false;
    }

    const candidateId = String(observation.candidateId).toLowerCase();
    const previousCodexSessionId = String(session.codexSessionId || '').toLowerCase();
    const expectedWakeId = String(
      session.codexWakeAttempt?.expectedId || session.expectedCodexWakeId || ''
    ).toLowerCase();
    if (expectedWakeId && candidateId !== expectedWakeId) {
      session.codexIdentityState = 'unresolved';
      session.codexIdentityError = `Exact Codex wake expected ${expectedWakeId}, but resumed ${candidateId}`;
      this.emit('sessionUpdated', this.getSessionSnapshot(session));
      return true;
    }
    const owner = [...this.sessions.values()].find((candidate) =>
      candidate.id !== session.id && candidate.cliType === session.cliType &&
      String(candidate.codexSessionId || '').toLowerCase() === candidateId
    );
    if (owner) {
      if (!this.transferCodexOwnership(session, owner, candidateId)) {
        return this.applyCodexIdentityObservation({
          sessionId: session.id,
          state: 'conflict',
          error: `Codex conversation is already linked to ${owner.name}`
        });
      }
    }

    const switched = previousCodexSessionId !== candidateId;
    const verifiedRecently = !switched &&
      session.codexIdentityState === 'verified' &&
      !session.codexIdentityError &&
      Date.now() - Date.parse(session.codexIdentityVerifiedAt || 0) < 30_000;
    if (verifiedRecently || (!switched && session.codexIdentityState === 'verified' && session.codexThreadName)) {
      return false;
    }
    if (switched) {
      session.codexSessionId = candidateId;
      session.codexThreadName = null;
      session.currentTask = '';
    }
    session.codexIdentityState = 'verified';
    session.codexIdentityVerifiedAt = new Date().toISOString();
    session.codexIdentityError = null;

    if (observation.threadName) {
      session.codexThreadName = observation.threadName;
      session.name = observation.threadName;
    } else if (switched) {
      session.name = `Codex ${candidateId.slice(0, 8)}`;
    }
    if (observation.repoContext) {
      session.repoRoot = observation.repoContext.repoRoot || null;
      session.repoName = observation.repoContext.repoName || null;
      session.gitBranch = observation.repoContext.gitBranch || null;
      session.groupKey = observation.repoContext.groupKey || session.workingDir;
    }

    this.dataStore.saveSession(session);
    this.emit('sessionUpdated', this.getSessionSnapshot(session));
    return true;
  }

  async getCodexResumeCatalog(query = {}) {
    if (query.easyccSessionId) {
      const target = this.sessions.get(query.easyccSessionId);
      if (!target || !isCodexType(target.cliType) || target.status !== 'paused') {
        throw new Error('The paused Codex card is no longer available');
      }
    }
    return this.codexSessionService.getResumeCatalog({
      sessions: this.sessions,
      groupKey: query.groupKey || '',
      easyccSessionId: query.easyccSessionId || '',
      historyRuntime: query.historyRuntime || '',
      cursor: query.cursor || '',
      timeZone: query.timeZone || 'UTC',
      query: query.query || '',
      refresh: query.refresh === '1' || query.refresh === true,
      groupBy: query.groupBy || '',
      groupSort: query.groupSort || '',
      threadSort: query.threadSort || ''
    });
  }

  async validateRecoveryWorkingDir(session) {
    const workingDir = this.normalizeWorkingDirForCli(session?.workingDir, session?.cliType || 'claude');
    if (!workingDir) {
      return { ok: false, code: 'missing_working_dir', message: 'Working directory is missing' };
    }

    if (this.platform === 'win32' && ['codex', 'wsl'].includes(session.cliType)) {
      try {
        const output = await this.codexSessionService.runShell(
          `if test -d ${this.quoteForPosixShell(workingDir)}; then printf ok; else printf missing; fi`
        );
        return String(output).trim() === 'ok'
          ? { ok: true }
          : { ok: false, code: 'missing_working_dir', message: 'Working directory is not available in WSL' };
      } catch (error) {
        const sourceError = error.cause || error;
        const message = [error.message, sourceError.message, sourceError.stderr].filter(Boolean).join(' ');
        const unavailable = sourceError.code === 'ENOENT' ||
          /wsl(?:\.exe)?.*(?:not found|cannot find|not recognized)/i.test(message) ||
          /WSL_E_DEFAULT_DISTRO_NOT_FOUND|no installed distributions|no distribution.*installed|specified distribution.*does not exist/i.test(message);
        return {
          ok: false,
          code: unavailable ? 'wsl_unavailable' : 'directory_check_failed',
          message: unavailable ? 'WSL is not available' : 'Could not verify the WSL working directory'
        };
      }
    }

    try {
      return fs.statSync(workingDir).isDirectory()
        ? { ok: true }
        : { ok: false, code: 'missing_working_dir', message: 'Working directory is not a directory' };
    } catch {
      return { ok: false, code: 'missing_working_dir', message: 'Working directory does not exist' };
    }
  }

  async prepareRecoverySummary() {
    const paused = [...this.sessions.values()].filter((session) =>
      session?.status === 'paused' && session.pauseReason !== 'auto_park'
    );
    const codexIds = paused
      .filter((session) => session.cliType === 'codex' && session.codexSessionId)
      .map((session) => session.codexSessionId);
    const [threadsById, processState] = await Promise.all([
      this.codexSessionService.getThreadsByIds(codexIds),
      this.codexSessionService.scanProcesses()
    ]);
    const rows = [];
    const exactCodex = [];

    for (const session of paused) {
      const cliType = session.cliType || 'claude';
      const row = {
        id: session.id,
        name: session.name,
        cliType,
        workingDir: session.workingDir,
        groupKey: session.groupKey || session.workingDir,
        projectName: session.repoName || path.basename(String(session.groupKey || session.workingDir || 'Project')),
        category: 'launchable',
        code: cliType === 'terminal' || cliType === 'wsl' ? 'fresh_shell' : 'exact',
        message: cliType === 'terminal' || cliType === 'wsl' ? 'Starts a fresh shell' : null
      };

      const directory = await this.validateRecoveryWorkingDir(session);
      if (!directory.ok) {
        Object.assign(row, { category: 'disabled', code: directory.code, message: directory.message });
        rows.push(row);
        continue;
      }

      if (cliType === 'claude' && !session.claudeSessionId) {
        Object.assign(row, { category: 'disabled', code: 'missing_identity', message: 'Claude conversation ID is missing' });
      } else if (cliType === 'codex') {
        const codexId = String(session.codexSessionId || '').toLowerCase();
        const thread = codexId ? threadsById.get(codexId) : null;
        if (!thread) {
          Object.assign(row, { category: 'requiresSelection', code: 'requires_selection', message: 'Choose an exact Codex conversation' });
        } else if (!codexPathsEqual(thread.workingDir, session.workingDir)) {
          Object.assign(row, { category: 'disabled', code: 'cwd_mismatch', message: 'Codex conversation belongs to a different folder' });
        } else {
          if (thread.threadName && thread.threadName !== session.name) {
            session.name = thread.threadName;
            session.codexThreadName = thread.threadName;
            this.dataStore.saveSession(session);
            this.emit('sessionUpdated', this.getSessionSnapshot(session));
          }
          row.name = thread.threadName || session.name;
          row.codexSessionId = codexId;
          const activeOwner = [...this.sessions.values()].find((candidate) =>
            candidate.id !== session.id &&
            !['paused', 'completed', 'killed'].includes(candidate.status) &&
            String(candidate.codexSessionId || '').toLowerCase() === codexId
          );
          if (activeOwner) {
            Object.assign(row, { category: 'disabled', code: 'already_active', message: `Conversation is active in ${activeOwner.name}` });
          } else if (processState.liveRootIds.has(codexId)) {
            Object.assign(row, { category: 'disabled', code: 'already_live', message: 'Codex conversation is already running' });
          } else {
            exactCodex.push({ session, row, codexId });
          }
        }
      }
      rows.push(row);
    }

    const owners = new Map();
    exactCodex
      .sort((a, b) => Date.parse(a.session.createdAt || 0) - Date.parse(b.session.createdAt || 0) || a.session.id.localeCompare(b.session.id))
      .forEach(({ row, codexId }) => {
        if (!owners.has(codexId)) {
          owners.set(codexId, row.id);
          return;
        }
        Object.assign(row, {
          category: 'disabled',
          code: 'duplicate_owner',
          message: `Conversation is already assigned to ${owners.get(codexId)}`
        });
      });

    const totals = {
      candidateTotal: rows.length,
      launchableTotal: rows.filter((row) => row.category === 'launchable').length,
      requiresSelectionTotal: rows.filter((row) => row.category === 'requiresSelection').length,
      disabledTotal: rows.filter((row) => row.category === 'disabled').length,
      projectTotal: new Set(rows.map((row) => row.groupKey).filter(Boolean)).size
    };
    return { sessions: rows, totals };
  }

  async recoverSessions(sessionIds = []) {
    const requestedIds = [...new Set((sessionIds || []).filter((id) => typeof id === 'string'))];
    const summary = await this.prepareRecoverySummary();
    const byId = new Map(summary.sessions.map((row) => [row.id, row]));
    const launchStarted = [];
    const skipped = [];
    const requiresSelection = [];

    for (const id of requestedIds) {
      const row = byId.get(id);
      if (!row) {
        skipped.push({ id, code: 'not_found', message: 'Paused recovery candidate was not found' });
        continue;
      }
      if (row.category === 'requiresSelection') {
        requiresSelection.push(row);
        continue;
      }
      if (row.category !== 'launchable') {
        skipped.push(row);
        continue;
      }
      const current = this.sessions.get(id);
      if (!current) {
        skipped.push({ ...row, code: 'not_found', message: 'Session no longer exists' });
        continue;
      }
      if (current.status !== 'paused') {
        skipped.push({
          ...row,
          code: current.status === 'active' ? 'already_active' : 'not_paused',
          message: current.status === 'active' ? 'Session is already active' : 'Session is no longer paused'
        });
        continue;
      }
      if (current.cliType === 'codex' && current.codexSessionId) {
        const activeOwner = [...this.sessions.values()].find((candidate) =>
          candidate.id !== current.id &&
          !['paused', 'completed', 'killed'].includes(candidate.status) &&
          String(candidate.codexSessionId || '').toLowerCase() === String(current.codexSessionId).toLowerCase()
        );
        if (activeOwner) {
          skipped.push({ ...row, code: 'already_active', message: `Conversation is active in ${activeOwner.name}` });
          continue;
        }
      }
      if (this.recoveryInFlight.has(id)) {
        skipped.push({ ...row, code: 'already_starting', message: 'Session recovery is already starting' });
        continue;
      }

      this.recoveryInFlight.add(id);
      try {
        const started = this.resumeSession(id, { recovery: true });
        if (!started) {
          skipped.push({ ...row, code: 'spawn_failed', message: 'Could not start session recovery' });
          continue;
        }
        launchStarted.push(this.getSessionSnapshot(this.sessions.get(id)));
      } finally {
        this.recoveryInFlight.delete(id);
      }
    }

    return { launchStarted, skipped, requiresSelection };
  }

  createBoundCodexSession(thread) {
    const now = new Date();
    const id = uuidv4();
    const repoContext = thread.repoContext || {
      repoRoot: null,
      repoName: null,
      gitBranch: null,
      groupKey: thread.workingDir
    };
    const session = {
      id,
      name: thread.threadName || `Codex ${thread.codexSessionId.slice(0, 8)}`,
      status: 'paused',
      currentTask: '',
      createdAt: now,
      lastActivity: new Date(thread.lastActivity || now),
      outputBuffer: new ByteRingBuffer(this.getOutputBufferSize('codex')),
      pty: null,
      workingDir: thread.workingDir,
      repoRoot: repoContext.repoRoot,
      repoName: repoContext.repoName,
      gitBranch: repoContext.gitBranch,
      groupKey: repoContext.groupKey || thread.workingDir,
      cliType: thread.historyRuntime === 'windows' ? CODEX_WINDOWS : 'codex',
      claudeSessionId: null,
      previousClaudeSessionIds: [],
      claudeSessionName: null,
      codexSessionId: thread.codexSessionId,
      codexThreadName: thread.threadName || null,
      codexLaunchStartedAt: null,
      codexIdentityState: 'unverified',
      codexIdentityVerifiedAt: null,
      codexIdentityError: null,
      recoveryError: null,
      notes: '',
      role: '',
      agentId: null,
      taskId: null,
      tags: [],
      plans: [],
      promptBuffer: '',
      statusDetectionContext: '',
      promptHistory: [],
      promptFlushTimer: null,
      inEscapeSeq: false,
      isComposingPrompt: false,
      lastSubmittedInputAtMs: 0,
      statusDebounceTimer: null,
      pendingStatus: null,
      roleInjection: null,
      startupSequence: null,
      stage: 'todo',
      stageEnteredAt: now.toISOString(),
      priority: 0,
      description: '',
      blockedBy: [],
      blocks: [],
      manuallyPlaced: false,
      manualPlacedAt: null,
      placementLocked: false,
      rejectionHistory: [],
      completedAt: null,
      updatedAt: now.toISOString(),
      comments: [],
      messageQueue: [],
      isOrchestrator: false,
      parentSessionId: null,
      teamInstanceId: null,
      codexCaptureTimer: null,
      codexCaptureAttempts: 0
    };
    this.ensureParkingFields(session);
    this.sessions.set(id, session);
    this.dataStore.saveSession(session);
    this.emit('sessionCreated', { id, session: this.getSessionSnapshot(session) });
    return session;
  }

  async resumeCodexSelections(selections = [], { targetEasyccSessionId = '', historyRuntime = '' } = {}) {
    const accepted = [];
    const skipped = [];
    const seen = new Set();
    const requestedIds = selections.map((selection) => selection?.codexSessionId);
    const targetSession = targetEasyccSessionId ? this.sessions.get(targetEasyccSessionId) : null;
    const runtime = targetSession ? getCodexRuntime(targetSession.cliType) : historyRuntime;
    if (!['wsl', 'windows'].includes(runtime)) {
      throw new Error('The Codex history runtime is missing or invalid');
    }
    const processLookup = typeof this.codexSessionService.getProcessSnapshotForRuntime === 'function'
      ? this.codexSessionService.getProcessSnapshotForRuntime(runtime)
      : this.codexSessionService.scanProcesses();
    const [processState, threadsById] = await Promise.all([
      processLookup,
      this.codexSessionService.getThreadsByIds(requestedIds, null, { runtime })
    ]);

    for (const selection of selections) {
      const codexSessionId = String(selection?.codexSessionId || '').toLowerCase();
      if (!codexSessionId || seen.has(codexSessionId)) {
        skipped.push({ ...selection, code: 'duplicate', message: 'Duplicate or missing Codex session ID' });
        continue;
      }
      seen.add(codexSessionId);

      const thread = threadsById.get(codexSessionId);
      if (!thread) {
        skipped.push({ ...selection, code: 'not_found', message: 'Codex conversation is no longer available' });
        continue;
      }

      const requestedEasyccSessionId = targetEasyccSessionId || selection.easyccSessionId || '';
      if (targetEasyccSessionId && selection.easyccSessionId && selection.easyccSessionId !== targetEasyccSessionId) {
        skipped.push({ ...selection, code: 'invalid_card', message: 'Selection does not match the requested EasyCC card' });
        continue;
      }
      let session = requestedEasyccSessionId ? this.sessions.get(requestedEasyccSessionId) : null;
      if (requestedEasyccSessionId && (!session || !isCodexType(session.cliType) || session.status !== 'paused')) {
        skipped.push({ ...selection, code: 'invalid_card', message: 'EasyCC card is not a paused Codex session' });
        continue;
      }
      if (session && !codexPathsEqual(session.workingDir, thread.workingDir)) {
        skipped.push({ ...selection, code: 'cwd_mismatch', message: 'Codex conversation belongs to a different folder' });
        continue;
      }

      const linked = [...this.sessions.values()].find((candidate) =>
        candidate.id !== session?.id &&
        getCodexRuntime(candidate.cliType) === runtime &&
        String(candidate.codexSessionId || '').toLowerCase() === codexSessionId
      );
      if (linked || processState.liveRootIds.has(codexSessionId)) {
        skipped.push({ ...selection, code: 'already_open', message: 'Codex conversation is already open or linked' });
        continue;
      }

      if (!session) session = this.createBoundCodexSession(thread);
      session.codexSessionId = codexSessionId;
      session.codexThreadName = thread.threadName || null;
      if (thread.threadName) session.name = thread.threadName;
      session.codexIdentityState = 'unverified';
      session.codexIdentityError = null;
      this.dataStore.saveSession(session);

      const success = this.resumeSession(session.id);
      if (!success) {
        session.status = 'paused';
        session.codexIdentityState = 'unresolved';
        session.codexIdentityError = 'Failed to start exact Codex resume';
        this.dataStore.saveSession(session);
        this.emit('sessionUpdated', this.getSessionSnapshot(session));
        skipped.push({ ...selection, easyccSessionId: session.id, code: 'launch_failed', message: session.codexIdentityError });
        continue;
      }
      accepted.push(this.getSessionSnapshot(session));
    }

    return { accepted, skipped };
  }

  deriveRepoContext(workingDir, fallback = null) {
    const normalizedWorkingDir = this.normalizeGroupPath(workingDir);
    const fallbackWorkingDir = this.normalizeGroupPath(fallback?.workingDir);
    const nonGitGroupKey = normalizedWorkingDir || fallbackWorkingDir || '';

    if (!workingDir || typeof workingDir !== 'string') {
      return {
        repoRoot: fallback?.repoRoot || null,
        repoName: fallback?.repoName || null,
        gitBranch: fallback?.gitBranch || null,
        groupKey: fallback?.groupKey || nonGitGroupKey
      };
    }

    try {
      const repoRoot = this.normalizeGroupPath(execFileSync('git', ['rev-parse', '--show-toplevel'], {
        cwd: workingDir,
        timeout: 5000,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore']
      }).trim());

      if (!repoRoot) {
        throw new Error('Missing repo root');
      }

      let gitBranch = execFileSync('git', ['branch', '--show-current'], {
        cwd: workingDir,
        timeout: 5000,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore']
      }).trim();

      if (!gitBranch) {
        gitBranch = 'detached';
      }

      return {
        repoRoot,
        repoName: path.basename(repoRoot) || repoRoot,
        gitBranch,
        groupKey: repoRoot
      };
    } catch {
      return {
        repoRoot: null,
        repoName: null,
        gitBranch: null,
        groupKey: nonGitGroupKey
      };
    }
  }

  applyRepoContext(session, fallback = null) {
    if (!session) return session;
    const repoContext = this.deriveRepoContext(session.workingDir, fallback);
    session.repoRoot = repoContext.repoRoot;
    session.repoName = repoContext.repoName;
    session.gitBranch = repoContext.gitBranch;
    session.groupKey = repoContext.groupKey || this.normalizeGroupPath(session.workingDir);
    return session;
  }

  sanitizeRole(role) {
    if (typeof role !== 'string') {
      return '';
    }
    const normalized = role.replace(/\0/g, '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
    return normalized.slice(0, 4096);
  }

  getEasyccEnv(easyccSessionId = '', meta = {}) {
    const env = {
      ...process.env,
      EASYCC_PORT: String(this.port || 5010),
      EASYCC_SESSION_ID: easyccSessionId || ''
    };
    if (meta.taskId) {
      env.EASYCC_TASK_ID = meta.taskId;
    }
    return env;
  }

  getWslLaunchEnv(easyccSessionId = '', meta = {}) {
    const env = this.getEasyccEnv(easyccSessionId, meta);

    // Keep Windows-side shell startup hooks from being imported into WSL before
    // our bootstrap script has a chance to set up a predictable environment.
    delete env.BASH_ENV;
    delete env.ENV;
    delete env.SHELLOPTS;
    delete env.PROMPT_COMMAND;

    return env;
  }

  quoteForPosixShell(value = '') {
    return `'${String(value).replace(/'/g, `'\\''`)}'`;
  }

  buildCodexBootstrapScript(workingDir, { resume = false, resumeTarget = null, easyccSessionId = '' } = {}) {
    const quotedWorkingDir = this.quoteForPosixShell(workingDir);
    const codexHome = this.codexSessionService?.resolveShellCodexHome?.() || '$HOME/.codex';
    const codexHomeExport = codexHome === '$HOME/.codex'
      ? 'export CODEX_HOME="$HOME/.codex";'
      : `export CODEX_HOME=${this.quoteForPosixShell(codexHome)};`;
    if (resume && !resumeTarget) {
      throw new Error('Exact Codex resume target is required');
    }
    const codexArgs = resume
      ? `--dangerously-bypass-approvals-and-sandbox -C ${quotedWorkingDir} resume ${this.quoteForPosixShell(resumeTarget)}`
      : `--dangerously-bypass-approvals-and-sandbox -C ${quotedWorkingDir}`;

    return [
      'unset NPM_CONFIG_PREFIX npm_config_prefix PREFIX prefix;',
      'if [ -f "$HOME/.profile" ]; then . "$HOME/.profile" >/dev/null 2>&1; fi;',
      'if [ -f "$HOME/.bashrc" ]; then . "$HOME/.bashrc" >/dev/null 2>&1; fi;',
      codexHomeExport,
      `export EASYCC_SESSION_ID=${this.quoteForPosixShell(easyccSessionId)};`,
      'if ! command -v codex >/dev/null 2>&1 && [ -s "$HOME/.nvm/nvm.sh" ]; then',
      '  . "$HOME/.nvm/nvm.sh" --no-use >/dev/null 2>&1;',
      '  nvm use --delete-prefix default >/dev/null 2>&1 || nvm use --delete-prefix >/dev/null 2>&1 || true;',
      'fi;',
      'codex_prefix="$(npm prefix -g 2>/dev/null || true)";',
      'if [ -n "$codex_prefix" ] && [ -x "$codex_prefix/bin/codex" ]; then',
      '  exec "$codex_prefix/bin/codex" ' + codexArgs + ';',
      'fi;',
      `exec codex ${codexArgs}`
    ].join(' ');
  }

  spawnTerminalProcess(workingDir, { easyccSessionId = '', meta = {} } = {}) {
    const env = this.getEasyccEnv(easyccSessionId, meta);
    const isWindows = process.platform === 'win32';
    if (isWindows) {
      return pty.spawn('powershell.exe', ['-NoLogo'], {
        name: 'xterm-color',
        cols: 120,
        rows: 30,
        cwd: workingDir,
        env
      });
    }

    const shell = process.env.SHELL || '/bin/bash';
    return pty.spawn(shell, [], {
      name: 'xterm-color',
      cols: 120,
      rows: 30,
      cwd: workingDir,
      env
    });
  }

  spawnWslProcess(workingDir, { easyccSessionId = '', meta = {} } = {}) {
    if (process.platform !== 'win32') {
      throw new Error('WSL sessions are only supported on Windows');
    }

    const env = this.getWslLaunchEnv(easyccSessionId, meta);
    const wslPath = this.convertToWslPath(workingDir);
    const shellBootstrap = 'export CODEX_HOME="$HOME/.codex"; exec "${SHELL:-/bin/bash}" -i';
    return pty.spawn('wsl.exe', ['--cd', wslPath, 'bash', '--noprofile', '--norc', '-lc', shellBootstrap], {
      name: 'xterm-color',
      cols: 120,
      rows: 30,
      env
    });
  }

  spawnCodexProcess(workingDir, { resume = false, resumeTarget = null, easyccSessionId = '', meta = {} } = {}) {
    const isWindows = process.platform === 'win32';
    const env = isWindows
      ? this.getWslLaunchEnv(easyccSessionId, meta)
      : this.getEasyccEnv(easyccSessionId, meta);
    if (isWindows) {
      const wslPath = this.convertToWslPath(workingDir);
      const bootstrapScript = this.buildCodexBootstrapScript(wslPath, { resume, resumeTarget, easyccSessionId });
      return pty.spawn('wsl.exe', ['--cd', wslPath, 'bash', '--noprofile', '--norc', '-c', bootstrapScript], {
        name: 'xterm-color',
        cols: 120,
        rows: 30,
        env
      });
    }

    const bootstrapScript = this.buildCodexBootstrapScript(workingDir, { resume, resumeTarget, easyccSessionId });
    return pty.spawn('/bin/bash', ['-lc', bootstrapScript], {
      name: 'xterm-color',
      cols: 120,
      rows: 30,
      cwd: workingDir,
      env
    });
  }

  spawnCodexWindowsProcess(workingDir, { resume = false, resumeTarget = null, easyccSessionId = '', meta = {} } = {}) {
    if (resume && !resumeTarget) throw new Error('Exact Codex resume target is required');
    const token = uuidv4();
    this.codexWindowsHookTokens.set(easyccSessionId, {
      token,
      generation: null,
      resumeTarget: resume ? String(resumeTarget).toLowerCase() : null
    });
    const env = this.getEasyccEnv(easyccSessionId, meta);
    env.EASYCC_CODEX_HOOK_TOKEN = token;
    return codexWindowsRuntime.spawn(workingDir, {
      resumeTarget: resume ? resumeTarget : null,
      easyccSessionId,
      env
    });
  }

  clearCodexWindowsWakeAttempt(session, {
    clearToken = false,
    clearWarning = true,
    clearExpected = true
  } = {}) {
    if (!session) return;
    const attempt = session.codexWakeAttempt;
    if (attempt?.corroborationTimer) clearTimeout(attempt.corroborationTimer);
    if (clearToken) {
      const tokenEntry = this.codexWindowsHookTokens.get(session.id);
      if (!attempt || !tokenEntry || tokenEntry.token === attempt.token) {
        this.codexWindowsHookTokens.delete(session.id);
      }
    }
    session.codexWakeAttempt = null;
    if (clearExpected) session.expectedCodexWakeId = null;
    if (clearWarning) session.wakeWarning = null;
  }

  bindCodexWindowsLaunch(session, resumeTarget = null) {
    const tokenEntry = this.codexWindowsHookTokens.get(session?.id);
    if (!session || !tokenEntry) return null;
    tokenEntry.generation = session.ptyGeneration;
    if (resumeTarget) tokenEntry.resumeTarget = String(resumeTarget).toLowerCase();
    if (session.runtimeState !== 'resuming' || !resumeTarget) return null;

    const expectedId = String(session.expectedCodexWakeId || '').toLowerCase();
    const launchTarget = String(resumeTarget).toLowerCase();
    session.codexWakeAttempt = {
      expectedId,
      launchTarget,
      cliType: session.cliType,
      token: tokenEntry.token,
      ptyGeneration: session.ptyGeneration,
      startedAt: Date.now(),
      fallbackAt: null,
      startupOutput: '',
      error: null,
      corroborationTimer: null
    };
    return session.codexWakeAttempt;
  }

  markCodexWakeAttemptError(session, code, message) {
    const attempt = session?.codexWakeAttempt;
    if (!attempt || attempt.ptyGeneration !== session.ptyGeneration) return false;
    attempt.error = { code, message };
    session.codexIdentityState = code === 'identity_conflict' ? 'conflict' : 'unresolved';
    session.codexIdentityError = message;
    this.emit('sessionUpdated', this.getSessionSnapshot(session));
    return true;
  }

  transferCodexOwnership(session, owner, candidateId = '') {
    if (!session || !owner || session.id === owner.id) return false;
    const ownerName = owner.name || owner.id;
    const transferred = this.killSession(owner.id);
    if (!transferred) return false;
    debugLog(
      `Codex conversation ${candidateId || 'unknown'} ownership transferred ` +
      `from EasyCC session ${owner.id} (${ownerName}) to ${session.id} (${session.name})`
    );
    return true;
  }

  observeCodexWakeStartupOutput(session, data, generation) {
    const attempt = session?.codexWakeAttempt;
    if (!attempt || attempt.ptyGeneration !== generation || attempt.error) return false;
    attempt.startupOutput = `${attempt.startupOutput}${this.cleanTerminalText(data)}`
      .slice(-CODEX_WAKE_OUTPUT_MAX_CHARS);
    const text = attempt.startupOutput;
    let message = null;
    let code = 'startup_error';
    if (/(?:^|\n)\s*(?:(?:error|fatal)\s*:?\s*)?(?:session|conversation)\s+[0-9a-f-]{36}\b.{0,100}\balready (?:in use|open)\b/im.test(text) ||
        /(?:^|\n)\s*(?:error|fatal)\s*:.{0,100}\b(?:session|conversation)\b.{0,100}\balready (?:in use|open)\b/im.test(text)) {
      code = 'identity_conflict';
      message = 'The exact Codex conversation is already open';
    } else if (/(?:^|\n)\s*(?:error|fatal)\s*:.{0,100}(?:(?:no|missing) (?:conversation|rollout)|(?:conversation|rollout).{0,40}not found)/im.test(text)) {
      message = 'The exact Codex conversation could not be found';
    } else if (/(?:^|\n)\s*(?:error|fatal)\s*:.{0,100}(?:failed to resume|exact Codex resume failed)/im.test(text)) {
      message = 'The exact Codex resume failed during startup';
    }
    return message ? this.markCodexWakeAttemptError(session, code, message) : false;
  }

  startCodexWakeCorroborationTimer(session, attempt) {
    if (!session || !attempt || attempt.corroborationTimer) return;
    const delay = Number(this.codexHookCorroborationTimeoutMs) || CODEX_HOOK_CORROBORATION_TIMEOUT_MS;
    attempt.corroborationTimer = setTimeout(() => {
      if (session.codexWakeAttempt !== attempt ||
          session.ptyGeneration !== attempt.ptyGeneration ||
          session.codexIdentityState !== 'resume_verified') return;
      session.wakeWarning = 'Exact resume is active, but the SessionStart identity callback did not arrive. Pause and retry if the displayed conversation is unexpected.';
      this.emit('sessionUpdated', this.getSessionSnapshot(session));
    }, delay);
    attempt.corroborationTimer.unref?.();
  }

  failLiveCodexWakeAttempt(session, attempt, message) {
    if (!session || session.codexWakeAttempt !== attempt ||
        session.ptyGeneration !== attempt.ptyGeneration) return false;
    if (attempt.corroborationTimer) clearTimeout(attempt.corroborationTimer);
    const processRef = session.pty;
    session.status = 'paused';
    session.runtimeState = 'wake_failed_live';
    session.pauseReason = 'auto_park';
    session.wakeError = message;
    session.wakeWarning = null;
    if (processRef) {
      try { processRef.kill(); } catch {}
    }
    this.dataStore.saveSession(session);
    this.emit('sessionUpdated', this.getSessionSnapshot(session));
    return true;
  }

  acceptCodexWindowsSessionStart(easyccSessionId, token, payload = {}) {
    const tokenEntry = this.codexWindowsHookTokens.get(easyccSessionId);
    if (!tokenEntry || tokenEntry.token !== token) return false;
    const session = this.sessions.get(easyccSessionId);
    if (!session || session.cliType !== CODEX_WINDOWS) return false;
    if (!session.pty || tokenEntry.generation !== session.ptyGeneration) return false;
    const candidateId = payload.session_id || payload.sessionId || payload.id;
    if (!candidateId) return false;
    const normalizedCandidate = String(candidateId).toLowerCase();
    const attempt = session.codexWakeAttempt;
    if (attempt && attempt.ptyGeneration !== session.ptyGeneration) return false;
    if (attempt && normalizedCandidate !== attempt.expectedId) {
      this.codexWindowsHookTokens.delete(easyccSessionId);
      const message = `Exact Codex wake expected ${attempt.expectedId}, but resumed ${normalizedCandidate}`;
      this.markCodexWakeAttemptError(session, 'identity_mismatch', message);
      if (session.runtimeState === 'live') this.failLiveCodexWakeAttempt(session, attempt, message);
      return true;
    }
    if (payload.cwd && !codexPathsEqual(payload.cwd, session.workingDir)) {
      this.codexWindowsHookTokens.delete(easyccSessionId);
      const message = 'Codex conversation belongs to a different folder';
      if (attempt) {
        this.markCodexWakeAttemptError(session, 'identity_mismatch', message);
        if (session.runtimeState === 'live') this.failLiveCodexWakeAttempt(session, attempt, message);
      } else {
        session.codexIdentityState = 'unresolved';
        session.codexIdentityError = message;
        this.emit('sessionUpdated', this.getSessionSnapshot(session));
      }
      return true;
    }
    const activeOwner = [...this.sessions.values()].find(candidate =>
      candidate.id !== session.id &&
      candidate.cliType === CODEX_WINDOWS &&
      candidate.pty &&
      !['paused', 'completed', 'killed'].includes(candidate.status) &&
      String(candidate.codexSessionId || '').toLowerCase() === normalizedCandidate
    );
    if (activeOwner) {
      if (!this.transferCodexOwnership(session, activeOwner, normalizedCandidate)) {
        this.codexWindowsHookTokens.delete(easyccSessionId);
        const message = `Codex conversation is already linked to ${activeOwner.name}`;
        if (attempt) {
          this.markCodexWakeAttemptError(session, 'identity_conflict', message);
          if (session.runtimeState === 'live') this.failLiveCodexWakeAttempt(session, attempt, message);
        } else {
          this.applyCodexIdentityObservation({
            sessionId: easyccSessionId,
            state: 'conflict',
            candidateId: normalizedCandidate,
            error: message
          });
        }
        return true;
      }
    }
    session.codexTranscriptPath = payload.transcript_path || payload.transcriptPath || null;
    const previousCodexSessionId = String(session.codexSessionId || '').toLowerCase();
    const switched = !!previousCodexSessionId && previousCodexSessionId !== normalizedCandidate;
    const indexedThreadName = this.codexSessionService
      ?.loadWindowsIndex?.()
      ?.get(normalizedCandidate)
      ?.threadName;
    this.applyCodexIdentityObservation({
      sessionId: easyccSessionId,
      state: 'verified',
      candidateId: normalizedCandidate,
      workingDir: payload.cwd || session.workingDir,
      threadName: indexedThreadName || (switched ? undefined : session.name)
    });
    if (attempt && session.codexIdentityState === 'conflict') {
      session.runtimeState = 'wake_failed_live';
      session.pauseReason = 'auto_park';
      session.wakeError = session.codexIdentityError;
    } else if (attempt && session.runtimeState === 'live') {
      this.clearCodexWindowsWakeAttempt(session, { clearToken: false });
      this.dataStore.saveSession(session);
      this.emit('sessionUpdated', this.getSessionSnapshot(session));
    } else if (attempt) {
      attempt.hookVerified = true;
      if (attempt.corroborationTimer) {
        clearTimeout(attempt.corroborationTimer);
        attempt.corroborationTimer = null;
      }
    }
    return true;
  }

  spawnClaudeProcess(workingDir, { sessionId = null, resumeId = null, role = '', easyccSessionId = '', meta = {}, startupPrompt = '', planMode = false } = {}) {
    const env = this.getEasyccEnv(easyccSessionId, meta);
    const args = ['--allow-dangerously-skip-permissions'];
    if (planMode) {
      args.push('--permission-mode', 'plan');
    } else {
      args.push('--permission-mode', 'bypassPermissions');
    }
    if (resumeId) {
      args.push('--resume', resumeId);
    } else if (sessionId) {
      args.push('--session-id', sessionId);
    }
    const sanitizedRole = this.sanitizeRole(role);
    if (sanitizedRole) {
      args.push('--append-system-prompt', sanitizedRole);
    }
    // startupPrompt delivered via startupSequence (PTY stdin after idle), not CLI arg

    const isWindows = process.platform === 'win32';
    if (isWindows) {
      return pty.spawn('cmd.exe', ['/c', 'claude', ...args], {
        name: 'xterm-color',
        cols: 120,
        rows: 30,
        cwd: workingDir,
        env
      });
    }
    return pty.spawn('claude', args, {
      name: 'xterm-color',
      cols: 120,
      rows: 30,
      cwd: workingDir,
      env
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
    const cleanData = String(data || '')
      .replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, '')
      .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
      .replace(/\r/g, '\n');

    return /Ask Codex to do anything/i.test(cleanData) ||
      /^\s*›(?:\s|$)/m.test(cleanData) ||
      /\?\s*for shortcuts/i.test(cleanData) ||
      /Would you like to run/i.test(cleanData) ||
      /Implement this plan\?/i.test(cleanData);
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
    this.markSemanticSubmission(session, { source: 'automation' });
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

    if (isCodexType(session.cliType)) {
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
    if (!session?.roleInjection) return false;
    if (session.roleInjection.cliType === 'codex' && this.isCodexReadyForInput(data)) {
      return this.injectCodexRole(session, 'prompt-detected');
    }
    if (session.roleInjection.cliType === 'claude') {
      const nextStatus = this.detectStatus(data, session.status, session.cliType);
      if (nextStatus === 'idle') {
        return this.injectClaudeRoleReminder(session, 'prompt-detected');
      }
    }
    return false;
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
      return false;
    }
    const startup = session.startupSequence;
    if (!startup.queue.length) {
      startup.active = false;
      startup.completedAt = new Date().toISOString();
      this.emit('sessionUpdated', this.getSessionSnapshot(session));
      // Drain message queue now that startup is complete
      if (this.canAcceptOrchestratorInput(session)) {
        this.drainMessageQueue(session);
      }
      return false;
    }

    const nextStatus = this.detectStatus(data, session.status, session.cliType);
    const ready = nextStatus === 'idle' || /Would you like to proceed/i.test(data) || /Ask Codex to do anything/i.test(data);
    const now = Date.now();
    if (!ready) return false;
    if (now - startup.lastSentAt < 1200) return false;

    const nextCommand = startup.queue.shift();
    if (!nextCommand) {
      startup.active = false;
      startup.completedAt = new Date().toISOString();
      // Drain message queue now that startup is complete
      if (this.canAcceptOrchestratorInput(session)) {
        this.drainMessageQueue(session);
      }
      return false;
    }

    if (isCodexType(session.cliType)) {
      this.markSemanticSubmission(session, { source: 'automation' });
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
    return true;
  }

  rewarmSession(id, agent) {
    const session = this.sessions.get(id);
    if (!session || !session.pty) {
      return false;
    }
    this.runStartupSequence(session, agent, { force: true });
    return true;
  }

  cleanTerminalText(data) {
    return String(data || '')
      .replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, '')
      .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
      .replace(/\r/g, '\n');
  }

  stripCodexResumeHint(text) {
    return String(text || '')
      .replace(/\s*[,.;:]\s*to\s+resume\s+this\s+(?:thread|session)\s+run\s+codex\s+resume\b.*$/i, '')
      .trim();
  }

  updateStatusDetectionContext(session, data) {
    const cleanData = this.cleanTerminalText(data);
    const next = `${session?.statusDetectionContext || ''}${cleanData}`;
    session.statusDetectionContext = next.length > 4000 ? next.slice(-4000) : next;
    return session.statusDetectionContext;
  }

  getCodexStatusSampler(session) {
    if (!session.codexStatusSampler) {
      session.codexStatusSampler = {
        chunks: [],
        head: 0,
        chars: 0,
        timer: null,
        deferred: null,
        screen: createCodexStatusScreen()
      };
    }
    return session.codexStatusSampler;
  }

  collectCodexStatusSample(session, data) {
    if (!session || !isCodexType(session.cliType)) return null;
    const sample = String(data || '');
    if (!sample) return this.getCodexStatusSampler(session);

    const sampler = this.getCodexStatusSampler(session);
    sampler.chunks.push(sample);
    sampler.chars += sample.length;

    while (sampler.chars > CODEX_STATUS_SAMPLE_MAX_CHARS && sampler.head < sampler.chunks.length) {
      const overflow = sampler.chars - CODEX_STATUS_SAMPLE_MAX_CHARS;
      const chunk = sampler.chunks[sampler.head];
      if (chunk.length <= overflow) {
        sampler.chars -= chunk.length;
        sampler.chunks[sampler.head] = null;
        sampler.head += 1;
      } else {
        sampler.chunks[sampler.head] = chunk.slice(overflow);
        sampler.chars -= overflow;
      }
    }

    if (sampler.head >= 1024 && sampler.head * 2 >= sampler.chunks.length) {
      sampler.chunks = sampler.chunks.slice(sampler.head);
      sampler.head = 0;
    }

    return sampler;
  }

  analyzeCodexStatusSample(session) {
    const sampler = session?.codexStatusSampler;
    if (!sampler || sampler.chars === 0) return false;

    const sample = sampler.chunks.slice(sampler.head).filter(Boolean).join('');
    sampler.chunks = [];
    sampler.head = 0;
    sampler.chars = 0;

    const analysis = applyCodexStatusScreenSample(sampler.screen, sample);
    if (analysis.workingRows.length === 0) return false;
    if (session.status === 'paused' || session.status === 'completed' || session.status === 'killed') return false;

    session.codexSampledWorkingUntil = Date.now() + CODEX_STATUS_SAMPLE_HOLD_MS;
    this.updateSessionStatus(session, 'thinking');
    return true;
  }

  scheduleCodexStatusSample(session) {
    const sampler = this.getCodexStatusSampler(session);
    if (sampler.timer || sampler.deferred) return;

    const scheduleTimeout = this.setTimeoutFn || setTimeout;
    const scheduleImmediate = this.setImmediateFn || setImmediate;
    sampler.timer = scheduleTimeout(() => {
      sampler.deferred = scheduleImmediate(() => {
        sampler.timer = null;
        sampler.deferred = null;
        this.analyzeCodexStatusSample(session);
        if (sampler.chars > 0 && session.pty && !['paused', 'completed', 'killed'].includes(session.status)) {
          this.scheduleCodexStatusSample(session);
        }
      });
    }, CODEX_STATUS_SAMPLE_INTERVAL_MS);
  }

  observeCodexStatusSample(session, data) {
    if (!session || !isCodexType(session.cliType)) return;
    if (session.status !== 'idle' && session.stage !== 'in_review') return;
    this.collectCodexStatusSample(session, data);
    this.scheduleCodexStatusSample(session);
  }

  clearCodexStatusSampler(session, { resetScreen = true } = {}) {
    const sampler = session?.codexStatusSampler;
    if (!sampler) return;

    const cancelTimeout = this.clearTimeoutFn || clearTimeout;
    const cancelImmediate = this.clearImmediateFn || clearImmediate;
    if (sampler.timer) cancelTimeout(sampler.timer);
    if (sampler.deferred) cancelImmediate(sampler.deferred);
    sampler.timer = null;
    sampler.deferred = null;
    sampler.chunks = [];
    sampler.head = 0;
    sampler.chars = 0;
    if (resetScreen) sampler.screen = createCodexStatusScreen();
    session.codexSampledWorkingUntil = 0;
  }

  /**
   * Process role/startup automation and status detection for one PTY chunk.
   * Shared by create and resume handlers so their debounce behavior cannot drift.
   * @param {object} session
   * @param {string} data
   * @returns {string}
   */
  processSessionOutputState(session, data) {
    const roleSubmitted = this.tryRoleInjectionOnOutput(session, data);
    const startupSubmitted = this.processStartupSequenceOnOutput(session, data);
    const automatedCodexSubmission = isCodexType(session?.cliType) &&
      (roleSubmitted || startupSubmitted);

    // The ready prompt that triggered automatic input is stale immediately after
    // the write. Do not let the same callback recreate a pending idle transition.
    if (automatedCodexSubmission) {
      return session.status;
    }

    if (session.resizingUntil && Date.now() <= session.resizingUntil) {
      return session.status;
    }

    const statusContext = this.updateStatusDetectionContext(session, data);
    const newStatus = this.detectStatus(
      data,
      session.status,
      session.cliType,
      statusContext,
      session.pendingStatus
    );

    const hasSampledWorkingSignal = isCodexType(session.cliType) &&
      session.codexSampledWorkingUntil &&
      Date.now() < session.codexSampledWorkingUntil;
    const hasExplicitReadySignal = isCodexType(session.cliType) &&
      newStatus === 'idle' &&
      this.isCodexReadyForInput(data);
    const effectiveStatus = hasSampledWorkingSignal && newStatus === 'idle' && !hasExplicitReadySignal
      ? 'thinking'
      : newStatus;

    if (hasExplicitReadySignal) {
      this.clearCodexStatusSampler(session);
      if (!session.interactionPending) {
        const gainedReadyEvidence = session.idleEvidence !== 'codex_ready_prompt';
        session.idleEvidence = 'codex_ready_prompt';
        session.readySince = session.readySince || new Date().toISOString();
        if (gainedReadyEvidence) this.emit('sessionUpdated', this.getSessionSnapshot(session));
      }
    } else if (isCodexType(session.cliType) && effectiveStatus === 'waiting') {
      const becameInteractionPending = !session.interactionPending;
      session.interactionPending = true;
      session.interactionPendingSource = 'codex_prompt';
      session.idleEvidence = null;
      session.readySince = null;
      if (becameInteractionPending) this.emit('sessionUpdated', this.getSessionSnapshot(session));
    } else if (!['idle', 'waiting'].includes(effectiveStatus)) {
      session.idleEvidence = null;
      session.readySince = null;
    }

    if (effectiveStatus === 'paused') {
      return effectiveStatus;
    }

    // A same-as-current Codex signal only needs the updater when it must cancel
    // an opposite pending transition. Keep steady-state streaming on the cheap path.
    const hasPendingTransition = !!(session.pendingStatus || session.statusDebounceTimer);
    if (
      effectiveStatus !== session.status ||
      (isCodexType(session.cliType) && hasPendingTransition)
    ) {
      this.updateSessionStatus(session, effectiveStatus);
    }
    return effectiveStatus;
  }

  extractSessionRename(data) {
    const cleanData = this.cleanTerminalText(data);
    const patterns = [
      /Session\s+renamed\s+to:?\s*"([^"\n]+)"/i,
      /Session\s+renamed\s+to:?\s*([^\n]+)/i,
      /Thread\s+renamed\s+to:?\s*"([^"\n]+)"/i,
      /Thread\s+renamed\s+to:?\s*([^\n]+)/i,
      /(?:Codex\s+)?conversation\s+renamed\s+to:?\s*"([^"\n]+)"/i,
      /(?:Codex\s+)?conversation\s+renamed\s+to:?\s*([^\n]+)/i,
      /Renamed\s+(?:session|conversation)\s+to:?\s*"([^"\n]+)"/i,
      /Renamed\s+(?:session|conversation)\s+to:?\s*([^\n]+)/i,
      /Renamed\s+to:?\s*"([^"\n]+)"/i,
      /Renamed\s+to:?\s*([^\n]+)/i
    ];

    for (const line of cleanData.split('\n')) {
      if (!/renamed/i.test(line)) continue;
      for (const pattern of patterns) {
        const match = line.match(pattern);
        if (!match || !match[1]) continue;
        const name = this.stripCodexResumeHint(
          match[1]
            .trim()
            .replace(/^["']|["']$/g, '')
        );
        if (name) return name;
      }
    }

    return '';
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
    const normalizedWorkingDir = this.normalizeWorkingDirForCli(workingDir, cliType);
    const repoContext = isCodexType(cliType)
      ? { repoRoot: null, repoName: null, gitBranch: null, groupKey: normalizedWorkingDir }
      : this.deriveRepoContext(normalizedWorkingDir);

    let ptyProcess;

    try {
      if (cliType === 'terminal') {
        ptyProcess = this.spawnTerminalProcess(normalizedWorkingDir, { easyccSessionId: id, meta: sessionMeta });
      } else if (cliType === 'wsl') {
        ptyProcess = this.spawnWslProcess(normalizedWorkingDir, { easyccSessionId: id, meta: sessionMeta });
      } else if (cliType === 'codex') {
        ptyProcess = this.spawnCodexProcess(normalizedWorkingDir, {
          resume: false,
          resumeTarget: null,
          easyccSessionId: id,
          meta: sessionMeta
        });
      } else if (cliType === CODEX_WINDOWS) {
        ptyProcess = this.spawnCodexWindowsProcess(normalizedWorkingDir, {
          resume: false, easyccSessionId: id, meta: sessionMeta
        });
      } else {
        ptyProcess = this.spawnClaudeProcess(normalizedWorkingDir, {
          sessionId: claudeSessionId,
          role: sanitizedRole,
          easyccSessionId: id,
          meta: sessionMeta,
          startupPrompt: sessionMeta.startupPrompt || '',
          planMode: sessionMeta.planMode || false
        });
      }
    } catch (error) {
      const cliName = isCodexType(cliType)
        ? 'Codex'
        : cliType === 'terminal'
          ? 'Terminal'
          : cliType === 'wsl'
            ? 'WSL'
            : 'Claude';
      throw new Error(`Failed to spawn ${cliName} CLI: ${error.message}`);
    }

    const session = {
      id,
      name,
      status: 'active',
      currentTask: '',
      createdAt: now,
      lastActivity: now,
      outputBuffer: new ByteRingBuffer(this.getOutputBufferSize(cliType)),
      pty: ptyProcess,
      workingDir: normalizedWorkingDir,
      repoRoot: repoContext.repoRoot,
      repoName: repoContext.repoName,
      gitBranch: repoContext.gitBranch,
      groupKey: repoContext.groupKey,
      cliType,  // 'claude' or 'codex'
      claudeSessionId: cliType === 'claude' ? claudeSessionId : null, // Only for Claude sessions
      previousClaudeSessionIds: [],
      codexSessionId: null,
      codexThreadName: null,
      codexLaunchStartedAt: isCodexType(cliType) ? now.toISOString() : null,
      codexIdentityState: isCodexType(cliType) ? 'verifying' : null,
      codexIdentityVerifiedAt: null,
      codexIdentityError: null,
      recoveryError: null,
      notes: '',
      role: sanitizedRole,
      agentId: sessionMeta.agentId || null,
      taskId: sessionMeta.taskId || null,
      isOrchestrator: sessionMeta.isOrchestrator || false,
      parentSessionId: sessionMeta.parentSessionId || null,
      teamInstanceId: sessionMeta.teamInstanceId || null,
      tags: [],
      plans: [],
      promptBuffer: '',      // Characters accumulated until Enter
      statusDetectionContext: '',
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
      comments: [],
      // Message queue for orchestrator sends when session is busy
      messageQueue: [],
      codexCaptureTimer: null,
      codexCaptureAttempts: 0
    };
    this.ensureParkingFields(session);

    this.resetSessionTranscript(id);
    const ptyGeneration = session.ptyGeneration;
    if (cliType === CODEX_WINDOWS) {
      this.bindCodexWindowsLaunch(session, null);
    }

    // Queue startupPrompt via startupSequence (delivers via PTY stdin after idle)
    if (sessionMeta.startupPrompt) {
      session.startupSequence = {
        active: true,
        queue: [sessionMeta.startupPrompt],
        waitingForIdle: true,
        sentCount: 0,
        lastSentAt: Date.now(),
        completedAt: null
      };
    }

    // Handle PTY output
    ptyProcess.onData((data) => {
      if (session.pty !== ptyProcess || session.ptyGeneration !== ptyGeneration) return;
      session.outputBuffer.push(data);
      this.emit('output', { sessionId: id, data });
      this.appendToTranscript(id, data);
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
      this.processSessionOutputState(session, data);
      this.observeCodexStatusSample(session, data);

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

      // Detect Claude Code and Codex /rename command output.
      const newName = this.extractSessionRename(data);
      if (newName && newName !== session.name) {
        session.name = newName;
        if (isCodexType(cliType)) session.codexThreadName = newName;
        this.dataStore.saveSession(session);
        this.emit('sessionUpdated', this.getSessionSnapshot(session));
      }

      // Detect plan updates from terminal output
      this.detectPlanActivity(data, session);
      this.attachCodexPlansFromOutput(session, data);

    });

    // Handle PTY exit
    ptyProcess.onExit(({ exitCode, signal }) => {
      if (session.pty !== ptyProcess || session.ptyGeneration !== ptyGeneration) return;
      const tokenEntry = this.codexWindowsHookTokens.get(id);
      if (cliType === CODEX_WINDOWS && tokenEntry?.generation === ptyGeneration) {
        this.codexWindowsHookTokens.delete(id);
      }
      session.lastPtyExitGeneration = ptyGeneration;
      session.lastPtyExitEvent = { exitCode, signal };
      // Don't process if shutting down (cleanup handles this)
      if (this.isShuttingDown) return;

      // Don't process if session was intentionally killed
      if (session.status === 'killed') return;

      // Don't mark as completed if intentionally paused
      if (session.status === 'paused') {
        return;
      }
      if (['parking', 'parking_failed_live', 'resuming', 'wake_failed_live'].includes(session.runtimeState)) return;

      // If session just started and immediately exited with error, keep it paused (don't delete)
      // This preserves sessions that fail to start
      const sessionAge = Date.now() - new Date(session.createdAt).getTime();
      debugLog(`PTY onExit for session ${id}: exitCode=${exitCode}, signal=${signal}, sessionAge=${sessionAge}ms`);
      if (sessionAge < 10000 && exitCode !== 0) {
        debugLog(`Session ${id} PAUSED due to early exit (age=${sessionAge}ms, exitCode=${exitCode})`);
        session.status = 'paused';
        this._clearWriteQueue(session);
        session.pty = null;
        this.clearCodexStatusSampler(session);
        this.clearCodexSessionCapture(session);
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
      this.clearCodexStatusSampler(session);
      this.clearCodexSessionCapture(session);
      this.dataStore.deleteSession(id);
      this.deleteSessionTranscript(id);
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
    if (isCodexType(cliType)) {
      this.codexSessionService.kickMonitor();
    }

    // Save to persistent storage
    this.dataStore.saveSession(session);

    // Start idle detection timer
    this.startIdleDetection(session);

    // Scan for existing plans that match this session
    this.scanExistingPlansForSession(id);

    const snapshot = this.getSessionSnapshot(session);
    this.emit('sessionCreated', { id, session: snapshot });
    return snapshot;
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

    // Find the most recently modified session that isn't owned by another EasyCC session
    sessions.sort((a, b) => new Date(b.modified) - new Date(a.modified));
    const ownedIds = new Set();
    for (const [id, s] of this.sessions) {
      if (id !== session.id && s.claudeSessionId) ownedIds.add(s.claudeSessionId);
    }
    const latestClaudeSession = sessions.find(cs => !ownedIds.has(cs.sessionId)) || null;

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

    // Collect IDs already owned by other EasyCC sessions
    const ownedIds = new Set();
    for (const [id, s] of this.sessions) {
      if (id !== session.id && s.claudeSessionId) ownedIds.add(s.claudeSessionId);
    }

    for (const pattern of patterns) {
      const match = data.match(pattern);
      if (match && match[1] && match[1].length >= 6) {
        // Don't adopt an ID already owned by another EasyCC session
        if (ownedIds.has(match[1])) {
          console.log(`Skipping Claude session ID ${match[1]} — already owned by another session`);
          continue;
        }
        session.claudeSessionId = match[1];
        this.dataStore.saveSession(session);
        console.log(`Detected Claude session ID: ${match[1]}`);
        break;
      }
    }
  }

  waitForPtyExit(processRef, timeoutMs = 5000) {
    return new Promise(resolve => {
      let settled = false;
      let timer = null;
      const finish = (result) => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        resolve(result);
      };
      processRef.onExit(event => finish({ exited: true, event }));
      timer = setTimeout(() => finish({ exited: false }), timeoutMs);
      timer.unref?.();
    });
  }

  parkSession(id, { reason = 'idle_timeout' } = {}) {
    const lifecycleTransitions = this.getLifecycleTransitions();
    const existingTransition = lifecycleTransitions.get(id);
    if (existingTransition?.kind === 'parking') return existingTransition.promise;
    if (existingTransition) {
      return Promise.resolve({ ok: false, error: 'lifecycle_transition_in_progress' });
    }
    const transition = (async () => {
      const session = this.sessions.get(id);
      if (!session || !this.isParkingEligible(session)) return { ok: false, error: 'not_eligible' };
      const processRef = session.pty;
      const generation = session.ptyGeneration;
      const previous = {
        status: session.status,
        idleEvidence: session.idleEvidence,
        readySince: session.readySince
      };

      session.runtimeState = 'parking';
      session.parkingProposalState = 'none';
      this.cancelPendingStatusTransition(session);
      this.emit('sessionUpdated', this.getSessionSnapshot(session));

      try {
        this.flushTranscriptStrict(id);
      } catch (error) {
        session.runtimeState = 'live';
        session.status = previous.status;
        session.idleEvidence = previous.idleEvidence;
        session.readySince = previous.readySince;
        session.wakeError = `Transcript flush failed: ${error.message}`;
        this.emit('sessionUpdated', this.getSessionSnapshot(session));
        return { ok: false, error: 'transcript_flush_failed' };
      }

      if (session.cliType === CODEX_WINDOWS) {
        this.clearCodexWindowsWakeAttempt(session, { clearToken: true });
      }

      const exitPromise = this.waitForPtyExit(processRef);
      try {
        processRef.kill();
      } catch (error) {
        session.runtimeState = 'live';
        session.wakeError = `Could not stop PTY: ${error.message}`;
        this.emit('sessionUpdated', this.getSessionSnapshot(session));
        return { ok: false, error: 'kill_failed' };
      }
      const exit = await exitPromise;
      if (!exit.exited || session.pty !== processRef || session.ptyGeneration !== generation) {
        session.runtimeState = 'parking_failed_live';
        session.wakeError = 'PTY termination could not be confirmed';
        this.emit('sessionUpdated', this.getSessionSnapshot(session));
        return { ok: false, error: 'kill_timeout' };
      }

      session.pty = null;
      session.status = 'paused';
      session.runtimeState = 'auto_parked';
      session.pauseReason = 'auto_park';
      session.parkedAt = new Date().toISOString();
      session.idleEvidence = null;
      session.readySince = null;
      session.wakeError = null;
      try {
        this.dataStore.saveSession(session, { throwOnError: true });
      } catch (error) {
        session.status = 'paused';
        session.runtimeState = 'paused';
        session.pauseReason = 'recovery_failed';
        session.wakeError = `PTY stopped, but parked state could not be saved: ${error.message}`;
        this.emit('sessionUpdated', this.getSessionSnapshot(session));
        return { ok: false, error: 'persistence_failed', session: this.getSessionSnapshot(session) };
      }
      session.outputBuffer.clear();
      const snapshot = this.getSessionSnapshot(session);
      this.emit('statusChange', {
        sessionId: id,
        status: 'paused',
        currentTask: session.currentTask,
        source: 'parking'
      });
      this.emit('sessionUpdated', snapshot);
      return { ok: true, session: snapshot };
    })().finally(() => {
      if (lifecycleTransitions.get(id)?.promise === transition) lifecycleTransitions.delete(id);
    });
    lifecycleTransitions.set(id, { kind: 'parking', promise: transition });
    return transition;
  }

  async getCodexWindowsWakeCollision(session, expectedId) {
    const normalized = String(expectedId || '').toLowerCase();
    const findActiveOwner = () => [...this.sessions.values()].find(candidate =>
      candidate.id !== session.id &&
      candidate.cliType === CODEX_WINDOWS &&
      candidate.pty &&
      !['paused', 'completed', 'killed'].includes(candidate.status) &&
      String(candidate.codexSessionId || '').toLowerCase() === normalized
    );
    let activeOwner = findActiveOwner();
    if (activeOwner) {
      return `Codex conversation is already linked to ${activeOwner.name}`;
    }
    const scanOwners = this.findCodexWindowsResumeOwners || codexWindowsRuntime.findExplicitResumeOwners;
    const externalOwners = await scanOwners(normalized);
    if (externalOwners.length > 0) {
      return 'Codex conversation is already open in another Windows process';
    }
    activeOwner = findActiveOwner();
    if (activeOwner) {
      return `Codex conversation is already linked to ${activeOwner.name}`;
    }
    return null;
  }

  evaluateWakeReadiness(session, processRef, generation) {
    if (session.pty !== processRef || session.ptyGeneration !== generation) {
      return { ready: false, error: 'pty_replaced', message: 'The resumed PTY was replaced before it became ready' };
    }
    if (session.lastPtyExitGeneration === generation) {
      return { ready: false, error: 'process_exited', message: 'The exact resume process exited before it became ready' };
    }
    if (session.cliType === 'claude') {
      return { ready: !!(session.claudeResumeVerified && session.status === 'idle') };
    }

    const attempt = session.codexWakeAttempt;
    if (attempt?.error) {
      return { ready: false, error: attempt.error.code, message: attempt.error.message };
    }
    if (session.codexIdentityState === 'conflict') {
      return {
        ready: false,
        error: 'identity_conflict',
        message: session.codexIdentityError || 'Codex conversation is already open'
      };
    }
    if (session.codexIdentityState === 'unresolved' && session.codexIdentityError) {
      return { ready: false, error: 'identity_mismatch', message: session.codexIdentityError };
    }

    const expectedId = String(session.expectedCodexWakeId || '').toLowerCase();
    const savedId = String(session.codexSessionId || '').toLowerCase();
    const readySinceMs = Date.parse(session.readySince || '');
    const configuredStableMs = Number(this.wakeReadyStableMs);
    const stableMs = Number.isFinite(configuredStableMs)
      ? Math.max(0, configuredStableMs)
      : CODEX_WAKE_READY_STABLE_MS;
    const promptReady = session.status === 'idle' &&
      session.idleEvidence === 'codex_ready_prompt' &&
      Number.isFinite(readySinceMs) &&
      Date.now() - readySinceMs >= stableMs;
    if (!expectedId || savedId !== expectedId || !promptReady) return { ready: false };
    if (session.codexIdentityState === 'verified') return { ready: true, mode: 'hook_verified' };

    const exactWindowsAttempt = session.cliType === CODEX_WINDOWS &&
      attempt &&
      attempt.cliType === CODEX_WINDOWS &&
      attempt.ptyGeneration === generation &&
      attempt.expectedId === expectedId &&
      attempt.launchTarget === expectedId &&
      attempt.token;
    if (exactWindowsAttempt && ['verifying', 'resume_verified'].includes(session.codexIdentityState)) {
      return { ready: true, mode: 'resume_verified', attempt };
    }
    return { ready: false };
  }

  wakeSession(id) {
    const lifecycleTransitions = this.getLifecycleTransitions();
    const existingTransition = lifecycleTransitions.get(id);
    if (existingTransition?.kind === 'waking') return existingTransition.promise;
    if (existingTransition) {
      return Promise.resolve({ ok: false, error: 'lifecycle_transition_in_progress' });
    }
    const transition = (async () => {
      const session = this.sessions.get(id);
      this.ensureParkingFields(session);
      if (!session || session.runtimeState !== 'auto_parked' || session.pauseReason !== 'auto_park') {
        return { ok: false, error: 'not_parked' };
      }

      const expectedId = isCodexType(session.cliType)
        ? String(session.codexSessionId || '').toLowerCase()
        : null;
      if (session.cliType === CODEX_WINDOWS) {
        const collision = await this.getCodexWindowsWakeCollision(session, expectedId);
        if (collision) {
          session.codexIdentityState = 'conflict';
          session.codexIdentityError = collision;
          session.wakeError = collision;
          this.dataStore.saveSession(session);
          this.emit('sessionUpdated', this.getSessionSnapshot(session));
          return { ok: false, error: 'identity_conflict', session: this.getSessionSnapshot(session) };
        }
      }

      this.clearCodexWindowsWakeAttempt(session, { clearToken: true });
      session.runtimeState = 'resuming';
      session.wakeError = null;
      session.wakeWarning = null;
      session.claudeResumeVerified = false;
      session.expectedCodexWakeId = expectedId;
      this.emit('sessionUpdated', this.getSessionSnapshot(session));
      const started = this.resumeSession(id, { recovery: true, lifecycleOwner: true });
      if (!started || !session.pty) {
        session.runtimeState = 'auto_parked';
        session.status = 'paused';
        session.pauseReason = 'auto_park';
        session.wakeError = session.recoveryError || 'Could not start exact resume';
        this.clearCodexWindowsWakeAttempt(session, { clearToken: true });
        this.dataStore.saveSession(session);
        this.emit('sessionUpdated', this.getSessionSnapshot(session));
        return { ok: false, error: 'spawn_failed' };
      }

      const processRef = session.pty;
      const generation = session.ptyGeneration;
      const deadline = Date.now() + (Number(this.wakeTimeoutMs) || CODEX_WAKE_TIMEOUT_MS);
      let ready = false;
      let readiness = { ready: false };
      while (Date.now() < deadline) {
        readiness = this.evaluateWakeReadiness(session, processRef, generation);
        if (readiness.error) break;
        ready = readiness.ready;
        if (ready) break;
        const sleep = this.wakeSleep || (ms => new Promise(resolve => setTimeout(resolve, ms)));
        await sleep(Number(this.wakePollMs) || CODEX_WAKE_POLL_MS);
      }

      if (!ready) {
        const alreadyExited = session.lastPtyExitGeneration === generation;
        const exitPromise = alreadyExited
          ? Promise.resolve({ exited: true, event: session.lastPtyExitEvent })
          : this.waitForPtyExit(processRef);
        if (!alreadyExited) {
          try { processRef.kill(); } catch {}
        }
        const exit = await exitPromise;
        if (!exit.exited || session.pty !== processRef || session.ptyGeneration !== generation) {
          session.runtimeState = 'wake_failed_live';
          session.wakeError = 'Wake failed and PTY cleanup could not be confirmed';
        } else {
          session.pty = null;
          session.runtimeState = 'auto_parked';
          session.status = 'paused';
          session.pauseReason = 'auto_park';
          session.wakeError = readiness.message || 'Exact session did not become ready before timeout';
        }
        this.clearCodexWindowsWakeAttempt(session, { clearToken: true, clearWarning: true });
        this.dataStore.saveSession(session);
        this.emit('sessionUpdated', this.getSessionSnapshot(session));
        return {
          ok: false,
          error: readiness.error || 'wake_timeout',
          session: this.getSessionSnapshot(session)
        };
      }

      session.runtimeState = 'live';
      session.pauseReason = null;
      session.parkedAt = null;
      session.wakeError = null;
      session.lastUserOrOrchestratorActivityAt = new Date().toISOString();
      if (readiness.mode === 'resume_verified') {
        session.codexIdentityState = 'resume_verified';
        session.codexIdentityVerifiedAt = new Date().toISOString();
        session.codexIdentityError = null;
        readiness.attempt.fallbackAt = Date.now();
        this.startCodexWakeCorroborationTimer(session, readiness.attempt);
      } else if (session.cliType === CODEX_WINDOWS) {
        this.clearCodexWindowsWakeAttempt(session, { clearToken: false });
      } else {
        session.expectedCodexWakeId = null;
      }
      this.dataStore.saveSession(session);
      this.emit('sessionUpdated', this.getSessionSnapshot(session));
      this.drainMessageQueue(session, { codexWindowsResume: session.cliType === CODEX_WINDOWS });
      return { ok: true, session: this.getSessionSnapshot(session) };
    })().finally(() => {
      if (lifecycleTransitions.get(id)?.promise === transition) lifecycleTransitions.delete(id);
    });
    lifecycleTransitions.set(id, { kind: 'waking', promise: transition });
    return transition;
  }

  retryTerminateSession(id) {
    const lifecycleTransitions = this.getLifecycleTransitions();
    const existingTransition = lifecycleTransitions.get(id);
    if (existingTransition?.kind === 'retry_kill') return existingTransition.promise;
    if (existingTransition) {
      return Promise.resolve({ ok: false, error: 'lifecycle_transition_in_progress' });
    }
    const transition = (async () => {
      const session = this.sessions.get(id);
      if (!session || !['parking_failed_live', 'wake_failed_live'].includes(session.runtimeState)) {
        return { ok: false, error: 'not_in_cleanup_limbo' };
      }
      const processRef = session.pty;
      const generation = session.ptyGeneration;
      if (processRef) {
        const alreadyExited = session.lastPtyExitGeneration === generation;
        const exitPromise = alreadyExited
          ? Promise.resolve({ exited: true })
          : this.waitForPtyExit(processRef);
        if (!alreadyExited) {
          try { processRef.kill(); } catch {}
        }
        const exit = await exitPromise;
        if (!exit.exited || session.pty !== processRef || session.ptyGeneration !== generation) {
          session.wakeError = 'PTY termination still could not be confirmed';
          this.emit('sessionUpdated', this.getSessionSnapshot(session));
          return { ok: false, error: 'kill_timeout', session: this.getSessionSnapshot(session) };
        }
      }
      session.pty = null;
      session.status = 'paused';
      session.runtimeState = 'auto_parked';
      session.pauseReason = 'auto_park';
      session.parkedAt = session.parkedAt || new Date().toISOString();
      session.wakeError = null;
      if (session.cliType === CODEX_WINDOWS) {
        this.clearCodexWindowsWakeAttempt(session, { clearToken: true });
      } else {
        session.expectedCodexWakeId = null;
      }
      try {
        this.dataStore.saveSession(session, { throwOnError: true });
      } catch (error) {
        session.runtimeState = 'paused';
        session.pauseReason = 'recovery_failed';
        session.wakeError = `PTY stopped, but cleanup state could not be saved: ${error.message}`;
        this.emit('sessionUpdated', this.getSessionSnapshot(session));
        return { ok: false, error: 'persistence_failed', session: this.getSessionSnapshot(session) };
      }
      session.outputBuffer.clear();
      const snapshot = this.getSessionSnapshot(session);
      this.emit('sessionUpdated', snapshot);
      return { ok: true, session: snapshot };
    })().finally(() => {
      if (lifecycleTransitions.get(id)?.promise === transition) lifecycleTransitions.delete(id);
    });
    lifecycleTransitions.set(id, { kind: 'retry_kill', promise: transition });
    return transition;
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
    if (this.getLifecycleTransitions().has(id)) return false;

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
    this.clearCodexSessionCapture(session);
    this.clearCodexStatusSampler(session);
    if (session.cliType === CODEX_WINDOWS) {
      this.clearCodexWindowsWakeAttempt(session, { clearToken: true });
    }

    // Kill the PTY process
    try {
      if (session.pty) {
        this._clearWriteQueue(session);
        session.pty.kill();
        session.pty = null;
      }
    } catch (error) {
      console.error(`Error killing PTY for session ${id}:`, error.message);
    }

    session.status = 'paused';
    session.runtimeState = 'paused';
    session.pauseReason = 'manual';
    session.parkedAt = null;
    session.idleEvidence = null;
    session.readySince = null;
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
   * @param {boolean} options.recovery - Safe startup recovery without role/startup automation or Claude fresh fallback
   * @returns {boolean} Success status
   */
  resumeSession(id, { fresh = false, recovery = false, lifecycleOwner = false } = {}) {
    const session = this.sessions.get(id);
    if (!session) {
      return false;
    }
    if (this.getLifecycleTransitions().has(id) && !lifecycleOwner) return false;

    if (session.status !== 'paused') {
      return false;
    }
    this.ensureParkingFields(session);
    if (session.pauseReason === 'auto_park' && !recovery) return false;

    const cliType = session.cliType || 'claude';
    session.recoveryError = null;
    if (cliType === CODEX_WINDOWS && session.runtimeState !== 'resuming') {
      this.clearCodexWindowsWakeAttempt(session, { clearToken: true });
    }
    if (!isCodexType(cliType)) {
      this.applyRepoContext(session);
    }
    if (isCodexType(cliType) && !fresh && !session.codexSessionId) {
      session.codexIdentityState = 'unresolved';
      session.codexIdentityError = 'Choose an exact Codex conversation before resuming';
      this.dataStore.saveSession(session);
      this.emit('sessionUpdated', this.getSessionSnapshot(session));
      return false;
    }
    let ptyProcess;
    let claudeFallbackAttempted = false;
    let suppressNextExit = false;
    let shouldResyncClaudeSession = false;
    let codexResumeTargetUsed = null;

    const createFreshClaudeProcess = ({ sessionId = null } = {}) => {
      return this.spawnClaudeProcess(session.workingDir, {
        sessionId,
        role: recovery ? '' : this.sanitizeRole(session.role || ''),
        easyccSessionId: session.id
      });
    };

    const handleClaudeResumeFallback = () => {
      if (cliType !== 'claude' || claudeFallbackAttempted) {
        return;
      }

      if (recovery) {
        claudeFallbackAttempted = true;
        session.status = 'paused';
        session.recoveryError = 'Saved Claude conversation could not be found';
        this._clearWriteQueue(session);
        if (session.pty) {
          try { session.pty.kill(); } catch { /* process may already be exiting */ }
        }
        session.pty = null;
        this.dataStore.saveSession(session);
        this.emit('sessionUpdated', this.getSessionSnapshot(session));
        this.emit('statusChange', {
          sessionId: id,
          status: 'paused',
          currentTask: session.currentTask,
          error: session.recoveryError,
          recoveryFailure: true
        });
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

    const wirePtyHandlers = (processRef) => {
      session.pty = processRef;
      session.ptyGeneration = (Number(session.ptyGeneration) || 0) + 1;
      session.lastPtyExitGeneration = null;
      session.lastPtyExitEvent = null;
      const ptyGeneration = session.ptyGeneration;

      processRef.onData((data) => {
        if (session.pty !== processRef || session.ptyGeneration !== ptyGeneration) return;
        session.outputBuffer.push(data);
        this.emit('output', { sessionId: id, data });
        this.appendToTranscript(id, data);
        if (shouldCountOutputAsActivity({
          data,
          isComposingPrompt: !!session.isComposingPrompt,
          lastSubmittedInputAtMs: session.lastSubmittedInputAtMs || 0,
          nowMs: Date.now()
        })) {
          session.lastActivity = new Date();
        }

        this.detectClaudeSessionId(data, session);
        if (cliType === 'claude' && /No conversation found with session ID/i.test(data)) {
          handleClaudeResumeFallback();
          return;
        }

        this.processSessionOutputState(session, data);
        this.observeCodexStatusSample(session, data);
        if (cliType === CODEX_WINDOWS) {
          this.observeCodexWakeStartupOutput(session, data, ptyGeneration);
        }

        const newName = this.extractSessionRename(data);
        if (newName && newName !== session.name) {
          session.name = newName;
          if (isCodexType(cliType)) session.codexThreadName = newName;
          this.dataStore.saveSession(session);
          this.emit('sessionUpdated', this.getSessionSnapshot(session));
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
        this.attachCodexPlansFromOutput(session, data);

      });

      processRef.onExit(({ exitCode, signal }) => {
        if (session.pty !== processRef || session.ptyGeneration !== ptyGeneration) return;
        const tokenEntry = this.codexWindowsHookTokens.get(id);
        if (cliType === CODEX_WINDOWS && tokenEntry?.generation === ptyGeneration) {
          this.codexWindowsHookTokens.delete(id);
        }
        session.lastPtyExitGeneration = ptyGeneration;
        session.lastPtyExitEvent = { exitCode, signal };
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
        if (['parking', 'parking_failed_live', 'resuming', 'wake_failed_live'].includes(session.runtimeState)) return;

        // If session just started and immediately exited with error, keep it paused (don't delete)
        // This preserves sessions that fail to resume (e.g., "Session ID already in use")
        const sessionAge = Date.now() - new Date(session.lastActivity).getTime();
        debugLog(`PTY onExit (resume) for session ${id}: exitCode=${exitCode}, signal=${signal}, sessionAge=${sessionAge}ms`);
        if (sessionAge < 10000 && (exitCode !== 0 || recovery)) {
          debugLog(`Session ${id} PAUSED due to early exit after resume (age=${sessionAge}ms, exitCode=${exitCode})`);
          session.status = 'paused';
          this._clearWriteQueue(session);
          session.pty = null;
          this.clearCodexStatusSampler(session);
          this.clearCodexSessionCapture(session);
          if (isCodexType(cliType)) {
            session.codexIdentityState = 'unresolved';
            session.codexIdentityError = 'Exact Codex resume failed';
          }
          if (recovery) {
            session.recoveryError = 'Session recovery exited before it was ready';
          }
          this.dataStore.saveSession(session);
          this.emit('statusChange', {
            sessionId: id,
            status: 'paused',
            currentTask: session.currentTask,
            error: session.recoveryError || 'Failed to resume session',
            recoveryFailure: recovery
          });
          return;
        }

        debugLog(`Session ${id} marked COMPLETED (exitCode=${exitCode}, signal=${signal})`);
        session.status = 'completed';
        const endedSnapshot = this.getSessionSnapshot(session);
        this.clearCodexStatusSampler(session);
        this.clearCodexSessionCapture(session);
        this.dataStore.deleteSession(id);
        this.deleteSessionTranscript(id);
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
      this.clearCodexStatusSampler(session);
      session.outputBuffer = new ByteRingBuffer(this.getOutputBufferSize(cliType));

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
      } else if (isCodexType(cliType)) {
        session.codexSessionId = null;
        session.codexThreadName = null;
        session.codexIdentityState = 'verifying';
        session.codexIdentityVerifiedAt = null;
        session.codexIdentityError = null;
      }
    }

    try {
      if (cliType === 'terminal') {
        ptyProcess = this.spawnTerminalProcess(session.workingDir, { easyccSessionId: session.id });
      } else if (cliType === 'wsl') {
        ptyProcess = this.spawnWslProcess(session.workingDir, { easyccSessionId: session.id });
      } else if (cliType === 'codex') {
        // Resume Codex in the same working directory to avoid cross-project jumps.
        session.codexLaunchStartedAt = new Date().toISOString();
        ptyProcess = this.spawnCodexProcess(session.workingDir, {
          resume: !fresh,
          resumeTarget: fresh ? null : this.selectCodexResumeTarget(session),
          easyccSessionId: session.id
        });
      } else if (cliType === CODEX_WINDOWS) {
        session.codexLaunchStartedAt = new Date().toISOString();
        codexResumeTargetUsed = fresh ? null : this.selectCodexResumeTarget(session);
        ptyProcess = this.spawnCodexWindowsProcess(session.workingDir, {
          resume: !fresh,
          resumeTarget: codexResumeTargetUsed,
          easyccSessionId: session.id
        });
      } else {
        if (fresh) {
          ptyProcess = createFreshClaudeProcess({ sessionId: session.claudeSessionId });
        } else {
          // Claude: resume existing session when possible, and append role for consistency.
          ptyProcess = this.spawnClaudeProcess(session.workingDir, {
            resumeId: session.claudeSessionId || null,
            role: recovery ? '' : this.sanitizeRole(session.role || ''),
            easyccSessionId: session.id
          });
        }
      }
    } catch (error) {
      console.error(`Failed to resume session ${id}:`, error.message);
      if (recovery) {
        session.recoveryError = error.message || 'Could not start session recovery';
        session.status = 'paused';
        session.pty = null;
        this.dataStore.saveSession(session);
        this.emit('sessionUpdated', this.getSessionSnapshot(session));
      }
      return false;
    }

    session.status = 'active';
    if (session.runtimeState !== 'resuming') {
      session.runtimeState = 'live';
      session.pauseReason = null;
      session.parkedAt = null;
    }
    session.lastActivity = new Date();
    session.statusDetectionContext = '';
    if (isCodexType(cliType) && !session.codexLaunchStartedAt) {
      session.codexLaunchStartedAt = new Date().toISOString();
    }
    if (isCodexType(cliType)) {
      session.codexIdentityState = 'verifying';
      session.codexIdentityError = null;
    }

    // Re-setup PTY handlers
    wirePtyHandlers(ptyProcess);
    if (cliType === CODEX_WINDOWS) {
      this.bindCodexWindowsLaunch(session, codexResumeTargetUsed);
    }
    if (!recovery) {
      this.setupRoleInjectionWorkflow(session, 'resume');
    } else {
      this.clearRoleInjectionWorkflow(session);
      session.startupSequence = null;
    }

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
    if (cliType === 'codex') this.codexSessionService.kickMonitor();

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
    if (meta.cliType !== undefined && ['claude', 'codex', 'codex-windows', 'terminal', 'wsl'].includes(meta.cliType)) {
      session.cliType = meta.cliType;
      this.applyRepoContext(session);
    }
    if (meta.priority !== undefined) session.priority = meta.priority;
    if (meta.description !== undefined) session.description = meta.description;
    if (meta.isOrchestrator !== undefined) session.isOrchestrator = !!meta.isOrchestrator;
    if (meta.parentSessionId !== undefined) session.parentSessionId = meta.parentSessionId || null;
    if (meta.teamInstanceId !== undefined) session.teamInstanceId = meta.teamInstanceId || null;

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
    return !isCodexType(session?.cliType || 'claude');
  }

  /**
   * Detect session status from terminal output
   * @param {string} data - Terminal output data
   * @param {string} currentStatus - Current session status
   * @param {string} cliType - CLI type ('claude', 'codex', 'terminal')
   * @param {string|null} contextData - Bounded recent cleaned output
   * @param {string|null} pendingStatus - Debounced transition not yet committed
   * @returns {string} Detected status
   */
  detectStatus(data, currentStatus, cliType = 'claude', contextData = null, pendingStatus = null) {
    // Don't change status if paused
    if (currentStatus === 'paused') {
      return 'paused';
    }

    // Strip ANSI escape sequences for pattern matching
    const cleanText = (value) => String(value || '')
      .replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, '')
      .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
      .replace(/\r/g, '\n');
    const cleanData = cleanText(data);
    const contextText = typeof contextData === 'string' && contextData.length > 0
      ? cleanText(contextData)
      : cleanData;
    const stripped = cleanData.trim();

    const hasCodexActionRequiredTitle = (value) =>
      /\x1b\](?:0|2);[^\x07\x1b]*Action Required[^\x07\x1b]*(?:\x07|\x1b\\)/i.test(String(value || ''));

    const codexPromptReadyPatterns = [
      /Ask Codex to do anything/i,
      /^\s*›(?:\s*$|\s+(?!\d+\.)\S.*$)/m,
      /\?\s*for shortcuts/i
    ];

    const waitingPatterns = [
      /^\s*>\s*$/m,
      /\?\s*$/,
      /Enter.*:/i,
      /Press.*to continue/i,
      /\[Y\/n\]/i,
      /\[y\/N\]/i,
      // Codex CLI patterns
      /Would you like to run/i,
      /Implement this plan\?/i,
      /^\s*›\s*\d+\./m,
      // Claude multi-choice prompts
      /^\s*>\s*\d+\./m,
      /Would you like to proceed/i,
      /Type .* to (change|tell)/i
    ];

    const codexPriorityWaitingPatterns = [
      /Would you like to run/i,
      /Implement this plan\?/i,
      /^\s*›\s*\d+\./m,
      /\[Y\/n\]/i,
      /\[y\/N\]/i,
      /Would you like to proceed/i
    ];

    const codexQuestionnairePatterns = [
      /Question\s+\d+\s*\/\s*\d+\s*\(\s*\d+\s+unanswered\s*\)/i,
      /enter to submit answer/i,
      /navigate questions/i
    ];

    const thinkingPatterns = [
      // Claude Code patterns
      /Thinking/i,
      /Processing/i,
      /\u2726/,
      /Scampering/i,
      /Pondering/i,
      /Reasoning/i,
      /Contemplating/i,
      /Analyzing/i,
      /Researching/i,
      /Investigating/i,
      /Examining/i,
      /Considering/i,
      /\(thought for \d+/i,
      /[\u2800-\u28FF]/,
      /[\u2721-\u2749]/,
      /\b[A-Z][a-z]+ing\s*\.{3}/,
      /\b[A-Z][a-z]+ing\s*\u2026/,
      // Codex CLI patterns
      /\u2022\s*Working\s*\(/,
      /esc to interrupt/i,
      /\u2022\s*\w+ing\s.*\(\d+s/
    ];

    const editingPatterns = [
      // Claude Code tool-call patterns
      /Write\(.+\)/,
      /Edit\(.+\)/,
      /MultiEdit\(.+\)/,
      /Creating file/i,
      // Codex CLI patterns
      /\u2022\s*Edited/i,
      /\u2022\s*Added/i,
      /\u2022\s*Deleted/i,
      /\u2714.*approved.*to run/i
    ];

    if (isCodexType(cliType)) {
      const hasReadyPrompt = codexPromptReadyPatterns.some((pattern) => pattern.test(cleanData));
      const hasActionRequiredTitle = hasCodexActionRequiredTitle(data);
      const hasQuestionnairePrompt = codexQuestionnairePatterns.some((pattern) => pattern.test(cleanData));
      const activityData = cleanData
        .split('\n')
        .filter((line) => !codexPromptReadyPatterns.some((pattern) => pattern.test(line)))
        .join('\n');

      for (const pattern of codexPriorityWaitingPatterns) {
        if (pattern.test(cleanData)) {
          return 'waiting';
        }
      }

      if (hasQuestionnairePrompt) {
        return 'waiting';
      }

      for (const pattern of editingPatterns) {
        if (pattern.test(activityData)) {
          return 'editing';
        }
      }

      const hasSpecificWorkingSignal = thinkingPatterns.some((pattern) =>
        pattern.source !== 'esc to interrupt' && pattern.test(activityData)
      );

      if (hasSpecificWorkingSignal) {
        return 'thinking';
      }

      if (hasActionRequiredTitle) {
        return 'waiting';
      }

      for (const pattern of thinkingPatterns) {
        if (pattern.test(activityData)) {
          return 'thinking';
        }
      }

      if (hasReadyPrompt) {
        return 'idle';
      }

      for (const pattern of waitingPatterns) {
        if (pattern.test(cleanData)) {
          return 'waiting';
        }
      }

      for (const pattern of codexPriorityWaitingPatterns) {
        if (pattern.test(contextText)) {
          return 'waiting';
        }
      }

      if (
        (currentStatus === 'idle' || pendingStatus === 'idle') &&
        isCodexPassiveReadyRedraw(data) &&
        codexPromptReadyPatterns.some(pattern => pattern.test(contextText))
      ) {
        return 'idle';
      }
    }

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

    // Claude Code "Baked for Xs" is an idle indicator, not thinking.
    // Must be checked before thinking patterns because the line contains
    // dingbat chars (e.g. ✱) that would otherwise match thinking spinners.
    if (/Baked for \d+/i.test(stripped)) {
      return 'idle';
    }

    if (!isCodexType(cliType)) {
      for (const pattern of thinkingPatterns) {
        if (pattern.test(cleanData)) {
          return 'thinking';
        }
      }

      // Detect editing patterns (must match actual tool-call output, not generic words)
      for (const pattern of editingPatterns) {
        if (pattern.test(cleanData)) {
          return 'editing';
        }
      }
    }

    // Detect waiting for input. Use the short rolling context window so Codex
    // menu redraws split across PTY chunks still count as waiting.
    if (!isCodexType(cliType)) {
      for (const pattern of waitingPatterns) {
        if (pattern.test(contextText)) {
          return 'waiting';
        }
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
    // Look for concrete plan file activity. Avoid generic plan-mode chatter;
    // the sidebar only needs a refresh when a plan was likely written/updated.
    const planPatterns = [
      /Updated plan/i,
      /plan.*updated/i,
      /Created.*plan/i,
      /wrote.*plan.*\.md/i,
      /Saved.*plan/i,
      /plan.*saved/i,
      /\.claude[/\\]plans[/\\].*\.md/i,
      /\.codex[/\\]plans[/\\].*\.md/i
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
   * Cancel a debounced status transition atomically.
   * @param {object} session
   */
  cancelPendingStatusTransition(session) {
    if (!session) return;
    if (session.statusDebounceTimer) {
      clearTimeout(session.statusDebounceTimer);
      session.statusDebounceTimer = null;
    }
    session.pendingStatus = null;
  }

  /**
   * Mark a submitted prompt/command as new work before writing it to the PTY.
   * @param {object} session
   * @param {object} options
   * @param {string} options.source
   */
  markSemanticSubmission(session, { source = 'input' } = {}) {
    if (!session) return;

    this.cancelPendingStatusTransition(session);
    this.clearCodexStatusSampler?.(session);
    session.statusDetectionContext = '';
    session.lastSubmittedInputAtMs = Date.now();
    session.lastUserOrOrchestratorActivityAt = new Date().toISOString();
    session.isComposingPrompt = false;
    session.interactionPending = false;
    session.interactionPendingSource = null;
    session.idleEvidence = null;
    session.readySince = null;
    session.parkingProposalState = 'none';
    session.parkingProposalReason = null;
    session.parkingDetectedAt = null;

    if (
      session.status !== 'paused' &&
      session.status !== 'completed' &&
      (
        session.status === 'idle' ||
        session.status === 'waiting' ||
        session.status === 'thinking' ||
        session.stage === 'in_review'
      )
    ) {
      session.status = 'active';
      this.emit('statusChange', {
        sessionId: session.id,
        status: 'active',
        currentTask: session.currentTask,
        source
      });
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
      this.cancelPendingStatusTransition(session);
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

        // Drain message queue when session becomes ready for orchestrator input
        if (this.canAcceptOrchestratorInput(session)) {
          this.drainMessageQueue(session);
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
    session.inEscapeSeq = false;
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
    if (this.getLifecycleTransitions().has(id)) return false;

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
    this.clearCodexSessionCapture(session);
    this.clearCodexStatusSampler(session);
    if (session.cliType === CODEX_WINDOWS) {
      this.clearCodexWindowsWakeAttempt(session, { clearToken: true });
    }

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
    this.deleteSessionTranscript(id);

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
  applyHookStatus({
    cwd,
    claudeSessionId,
    status,
    hookEvent,
    notificationType = null,
    toolName = null
  }) {
    // Find session: prefer exact claudeSessionId match, fall back to workingDir
    // Fallback only matches sessions with a running PTY to avoid cross-contamination
    let session = claudeSessionId
      ? [...this.sessions.values()].find(s => s.claudeSessionId === claudeSessionId)
      : null;
    if (hookEvent === 'SessionStart' && !session) return;
    if (!session) {
      session = [...this.sessions.values()].find(
        s => s.workingDir === cwd && s.cliType === 'claude' && s.status !== 'paused' && s.pty
      );
    }
    if (!session) return;

    const prev = session.status;

    if (hookEvent === 'SessionStart') {
      if (session.runtimeState === 'resuming' && session.claudeSessionId === claudeSessionId) {
        session.claudeResumeVerified = true;
        this.emit('sessionUpdated', this.getSessionSnapshot(session));
      }
      return;
    }

    if (hookEvent === 'Stop') {
      // Claude finished or waiting for user input (e.g. AskUserQuestion) — force idle
      if (session.idleTimer) {
        clearInterval(session.idleTimer);
        session.idleTimer = null;
      }
      session.lastActivity = new Date();
      if (session.interactionPending) {
        session.status = 'waiting';
        session.idleEvidence = null;
        session.readySince = null;
      } else {
        session.status = 'idle';
        session.idleEvidence = 'claude_stop_hook';
        session.readySince = new Date().toISOString();
      }
    } else if (hookEvent === 'Notification') {
      session.status = 'waiting';
      session.interactionPending = true;
      session.interactionPendingSource = 'claude_notification';
      session.interactionPendingKind = notificationType || 'unknown';
      session.idleEvidence = null;
      session.readySince = null;
    } else if (hookEvent === 'UserPromptSubmit') {
      session.status = 'active';
      session.lastActivity = new Date();
      session.lastUserOrOrchestratorActivityAt = new Date().toISOString();
      session.interactionPending = false;
      session.interactionPendingSource = null;
      session.interactionPendingKind = null;
      session.idleEvidence = null;
      session.readySince = null;
    } else if (hookEvent === 'PreToolUse') {
      session.lastActivity = new Date();
      if (toolName === 'AskUserQuestion') {
        session.interactionPending = true;
        session.interactionPendingSource = 'claude_tool';
        session.interactionPendingKind = 'elicitation_dialog';
      } else if (session.interactionPendingSource === 'claude_notification' &&
          session.interactionPendingKind === 'permission_prompt') {
        session.interactionPending = false;
        session.interactionPendingSource = null;
        session.interactionPendingKind = null;
      }
      session.status = session.interactionPending ? 'waiting' : 'editing';
      session.idleEvidence = null;
      session.readySince = null;
    }

    if (session.status !== prev) {
      this.dataStore.saveSession(session);
      this.emit('statusChange', {
        sessionId: session.id,
        status: session.status,
        source: 'hook',
      });
      this.emit('sessionUpdated', this.getSessionSnapshot(session));
      // Restart idle detection after non-Stop events
      if (hookEvent !== 'Stop') this.startIdleDetection(session);
    } else {
      this.dataStore.saveSession(session);
      this.emit('sessionUpdated', this.getSessionSnapshot(session));
    }
  }

  /**
   * Write text to PTY in chunks to avoid OS input buffer overflow.
   * Uses a per-session queue to prevent interleaving from concurrent sendInput() calls.
   */
  _writeToPty(session, text) {
    const CHUNK_BYTE_LIMIT = 1024;

    if (session._writeDraining) {
      if (!session._writeQueue) session._writeQueue = [];
      this._splitAndEnqueue(session, text, CHUNK_BYTE_LIMIT);
      return;
    }

    if (Buffer.byteLength(text, 'utf8') <= CHUNK_BYTE_LIMIT) {
      if (session.pty) session.pty.write(text);
      return;
    }

    if (!session._writeQueue) session._writeQueue = [];
    this._splitAndEnqueue(session, text, CHUNK_BYTE_LIMIT);
    this._drainWriteQueue(session);
  }

  /**
   * Codex on Windows treats text and a trailing carriage return received in
   * one ConPTY write as pasted text during some resume redraws. Keep Enter as
   * a distinct keystroke, matching xterm.js and the immediate API-send path.
   * Scope the delayed keypress to the current PTY generation so it can never
   * reach a replacement process.
   */
  _writeInputToPty(session, text, { submitDelayMs = 0, onSubmitted = null } = {}) {
    if (session.cliType !== CODEX_WINDOWS || submitDelayMs <= 0 ||
        text.length <= 1 || !text.endsWith('\r')) {
      this._writeToPty(session, text);
      onSubmitted?.(true);
      return;
    }

    const body = text.slice(0, -1);
    const processRef = session.pty;
    const generation = session.ptyGeneration;
    this._writeToPty(session, body);

    const scheduleTimeout = this.setTimeoutFn || setTimeout;
    const submitEnter = () => {
      const registeredSession = this.sessions?.get?.(session.id);
      if ((registeredSession && registeredSession !== session) ||
          (this.sessions?.has && !this.sessions.has(session.id)) ||
          session.pty !== processRef || session.ptyGeneration !== generation ||
          ['killed', 'completed', 'paused'].includes(session.status) ||
          (session.runtimeState && session.runtimeState !== 'live')) {
        onSubmitted?.(false);
        return;
      }
      if (session._writeDraining) {
        scheduleTimeout(submitEnter, 10);
        return;
      }
      try {
        this._writeToPty(session, '\r');
        onSubmitted?.(true);
      } catch {
        onSubmitted?.(false);
      }
    };
    scheduleTimeout(submitEnter, submitDelayMs);
  }

  _splitAndEnqueue(session, text, byteCap) {
    let pos = 0;
    while (pos < text.length) {
      let end = pos;
      let bytes = 0;
      while (end < text.length) {
        const cp = text.codePointAt(end);
        const charLen = cp > 0xFFFF ? 2 : 1;
        const charBytes = cp <= 0x7F ? 1 : cp <= 0x7FF ? 2 : cp <= 0xFFFF ? 3 : 4;
        if (bytes + charBytes > byteCap && end > pos) break;
        bytes += charBytes;
        end += charLen;
      }

      // Guard: never split escape sequences across chunks.
      // Bracket paste sequences (\x1b[200~ / \x1b[201~) split across delayed
      // writes cause the CLI to interpret a lone \x1b as Escape, hanging paste mode.
      if (end < text.length && end > pos) {
        let adjusted = end;

        // Rule 1: never end a chunk on bare \x1b
        if (text.charCodeAt(adjusted - 1) === 0x1b) {
          adjusted--;
        }

        // Rule 2: protect CSI sequences (especially bracket paste wrappers)
        // Check if any ESC within the last 6 chars starts a sequence past adjusted
        if (adjusted > pos) {
          for (let scan = Math.max(pos, adjusted - 5); scan < adjusted; scan++) {
            if (text.charCodeAt(scan) === 0x1b) {
              const remaining = text.length - scan;
              if (remaining >= 2 && text.charCodeAt(scan + 1) === 0x5b) { // '['
                let seqEnd = scan + 2;
                while (seqEnd < text.length &&
                       text.charCodeAt(seqEnd) >= 0x20 &&
                       text.charCodeAt(seqEnd) <= 0x3f) {
                  seqEnd++; // parameter bytes
                }
                if (seqEnd < text.length) seqEnd++; // final byte (~ for bracket paste)
                if (seqEnd > adjusted) {
                  adjusted = scan;
                  break;
                }
              } else {
                // Non-CSI escape — pull back to before ESC
                adjusted = scan;
                break;
              }
            }
          }
        }

        // If pullback collapsed to pos, ESC starts at chunk start.
        // Extend forward to include the full sequence instead of splitting it.
        if (adjusted <= pos) {
          if (text.charCodeAt(pos) === 0x1b) {
            let seqEnd = pos + 1;
            if (seqEnd < text.length && text.charCodeAt(seqEnd) === 0x5b) {
              seqEnd++;
              while (seqEnd < text.length &&
                     text.charCodeAt(seqEnd) >= 0x20 &&
                     text.charCodeAt(seqEnd) <= 0x3f) {
                seqEnd++;
              }
              if (seqEnd < text.length) seqEnd++; // final byte
            }
            end = Math.max(end, seqEnd);
          }
        } else {
          end = adjusted;
        }
      }

      session._writeQueue.push(text.slice(pos, end));
      pos = end;
    }
  }

  _drainWriteQueue(session) {
    if (!session._writeQueue?.length) {
      session._writeDraining = false;
      return;
    }
    session._writeDraining = true;
    const chunk = session._writeQueue.shift();
    // [paste-debug] Temporary logging — remove after verifying paste fix
    if (chunk.includes('\x1b')) {
      const hexTail = Buffer.from(chunk.slice(-10)).toString('hex');
      const hexHead = Buffer.from(chunk.slice(0, 10)).toString('hex');
      console.log(`[paste-debug] chunk len=${chunk.length}, head=${hexHead}, tail=${hexTail}, remaining=${session._writeQueue.length}`);
    }
    if (session.pty) {
      session.pty.write(chunk);
    } else {
      session._writeQueue = [];
      session._writeDraining = false;
      return;
    }
    session._drainTimer = setTimeout(() => {
      this._drainWriteQueue(session);
    }, 5);
  }

  _clearWriteQueue(session) {
    if (session._drainTimer) {
      clearTimeout(session._drainTimer);
      session._drainTimer = null;
    }
    session._writeQueue = [];
    session._writeDraining = false;
  }

  /**
   * Send input to a session
   * @param {string} id - Session ID
   * @param {string} text - Text to send
   * @param {object} options
   * @param {'soft_newline'|null} options.inputIntent - Validated terminal input intent
   * @returns {boolean} Success status
   */
  sendInput(id, text, {
    codexWindowsSubmitDelayMs = 0,
    onCodexWindowsSubmitted = null,
    inputIntent = null
  } = {}) {
    const session = this.sessions.get(id);
    if (!session || session.status === 'completed' || session.status === 'paused' ||
        (session.runtimeState && session.runtimeState !== 'live')) {
      return false;
    }

    try {
      // Filter out focus reporting sequences that xterm.js may send
      // These can interfere with Claude CLI
      const filteredText = text.replace(/\x1b\[[IO]/g, '');
      if (!filteredText) {
        return true; // Nothing left to send after filtering
      }

      const isCodexWindowsSoftNewline =
        session.cliType === CODEX_WINDOWS &&
        inputIntent === 'soft_newline' &&
        filteredText === '\n';
      if (isCodexWindowsSoftNewline) {
        this._writeInputToPty(session, filteredText);
        this.clearPromptFlushTimer(session);
        session.promptBuffer += '\n';
        session.isComposingPrompt = true;
        return true;
      }

      const isSubmittedInput = hasSubmittedInput(filteredText);
      if (isSubmittedInput) {
        this.markSemanticSubmission(session, { source: 'input' });

        // Resume auto-sync when user submits input (unless explicitly locked)
        if (session.manuallyPlaced && !session.placementLocked) {
          session.manuallyPlaced = false;
          session.manualPlacedAt = null;
        }
      }
      this._writeInputToPty(session, filteredText, {
        submitDelayMs: codexWindowsSubmitDelayMs,
        onSubmitted: onCodexWindowsSubmitted
      });

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
        // Reset escape sequence state at the start of each new input event.
        // xterm.js sends complete sequences in a single onData call, so a stale
        // inEscapeSeq=true from a previous call means that call had a bare \x1b
        // (e.g. Escape key press) that should not bleed into this call.
        session.inEscapeSeq = false;
        for (const char of filteredText) {
          const code = char.charCodeAt(0);

          // Detect start of escape sequence (ESC = 0x1b)
          if (code === 0x1b) {
            session.inEscapeSeq = true;
            continue;
          }

          // If in escape sequence, wait for terminating character.
          // Full VT100 CSI final-byte range is 0x40-0x7E (@-~).
          if (session.inEscapeSeq) {
            if (code >= 0x40 && code <= 0x7E) {
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
      this.clearCodexStatusSampler(session);
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
   * Get a bounded recent output tail for lightweight status/stage decisions.
   * @param {string} id - Session ID
   * @param {object} options
   * @param {number} options.maxChunks - Maximum recent buffer chunks to inspect
   * @param {number} options.maxChars - Maximum characters to return
   * @returns {string}
   */
  getRecentSessionOutputText(id, { maxChunks = 80, maxChars = 20000 } = {}) {
    const session = this.sessions.get(id);
    if (!session?.outputBuffer?.getAll) {
      return '';
    }

    const chunks = session.outputBuffer.getAll();
    if (chunks.length === 0) {
      return '';
    }

    const boundedChunks = chunks.slice(-Math.max(1, maxChunks));
    const text = boundedChunks.map(chunk => String(chunk || '')).join('');
    return text.length > maxChars ? text.slice(-maxChars) : text;
  }

  getSessionTranscript(id, options = {}) {
    const session = this.sessions.get(id);
    if (!session) {
      return null;
    }

    const output = session.outputBuffer.getAll();
    const liveReplayBytes = prepareTerminalReplayPayload(output).replayBytes;

    return readTranscriptWindow(this.getTranscriptPath(id), {
      beforeBytes: options.beforeBytes,
      limitBytes: options.limitBytes,
      liveReplayBytes
    });
  }

  /**
   * Create a safe serializable snapshot of a session
   * @param {object} session - Session object
   * @returns {object} Session snapshot (without PTY reference)
   */
  getSessionSnapshot(session) {
    this.ensureParkingFields(session);
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
      repoRoot: session.repoRoot || null,
      repoName: session.repoName || null,
      gitBranch: session.gitBranch || null,
      groupKey: session.groupKey || this.normalizeGroupPath(session.workingDir),
      cliType: session.cliType || 'claude',
      claudeSessionId: session.claudeSessionId || null,
      previousClaudeSessionIds: session.previousClaudeSessionIds || [],
      claudeSessionName: session.claudeSessionName || null,
      codexSessionId: session.codexSessionId || null,
      codexThreadName: session.codexThreadName || null,
      codexLaunchStartedAt: session.codexLaunchStartedAt || null,
      codexIdentityState: session.codexIdentityState || null,
      codexIdentityVerifiedAt: session.codexIdentityVerifiedAt || null,
      codexIdentityError: session.codexIdentityError || null,
      recoveryError: session.recoveryError || null,
      runtimeState: session.runtimeState,
      pauseReason: session.pauseReason || null,
      parkedAt: session.parkedAt || null,
      keepAwake: !!session.keepAwake,
      interactionPending: !!session.interactionPending,
      idleEvidence: session.idleEvidence || null,
      readySince: session.readySince || null,
      wakeError: session.wakeError || null,
      wakeWarning: session.wakeWarning || null,
      parkingProposalState: session.parkingProposalState || 'none',
      parkingProposalReason: session.parkingProposalReason || null,
      parkingDetectedAt: session.parkingDetectedAt || null,
      parkingSnoozedUntil: session.parkingSnoozedUntil || null,
      lastUserOrOrchestratorActivityAt: session.lastUserOrOrchestratorActivityAt || null,
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
      comments: session.comments || [],
      // Message queue
      queuedMessages: (session.messageQueue || []).filter(m => m.status === 'queued').length,
      // Orchestrator fields
      isOrchestrator: session.isOrchestrator || false,
      parentSessionId: session.parentSessionId || null,
      teamInstanceId: session.teamInstanceId || null,
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

      const seen = new Set();
      const plans = [];

      const addPlan = (planRef, { filterWorkingDir = false } = {}) => {
        const plan = this.planManager.getPlanContent(planRef);
        if (plan) {
          if (filterWorkingDir && !this.planMatchesSessionWorkingDir(session, planRef, plan)) {
            return;
          }
          const key = plan.path || plan.filename;
          if (!seen.has(key)) {
            seen.add(key);
            plans.push(plan);
          }
        }
      };

      for (const planRef of trackedPlanPaths) {
        addPlan(planRef, { filterWorkingDir: true });
      }

      for (const planRef of (session.plans || [])) {
        addPlan(planRef);
      }

      // Sort by modified time (newest first)
      plans.sort((a, b) => new Date(b.modifiedAt) - new Date(a.modifiedAt));
      return plans;
    }

    if (isCodexType(session.cliType) || session.cliType === 'wsl') {
      this.backfillCodexPlansForSession(session);
      const trackedPlanPaths = session.codexSessionId
        ? this.getPlansForCodexSession(session.codexSessionId, session.cliType)
        : [];
      const seen = new Set();
      const plans = [];

      const addPlan = (planRef, { filterWorkingDir = false } = {}) => {
        const plan = this.planManager.getPlanContent(planRef);
        if (plan) {
          if (filterWorkingDir && !this.planMatchesSessionWorkingDir(session, planRef, plan)) {
            return;
          }
          const key = plan.path || plan.filename;
          if (!seen.has(key)) {
            seen.add(key);
            plans.push(plan);
          }
        }
      };

      for (const planRef of trackedPlanPaths) {
        addPlan(planRef, { filterWorkingDir: true });
      }

      for (const planRef of (session.plans || [])) {
        addPlan(planRef);
      }

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
  // ============================================
  // Message Queue Methods
  // ============================================

  /**
   * Check if a session can accept orchestrator input right now.
   * Direct terminal typing bypasses this — it always goes via sendInput().
   */
  canAcceptOrchestratorInput(session) {
    if (!session || !session.pty) return false;
    if (session.runtimeState && session.runtimeState !== 'live') return false;
    if (session.status === 'completed' || session.status === 'paused') return false;
    if (session.startupSequence?.active) return false;
    if (session._writeDraining) return false;
    return ['idle', 'waiting'].includes(session.status);
  }

  /**
   * Send input directly or enqueue if session is busy.
   * Only for orchestrator/API sends — NOT for direct terminal typing.
   * @returns {{ sent: boolean, queued: boolean, messageId?: string, queuePosition?: number }}
   */
  sendOrEnqueue(id, text, { fromSessionId = null } = {}) {
    const session = this.sessions.get(id);
    if (!session) return { sent: false, queued: false, error: 'session_not_found' };
    if (session.status === 'completed') return { sent: false, queued: false, error: 'session_completed' };

    this.ensureParkingFields(session);
    if (['parking', 'auto_parked', 'resuming'].includes(session.runtimeState)) {
      const queued = this.enqueueMessage(id, text, fromSessionId);
      if (queued.queued && session.runtimeState === 'auto_parked') {
        void this.wakeSession(id);
        return { ...queued, waking: true };
      }
      return queued;
    }

    if (this.canAcceptOrchestratorInput(session)) {
      const result = this.sendInput(id, text);
      return { sent: result, queued: false };
    }

    // Session is busy — enqueue
    return this.enqueueMessage(id, text, fromSessionId);
  }

  /**
   * Add a message to the session's queue.
   * @returns {{ sent: false, queued: boolean, messageId?: string, queuePosition?: number, error?: string }}
   */
  enqueueMessage(id, text, fromSessionId = null) {
    const session = this.sessions.get(id);
    if (!session) return { sent: false, queued: false, error: 'session_not_found' };

    const queuedCount = (session.messageQueue || []).filter(m => m.status === 'queued').length;
    if (queuedCount >= MAX_MESSAGE_QUEUE_SIZE) {
      return { sent: false, queued: false, error: 'queue_full', maxSize: MAX_MESSAGE_QUEUE_SIZE };
    }

    const msg = {
      id: uuidv4().slice(0, 8),
      text,
      fromSessionId: fromSessionId || null,
      queuedAt: new Date().toISOString(),
      status: 'queued'
    };

    if (!session.messageQueue) session.messageQueue = [];
    session.messageQueue.push(msg);
    session.updatedAt = new Date().toISOString();
    this.dataStore.saveSession(session);
    this.emit('sessionUpdated', this.getSessionSnapshot(session));
    debugLog(`Queued message ${msg.id} for session ${id} (queue size: ${queuedCount + 1})`);

    return { sent: false, queued: true, messageId: msg.id, queuePosition: queuedCount + 1 };
  }

  /**
   * Drain queued messages while session is ready.
   * Loops to deliver consecutive messages (e.g. text + Enter) atomically.
   * Once a message with \r is sent, sendInput transitions status to 'active'
   * on the next event loop tick, so canAcceptOrchestratorInput breaks the loop.
   */
  drainMessageQueue(session, { codexWindowsResume = false } = {}) {
    if (!session || session._queueDraining) return;
    if (!session.messageQueue?.length) return;
    if (!this.canAcceptOrchestratorInput(session)) return;

    session._queueDraining = true;

    try {
      this._sweepExpiredQueueMessages(session);

      while (true) {
        const idx = session.messageQueue.findIndex(m => m.status === 'queued');
        if (idx === -1) break;
        if (!this.canAcceptOrchestratorInput(session)) break;

        const msg = session.messageQueue[idx];
        const delayedResumeSubmit = codexWindowsResume && session.cliType === CODEX_WINDOWS &&
          msg.text.length > 1 && msg.text.endsWith('\r');
        if (delayedResumeSubmit) msg.status = 'delivering';
        const result = this.sendInput(session.id, msg.text, {
          codexWindowsSubmitDelayMs: delayedResumeSubmit ? CODEX_WINDOWS_SUBMIT_DELAY_MS : 0,
          onCodexWindowsSubmitted: delayedResumeSubmit
            ? delivered => this.finishDelayedQueueDelivery(session, msg, delivered)
            : null
        });

        if (result && delayedResumeSubmit) {
          debugLog(`Queued message ${msg.id} is awaiting its resume Enter keypress for session ${session.id}`);
          break;
        } else if (result) {
          msg.status = 'delivered';
          msg.deliveredAt = new Date().toISOString();
          session.messageQueue.splice(idx, 1);
          debugLog(`Delivered queued message ${msg.id} to session ${session.id}`);
        } else {
          if (delayedResumeSubmit) msg.status = 'queued';
          debugLog(`Failed to deliver queued message ${msg.id} to session ${session.id} — re-queued`);
          break;
        }
      }

      session.updatedAt = new Date().toISOString();
      this.dataStore.saveSession(session);
      this.emit('sessionUpdated', this.getSessionSnapshot(session));
    } finally {
      session._queueDraining = false;
    }
  }

  finishDelayedQueueDelivery(session, msg, delivered) {
    if (this.sessions?.get && this.sessions.get(session.id) !== session) return;
    if (!session?.messageQueue || msg.status !== 'delivering') return;
    const idx = session.messageQueue.indexOf(msg);
    if (idx === -1) return;
    if (delivered) {
      msg.status = 'delivered';
      msg.deliveredAt = new Date().toISOString();
      session.messageQueue.splice(idx, 1);
      debugLog(`Delivered queued message ${msg.id} to session ${session.id}`);
    } else {
      msg.status = 'queued';
      delete msg.deliveredAt;
      debugLog(`Resume Enter keypress was cancelled for queued message ${msg.id}; message re-queued`);
    }
    session.updatedAt = new Date().toISOString();
    this.dataStore.saveSession(session);
    this.emit('sessionUpdated', this.getSessionSnapshot(session));
  }

  /**
   * Sweep expired messages from a session's queue.
   */
  _sweepExpiredQueueMessages(session) {
    if (!session.messageQueue?.length) return;

    const now = Date.now();
    let changed = false;

    session.messageQueue = session.messageQueue.filter(msg => {
      if (msg.status === 'delivering') return true;
      if (msg.status !== 'queued') return false; // Remove delivered/expired
      const age = now - new Date(msg.queuedAt).getTime();
      if (age > MESSAGE_QUEUE_EXPIRY_MS) {
        debugLog(`Expired queued message ${msg.id} for session ${session.id} (age: ${Math.round(age / 1000)}s)`);
        changed = true;
        return false;
      }
      return true;
    });

    if (changed) {
      this.emit('sessionUpdated', this.getSessionSnapshot(session));
    }
  }

  /**
   * Get the message queue for a session.
   * @returns {Array|null} Queue array or null if session not found
   */
  getMessageQueue(id) {
    const session = this.sessions.get(id);
    if (!session) return null;
    return (session.messageQueue || []).filter(m => m.status === 'queued');
  }

  /**
   * Clear all queued messages for a session.
   * @returns {boolean} Success
   */
  clearMessageQueue(id) {
    const session = this.sessions.get(id);
    if (!session) return false;

    const hadMessages = (session.messageQueue || []).some(m => m.status === 'queued');
    session.messageQueue = [];
    session.updatedAt = new Date().toISOString();
    this.dataStore.saveSession(session);
    if (hadMessages) {
      this.emit('sessionUpdated', this.getSessionSnapshot(session));
    }
    return true;
  }

  addComment(sessionId, textOrOpts, author = 'user') {
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error(`Session not found: ${sessionId}`);

    // Support both old (text, author) and new ({ text, author, parentId, mentions }) signatures
    const opts = typeof textOrOpts === 'string'
      ? { text: textOrOpts, author }
      : { author, ...textOrOpts };

    const comment = createComment(opts);

    session.comments.push(comment);
    session.updatedAt = new Date().toISOString();
    this.dataStore.saveSession(session);
    this.emit('sessionUpdated', this.getSessionSnapshot(session));

    return comment;
  }

  /**
   * Toggle a reaction on a session comment.
   * @returns {object|null} Updated comment or null
   */
  addReaction(sessionId, commentId, emoji, author = 'user') {
    const session = this.sessions.get(sessionId);
    if (!session) return null;

    const comment = (session.comments || []).find(c => c.id === commentId);
    if (!comment) return null;

    addReactionToComment(comment, emoji, author);
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
    this.codexSessionService.stopMonitor();

    for (const [id, session] of this.sessions) {
      if (session.status === 'killed') {
        continue;
      }
      this.clearRoleInjectionWorkflow(session);
      this.clearCodexSessionCapture(session);
      this.clearCodexStatusSampler(session);
      if (session.cliType === CODEX_WINDOWS) {
        this.clearCodexWindowsWakeAttempt(session, { clearToken: true });
      }
      session.startupSequence = null;
      if (['parking_failed_live', 'wake_failed_live'].includes(session.runtimeState)) {
        session.pauseReason = 'recovery_failed';
        session.recoveryError = 'EasyCC shut down while PTY termination was unconfirmed';
      } else if (session.runtimeState !== 'auto_parked') {
        session.pauseReason = session.pauseReason || 'startup_restore';
      }
      if (session.pty) {
        this._clearWriteQueue(session);
        session.pty.kill();
      }
      session.status = 'paused';
      if (session.runtimeState !== 'auto_parked') session.runtimeState = 'paused';
      session.pty = null;
      this.dataStore.saveSession(session);  // Persist for restart
    }
    this.sessions.clear();
  }
}

module.exports = SessionManager;

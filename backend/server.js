const fastify = require('fastify');
const fastifyWebsocket = require('@fastify/websocket');
const fastifyStatic = require('@fastify/static');
const fastifyCors = require('@fastify/cors');
const path = require('path');
const fs = require('fs');
const SessionManager = require('./sessionManager');
const PlanManager = require('./planManager');
const SettingsManager = require('./settingsManager');
const DataStore = require('./dataStore');
const PlanVersionStore = require('./planVersionStore');

const app = fastify({ logger: true });
const dataStore = new DataStore();
const sessionManager = new SessionManager();
const planManager = new PlanManager();
const settingsManager = new SettingsManager();
const planVersionStore = new PlanVersionStore();
const { sessionStatusToStage } = require('./stagesConfig');

const DEFAULT_FOLDERS_ROOT = 'C:\\Users\\denni\\apps';

// Per-session debounce timers for kanban stage sync (3s stability)
const kanbanSyncTimers = new Map();

// Track WebSocket connections
const dashboardClients = new Set();
const terminalClients = new Map(); // sessionId -> Set of clients

function normalizeWindowsPath(input) {
  if (!input || typeof input !== 'string') return '';
  const normalized = path.win32.normalize(input.trim().replace(/\//g, '\\'));
  if (/^[A-Za-z]:\\?$/.test(normalized)) {
    return `${normalized[0].toUpperCase()}:\\`;
  }
  return normalized.replace(/\\+$/, '');
}

function isPathWithinRoot(targetPath, rootPath) {
  const normalizedTarget = normalizeWindowsPath(targetPath).toLowerCase();
  const normalizedRoot = normalizeWindowsPath(rootPath).toLowerCase();
  return normalizedTarget === normalizedRoot || normalizedTarget.startsWith(`${normalizedRoot}\\`);
}

function generateSessionName(cliType = 'claude') {
  const now = new Date();
  const date = now.toISOString().slice(0, 10);
  const time = now.toTimeString().slice(0, 5).replace(':', '');
  const prefix = cliType === 'terminal' ? 'Terminal' : cliType === 'codex' ? 'Codex' : 'Session';
  return `${prefix} ${date}-${time}`;
}

async function start() {
  // Register plugins
  await app.register(fastifyCors, {
    origin: true,
    credentials: true
  });

  await app.register(fastifyWebsocket, {
    options: {
      // Allow connections from any origin (for dev mode cross-origin connections)
      verifyClient: function (info, next) {
        next(true);
      }
    }
  });

  // Serve static files in production
  const uiDistPath = path.join(__dirname, '..', 'ui', 'dist');
  try {
    await app.register(fastifyStatic, {
      root: uiDistPath,
      prefix: '/'
    });
  } catch (error) {
    console.log('Static file serving not available (dev mode)');
  }

  // REST API Routes

  // List all sessions
  app.get('/api/sessions', async () => {
    return { sessions: sessionManager.getAllSessions() };
  });

  // Create a new session
  app.post('/api/sessions', async (request, reply) => {
    const { name, workingDir, cliType, stage, priority, description } = request.body || {};

    // Validate cliType
    const validCliTypes = ['claude', 'codex', 'terminal'];
    const normalizedCliType = cliType && validCliTypes.includes(cliType) ? cliType : 'claude';
    const normalizedName = typeof name === 'string' ? name.trim() : '';
    const resolvedName = normalizedName || generateSessionName(normalizedCliType);

    try {
      const session = sessionManager.createSession(resolvedName, workingDir, normalizedCliType, {
        stage: stage || 'todo',
        priority: priority || 0,
        description: description || ''
      });

      return reply.status(201).send({ session });
    } catch (error) {
      return reply.status(500).send({ error: error.message });
    }
  });

  // List folders in a directory (for folder picker)
  app.get('/api/folders', async (request, reply) => {
    const root = normalizeWindowsPath(process.env.FOLDERS_BROWSE_ROOT || DEFAULT_FOLDERS_ROOT);
    const requestedBase = normalizeWindowsPath(request.query.base || root) || root;

    try {
      if (!isPathWithinRoot(requestedBase, root)) {
        return reply.status(403).send({ error: `Path must be within ${root}` });
      }

      if (!fs.existsSync(requestedBase) || !fs.statSync(requestedBase).isDirectory()) {
        return reply.status(400).send({ error: 'Requested path is not a directory' });
      }

      const entries = fs.readdirSync(requestedBase, { withFileTypes: true });
      const folders = entries
        .filter(e => e.isDirectory())
        .map(e => e.name)
        .sort();
      return { folders, base: requestedBase, root };
    } catch (error) {
      return reply.status(500).send({ error: error.message });
    }
  });

  // Get a single session
  app.get('/api/sessions/:id', async (request, reply) => {
    const { id } = request.params;
    const session = sessionManager.getSession(id);

    if (!session) {
      return reply.status(404).send({ error: 'Session not found' });
    }

    return { session };
  });

  // Update session metadata
  app.patch('/api/sessions/:id', async (request, reply) => {
    const { id } = request.params;
    const { name, notes, tags, cliType } = request.body || {};

    const session = sessionManager.updateSessionMeta(id, { name, notes, tags, cliType });

    if (!session) {
      return reply.status(404).send({ error: 'Session not found' });
    }

    return { session };
  });

  // Kill a session
  app.delete('/api/sessions/:id', async (request, reply) => {
    const { id } = request.params;
    const success = sessionManager.killSession(id);

    if (!success) {
      return reply.status(404).send({ error: 'Session not found' });
    }

    return { success: true };
  });

  // Pause a session
  app.post('/api/sessions/:id/pause', async (request, reply) => {
    const { id } = request.params;
    const success = sessionManager.pauseSession(id);

    if (!success) {
      return reply.status(400).send({ error: 'Could not pause session (not found or already paused/completed)' });
    }

    return { success: true, session: sessionManager.getSession(id) };
  });

  // Resume a paused session
  app.post('/api/sessions/:id/resume', async (request, reply) => {
    const { id } = request.params;
    const success = sessionManager.resumeSession(id);

    if (!success) {
      return reply.status(400).send({ error: 'Could not resume session (not found or not paused)' });
    }

    return { success: true, session: sessionManager.getSession(id) };
  });

  // Get plans for a session
  app.get('/api/sessions/:id/plans', async (request, reply) => {
    const { id } = request.params;
    const session = sessionManager.getSession(id);

    if (!session) {
      return reply.status(404).send({ error: 'Session not found' });
    }

    const plans = sessionManager.getSessionPlans(id);
    return { plans };
  });

  // Manually associate a plan with a session
  app.post('/api/sessions/:id/plans', async (request, reply) => {
    const { id } = request.params;
    const { planPath } = request.body || {};

    const session = sessionManager.getSession(id);
    if (!session) {
      return reply.status(404).send({ error: 'Session not found' });
    }

    if (!planPath) {
      return reply.status(400).send({ error: 'planPath is required' });
    }

    sessionManager.addOrUpdatePlanInSession(id, planPath);
    const plans = sessionManager.getSessionPlans(id);
    return { plans };
  });

  // Get Claude session transcript (user prompts from JSONL)
  app.get('/api/sessions/:id/claude-transcript', async (request, reply) => {
    const { id } = request.params;
    const session = sessionManager.getSession(id);

    if (!session) {
      return reply.status(404).send({ error: 'Session not found' });
    }

    if (!session.claudeSessionId) {
      return reply.status(400).send({ error: 'No Claude session ID linked' });
    }

    const transcript = sessionManager.getClaudeSessionTranscript(
      session.claudeSessionId,
      session.workingDir
    );

    if (!transcript) {
      return reply.status(404).send({ error: 'Claude session transcript not found' });
    }

    return { transcript };
  });

  // List available Claude sessions for linking
  app.get('/api/sessions/:id/available-claude-sessions', async (request, reply) => {
    const { id } = request.params;
    const session = sessionManager.getSession(id);

    if (!session) {
      return reply.status(404).send({ error: 'Session not found' });
    }

    const claudeSessions = sessionManager.listClaudeSessionsForLinking(session.workingDir);
    return { claudeSessions, currentClaudeSessionId: session.claudeSessionId };
  });

  // Manually link a Claude session ID to our session
  app.post('/api/sessions/:id/link-claude-session', async (request, reply) => {
    const { id } = request.params;
    const { claudeSessionId } = request.body || {};

    if (!claudeSessionId) {
      return reply.status(400).send({ error: 'claudeSessionId is required' });
    }

    const success = sessionManager.linkClaudeSession(id, claudeSessionId);

    if (!success) {
      return reply.status(404).send({ error: 'Session not found' });
    }

    return { success: true, claudeSessionId };
  });

  // Generate a Claude session ID and inject launch command into terminal
  app.post('/api/sessions/:id/generate-claude-session', async (request, reply) => {
    const { id } = request.params;
    const result = sessionManager.generateAndInjectClaudeSession(id);

    if (!result) {
      return reply.status(404).send({ error: 'Session not found' });
    }

    return { claudeSessionId: result.claudeSessionId, command: result.command };
  });

  // Create a new plan from pasted content
  app.post('/api/plans', async (request, reply) => {
    const { content, name, sessionId } = request.body || {};

    if (!content || !content.trim()) {
      return reply.status(400).send({ error: 'Plan content is required' });
    }

    const fs = require('fs');
    const path = require('path');
    const os = require('os');

    const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const safeName = (name || 'pasted-plan').replace(/[^a-zA-Z0-9-_]/g, '-').slice(0, 40);
    const filename = `${safeName}-${timestamp}.md`;
    const plansDir = path.join(os.homedir(), '.claude', 'plans');

    if (!fs.existsSync(plansDir)) {
      fs.mkdirSync(plansDir, { recursive: true });
    }

    const planPath = path.join(plansDir, filename);
    fs.writeFileSync(planPath, content, 'utf8');

    if (sessionId) {
      const session = sessionManager.getSession(sessionId);
      if (session) {
        if (!session.plans) session.plans = [];
        if (!session.plans.includes(planPath)) {
          session.plans.push(planPath);
        }
        dataStore.saveSession(session);
      }
    }

    return { success: true, path: planPath, filename };
  });

  // List plans not yet associated with a session
  app.get('/api/sessions/:id/available-plans', async (request, reply) => {
    const { id } = request.params;
    const session = sessionManager.getSession(id);

    if (!session) {
      return reply.status(404).send({ error: 'Session not found' });
    }

    const allPlans = planManager.listPlans();
    const sessionPlans = session.plans || [];

    // Filter out plans already associated with this session
    const available = allPlans.filter(p => !sessionPlans.includes(p.path));
    return { plans: available };
  });

  // Resize a session's terminal
  app.post('/api/sessions/:id/resize', async (request, reply) => {
    const { id } = request.params;
    const { cols, rows } = request.body || {};

    if (!cols || !rows || typeof cols !== 'number' || typeof rows !== 'number') {
      return reply.status(400).send({ error: 'cols and rows are required and must be numbers' });
    }

    const success = sessionManager.resizeSession(id, cols, rows);

    if (!success) {
      return reply.status(404).send({ error: 'Session not found or completed' });
    }

    return { success: true };
  });

  // Plans API

  // List all plans
  app.get('/api/plans', async () => {
    const plans = planManager.listPlans();
    return { plans };
  });

  // Get a specific plan
  app.get('/api/plans/:filename', async (request, reply) => {
    const { filename } = request.params;
    const plan = planManager.getPlanContent(filename);

    if (!plan) {
      return reply.status(404).send({ error: 'Plan not found' });
    }

    return { plan };
  });

  // Plan Version API

  // Get all versions for a plan
  app.get('/api/plans/:filename/versions', async (request, reply) => {
    const { filename } = request.params;
    const planPath = planManager.getPlanPath(filename);

    if (!planPath || !fs.existsSync(planPath)) {
      return reply.status(404).send({ error: 'Plan not found' });
    }

    const versions = planVersionStore.getVersions(planPath);
    return { versions, planPath };
  });

  // Get a specific version's content
  app.get('/api/plans/:filename/versions/:versionFilename', async (request, reply) => {
    const { filename, versionFilename } = request.params;
    const planPath = planManager.getPlanPath(filename);

    if (!planPath) {
      return reply.status(404).send({ error: 'Plan not found' });
    }

    const content = planVersionStore.getVersionContent(planPath, versionFilename);

    if (!content) {
      return reply.status(404).send({ error: 'Version not found' });
    }

    return { content, versionFilename };
  });

  // Create a version snapshot manually
  app.post('/api/plans/:filename/versions', async (request, reply) => {
    const { filename } = request.params;
    const planPath = planManager.getPlanPath(filename);

    if (!planPath || !fs.existsSync(planPath)) {
      return reply.status(404).send({ error: 'Plan not found' });
    }

    const content = fs.readFileSync(planPath, 'utf8');
    planVersionStore.markDirty(planPath, content);
    const version = planVersionStore.createVersion(planPath);

    if (!version) {
      return { message: 'No changes to save' };
    }

    return { version };
  });

  // Delete a version
  app.delete('/api/plans/:filename/versions/:versionFilename', async (request, reply) => {
    const { filename, versionFilename } = request.params;
    const planPath = planManager.getPlanPath(filename);

    if (!planPath) {
      return reply.status(404).send({ error: 'Plan not found' });
    }

    const planDir = planVersionStore.getPlanDir(planPath);
    const versionPath = path.join(planDir, versionFilename);
    const metaPath = versionPath.replace('.md', '.meta.json');

    try {
      if (fs.existsSync(versionPath)) {
        fs.unlinkSync(versionPath);
      }
      if (fs.existsSync(metaPath)) {
        fs.unlinkSync(metaPath);
      }
      return { success: true };
    } catch (error) {
      return reply.status(500).send({ error: error.message });
    }
  });

  // Get diff between two versions
  app.get('/api/plans/:filename/diff', async (request, reply) => {
    const { filename } = request.params;
    const { from, to } = request.query;

    const planPath = planManager.getPlanPath(filename);

    if (!planPath) {
      return reply.status(404).send({ error: 'Plan not found' });
    }

    if (!from || !to) {
      return reply.status(400).send({ error: 'Both "from" and "to" version filenames are required' });
    }

    const content1 = planVersionStore.getVersionContent(planPath, from);
    const content2 = planVersionStore.getVersionContent(planPath, to);

    if (!content1 || !content2) {
      return reply.status(404).send({ error: 'One or both versions not found' });
    }

    const diff = planVersionStore.diffVersions(content1, content2);
    return { diff, from, to };
  });

  // Settings API

  // Get current settings
  app.get('/api/settings', async () => {
    return { settings: settingsManager.loadSettings() };
  });

  // Get default settings
  app.get('/api/settings/defaults', async () => {
    return { settings: settingsManager.getDefaults() };
  });

  // Update settings
  app.put('/api/settings', async (request, reply) => {
    const updates = request.body;

    if (!updates || typeof updates !== 'object') {
      return reply.status(400).send({ error: 'Invalid settings payload' });
    }

    const settings = settingsManager.updateSettings(updates);
    return { settings };
  });

  // Reset settings to defaults
  app.post('/api/settings/reset', async () => {
    const settings = settingsManager.resetSettings();
    return { settings };
  });

  // ============================================
  // Session Kanban / Stage Routes
  // ============================================

  // Get sessions grouped by stage
  app.get('/api/sessions/by-stage', async () => {
    return { sessionsByStage: sessionManager.getSessionsByStage() };
  });

  // Get session stage stats
  app.get('/api/sessions/stats', async () => {
    return { stats: sessionManager.getStageStats() };
  });

  // Move session to a stage
  app.post('/api/sessions/:id/move', async (request, reply) => {
    const { id } = request.params;
    const { stage, reason } = request.body || {};

    if (!stage) {
      return reply.status(400).send({ error: 'Target stage is required' });
    }

    try {
      const session = sessionManager.moveSession(id, stage, { reason, source: 'manual' });
      return { session };
    } catch (error) {
      if (error.message.includes('not found')) {
        return reply.status(404).send({ error: error.message });
      }
      return reply.status(400).send({ error: error.message });
    }
  });

  // Advance session to next stage
  app.post('/api/sessions/:id/advance', async (request, reply) => {
    const { id } = request.params;

    try {
      const session = sessionManager.advanceSession(id);
      return { session };
    } catch (error) {
      if (error.message.includes('not found')) {
        return reply.status(404).send({ error: error.message });
      }
      return reply.status(400).send({ error: error.message });
    }
  });

  // Reject session to previous stage
  app.post('/api/sessions/:id/reject', async (request, reply) => {
    const { id } = request.params;
    const { reason, targetStage } = request.body || {};

    if (!reason) {
      return reply.status(400).send({ error: 'Rejection reason is required' });
    }

    try {
      const session = sessionManager.rejectSession(id, reason, targetStage);
      return { session };
    } catch (error) {
      if (error.message.includes('not found')) {
        return reply.status(404).send({ error: error.message });
      }
      return reply.status(400).send({ error: error.message });
    }
  });

  // Add dependency between sessions
  app.post('/api/sessions/:id/dependencies', async (request, reply) => {
    const { id } = request.params;
    const { blockerId } = request.body || {};

    if (!blockerId) {
      return reply.status(400).send({ error: 'blockerId is required' });
    }

    try {
      const session = sessionManager.addDependency(id, blockerId);
      return { session };
    } catch (error) {
      if (error.message.includes('not found')) {
        return reply.status(404).send({ error: error.message });
      }
      return reply.status(400).send({ error: error.message });
    }
  });

  // Remove dependency
  app.delete('/api/sessions/:id/dependencies/:blockerId', async (request, reply) => {
    const { id, blockerId } = request.params;

    try {
      const session = sessionManager.removeDependency(id, blockerId);
      return { session };
    } catch (error) {
      if (error.message.includes('not found')) {
        return reply.status(404).send({ error: error.message });
      }
      return reply.status(400).send({ error: error.message });
    }
  });

  // Reset manual placement
  app.post('/api/sessions/:id/reset-placement', async (request, reply) => {
    const { id } = request.params;

    try {
      const session = sessionManager.resetManualPlacement(id);
      return { session };
    } catch (error) {
      if (error.message.includes('not found')) {
        return reply.status(404).send({ error: error.message });
      }
      return reply.status(500).send({ error: error.message });
    }
  });

  // Add comment to session
  app.post('/api/sessions/:id/comments', async (request, reply) => {
    const { id } = request.params;
    const { text, author } = request.body || {};

    if (!text || !text.trim()) {
      return reply.status(400).send({ error: 'Comment text is required' });
    }

    try {
      const comment = sessionManager.addComment(id, text.trim(), author);
      return { comment };
    } catch (error) {
      if (error.message.includes('not found')) {
        return reply.status(404).send({ error: error.message });
      }
      return reply.status(500).send({ error: error.message });
    }
  });

  // Get comments for session
  app.get('/api/sessions/:id/comments', async (request, reply) => {
    const { id } = request.params;
    const session = sessionManager.getSession(id);

    if (!session) {
      return reply.status(404).send({ error: 'Session not found' });
    }

    return { comments: session.comments || [] };
  });

  // ============================================
  // Stages API
  // ============================================

  // Get all stages
  app.get('/api/stages', async () => {
    return { stages: sessionManager.getStages() };
  });

  // Update stages configuration
  app.put('/api/stages', async (request, reply) => {
    const { stages } = request.body || {};

    if (!stages || !Array.isArray(stages)) {
      return reply.status(400).send({ error: 'stages array is required' });
    }

    try {
      const updatedStages = sessionManager.updateStages(stages);
      return { stages: updatedStages };
    } catch (error) {
      return reply.status(500).send({ error: error.message });
    }
  });

  // ============================================
  // Transitions API
  // ============================================

  // Get recent transitions (for analytics/audit)
  app.get('/api/transitions', async (request, reply) => {
    const limit = parseInt(request.query.limit || '100', 10);
    return { transitions: dataStore.getRecentTransitions(limit) };
  });

  // WebSocket: Dashboard updates
  app.register(async function (fastify) {
    fastify.get('/socket/dashboard', { websocket: true }, (socket, req) => {
      dashboardClients.add(socket);

      // Send initial sessions list
      socket.send(JSON.stringify({
        type: 'init',
        sessions: sessionManager.getAllSessions()
      }));

      socket.on('close', () => {
        dashboardClients.delete(socket);
      });

      socket.on('error', (error) => {
        console.error('Dashboard WebSocket error:', error.message);
        dashboardClients.delete(socket);
      });
    });
  });

  // WebSocket: Terminal I/O
  app.register(async function (fastify) {
    fastify.get('/socket/sessions/:id/terminal', { websocket: true }, (socket, req) => {
      const { id } = req.params;
      const session = sessionManager.getSession(id);

      if (!session) {
        socket.send(JSON.stringify({ type: 'error', error: 'Session not found' }));
        socket.close();
        return;
      }

      // Add to terminal clients
      if (!terminalClients.has(id)) {
        terminalClients.set(id, new Set());
      }
      terminalClients.get(id).add(socket);

      // Send session status (for paused indicator)
      socket.send(JSON.stringify({
        type: 'status',
        status: session.status
      }));

      // Send buffered output after a short delay to allow proxy to fully establish
      setTimeout(() => {
        const output = sessionManager.getSessionOutput(id);
        if (output && output.length > 0) {
          try {
            socket.send(JSON.stringify({
              type: 'output',
              data: output.join('')
            }));
          } catch (e) {
            // Socket may have closed
          }
        }
      }, 100);

      // Handle incoming messages (user input)
      socket.on('message', (message) => {
        try {
          const parsed = JSON.parse(message.toString());

          if (parsed.type === 'input' && parsed.data) {
            sessionManager.sendInput(id, parsed.data);
          } else if (parsed.type === 'resize' && parsed.cols && parsed.rows) {
            sessionManager.resizeSession(id, parsed.cols, parsed.rows);
          }
        } catch (error) {
          console.error('Error parsing terminal message:', error.message);
        }
      });

      socket.on('close', () => {
        const clients = terminalClients.get(id);
        if (clients) {
          clients.delete(socket);
          if (clients.size === 0) {
            terminalClients.delete(id);
          }
        }
      });

      socket.on('error', (error) => {
        console.error('Terminal WebSocket error:', error.message);
        const clients = terminalClients.get(id);
        if (clients) {
          clients.delete(socket);
        }
      });
    });
  });

  // Session manager event handlers

  // Broadcast output to terminal clients
  sessionManager.on('output', ({ sessionId, data }) => {
    const clients = terminalClients.get(sessionId);
    if (clients) {
      const message = JSON.stringify({ type: 'output', data });
      for (const client of clients) {
        try {
          client.send(message);
        } catch (error) {
          console.error('Error sending to terminal client:', error.message);
        }
      }
    }
  });

  // Broadcast status changes to dashboard clients
  sessionManager.on('statusChange', ({ sessionId, status, currentTask }) => {
    const message = JSON.stringify({
      type: 'statusChange',
      sessionId,
      status,
      currentTask
    });

    for (const client of dashboardClients) {
      try {
        client.send(message);
      } catch (error) {
        console.error('Error sending to dashboard client:', error.message);
      }
    }

    // Also notify terminal clients about status changes (for paused overlay)
    const termClients = terminalClients.get(sessionId);
    if (termClients) {
      const statusMessage = JSON.stringify({ type: 'status', status });
      for (const client of termClients) {
        try {
          client.send(statusMessage);
        } catch (error) {
          console.error('Error sending status to terminal client:', error.message);
        }
      }
    }
  });

  // Broadcast session updates to dashboard clients
  sessionManager.on('sessionUpdated', (sessionData) => {
    const message = JSON.stringify({
      type: 'sessionUpdated',
      ...sessionData
    });

    for (const client of dashboardClients) {
      try {
        client.send(message);
      } catch (error) {
        console.error('Error sending to dashboard client:', error.message);
      }
    }
  });

  // Broadcast prompt added to dashboard clients
  sessionManager.on('promptAdded', ({ sessionId, promptHistory }) => {
    const message = JSON.stringify({
      type: 'promptAdded',
      sessionId,
      promptHistory
    });

    for (const client of dashboardClients) {
      try {
        client.send(message);
      } catch (error) {
        console.error('Error sending to dashboard client:', error.message);
      }
    }
  });

  // Broadcast session killed to dashboard clients
  sessionManager.on('sessionKilled', ({ sessionId }) => {
    const message = JSON.stringify({
      type: 'sessionKilled',
      sessionId
    });

    for (const client of dashboardClients) {
      try {
        client.send(message);
      } catch (error) {
        console.error('Error sending to dashboard client:', error.message);
      }
    }

    // Also notify terminal clients
    const termClients = terminalClients.get(sessionId);
    if (termClients) {
      for (const client of termClients) {
        try {
          client.send(JSON.stringify({ type: 'sessionEnded' }));
          client.close();
        } catch (error) {
          console.error('Error closing terminal client:', error.message);
        }
      }
      terminalClients.delete(sessionId);
    }
  });

  // Broadcast session ended to clients
  sessionManager.on('sessionEnded', ({ sessionId }) => {
    const message = JSON.stringify({
      type: 'sessionEnded',
      sessionId
    });

    for (const client of dashboardClients) {
      try {
        client.send(message);
      } catch (error) {
        console.error('Error sending to dashboard client:', error.message);
      }
    }

    // Clear debounce timer
    if (kanbanSyncTimers.has(sessionId)) {
      clearTimeout(kanbanSyncTimers.get(sessionId));
      kanbanSyncTimers.delete(sessionId);
    }
  });

  // Clear debounce timer on session kill
  sessionManager.on('sessionKilled', ({ sessionId }) => {
    if (kanbanSyncTimers.has(sessionId)) {
      clearTimeout(kanbanSyncTimers.get(sessionId));
      kanbanSyncTimers.delete(sessionId);
    }
  });

  // Broadcast sessionMoved events to dashboard clients
  sessionManager.on('sessionMoved', (data) => {
    const message = JSON.stringify({ type: 'sessionMoved', ...data });
    for (const client of dashboardClients) {
      try {
        client.send(message);
      } catch (error) {
        console.error('Error sending to dashboard client:', error.message);
      }
    }
  });

  // Broadcast stagesUpdated events
  sessionManager.on('stagesUpdated', (stages) => {
    const message = JSON.stringify({ type: 'stagesUpdated', stages });
    for (const client of dashboardClients) {
      try {
        client.send(message);
      } catch (error) {
        console.error('Error sending to dashboard client:', error.message);
      }
    }
  });

  // Debounced auto-sync: session status → session's own stage (3s stability)
  sessionManager.on('statusChange', ({ sessionId, status }) => {
    // Clear previous timer
    if (kanbanSyncTimers.has(sessionId)) {
      clearTimeout(kanbanSyncTimers.get(sessionId));
    }

    // Codex mid-work approvals: don't auto-move to in_review
    const session = sessionManager.getSession(sessionId);
    if (session?.cliType === 'codex' && status === 'waiting') {
      kanbanSyncTimers.delete(sessionId);
      return;
    }

    const targetStage = sessionStatusToStage(status);
    if (!targetStage) {
      kanbanSyncTimers.delete(sessionId);
      return;
    }

    // Set 3s debounce timer
    const timer = setTimeout(() => {
      kanbanSyncTimers.delete(sessionId);
      try {
        sessionManager.moveSession(sessionId, targetStage, { source: 'auto' });
      } catch (err) {
        console.error(`Auto-sync stage failed for session ${sessionId}:`, err.message);
      }
    }, 3000);

    kanbanSyncTimers.set(sessionId, timer);
  });

  // ============================================
  // Plan Version Tracking Integration
  // ============================================

  // Watch for plan file changes and mark them as dirty
  planManager.watchPlans((plan) => {
    if (plan && plan.filename && plan.filename.endsWith('.md')) {
      const planPath = plan.path;
      if (planPath && fs.existsSync(planPath)) {
        try {
          const content = fs.readFileSync(planPath, 'utf8');
          planVersionStore.markDirty(planPath, content);
          console.log(`[PlanVersionStore] Marked plan as dirty: ${plan.filename}`);
        } catch (error) {
          console.error(`[PlanVersionStore] Error marking plan dirty: ${error.message}`);
        }
      }
    }
  });

  // Create version snapshots when any session goes idle (idle-triggered versioning)
  sessionManager.on('statusChange', ({ sessionId, status }) => {
    if (status === 'idle') {
      // Flush all dirty plans to create version snapshots
      const versions = planVersionStore.flushDirtyPlans();
      if (versions.length > 0) {
        console.log(`[PlanVersionStore] Created ${versions.length} version snapshot(s) on idle`);

        // Notify dashboard clients about new versions
        for (const version of versions) {
          const message = JSON.stringify({
            type: 'planVersionCreated',
            planPath: version.planPath,
            timestamp: version.timestamp
          });

          for (const client of dashboardClients) {
            try {
              client.send(message);
            } catch (error) {
              console.error('Error sending version notification:', error.message);
            }
          }
        }
      }
    }
  });


  // Fallback route for SPA
  app.setNotFoundHandler((request, reply) => {
    if (request.url.startsWith('/api/') || request.url.startsWith('/ws/')) {
      return reply.status(404).send({ error: 'Not found' });
    }
    // Serve index.html for SPA routing
    return reply.sendFile('index.html');
  });

  // Graceful shutdown
  const shutdown = async () => {
    console.log('Shutting down...');
    sessionManager.cleanup();
    await app.close();
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  // Start server
  const host = '0.0.0.0';
  const port = parseInt(process.env.PORT || '5010', 10);

  try {
    await app.listen({ port, host });
    console.log(`\nClaude Manager running at:`);
    console.log(`  Local:   http://localhost:${port}`);
    console.log(`  Network: http://${getLocalIP()}:${port}\n`);
  } catch (error) {
    console.error('Failed to start server:', error);
    process.exit(1);
  }
}

// Get local IP address for network access info
function getLocalIP() {
  const { networkInterfaces } = require('os');
  const nets = networkInterfaces();

  for (const name of Object.keys(nets)) {
    for (const net of nets[name]) {
      if (net.family === 'IPv4' && !net.internal) {
        return net.address;
      }
    }
  }
  return '0.0.0.0';
}

// Only auto-start if not running in Electron
if (!process.versions.electron) {
  start();
}

// Export for Electron main process
module.exports = { start };

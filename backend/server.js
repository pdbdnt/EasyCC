const fastify = require('fastify');
const fastifyWebsocket = require('@fastify/websocket');
const fastifyStatic = require('@fastify/static');
const fastifyCors = require('@fastify/cors');
const path = require('path');
const fs = require('fs');
const os = require('os');
const SessionManager = require('./sessionManager');
const PlanManager = require('./planManager');
const SettingsManager = require('./settingsManager');
const DataStore = require('./dataStore');
const PlanVersionStore = require('./planVersionStore');
const AgentStore = require('./agentStore');
const TaskStore = require('./taskStore');
const { generateSessionName, ensureUniqueSessionName } = require('./sessionNaming');
const { prepareTerminalReplayPayload } = require('./terminalReplayUtils');

const app = fastify({ logger: true });
const dataStore = new DataStore();
const sessionManager = new SessionManager();
const planManager = new PlanManager();
const settingsManager = new SettingsManager();
const planVersionStore = new PlanVersionStore();
const agentStore = new AgentStore();
const taskStore = new TaskStore();
const { sessionStatusToStage } = require('./stagesConfig');

const DEFAULT_FOLDERS_ROOT = process.env.FOLDERS_BROWSE_ROOT || path.join(os.homedir(), 'apps');

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

function normalizePathKey(filePath) {
  if (!filePath || typeof filePath !== 'string') return '';
  const resolved = path.resolve(filePath);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function listProjectPlans(workingDir) {
  if (!workingDir || typeof workingDir !== 'string') {
    return [];
  }

  const plansDir = path.join(workingDir, 'plans');
  if (!fs.existsSync(plansDir)) {
    return [];
  }

  try {
    const files = fs.readdirSync(plansDir);
    const plans = [];

    for (const file of files) {
      if (!file.endsWith('.md')) {
        continue;
      }

      const filePath = path.join(plansDir, file);
      const stats = fs.statSync(filePath);
      plans.push({
        filename: file,
        name: file.replace('.md', '').replace(/-/g, ' '),
        path: filePath,
        createdAt: stats.birthtime.toISOString(),
        modifiedAt: stats.mtime.toISOString(),
        size: stats.size
      });
    }

    plans.sort((a, b) => new Date(b.modifiedAt) - new Date(a.modifiedAt));
    return plans;
  } catch (error) {
    console.error('Error listing project plans:', error.message);
    return [];
  }
}

function normalizeRoleInput(role) {
  if (role === undefined || role === null) {
    return { value: '' };
  }
  if (typeof role !== 'string') {
    return { error: 'role must be a string' };
  }

  const normalized = role.replace(/\0/g, '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  if (normalized.length > 4096) {
    return { error: 'role must be 4096 characters or fewer' };
  }

  return { value: normalized };
}

function normalizeStringArray(value) {
  if (!Array.isArray(value)) return [];
  return value
    .filter((entry) => typeof entry === 'string')
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function parseMentionNames(text) {
  if (typeof text !== 'string') return [];
  const matches = text.match(/@([a-zA-Z0-9_-]+)/g) || [];
  return matches.map((mention) => mention.slice(1).trim()).filter(Boolean);
}

function resolveMentionAgentIds(text, explicitMentions = []) {
  const directIds = normalizeStringArray(explicitMentions);
  const byName = parseMentionNames(text);
  if (byName.length === 0) return directIds;
  const agents = agentStore.listAgents();
  const ids = new Set(directIds);
  for (const name of byName) {
    const matched = agents.find((agent) => agent.name.toLowerCase() === name.toLowerCase());
    if (matched) ids.add(matched.id);
  }
  return [...ids];
}

function getActiveRunForAgent(task, agentId) {
  const history = Array.isArray(task?.runHistory) ? task.runHistory : [];
  for (let i = history.length - 1; i >= 0; i -= 1) {
    const run = history[i];
    if (run?.agentId === agentId && !run.endedAt) {
      return run;
    }
  }
  return null;
}

function broadcastDashboard(payload) {
  const message = JSON.stringify(payload);
  for (const client of dashboardClients) {
    try {
      client.send(message);
    } catch (error) {
      console.error('Error sending to dashboard client:', error.message);
    }
  }
}

async function start() {
  // Register plugins
  await app.register(fastifyCors, {
    origin: ['http://localhost:5010', 'http://localhost:5011'],
    credentials: true
  });

  await app.register(fastifyWebsocket, {
    options: {
      verifyClient: function (info, next) {
        const origin = info.origin || info.req.headers.origin || '';
        const allowed = origin.startsWith('http://localhost:');
        next(allowed);
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

  // Agents API
  app.get('/api/agents', async () => {
    return { agents: agentStore.listAgents() };
  });

  app.post('/api/agents', async (request, reply) => {
    const body = request.body || {};
    const normalizedRole = normalizeRoleInput(body.role);
    if (normalizedRole.error) {
      return reply.status(400).send({ error: normalizedRole.error });
    }

    const agent = agentStore.createAgent({
      name: typeof body.name === 'string' ? body.name : '',
      role: normalizedRole.value,
      cliType: body.cliType,
      workingDir: body.workingDir,
      notes: body.notes,
      tags: normalizeStringArray(body.tags),
      skills: normalizeStringArray(body.skills),
      startupPrompt: typeof body.startupPrompt === 'string' ? body.startupPrompt : ''
    });

    broadcastDashboard({ type: 'agentUpdated', agent });
    return reply.status(201).send({ agent });
  });

  app.patch('/api/agents/:id', async (request, reply) => {
    const { id } = request.params;
    const body = request.body || {};
    const normalizedRole = normalizeRoleInput(body.role);
    if (normalizedRole.error) {
      return reply.status(400).send({ error: normalizedRole.error });
    }

    const updates = { ...body };
    if (body.role !== undefined) updates.role = normalizedRole.value;
    if (body.tags !== undefined) updates.tags = normalizeStringArray(body.tags);
    if (body.skills !== undefined) updates.skills = normalizeStringArray(body.skills);
    if (body.memory !== undefined) updates.memory = normalizeStringArray(body.memory);
    const agent = agentStore.updateAgent(id, updates);
    if (!agent) {
      return reply.status(404).send({ error: 'Agent not found' });
    }
    broadcastDashboard({ type: 'agentUpdated', agent });
    return { agent };
  });

  app.delete('/api/agents/:id', async (request, reply) => {
    const { id } = request.params;
    const agent = agentStore.deleteAgent(id);
    if (!agent) {
      return reply.status(404).send({ error: 'Agent not found' });
    }
    broadcastDashboard({ type: 'agentUpdated', agent });
    return { agent };
  });

  app.post('/api/agents/:id/start', async (request, reply) => {
    const { id } = request.params;
    const agent = agentStore.getAgent(id);
    if (!agent || agent.deletedAt) {
      return reply.status(404).send({ error: 'Agent not found' });
    }

    if (agent.activeSessionId) {
      const existing = sessionManager.getSession(agent.activeSessionId);
      if (existing && existing.status !== 'completed') {
        return { session: existing, agent };
      }
    }

    try {
      const session = sessionManager.createSession(
        agent.name,
        agent.workingDir,
        agent.cliType,
        {},
        agent.role || '',
        { agentId: agent.id }
      );
      const updatedAgent = agentStore.updateAgent(id, {
        activeSessionId: session.id,
        lastActiveAt: new Date().toISOString(),
        sessionHistory: [...(agent.sessionHistory || []), session.id]
      });
      const liveSession = sessionManager.sessions.get(session.id);
      if (liveSession) {
        sessionManager.runStartupSequence(liveSession, updatedAgent || agent);
      }
      broadcastDashboard({ type: 'agentUpdated', agent: updatedAgent || agent });
      return { session, agent: updatedAgent || agent };
    } catch (error) {
      return reply.status(500).send({ error: error.message });
    }
  });

  app.post('/api/agents/:id/stop', async (request, reply) => {
    const { id } = request.params;
    const agent = agentStore.getAgent(id);
    if (!agent || agent.deletedAt) {
      return reply.status(404).send({ error: 'Agent not found' });
    }
    if (!agent.activeSessionId) {
      return { success: true, agent };
    }
    const snapshotBeforeStop = sessionManager.getSession(agent.activeSessionId);
    sessionManager.killSession(agent.activeSessionId);
    appendAgentMemoryFromSession(agent.id, snapshotBeforeStop);
    const updatedAgent = agentStore.updateAgent(id, {
      activeSessionId: null,
      lastActiveAt: new Date().toISOString()
    });
    broadcastDashboard({ type: 'agentUpdated', agent: updatedAgent || agent });
    return { success: true, agent: updatedAgent || agent };
  });

  app.post('/api/agents/:id/restart', async (request, reply) => {
    const { id } = request.params;
    const agent = agentStore.getAgent(id);
    if (!agent || agent.deletedAt) {
      return reply.status(404).send({ error: 'Agent not found' });
    }
    if (agent.activeSessionId) {
      const snapshotBeforeStop = sessionManager.getSession(agent.activeSessionId);
      sessionManager.killSession(agent.activeSessionId);
      appendAgentMemoryFromSession(id, snapshotBeforeStop);
      agentStore.updateAgent(id, { activeSessionId: null });
    }
    const refreshed = agentStore.getAgent(id);
    try {
      const session = sessionManager.createSession(
        refreshed.name,
        refreshed.workingDir,
        refreshed.cliType,
        {},
        refreshed.role || '',
        { agentId: refreshed.id }
      );
      const updatedAgent = agentStore.updateAgent(id, {
        activeSessionId: session.id,
        lastActiveAt: new Date().toISOString(),
        sessionHistory: [...(refreshed.sessionHistory || []), session.id]
      });
      const liveSession = sessionManager.sessions.get(session.id);
      if (liveSession) {
        sessionManager.runStartupSequence(liveSession, updatedAgent || refreshed);
      }
      broadcastDashboard({ type: 'agentUpdated', agent: updatedAgent || refreshed });
      return { session, agent: updatedAgent || refreshed };
    } catch (error) {
      return reply.status(500).send({ error: error.message });
    }
  });

  app.post('/api/agents/:id/rewarm', async (request, reply) => {
    const { id } = request.params;
    const agent = agentStore.getAgent(id);
    if (!agent || !agent.activeSessionId) {
      return reply.status(404).send({ error: 'Agent or active session not found' });
    }
    const snapshot = sessionManager.getSession(agent.activeSessionId);
    if (snapshot?.status === 'paused') {
      sessionManager.resumeSession(agent.activeSessionId);
    }
    const ok = sessionManager.rewarmSession(agent.activeSessionId, agent);
    if (!ok) {
      return reply.status(400).send({ error: 'Could not re-warm agent session' });
    }
    return { success: true };
  });

  // List all sessions
  app.get('/api/sessions', async () => {
    return { sessions: sessionManager.getAllSessions() };
  });

  // Create a new session
  app.post('/api/sessions', async (request, reply) => {
    const { name, workingDir, cliType, stage, priority, description, role } = request.body || {};
    const normalizedRole = normalizeRoleInput(role);
    if (normalizedRole.error) {
      return reply.status(400).send({ error: normalizedRole.error });
    }

    // Validate cliType
    const validCliTypes = ['claude', 'codex', 'terminal'];
    const normalizedCliType = cliType && validCliTypes.includes(cliType) ? cliType : 'claude';
    const normalizedName = typeof name === 'string' ? name.trim() : '';
    const existingNames = sessionManager.getAllSessions().map(s => s.name);
    const resolvedName = normalizedName || ensureUniqueSessionName(generateSessionName(new Date(), normalizedCliType), existingNames);

    try {
      const session = sessionManager.createSession(resolvedName, workingDir, normalizedCliType, {
        stage: stage || 'todo',
        priority: priority || 0,
        description: description || ''
      }, normalizedRole.value);

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
      return { folders, base: requestedBase, root, defaultRoot: root };
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
    const { name, notes, tags, cliType, role } = request.body || {};
    const normalizedRole = normalizeRoleInput(role);
    if (normalizedRole.error) {
      return reply.status(400).send({ error: normalizedRole.error });
    }

    const session = sessionManager.updateSessionMeta(id, {
      name,
      notes,
      tags,
      cliType,
      role: role === undefined ? undefined : normalizedRole.value
    });

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
      // Session not in memory — try cleaning from dataStore (orphaned entry)
      const cleaned = sessionManager.dataStore.deleteSession(id);
      if (cleaned) {
        sessionManager.emit('sessionKilled', { sessionId: id, session: { id } });
        return { success: true };
      }
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
    const { fresh } = request.body || {};
    const success = sessionManager.resumeSession(id, { fresh: !!fresh });

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

    const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const safeName = (name || 'pasted-plan').replace(/[^a-zA-Z0-9-_]/g, '-').slice(0, 40);
    const filename = `${safeName}-${timestamp}.md`;
    const session = sessionId ? sessionManager.getSession(sessionId) : null;
    const useProjectPlans = Boolean(
      session &&
      (session.cliType === 'codex' || session.cliType === 'terminal') &&
      session.workingDir
    );
    const plansDir = useProjectPlans
      ? path.join(session.workingDir, 'plans')
      : path.join(os.homedir(), '.claude', 'plans');
    const scope = useProjectPlans ? 'project' : 'claude-home';

    if (!fs.existsSync(plansDir)) {
      fs.mkdirSync(plansDir, { recursive: true });
    }

    const planPath = path.join(plansDir, filename);
    fs.writeFileSync(planPath, content, 'utf8');

    // Bootstrap into versioning system so PlanViewer shows toolbar + Save button
    planVersionStore.markDirty(planPath, content);
    planVersionStore.createVersion(planPath);

    if (sessionId) {
      sessionManager.addOrUpdatePlanInSession(sessionId, planPath);
    }

    return { success: true, path: planPath, filename, scope };
  });

  // List plans not yet associated with a session
  app.get('/api/sessions/:id/available-plans', async (request, reply) => {
    const { id } = request.params;
    const session = sessionManager.getSession(id);

    if (!session) {
      return reply.status(404).send({ error: 'Session not found' });
    }

    const plansByPath = new Map();
    const sessionPlans = session.plans || [];

    for (const plan of planManager.listPlans()) {
      plansByPath.set(normalizePathKey(plan.path), plan);
    }

    if ((session.cliType === 'codex' || session.cliType === 'terminal') && session.workingDir) {
      for (const plan of listProjectPlans(session.workingDir)) {
        plansByPath.set(normalizePathKey(plan.path), plan);
      }
    }

    const sessionPlanKeys = new Set(sessionPlans.map((planPath) => normalizePathKey(planPath)));
    const available = [...plansByPath.values()]
      .filter((plan) => !sessionPlanKeys.has(normalizePathKey(plan.path)))
      .sort((a, b) => new Date(b.modifiedAt) - new Date(a.modifiedAt));
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
    // Sanitize to prevent path traversal (e.g. ../../etc/passwd)
    const safeVersionFilename = path.basename(versionFilename);
    if (!safeVersionFilename.endsWith('.md') && !safeVersionFilename.endsWith('.meta.json')) {
      return reply.status(403).send({ error: 'Invalid version filename' });
    }

    const planPath = planManager.getPlanPath(filename);

    if (!planPath) {
      return reply.status(404).send({ error: 'Plan not found' });
    }

    const planDir = planVersionStore.getPlanDir(planPath);
    const versionPath = path.join(planDir, safeVersionFilename);
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

  // Save a plan version to the project's plans/ directory
  app.post('/api/plans/save', async (request, reply) => {
    const { content, title, versionNumber, versionDate, workingDir } = request.body || {};

    if (!content || !content.trim()) {
      return reply.status(400).send({ error: 'Plan content is required' });
    }
    if (!workingDir) {
      return reply.status(400).send({ error: 'workingDir is required' });
    }

    // Validate workingDir exists and is a real directory
    const resolvedDir = path.resolve(workingDir);
    if (!fs.existsSync(resolvedDir) || !fs.statSync(resolvedDir).isDirectory()) {
      return reply.status(400).send({ error: 'workingDir must be an existing directory' });
    }
    const realDir = fs.realpathSync(resolvedDir);

    const safeTitle = (title || 'plan').replace(/[^a-zA-Z0-9-_ ]/g, '').replace(/\s+/g, '-').slice(0, 60);
    const versionLabel = versionNumber ? `v${versionNumber}` : 'current';
    const dateStr = versionDate
      ? new Date(versionDate).toISOString().replace(/[:.]/g, '-').slice(0, 16)
      : new Date().toISOString().replace(/[:.]/g, '-').slice(0, 16);
    const filename = `${safeTitle}_${versionLabel}_${dateStr}.md`;

    const plansDir = path.join(realDir, 'plans');
    if (!fs.existsSync(plansDir)) {
      fs.mkdirSync(plansDir, { recursive: true });
    }

    const planPath = path.join(plansDir, filename);
    fs.writeFileSync(planPath, content, 'utf8');

    return { success: true, path: planPath, filename };
  });

  // List saved plans in a project's plans/ directory
  app.get('/api/saved-plans', async (request, reply) => {
    const { workingDir } = request.query;
    if (!workingDir) {
      return reply.status(400).send({ error: 'workingDir query param is required' });
    }

    const plansDir = path.join(workingDir, 'plans');
    if (!fs.existsSync(plansDir)) {
      return { plans: [] };
    }

    try {
      const files = fs.readdirSync(plansDir).filter(f => f.endsWith('.md'));
      const plans = files.map(filename => {
        const filePath = path.join(plansDir, filename);
        const stat = fs.statSync(filePath);
        const content = fs.readFileSync(filePath, 'utf8');
        // Extract title from first h1 heading
        const titleMatch = content.match(/^#\s+(.+)$/m);
        const name = titleMatch ? titleMatch[1] : filename.replace(/\.md$/, '');
        return {
          filename,
          name,
          path: filePath,
          content,
          modifiedAt: stat.mtime.toISOString(),
          size: stat.size
        };
      });
      plans.sort((a, b) => new Date(b.modifiedAt) - new Date(a.modifiedAt));
      return { plans };
    } catch (error) {
      return reply.status(500).send({ error: `Failed to read plans: ${error.message}` });
    }
  });

  // Receive Claude Code lifecycle hook events (Stop, UserPromptSubmit, PreToolUse)
  // Hook script (backend/claude-hook.js) POSTs the JSON payload from stdin here.
  app.post('/api/hook-event', async (request, reply) => {
    const { hook_event_name, cwd, transcript_path } = request.body || {};
    if (!hook_event_name || !cwd) return reply.send({ ok: false });

    // Extract claudeSessionId from transcript filename: .../abc123.jsonl → abc123
    const claudeSessionId = transcript_path
      ? path.basename(transcript_path, '.jsonl')
      : null;

    const statusMap = {
      Stop: 'idle',
      UserPromptSubmit: 'active',
      PreToolUse: 'editing',
    };
    const status = statusMap[hook_event_name];
    if (!status) return reply.send({ ok: true });

    sessionManager.applyHookStatus({ cwd, claudeSessionId, status, hookEvent: hook_event_name });
    return reply.send({ ok: true });
  });

  // Open a file or folder in the OS default application
  app.post('/api/open-path', async (request, reply) => {
    const { execFile } = require('child_process');
    const { filePath } = request.body || {};
    if (!filePath) return reply.status(400).send({ error: 'filePath is required' });

    // Validate path exists before opening
    const resolved = path.resolve(filePath);
    if (!fs.existsSync(resolved)) {
      return reply.status(404).send({ error: 'Path not found' });
    }

    try {
      if (process.platform === 'win32') {
        // Use explorer.exe directly — no cmd.exe shell parsing
        execFile('explorer.exe', [resolved]);
      } else if (process.platform === 'darwin') {
        execFile('open', [resolved]);
      } else {
        execFile('xdg-open', [resolved]);
      }
      return reply.send({ success: true });
    } catch (err) {
      return reply.status(500).send({ error: err.message });
    }
  });

  // Delete a saved plan
  app.delete('/api/saved-plans', async (request, reply) => {
    const { path: filePath } = request.query;
    if (!filePath) {
      return reply.status(400).send({ error: 'path query param is required' });
    }

    // Security: resolve symlinks, only allow .md files inside plans/ directories
    const normalized = path.resolve(filePath);
    if (!normalized.endsWith('.md')) {
      return reply.status(403).send({ error: 'Can only delete .md files' });
    }

    try {
      if (!fs.existsSync(normalized)) return { success: true };
      // Resolve symlinks to get real path before checking parent
      const realPath = fs.realpathSync(normalized);
      const parentDir = path.basename(path.dirname(realPath));
      if (parentDir !== 'plans') {
        return reply.status(403).send({ error: 'Can only delete files in plans/ directories' });
      }
      fs.unlinkSync(realPath);
      return { success: true };
    } catch (error) {
      return reply.status(500).send({ error: `Failed to delete: ${error.message}` });
    }
  });

  // Get recent git commits for a working directory
  app.get('/api/git-commits', async (request, reply) => {
    const { execFile } = require('child_process');
    const { promisify } = require('util');
    const execFileAsync = promisify(execFile);

    const { workingDir, limit = '20' } = request.query;
    if (!workingDir) {
      return reply.status(400).send({ error: 'workingDir query param is required' });
    }

    // Check if directory is a git repo
    try {
      await execFileAsync('git', ['rev-parse', '--is-inside-work-tree'], {
        cwd: workingDir,
        timeout: 5000
      });
    } catch {
      return { commits: [], isGitRepo: false };
    }

    // Fetch commits (use record separator %x1e between commits to handle multi-line bodies)
    try {
      const n = Math.max(1, Math.min(parseInt(limit, 10) || 20, 100));
      const { stdout } = await execFileAsync('git', [
        'log', '--format=%H%x00%s%x00%b%x00%aI%x1e', `-n`, `${n}`
      ], { cwd: workingDir, timeout: 5000 });

      if (!stdout.trim()) {
        return { commits: [], isGitRepo: true };
      }

      const commits = stdout.split('\x1e')
        .map(record => record.trim())
        .filter(record => record.length > 0)
        .map(record => {
          const parts = record.split('\0');
          return {
            hash: parts[0] ? parts[0].substring(0, 7) : '',
            fullHash: parts[0] || '',
            subject: parts[1] || '',
            body: (parts[2] || '').trim(),
            date: parts[3] || ''
          };
        });

      return { commits, isGitRepo: true };
    } catch {
      return { commits: [], isGitRepo: true };
    }
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

  // Install Claude Code lifecycle hooks into ~/.claude/settings.json
  // so that Stop/UserPromptSubmit/PreToolUse events are forwarded to CLIOverlord.
  app.post('/api/settings/install-hooks', async (request, reply) => {
    const scriptPath = path.resolve(__dirname, 'claude-hook.js');
    const settingsPath = path.join(os.homedir(), '.claude', 'settings.json');

    // Ensure ~/.claude/ exists
    const claudeDir = path.join(os.homedir(), '.claude');
    if (!fs.existsSync(claudeDir)) {
      fs.mkdirSync(claudeDir, { recursive: true });
    }

    // Read existing settings non-destructively
    let existing = {};
    if (fs.existsSync(settingsPath)) {
      try {
        existing = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
      } catch (e) {
        return reply.status(500).send({ error: `Failed to parse existing settings: ${e.message}` });
      }
    }

    // Build hook command using node with the absolute script path
    const command = `node "${scriptPath}"`;
    const makeEntry = () => [{
      hooks: [{ type: 'command', command, timeout: 5 }]
    }];

    existing.hooks = existing.hooks || {};
    existing.hooks.Stop = makeEntry();
    existing.hooks.UserPromptSubmit = makeEntry();
    existing.hooks.PreToolUse = makeEntry();

    fs.writeFileSync(settingsPath, JSON.stringify(existing, null, 2), 'utf8');
    return { ok: true, settingsPath, events: ['Stop', 'UserPromptSubmit', 'PreToolUse'] };
  });

  // Check if Claude Code hooks are currently installed
  app.get('/api/settings/hooks-status', async () => {
    const settingsPath = path.join(os.homedir(), '.claude', 'settings.json');
    if (!fs.existsSync(settingsPath)) return { installed: false };
    try {
      const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
      const hooks = settings.hooks || {};
      const installed = !!(hooks.Stop && hooks.UserPromptSubmit && hooks.PreToolUse);
      return { installed, hooks: Object.keys(hooks) };
    } catch {
      return { installed: false };
    }
  });

  // Remove CLIOverlord hooks from ~/.claude/settings.json
  app.post('/api/settings/uninstall-hooks', async (request, reply) => {
    const settingsPath = path.join(os.homedir(), '.claude', 'settings.json');
    if (!fs.existsSync(settingsPath)) return { ok: true };

    try {
      const existing = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
      if (existing.hooks) {
        delete existing.hooks.Stop;
        delete existing.hooks.UserPromptSubmit;
        delete existing.hooks.PreToolUse;
        if (Object.keys(existing.hooks).length === 0) delete existing.hooks;
      }
      fs.writeFileSync(settingsPath, JSON.stringify(existing, null, 2), 'utf8');
      return { ok: true };
    } catch (e) {
      return reply.status(500).send({ error: e.message });
    }
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

  // Lock session to current column
  app.post('/api/sessions/:id/lock-placement', async (request, reply) => {
    const { id } = request.params;

    try {
      const session = sessionManager.lockPlacement(id);
      return { session };
    } catch (error) {
      if (error.message.includes('not found')) {
        return reply.status(404).send({ error: error.message });
      }
      return reply.status(500).send({ error: error.message });
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

  // Task cards API (first-class task entities)
  app.get('/api/tasks', async () => {
    return { tasks: taskStore.listTasks() };
  });

  app.post('/api/tasks', async (request, reply) => {
    const body = request.body || {};
    if (!body.title || !String(body.title).trim()) {
      return reply.status(400).send({ error: 'title is required' });
    }
    const task = taskStore.createTask({
      title: String(body.title),
      description: typeof body.description === 'string' ? body.description : '',
      planContent: typeof body.planContent === 'string' ? body.planContent : '',
      assignedAgents: normalizeStringArray(body.assignedAgents),
      stage: typeof body.stage === 'string' ? body.stage : 'todo',
      priority: Number.isFinite(body.priority) ? body.priority : 0,
      blockedBy: normalizeStringArray(body.blockedBy),
      blocks: normalizeStringArray(body.blocks)
    });
    broadcastDashboard({ type: 'taskUpdated', task });
    return reply.status(201).send({ task });
  });

  app.get('/api/tasks/:id', async (request, reply) => {
    const task = taskStore.getTask(request.params.id);
    if (!task) return reply.status(404).send({ error: 'Task not found' });
    return { task };
  });

  app.patch('/api/tasks/:id', async (request, reply) => {
    const task = taskStore.updateTask(request.params.id, request.body || {});
    if (!task) return reply.status(404).send({ error: 'Task not found' });
    broadcastDashboard({ type: 'taskUpdated', task });
    return { task };
  });

  app.delete('/api/tasks/:id', async (request, reply) => {
    const task = taskStore.deleteTask(request.params.id);
    if (!task) return reply.status(404).send({ error: 'Task not found' });
    broadcastDashboard({ type: 'taskUpdated', task });
    return { task };
  });

  app.post('/api/tasks/:id/assign', async (request, reply) => {
    const { assignedAgents } = request.body || {};
    const task = taskStore.updateTask(request.params.id, { assignedAgents: normalizeStringArray(assignedAgents) });
    if (!task) return reply.status(404).send({ error: 'Task not found' });
    broadcastDashboard({ type: 'taskUpdated', task });
    return { task };
  });

  app.post('/api/tasks/:id/start-run', async (request, reply) => {
    const task = taskStore.getTask(request.params.id);
    if (!task || task.archivedAt) return reply.status(404).send({ error: 'Task not found' });

    const { agentId } = request.body || {};
    if (!agentId || typeof agentId !== 'string') {
      return reply.status(400).send({ error: 'agentId is required' });
    }

    const agent = agentStore.getAgent(agentId);
    if (!agent || agent.deletedAt) {
      return reply.status(404).send({ error: 'Agent not found' });
    }

    // Build task context to send to agent
    const taskContext = {
      title: task.title || '',
      description: task.description || '',
      comments: (task.comments || []).slice(-5).map(c => ({
        author: c.author || 'unknown',
        text: (c.text || '').slice(0, 500)
      }))
    };

    let session = null;
    let createdNewSession = false;
    if (agent.activeSessionId) {
      session = sessionManager.getSession(agent.activeSessionId);
    }

    if (!session || session.status === 'completed') {
      try {
        const created = sessionManager.createSession(
          agent.name,
          agent.workingDir,
          agent.cliType,
          {},
          agent.role || '',
          { agentId: agent.id, taskId: task.id }
        );
        session = created;
        createdNewSession = true;
        const updatedAgent = agentStore.updateAgent(agent.id, {
          activeSessionId: created.id,
          lastActiveAt: new Date().toISOString(),
          sessionHistory: [...(agent.sessionHistory || []), created.id]
        });
        if (updatedAgent) {
          broadcastDashboard({ type: 'agentUpdated', agent: updatedAgent });
        }
      } catch (error) {
        return reply.status(500).send({ error: error.message });
      }
    } else {
      const updatedSession = sessionManager.updateSessionMeta(session.id, { taskId: task.id });
      if (updatedSession) {
        session = updatedSession;
      }
    }

    // Inject task context into agent session
    if (createdNewSession) {
      // Task context will be appended to startup sequence
      sessionManager.appendTaskContext(session.id, taskContext);
    } else {
      // Session already running - send task context directly
      const instruction = `You have been assigned a new task:\n\nTitle: ${taskContext.title}` +
        (taskContext.description ? `\n\nDescription:\n${taskContext.description}` : '') +
        `\n\nPlease begin working on this task.\r`;
      sessionManager.sendInput(session.id, instruction);
    }

    const freshTask = taskStore.getTask(task.id);
    const existingRun = getActiveRunForAgent(freshTask, agent.id);
    if (!existingRun || existingRun.sessionId !== session.id) {
      taskStore.appendRun(task.id, {
        sessionId: session.id,
        agentId: agent.id,
        startedAt: new Date().toISOString(),
        status: 'active'
      });
    }

    const taskWithRun = taskStore.getTask(task.id);
    broadcastDashboard({ type: 'taskUpdated', task: taskWithRun });
    return { task: taskWithRun, session };
  });

  app.post('/api/tasks/:id/stop-run', async (request, reply) => {
    const task = taskStore.getTask(request.params.id);
    if (!task || task.archivedAt) return reply.status(404).send({ error: 'Task not found' });

    const { agentId } = request.body || {};
    if (!agentId || typeof agentId !== 'string') {
      return reply.status(400).send({ error: 'agentId is required' });
    }

    const agent = agentStore.getAgent(agentId);
    if (!agent || agent.deletedAt) {
      return reply.status(404).send({ error: 'Agent not found' });
    }

    const activeRun = getActiveRunForAgent(task, agent.id);
    const targetSessionId = activeRun?.sessionId || null;
    if (!targetSessionId) {
      return reply.status(400).send({ error: 'No active run for this agent on this task' });
    }

    const session = sessionManager.getSession(targetSessionId);
    if (session && session.status !== 'completed' && session.status !== 'killed') {
      sessionManager.killSession(targetSessionId);
    }

    taskStore.closeRun(task.id, {
      sessionId: targetSessionId,
      agentId: agent.id,
      endedAt: new Date().toISOString(),
      status: 'stopped'
    });

    const updatedTask = taskStore.getTask(task.id);
    broadcastDashboard({ type: 'taskUpdated', task: updatedTask });
    return { task: updatedTask };
  });

  app.post('/api/tasks/:id/comments', async (request, reply) => {
    const body = request.body || {};
    const text = typeof body.text === 'string' ? body.text.trim() : '';
    if (!text) return reply.status(400).send({ error: 'Comment text is required' });
    const mentions = resolveMentionAgentIds(text, body.mentions);
    const comment = taskStore.addComment(request.params.id, {
      author: body.author || 'user',
      text,
      mentions
    });
    if (!comment) return reply.status(404).send({ error: 'Task not found' });

    const delivered = [];
    const skipped = [];

    // Mention delivery: prefer active run linked to this task, fall back to active agent session.
    for (const agentId of mentions) {
      const agent = agentStore.getAgent(agentId);
      if (!agent) {
        skipped.push({ agentId, reason: 'agent_not_found' });
        continue;
      }
      let targetSessionId = null;
      const activeRun = getActiveRunForAgent(taskStore.getTask(request.params.id), agent.id);
      if (activeRun?.sessionId) {
        targetSessionId = activeRun.sessionId;
      } else if (agent.activeSessionId) {
        targetSessionId = agent.activeSessionId;
      }
      if (!targetSessionId) {
        skipped.push({ agentId, reason: 'no_active_session' });
        continue;
      }
      const instruction = `[Task mention] ${text}\nPlease acknowledge and execute this instruction if applicable.\r`;
      const ok = sessionManager.sendInput(targetSessionId, instruction);
      if (ok) {
        delivered.push({ agentId, sessionId: targetSessionId });
      } else {
        skipped.push({ agentId, reason: 'input_rejected', sessionId: targetSessionId });
      }
    }

    const task = taskStore.getTask(request.params.id);
    broadcastDashboard({ type: 'taskUpdated', task });
    return { comment, task, delivered, skipped };
  });

  app.post('/api/tasks/:id/auto-comment', async (request, reply) => {
    const body = request.body || {};
    const text = typeof body.text === 'string' ? body.text.trim() : '';
    if (!text) return reply.status(400).send({ error: 'Comment text is required' });
    const comment = taskStore.addComment(request.params.id, {
      author: body.author || 'agent',
      text,
      mentions: normalizeStringArray(body.mentions)
    });
    if (!comment) return reply.status(404).send({ error: 'Task not found' });
    const task = taskStore.getTask(request.params.id);
    broadcastDashboard({ type: 'taskUpdated', task });
    return { comment, task };
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
        sessions: sessionManager.getAllSessions(),
        agents: agentStore.listAgents(),
        tasks: taskStore.listTasks()
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
            const replay = prepareTerminalReplayPayload(output);
            socket.send(JSON.stringify({
              type: 'output',
              data: replay.data
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

  const clearActiveSessionFromAgents = (sessionId) => {
    const agents = agentStore.listAgents({ includeDeleted: true });
    for (const agent of agents) {
      if (agent.activeSessionId === sessionId) {
        const updated = agentStore.updateAgent(agent.id, {
          activeSessionId: null,
          lastActiveAt: new Date().toISOString()
        });
        if (updated) {
          broadcastDashboard({ type: 'agentUpdated', agent: updated });
        }
      }
    }
  };

  const appendAgentMemoryFromSession = (agentId, sessionSnapshot) => {
    if (!agentId || !sessionSnapshot) return;
    const agent = agentStore.getAgent(agentId);
    if (!agent || agent.memoryEnabled === false) return;
    const history = Array.isArray(sessionSnapshot.promptHistory) ? sessionSnapshot.promptHistory : [];
    const latest = history.slice(-3).map((entry) => entry?.text).filter(Boolean);
    if (latest.length === 0) return;
    const memory = [...(agent.memory || []), ...latest.map((text) => `Session ${sessionSnapshot.id.slice(0, 8)}: ${text.slice(0, 180)}`)];
    const deduped = [...new Set(memory)].slice(-50);
    const updated = agentStore.updateAgent(agent.id, { memory: deduped });
    if (updated) {
      broadcastDashboard({ type: 'agentUpdated', agent: updated });
    }
  };

  const closeTaskRunForSession = (sessionSnapshot, status = 'completed') => {
    if (!sessionSnapshot?.taskId || !sessionSnapshot?.id) return;
    const closed = taskStore.closeRun(sessionSnapshot.taskId, {
      sessionId: sessionSnapshot.id,
      agentId: sessionSnapshot.agentId || null,
      endedAt: new Date().toISOString(),
      status
    });
    if (!closed) return;
    const updatedTask = taskStore.getTask(sessionSnapshot.taskId);
    if (updatedTask) {
      broadcastDashboard({ type: 'taskUpdated', task: updatedTask });
    }
  };

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

    const session = sessionManager.getSession(sessionId);
    if (session?.agentId) {
      const agent = agentStore.getAgent(session.agentId);
      if (agent) {
        const updated = agentStore.updateAgent(agent.id, {
          activeSessionId: sessionId,
          lastActiveAt: new Date().toISOString()
        });
        if (updated) {
          broadcastDashboard({ type: 'agentUpdated', agent: updated });
        }

        if (status === 'idle') {
          const tasks = taskStore.listTasks().filter((task) => (task.assignedAgents || []).includes(agent.id));
          for (const task of tasks) {
            taskStore.addComment(task.id, {
              author: agent.id,
              text: `Auto-update: ${agent.name} reached idle state on session ${sessionId.slice(0, 8)}.`,
              mentions: []
            });
            const updatedTask = taskStore.getTask(task.id);
            if (updatedTask) {
              broadcastDashboard({ type: 'taskUpdated', task: updatedTask });
            }
          }
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
  sessionManager.on('sessionKilled', ({ sessionId, session }) => {
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
    closeTaskRunForSession(session, 'killed');
    clearActiveSessionFromAgents(sessionId);
    if (session?.agentId) {
      const ended = taskStore.endRunsByAgent(session.agentId, 'killed');
      for (const { taskId } of ended) {
        const t = taskStore.getTask(taskId);
        if (t) broadcastDashboard({ type: 'taskUpdated', task: t });
      }
    }
  });

  // Broadcast session ended to clients
  sessionManager.on('sessionEnded', ({ sessionId, session }) => {
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
      clearTimeout(kanbanSyncTimers.get(sessionId)?.timer);
      kanbanSyncTimers.delete(sessionId);
    }
    closeTaskRunForSession(session, 'completed');
    clearActiveSessionFromAgents(sessionId);
    appendAgentMemoryFromSession(session?.agentId, session);
    if (session?.agentId) {
      const ended = taskStore.endRunsByAgent(session.agentId, 'completed');
      for (const { taskId } of ended) {
        const t = taskStore.getTask(taskId);
        if (t) broadcastDashboard({ type: 'taskUpdated', task: t });
      }
    }
  });

  // Clear debounce timer on session kill
  sessionManager.on('sessionKilled', ({ sessionId }) => {
    if (kanbanSyncTimers.has(sessionId)) {
      clearTimeout(kanbanSyncTimers.get(sessionId)?.timer);
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
  // kanbanSyncTimers values: { timer, targetStage } — tracks pending target
  // so repeated events for the same target don't restart the debounce window.
  // Hook-sourced events use a shorter debounce since they're authoritative signals.
  sessionManager.on('statusChange', ({ sessionId, status, source }) => {
    const existing = kanbanSyncTimers.get(sessionId);

    // Codex mid-work approvals: don't auto-move to in_review
    const session = sessionManager.getSession(sessionId);
    if (session?.cliType === 'codex' && status === 'waiting') {
      if (existing) clearTimeout(existing.timer);
      kanbanSyncTimers.delete(sessionId);
      return;
    }

    // Don't auto-move sessions out of 'todo' until user has submitted input
    if (session?.stage === 'todo' && !session?.lastSubmittedInputAtMs) {
      if (existing) clearTimeout(existing.timer);
      kanbanSyncTimers.delete(sessionId);
      return;
    }

    const targetStage = sessionStatusToStage(status);
    if (!targetStage) {
      if (existing) clearTimeout(existing.timer);
      kanbanSyncTimers.delete(sessionId);
      return;
    }

    // Don't auto-move on 'active' when already in_progress (prevents jitter from redraws).
    // But DO allow 'active' to move back to in_progress from other stages (e.g. in_review).
    if (status === 'active' && targetStage === 'in_progress') {
      const sess = sessionManager.getSession(sessionId);
      if (sess?.stage === 'in_progress') {
        return;
      }
    }

    // KEY FIX: If a timer is already pending for the SAME target stage,
    // let it fire — don't restart the debounce window. This prevents
    // continuous streaming output from indefinitely resetting the timer.
    if (existing && existing.targetStage === targetStage) {
      return;
    }

    // Don't let brief thinking flickers cancel a pending in_review timer.
    // When a session is waiting for user input (plan approval), transient
    // "thinking" status from cursor animation should not reset the move.
    // Sustained real work will create a new in_progress timer after in_review fires.
    if (existing && existing.targetStage === 'in_review' && targetStage === 'in_progress') {
      return;
    }

    // Different target or no existing timer — (re)start debounce
    if (existing) clearTimeout(existing.timer);

    // Hook-sourced events are authoritative — use short debounce (200ms).
    // PTY regex-based events use 3s debounce for stability.
    const delay = source === 'hook' ? 200 : 3000;
    const timer = setTimeout(() => {
      kanbanSyncTimers.delete(sessionId);
      try {
        sessionManager.moveSession(sessionId, targetStage, { source: 'auto' });
      } catch (err) {
        console.error(`Auto-sync stage failed for session ${sessionId}:`, err.message);
      }
    }, delay);

    kanbanSyncTimers.set(sessionId, { timer, targetStage });
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

          // Notify sessions that reference this plan so frontend re-fetches content
          const normalizedPlanPath = planPath.replace(/\\/g, '/').toLowerCase();
          const normalizedFilename = plan.filename.toLowerCase();
          for (const s of sessionManager.getAllSessions()) {
            const refs = s.plans || [];
            const match = refs.some(p => {
              const np = (p || '').replace(/\\/g, '/').toLowerCase();
              return np === normalizedPlanPath || np === normalizedFilename || np.endsWith('/' + normalizedFilename);
            });
            if (match) {
              sessionManager.emit('sessionUpdated', { id: s.id, plansUpdatedAt: Date.now() });
            }
          }
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
  const host = '127.0.0.1';
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

const fastify = require('fastify');
const fastifyWebsocket = require('@fastify/websocket');
const fastifyStatic = require('@fastify/static');
const fastifyCors = require('@fastify/cors');
const path = require('path');
const fs = require('fs');
const SessionManager = require('./sessionManager');
const PlanManager = require('./planManager');
const SettingsManager = require('./settingsManager');

const app = fastify({ logger: true });
const sessionManager = new SessionManager();
const planManager = new PlanManager();
const settingsManager = new SettingsManager();

// Track WebSocket connections
const dashboardClients = new Set();
const terminalClients = new Map(); // sessionId -> Set of clients

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
    const { name, workingDir, cliType } = request.body || {};

    if (!name || typeof name !== 'string' || name.trim() === '') {
      return reply.status(400).send({ error: 'Session name is required' });
    }

    // Validate cliType
    const validCliTypes = ['claude', 'codex'];
    const normalizedCliType = cliType && validCliTypes.includes(cliType) ? cliType : 'claude';

    try {
      const session = sessionManager.createSession(name.trim(), workingDir, normalizedCliType);
      return reply.status(201).send({ session });
    } catch (error) {
      return reply.status(500).send({ error: error.message });
    }
  });

  // List folders in a directory (for folder picker)
  app.get('/api/folders', async (request, reply) => {
    const base = request.query.base || 'C:\\Users\\denni\\apps';

    try {
      const entries = fs.readdirSync(base, { withFileTypes: true });
      const folders = entries
        .filter(e => e.isDirectory())
        .map(e => e.name)
        .sort();
      return { folders };
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
    const { name, notes, tags } = request.body || {};

    const session = sessionManager.updateSessionMeta(id, { name, notes, tags });

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

start();

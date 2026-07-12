function registerRecoveryRoutes(app, { sessionManager }) {
  app.get('/api/sessions/recovery-summary', async (request, reply) => {
    try {
      return await sessionManager.prepareRecoverySummary();
    } catch (error) {
      return reply.status(500).send({ error: `Could not prepare session recovery: ${error.message}` });
    }
  });

  app.post('/api/sessions/recover', async (request, reply) => {
    const sessionIds = request.body?.sessionIds;
    if (!Array.isArray(sessionIds)) {
      return reply.status(400).send({ error: 'sessionIds must be an array' });
    }
    if (sessionIds.length > 100) {
      return reply.status(400).send({ error: 'At most 100 sessions can be recovered at once' });
    }
    if (sessionIds.some((id) => typeof id !== 'string' || !id.trim())) {
      return reply.status(400).send({ error: 'Every recovery session ID must be a non-empty string' });
    }

    try {
      return await sessionManager.recoverSessions(sessionIds);
    } catch (error) {
      return reply.status(500).send({ error: `Could not recover sessions: ${error.message}` });
    }
  });
}

module.exports = registerRecoveryRoutes;

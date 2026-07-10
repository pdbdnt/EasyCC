function registerCodexResumeRoutes(app, { sessionManager }) {
  app.get('/api/codex/resume-catalog', async (request, reply) => {
    try {
      return await sessionManager.getCodexResumeCatalog(request.query || {});
    } catch (error) {
      return reply.status(500).send({ error: `Could not load Codex history: ${error.message}` });
    }
  });

  app.post('/api/codex/resume-selection', async (request, reply) => {
    const selections = request.body?.selections;
    if (!Array.isArray(selections) || selections.length === 0) {
      return reply.status(400).send({ error: 'Select at least one Codex conversation' });
    }
    if (selections.length > 100) {
      return reply.status(400).send({ error: 'At most 100 conversations can be resumed at once' });
    }
    const malformed = selections.some((selection) =>
      !selection || typeof selection.codexSessionId !== 'string' ||
      (selection.easyccSessionId !== undefined && typeof selection.easyccSessionId !== 'string')
    );
    if (malformed) {
      return reply.status(400).send({ error: 'Each selection requires a Codex session ID' });
    }

    try {
      const result = await sessionManager.resumeCodexSelections(selections);
      return reply.status(202).send(result);
    } catch (error) {
      return reply.status(500).send({ error: `Could not resume Codex conversations: ${error.message}` });
    }
  });
}

module.exports = registerCodexResumeRoutes;

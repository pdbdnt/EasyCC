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
    const targetEasyccSessionId = request.body?.easyccSessionId || '';
    const historyRuntime = request.body?.historyRuntime || '';
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
    if (targetEasyccSessionId && typeof targetEasyccSessionId !== 'string') {
      return reply.status(400).send({ error: 'EasyCC session ID must be a string' });
    }
    if (historyRuntime && !['wsl', 'windows'].includes(historyRuntime)) {
      return reply.status(400).send({ error: 'Codex history runtime must be wsl or windows' });
    }
    if (!targetEasyccSessionId && !historyRuntime) {
      return reply.status(400).send({ error: 'Codex history runtime is required' });
    }
    if (targetEasyccSessionId && selections.length !== 1) {
      return reply.status(400).send({ error: 'Choose exactly one conversation for this EasyCC card' });
    }
    if (targetEasyccSessionId && selections.some((selection) =>
      selection.easyccSessionId && selection.easyccSessionId !== targetEasyccSessionId
    )) {
      return reply.status(400).send({ error: 'Selection does not match the requested EasyCC card' });
    }

    try {
      const scopedSelections = targetEasyccSessionId
        ? selections.map((selection) => ({ ...selection, easyccSessionId: targetEasyccSessionId }))
        : selections;
      const options = {
        targetEasyccSessionId,
        ...(historyRuntime ? { historyRuntime } : {})
      };
      const result = await sessionManager.resumeCodexSelections(scopedSelections, options);
      return reply.status(202).send(result);
    } catch (error) {
      return reply.status(500).send({ error: `Could not resume Codex conversations: ${error.message}` });
    }
  });
}

module.exports = registerCodexResumeRoutes;

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const SessionManager = require('../backend/sessionManager');

function withCodexPlanFile(filename, content, fn) {
  const plansDir = path.join(os.homedir(), '.codex', 'plans');
  fs.mkdirSync(plansDir, { recursive: true });
  const planPath = path.join(plansDir, filename);
  assert.equal(fs.existsSync(planPath), false, `Test plan path already exists: ${planPath}`);
  fs.writeFileSync(planPath, content, 'utf8');
  try {
    return fn(planPath);
  } finally {
    fs.rmSync(planPath, { force: true });
  }
}

test('getSessionPlans keeps manually associated plans for terminal sessions even when workingDir text differs', () => {
  const sessionId = 'session-1';
  const planPath = '/tmp/project/plans/pasted-plan.md';
  const sessionManager = Object.create(SessionManager.prototype);

  sessionManager.sessions = new Map([
    [sessionId, {
      id: sessionId,
      cliType: 'terminal',
      workingDir: 'C:\\Users\\denni\\apps\\EasyCC',
      plans: [planPath]
    }]
  ]);

  sessionManager.planManager = {
    getPlanContent(requestedPath) {
      assert.equal(requestedPath, planPath);
      return {
        filename: 'pasted-plan.md',
        name: 'pasted plan',
        path: planPath,
        content: '# Plan',
        workingDir: '/home/denni/apps/EasyCC',
        modifiedAt: '2026-03-07T10:00:00.000Z'
      };
    }
  };

  const plans = sessionManager.getSessionPlans(sessionId);

  assert.equal(plans.length, 1);
  assert.equal(plans[0].path, planPath);
  assert.equal(plans[0].workingDir, '/home/denni/apps/EasyCC');
});

test('getSessionPlans merges Claude-tracked and manual plans without duplicates and sorts newest first', () => {
  const sessionId = 'session-2';
  const trackedPlanPath = '/tmp/project/plans/tracked-plan.md';
  const manualPlanPath = '/tmp/project/plans/manual-plan.md';
  const duplicateTrackedPath = trackedPlanPath;
  const sessionManager = Object.create(SessionManager.prototype);

  sessionManager.sessions = new Map([
    [sessionId, {
      id: sessionId,
      cliType: 'claude',
      claudeSessionId: 'claude-123',
      workingDir: 'C:\\Users\\denni\\apps\\EasyCC',
      plans: [manualPlanPath, duplicateTrackedPath]
    }]
  ]);

  sessionManager.planManager = {
    getPlansForClaudeSession(claudeSessionId, workingDir) {
      assert.equal(claudeSessionId, 'claude-123');
      assert.equal(workingDir, 'C:\\Users\\denni\\apps\\EasyCC');
      return [trackedPlanPath];
    },
    getPlanContent(requestedPath) {
      if (requestedPath === trackedPlanPath) {
        return {
          filename: 'tracked-plan.md',
          name: 'tracked plan',
          path: trackedPlanPath,
          modifiedAt: '2026-03-07T09:00:00.000Z'
        };
      }

      if (requestedPath === manualPlanPath) {
        return {
          filename: 'manual-plan.md',
          name: 'manual plan',
          path: manualPlanPath,
          modifiedAt: '2026-03-07T11:00:00.000Z'
        };
      }

      throw new Error(`Unexpected plan path: ${requestedPath}`);
    }
  };

  const plans = sessionManager.getSessionPlans(sessionId);

  assert.deepEqual(
    plans.map((plan) => plan.path),
    [manualPlanPath, trackedPlanPath]
  );
});

test('attachCodexPlansFromOutput associates exact Codex plan path with session', () => {
  withCodexPlanFile(`easycc-output-plan-${process.pid}.md`, '# Output Plan\n', (planPath) => {
    const sessionId = 'session-codex-output';
    const sessionManager = Object.create(SessionManager.prototype);
    const session = {
      id: sessionId,
      cliType: 'codex',
      workingDir: '/home/denni/apps/specsket',
      plans: []
    };

    sessionManager.sessions = new Map([[sessionId, session]]);
    sessionManager.dataStore = {
      addPlanToSession(id, requestedPath) {
        assert.equal(id, sessionId);
        assert.equal(requestedPath, planPath);
      }
    };
    sessionManager.emit = () => {};

    const attached = sessionManager.attachCodexPlansFromOutput(
      session,
      `Plan saved to: ${planPath}\n`
    );

    assert.deepEqual(attached, [planPath]);
    assert.deepEqual(session.plans, [planPath]);
  });
});

test('attachCodexPlansFromOutput associates WSL shell Codex plan path with only that session', () => {
  withCodexPlanFile(`easycc-wsl-output-plan-${process.pid}.md`, '# WSL Output Plan\n', (planPath) => {
    const sessionId = 'session-wsl-output';
    const otherSessionId = 'session-wsl-other';
    const sessionManager = Object.create(SessionManager.prototype);
    const session = {
      id: sessionId,
      cliType: 'wsl',
      workingDir: '/home/denni/apps/specsket',
      plans: []
    };
    const otherSession = {
      id: otherSessionId,
      cliType: 'wsl',
      workingDir: '/home/denni/apps/specsket',
      plans: []
    };

    sessionManager.sessions = new Map([[sessionId, session], [otherSessionId, otherSession]]);
    sessionManager.dataStore = {
      addPlanToSession(id, requestedPath) {
        assert.equal(id, sessionId);
        assert.equal(requestedPath, planPath);
      }
    };
    sessionManager.emit = () => {};

    const attached = sessionManager.attachCodexPlansFromOutput(
      session,
      `Plan saved to: ${planPath}\n`
    );

    assert.deepEqual(attached, [planPath]);
    assert.deepEqual(session.plans, [planPath]);
    assert.deepEqual(otherSession.plans, []);
  });
});

test('getSessionPlans backfills WSL terminal Codex plan paths from EasyCC transcript', () => {
  withCodexPlanFile(`easycc-wsl-terminal-backfill-plan-${process.pid}.md`, '# WSL Terminal Backfill Plan\n', (trackedPlanPath) => {
    const sessionId = 'session-wsl-terminal-backfill';
    const sessionManager = Object.create(SessionManager.prototype);
    const session = {
      id: sessionId,
      name: 'manual-codex-wsl',
      cliType: 'wsl',
      workingDir: '/home/denni/apps/specsket',
      plans: []
    };

    sessionManager.sessions = new Map([[sessionId, session]]);
    sessionManager.readSessionTerminalTranscriptText = (requestedSessionId) => {
      assert.equal(requestedSessionId, sessionId);
      return `Plan saved to: ${trackedPlanPath}\n`;
    };
    sessionManager.dataStore = {
      addPlanToSession(id, requestedPath) {
        assert.equal(id, sessionId);
        assert.equal(requestedPath, trackedPlanPath);
      }
    };
    sessionManager.emit = () => {};
    sessionManager.planManager = {
      getPlanContent(requestedPath) {
        assert.equal(requestedPath, trackedPlanPath);
        return {
          filename: path.basename(trackedPlanPath),
          name: 'wsl terminal backfill plan',
          path: trackedPlanPath,
          modifiedAt: '2026-05-20T12:00:00.000Z'
        };
      }
    };

    const plans = sessionManager.getSessionPlans(sessionId);

    assert.deepEqual(plans.map((plan) => plan.path), [trackedPlanPath]);
    assert.deepEqual(session.plans, [trackedPlanPath]);
  });
});

test('getSessionPlans includes Codex transcript plan paths and manual plans', () => {
  withCodexPlanFile(`easycc-transcript-plan-${process.pid}.md`, '# Transcript Plan\n', (trackedPlanPath) => {
    const manualPlanPath = '/tmp/project/plans/manual-codex-plan.md';
    const sessionId = 'session-codex-transcript';
    const sessionManager = Object.create(SessionManager.prototype);

    sessionManager.sessions = new Map([
      [sessionId, {
        id: sessionId,
        cliType: 'codex',
        codexSessionId: 'codex-123',
        workingDir: '/home/denni/apps/specsket',
        plans: [manualPlanPath]
      }]
    ]);
    sessionManager.readCodexSessionTranscriptText = (codexSessionId) => {
      assert.equal(codexSessionId, 'codex-123');
      return JSON.stringify({
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'assistant',
          content: [{ type: 'output_text', text: `Plan saved to: ${trackedPlanPath}` }]
        }
      });
    };
    sessionManager.planManager = {
      getPlanContent(requestedPath) {
        if (requestedPath === trackedPlanPath) {
          return {
            filename: path.basename(trackedPlanPath),
            name: 'transcript plan',
            path: trackedPlanPath,
            modifiedAt: '2026-05-20T10:00:00.000Z'
          };
        }
        if (requestedPath === manualPlanPath) {
          return {
            filename: 'manual-codex-plan.md',
            name: 'manual plan',
            path: manualPlanPath,
            modifiedAt: '2026-05-20T09:00:00.000Z'
          };
        }
        throw new Error(`Unexpected plan path: ${requestedPath}`);
      }
    };
    sessionManager.dataStore = {
      addPlanToSession() {}
    };
    sessionManager.emit = () => {};
    sessionManager.loadCodexSessionIndex = () => [];

    const plans = sessionManager.getSessionPlans(sessionId);

    assert.deepEqual(
      plans.map((plan) => plan.path),
      [trackedPlanPath, manualPlanPath]
    );
  });
});

test('getSessionPlans backfills Codex plans from EasyCC terminal transcript without captured Codex ID', () => {
  withCodexPlanFile(`easycc-terminal-backfill-plan-${process.pid}.md`, '# Terminal Backfill Plan\n', (trackedPlanPath) => {
    const sessionId = 'session-codex-terminal-backfill';
    const sessionManager = Object.create(SessionManager.prototype);
    const session = {
      id: sessionId,
      name: 'cutsheetfont-etc',
      cliType: 'codex',
      codexSessionId: null,
      workingDir: '/home/denni/apps/specsket',
      createdAt: '2026-05-20T05:00:00.000Z',
      lastActivity: '2026-05-20T05:30:00.000Z',
      plans: []
    };

    sessionManager.sessions = new Map([[sessionId, session]]);
    sessionManager.readSessionTerminalTranscriptText = (requestedSessionId) => {
      assert.equal(requestedSessionId, sessionId);
      return `Plan saved to: ${trackedPlanPath}\n`;
    };
    sessionManager.loadCodexSessionIndex = () => [];
    sessionManager.dataStore = {
      addPlanToSession(id, requestedPath) {
        assert.equal(id, sessionId);
        assert.equal(requestedPath, trackedPlanPath);
      }
    };
    sessionManager.emit = () => {};
    sessionManager.planManager = {
      getPlanContent(requestedPath) {
        assert.equal(requestedPath, trackedPlanPath);
        return {
          filename: path.basename(trackedPlanPath),
          name: 'terminal backfill plan',
          path: trackedPlanPath,
          modifiedAt: '2026-05-20T12:00:00.000Z'
        };
      }
    };

    const plans = sessionManager.getSessionPlans(sessionId);

    assert.deepEqual(plans.map((plan) => plan.path), [trackedPlanPath]);
    assert.deepEqual(session.plans, [trackedPlanPath]);
  });
});

test('ensureCodexSessionLinked recovers Codex ID from old resume hint title', () => {
  const sessionId = 'session-codex-title-backfill';
  const codexSessionId = '019e43b8-5674-7002-8ff3-b301c72d3c04';
  const sessionManager = Object.create(SessionManager.prototype);
  const session = {
    id: sessionId,
    name: `cutsheetfont-etc. To resume this thread run codex resume, then select cutsheetfont-etc (${codexSessionId})`,
    cliType: 'codex',
    codexSessionId: null,
    workingDir: '/home/denni/apps/specsket',
    plans: []
  };

  sessionManager.sessions = new Map([[sessionId, session]]);
  sessionManager.readCodexSessionMetaById = (requestedSessionId) => {
    assert.equal(requestedSessionId, codexSessionId);
    return {
      sessionId: codexSessionId,
      cwd: '/home/denni/apps/specsket',
      createdAt: '2026-05-20T05:00:00.000Z',
      filePath: '/home/denni/.codex/sessions/fake.jsonl'
    };
  };
  sessionManager.loadCodexSessionIndex = () => [{
    id: codexSessionId,
    threadName: 'cutsheetfont-etc',
    updatedAt: '2026-05-20T05:30:00.000Z',
    updatedAtMs: Date.parse('2026-05-20T05:30:00.000Z')
  }];
  sessionManager.dataStore = {
    saveSession(requestedSession) {
      assert.equal(requestedSession.id, sessionId);
    }
  };
  sessionManager.emit = () => {};
  sessionManager.getSessionSnapshot = (requestedSession) => requestedSession;

  assert.equal(sessionManager.ensureCodexSessionLinked(session), true);
  assert.equal(session.codexSessionId, codexSessionId);
  assert.equal(session.codexThreadName, 'cutsheetfont-etc');
});

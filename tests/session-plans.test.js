const test = require('node:test');
const assert = require('node:assert/strict');

const SessionManager = require('../backend/sessionManager');

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

const test = require('node:test');
const assert = require('node:assert/strict');

const { createQuitCoordinator } = require('../electron/quitCoordinator');

test('quit waits for backend stop and is idempotent', async () => {
  let releaseStop;
  const stopGate = new Promise(resolve => { releaseStop = resolve; });
  const exits = [];
  let stopped = 0;
  const app = {
    isQuitting: false,
    exit: code => exits.push(code)
  };
  const coordinator = createQuitCoordinator({
    app,
    stopBackend: () => stopGate,
    onStopped: () => { stopped += 1; },
    logger: { log() {}, error() {} }
  });

  let prevented = 0;
  coordinator.handleBeforeQuit({ preventDefault: () => { prevented += 1; } });
  const duplicate = coordinator.requestQuit(0);
  assert.equal(app.isQuitting, true);
  assert.equal(prevented, 1);
  assert.deepEqual(exits, []);

  releaseStop();
  await duplicate;
  assert.deepEqual(exits, [0]);
  assert.equal(stopped, 1);
  assert.equal(coordinator.isFinalExitAllowed(), true);

  coordinator.handleBeforeQuit({ preventDefault: () => { prevented += 1; } });
  assert.equal(prevented, 1);
});

test('quit reports cleanup failure through a nonzero exit', async () => {
  const exits = [];
  const errors = [];
  const coordinator = createQuitCoordinator({
    app: { exit: code => exits.push(code) },
    stopBackend: async () => { throw new Error('cleanup failed'); },
    logger: { log() {}, error: (...values) => errors.push(values) }
  });

  await coordinator.requestQuit(0);
  assert.deepEqual(exits, [1]);
  assert.equal(errors.length, 1);
});

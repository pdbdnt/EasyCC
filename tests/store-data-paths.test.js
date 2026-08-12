const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const DataStore = require('../backend/dataStore');
const PlanVersionStore = require('../backend/planVersionStore');
const SettingsManager = require('../backend/settingsManager');
const AgentStore = require('../backend/agentStore');
const TaskStore = require('../backend/taskStore');
const PresetStore = require('../backend/presetStore');
const TeamStore = require('../backend/teamStore');

test('all persistent stores honor EASYCC_DATA_DIR while explicit directories win', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'easycc-store-root-'));
  const explicit = fs.mkdtempSync(path.join(os.tmpdir(), 'easycc-store-explicit-'));
  const previous = process.env.EASYCC_DATA_DIR;
  process.env.EASYCC_DATA_DIR = root;

  try {
    const stores = [
      new DataStore(),
      new SettingsManager(),
      new AgentStore(),
      new TaskStore(),
      new PresetStore(),
      new TeamStore()
    ];
    for (const store of stores) assert.equal(store.dataDir, root);
    assert.equal(new PlanVersionStore().dataDir, path.join(root, 'plan-versions'));

    assert.equal(new DataStore(explicit).dataDir, explicit);
    assert.equal(new PlanVersionStore(explicit).dataDir, explicit);
    assert.equal(new SettingsManager(explicit).dataDir, explicit);
  } finally {
    if (previous === undefined) delete process.env.EASYCC_DATA_DIR;
    else process.env.EASYCC_DATA_DIR = previous;
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(explicit, { recursive: true, force: true });
  }
});

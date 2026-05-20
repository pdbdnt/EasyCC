const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const PlanManager = require('../backend/planManager');

function makeTempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

test('getPlanContent reads plan by filename from manager plans directory', () => {
  const plansDir = makeTempDir('plan-manager-plans-');
  try {
    const manager = new PlanManager(plansDir);

    const filename = 'sample-plan.md';
    const filePath = path.join(plansDir, filename);
    const body = '# Sample Plan\n\nWorking Directory: C:\\Users\\testuser\\apps\\demo\n';
    fs.writeFileSync(filePath, body, 'utf8');

    const result = manager.getPlanContent(filename);

    assert.ok(result);
    assert.equal(result.filename, filename);
    assert.equal(result.path, filePath);
    assert.equal(result.content, body);
    assert.equal(result.workingDir, 'C:\\Users\\testuser\\apps\\demo');
  } finally {
    fs.rmSync(plansDir, { recursive: true, force: true });
  }
});

test('getPlanContent reads plan by full path outside manager plans directory', () => {
  const plansDir = makeTempDir('plan-manager-home-');
  const outsideDir = makeTempDir('plan-manager-project-');
  try {
    const manager = new PlanManager(plansDir);

    const filePath = path.join(outsideDir, 'project-plan.md');
    const body = '# Project Plan\n\nWorking Directory: /tmp/project-a\n';
    fs.writeFileSync(filePath, body, 'utf8');

    const result = manager.getPlanContent(filePath);

    assert.ok(result);
    assert.equal(result.filename, 'project-plan.md');
    assert.equal(result.path, filePath);
    assert.equal(result.content, body);
    assert.equal(result.workingDir, '/tmp/project-a');
  } finally {
    fs.rmSync(plansDir, { recursive: true, force: true });
    fs.rmSync(outsideDir, { recursive: true, force: true });
  }
});

test('listPlans and filename lookup include extra plan directories', () => {
  const claudeDir = makeTempDir('plan-manager-claude-');
  const codexDir = makeTempDir('plan-manager-codex-');
  try {
    const manager = new PlanManager(claudeDir, { extraPlansDirs: [codexDir] });
    fs.writeFileSync(path.join(claudeDir, 'claude-plan.md'), '# Claude Plan\n', 'utf8');
    fs.writeFileSync(path.join(codexDir, 'codex-plan.md'), '# Codex Plan\n', 'utf8');

    const plans = manager.listPlans();
    assert.deepEqual(
      new Set(plans.map(plan => plan.filename)),
      new Set(['claude-plan.md', 'codex-plan.md'])
    );

    const codexPlan = manager.getPlanContent('codex-plan.md');
    assert.ok(codexPlan);
    assert.equal(codexPlan.path, path.join(codexDir, 'codex-plan.md'));
  } finally {
    fs.rmSync(claudeDir, { recursive: true, force: true });
    fs.rmSync(codexDir, { recursive: true, force: true });
  }
});

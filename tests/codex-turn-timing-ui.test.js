const test = require('node:test');
const assert = require('node:assert/strict');

test('Codex turn timing formats running and completed wall-clock durations', async () => {
  const {
    formatElapsedDuration,
    formatRunningElapsedDuration,
    getCodexTurnTimingDisplay
  } = await import('../ui/src/utils/codexTurnTiming.js');
  const startedAt = '2026-07-23T00:00:00.000Z';

  const running = getCodexTurnTimingDisplay(
    { turnId: 'turn-1', status: 'running', startedAt },
    Date.parse('2026-07-23T00:05:23.000Z')
  );
  assert.deepEqual(running, { label: 'Working', elapsedMs: 323_000 });
  assert.equal(formatRunningElapsedDuration(0), '<2m');
  assert.equal(formatRunningElapsedDuration(running.elapsedMs), '4m');
  assert.equal(formatRunningElapsedDuration(3_723_000), '1h 02m');

  const completed = getCodexTurnTimingDisplay({
    turnId: 'turn-1',
    status: 'completed',
    startedAt,
    completedAt: '2026-07-23T01:02:03.000Z',
    elapsedMs: 3_723_000
  });
  assert.deepEqual(completed, { label: 'Last turn', elapsedMs: 3_723_000 });
  assert.equal(formatElapsedDuration(completed.elapsedMs), '1h 02m 03s');
});

test('Codex turn timing omits missing data and labels interrupted turns', async () => {
  const { getCodexTurnTimingDisplay } = await import('../ui/src/utils/codexTurnTiming.js');

  assert.equal(getCodexTurnTimingDisplay(null), null);
  assert.equal(getCodexTurnTimingDisplay({ status: 'running', startedAt: 'invalid' }), null);
  assert.deepEqual(getCodexTurnTimingDisplay({
    turnId: 'turn-2',
    status: 'stopped',
    startedAt: '2026-07-23T00:00:00.000Z',
    elapsedMs: 120_000
  }), { label: 'Stopped', elapsedMs: 120_000 });
});

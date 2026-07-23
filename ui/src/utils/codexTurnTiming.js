export function formatElapsedDuration(elapsedMs) {
  const totalSeconds = Math.max(0, Math.floor((Number(elapsedMs) || 0) / 1000));
  if (totalSeconds < 60) return `${totalSeconds}s`;

  const seconds = totalSeconds % 60;
  const totalMinutes = Math.floor(totalSeconds / 60);
  if (totalMinutes < 60) return `${totalMinutes}m ${String(seconds).padStart(2, '0')}s`;

  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return `${hours}h ${String(minutes).padStart(2, '0')}m ${String(seconds).padStart(2, '0')}s`;
}

export function formatRunningElapsedDuration(elapsedMs, bucketMs = 2 * 60 * 1000) {
  const safeElapsedMs = Math.max(0, Number(elapsedMs) || 0);
  const bucketSizeMinutes = bucketMs / 60_000;
  if (safeElapsedMs < bucketMs) return `<${bucketSizeMinutes}m`;

  const bucketMinutes = Math.floor(safeElapsedMs / bucketMs) * bucketSizeMinutes;
  if (bucketMinutes < 60) return `${bucketMinutes}m`;

  const hours = Math.floor(bucketMinutes / 60);
  const minutes = bucketMinutes % 60;
  return minutes === 0 ? `${hours}h` : `${hours}h ${String(minutes).padStart(2, '0')}m`;
}

export function getCodexTurnTimingDisplay(timing, nowMs = Date.now()) {
  if (!timing?.startedAt) return null;
  const startedAtMs = Date.parse(timing.startedAt);
  if (!Number.isFinite(startedAtMs)) return null;

  if (timing.status === 'running') {
    return {
      label: 'Working',
      elapsedMs: Math.max(0, nowMs - startedAtMs)
    };
  }

  const elapsedMs = Math.max(0, Number(timing.elapsedMs) || 0);
  return {
    label: timing.status === 'completed' ? 'Last turn' : 'Stopped',
    elapsedMs
  };
}

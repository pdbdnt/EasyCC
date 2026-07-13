import { useEffect, useMemo, useState } from 'react';

export default function StartupRecoveryModal({
  summary,
  loading = false,
  busy = false,
  error = '',
  onRestart,
  onRestorePaused,
  onRetry,
  onClose
}) {
  const [remember, setRemember] = useState(false);
  const totals = summary?.totals || {};
  const sessions = useMemo(() => summary?.sessions || [], [summary?.sessions]);
  const launchableIds = useMemo(
    () => sessions.filter((session) => session.category === 'launchable').map((session) => session.id),
    [sessions]
  );
  const groups = useMemo(() => {
    const byKey = new Map();
    for (const session of sessions) {
      const key = session.groupKey || session.workingDir || 'ungrouped';
      if (!byKey.has(key)) {
        const normalizedPath = String(key).replace(/\\/g, '/').replace(/\/$/, '');
        byKey.set(key, {
          key,
          name: session.projectName || normalizedPath.split('/').pop() || 'Other',
          path: key,
          sessions: []
        });
      }
      byKey.get(key).sessions.push(session);
    }
    return [...byKey.values()];
  }, [sessions]);
  const [selectedIds, setSelectedIds] = useState(new Set());

  useEffect(() => {
    setSelectedIds(new Set(launchableIds));
  }, [launchableIds]);

  const allLaunchableSelected = launchableIds.length > 0 && launchableIds.every((id) => selectedIds.has(id));

  const toggleSession = (id, checked) => {
    setSelectedIds((current) => {
      const next = new Set(current);
      if (checked) next.add(id);
      else next.delete(id);
      return next;
    });
  };

  const toggleGroup = (group) => {
    const groupLaunchableIds = group.sessions
      .filter((session) => session.category === 'launchable')
      .map((session) => session.id);
    const allSelected = groupLaunchableIds.length > 0 && groupLaunchableIds.every((id) => selectedIds.has(id));
    setSelectedIds((current) => {
      const next = new Set(current);
      for (const id of groupLaunchableIds) {
        if (allSelected) next.delete(id);
        else next.add(id);
      }
      return next;
    });
  };

  return (
    <div className="modal-overlay startup-recovery-overlay">
      <div className="modal startup-recovery-modal" role="dialog" aria-modal="true" aria-labelledby="startup-recovery-title">
        <header className="startup-recovery-heading">
          <div>
            <p className="codex-resume-eyebrow">Workspace recovery</p>
            <h2 id="startup-recovery-title">Previous workspace found</h2>
            {!loading && !error && (
              <p>
                {totals.projectTotal || 0} project{totals.projectTotal === 1 ? '' : 's'} and{' '}
                {totals.candidateTotal || 0} session{totals.candidateTotal === 1 ? '' : 's'} can be reviewed.
              </p>
            )}
          </div>
          <button type="button" className="codex-resume-close" aria-label="Close recovery dialog" disabled={busy} onClick={onClose}>&times;</button>
        </header>

        {loading ? (
          <div className="startup-recovery-state">Preparing recovery options…</div>
        ) : error ? (
          <div className="startup-recovery-state startup-recovery-error" role="alert">
            <p>{error}</p>
            <button type="button" className="btn btn-secondary" onClick={onRetry}>Retry</button>
          </div>
        ) : (
          <>
            <div className="startup-recovery-stats">
              <span><strong>{totals.launchableTotal || 0}</strong> ready</span>
              <span><strong>{totals.requiresSelectionTotal || 0}</strong> need selection</span>
              <span><strong>{totals.disabledTotal || 0}</strong> unavailable</span>
              {launchableIds.length > 0 && (
                <button
                  type="button"
                  className="btn btn-secondary btn-small startup-recovery-select-all"
                  disabled={busy}
                  onClick={() => setSelectedIds(new Set(allLaunchableSelected ? [] : launchableIds))}
                >
                  {allLaunchableSelected ? 'Unselect all' : 'Select all'}
                </button>
              )}
            </div>

            <div className="startup-recovery-list">
              {groups.map((group) => {
                const groupLaunchableIds = group.sessions
                  .filter((session) => session.category === 'launchable')
                  .map((session) => session.id);
                const allGroupSelected = groupLaunchableIds.length > 0 && groupLaunchableIds.every((id) => selectedIds.has(id));
                return (
                  <section
                    className="startup-recovery-group"
                    role="group"
                    aria-label={`${group.name} — ${group.path}`}
                    key={group.key}
                  >
                    <div className="startup-recovery-group-heading">
                      <div>
                        <strong>{group.name}</strong>
                        <small>{group.path}</small>
                      </div>
                      <span>{group.sessions.length}</span>
                      {groupLaunchableIds.length > 0 && (
                        <button
                          type="button"
                          className="btn btn-secondary btn-small"
                          disabled={busy}
                          onClick={() => toggleGroup(group)}
                        >
                          {allGroupSelected ? 'Unselect project' : 'Select project'}
                        </button>
                      )}
                    </div>
                    {group.sessions.map((session) => {
                      const launchable = session.category === 'launchable';
                      return (
                      <label className={`startup-recovery-row is-${session.category}`} key={session.id}>
                        <input
                          type="checkbox"
                          checked={launchable && selectedIds.has(session.id)}
                          disabled={busy || !launchable}
                          onChange={(event) => toggleSession(session.id, event.target.checked)}
                          aria-label={`Restart ${session.name}`}
                        />
                        <div className="startup-recovery-row-copy">
                          <strong>{session.name}</strong>
                          <small>{session.workingDir}</small>
                        </div>
                        <span>{session.message || (session.code === 'exact' ? 'Exact conversation' : 'Ready')}</span>
                      </label>
                    );})}
                  </section>
                );
              })}
            </div>

            <label className="startup-recovery-remember">
              <input type="checkbox" checked={remember} onChange={(event) => setRemember(event.target.checked)} />
              Remember my choice
            </label>

            <div className="startup-recovery-actions">
              <button type="button" className="btn btn-secondary" disabled={busy} onClick={() => onRestorePaused({ remember })}>
                Restore paused and choose Codex
              </button>
              <button type="button" className="btn btn-primary" disabled={busy || selectedIds.size === 0} onClick={() => onRestart({ remember, sessionIds: [...selectedIds] })}>
                {busy ? 'Starting…' : `Restart selected sessions (${selectedIds.size})`}
              </button>
            </div>
            <p className="settings-description">Terminal and WSL sessions restart as fresh shells. No saved role or startup prompt is resent.</p>
          </>
        )}
      </div>
    </div>
  );
}

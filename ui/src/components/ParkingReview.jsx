import { useEffect, useMemo, useState } from 'react';

function relativeTime(value) {
  const ms = Date.now() - new Date(value || 0).getTime();
  if (!Number.isFinite(ms) || ms < 0) return 'just now';
  if (ms < 60_000) return 'just now';
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m ago`;
  return `${Math.floor(ms / 3_600_000)}h ago`;
}

export default function ParkingReview({
  summary,
  clientId,
  enabled = true,
  drawerOpen,
  onCloseDrawer,
  onConfirm,
  onSnooze,
  onKeepAwake,
  onWake,
  onOpenSession
}) {
  const reviewSessions = enabled ? summary?.reviewSessions || [] : [];
  const modalOwned = enabled && reviewSessions.length > 0 && summary?.modalOwnerClientId === clientId;
  const [selected, setSelected] = useState(new Set());
  const [busy, setBusy] = useState(false);
  const [history, setHistory] = useState([]);
  const [tab, setTab] = useState('review');

  useEffect(() => {
    setSelected(prev => {
      const valid = new Set(reviewSessions.map(session => session.id));
      const next = new Set([...prev].filter(id => valid.has(id)));
      for (const id of valid) if (!prev.has(id)) next.add(id);
      return next;
    });
  }, [reviewSessions.map(session => session.id).join('|')]);

  useEffect(() => {
    if (!drawerOpen) return;
    fetch('/api/session-parking/events?limit=100')
      .then(response => response.json())
      .then(data => setHistory(data.events || []))
      .catch(() => setHistory([]));
  }, [drawerOpen, summary?.parked, summary?.review]);

  const selectedIds = useMemo(() => [...selected], [selected]);
  const snoozeAll = async () => {
    if (!reviewSessions.length || busy) return;
    setBusy(true);
    try { await onSnooze(reviewSessions.map(session => session.id)); }
    finally { setBusy(false); }
  };
  const confirm = async () => {
    if (!selectedIds.length || busy) return;
    setBusy(true);
    try { await onConfirm(selectedIds); }
    finally { setBusy(false); }
  };

  useEffect(() => {
    if (!modalOwned) return undefined;
    const handleEscape = event => {
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        event.stopImmediatePropagation?.();
        void snoozeAll();
      }
    };
    document.addEventListener('keydown', handleEscape, true);
    return () => document.removeEventListener('keydown', handleEscape, true);
  }, [modalOwned, busy, reviewSessions.map(session => session.id).join('|')]);

  const rows = (
    <div className="parking-review-list">
      {reviewSessions.map(session => (
        <label key={session.id} className="parking-review-row">
          <input
            type="checkbox"
            checked={selected.has(session.id)}
            onChange={() => setSelected(prev => {
              const next = new Set(prev);
              if (next.has(session.id)) next.delete(session.id);
              else next.add(session.id);
              return next;
            })}
          />
          <span className="parking-review-main">
            <strong>{session.name}</strong>
            <small>{session.repoName || session.workingDir} · {session.cliType}</small>
            <small>{session.parkingProposalReason === 'live_cap' ? 'Live-session limit' : 'Idle timeout'} · ready {relativeTime(session.readySince)}</small>
          </span>
          <button
            type="button"
            className="btn btn-small btn-secondary"
            onClick={event => {
              event.preventDefault();
              onKeepAwake(session.id, true);
            }}
          >
            Keep Awake
          </button>
        </label>
      ))}
    </div>
  );

  return (
    <>
      {modalOwned && (
        <div className="modal-overlay parking-confirm-overlay">
          <div className="modal parking-confirm-modal" onClick={event => event.stopPropagation()}>
            <h2>Park idle sessions?</h2>
            <p className="settings-description">
              EasyCC will stop the selected CLI processes and keep their transcripts. Nothing is parked without confirmation.
            </p>
            {rows}
            <div className="modal-actions">
              <button className="btn btn-secondary" onClick={snoozeAll} disabled={busy}>Not now (15m)</button>
              <button className="btn btn-primary" onClick={confirm} disabled={busy || selectedIds.length === 0}>
                Park selected ({selectedIds.length})
              </button>
            </div>
          </div>
        </div>
      )}

      {drawerOpen && (
        <div className="parking-drawer">
          <div className="parking-drawer-header">
            <h2>Session parking</h2>
            <button className="btn-icon" onClick={onCloseDrawer}>×</button>
          </div>
          <div className="parking-tabs">
            {['review', 'current', 'history'].map(value => (
              <button key={value} className={tab === value ? 'active' : ''} onClick={() => setTab(value)}>
                {value[0].toUpperCase() + value.slice(1)}
              </button>
            ))}
          </div>
          {tab === 'review' && (reviewSessions.length ? rows : <p className="empty-state">No sessions awaiting review.</p>)}
          {tab === 'current' && (
            <div className="parking-review-list">
              {(summary?.currentParked || []).map(session => (
                <div key={session.id} className="parking-review-row">
                  <span className="parking-review-main">
                    <strong>{session.name}</strong>
                    <small>{session.repoName || session.workingDir}</small>
                    <small>Parked {relativeTime(session.parkedAt)}</small>
                  </span>
                  <div className="parking-row-actions">
                    <button className="btn btn-small btn-primary" onClick={() => onWake(session.id)}>Resume</button>
                    <button className="btn btn-small btn-secondary" onClick={() => onKeepAwake(session.id, true)}>Keep Awake</button>
                    <button className="btn btn-small btn-secondary" onClick={() => onOpenSession(session.id)}>Open</button>
                  </div>
                </div>
              ))}
              {!summary?.currentParked?.length && <p className="empty-state">No parked sessions.</p>}
            </div>
          )}
          {tab === 'history' && (
            <div className="parking-history">
              <p className="settings-description">Display names may come from conversation titles; prompt and transcript bodies are never logged.</p>
              {history.map((event, index) => (
                <div className="parking-history-row" key={`${event.timestamp}-${event.sessionId}-${index}`}>
                  <strong>{event.eventType?.replaceAll('_', ' ')}</strong>
                  <span>{event.sessionName || event.sessionId}</span>
                  <small>{relativeTime(event.timestamp)} · Live {event.live ?? '–'} · Parked {event.parked ?? '–'} · Review {event.review ?? '–'}</small>
                </div>
              ))}
              {!history.length && <p className="empty-state">No parking history yet.</p>}
            </div>
          )}
        </div>
      )}
    </>
  );
}

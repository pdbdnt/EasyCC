import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

function formatActivity(value) {
  if (!value) return '';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '' : date.toLocaleString([], {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit'
  });
}

function selectionKey(easyccSessionId, codexSessionId) {
  return easyccSessionId ? `saved:${easyccSessionId}` : `thread:${codexSessionId}`;
}

export default function CodexResumeModal({ scope = {}, onClose, onComplete }) {
  const [catalog, setCatalog] = useState(scope.initialCatalog || null);
  const [loading, setLoading] = useState(!scope.initialCatalog);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');
  const [searchInput, setSearchInput] = useState('');
  const [query, setQuery] = useState('');
  const [cursor, setCursor] = useState('');
  const [cursorStack, setCursorStack] = useState([]);
  const [selections, setSelections] = useState(() => new Map());
  const dialogRef = useRef(null);
  const initialCatalogPendingRef = useRef(!!scope.initialCatalog);
  const defaultsInitializedRef = useRef(false);

  const loadCatalog = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const params = new URLSearchParams({ timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC' });
      if (scope.groupKey) params.set('groupKey', scope.groupKey);
      if (cursor) params.set('cursor', cursor);
      if (query) params.set('query', query);
      const response = await fetch(`/api/codex/resume-catalog?${params}`);
      const body = await response.json();
      if (!response.ok) throw new Error(body.error || 'Could not load Codex conversations');
      setCatalog(body);
    } catch (loadError) {
      setError(loadError.message);
    } finally {
      setLoading(false);
    }
  }, [cursor, query, scope.groupKey]);

  useEffect(() => {
    if (initialCatalogPendingRef.current && !cursor && !query) {
      initialCatalogPendingRef.current = false;
      return;
    }
    loadCatalog();
  }, [loadCatalog, cursor, query]);

  useEffect(() => {
    if (!catalog || defaultsInitializedRef.current) return;
    defaultsInitializedRef.current = true;
    setSelections((current) => {
      const next = new Map();
      for (const saved of catalog.savedSessions || []) {
        if (saved.selectedByDefault && saved.codexSessionId) {
          next.set(selectionKey(saved.easyccSessionId, saved.codexSessionId), {
            easyccSessionId: saved.easyccSessionId,
            codexSessionId: saved.codexSessionId
          });
        }
      }
      return next;
    });
  }, [catalog]);

  useEffect(() => {
    const handleKeyDown = (event) => {
      if (event.key === 'Escape' && !submitting) onClose();
    };
    window.addEventListener('keydown', handleKeyDown);
    dialogRef.current?.focus();
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [onClose, submitting]);

  const selectedCodexIds = useMemo(
    () => new Set([...selections.values()].map((item) => item.codexSessionId)),
    [selections]
  );

  const choose = useCallback((codexSessionId, easyccSessionId, checked) => {
    setSelections((current) => {
      const next = new Map(current);
      for (const [key, value] of next) {
        if (value.codexSessionId === codexSessionId || (easyccSessionId && value.easyccSessionId === easyccSessionId)) {
          next.delete(key);
        }
      }
      if (checked && codexSessionId) {
        next.set(selectionKey(easyccSessionId, codexSessionId), { codexSessionId, easyccSessionId });
      }
      return next;
    });
  }, []);

  const submit = async () => {
    if (selections.size === 0) return;
    setSubmitting(true);
    setError('');
    try {
      const response = await fetch('/api/codex/resume-selection', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ selections: [...selections.values()] })
      });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error || 'Could not resume Codex conversations');
      onComplete(body);
      onClose();
    } catch (submitError) {
      setError(submitError.message);
      setSubmitting(false);
    }
  };

  const savedSessions = catalog?.savedSessions || [];
  const threads = catalog?.threads || [];
  const eligibleThreads = threads.filter((thread) => thread.selectable);

  return (
    <div className="modal-overlay codex-resume-overlay" onMouseDown={(event) => event.target === event.currentTarget && !submitting && onClose()}>
      <div
        ref={dialogRef}
        className="modal codex-resume-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="codex-resume-title"
        tabIndex={-1}
      >
        <header className="codex-resume-heading">
          <div>
            <p className="codex-resume-eyebrow">Codex history</p>
            <h2 id="codex-resume-title">Resume exact conversations</h2>
            <p>Choose the saved threads that should return{scope.displayName ? ` in ${scope.displayName}` : ''}.</p>
          </div>
          <button className="codex-resume-close" type="button" onClick={onClose} aria-label="Close resume dialog">&times;</button>
        </header>

        <form
          className="codex-resume-search"
          onSubmit={(event) => {
            event.preventDefault();
            setCursor('');
            setCursorStack([]);
            setQuery(searchInput.trim());
          }}
        >
          <input
            value={searchInput}
            onChange={(event) => setSearchInput(event.target.value)}
            placeholder="Search title, session ID, or folder"
            aria-label="Search Codex history"
          />
          <button className="btn btn-secondary btn-small" type="submit">Search</button>
        </form>

        {error && <div className="codex-resume-error" role="alert">{error}</div>}

        <div className="codex-resume-body" aria-busy={loading}>
          {savedSessions.length > 0 && (
            <section className="codex-resume-section" aria-labelledby="saved-codex-sessions">
              <div className="codex-resume-section-title">
                <h3 id="saved-codex-sessions">Paused in EasyCC</h3>
                <span>{savedSessions.length}</span>
              </div>
              <div className="codex-resume-list">
                {savedSessions.map((saved) => {
                  const checked = !!saved.codexSessionId && selectedCodexIds.has(saved.codexSessionId);
                  return (
                    <div className="codex-resume-row" key={saved.easyccSessionId}>
                      {saved.mappingState === 'exact' ? (
                        <label className="codex-resume-check">
                          <input
                            type="checkbox"
                            checked={checked}
                            disabled={saved.selectable === false}
                            onChange={(event) => choose(saved.codexSessionId, saved.easyccSessionId, event.target.checked)}
                          />
                          <span>
                            <strong>{saved.name}</strong>
                            <small>{saved.workingDir}</small>
                            {saved.disabledReason && <em>{saved.disabledReason}</em>}
                          </span>
                        </label>
                      ) : (
                        <div className="codex-resume-unresolved">
                          <span>
                            <strong>{saved.name}</strong>
                            <small>No exact Codex thread is linked. Choose one from this page.</small>
                          </span>
                          <select
                            aria-label={`Choose a Codex conversation for ${saved.name}`}
                            value={[...selections.values()].find((item) => item.easyccSessionId === saved.easyccSessionId)?.codexSessionId || ''}
                            onChange={(event) => choose(event.target.value, saved.easyccSessionId, !!event.target.value)}
                          >
                            <option value="">Choose conversation…</option>
                            {eligibleThreads
                              .filter((thread) => !thread.linkedEasyccSessionId || thread.linkedEasyccSessionId === saved.easyccSessionId)
                              .map((thread) => (
                              <option key={thread.codexSessionId} value={thread.codexSessionId}>{thread.threadName}</option>
                              ))}
                          </select>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </section>
          )}

          <section className="codex-resume-section" aria-labelledby="codex-history-list">
            <div className="codex-resume-section-title">
              <h3 id="codex-history-list">Conversation history</h3>
              <span>{catalog?.page?.dates?.join(' · ') || ''}</span>
            </div>
            {loading ? (
              <div className="codex-resume-empty">Loading Codex history…</div>
            ) : threads.length === 0 ? (
              <div className="codex-resume-empty">No matching conversations found.</div>
            ) : (
              <div className="codex-resume-list">
                {threads.map((thread) => (
                  <label className={`codex-resume-row codex-resume-check${thread.selectable ? '' : ' is-disabled'}`} key={thread.codexSessionId}>
                    <input
                      type="checkbox"
                      checked={selectedCodexIds.has(thread.codexSessionId)}
                      disabled={!thread.selectable}
                      onChange={(event) => choose(thread.codexSessionId, thread.linkedEasyccSessionId || undefined, event.target.checked)}
                    />
                    <span className="codex-resume-copy">
                      <span className="codex-resume-row-heading">
                        <strong>{thread.threadName}</strong>
                        <time>{formatActivity(thread.lastActivity)}</time>
                      </span>
                      {thread.preview && <span className="codex-resume-preview">{thread.preview}</span>}
                      <small>{thread.workingDir} · {thread.codexSessionId}</small>
                      {thread.disabledReason && <em>{thread.disabledReason}</em>}
                    </span>
                  </label>
                ))}
              </div>
            )}
          </section>
        </div>

        <footer className="codex-resume-footer">
          <div className="codex-resume-pagination">
            <button
              className="btn btn-secondary btn-small"
              type="button"
              disabled={cursorStack.length === 0 || loading}
              onClick={() => {
                const nextStack = [...cursorStack];
                setCursor(nextStack.pop() || '');
                setCursorStack(nextStack);
              }}
            >
              Newer
            </button>
            <button
              className="btn btn-secondary btn-small"
              type="button"
              disabled={!catalog?.page?.nextCursor || loading}
              onClick={() => {
                setCursorStack((current) => [...current, cursor]);
                setCursor(catalog.page.nextCursor);
              }}
            >
              Older
            </button>
          </div>
          <div className="codex-resume-actions">
            <span>{selections.size} selected</span>
            <button className="btn btn-secondary" type="button" onClick={onClose}>Cancel</button>
            <button className="btn btn-primary" type="button" disabled={selections.size === 0 || submitting} onClick={submit}>
              {submitting ? 'Starting…' : `Resume ${selections.size || ''}`.trim()}
            </button>
          </div>
        </footer>
      </div>
    </div>
  );
}

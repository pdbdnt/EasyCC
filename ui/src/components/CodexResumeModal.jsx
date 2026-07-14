import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

const MAX_RESUME_SELECTIONS = 100;
const catalogCache = new Map();
const catalogRequests = new Map();
const HISTORY_PREFERENCES_KEY = 'easycc.codexHistoryPreferences.v1';
const DEFAULT_HISTORY_PREFERENCES = {
  groupBy: 'folder',
  groupSort: 'recent',
  threadSort: 'updated-desc'
};

function readHistoryPreferences() {
  try {
    return { ...DEFAULT_HISTORY_PREFERENCES, ...JSON.parse(localStorage.getItem(HISTORY_PREFERENCES_KEY) || '{}') };
  } catch {
    return DEFAULT_HISTORY_PREFERENCES;
  }
}

async function requestCatalog(url) {
  if (catalogRequests.has(url)) return catalogRequests.get(url);
  const request = fetch(url)
    .then(async (response) => {
      const body = await response.json();
      if (!response.ok) throw new Error(body.error || 'Could not load Codex conversations');
      return body;
    })
    .finally(() => catalogRequests.delete(url));
  catalogRequests.set(url, request);
  return request;
}

function formatActivity(value) {
  if (!value) return 'Unknown';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? 'Unknown' : date.toLocaleString([], {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit'
  });
}

function selectionKey(easyccSessionId, codexSessionId) {
  return easyccSessionId ? `saved:${easyccSessionId}` : `thread:${codexSessionId}`;
}

function comparableFolder(value) {
  let normalized = String(value || '').trim().replace(/\\/g, '/').replace(/\/$/, '');
  const uncMatch = normalized.match(/^\/\/wsl(?:\$|\.localhost)?\/[^/]+(\/.*)?$/i);
  if (uncMatch) normalized = uncMatch[1] || '/';
  const driveMatch = normalized.match(/^([a-z]):(\/.*)?$/i);
  if (driveMatch) normalized = `/mnt/${driveMatch[1].toLowerCase()}${driveMatch[2] || ''}`;
  return /^\/mnt\/[a-z](?:\/|$)/i.test(normalized) ? normalized.toLowerCase() : normalized;
}

function sameFolder(left, right) {
  const normalizedLeft = comparableFolder(left);
  return !!normalizedLeft && normalizedLeft === comparableFolder(right);
}

function fallbackGroups(threads) {
  const groups = new Map();
  for (const thread of threads) {
    const key = thread.groupKey || thread.workingDir;
    if (!groups.has(key)) {
      groups.set(key, {
        key,
        name: String(key || 'Unknown folder').split('/').filter(Boolean).at(-1) || key,
        path: key,
        count: 0,
        selectableCount: 0,
        selectableSelections: [],
        lastActivity: thread.lastActivity
      });
    }
    const group = groups.get(key);
    group.count += 1;
    if (thread.selectable) {
      group.selectableCount += 1;
      group.selectableSelections.push({
        codexSessionId: thread.codexSessionId,
        easyccSessionId: thread.linkedEasyccSessionId || undefined
      });
    }
  }
  return [...groups.values()];
}

export default function CodexResumeModal({ scope = {}, onClose, onComplete }) {
  const [historyPreferences, setHistoryPreferences] = useState(readHistoryPreferences);
  const { groupBy, groupSort, threadSort } = historyPreferences;
  const [catalog, setCatalog] = useState(scope.initialCatalog || null);
  const [loading, setLoading] = useState(!scope.initialCatalog);
  const [refreshing, setRefreshing] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');
  const [warning, setWarning] = useState('');
  const [bulkMessage, setBulkMessage] = useState('');
  const [searchInput, setSearchInput] = useState('');
  const [query, setQuery] = useState('');
  const [cursor, setCursor] = useState('');
  const [cursorStack, setCursorStack] = useState([]);
  const [reloadNonce, setReloadNonce] = useState(0);
  const [selections, setSelections] = useState(() => new Map());
  const [collapsedGroups, setCollapsedGroups] = useState(() => new Set());
  const dialogRef = useRef(null);
  const initialCatalogPendingRef = useRef(!!scope.initialCatalog);
  const defaultsInitializedRef = useRef(false);
  const requestVersionRef = useRef(0);

  const loadCatalog = useCallback(async () => {
    const version = requestVersionRef.current + 1;
    requestVersionRef.current = version;
    const params = new URLSearchParams({ timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC' });
    if (scope.groupKey) params.set('groupKey', scope.groupKey);
    if (scope.easyccSessionId) params.set('easyccSessionId', scope.easyccSessionId);
    params.set('groupBy', groupBy);
    params.set('groupSort', groupSort);
    params.set('threadSort', threadSort);
    if (cursor) params.set('cursor', cursor);
    if (query) params.set('query', query);
    const cacheKey = params.toString();
    const cached = catalogCache.get(cacheKey) || null;

    if (cached) {
      setCatalog(cached);
      setLoading(false);
      setRefreshing(true);
    } else {
      setCatalog(null);
      setLoading(true);
      setRefreshing(false);
    }
    setError('');
    setWarning('');
    try {
      const body = await requestCatalog(`/api/codex/resume-catalog?${params}`);
      if (requestVersionRef.current !== version) return;
      catalogCache.set(cacheKey, body);
      setCatalog(body);
      setLoading(false);

      if (body.cache?.historyStale) {
        setRefreshing(true);
        const refreshParams = new URLSearchParams(params);
        refreshParams.set('refresh', '1');
        try {
          const freshBody = await requestCatalog(`/api/codex/resume-catalog?${refreshParams}`);
          if (requestVersionRef.current !== version) return;
          catalogCache.set(cacheKey, freshBody);
          setCatalog(freshBody);
        } catch (refreshError) {
          if (requestVersionRef.current === version) {
            setWarning(`${refreshError.message} Cached conversations are still shown.`);
          }
        }
      }
    } catch (loadError) {
      if (requestVersionRef.current !== version) return;
      if (cached) {
        setWarning(`${loadError.message} Cached conversations are still shown.`);
      } else {
        setError(loadError.message);
      }
    } finally {
      if (requestVersionRef.current === version) {
        setLoading(false);
        setRefreshing(false);
      }
    }
  }, [cursor, groupBy, groupSort, query, reloadNonce, scope.easyccSessionId, scope.groupKey, threadSort]);

  useEffect(() => {
    try {
      localStorage.setItem(HISTORY_PREFERENCES_KEY, JSON.stringify(historyPreferences));
    } catch {
      // Session preferences are optional.
    }
  }, [historyPreferences]);

  useEffect(() => {
    if (initialCatalogPendingRef.current && !cursor && !query) {
      initialCatalogPendingRef.current = false;
      return;
    }
    loadCatalog();
    return () => {
      requestVersionRef.current += 1;
    };
  }, [loadCatalog]);

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
    if (!catalog) return;
    const disabledIds = new Set([
      ...(catalog.threads || []).filter((thread) => !thread.selectable).map((thread) => thread.codexSessionId),
      ...(catalog.savedSessions || []).filter((saved) => saved.selectable === false).map((saved) => saved.codexSessionId)
    ].filter(Boolean));
    if (disabledIds.size === 0) return;
    setSelections((current) => {
      const next = new Map([...current].filter(([, value]) => !disabledIds.has(value.codexSessionId)));
      return next.size === current.size ? current : next;
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

  const threadsByGroup = useMemo(() => {
    const result = new Map();
    for (const thread of catalog?.threads || []) {
      const key = thread.groupKey || thread.workingDir;
      if (!result.has(key)) result.set(key, []);
      result.get(key).push(thread);
    }
    return result;
  }, [catalog]);

  const groups = useMemo(() => {
    const rows = catalog?.groups?.length ? catalog.groups : fallbackGroups(catalog?.threads || []);
    return rows.map((group) => ({ ...group, threads: threadsByGroup.get(group.key) || [] }));
  }, [catalog, threadsByGroup]);

  const choose = useCallback((codexSessionId, easyccSessionId, checked) => {
    setSelections((current) => {
      const next = new Map(current);
      for (const [key, value] of next) {
        if (value.codexSessionId === codexSessionId || (easyccSessionId && value.easyccSessionId === easyccSessionId)) {
          next.delete(key);
        }
      }
      if (checked && codexSessionId) {
        if (next.size >= MAX_RESUME_SELECTIONS) {
          setBulkMessage(`A maximum of ${MAX_RESUME_SELECTIONS} conversations can be selected.`);
          return next;
        }
        next.set(selectionKey(easyccSessionId, codexSessionId), { codexSessionId, easyccSessionId });
      }
      setBulkMessage('');
      return next;
    });
  }, []);

  const chooseMany = useCallback((items, checked) => {
    setSelections((current) => {
      const next = new Map(current);
      let limited = false;
      for (const item of items) {
        const codexSessionId = item?.codexSessionId;
        if (!codexSessionId) continue;
        for (const [key, value] of next) {
          if (value.codexSessionId === codexSessionId) next.delete(key);
        }
        if (!checked) continue;
        if (next.size >= MAX_RESUME_SELECTIONS) {
          limited = true;
          break;
        }
        const easyccSessionId = item.easyccSessionId || undefined;
        next.set(selectionKey(easyccSessionId, codexSessionId), { codexSessionId, easyccSessionId });
      }
      setBulkMessage(limited ? `A maximum of ${MAX_RESUME_SELECTIONS} conversations can be selected.` : '');
      return next;
    });
  }, []);

  const updateHistoryPreference = useCallback((field, value) => {
    setHistoryPreferences((current) => ({ ...current, [field]: value }));
    setCursor('');
    setCursorStack([]);
  }, []);

  const submit = async () => {
    if (selections.size === 0) return;
    setSubmitting(true);
    setError('');
    try {
      const response = await fetch('/api/codex/resume-selection', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          selections: [...selections.values()],
          ...(scope.easyccSessionId ? { easyccSessionId: scope.easyccSessionId } : {})
        })
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
  const canSelectVisible = !scope.easyccSessionId && eligibleThreads.some((thread) =>
    !selectedCodexIds.has(thread.codexSessionId)
  ) && selections.size < MAX_RESUME_SELECTIONS;

  const selectVisible = () => {
    setSelections((current) => {
      const next = new Map(current);
      const currentCodexIds = new Set([...current.values()].map((item) => item.codexSessionId));
      let limited = false;
      for (const thread of eligibleThreads) {
        if (currentCodexIds.has(thread.codexSessionId)) continue;
        if (next.size >= MAX_RESUME_SELECTIONS) {
          limited = true;
          break;
        }
        const easyccSessionId = thread.linkedEasyccSessionId || undefined;
        next.set(selectionKey(easyccSessionId, thread.codexSessionId), {
          codexSessionId: thread.codexSessionId,
          easyccSessionId
        });
        currentCodexIds.add(thread.codexSessionId);
      }
      setBulkMessage(limited ? `A maximum of ${MAX_RESUME_SELECTIONS} conversations can be selected.` : '');
      return next;
    });
  };

  const unselectAll = () => {
    setSelections(new Map());
    setBulkMessage('');
  };

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
            const nextQuery = searchInput.trim();
            if (nextQuery === query) setReloadNonce((value) => value + 1);
            else setQuery(nextQuery);
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

        <div className="codex-resume-sortbar" aria-label="History organization">
          <label>
            <span>Group by</span>
            <select
              aria-label="Group conversations by"
              value={groupBy}
              onChange={(event) => updateHistoryPreference('groupBy', event.target.value)}
            >
              <option value="folder">Project / folder</option>
              <option value="none">None (all conversations)</option>
            </select>
          </label>
          <label>
            <span>Sort groups</span>
            <select
              aria-label="Sort folder groups"
              value={groupSort}
              disabled={groupBy === 'none'}
              onChange={(event) => updateHistoryPreference('groupSort', event.target.value)}
            >
              <option value="recent">Recently active</option>
              <option value="oldest">Oldest activity</option>
              <option value="folder-asc">Folder A–Z</option>
              <option value="folder-desc">Folder Z–A</option>
              <option value="count-desc">Most conversations</option>
              <option value="count-asc">Fewest conversations</option>
            </select>
          </label>
          <label>
            <span>Sort conversations</span>
            <select
              aria-label="Sort conversations"
              value={threadSort}
              onChange={(event) => updateHistoryPreference('threadSort', event.target.value)}
            >
              <option value="updated-desc">Last updated (newest)</option>
              <option value="updated-asc">Last updated (oldest)</option>
              <option value="created-desc">Created (newest)</option>
              <option value="created-asc">Created (oldest)</option>
              <option value="title-asc">Title A–Z</option>
              <option value="title-desc">Title Z–A</option>
            </select>
          </label>
        </div>

        {error && <div className="codex-resume-error" role="alert">{error}</div>}
        {warning && (
          <div className="codex-resume-warning" role="status">
            <span>{warning}</span>
            <button className="btn btn-secondary btn-small" type="button" onClick={() => setReloadNonce((value) => value + 1)}>Retry</button>
          </div>
        )}

        <div className="codex-resume-body" aria-busy={loading || refreshing}>
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
                              .filter((thread) => sameFolder(thread.workingDir, saved.workingDir))
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
              <span>{refreshing ? 'Refreshing…' : (catalog?.page?.dates?.join(' · ') || '')}</span>
            </div>
            {loading && !catalog ? (
              <div className="codex-resume-empty">Loading Codex history…</div>
            ) : threads.length === 0 ? (
              <div className="codex-resume-empty">
                <strong>No matching conversations found.</strong>
                {catalog?.cache?.diagnostics && (
                  <small>
                    Codex home: {catalog.cache.diagnostics.codexHome} · Indexed {catalog.cache.diagnostics.indexCount} · Rollouts {catalog.cache.diagnostics.rolloutCount}
                  </small>
                )}
                <button className="btn btn-secondary btn-small" type="button" onClick={() => setReloadNonce((value) => value + 1)}>Retry</button>
              </div>
            ) : groupBy === 'none' ? (
              <div className="codex-resume-list">
                {threads.map((thread) => (
                  <label className={`codex-resume-row codex-resume-check${thread.selectable ? '' : ' is-disabled'}`} key={thread.codexSessionId}>
                    <input
                      type="checkbox"
                      checked={selectedCodexIds.has(thread.codexSessionId)}
                      disabled={!thread.selectable}
                      onChange={(event) => choose(thread.codexSessionId, scope.easyccSessionId || thread.linkedEasyccSessionId || undefined, event.target.checked)}
                    />
                    <span className="codex-resume-copy">
                      <span className="codex-resume-row-heading"><strong>{thread.threadName}</strong><time>Updated {formatActivity(thread.lastActivity)}</time></span>
                      {thread.preview && <span className="codex-resume-preview">{thread.preview}</span>}
                      <small>{thread.workingDir} · Created {formatActivity(thread.createdAt)} · {thread.codexSessionId}</small>
                      {thread.disabledReason && <em>{thread.disabledReason}</em>}
                    </span>
                  </label>
                ))}
              </div>
            ) : (
              <div className="codex-resume-groups">
                {groups.map((group) => {
                  const collapsed = collapsedGroups.has(group.key);
                  const selectedInGroup = (group.selectableSelections || []).filter((item) => selectedCodexIds.has(item.codexSessionId)).length;
                  const allSelected = group.selectableCount > 0 && selectedInGroup === group.selectableCount;
                  return (
                    <section className="codex-resume-group" key={group.key} aria-label={`${group.name} conversations`}>
                      <div className="codex-resume-group-heading">
                        <button
                          type="button"
                          className="codex-resume-group-toggle"
                          aria-expanded={!collapsed}
                          onClick={() => setCollapsedGroups((current) => {
                            const next = new Set(current);
                            if (next.has(group.key)) next.delete(group.key);
                            else next.add(group.key);
                            return next;
                          })}
                        >
                          <span aria-hidden="true">{collapsed ? '▸' : '▾'}</span>
                          <span><strong>{group.name}</strong><small>{group.path}</small></span>
                        </button>
                        <span className="codex-resume-group-meta">Updated {formatActivity(group.lastActivity)} · {group.count} conversation{group.count === 1 ? '' : 's'} · Selection {selectedInGroup}/{group.selectableCount}</span>
                        {!scope.easyccSessionId && group.selectableCount > 0 && (
                          <button
                            className="btn btn-secondary btn-small"
                            type="button"
                            onClick={() => chooseMany(group.selectableSelections || [], !allSelected)}
                          >
                            {allSelected ? 'Unselect folder' : 'Select folder'}
                          </button>
                        )}
                      </div>
                      {!collapsed && (
                        group.threads.length > 0 ? (
                          <div className="codex-resume-list">
                            {group.threads.map((thread) => (
                              <label className={`codex-resume-row codex-resume-check${thread.selectable ? '' : ' is-disabled'}`} key={thread.codexSessionId}>
                                <input
                                  type="checkbox"
                                  checked={selectedCodexIds.has(thread.codexSessionId)}
                                  disabled={!thread.selectable}
                                  onChange={(event) => choose(thread.codexSessionId, scope.easyccSessionId || thread.linkedEasyccSessionId || undefined, event.target.checked)}
                                />
                                <span className="codex-resume-copy">
                                  <span className="codex-resume-row-heading"><strong>{thread.threadName}</strong><time>Updated {formatActivity(thread.lastActivity)}</time></span>
                                  {thread.preview && <span className="codex-resume-preview">{thread.preview}</span>}
                                  <small>Created {formatActivity(thread.createdAt)} · {thread.codexSessionId}</small>
                                  {thread.disabledReason && <em>{thread.disabledReason}</em>}
                                </span>
                              </label>
                            ))}
                          </div>
                        ) : <div className="codex-resume-group-empty">Conversations in this folder are on another page.</div>
                      )}
                    </section>
                  );
                })}
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
              Previous
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
              Next
            </button>
          </div>
          <div className="codex-resume-actions">
            {!scope.easyccSessionId && (
              <button className="btn btn-secondary btn-small" type="button" disabled={!canSelectVisible || submitting} onClick={selectVisible}>
                Select visible
              </button>
            )}
            {selections.size > 0 && (
              <button className="btn btn-secondary btn-small" type="button" disabled={submitting} onClick={unselectAll}>
                Unselect all
              </button>
            )}
            <span>{selections.size} selected</span>
            <button className="btn btn-secondary" type="button" onClick={onClose}>Cancel</button>
            <button className="btn btn-primary" type="button" disabled={selections.size === 0 || submitting} onClick={submit}>
              {submitting ? 'Starting…' : `Resume ${selections.size || ''}`.trim()}
            </button>
          </div>
        </footer>
        {bulkMessage && <div className="codex-resume-limit" role="status">{bulkMessage}</div>}
      </div>
    </div>
  );
}

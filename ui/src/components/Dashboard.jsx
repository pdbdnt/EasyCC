import { useMemo, useEffect, useLayoutEffect, useRef, useState, useCallback } from 'react';
import SessionCard from './SessionCard';
import HintBadge from './HintBadge';
import SavedPlansModal from './SavedPlansModal';
import { getDirectoryName, getProjectDisplayName } from '../utils/projectUtils';


/**
 * Generate unique hint letter for a directory name, avoiding collisions
 * @param {string} dirName - Directory name
 * @param {Set<string>} usedLetters - Already used letters
 * @returns {string} Single letter hint prefix
 */
function getHintLetter(dirName, usedLetters) {
  const name = dirName.toLowerCase();
  // Try each character in the directory name
  for (let i = 0; i < name.length; i++) {
    const char = name[i];
    // Only use alphanumeric characters
    if (/[a-z0-9]/.test(char) && !usedLetters.has(char)) {
      usedLetters.add(char);
      return char;
    }
  }
  // Fallback: find first unused letter
  for (let code = 97; code <= 122; code++) { // a-z
    const char = String.fromCharCode(code);
    if (!usedLetters.has(char)) {
      usedLetters.add(char);
      return char;
    }
  }
  // Ultimate fallback: use number
  for (let i = 0; i <= 9; i++) {
    const char = i.toString();
    if (!usedLetters.has(char)) {
      usedLetters.add(char);
      return char;
    }
  }
  return 'x';
}

function Dashboard({
  sessions,
  selectedId,
  selectedIds = [],
  onSelectSession,
  onToggleSelectSession,
  onNewSession,
  onShowDetails,
  onOpenSettings,
  onUpdateSession,
  onMoveSession,
  onResetPlacement,
  onKillSession,
  onResumeSession,
  connectionStatus,
  hintModeActive = false,
  typedChars = '',
  hintCodes = {},
  onGroupedSessionsChange,
  kanbanColumnFilter = null,
  onClearKanbanFilter,
  stages = [],
  viewTransition = null,
  flipTriggerNonce = 0,
  settings = {},
  onUpdateSettings,
  sessionIdToGroup,
  sessionGroups = [],
  activeGroupId = null,
  onSaveGroup,
  onDeleteGroup,
  onRenameGroup,
  kanbanRects = null,
  onKanbanRectsConsumed,
  sidebarCardRefsRef,
  kanbanProjectFilter = null,
  onClearKanbanProjectFilter
}) {
  const [collapsedGroups, setCollapsedGroups] = useState(() => new Set());
  const [groupNameInput, setGroupNameInput] = useState('');
  const [showGroupNameInput, setShowGroupNameInput] = useState(false);
  const [killGroupTarget, setKillGroupTarget] = useState(null); // { dirName, sessionIds }
  const [savedPlansTarget, setSavedPlansTarget] = useState(null); // { dirName, workingDir }
  const [editingAlias, setEditingAlias] = useState(null); // workingDir being edited
  const [aliasInput, setAliasInput] = useState('');
  const aliasInputRef = useRef(null);

  const projectAliases = settings?.projectAliases || {};

  const handleAliasDoubleClick = useCallback((e, workingDir, currentDisplayName) => {
    e.stopPropagation();
    setEditingAlias(workingDir);
    setAliasInput(projectAliases[workingDir] || '');
  }, [projectAliases]);

  const handleAliasSave = useCallback(async (workingDir) => {
    const trimmed = aliasInput.trim();
    const newAliases = { ...projectAliases };
    if (trimmed) {
      newAliases[workingDir] = trimmed;
    } else {
      delete newAliases[workingDir];
    }
    if (onUpdateSettings) {
      await onUpdateSettings({ projectAliases: newAliases });
    }
    setEditingAlias(null);
  }, [aliasInput, projectAliases, onUpdateSettings]);

  const handleAliasKeyDown = useCallback((e, workingDir) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      handleAliasSave(workingDir);
    } else if (e.key === 'Escape') {
      setEditingAlias(null);
    }
  }, [handleAliasSave]);

  useEffect(() => {
    if (editingAlias && aliasInputRef.current) {
      aliasInputRef.current.focus();
      aliasInputRef.current.select();
    }
  }, [editingAlias]);
  const cardNodeRefs = useRef(new Map());
  const cardRefCallbacks = useRef(new Map());
  const previousCardRectsRef = useRef(new Map());
  const lastAnimatedNonceRef = useRef(0);
  const runningAnimationsRef = useRef([]);

  // Get hint codes from settings or use defaults
  const newSessionHint = hintCodes.newSession || 'ns';
  const settingsHint = hintCodes.settings || 'st';

  const getCardNodeRef = useCallback((sessionId) => {
    if (cardRefCallbacks.current.has(sessionId)) {
      return cardRefCallbacks.current.get(sessionId);
    }

    const callback = (node) => {
      if (node) {
        cardNodeRefs.current.set(sessionId, node);
        if (sidebarCardRefsRef) sidebarCardRefsRef.current.set(sessionId, node);
        return;
      }
      cardNodeRefs.current.delete(sessionId);
      if (sidebarCardRefsRef) sidebarCardRefsRef.current.delete(sessionId);
    };

    cardRefCallbacks.current.set(sessionId, callback);
    return callback;
  }, []);

  // Filter sessions by kanban column and/or project if active
  const filteredSessions = useMemo(() => {
    let result = sessions;
    if (kanbanColumnFilter) result = result.filter(s => s.stage === kanbanColumnFilter);
    if (kanbanProjectFilter && kanbanProjectFilter.size > 0) {
      result = result.filter(s => kanbanProjectFilter.has(s.workingDir));
    }
    return result;
  }, [sessions, kanbanColumnFilter, kanbanProjectFilter]);

  // Total sessions per directory (unfiltered) for showing "filtered/total" counts
  const totalsByDir = useMemo(() => {
    const totals = new Map();
    sessions.forEach(session => {
      const dirName = getDirectoryName(session.workingDir);
      totals.set(dirName, (totals.get(dirName) || 0) + 1);
    });
    return totals;
  }, [sessions]);

  // Group sessions by their working directory with directory-based hint codes
  const groupedSessions = useMemo(() => {
    const groups = new Map();

    filteredSessions.forEach((session, index) => {
      const dirName = getDirectoryName(session.workingDir);
      if (!groups.has(dirName)) {
        groups.set(dirName, []);
      }
      groups.get(dirName).push({ session, globalIndex: index });
    });

    // Within each group, sort sessions.
    // When kanban filter is active, sort by stageEnteredAt (most recent first).
    // Otherwise, show Claude sessions first, Codex last, then by insertion order.
    for (const [, sessionsInGroup] of groups) {
      sessionsInGroup.sort((a, b) => {
        if (kanbanColumnFilter) {
          // Most recently entered stage first
          const aTime = a.session.stageEnteredAt ? new Date(a.session.stageEnteredAt).getTime() : 0;
          const bTime = b.session.stageEnteredAt ? new Date(b.session.stageEnteredAt).getTime() : 0;
          if (aTime !== bTime) return bTime - aTime;
        }
        const aCodex = a.session.cliType === 'codex' ? 1 : 0;
        const bCodex = b.session.cliType === 'codex' ? 1 : 0;
        if (aCodex !== bCodex) {
          return aCodex - bCodex;
        }
        return a.globalIndex - b.globalIndex;
      });
    }

    // Sort groups alphabetically (first gets priority for letter)
    const sortedGroups = Array.from(groups.entries()).sort((a, b) => a[0].localeCompare(b[0]));

    // Assign unique hint letters to each group (use display name for hint derivation)
    const usedLetters = new Set();
    const groupsWithHints = sortedGroups.map(([dirName, sessionsInGroup]) => {
      const displayName = getProjectDisplayName(sessionsInGroup[0]?.session?.workingDir, projectAliases) || dirName;
      const hintLetter = getHintLetter(displayName, usedLetters);
      // Assign hint codes to sessions within group
      const sessionsWithHints = sessionsInGroup.map((item, indexInGroup) => ({
        ...item,
        hintCode: `${hintLetter}${indexInGroup + 1}`
      }));
      return [dirName, sessionsWithHints, hintLetter];
    });

    return groupsWithHints;
  }, [filteredSessions, kanbanColumnFilter, projectAliases]);

  useLayoutEffect(() => {
    const flipRequested = flipTriggerNonce > 0 && flipTriggerNonce !== lastAnimatedNonceRef.current;
    const shouldSampleRects = !!(viewTransition?.active || flipRequested);
    const isCtrlOContext = !!(viewTransition?.reason === 'ctrl-o' || viewTransition?.reason === 'kanban-select' || flipRequested);
    if (!shouldSampleRects || !isCtrlOContext) return;

    const nextRects = new Map();
    cardNodeRefs.current.forEach((node, sessionId) => {
      if (!node?.isConnected) return;
      nextRects.set(sessionId, node.getBoundingClientRect());
    });

    const prefersReducedMotion = typeof window !== 'undefined' &&
      window.matchMedia &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    // If user explicitly enabled animations in settings, override OS reduced-motion preference
    const userExplicitlyEnabled = settings?.ui?.showFlipAnimation === true;
    const shouldAnimateFlip = (!prefersReducedMotion || userExplicitlyEnabled) &&
      viewTransition?.active &&
      (viewTransition?.reason === 'ctrl-o' || viewTransition?.reason === 'kanban-select') &&
      viewTransition?.direction === 'k2s' &&
      flipRequested &&
      nextRects.size > 0 &&
      nextRects.size <= (settings?.ui?.maxFlipAnimationCards ?? 60);

    console.log('[FLIP-DEBUG] useLayoutEffect:', { flipRequested, shouldSampleRects, isCtrlOContext, viewTransitionActive: viewTransition?.active, viewTransitionDirection: viewTransition?.direction, viewTransitionReason: viewTransition?.reason, nextRectsSize: nextRects.size, shouldAnimateFlip, showFlipAnimation: settings?.ui?.showFlipAnimation, flipAnimationSpeed: settings?.ui?.flipAnimationSpeed, kanbanRectsSize: kanbanRects?.size ?? 'null', flipTriggerNonce, lastAnimatedNonce: lastAnimatedNonceRef.current });

    if (shouldAnimateFlip && settings?.ui?.showFlipAnimation !== false) {
      // Speed multiplier: lower = slower (0.1 = 10x slower, 1 = normal, 4 = 4x faster)
      const speedMult = settings?.ui?.flipAnimationSpeed || 1;
      const flipDuration = Math.round(350 / speedMult);
      const fadeDuration = Math.round(200 / speedMult);
      const staggerMs = Math.round(40 / speedMult);

      // Temporarily allow overflow so cards can fly from kanban area
      const sessionsListEl = document.querySelector('.sessions-list');
      const sidebarEl = document.querySelector('.sidebar');
      const savedOverflow = {
        sidebar: sidebarEl?.style.overflow,
        sessionsList: sessionsListEl?.style.overflow
      };
      if (sidebarEl) sidebarEl.style.overflow = 'visible';
      if (sessionsListEl) sessionsListEl.style.overflow = 'visible';

      const hasKanbanRects = kanbanRects && kanbanRects.size > 0;
      const animations = [];

      let animIndex = 0;
      nextRects.forEach((nextRect, sessionId) => {
        const node = cardNodeRefs.current.get(sessionId);
        if (!node || typeof node.animate !== 'function') return;
        if (nextRect.width === 0 || nextRect.height === 0) return;

        const kanbanRect = hasKanbanRects ? kanbanRects.get(sessionId) : null;
        const staggerDelay = animIndex * staggerMs;

        if (kanbanRect) {
          // TRUE FLIP: fly from kanban position to sidebar position
          const dx = kanbanRect.left - nextRect.left;
          const dy = kanbanRect.top - nextRect.top;
          console.log('[FLIP-DEBUG] Card FLIP:', sessionId, { dx, dy, flipDuration, staggerDelay });

          // Elevate card above all UI during flight
          node.style.position = 'relative';
          node.style.zIndex = '9999';
          node.style.willChange = 'transform, opacity';

          const anim = node.animate(
            [
              { transform: `translate(${dx}px, ${dy}px)`, opacity: 0.7 },
              { transform: 'translate(0, 0)', opacity: 1 }
            ],
            { duration: flipDuration, easing: 'cubic-bezier(0.22, 1, 0.36, 1)', delay: staggerDelay, fill: 'backwards' }
          );
          anim.onfinish = () => {
            node.style.willChange = '';
            node.style.zIndex = '';
            node.style.position = '';
          };
          animations.push(anim);
        } else {
          // No kanban position — fade-in fallback
          console.log('[FLIP-DEBUG] Card FADE:', sessionId, { fadeDuration, staggerDelay });
          node.style.willChange = 'transform, opacity';
          const anim = node.animate(
            [
              { opacity: 0, transform: 'translateY(8px)' },
              { opacity: 1, transform: 'translateY(0)' }
            ],
            { duration: fadeDuration, easing: 'ease-out', delay: staggerDelay, fill: 'backwards' }
          );
          anim.onfinish = () => { node.style.willChange = ''; };
          animations.push(anim);
        }
        animIndex++;
      });

      // Restore overflow after all animations complete
      if (animations.length > 0) {
        const maxDuration = flipDuration + (animIndex * staggerMs) + 50;
        setTimeout(() => {
          if (sidebarEl) sidebarEl.style.overflow = savedOverflow.sidebar || '';
          if (sessionsListEl) sessionsListEl.style.overflow = savedOverflow.sessionsList || '';
        }, maxDuration);
      }

      // Consume kanban rects
      if (hasKanbanRects && onKanbanRectsConsumed) {
        onKanbanRectsConsumed();
      }

      lastAnimatedNonceRef.current = flipTriggerNonce;
    }

    previousCardRectsRef.current = nextRects;
  }, [groupedSessions, viewTransition, flipTriggerNonce, kanbanRects, onKanbanRectsConsumed, settings]);

  // Notify parent about grouped sessions for navigation
  useEffect(() => {
    if (onGroupedSessionsChange) {
      onGroupedSessionsChange(groupedSessions);
    }
  }, [groupedSessions, onGroupedSessionsChange]);

  // Keep collapse state in sync with active groups
  useEffect(() => {
    setCollapsedGroups((prev) => {
      const activeGroupNames = new Set(groupedSessions.map(([dirName]) => dirName));
      const next = new Set();
      for (const dirName of prev) {
        if (activeGroupNames.has(dirName)) {
          next.add(dirName);
        }
      }
      return next.size === prev.size ? prev : next;
    });
  }, [groupedSessions]);

  // Ensure selected session remains visible
  useEffect(() => {
    if (!selectedId) return;
    const selectedGroup = groupedSessions.find(([, sessionsInGroup]) =>
      sessionsInGroup.some(({ session }) => session.id === selectedId)
    );
    if (!selectedGroup) return;
    const [dirName] = selectedGroup;
    setCollapsedGroups((prev) => {
      if (!prev.has(dirName)) return prev;
      const next = new Set(prev);
      next.delete(dirName);
      return next;
    });
  }, [groupedSessions, selectedId]);

  const toggleGroupCollapsed = (dirName) => {
    setCollapsedGroups((prev) => {
      const next = new Set(prev);
      if (next.has(dirName)) {
        next.delete(dirName);
      } else {
        next.add(dirName);
      }
      return next;
    });
  };

  return (
    <>
      <div className="sidebar-header">
        <h1>CliMan</h1>
        <div className="sidebar-header-actions">
          <button className="settings-btn" onClick={onOpenSettings} title="Settings">
            <HintBadge
              code={settingsHint}
              visible={hintModeActive}
              position="top-right"
              action={onOpenSettings}
              typedChars={typedChars}
            />
            ⚙️
          </button>
          <button className="btn btn-primary btn-small" onClick={onNewSession}>
            <HintBadge
              code={newSessionHint}
              visible={hintModeActive}
              position="top-left"
              action={onNewSession}
              typedChars={typedChars}
            />
            + New
          </button>
        </div>
      </div>
      {kanbanColumnFilter && (
        <div className="kanban-filter-chip">
          <span>Filtered: {kanbanColumnFilter.replace('_', ' ')}</span>
          <button onClick={onClearKanbanFilter} title="Clear filter">&times;</button>
        </div>
      )}
      {kanbanProjectFilter && kanbanProjectFilter.size > 0 && (
        <div className="kanban-filter-chip">
          <span>Project: {kanbanProjectFilter.size === 1
            ? getProjectDisplayName([...kanbanProjectFilter][0], settings?.projectAliases)
            : `${kanbanProjectFilter.size} projects`}</span>
          <button onClick={onClearKanbanProjectFilter} title="Clear project filter">&times;</button>
        </div>
      )}
      {selectedIds.length > 1 && (
        <div className="save-group-bar">
          {activeGroupId ? (
            <>
              <span className="group-active-label">
                Group: {sessionGroups.find(g => g.id === activeGroupId)?.name || 'Unnamed'}
              </span>
              <button
                className="btn btn-secondary btn-small"
                onClick={() => onDeleteGroup(activeGroupId)}
                title="Dissolve this group"
              >
                Ungroup
              </button>
            </>
          ) : showGroupNameInput ? (
            <>
              <input
                type="text"
                className="group-name-input"
                value={groupNameInput}
                onChange={(e) => setGroupNameInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && groupNameInput.trim()) {
                    onSaveGroup(groupNameInput.trim());
                    setGroupNameInput('');
                    setShowGroupNameInput(false);
                  } else if (e.key === 'Escape') {
                    setShowGroupNameInput(false);
                    setGroupNameInput('');
                  }
                }}
                placeholder="Group name..."
                autoFocus
              />
              <button
                className="btn btn-primary btn-small"
                onClick={() => {
                  if (groupNameInput.trim()) {
                    onSaveGroup(groupNameInput.trim());
                    setGroupNameInput('');
                    setShowGroupNameInput(false);
                  }
                }}
                disabled={!groupNameInput.trim()}
              >
                Save
              </button>
              <button
                className="btn btn-secondary btn-small"
                onClick={() => { setShowGroupNameInput(false); setGroupNameInput(''); }}
              >
                Cancel
              </button>
            </>
          ) : (
            <button
              className="btn btn-secondary btn-small"
              onClick={() => setShowGroupNameInput(true)}
            >
              Save as Group ({selectedIds.length})
            </button>
          )}
        </div>
      )}
      <div className="sessions-list">
        {filteredSessions.length === 0 ? (
          <div className="empty-state">
            <div className="empty-state-icon">{kanbanColumnFilter ? '👀' : '📭'}</div>
            <p>{kanbanColumnFilter ? `Watching: ${kanbanColumnFilter.replace('_', ' ')}` : 'No active sessions'}</p>
            <p>{kanbanColumnFilter ? 'Will auto-show when a session enters this stage' : 'Create one to get started'}</p>
          </div>
        ) : (
          groupedSessions.map(([dirName, sessionsInGroup, hintLetter]) => {
            const groupWorkingDir = sessionsInGroup[0]?.session?.workingDir;
            const displayName = getProjectDisplayName(groupWorkingDir, projectAliases);
            const isEditingThis = editingAlias === groupWorkingDir;
            return (
            <div key={dirName} className="session-group">
              <button
                type="button"
                className="session-group-header"
                onClick={() => toggleGroupCollapsed(dirName)}
                aria-expanded={!collapsedGroups.has(dirName)}
                aria-label={`${collapsedGroups.has(dirName) ? 'Expand' : 'Collapse'} ${displayName} (${sessionsInGroup.length} sessions)`}
              >
                <span className={`session-group-chevron ${collapsedGroups.has(dirName) ? 'collapsed' : ''}`}>▾</span>
                <span className="session-group-icon">📁</span>
                {isEditingThis ? (
                  <input
                    ref={aliasInputRef}
                    className="session-group-alias-input"
                    value={aliasInput}
                    onChange={e => setAliasInput(e.target.value)}
                    onBlur={() => handleAliasSave(groupWorkingDir)}
                    onKeyDown={e => handleAliasKeyDown(e, groupWorkingDir)}
                    onClick={e => e.stopPropagation()}
                    placeholder={dirName}
                  />
                ) : (
                  <span
                    className="session-group-name"
                    title={groupWorkingDir}
                    onDoubleClick={e => handleAliasDoubleClick(e, groupWorkingDir, displayName)}
                  >
                    {displayName}
                  </span>
                )}
                <span className="session-group-count">
                  {kanbanColumnFilter
                    ? `${sessionsInGroup.length}/${totalsByDir.get(dirName) || 0}`
                    : sessionsInGroup.length}
                </span>
                {hintModeActive && (
                  <span className="session-group-hint">{hintLetter}</span>
                )}
                <button
                  className="group-gear-btn"
                  title={`Saved plans for ${displayName}`}
                  onClick={(e) => {
                    e.stopPropagation();
                    const workingDir = sessionsInGroup[0]?.session?.workingDir;
                    if (workingDir) {
                      setSavedPlansTarget({ dirName, workingDir });
                    }
                  }}
                >
                  ⚙
                </button>
                {onResumeSession && sessionsInGroup.some(s => s.session.status === 'paused') && (
                  <button
                    className="group-resume-btn"
                    title={`Resume all paused sessions in ${displayName}`}
                    onClick={async (e) => {
                      e.stopPropagation();
                      const pausedIds = sessionsInGroup
                        .filter(s => s.session.status === 'paused')
                        .map(s => s.session.id);
                      for (const id of pausedIds) {
                        await onResumeSession(id);
                      }
                    }}
                  >
                    ▶
                  </button>
                )}
                {onKillSession && (
                  <button
                    className="group-kill-btn"
                    title={`Kill all sessions in ${displayName}`}
                    onClick={(e) => {
                      e.stopPropagation();
                      setKillGroupTarget({
                        dirName,
                        sessionIds: sessionsInGroup.map(s => s.session.id)
                      });
                    }}
                  >
                    ✕
                  </button>
                )}
              </button>
              {!collapsedGroups.has(dirName) && sessionsInGroup.map(({ session, globalIndex, hintCode }) => {
                const recentlyEntered = kanbanColumnFilter && session.stageEnteredAt &&
                  (Date.now() - new Date(session.stageEnteredAt).getTime()) < 10 * 60 * 1000;
                return (
                  <div
                    key={session.id}
                    className="session-card-flip-item"
                    data-session-id={session.id}
                    ref={getCardNodeRef(session.id)}
                  >
                    <SessionCard
                      session={session}
                      index={globalIndex}
                      isSelected={session.id === selectedId}
                      isMultiSelected={selectedIds.includes(session.id) && selectedIds.length > 1}
                      onSelect={(event) => onSelectSession(session.id, event)}
                      onToggleSelect={onToggleSelectSession}
                      onShowDetails={onShowDetails}
                      onUpdate={onUpdateSession}
                      onMoveSession={onMoveSession}
                      onResetPlacement={onResetPlacement}
                      hintModeActive={hintModeActive}
                      typedChars={typedChars}
                      hintCode={hintCode}
                      isRecentlyEntered={!!recentlyEntered}
                      stages={stages}
                      groupInfo={sessionIdToGroup?.get(session.id) || null}
                      isGroupFocused={activeGroupId && selectedIds.includes(session.id) && session.id === selectedId}
                    />
                  </div>
                );
              })}
            </div>
          );})
        )}
      </div>
      <div className={`connection-status ${connectionStatus}`}>
        <span className={`status-indicator ${connectionStatus === 'connected' ? 'active' : 'idle'}`} />
        {connectionStatus === 'connected' ? 'Connected' :
         connectionStatus === 'connecting' ? 'Connecting...' :
         'Disconnected'}
      </div>
      {killGroupTarget && (
        <div className="modal-overlay" onClick={() => setKillGroupTarget(null)} onKeyDown={e => { if (e.key === 'Escape') setKillGroupTarget(null); }}>
          <div className="modal" onClick={e => e.stopPropagation()}>
            <h2>Kill All Sessions?</h2>
            <p className="settings-description">
              This will kill <strong>{killGroupTarget.sessionIds.length}</strong> session{killGroupTarget.sessionIds.length > 1 ? 's' : ''} in <strong>{killGroupTarget.dirName}</strong>.
            </p>
            <div className="modal-actions">
              <button className="btn btn-secondary" onClick={() => setKillGroupTarget(null)} autoFocus>
                Cancel
              </button>
              <button
                className="btn btn-danger"
                onClick={async () => {
                  for (const id of killGroupTarget.sessionIds) {
                    await onKillSession(id, { skipConfirm: true });
                  }
                  setKillGroupTarget(null);
                }}
              >
                Kill {killGroupTarget.sessionIds.length} Session{killGroupTarget.sessionIds.length > 1 ? 's' : ''}
              </button>
            </div>
          </div>
        </div>
      )}
      {savedPlansTarget && (
        <SavedPlansModal
          workingDir={savedPlansTarget.workingDir}
          dirName={savedPlansTarget.dirName}
          onClose={() => setSavedPlansTarget(null)}
        />
      )}
    </>
  );
}

export default Dashboard;

import React, { useState, useCallback, useEffect, useRef } from 'react';
import Dashboard from './components/Dashboard';
import TerminalView from './components/TerminalView';
import NewSessionModal from './components/NewSessionModal';
import SessionDetailsModal from './components/SessionDetailsModal';
import ContextSidebar from './components/ContextSidebar';
import SettingsModal from './components/SettingsModal';
import ResizeHandle from './components/ResizeHandle';
import HintBadge from './components/HintBadge';
import KanbanBoard from './components/KanbanBoard';
import ToastContainer from './components/Toast';
import { useSessions } from './hooks/useSessions';
import { useContextSidebar } from './hooks/useContextSidebar';
import { useSettings } from './hooks/useSettings';
import { useHintMode } from './hooks/useHintMode';
import { useToast } from './hooks/useToast';
import { registerHint, unregisterHint } from './utils/hintRegistry';

const makePaneId = () => `pane-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

const PANE_LAYOUT_KEY = 'claude-manager-pane-layout';

function loadPaneLayout() {
  try {
    const stored = localStorage.getItem(PANE_LAYOUT_KEY);
    if (!stored) return null;
    return JSON.parse(stored);
  } catch { return null; }
}

function savePaneLayout(panes, layout, sizes) {
  try {
    localStorage.setItem(PANE_LAYOUT_KEY, JSON.stringify({
      panes: panes.map(p => ({ id: p.id, sessionId: p.sessionId })),
      layout,
      sizes
    }));
  } catch { /* ignore */ }
}

function isSplitRightShortcut(e) {
  return e.altKey && e.shiftKey && !e.ctrlKey && !e.metaKey &&
    (e.key === '+' || e.key === '=' || e.code === 'NumpadAdd');
}

function isSplitBottomShortcut(e) {
  return e.altKey && e.shiftKey && !e.ctrlKey && !e.metaKey &&
    (e.key === '-' || e.key === '_' || e.code === 'NumpadSubtract');
}

function isCloseSessionShortcut(e) {
  return (e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey && e.key.toLowerCase() === 'w';
}

function isClosePaneShortcut(e) {
  return e.ctrlKey && e.shiftKey && !e.altKey && !e.metaKey && e.key.toLowerCase() === 'w';
}

function isPaneFocusShortcut(e) {
  return e.altKey && !e.ctrlKey && !e.shiftKey && !e.metaKey &&
    (e.key === 'ArrowLeft' || e.key === 'ArrowRight' || e.key === 'ArrowUp' || e.key === 'ArrowDown');
}

function App() {
  const [currentView, setCurrentView] = useState('sessions'); // 'sessions' | 'kanban'
  const [showNewSessionModal, setShowNewSessionModal] = useState(false);
  const [showSettingsModal, setShowSettingsModal] = useState(false);
  const [detailsSession, setDetailsSession] = useState(null);
  const {
    sessions,
    stages,
    sessionsByStage,
    selectedId,
    selectSession,
    createSession,
    killSession,
    pauseSession,
    resumeSession,
    updateSession,
    moveSession,
    advanceSession,
    rejectSession,
    connectionStatus
  } = useSessions();
  const { isVisible: sidebarVisible, toggle: toggleSidebar, hide: hideSidebar } = useContextSidebar();
  const { settings, updateSettings, resetSettings } = useSettings();
  const { toasts, addToast, removeToast } = useToast();
  const [sessionsWidth, setSessionsWidth] = useState(280);
  const [contextWidth, setContextWidth] = useState(320);
  const [focusedPanel, setFocusedPanel] = useState(null); // 'terminal' | 'context' | null
  const [groupedSessions, setGroupedSessions] = useState([]);
  const [terminalPanes, setTerminalPanes] = useState([]);
  const [activePaneId, setActivePaneId] = useState(null);
  const [paneLayout, setPaneLayout] = useState('row'); // row: split right, column: split down
  const [showCloseSessionModal, setShowCloseSessionModal] = useState(false);
  const [pendingCloseSessionId, setPendingCloseSessionId] = useState(null);
  const [paneSizes, setPaneSizes] = useState([]); // flex ratios for each pane
  const [kanbanColumnFilter, setKanbanColumnFilter] = useState(null); // stage ID filter from kanban

  // Refs for focus management
  const contextRef = useRef(null);
  const paneRefs = useRef(new Map());
  const closingSessionRef = useRef(false);

  // Hint mode configuration from settings
  const hintModeSettings = settings?.keyboard?.hintMode || { enabled: true, triggerKey: '`' };
  const { isActive: hintModeActive, typedChars } = useHintMode({
    enabled: hintModeSettings.enabled,
    triggerKey: hintModeSettings.triggerKey
  });
  const confirmBeforeLeave = settings?.ui?.confirmBeforeLeave ?? true;

  const selectedSession = sessions.find(s => s.id === selectedId);
  const pendingCloseSession = sessions.find(s => s.id === pendingCloseSessionId);

  const focusActiveTerminal = useCallback(() => {
    if (activePaneId) {
      paneRefs.current.get(activePaneId)?.focus?.();
      return;
    }
    const firstPaneId = terminalPanes[0]?.id;
    if (firstPaneId) {
      paneRefs.current.get(firstPaneId)?.focus?.();
    }
  }, [activePaneId, terminalPanes]);

  // Save pane layout on changes
  useEffect(() => {
    if (terminalPanes.length > 0) {
      savePaneLayout(terminalPanes, paneLayout, paneSizes);
    }
  }, [terminalPanes, paneLayout, paneSizes]);

  // Restore pane layout from localStorage on mount
  useEffect(() => {
    const stored = loadPaneLayout();
    if (stored && stored.panes?.length > 0) {
      // Will be filtered to valid sessions in the sync effect below
      setTerminalPanes(stored.panes);
      if (stored.layout) setPaneLayout(stored.layout);
      if (stored.sizes?.length > 0) setPaneSizes(stored.sizes);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Keep paneSizes in sync with pane count
  useEffect(() => {
    setPaneSizes(prev => {
      if (prev.length === terminalPanes.length && terminalPanes.length > 0) return prev;
      // Equal distribution
      return terminalPanes.map(() => 1 / (terminalPanes.length || 1));
    });
  }, [terminalPanes.length]);

  const handlePaneResize = useCallback((index, delta) => {
    setPaneSizes(prev => {
      if (prev.length < 2 || index >= prev.length - 1) return prev;
      const next = [...prev];
      const total = next[index] + next[index + 1];
      // Convert pixel delta to ratio delta (assume container is available)
      const containerSize = paneLayout === 'row'
        ? document.querySelector('.terminal-panes')?.clientWidth || 800
        : document.querySelector('.terminal-panes')?.clientHeight || 400;
      const ratioDelta = delta / containerSize;
      next[index] = Math.max(0.1, Math.min(total - 0.1, next[index] + ratioDelta));
      next[index + 1] = total - next[index];
      return next;
    });
  }, [paneLayout]);

  // Keep pane session references in sync with selected session list.
  useEffect(() => {
    if (currentView !== 'sessions') return;
    const validSessionIds = new Set(sessions.map(s => s.id));
    setTerminalPanes(prev => {
      const next = prev.filter(pane => validSessionIds.has(pane.sessionId));
      if (next.length > 0) {
        return next;
      }
      if (selectedId && validSessionIds.has(selectedId)) {
        return [{ id: makePaneId(), sessionId: selectedId }];
      }
      if (sessions.length > 0) {
        return [{ id: makePaneId(), sessionId: sessions[0].id }];
      }
      return [];
    });
  }, [sessions, selectedId, currentView]);

  // Keep selected session visible in a pane.
  useEffect(() => {
    if (currentView !== 'sessions' || !selectedId) return;
    setTerminalPanes(prev => {
      if (prev.length === 0) return prev;
      if (prev.some(pane => pane.sessionId === selectedId)) return prev;
      const targetPaneId = activePaneId && prev.some(p => p.id === activePaneId)
        ? activePaneId
        : prev[0].id;
      return prev.map(pane =>
        pane.id === targetPaneId ? { ...pane, sessionId: selectedId } : pane
      );
    });
  }, [selectedId, activePaneId, currentView]);

  useEffect(() => {
    if (terminalPanes.length === 0) {
      if (activePaneId !== null) setActivePaneId(null);
      return;
    }
    if (!activePaneId || !terminalPanes.some(p => p.id === activePaneId)) {
      setActivePaneId(terminalPanes[0].id);
    }
  }, [terminalPanes, activePaneId]);

  const createSplitPane = useCallback(async (direction) => {
    if (currentView !== 'sessions') return;
    const sourceSession = sessions.find(s => s.id === selectedId) || sessions[0];
    const workingDir = sourceSession?.workingDir || settings?.session?.defaultWorkingDir || '';
    const now = new Date();
    const timeStamp = now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    const name = `Terminal ${timeStamp}`;
    const createdSession = await createSession(name, workingDir, 'terminal', { select: false });
    if (!createdSession) return;

    const newPaneId = makePaneId();
    setPaneLayout(direction === 'right' ? 'row' : 'column');
    setTerminalPanes(prev => {
      if (prev.length === 0) {
        return [{ id: newPaneId, sessionId: createdSession.id }];
      }
      const activeIndex = activePaneId
        ? prev.findIndex(pane => pane.id === activePaneId)
        : -1;
      const insertAt = activeIndex >= 0 ? activeIndex + 1 : prev.length;
      const next = [...prev];
      next.splice(insertAt, 0, { id: newPaneId, sessionId: createdSession.id });
      return next;
    });
    setActivePaneId(newPaneId);
    selectSession(createdSession.id);
    setFocusedPanel('terminal');
  }, [activePaneId, createSession, currentView, selectSession, selectedId, sessions, settings?.session?.defaultWorkingDir]);

  const requestCloseCurrentSession = useCallback(() => {
    if (currentView !== 'sessions') return;

    let targetSessionId = selectedId;
    if (activePaneId) {
      const activePane = terminalPanes.find(pane => pane.id === activePaneId);
      if (activePane?.sessionId) {
        targetSessionId = activePane.sessionId;
      }
    }

    if (!targetSessionId) return;

    setPendingCloseSessionId(targetSessionId);
    setShowCloseSessionModal(true);
  }, [activePaneId, currentView, selectedId, terminalPanes]);

  const closeFocusedPane = useCallback(async () => {
    if (currentView !== 'sessions' || terminalPanes.length <= 1) return;
    const pane = terminalPanes.find(p => p.id === activePaneId);
    if (!pane) return;
    const paneIndex = terminalPanes.findIndex(p => p.id === activePaneId);
    // Kill the pane's session
    await killSession(pane.sessionId, { skipConfirm: true });
    // Remove the pane
    setTerminalPanes(prev => prev.filter(p => p.id !== activePaneId));
    setPaneSizes(prev => {
      if (prev.length <= 1) return [];
      const next = prev.filter((_, i) => i !== paneIndex);
      // Redistribute removed pane's space
      const total = next.reduce((a, b) => a + b, 0);
      return total > 0 ? next.map(s => s / total) : [];
    });
    // Focus adjacent pane
    const remaining = terminalPanes.filter(p => p.id !== activePaneId);
    if (remaining.length > 0) {
      const newIndex = Math.min(paneIndex, remaining.length - 1);
      setActivePaneId(remaining[newIndex].id);
      selectSession(remaining[newIndex].sessionId);
    }
  }, [activePaneId, currentView, killSession, selectSession, terminalPanes]);

  const navigatePanes = useCallback((direction) => {
    if (terminalPanes.length <= 1) return;
    const currentIndex = terminalPanes.findIndex(p => p.id === activePaneId);
    if (currentIndex === -1) return;
    let newIndex;
    if (direction === 'ArrowRight' || direction === 'ArrowDown') {
      newIndex = (currentIndex + 1) % terminalPanes.length;
    } else {
      newIndex = (currentIndex - 1 + terminalPanes.length) % terminalPanes.length;
    }
    const newPane = terminalPanes[newIndex];
    setActivePaneId(newPane.id);
    selectSession(newPane.sessionId);
    setFocusedPanel('terminal');
    setTimeout(() => paneRefs.current.get(newPane.id)?.focus?.(), 0);
  }, [activePaneId, selectSession, terminalPanes]);

  const handleConfirmCloseCurrentSession = useCallback(async () => {
    if (!pendingCloseSessionId) return;
    const success = await killSession(pendingCloseSessionId, { skipConfirm: true });
    closingSessionRef.current = false;
    if (success) {
      setShowCloseSessionModal(false);
      setPendingCloseSessionId(null);
    }
  }, [killSession, pendingCloseSessionId]);

  const handleCancelCloseCurrentSession = useCallback(() => {
    closingSessionRef.current = false;
    setShowCloseSessionModal(false);
    setPendingCloseSessionId(null);
  }, []);

  // Protect against accidental tab/window close (e.g. Ctrl+W)
  useEffect(() => {
    if (!confirmBeforeLeave) {
      return undefined;
    }

    const handleBeforeUnload = (event) => {
      if (closingSessionRef.current) return;
      event.preventDefault();
      event.returnValue = '';
    };

    window.addEventListener('beforeunload', handleBeforeUnload);
    return () => window.removeEventListener('beforeunload', handleBeforeUnload);
  }, [confirmBeforeLeave]);

  // Blur active element when hint mode activates (prevent terminal from capturing keys)
  useEffect(() => {
    if (hintModeActive && document.activeElement) {
      document.activeElement.blur();
    }
  }, [hintModeActive]);

  // Register panel focus hints
  useEffect(() => {
    registerHint('tm', {
      action: () => {
        setFocusedPanel('terminal');
        focusActiveTerminal();
      },
      label: 'Focus Terminal'
    });
    registerHint('cx', {
      action: () => {
        setFocusedPanel('context');
        contextRef.current?.focus();
      },
      label: 'Focus Context'
    });

    return () => {
      unregisterHint('tm');
      unregisterHint('cx');
    };
  }, [focusActiveTerminal]);

  // Session navigation functions
  const navigateSession = useCallback((direction) => {
    if (!selectedId || groupedSessions.length === 0) return;

    // Find current session's group
    let currentGroupIndex = -1;
    let currentIndexInGroup = -1;

    for (let gi = 0; gi < groupedSessions.length; gi++) {
      const [, sessionsInGroup] = groupedSessions[gi];
      for (let si = 0; si < sessionsInGroup.length; si++) {
        if (sessionsInGroup[si].session.id === selectedId) {
          currentGroupIndex = gi;
          currentIndexInGroup = si;
          break;
        }
      }
      if (currentGroupIndex !== -1) break;
    }

    if (currentGroupIndex === -1) {
      // Selected session is no longer in the filtered list (e.g., moved to another kanban stage).
      // Fall back to the first session in the first group.
      if (groupedSessions.length > 0) {
        const [, firstGroup] = groupedSessions[0];
        if (firstGroup.length > 0) {
          selectSession(firstGroup[0].session.id);
        }
      }
      return;
    }

    const [, sessionsInGroup] = groupedSessions[currentGroupIndex];

    if (direction === 'next') {
      const nextIndex = (currentIndexInGroup + 1) % sessionsInGroup.length;
      selectSession(sessionsInGroup[nextIndex].session.id);
    } else {
      const prevIndex = (currentIndexInGroup - 1 + sessionsInGroup.length) % sessionsInGroup.length;
      selectSession(sessionsInGroup[prevIndex].session.id);
    }
  }, [selectedId, groupedSessions, selectSession]);

  const navigateGroup = useCallback((direction) => {
    if (groupedSessions.length === 0) return;

    // Find current group index
    let currentGroupIndex = -1;
    for (let gi = 0; gi < groupedSessions.length; gi++) {
      const [, sessionsInGroup] = groupedSessions[gi];
      if (sessionsInGroup.some(s => s.session.id === selectedId)) {
        currentGroupIndex = gi;
        break;
      }
    }

    if (currentGroupIndex === -1) {
      // No current selection, go to first group
      currentGroupIndex = direction === 'next' ? -1 : groupedSessions.length;
    }

    if (direction === 'next') {
      const nextGroupIndex = (currentGroupIndex + 1) % groupedSessions.length;
      const [, sessions] = groupedSessions[nextGroupIndex];
      selectSession(sessions[0].session.id);
    } else {
      const prevGroupIndex = (currentGroupIndex - 1 + groupedSessions.length) % groupedSessions.length;
      const [, sessions] = groupedSessions[prevGroupIndex];
      selectSession(sessions[0].session.id);
    }
  }, [selectedId, groupedSessions, selectSession]);

  // Keyboard shortcuts for panel resize and session navigation
  // Kanban arrow key navigation
  const navigateKanban = useCallback((key) => {
    const sortSessions = (list) => {
      return [...list].sort((a, b) => {
        const statusOrder = { active: 0, thinking: 0, editing: 0, idle: 1, waiting: 1, paused: 2, completed: 3 };
        const statusDiff = (statusOrder[a.status] ?? 3) - (statusOrder[b.status] ?? 3);
        if (statusDiff !== 0) return statusDiff;
        return (b.priority || 0) - (a.priority || 0);
      });
    };

    let currentColIndex = -1;
    let currentSessionIndex = -1;
    const columnSessions = stages.map((stage, i) => {
      const sorted = sortSessions(sessionsByStage[stage.id] || []);
      const idx = sorted.findIndex(s => s.id === selectedId);
      if (idx !== -1) {
        currentColIndex = i;
        currentSessionIndex = idx;
      }
      return sorted;
    });

    if (key === 'ArrowLeft' || key === 'ArrowRight') {
      const dir = key === 'ArrowRight' ? 1 : -1;
      let targetCol = currentColIndex === -1 ? 0 : currentColIndex;
      for (let i = 0; i < stages.length; i++) {
        targetCol = (targetCol + dir + stages.length) % stages.length;
        if (columnSessions[targetCol].length > 0) break;
      }
      if (columnSessions[targetCol].length > 0) {
        selectSession(columnSessions[targetCol][0].id);
      }
    } else {
      if (currentColIndex === -1) {
        const firstNonEmpty = columnSessions.find(col => col.length > 0);
        if (firstNonEmpty) selectSession(firstNonEmpty[0].id);
        return;
      }
      const col = columnSessions[currentColIndex];
      if (col.length === 0) return;
      const dir = key === 'ArrowDown' ? 1 : -1;
      const nextIndex = (currentSessionIndex + dir + col.length) % col.length;
      selectSession(col[nextIndex].id);
    }
  }, [stages, sessionsByStage, selectedId, selectSession]);

  useEffect(() => {
    const handleKeyDown = (e) => {
      // Skip if hint mode is active (let hint mode handle keys)
      if (hintModeActive) return;

      // Skip if terminal override mode is active (let terminal handle keys)
      if (window.__terminalOverrideKeys) return;

      const target = e.target;
      const isEditableTarget = target instanceof HTMLElement && (
        target.tagName === 'INPUT' ||
        (target.tagName === 'TEXTAREA' && !target.closest('.xterm')) ||
        target.tagName === 'SELECT' ||
        target.isContentEditable
      );
      if (isEditableTarget) return;

      // Ctrl+O: toggle between sessions and kanban views
      if (e.ctrlKey && !e.altKey && !e.shiftKey && !e.metaKey && e.key.toLowerCase() === 'o') {
        e.preventDefault();
        setCurrentView(prev => prev === 'sessions' ? 'kanban' : 'sessions');
        return;
      }

      // Arrow keys for kanban navigation (bare arrows, no modifiers)
      if (currentView === 'kanban' && !e.ctrlKey && !e.altKey && !e.shiftKey && !e.metaKey) {
        if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(e.key)) {
          e.preventDefault();
          navigateKanban(e.key);
          return;
        }
      }

      if (isSplitRightShortcut(e)) {
        e.preventDefault();
        createSplitPane('right');
        return;
      }

      if (isSplitBottomShortcut(e)) {
        e.preventDefault();
        createSplitPane('down');
        return;
      }

      // Ctrl+Shift+W closes focused pane (before Ctrl+W check)
      if (isClosePaneShortcut(e)) {
        e.preventDefault();
        e.stopPropagation();
        closeFocusedPane();
        return;
      }

      // Alt+Arrow navigates between panes
      if (isPaneFocusShortcut(e)) {
        e.preventDefault();
        navigatePanes(e.key);
        return;
      }

      if (isCloseSessionShortcut(e)) {
        e.preventDefault();
        e.stopPropagation();
        closingSessionRef.current = true;
        requestCloseCurrentSession();
        return;
      }

      if (e.ctrlKey && e.altKey) {
        const resizeStep = 50;
        const maxWidth = Math.floor(window.innerWidth * 0.7);

        // Panel resize: Ctrl+Alt+Arrow keys
        if (e.key === 'ArrowLeft') {
          e.preventDefault();
          // Left arrow makes context narrower (terminal wider)
          setContextWidth(w => Math.max(250, w - resizeStep));
        }

        if (e.key === 'ArrowRight') {
          e.preventDefault();
          // Right arrow makes context wider (terminal narrower)
          setContextWidth(w => Math.min(maxWidth, w + resizeStep));
        }
      }

      // Session navigation: Ctrl+[ ] ; ' (works even when terminal is focused)
      if (e.ctrlKey && !e.altKey && !e.shiftKey && !e.metaKey) {
        if (e.code === 'BracketRight' || e.key === ']') {
          e.preventDefault();
          navigateSession('next');
        }
        if (e.code === 'BracketLeft' || e.key === '[') {
          e.preventDefault();
          navigateSession('prev');
        }
        if (e.key === "'") {
          e.preventDefault();
          navigateGroup('next');
        }
        if (e.key === ';') {
          e.preventDefault();
          navigateGroup('prev');
        }
      }
    };

    window.addEventListener('keydown', handleKeyDown, true);
    return () => window.removeEventListener('keydown', handleKeyDown, true);
  }, [closeFocusedPane, createSplitPane, hintModeActive, focusedPanel, navigatePanes, navigateSession, navigateGroup, requestCloseCurrentSession, currentView, navigateKanban]);

  const handleSessionsResize = useCallback((delta) => {
    setSessionsWidth(w => Math.max(200, Math.min(400, w + delta)));
  }, []);

  const handleContextResize = useCallback((delta) => {
    // Calculate 70% of viewport width as max
    const maxWidth = Math.floor(window.innerWidth * 0.7);
    setContextWidth(w => Math.max(250, Math.min(maxWidth, w + delta)));
  }, []);

  const handleCreateSession = async (name, workingDir, cliType) => {
    const createdSession = await createSession(name, workingDir, cliType);
    if (createdSession) {
      setShowNewSessionModal(false);
    }
    return !!createdSession;
  };

  const handleSessionSelectFromKanban = useCallback((sessionId, stageId) => {
    selectSession(sessionId);
    setCurrentView('sessions');
    setKanbanColumnFilter(stageId || null);
  }, [selectSession]);

  const handleClearKanbanFilter = useCallback(() => {
    setKanbanColumnFilter(null);
  }, []);

  const handleShowDetails = (session) => {
    setDetailsSession(session);
  };

  const handleCloseDetails = () => {
    setDetailsSession(null);
  };

  const handleUpdateSession = async (id, updates) => {
    const success = await updateSession(id, updates);
    if (success) {
      // Update the details modal with the latest data
      const updatedSession = sessions.find(s => s.id === id);
      if (updatedSession) {
        setDetailsSession({ ...updatedSession, ...updates });
      }
    }
    return success;
  };

  const handleKillFromDetails = async (id) => {
    const success = await killSession(id);
    if (success) {
      setDetailsSession(null);
    }
    return success;
  };

  const handlePauseFromDetails = async (id) => {
    const success = await pauseSession(id);
    if (success) {
      // Update details modal
      setDetailsSession(prev => prev ? { ...prev, status: 'paused' } : null);
    }
    return success;
  };

  const handleResumeFromDetails = async (id) => {
    const success = await resumeSession(id);
    if (success) {
      // Update details modal
      setDetailsSession(prev => prev ? { ...prev, status: 'active' } : null);
    }
    return success;
  };

  return (
    <div className={`app-container ${hintModeActive ? 'hint-mode-active' : ''}`}>
      <aside className="sidebar sessions-sidebar" style={{ width: sessionsWidth, minWidth: sessionsWidth }}>
        <div className="sidebar-header">
          <h1>Claude Manager</h1>
          <div className="view-toggle">
            <button
              className={`view-toggle-btn ${currentView === 'sessions' ? 'active' : ''}`}
              onClick={() => setCurrentView('sessions')}
            >
              Sessions
            </button>
            <button
              className={`view-toggle-btn ${currentView === 'kanban' ? 'active' : ''}`}
              onClick={() => setCurrentView('kanban')}
            >
              Kanban
            </button>
          </div>
        </div>
        <Dashboard
          sessions={sessions}
          selectedId={selectedId}
          onSelectSession={selectSession}
          onNewSession={() => setShowNewSessionModal(true)}
          onShowDetails={handleShowDetails}
          onOpenSettings={() => setShowSettingsModal(true)}
          onUpdateSession={updateSession}
          onKillSession={killSession}
          onResumeSession={resumeSession}
          connectionStatus={connectionStatus}
          hintModeActive={hintModeActive}
          typedChars={typedChars}
          hintCodes={settings?.keyboard?.hintMode?.hints || {}}
          onGroupedSessionsChange={setGroupedSessions}
          kanbanColumnFilter={kanbanColumnFilter}
          onClearKanbanFilter={handleClearKanbanFilter}
        />
      </aside>
      <ResizeHandle onResize={handleSessionsResize} />
      {currentView === 'kanban' ? (
        <main className="main-content">
          <KanbanBoard
            sessions={sessions}
            stages={stages}
            sessionsByStage={sessionsByStage}
            moveSession={moveSession}
            advanceSession={advanceSession}
            rejectSession={rejectSession}
            settings={settings}
            onUpdateSession={updateSession}
            onSessionSelect={handleSessionSelectFromKanban}
            onCreateSession={(stageId) => {
              setShowNewSessionModal(true);
            }}
            selectedSessionId={selectedId}
            onPauseSession={pauseSession}
            onResumeSession={resumeSession}
            onKillSession={killSession}
            addToast={addToast}
          />
        </main>
      ) : (
        <>
      {selectedSession && sidebarVisible && (
        <>
          <aside
            className="sidebar context-sidebar-column"
            style={{ width: contextWidth, minWidth: contextWidth, position: 'relative' }}
            onClick={() => setFocusedPanel('context')}
            ref={contextRef}
            tabIndex={-1}
          >
            <HintBadge
              code="cx"
              visible={hintModeActive}
              position="top-left"
              typedChars={typedChars}
            />
            <ContextSidebar
              session={selectedSession}
              onClose={hideSidebar}
              onUpdateSession={updateSession}
              onFocus={() => setFocusedPanel('context')}
            />
          </aside>
          <ResizeHandle onResize={handleContextResize} />
        </>
      )}
      <main
        className="main-content"
        style={{ position: 'relative' }}
        onClick={() => setFocusedPanel('terminal')}
      >
        <HintBadge
          code="tm"
          visible={hintModeActive && selectedSession}
          position="top-left"
          typedChars={typedChars}
        />
        {terminalPanes.length > 0 ? (
          <div className={`terminal-panes terminal-panes-${paneLayout}`}>
            {terminalPanes.map((pane, index) => {
              const paneSession = sessions.find(s => s.id === pane.sessionId);
              if (!paneSession) return null;
              const flexValue = paneSizes[index] || (1 / terminalPanes.length);

              return (
                <React.Fragment key={pane.id}>
                  {index > 0 && (
                    <ResizeHandle
                      direction={paneLayout === 'row' ? 'vertical' : 'horizontal'}
                      onResize={(delta) => handlePaneResize(index - 1, delta)}
                    />
                  )}
                  <div
                    className={`terminal-pane ${activePaneId === pane.id ? 'active' : ''}`}
                    style={{ flex: flexValue }}
                  >
                    <TerminalView
                      ref={(instance) => {
                        if (instance) {
                          paneRefs.current.set(pane.id, instance);
                        } else {
                          paneRefs.current.delete(pane.id);
                        }
                      }}
                      session={paneSession}
                      onKillSession={() => killSession(paneSession.id)}
                      onPauseSession={pauseSession}
                      onResumeSession={resumeSession}
                      onToggleSidebar={toggleSidebar}
                      sidebarVisible={sidebarVisible}
                      settings={settings}
                      onUpdateSession={updateSession}
                      hintModeActive={hintModeActive}
                      typedChars={typedChars}
                      hintCodes={settings?.keyboard?.hintMode?.hints || {}}
                      onFocus={() => {
                        setActivePaneId(pane.id);
                        setFocusedPanel('terminal');
                        selectSession(paneSession.id);
                      }}
                    />
                  </div>
                </React.Fragment>
              );
            })}
          </div>
        ) : (
          <div className="terminal-placeholder">
            <div className="terminal-placeholder-icon">🖥️</div>
            <p>Select a session or create a new one</p>
          </div>
        )}
      </main>
        </>
      )}
      {showNewSessionModal && (
        <NewSessionModal
          onClose={() => setShowNewSessionModal(false)}
          onCreate={handleCreateSession}
          defaultWorkingDir={selectedSession?.workingDir}
        />
      )}
      {showSettingsModal && (
        <SettingsModal
          settings={settings}
          onClose={() => setShowSettingsModal(false)}
          onSave={updateSettings}
          onReset={resetSettings}
        />
      )}
      {detailsSession && (
        <SessionDetailsModal
          session={detailsSession}
          onClose={handleCloseDetails}
          onUpdate={handleUpdateSession}
          onPause={handlePauseFromDetails}
          onResume={handleResumeFromDetails}
          onKill={handleKillFromDetails}
        />
      )}
      {hintModeActive && (
        <div className="hint-mode-indicator">
          <span>Hint Mode</span>
          <span className="typed-chars">{typedChars || '_'}</span>
        </div>
      )}
      {showCloseSessionModal && pendingCloseSession && (
        <div className="modal-overlay" onClick={handleCancelCloseCurrentSession} onKeyDown={e => { if (e.key === 'Escape') handleCancelCloseCurrentSession(); }}>
          <div className="modal" onClick={e => e.stopPropagation()}>
            <h2>Close Current Session?</h2>
            <p className="settings-description">
              This will kill session <strong>{pendingCloseSession.name}</strong> and keep this browser tab open.
            </p>
            <div className="modal-actions">
              <button className="btn btn-secondary" onClick={handleCancelCloseCurrentSession} autoFocus>
                Cancel
              </button>
              <button className="btn btn-danger" onClick={handleConfirmCloseCurrentSession}>
                Kill Session
              </button>
            </div>
          </div>
        </div>
      )}
      <ToastContainer toasts={toasts} onRemove={removeToast} />
    </div>
  );
}

export default App;

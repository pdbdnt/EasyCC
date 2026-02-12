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

function getGridLayout(count) {
  if (count <= 1) return { cols: 1, rows: 1 };
  if (count === 2) return { cols: 2, rows: 1 };
  if (count <= 4) return { cols: 2, rows: Math.ceil(count / 2) };
  if (count <= 6) return { cols: 3, rows: Math.ceil(count / 3) };
  return { cols: 4, rows: Math.ceil(count / 4) };
}

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

const CTRL_O_TRANSITION_MS = 280;

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
    selectedIds,
    selectSession,
    setActiveSelectedId,
    toggleSelectSession,
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
  const [focusedColumnId, setFocusedColumnId] = useState(null); // stage ID when empty kanban column focused
  const [multiPaneLayout, setMultiPaneLayout] = useState('auto'); // 'auto' | 'row' | 'column'
  const [multiPaneSizes, setMultiPaneSizes] = useState(null); // null=equal, Array for row/col, {cols:[]} for grid
  const [viewTransition, setViewTransition] = useState({
    active: false,
    direction: null,
    reason: 'other',
    nonce: 0
  });
  const [flipTriggerNonce, setFlipTriggerNonce] = useState(0);

  // Refs for focus management
  const contextRef = useRef(null);
  const paneRefs = useRef(new Map());
  const closingSessionRef = useRef(false);
  const wasMultiSelectRef = useRef(false);
  const ctrlOTransitionTimerRef = useRef(null);

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

  const switchView = useCallback((nextView, options = {}) => {
    const reason = options.reason || 'other';
    const fromView = options.fromView || currentView;
    if (fromView === nextView) return;

    const reducedMotion = typeof window !== 'undefined' &&
      window.matchMedia &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const shouldAnimateCtrlO = reason === 'ctrl-o' && !reducedMotion;

    if (shouldAnimateCtrlO) {
      const direction = fromView === 'kanban' && nextView === 'sessions'
        ? 'k2s'
        : (fromView === 'sessions' && nextView === 'kanban' ? 's2k' : null);

      if (direction) {
        if (ctrlOTransitionTimerRef.current) {
          clearTimeout(ctrlOTransitionTimerRef.current);
        }
        setViewTransition((prev) => ({
          active: true,
          direction,
          reason: 'ctrl-o',
          nonce: prev.nonce + 1
        }));
        if (direction === 'k2s') {
          setFlipTriggerNonce((n) => n + 1);
        }
        ctrlOTransitionTimerRef.current = setTimeout(() => {
          setViewTransition((prev) => ({ ...prev, active: false }));
          ctrlOTransitionTimerRef.current = null;
        }, CTRL_O_TRANSITION_MS);
      }
    } else {
      setViewTransition((prev) => (
        prev.active ? { ...prev, active: false, reason: 'other', direction: null } : prev
      ));
    }

    setCurrentView(nextView);
  }, [currentView]);

  // Save pane layout on changes
  useEffect(() => {
    if (terminalPanes.length > 0) {
      savePaneLayout(terminalPanes, paneLayout, paneSizes);
    }
  }, [terminalPanes, paneLayout, paneSizes]);

  useEffect(() => {
    return () => {
      if (ctrlOTransitionTimerRef.current) {
        clearTimeout(ctrlOTransitionTimerRef.current);
      }
    };
  }, []);

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

  // Reset multi-pane sizes when pane count or layout mode changes
  const prevMultiCountRef = useRef(0);
  const prevMultiLayoutRef = useRef(multiPaneLayout);
  useEffect(() => {
    const count = terminalPanes.length;
    if (count !== prevMultiCountRef.current || multiPaneLayout !== prevMultiLayoutRef.current) {
      setMultiPaneSizes(null);
      prevMultiCountRef.current = count;
      prevMultiLayoutRef.current = multiPaneLayout;
    }
  }, [terminalPanes.length, multiPaneLayout]);

  // Resize handler for multi-pane mode (row/column/grid)
  const handleMultiPaneResize = useCallback((index, delta, mode) => {
    setMultiPaneSizes(prev => {
      const count = terminalPanes.length;
      if (count < 2) return prev;

      if (mode === 'row' || mode === 'column') {
        const sizes = Array.isArray(prev) ? [...prev] : Array(count).fill(1 / count);
        const containerEl = document.querySelector('.terminal-panes');
        const containerSize = mode === 'row' ? containerEl?.clientWidth : containerEl?.clientHeight;
        if (!containerSize) return prev;

        const total = sizes[index] + sizes[index + 1];
        const ratioDelta = delta / containerSize;
        sizes[index] = Math.max(0.05, Math.min(total - 0.05, sizes[index] + ratioDelta));
        sizes[index + 1] = total - sizes[index];
        return sizes;
      }

      if (mode === 'grid-col') {
        const { cols } = getGridLayout(count);
        const colSizes = prev?.cols ? [...prev.cols] : Array(cols).fill(1 / cols);
        const containerEl = document.querySelector('.terminal-panes');
        const containerWidth = containerEl?.clientWidth || 800;
        const ratioDelta = delta / containerWidth;
        const total = colSizes[index] + colSizes[index + 1];
        colSizes[index] = Math.max(0.05, Math.min(total - 0.05, colSizes[index] + ratioDelta));
        colSizes[index + 1] = total - colSizes[index];
        return { cols: colSizes };
      }

      return prev;
    });
  }, [terminalPanes.length]);

  const resetMultiPaneSizes = useCallback(() => {
    setMultiPaneSizes(null);
  }, []);

  // Consolidated pane sync: keeps panes in sync with selection and session list.
  useEffect(() => {
    if (currentView !== 'sessions') return;
    const validSessionIds = new Set(sessions.map(s => s.id));

    if (selectedIds.length > 1) {
      wasMultiSelectRef.current = true;
      // Multi-select mode: build panes from selectedIds
      const validSelected = selectedIds.filter(id => validSessionIds.has(id));
      if (validSelected.length === 0) {
        setTerminalPanes([]);
        return;
      }
      setTerminalPanes(prev => {
        return validSelected.map(sid => {
          const existing = prev.find(p => p.sessionId === sid);
          return existing || { id: makePaneId(), sessionId: sid };
        });
      });
    } else {
      // Transitioning from multi to single: collapse to one pane
      if (wasMultiSelectRef.current) {
        wasMultiSelectRef.current = false;
        const singleId = selectedIds[0] || (sessions.length > 0 ? sessions[0].id : null);
        if (!singleId || !validSessionIds.has(singleId)) {
          if (sessions.length > 0) {
            setTerminalPanes([{ id: makePaneId(), sessionId: sessions[0].id }]);
          } else {
            setTerminalPanes([]);
          }
          return;
        }
        setTerminalPanes(prev => {
          const existing = prev.find(p => p.sessionId === singleId);
          return [existing || { id: makePaneId(), sessionId: singleId }];
        });
        return;
      }

      // Normal single-select mode (preserves split panes)
      // When kanban filter is active with no selection, don't fallback to first session
      const singleId = selectedIds[0] ||
        (kanbanColumnFilter ? null : (sessions.length > 0 ? sessions[0].id : null));
      if (!singleId || !validSessionIds.has(singleId)) {
        setTerminalPanes(prev => {
          const next = prev.filter(p => validSessionIds.has(p.sessionId));
          if (next.length > 0) return next;
          if (sessions.length > 0) return [{ id: makePaneId(), sessionId: sessions[0].id }];
          return [];
        });
        return;
      }
      setTerminalPanes(prev => {
        const valid = prev.filter(p => validSessionIds.has(p.sessionId));
        if (valid.length === 0) return [{ id: makePaneId(), sessionId: singleId }];
        if (valid.some(p => p.sessionId === singleId)) return valid;
        const targetPaneId = activePaneId && valid.some(p => p.id === activePaneId)
          ? activePaneId : valid[0].id;
        return valid.map(p => p.id === targetPaneId ? { ...p, sessionId: singleId } : p);
      });
    }
  }, [selectedIds, sessions, currentView, activePaneId, kanbanColumnFilter]);

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
    if (selectedIds.length <= 1) {
      selectSession(newPane.sessionId);
    }
    setFocusedPanel('terminal');
    setTimeout(() => paneRefs.current.get(newPane.id)?.focus?.(), 0);
  }, [activePaneId, selectSession, selectedIds, terminalPanes]);

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

  const handleSessionSelectFromKanban = useCallback((sessionId, stageId) => {
    selectSession(sessionId);
    switchView('sessions', { reason: 'other', fromView: 'kanban' });
    setKanbanColumnFilter(stageId || null);
  }, [selectSession, switchView]);

  // Clear focused column when a session gets selected
  useEffect(() => {
    if (selectedId && focusedColumnId) setFocusedColumnId(null);
  }, [selectedId, focusedColumnId]);

  // Auto-clear focus when a session arrives in the focused empty column
  useEffect(() => {
    if (focusedColumnId && (sessionsByStage[focusedColumnId] || []).length > 0) {
      setFocusedColumnId(null);
      selectSession(sessionsByStage[focusedColumnId][0].id);
    }
  }, [focusedColumnId, sessionsByStage, selectSession]);

  // Auto-select when a session arrives in a filtered-but-empty sessions view (watch mode)
  useEffect(() => {
    if (currentView !== 'sessions' || !kanbanColumnFilter) return;
    if (selectedId) return;
    const matchingSessions = sessions.filter(s => s.stage === kanbanColumnFilter);
    if (matchingSessions.length > 0) {
      selectSession(matchingSessions[0].id);
    }
  }, [currentView, kanbanColumnFilter, selectedId, sessions, selectSession]);

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

    // If no session selected but a column is focused, use that as current position
    if (currentColIndex === -1 && focusedColumnId) {
      currentColIndex = stages.findIndex(s => s.id === focusedColumnId);
    }

    if (key === 'ArrowLeft' || key === 'ArrowRight') {
      const dir = key === 'ArrowRight' ? 1 : -1;
      // If nothing selected/focused yet, start at first column (ArrowRight) or last (ArrowLeft)
      let targetCol;
      if (currentColIndex === -1) {
        targetCol = dir === 1 ? 0 : stages.length - 1;
      } else {
        targetCol = (currentColIndex + dir + stages.length) % stages.length;
      }

      if (columnSessions[targetCol].length > 0) {
        // Non-empty column: select first session, clear column focus
        setFocusedColumnId(null);
        selectSession(columnSessions[targetCol][0].id);
      } else {
        // Empty column: focus the column, deselect any session
        selectSession(null);
        setFocusedColumnId(stages[targetCol].id);
      }
    } else {
      // Up/Down: no-op if empty column is focused
      if (focusedColumnId) return;

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
  }, [stages, sessionsByStage, selectedId, selectSession, focusedColumnId]);

  // Refs for keyboard handler -- allows mount-once effect with no dependency churn
  const hintModeActiveRef = useRef(hintModeActive);
  const currentViewRef = useRef(currentView);
  const selectedIdRef = useRef(selectedId);
  const stagesRef = useRef(stages);
  const sessionsByStageRef = useRef(sessionsByStage);
  const navigateSessionRef = useRef(navigateSession);
  const navigateGroupRef = useRef(navigateGroup);
  const navigateKanbanRef = useRef(navigateKanban);
  const createSplitPaneRef = useRef(createSplitPane);
  const closeFocusedPaneRef = useRef(closeFocusedPane);
  const navigatePanesRef = useRef(navigatePanes);
  const requestCloseCurrentSessionRef = useRef(requestCloseCurrentSession);
  const handleSessionSelectFromKanbanRef = useRef(handleSessionSelectFromKanban);
  const switchViewRef = useRef(switchView);
  const focusedColumnIdRef = useRef(focusedColumnId);
  const kanbanColumnFilterRef = useRef(kanbanColumnFilter);

  // Sync refs during render (no effect needed)
  hintModeActiveRef.current = hintModeActive;
  currentViewRef.current = currentView;
  selectedIdRef.current = selectedId;
  stagesRef.current = stages;
  sessionsByStageRef.current = sessionsByStage;
  navigateSessionRef.current = navigateSession;
  navigateGroupRef.current = navigateGroup;
  navigateKanbanRef.current = navigateKanban;
  createSplitPaneRef.current = createSplitPane;
  closeFocusedPaneRef.current = closeFocusedPane;
  navigatePanesRef.current = navigatePanes;
  requestCloseCurrentSessionRef.current = requestCloseCurrentSession;
  handleSessionSelectFromKanbanRef.current = handleSessionSelectFromKanban;
  switchViewRef.current = switchView;
  focusedColumnIdRef.current = focusedColumnId;
  kanbanColumnFilterRef.current = kanbanColumnFilter;

  // Mount-once keyboard handler -- reads all dynamic values from refs
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => {
    const handleKeyDown = (e) => {
      // Skip if hint mode is active (let hint mode handle keys)
      if (hintModeActiveRef.current) return;

      // ── Always-intercept shortcuts (even in terminal override mode) ──

      // Ctrl+Shift+W: close focused pane
      if (isClosePaneShortcut(e)) {
        e.preventDefault();
        e.stopPropagation();
        closeFocusedPaneRef.current();
        return;
      }

      // Ctrl+W / Cmd+W: close current session (never let browser close tab)
      if (isCloseSessionShortcut(e)) {
        e.preventDefault();
        e.stopPropagation();
        closingSessionRef.current = true;
        requestCloseCurrentSessionRef.current();
        return;
      }

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
        const currentView = currentViewRef.current;
        if (currentView === 'kanban') {
          // Switching to sessions: check focused column first, then selected session
          const focusedCol = focusedColumnIdRef.current;
          if (focusedCol) {
            setKanbanColumnFilter(focusedCol);
            setFocusedColumnId(null);
            selectSession(null); // Clear selection so no terminal shows for empty stage
          } else {
            const selId = selectedIdRef.current;
            if (selId) {
              const stageId = stagesRef.current.find(stage =>
                (sessionsByStageRef.current[stage.id] || []).some(s => s.id === selId)
              )?.id;
              setKanbanColumnFilter(stageId || null);
            }
          }
          switchViewRef.current('sessions', { reason: 'ctrl-o', fromView: currentView });
        } else {
          // Switching to kanban: restore focused column if filter matches an empty stage
          const currentFilter = kanbanColumnFilterRef.current;
          if (currentFilter) {
            const stageExists = stagesRef.current.some(s => s.id === currentFilter);
            const hasSessionsInStage = (sessionsByStageRef.current[currentFilter] || []).length > 0;
            if (stageExists && !hasSessionsInStage) {
              setFocusedColumnId(currentFilter);
            }
          }
          setKanbanColumnFilter(null);
          switchViewRef.current('kanban', { reason: 'ctrl-o', fromView: currentView });
        }
        return;
      }

      // Arrow keys + Enter for kanban navigation (bare keys, no modifiers)
      if (currentViewRef.current === 'kanban' && !e.ctrlKey && !e.altKey && !e.shiftKey && !e.metaKey) {
        if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(e.key)) {
          e.preventDefault();
          navigateKanbanRef.current(e.key);
          return;
        }
        if (e.key === 'Enter') {
          // Enter on focused empty column: switch to sessions view with that filter
          const focusedCol = focusedColumnIdRef.current;
          if (focusedCol) {
            e.preventDefault();
            setKanbanColumnFilter(focusedCol);
            setFocusedColumnId(null);
            switchViewRef.current('sessions', { reason: 'other', fromView: 'kanban' });
            return;
          }
          // Enter on selected session: switch to sessions view
          if (selectedIdRef.current) {
            e.preventDefault();
            const selId = selectedIdRef.current;
            const stageId = stagesRef.current.find(stage =>
              (sessionsByStageRef.current[stage.id] || []).some(s => s.id === selId)
            )?.id;
            handleSessionSelectFromKanbanRef.current(selId, stageId);
            return;
          }
        }
      }

      if (isSplitRightShortcut(e)) {
        e.preventDefault();
        createSplitPaneRef.current('right');
        return;
      }

      if (isSplitBottomShortcut(e)) {
        e.preventDefault();
        createSplitPaneRef.current('down');
        return;
      }

      // Alt+Arrow navigates between panes
      if (isPaneFocusShortcut(e)) {
        e.preventDefault();
        navigatePanesRef.current(e.key);
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
          navigateSessionRef.current('next');
        }
        if (e.code === 'BracketLeft' || e.key === '[') {
          e.preventDefault();
          navigateSessionRef.current('prev');
        }
        if (e.key === "'") {
          e.preventDefault();
          navigateGroupRef.current('next');
        }
        if (e.key === ';') {
          e.preventDefault();
          navigateGroupRef.current('prev');
        }
      }
    };

    window.addEventListener('keydown', handleKeyDown, true);
    return () => window.removeEventListener('keydown', handleKeyDown, true);
  }, []);

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

  const ctrlOTransitionClass = viewTransition.active && viewTransition.reason === 'ctrl-o' && viewTransition.direction
    ? `ctrl-o-transition ctrl-o-transition-${viewTransition.direction}`
    : '';

  return (
    <div className={`app-container ${hintModeActive ? 'hint-mode-active' : ''}`}>
      <aside className="sidebar sessions-sidebar" style={{ width: sessionsWidth, minWidth: sessionsWidth }}>
        <div className="sidebar-header">
          <h1>CliMan</h1>
          <div className="view-toggle">
            <button
              className={`view-toggle-btn ${currentView === 'sessions' ? 'active' : ''}`}
              onClick={() => switchView('sessions', { reason: 'other', fromView: currentView })}
            >
              Sessions
            </button>
            <button
              className={`view-toggle-btn ${currentView === 'kanban' ? 'active' : ''}`}
              onClick={() => switchView('kanban', { reason: 'other', fromView: currentView })}
            >
              Kanban
            </button>
          </div>
        </div>
        <Dashboard
          sessions={sessions}
          selectedId={selectedId}
          selectedIds={selectedIds}
          onSelectSession={selectSession}
          onToggleSelectSession={toggleSelectSession}
          onNewSession={() => setShowNewSessionModal(true)}
          onShowDetails={handleShowDetails}
          onOpenSettings={() => setShowSettingsModal(true)}
          onUpdateSession={updateSession}
          onMoveSession={moveSession}
          onKillSession={killSession}
          onResumeSession={resumeSession}
          connectionStatus={connectionStatus}
          hintModeActive={hintModeActive}
          typedChars={typedChars}
          hintCodes={settings?.keyboard?.hintMode?.hints || {}}
          onGroupedSessionsChange={setGroupedSessions}
          kanbanColumnFilter={kanbanColumnFilter}
          onClearKanbanFilter={handleClearKanbanFilter}
          stages={stages}
          viewTransition={viewTransition}
          flipTriggerNonce={flipTriggerNonce}
        />
      </aside>
      <ResizeHandle onResize={handleSessionsResize} />
      {currentView === 'kanban' ? (
        <main className={`main-content ${ctrlOTransitionClass}`.trim()}>
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
            focusedColumnId={focusedColumnId}
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
        className={`main-content ${ctrlOTransitionClass}`.trim()}
        style={{ position: 'relative' }}
        onClick={() => setFocusedPanel('terminal')}
      >
        <HintBadge
          code="tm"
          visible={hintModeActive && selectedSession}
          position="top-left"
          typedChars={typedChars}
        />
        {selectedIds.length > 1 && (
          <div className="multi-pane-layout-toggle">
            <button onClick={() => setMultiPaneLayout('auto')}
                    className={multiPaneLayout === 'auto' ? 'active' : ''} title="Auto grid">&#8862;</button>
            <button onClick={() => setMultiPaneLayout('row')}
                    className={multiPaneLayout === 'row' ? 'active' : ''} title="Side by side">|||</button>
            <button onClick={() => setMultiPaneLayout('column')}
                    className={multiPaneLayout === 'column' ? 'active' : ''} title="Stacked">&#8801;</button>
            <span className="multi-pane-count">{selectedIds.length} sessions</span>
          </div>
        )}
        {terminalPanes.length > 0 ? (
          <div className={`terminal-panes ${
            selectedIds.length > 1
              ? (multiPaneLayout === 'auto' ? 'terminal-panes-grid' :
                 multiPaneLayout === 'row' ? 'terminal-panes-row' : 'terminal-panes-column')
              : `terminal-panes-${paneLayout}`
          }`}
          style={selectedIds.length > 1 && multiPaneLayout === 'auto' ? {
            gridTemplateColumns: multiPaneSizes?.cols
              ? multiPaneSizes.cols.map(s => `${s}fr`).join(' ')
              : `repeat(${getGridLayout(terminalPanes.length).cols}, 1fr)`,
            gridTemplateRows: `repeat(${getGridLayout(terminalPanes.length).rows}, 1fr)`,
          } : undefined}
          >
            {selectedIds.length > 1 && multiPaneLayout === 'auto' && (() => {
              const { cols } = getGridLayout(terminalPanes.length);
              if (cols <= 1) return null;
              const colSizes = multiPaneSizes?.cols || Array(cols).fill(1 / cols);
              return (
                <div className="grid-resize-overlay">
                  {Array.from({ length: cols - 1 }, (_, i) => {
                    const leftPct = colSizes.slice(0, i + 1).reduce((a, b) => a + b, 0) / colSizes.reduce((a, b) => a + b, 0) * 100;
                    return (
                      <div
                        key={`grid-col-handle-${i}`}
                        className="grid-col-resize-handle"
                        style={{ left: `${leftPct}%` }}
                        onMouseDown={(e) => {
                          e.preventDefault();
                          let startX = e.clientX;
                          const onMove = (me) => {
                            const delta = me.clientX - startX;
                            startX = me.clientX;
                            handleMultiPaneResize(i, delta, 'grid-col');
                          };
                          const onUp = () => {
                            document.removeEventListener('mousemove', onMove);
                            document.removeEventListener('mouseup', onUp);
                            document.body.style.cursor = '';
                            document.body.style.userSelect = '';
                          };
                          document.addEventListener('mousemove', onMove);
                          document.addEventListener('mouseup', onUp);
                          document.body.style.cursor = 'col-resize';
                          document.body.style.userSelect = 'none';
                        }}
                        onDoubleClick={resetMultiPaneSizes}
                      />
                    );
                  })}
                </div>
              );
            })()}
            {terminalPanes.map((pane, index) => {
              const paneSession = sessions.find(s => s.id === pane.sessionId);
              if (!paneSession) return null;
              const isMultiMode = selectedIds.length > 1;
              const flexValue = paneSizes[index] || (1 / terminalPanes.length);
              const showSingleResizeHandle = !isMultiMode && index > 0;
              const showMultiResizeHandle = isMultiMode && index > 0 && multiPaneLayout !== 'auto';
              const multiFlexValue = Array.isArray(multiPaneSizes) ? multiPaneSizes[index] : (1 / terminalPanes.length);

              return (
                <React.Fragment key={pane.id}>
                  {showSingleResizeHandle && (
                    <ResizeHandle
                      direction={paneLayout === 'row' ? 'vertical' : 'horizontal'}
                      onResize={(delta) => handlePaneResize(index - 1, delta)}
                    />
                  )}
                  {showMultiResizeHandle && (
                    <ResizeHandle
                      direction={multiPaneLayout === 'row' ? 'vertical' : 'horizontal'}
                      onResize={(delta) => handleMultiPaneResize(index - 1, delta, multiPaneLayout)}
                      onDoubleClick={resetMultiPaneSizes}
                    />
                  )}
                  <div
                    className={`terminal-pane ${activePaneId === pane.id ? 'active' : ''}`}
                    style={isMultiMode
                      ? (multiPaneLayout !== 'auto' ? { flex: multiFlexValue } : undefined)
                      : { flex: flexValue }}
                    onMouseDown={() => {
                      setActivePaneId(pane.id);
                      setFocusedPanel('terminal');
                      if (selectedIds.length > 1) {
                        setActiveSelectedId(paneSession.id);
                      }
                    }}
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
                      onUpdateSettings={updateSettings}
                      onFocus={() => {
                        setActivePaneId(pane.id);
                        setFocusedPanel('terminal');
                        if (selectedIds.length <= 1) {
                          selectSession(paneSession.id);
                        } else {
                          setActiveSelectedId(paneSession.id);
                        }
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

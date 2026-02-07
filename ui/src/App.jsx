import { useState, useCallback, useEffect, useRef } from 'react';
import Dashboard from './components/Dashboard';
import TerminalView from './components/TerminalView';
import NewSessionModal from './components/NewSessionModal';
import SessionDetailsModal from './components/SessionDetailsModal';
import ContextSidebar from './components/ContextSidebar';
import SettingsModal from './components/SettingsModal';
import ResizeHandle from './components/ResizeHandle';
import HintBadge from './components/HintBadge';
import KanbanBoard from './components/KanbanBoard';
import { useSessions } from './hooks/useSessions';
import { useContextSidebar } from './hooks/useContextSidebar';
import { useSettings } from './hooks/useSettings';
import { useHintMode } from './hooks/useHintMode';
import { registerHint, unregisterHint } from './utils/hintRegistry';

function App() {
  const [currentView, setCurrentView] = useState('sessions'); // 'sessions' | 'kanban'
  const [showNewSessionModal, setShowNewSessionModal] = useState(false);
  const [showSettingsModal, setShowSettingsModal] = useState(false);
  const [detailsSession, setDetailsSession] = useState(null);
  const {
    sessions,
    selectedId,
    selectSession,
    createSession,
    killSession,
    pauseSession,
    resumeSession,
    updateSession,
    connectionStatus
  } = useSessions();
  const { isVisible: sidebarVisible, toggle: toggleSidebar, hide: hideSidebar } = useContextSidebar();
  const { settings, updateSettings, resetSettings } = useSettings();
  const [sessionsWidth, setSessionsWidth] = useState(280);
  const [contextWidth, setContextWidth] = useState(320);
  const [focusedPanel, setFocusedPanel] = useState(null); // 'terminal' | 'context' | null
  const [groupedSessions, setGroupedSessions] = useState([]);

  // Refs for focus management
  const terminalRef = useRef(null);
  const contextRef = useRef(null);

  // Hint mode configuration from settings
  const hintModeSettings = settings?.keyboard?.hintMode || { enabled: true, triggerKey: '`' };
  const { isActive: hintModeActive, typedChars } = useHintMode({
    enabled: hintModeSettings.enabled,
    triggerKey: hintModeSettings.triggerKey
  });

  const selectedSession = sessions.find(s => s.id === selectedId);

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
        terminalRef.current?.focus();
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
  }, []);

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

    if (currentGroupIndex === -1) return;

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
  useEffect(() => {
    const handleKeyDown = (e) => {
      // Skip if hint mode is active (let hint mode handle keys)
      if (hintModeActive) return;

      const target = e.target;
      const isEditableTarget = target instanceof HTMLElement && (
        target.tagName === 'INPUT' ||
        target.tagName === 'TEXTAREA' ||
        target.tagName === 'SELECT' ||
        target.isContentEditable
      );
      if (isEditableTarget) return;

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
        if (e.key === ']') {
          e.preventDefault();
          navigateSession('next');
        }
        if (e.key === '[') {
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

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [hintModeActive, focusedPanel, navigateSession, navigateGroup]);

  const handleSessionsResize = useCallback((delta) => {
    setSessionsWidth(w => Math.max(200, Math.min(400, w + delta)));
  }, []);

  const handleContextResize = useCallback((delta) => {
    // Calculate 70% of viewport width as max
    const maxWidth = Math.floor(window.innerWidth * 0.7);
    setContextWidth(w => Math.max(250, Math.min(maxWidth, w + delta)));
  }, []);

  const handleCreateSession = async (name, workingDir, cliType) => {
    const success = await createSession(name, workingDir, cliType);
    if (success) {
      setShowNewSessionModal(false);
    }
    return success;
  };

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
          connectionStatus={connectionStatus}
          hintModeActive={hintModeActive}
          typedChars={typedChars}
          hintCodes={settings?.keyboard?.hintMode?.hints || {}}
          onGroupedSessionsChange={setGroupedSessions}
        />
      </aside>
      <ResizeHandle onResize={handleSessionsResize} />
      {currentView === 'kanban' ? (
        <main className="main-content">
          <KanbanBoard
            sessions={sessions}
            settings={settings}
            onUpdateSession={updateSession}
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
        {selectedSession ? (
          <TerminalView
            ref={terminalRef}
            session={selectedSession}
            onKillSession={() => killSession(selectedId)}
            onPauseSession={pauseSession}
            onResumeSession={resumeSession}
            onToggleSidebar={toggleSidebar}
            sidebarVisible={sidebarVisible}
            settings={settings}
            onUpdateSession={updateSession}
            hintModeActive={hintModeActive}
            typedChars={typedChars}
            hintCodes={settings?.keyboard?.hintMode?.hints || {}}
            onFocus={() => setFocusedPanel('terminal')}
          />
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
    </div>
  );
}

export default App;

import { useState, useMemo } from 'react';
import KanbanColumn from './KanbanColumn';
import TaskViewModal from './TaskViewModal';
import { getProjectDisplayName } from '../utils/projectUtils';

function KanbanBoard({ sessions, stages, sessionsByStage, moveSession, advanceSession, rejectSession, settings, onUpdateSession, onSessionSelect, onCreateSession, selectedSessionId, focusedColumnId, onPauseSession, onResumeSession, onKillSession, addToast }) {
  const [draggingSessionId, setDraggingSessionId] = useState(null);
  const [viewingSession, setViewingSession] = useState(null);
  const [selectedProjects, setSelectedProjects] = useState(new Set());

  // Get unique projects from sessions
  const projects = useMemo(() => {
    const projectSet = new Set(sessions.map(s => s.workingDir).filter(Boolean));
    return Array.from(projectSet).sort();
  }, [sessions]);

  // Filter sessions by selected projects
  const filteredSessionsByStage = useMemo(() => {
    if (selectedProjects.size === 0) {
      return sessionsByStage;
    }
    const filtered = {};
    stages.forEach(stage => {
      filtered[stage.id] = (sessionsByStage[stage.id] || []).filter(
        s => selectedProjects.has(s.workingDir)
      );
    });
    return filtered;
  }, [sessionsByStage, selectedProjects, stages]);

  const toggleProject = (project) => {
    setSelectedProjects(prev => {
      const next = new Set(prev);
      if (next.has(project)) next.delete(project);
      else next.add(project);
      return next;
    });
  };

  const handleDragStart = (session) => {
    setDraggingSessionId(session.id);
  };

  const handleDragEnd = () => {
    setDraggingSessionId(null);
  };

  const handleSessionDrop = async (sessionId, targetStageId) => {
    setDraggingSessionId(null);
    const session = sessions.find(s => s.id === sessionId);
    if (session && session.stage !== targetStageId) {
      try {
        await moveSession(sessionId, targetStageId);
      } catch (err) {
        alert(`Failed to move session: ${err.message}`);
      }
    }
  };

  const handleAddSession = (stageId) => {
    if (onCreateSession) {
      onCreateSession(stageId);
    }
  };

  const handleLockPlacement = async (sessionId) => {
    try {
      const res = await fetch(`/api/sessions/${sessionId}/lock-placement`, { method: 'POST' });
      if (res.ok) {
        addToast?.('Locked to column', 'success');
      } else {
        addToast?.('Failed to lock', 'error');
      }
    } catch (err) {
      addToast?.('Failed to lock', 'error');
    }
  };

  const handleResetPlacement = async (sessionId) => {
    try {
      const res = await fetch(`/api/sessions/${sessionId}/reset-placement`, { method: 'POST' });
      if (res.ok) {
        addToast?.('Auto-sync unlocked', 'success');
      } else {
        addToast?.('Failed to unlock placement', 'error');
      }
    } catch (err) {
      console.error('Failed to reset placement:', err);
      addToast?.('Failed to unlock placement', 'error');
    }
  };

  const handleViewSession = (session) => {
    setViewingSession(session);
  };

  const handleCloseViewModal = () => {
    setViewingSession(null);
  };

  const handleAdvanceSession = async (sessionId) => {
    try {
      await advanceSession(sessionId);
      setViewingSession(null);
    } catch (err) {
      alert(`Failed to advance: ${err.message}`);
    }
  };

  const handleRejectSession = async (sessionId, reason, targetStage) => {
    try {
      await rejectSession(sessionId, reason, targetStage);
      setViewingSession(null);
    } catch (err) {
      alert(`Failed to reject: ${err.message}`);
    }
  };

  // Calculate stats
  const stats = useMemo(() => {
    const total = sessions.length;
    const active = sessions.filter(s => ['active', 'thinking', 'editing'].includes(s.status)).length;
    const paused = sessions.filter(s => s.status === 'paused').length;
    const done = sessions.filter(s => s.stage === 'done').length;
    return { total, active, paused, done };
  }, [sessions]);

  if (!stages || stages.length === 0) {
    return (
      <div className="kanban-loading">
        <div className="loading-spinner"></div>
        <span>Loading kanban board...</span>
      </div>
    );
  }

  return (
    <div className="kanban-board">
      <div className="kanban-toolbar">
        <div className="kanban-stats">
          <span className="stat">
            <strong>{stats.total}</strong> sessions
          </span>
          <span className="stat stat-active">
            <strong>{stats.active}</strong> active
          </span>
          {stats.paused > 0 && (
            <span className="stat stat-blocked">
              <strong>{stats.paused}</strong> paused
            </span>
          )}
          <span className="stat stat-done">
            <strong>{stats.done}</strong> done
          </span>
        </div>

        <div className="kanban-filters">
          <div className="project-filter-chips">
            <button
              className={`project-chip project-chip-all ${selectedProjects.size === 0 ? 'selected' : ''}`}
              onClick={() => setSelectedProjects(new Set())}
            >
              All
            </button>
            {projects.map(project => (
              <button
                key={project}
                className={`project-chip ${selectedProjects.has(project) ? 'selected' : ''}`}
                onClick={() => toggleProject(project)}
              >
                {getProjectDisplayName(project, settings?.projectAliases)}
              </button>
            ))}
          </div>
        </div>
      </div>

      <div className="kanban-columns">
        {stages.map(stage => (
          <KanbanColumn
            key={stage.id}
            stage={stage}
            sessions={filteredSessionsByStage[stage.id] || []}
            onSessionClick={handleViewSession}
            onSessionDrop={handleSessionDrop}
            onAddSession={handleAddSession}
            onDragStart={handleDragStart}
            onDragEnd={handleDragEnd}
            draggingSessionId={draggingSessionId}
            onSessionSelect={onSessionSelect}
            selectedSessionId={selectedSessionId}
            onResetPlacement={handleResetPlacement}
            onLockPlacement={handleLockPlacement}
            focusedColumnId={focusedColumnId}
          />
        ))}
      </div>

      {viewingSession && (
        <TaskViewModal
          session={viewingSession}
          stages={stages}
          onClose={handleCloseViewModal}
          onUpdateSession={onUpdateSession}
          onAdvance={handleAdvanceSession}
          onReject={handleRejectSession}
          onSessionSelect={onSessionSelect}
          settings={settings}
          onPauseSession={onPauseSession}
          onResumeSession={onResumeSession}
          onKillSession={onKillSession}
        />
      )}
    </div>
  );
}

export default KanbanBoard;

import { useState, useEffect, useRef } from 'react';
import TaskCard from './TaskCard';
import { getProjectDisplayName } from '../utils/projectUtils';

function KanbanColumn({
  stage,
  sessions = [],
  onSessionClick,
  onSessionDrop,
  onAddSession,
  onDragStart,
  onDragEnd,
  draggingSessionId,
  onSessionSelect,
  selectedSessionId,
  onResetPlacement,
  onLockPlacement,
  focusedColumnId,
  projectAliases
}) {
  const [isDragOver, setIsDragOver] = useState(false);
  const isFocused = stage.id === focusedColumnId;
  const columnRef = useRef(null);

  // Auto-scroll focused column into view
  useEffect(() => {
    if (isFocused && columnRef.current) {
      columnRef.current.scrollIntoView({ inline: 'nearest', behavior: 'smooth' });
    }
  }, [isFocused]);

  const handleDragOver = (e) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    if (!isDragOver) {
      setIsDragOver(true);
    }
  };

  const handleDragLeave = (e) => {
    if (!e.currentTarget.contains(e.relatedTarget)) {
      setIsDragOver(false);
    }
  };

  const handleDrop = (e) => {
    e.preventDefault();
    setIsDragOver(false);
    const sessionId = e.dataTransfer.getData('text/plain');
    if (sessionId) {
      onSessionDrop?.(sessionId, stage.id);
    }
  };

  const getPoolTypeLabel = (poolType) => {
    switch (poolType) {
      case 'specialized': return 'Specialized agents';
      case 'shared': return 'Shared pool';
      case 'human': return 'Human review';
      case 'none': return stage.id === 'done' ? 'Completed' : 'No agents';
      default: return poolType;
    }
  };

  const getPoolTypeIcon = (poolType) => {
    switch (poolType) {
      case 'specialized': return '🤖';
      case 'shared': return '👥';
      case 'human': return '👤';
      case 'none': return stage.id === 'done' ? '✅' : '📋';
      default: return '📋';
    }
  };

  // Count sessions by status
  const active = sessions.filter(s => ['active', 'thinking', 'editing'].includes(s.status)).length;
  const paused = sessions.filter(s => s.status === 'paused').length;

  return (
    <div
      ref={columnRef}
      className={`kanban-column ${isDragOver ? 'drag-over' : ''} ${isFocused ? 'column-focused' : ''}`}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      <div className="kanban-column-header" style={{ borderTopColor: stage.color }}>
        <div className="column-title-row">
          <span className="column-icon">{getPoolTypeIcon(stage.poolType)}</span>
          <h3 className="column-title">{stage.name}</h3>
          <span className="column-count">{sessions.length}</span>
        </div>
        <div className="column-meta">
          <span className="column-pool-type">{getPoolTypeLabel(stage.poolType)}</span>
          {stage.agentPool > 0 && (
            <span className="column-agent-pool">
              {stage.agentPool} agent{stage.agentPool !== 1 ? 's' : ''}
            </span>
          )}
        </div>
        {(active > 0 || paused > 0) && (
          <div className="column-status-summary">
            {active > 0 && <span className="status-in-progress">{active} active</span>}
            {paused > 0 && <span className="status-blocked">{paused} paused</span>}
          </div>
        )}
      </div>

      <div className="kanban-column-body">
        {sessions.length === 0 ? (
          <div className="column-empty">
            {isDragOver ? 'Drop here' : (isFocused ? 'Press Enter or Ctrl+O to watch' : 'No sessions')}
          </div>
        ) : (() => {
          const sorted = [...sessions].sort((a, b) => {
            const statusOrder = { active: 0, thinking: 0, editing: 0, idle: 1, waiting: 1, paused: 2, completed: 3 };
            const statusDiff = (statusOrder[a.status] ?? 3) - (statusOrder[b.status] ?? 3);
            if (statusDiff !== 0) return statusDiff;
            return (b.priority || 0) - (a.priority || 0);
          });

          // Group by project
          const groups = new Map();
          for (const session of sorted) {
            const project = session.workingDir || 'Unassigned';
            if (!groups.has(project)) groups.set(project, []);
            groups.get(project).push(session);
          }

          return Array.from(groups.entries()).map(([project, projectSessions]) => (
            <div key={project} className="kanban-project-group">
              {groups.size > 1 && (
                <div className="kanban-project-subheader">
                  {getProjectDisplayName(project, projectAliases)}
                </div>
              )}
              {projectSessions.map(session => (
                <TaskCard
                  key={session.id}
                  session={session}
                  onClick={onSessionClick}
                  onDragStart={onDragStart}
                  onDragEnd={onDragEnd}
                  isDragging={draggingSessionId === session.id}
                  onSessionSelect={onSessionSelect}
                  selectedSessionId={selectedSessionId}
                  stageId={stage.id}
                  onResetPlacement={onResetPlacement}
                  onLockPlacement={onLockPlacement}
                />
              ))}
            </div>
          ));
        })()}
      </div>

      {stage.id === 'todo' && (
        <div className="kanban-column-footer">
          <button
            className="btn-add-task"
            onClick={() => onAddSession?.(stage.id)}
          >
            + Add Session
          </button>
        </div>
      )}
    </div>
  );
}

export default KanbanColumn;

import { useMemo, useState } from 'react';
import TaskCard from './TaskCard';
import { getProjectDisplayName } from '../utils/projectUtils';

function KanbanSessionColumn({
  stage,
  sessions = [],
  settings,
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
  cardNodeRefs,
  focusedColumnId
}) {
  const [isDragOver, setIsDragOver] = useState(false);

  const groups = useMemo(() => {
    const map = new Map();
    for (const session of sessions) {
      const project = session.workingDir || 'Unassigned';
      if (!map.has(project)) map.set(project, []);
      map.get(project).push(session);
    }
    return map;
  }, [sessions]);

  const handleDragOver = (e) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    if (!isDragOver) setIsDragOver(true);
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

  return (
    <div
      className={`kanban-column ${isDragOver ? 'drag-over' : ''} ${focusedColumnId === stage.id ? 'column-focused' : ''}`}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      <div className="kanban-column-header" style={{ borderTopColor: stage.color }}>
        <div className="column-title-row">
          <h3 className="column-title">{stage.name}</h3>
          <span className="column-count">{sessions.length}</span>
        </div>
      </div>

      <div className="kanban-column-body">
        {sessions.length === 0 ? (
          <div className="column-empty">{isDragOver ? 'Drop here' : 'No sessions'}</div>
        ) : (
          Array.from(groups.entries()).map(([project, projectSessions]) => (
            <div key={project} className="kanban-project-group">
              {groups.size > 1 && (
                <div className="kanban-project-subheader">
                  {getProjectDisplayName(project, settings?.projectAliases)}
                </div>
              )}
              {projectSessions.map((session) => (
                <TaskCard
                  key={session.id}
                  ref={cardNodeRefs ? (node => {
                    if (node) cardNodeRefs.set(session.id, node);
                    else cardNodeRefs.delete(session.id);
                  }) : undefined}
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
          ))
        )}
      </div>

      {stage.id === 'todo' && (
        <div className="kanban-column-footer">
          <button className="btn-add-task" onClick={() => onAddSession?.(stage.id)}>
            + Add Session
          </button>
        </div>
      )}
    </div>
  );
}

export default KanbanSessionColumn;

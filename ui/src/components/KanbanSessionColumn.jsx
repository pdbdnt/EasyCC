import { useState } from 'react';
import TaskCard from './TaskCard';

function KanbanSessionColumn({
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
  cardNodeRefs,
  focusedColumnId
}) {
  const [isDragOver, setIsDragOver] = useState(false);

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
          sessions.map((session) => (
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

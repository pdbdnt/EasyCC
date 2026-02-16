import { useState } from 'react';
import KanbanTaskCard from './KanbanTaskCard';

function KanbanColumn({
  stage,
  tasks = [],
  agentsById,
  onTaskClick,
  onTaskDrop,
  onAddTask,
  onDragStart,
  onDragEnd,
  draggingTaskId,
  bulkMode,
  selectedTaskIds,
  onToggleTaskSelect,
  onToggleSelectAll
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
    const taskId = e.dataTransfer.getData('text/plain');
    if (taskId) {
      onTaskDrop?.(taskId, stage.id);
    }
  };

  const allSelected = bulkMode && tasks.length > 0 && tasks.every(t => selectedTaskIds?.has(t.id));

  return (
    <div
      className={`kanban-column ${isDragOver ? 'drag-over' : ''}`}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      <div className="kanban-column-header" style={{ borderTopColor: stage.color }}>
        <div className="column-title-row">
          {bulkMode && tasks.length > 0 && (
            <input
              type="checkbox"
              className="kanban-bulk-checkbox"
              checked={allSelected}
              onChange={() => onToggleSelectAll?.(stage.id)}
              title="Select all in column"
            />
          )}
          <h3 className="column-title">{stage.name}</h3>
          <span className="column-count">{tasks.length}</span>
        </div>
      </div>

      <div className="kanban-column-body">
        {tasks.length === 0 ? (
          <div className="column-empty">{isDragOver ? 'Drop here' : 'No tasks'}</div>
        ) : (
          tasks.map((task) => (
            <KanbanTaskCard
              key={task.id}
              task={task}
              agentsById={agentsById}
              onClick={onTaskClick}
              onDragStart={onDragStart}
              onDragEnd={onDragEnd}
              isDragging={draggingTaskId === task.id}
              selectable={bulkMode}
              selected={selectedTaskIds?.has(task.id)}
              onToggleSelect={onToggleTaskSelect}
            />
          ))
        )}
      </div>

      {stage.id === 'todo' && (
        <div className="kanban-column-footer">
          <button className="btn-add-task" onClick={() => onAddTask?.(stage.id)}>
            + Add Task
          </button>
        </div>
      )}
    </div>
  );
}

export default KanbanColumn;

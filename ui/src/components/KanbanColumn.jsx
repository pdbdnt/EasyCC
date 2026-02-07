import { useState } from 'react';
import TaskCard from './TaskCard';

function KanbanColumn({
  stage,
  tasks,
  onTaskClick,
  onTaskEdit,
  onTaskDelete,
  onTaskDrop,
  onAddTask,
  onDragStart,
  onDragEnd,
  draggingTaskId
}) {
  const [isDragOver, setIsDragOver] = useState(false);

  const handleDragOver = (e) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    if (!isDragOver) {
      setIsDragOver(true);
    }
  };

  const handleDragLeave = (e) => {
    // Only set false if we're leaving the column entirely
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

  // Count tasks by status
  const inProgress = tasks.filter(t => t.status === 'in_progress').length;
  const blocked = tasks.filter(t => t.status === 'blocked').length;
  const queued = tasks.filter(t => t.status === 'queued').length;

  return (
    <div
      className={`kanban-column ${isDragOver ? 'drag-over' : ''}`}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      <div className="kanban-column-header" style={{ borderTopColor: stage.color }}>
        <div className="column-title-row">
          <span className="column-icon">{getPoolTypeIcon(stage.poolType)}</span>
          <h3 className="column-title">{stage.name}</h3>
          <span className="column-count">{tasks.length}</span>
        </div>
        <div className="column-meta">
          <span className="column-pool-type">{getPoolTypeLabel(stage.poolType)}</span>
          {stage.agentPool > 0 && (
            <span className="column-agent-pool">
              {stage.agentPool} agent{stage.agentPool !== 1 ? 's' : ''}
            </span>
          )}
        </div>
        {(inProgress > 0 || blocked > 0) && (
          <div className="column-status-summary">
            {inProgress > 0 && <span className="status-in-progress">{inProgress} active</span>}
            {blocked > 0 && <span className="status-blocked">{blocked} blocked</span>}
          </div>
        )}
      </div>

      <div className="kanban-column-body">
        {tasks.length === 0 ? (
          <div className="column-empty">
            {isDragOver ? 'Drop here' : 'No tasks'}
          </div>
        ) : (
          tasks
            .sort((a, b) => {
              // Sort by status (in_progress first, then queued, then blocked)
              const statusOrder = { in_progress: 0, queued: 1, blocked: 2 };
              const statusDiff = (statusOrder[a.status] ?? 3) - (statusOrder[b.status] ?? 3);
              if (statusDiff !== 0) return statusDiff;
              // Then by priority (higher first)
              return b.priority - a.priority;
            })
            .map(task => (
              <TaskCard
                key={task.id}
                task={task}
                onClick={onTaskClick}
                onEdit={onTaskEdit}
                onDelete={onTaskDelete}
                onDragStart={onDragStart}
                onDragEnd={onDragEnd}
                isDragging={draggingTaskId === task.id}
              />
            ))
        )}
      </div>

      {stage.id === 'backlog' && (
        <div className="kanban-column-footer">
          <button
            className="btn-add-task"
            onClick={() => onAddTask?.(stage.id)}
          >
            + Add Task
          </button>
        </div>
      )}
    </div>
  );
}

export default KanbanColumn;

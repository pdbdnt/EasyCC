import { useState } from 'react';

function TaskCard({
  task,
  onClick,
  onEdit,
  onDelete,
  onDragStart,
  onDragEnd,
  isDragging = false
}) {
  const [isExpanded, setIsExpanded] = useState(false);

  const getStatusColor = (status) => {
    switch (status) {
      case 'queued': return 'var(--status-idle)';
      case 'in_progress': return 'var(--status-active)';
      case 'blocked': return 'var(--status-error)';
      case 'done': return 'var(--status-completed)';
      default: return 'var(--text-muted)';
    }
  };

  const getPriorityLabel = (priority) => {
    if (priority >= 3) return { label: 'Critical', class: 'priority-critical' };
    if (priority >= 2) return { label: 'High', class: 'priority-high' };
    if (priority >= 1) return { label: 'Medium', class: 'priority-medium' };
    return { label: 'Low', class: 'priority-low' };
  };

  const getStatusIcon = (status) => {
    switch (status) {
      case 'queued': return '○';
      case 'in_progress': return '◐';
      case 'blocked': return '⊘';
      case 'done': return '●';
      default: return '○';
    }
  };

  const handleDragStart = (e) => {
    e.dataTransfer.setData('text/plain', task.id);
    e.dataTransfer.effectAllowed = 'move';
    onDragStart?.(task);
  };

  const handleDragEnd = (e) => {
    onDragEnd?.(task);
  };

  const handleEditClick = (e) => {
    e.stopPropagation();
    onEdit?.(task);
  };

  const handleDeleteClick = (e) => {
    e.stopPropagation();
    if (confirm(`Delete task "${task.title}"?`)) {
      onDelete?.(task.id);
    }
  };

  const priority = getPriorityLabel(task.priority);
  const hasBlockers = task.blockedBy && task.blockedBy.length > 0;
  const hasRejections = task.rejectionHistory && task.rejectionHistory.length > 0;

  const handleClick = (e) => {
    // Single click opens the task view modal
    onClick?.(task);
  };

  const handleDoubleClick = (e) => {
    // Double click expands inline details
    e.stopPropagation();
    setIsExpanded(!isExpanded);
  };

  return (
    <div
      className={`task-card ${isDragging ? 'dragging' : ''} ${task.status === 'blocked' ? 'blocked' : ''}`}
      draggable
      onDragStart={handleDragStart}
      onDragEnd={handleDragEnd}
      onClick={handleClick}
      onDoubleClick={handleDoubleClick}
    >
      <div className="task-card-header">
        <span
          className="task-status-icon"
          style={{ color: getStatusColor(task.status) }}
          title={task.status}
        >
          {getStatusIcon(task.status)}
        </span>
        <span className="task-title">{task.title}</span>
        {task.priority > 0 && (
          <span className={`task-priority ${priority.class}`} title={`Priority: ${priority.label}`}>
            {priority.label[0]}
          </span>
        )}
      </div>

      <div className="task-card-meta">
        <span className="task-project" title={task.project}>
          {task.project.split(/[/\\]/).pop()}
        </span>
        {task.assignedAgent && (
          <span className="task-agent" title={`Assigned to: ${task.assignedAgent}`}>
            🤖
          </span>
        )}
        {hasBlockers && (
          <span className="task-blockers" title={`Blocked by ${task.blockedBy.length} task(s)`}>
            🔗 {task.blockedBy.length}
          </span>
        )}
        {hasRejections && (
          <span className="task-rejections" title={`Rejected ${task.rejectionHistory.length} time(s)`}>
            ↩ {task.rejectionHistory.length}
          </span>
        )}
      </div>

      {isExpanded && (
        <div className="task-card-expanded">
          {task.description && (
            <div className="task-description">
              {task.description}
            </div>
          )}

          {task.tags && task.tags.length > 0 && (
            <div className="task-tags">
              {task.tags.map(tag => (
                <span key={tag} className="task-tag">{tag}</span>
              ))}
            </div>
          )}

          {hasRejections && (
            <div className="task-rejection-history">
              <strong>Last rejection:</strong> {task.rejectionHistory[task.rejectionHistory.length - 1].reason}
            </div>
          )}

          {task.context?.blockReason && (
            <div className="task-block-reason">
              <strong>Blocked:</strong> {task.context.blockReason}
            </div>
          )}

          <div className="task-card-actions">
            <button
              className="btn-small"
              onClick={handleEditClick}
              title="Edit task"
            >
              Edit
            </button>
            <button
              className="btn-small btn-danger"
              onClick={handleDeleteClick}
              title="Delete task"
            >
              Delete
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

export default TaskCard;

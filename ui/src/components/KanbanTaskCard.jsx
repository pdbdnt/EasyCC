function KanbanTaskCard({ task, agentsById, onClick, onDragStart, onDragEnd, isDragging = false, selectable, selected, onToggleSelect }) {
  const assignedAgentNames = (task.assignedAgents || [])
    .map((id) => agentsById.get(id)?.name || id)
    .filter(Boolean);
  const activeRuns = (task.runHistory || []).filter((run) => !run.endedAt);

  const getRelativeTime = (dateString) => {
    if (!dateString) return '';
    const date = new Date(dateString);
    const now = new Date();
    const diff = Math.floor((now - date) / 1000);
    if (diff < 60) return `${diff}s ago`;
    if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
    if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
    return `${Math.floor(diff / 86400)}d ago`;
  };

  const handleDragStart = (e) => {
    e.dataTransfer.setData('text/plain', task.id);
    e.dataTransfer.effectAllowed = 'move';
    onDragStart?.(task);
  };

  const handleClick = () => {
    if (selectable) {
      onToggleSelect?.(task.id);
    } else {
      onClick?.(task);
    }
  };

  return (
    <div
      className={`kanban-task-card ${isDragging ? 'dragging' : ''} ${selected ? 'selected' : ''}`}
      draggable={!selectable}
      onDragStart={selectable ? undefined : handleDragStart}
      onDragEnd={selectable ? undefined : () => onDragEnd?.(task)}
      onClick={handleClick}
    >
      <div className="kanban-task-card-header">
        {selectable && (
          <input
            type="checkbox"
            className="kanban-bulk-checkbox"
            checked={!!selected}
            onChange={() => onToggleSelect?.(task.id)}
            onClick={e => e.stopPropagation()}
          />
        )}
        <strong>{task.title}</strong>
        {task.priority > 0 && (
          <span className="kanban-task-priority">P{task.priority}</span>
        )}
      </div>

      {task.description && (
        <div className="kanban-task-description" title={task.description}>
          {task.description.length > 120 ? `${task.description.slice(0, 120)}...` : task.description}
        </div>
      )}

      <div className="kanban-task-meta">
        <span>Agents: {assignedAgentNames.length ? assignedAgentNames.slice(0, 3).join(', ') : 'none'}</span>
      </div>
      <div className="kanban-task-meta">
        <span>Runs: {activeRuns.length > 0 ? `${activeRuns.length} active` : 'no active run'}</span>
      </div>
      <div className="kanban-task-meta">
        <span>Comments: {(task.comments || []).length}</span>
        <span>Updated {getRelativeTime(task.updatedAt || task.createdAt)}</span>
      </div>
    </div>
  );
}

export default KanbanTaskCard;

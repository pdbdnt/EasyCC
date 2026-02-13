import { useRef, useEffect } from 'react';

function getDisplayTask(session) {
  if (session.currentTask && session.currentTask.length > 5) {
    return session.currentTask;
  }
  const lastPrompt = session.promptHistory?.[session.promptHistory.length - 1];
  if (lastPrompt?.text) {
    return lastPrompt.text.split('\n')[0].substring(0, 100);
  }
  if (session.claudeSessionName) {
    return session.claudeSessionName;
  }
  return session.description || '';
}

function TaskCard({
  session,
  onClick,
  onDragStart,
  onDragEnd,
  isDragging = false,
  onSessionSelect,
  selectedSessionId,
  stageId,
  onResetPlacement,
  onLockPlacement
}) {
  const isSelected = session.id === selectedSessionId;
  const cardRef = useRef(null);

  useEffect(() => {
    if (isSelected && cardRef.current) {
      cardRef.current.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    }
  }, [isSelected]);

  const getStatusColor = (status) => {
    switch (status) {
      case 'active': return 'var(--status-active)';
      case 'idle': return 'var(--status-idle)';
      case 'thinking': return 'var(--status-thinking, #3b82f6)';
      case 'editing': return 'var(--status-editing, #8b5cf6)';
      case 'waiting': return 'var(--status-waiting, #f59e0b)';
      case 'paused': return 'var(--status-paused, #6b7280)';
      case 'completed': return 'var(--status-completed, #22c55e)';
      default: return 'var(--text-muted)';
    }
  };

  const getStatusEmoji = (status) => {
    switch (status) {
      case 'active': return '🟢';
      case 'idle': return '🟡';
      case 'thinking': return '🔵';
      case 'editing': return '✏️';
      case 'waiting': return '⏳';
      case 'paused': return '⏸️';
      case 'completed': return '⚪';
      default: return '⚫';
    }
  };

  const getRelativeTime = (dateString) => {
    if (!dateString) return '';
    const date = new Date(dateString);
    const now = new Date();
    const diff = Math.floor((now - date) / 1000);
    if (diff < 5) return 'just now';
    if (diff < 60) return `${diff}s ago`;
    if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
    if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
    return `${Math.floor(diff / 86400)}d ago`;
  };

  const handleDragStart = (e) => {
    e.dataTransfer.setData('text/plain', session.id);
    e.dataTransfer.effectAllowed = 'move';
    onDragStart?.(session);
  };

  const handleDragEnd = () => {
    onDragEnd?.(session);
  };

  const handleClick = () => {
    if (onSessionSelect) {
      onSessionSelect(session.id, stageId);
    }
  };

  const handleDetailsClick = (e) => {
    e.stopPropagation();
    onClick?.(session);
  };

  const isPaused = session.status === 'paused';
  const statusColor = getStatusColor(session.status);

  return (
    <div
      ref={cardRef}
      className={`task-card task-card-linked ${isDragging ? 'dragging' : ''} ${isPaused ? 'task-card-paused' : ''} ${isSelected ? 'task-card-selected' : ''}`}
      style={{ borderLeftColor: statusColor }}
      draggable
      onDragStart={handleDragStart}
      onDragEnd={handleDragEnd}
      onClick={handleClick}
    >
      <div className="task-card-header">
        <span className={`status-indicator ${session.status}`} />
        <span className="task-title">{session.name}</span>
        {(!session.cliType || session.cliType === 'claude' || session.cliType === 'claude-code') && (
          <span className="cli-type-badge claude-code">CC</span>
        )}
        {session.cliType === 'codex' && (
          <span className="cli-type-badge codex">CDX</span>
        )}
        {session.cliType === 'terminal' && (
          <span className="cli-type-badge terminal">TRM</span>
        )}
        <button
          className="btn-icon task-card-details-btn"
          onClick={handleDetailsClick}
          title="Session details"
        >
          ⚙️
        </button>
      </div>

      <div className="task-card-meta">
        <span className="task-card-status">
          {getStatusEmoji(session.status)} {session.status}
        </span>
        <button
          className={`btn-icon task-lock-btn ${session.manuallyPlaced ? 'locked' : ''}`}
          title={session.manuallyPlaced ? 'Locked to column — click to unlock' : 'Lock to this column'}
          onClick={(e) => {
            e.stopPropagation();
            if (session.manuallyPlaced) {
              onResetPlacement?.(session.id);
            } else {
              onLockPlacement?.(session.id);
            }
          }}
        >
          {session.manuallyPlaced ? '🔒' : '🔓'}
        </button>
        {session.priority > 0 && (
          <span className={`task-priority ${session.priority >= 3 ? 'priority-critical' : session.priority >= 2 ? 'priority-high' : 'priority-medium'}`}>
            {session.priority >= 3 ? 'C' : session.priority >= 2 ? 'H' : 'M'}
          </span>
        )}
      </div>

      {(() => {
        const displayTask = getDisplayTask(session);
        return displayTask && !isPaused ? (
          <div className="task-card-current-task" title={displayTask}>
            {displayTask}
          </div>
        ) : null;
      })()}

      {session.description && (
        <div className="task-card-notes" title={session.description}>
          {session.description.length > 60 ? session.description.substring(0, 60) + '...' : session.description}
        </div>
      )}

      {session.tags && session.tags.length > 0 && (
        <div className="session-tags">
          {session.tags.slice(0, 3).map(tag => (
            <span key={tag} className="session-tag">{tag}</span>
          ))}
          {session.tags.length > 3 && (
            <span className="session-tag-more">+{session.tags.length - 3}</span>
          )}
        </div>
      )}

      <div className="task-card-footer">
        <span className="task-card-time">
          {isPaused ? 'Paused' : getRelativeTime(session.lastActivity)}
        </span>
      </div>

      {isPaused && (
        <div className="paused-overlay">
          <span className="paused-badge">PAUSED</span>
        </div>
      )}
    </div>
  );
}

export default TaskCard;

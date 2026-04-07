import { useState, useEffect, useRef } from 'react';
import HintBadge from './HintBadge';

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

function SessionCard({
  session,
  index,
  isSelected,
  isMultiSelected = false,
  onSelect,
  onToggleSelect,
  onShowDetails,
  onUpdate,
  onMoveSession,
  onResetPlacement,
  hintModeActive = false,
  typedChars = '',
  hintCode = '',
  isRecentlyEntered = false,
  stages = [],
  groupInfo = null,
  isGroupFocused = false,
  childCount = 0,
  isChildSession = false,
  onViewOrchestratorGroup
}) {
  const [isEditing, setIsEditing] = useState(false);
  const [editName, setEditName] = useState(session.name);
  const [showStageMenu, setShowStageMenu] = useState(false);
  const stageMenuRef = useRef(null);

  // Close stage menu on click outside
  useEffect(() => {
    if (!showStageMenu) return;
    const handleClickOutside = (e) => {
      if (stageMenuRef.current && !stageMenuRef.current.contains(e.target)) {
        setShowStageMenu(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [showStageMenu]);

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
    const date = new Date(dateString);
    const now = new Date();
    const diff = Math.floor((now - date) / 1000);

    if (diff < 5) return 'just now';
    if (diff < 60) return `${diff}s ago`;
    if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
    if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
    return `${Math.floor(diff / 86400)}d ago`;
  };

  const handleDetailsClick = (e) => {
    e.stopPropagation();
    onShowDetails?.(session);
  };

  const handleNameDoubleClick = (e) => {
    e.stopPropagation();
    setIsEditing(true);
    setEditName(session.name);
  };

  const handleNameBlur = () => {
    if (editName.trim() && editName !== session.name) {
      onUpdate?.(session.id, { name: editName.trim() });
    }
    setIsEditing(false);
  };

  const handleNameKeyDown = (e) => {
    if (e.key === 'Enter') {
      e.target.blur();
    } else if (e.key === 'Escape') {
      setEditName(session.name);
      setIsEditing(false);
    }
  };

  const isPaused = session.status === 'paused';
  const currentStage = stages.find(s => s.id === session.stage);
  const canViewGroup = session.isOrchestrator && childCount > 0 && typeof onViewOrchestratorGroup === 'function';

  const handleClick = (e) => {
    // Pass event to onSelect so parent can detect Ctrl/Cmd for group logic
    onSelect(e);
  };

  return (
    <div
      className={`session-card ${isSelected ? 'selected' : ''} ${isMultiSelected ? 'multi-selected' : ''} ${isGroupFocused ? 'group-focused' : ''} ${isPaused ? 'paused' : ''} ${isRecentlyEntered ? 'recently-entered' : ''}${session.isOrchestrator ? ' session-card--orchestrator' : ''}${isChildSession ? ' session-card--child' : ''}`}
      onClick={handleClick}
    >
      {hintCode && (
        <HintBadge
          code={hintCode}
          visible={hintModeActive}
          position="top-left"
          action={onSelect}
          typedChars={typedChars}
        />
      )}
      <div className="session-card-header">
        <span className="session-name" onDoubleClick={handleNameDoubleClick}>
          <span className={`status-indicator ${session.status}`} />
          {isEditing ? (
            <input
              type="text"
              className="session-name-input"
              value={editName}
              onChange={e => setEditName(e.target.value)}
              onBlur={handleNameBlur}
              onKeyDown={handleNameKeyDown}
              onClick={e => e.stopPropagation()}
              autoFocus
            />
          ) : (
            <>
              {session.isOrchestrator && <span className="orchestrator-icon" title="Orchestrator">&#9733;</span>}
              {session.name}
              {childCount > 0 && <span className="child-count-badge">({childCount})</span>}
              {session.queuedMessages > 0 && <span className="queue-count-badge" title={`${session.queuedMessages} queued message${session.queuedMessages > 1 ? 's' : ''}`}>Q:{session.queuedMessages}</span>}
              {(!session.cliType || session.cliType === 'claude-code') && (
                <span className="cli-type-badge claude-code">CC</span>
              )}
              {session.cliType === 'codex' && (
                <span className="cli-type-badge codex">CDX</span>
              )}
              {session.cliType === 'terminal' && (
                <span className="cli-type-badge terminal">TRM</span>
              )}
              {session.cliType === 'wsl' && (
                <span className="cli-type-badge wsl">WSL</span>
              )}
              {groupInfo && (
                <span className="group-badge" title={`Group: ${groupInfo.name}`}>
                  {groupInfo.name.length > 8 ? groupInfo.name.substring(0, 8) + '..' : groupInfo.name}
                </span>
              )}
              {session.teamInstanceId && (
                <span className="group-badge" title={`Team: ${session.teamInstanceId}`}>
                  TM
                </span>
              )}
              {session.agentId && (
                <span className="group-badge" title={`Agent: ${session.agentId}`}>
                  AG:{session.agentId.slice(0, 6)}
                </span>
              )}
            </>
          )}
        </span>
        <span className={`session-status ${session.status}`}>
          {getStatusEmoji(session.status)} {session.status}
        </span>
      </div>

      {(() => {
        const displayTask = getDisplayTask(session);
        return displayTask && !isPaused ? (
          <div className="session-task" title={displayTask}>
            {displayTask}
          </div>
        ) : null;
      })()}

      {session.notes && (
        <div className="session-notes-preview" title={session.notes}>
          {session.notes.length > 60 ? session.notes.substring(0, 60) + '...' : session.notes}
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

      <div className="session-footer">
        {session.manuallyPlaced && (
          <button
            className="session-lock-icon clickable"
            title="Locked to column — click to unlock"
            onClick={(e) => {
              e.stopPropagation();
              onResetPlacement?.(session.id);
            }}
          >🔒</button>
        )}
        {currentStage && (
          <div className="stage-badge-wrapper" ref={stageMenuRef}>
            <span
              className={`stage-badge ${onMoveSession ? 'clickable' : ''}`}
              style={{
                backgroundColor: currentStage.color + '22',
                color: currentStage.color,
                borderColor: currentStage.color + '55'
              }}
              onClick={(e) => {
                if (!onMoveSession) return;
                e.stopPropagation();
                setShowStageMenu(!showStageMenu);
              }}
            >
              {currentStage.name}
            </span>
            {showStageMenu && (
              <div className="stage-picker-dropdown">
                {stages.map((stage) => (
                  <div
                    key={stage.id}
                    className={`stage-picker-item ${stage.id === session.stage ? 'current' : ''}`}
                    onClick={(e) => {
                      e.stopPropagation();
                      if (stage.id !== session.stage) {
                        onMoveSession(session.id, stage.id);
                      }
                      setShowStageMenu(false);
                    }}
                  >
                    <span
                      className="stage-picker-dot"
                      style={{ backgroundColor: stage.color }}
                    />
                    <span>{stage.name}</span>
                    {stage.id === session.stage && <span style={{ marginLeft: 'auto' }}>{'\u2713'}</span>}
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
        <div className="session-time">
          {isPaused ? 'Paused' : `Last activity: ${getRelativeTime(session.lastActivity)}`}
        </div>
        {canViewGroup && (
          <button
            className="btn-icon"
            onClick={(e) => {
              e.stopPropagation();
              onViewOrchestratorGroup(session.id);
            }}
            title="View group"
          >
            ▦
          </button>
        )}
        <button
          className="btn-icon"
          onClick={handleDetailsClick}
          title="Session details"
        >
          ⚙️
        </button>
      </div>

      {isPaused && (
        <div className="paused-overlay">
          <span className="paused-badge">PAUSED</span>
        </div>
      )}
    </div>
  );
}

export default SessionCard;

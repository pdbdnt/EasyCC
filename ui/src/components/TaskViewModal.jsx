import { useState, useRef, useEffect } from 'react';
import TerminalView from './TerminalView';
import ContextSidebar from './ContextSidebar';
import ResizeHandle from './ResizeHandle';

/**
 * Modal for viewing a session's details with terminal and context.
 * Sessions ARE the kanban cards now.
 */
function TaskViewModal({
  session,
  stages,
  onClose,
  onUpdateSession,
  onAdvance,
  onReject,
  onSessionSelect,
  settings,
  onPauseSession,
  onResumeSession,
  onKillSession
}) {
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [showRejectModal, setShowRejectModal] = useState(false);
  const [rejectReason, setRejectReason] = useState('');
  const [rejectTargetStage, setRejectTargetStage] = useState('');
  const [contextWidth, setContextWidth] = useState(300);
  const [showContext, setShowContext] = useState(true);
  const modalRef = useRef(null);

  // Get current stage info
  const currentStage = stages?.find(s => s.id === session.stage);
  const previousStages = stages?.filter(s => s.order < (currentStage?.order || 0)) || [];

  useEffect(() => {
    const handleKeyDown = (e) => {
      if (e.key === 'Escape') {
        if (showRejectModal) {
          setShowRejectModal(false);
        } else {
          onClose();
        }
      }
      if (e.ctrlKey && e.altKey) {
        if (e.key === 'ArrowRight') {
          e.preventDefault();
          setContextWidth(w => Math.min(w + 40, window.innerWidth * 0.5));
        } else if (e.key === 'ArrowLeft') {
          e.preventDefault();
          setContextWidth(w => Math.max(w - 40, 200));
        }
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [showRejectModal, onClose]);

  const handleBackdropClick = (e) => {
    if (e.target === e.currentTarget) {
      onClose();
    }
  };

  const handleRejectSubmit = () => {
    if (!rejectReason.trim()) {
      alert('Please provide a rejection reason');
      return;
    }
    onReject?.(session.id, rejectReason.trim(), rejectTargetStage || undefined);
    setShowRejectModal(false);
    setRejectReason('');
    setRejectTargetStage('');
  };

  const getStatusBadge = (status) => {
    const badges = {
      active: { label: 'Active', class: 'status-active' },
      idle: { label: 'Idle', class: 'status-idle' },
      thinking: { label: 'Thinking', class: 'status-active' },
      editing: { label: 'Editing', class: 'status-active' },
      waiting: { label: 'Waiting', class: 'status-idle' },
      paused: { label: 'Paused', class: 'status-blocked' },
      completed: { label: 'Completed', class: 'status-done' }
    };
    return badges[status] || { label: status, class: '' };
  };

  const statusBadge = getStatusBadge(session.status);

  return (
    <div
      className={`modal-backdrop task-view-backdrop ${isFullscreen ? 'fullscreen' : ''}`}
      onClick={handleBackdropClick}
    >
      <div
        className={`task-view-modal ${isFullscreen ? 'fullscreen' : ''}`}
        ref={modalRef}
      >
        {/* Header */}
        <div className="task-view-header">
          <div className="task-view-title">
            <h2>{session.name}</h2>
            <span className={`task-view-status ${statusBadge.class}`}>
              {statusBadge.label}
            </span>
            <span className="task-view-stage">
              {currentStage?.name || session.stage}
            </span>
            {session.workingDir && (
              <span className="task-view-project">
                {session.workingDir.split(/[/\\]/).pop()}
              </span>
            )}
          </div>
          <div className="task-view-actions">
            {session.stage !== 'done' && currentStage?.poolType !== 'human' && (
              <button
                className="btn-small btn-success"
                onClick={() => onAdvance?.(session.id)}
                title="Move to next stage"
              >
                Advance
              </button>
            )}
            {currentStage?.poolType === 'human' && session.stage !== 'done' && (
              <button
                className="btn-small btn-success"
                onClick={() => onAdvance?.(session.id)}
                title="Approve and move to Done"
              >
                Approve
              </button>
            )}
            {session.stage !== 'todo' && session.stage !== 'done' && (
              <button
                className="btn-small btn-warning"
                onClick={() => setShowRejectModal(true)}
                title="Reject and send back"
              >
                Reject
              </button>
            )}
            {onSessionSelect && (
              <button
                className="btn-small"
                onClick={() => { onSessionSelect(session.id); onClose(); }}
                title="Open in terminal view"
              >
                Open Terminal
              </button>
            )}
            <button
              className="btn-icon"
              onClick={() => setIsFullscreen(!isFullscreen)}
              title={isFullscreen ? 'Exit fullscreen' : 'Fullscreen'}
            >
              {isFullscreen ? '⛶' : '⛶'}
            </button>
            <button className="modal-close" onClick={onClose}>×</button>
          </div>
        </div>

        {/* Content: Context + Terminal */}
        <div className="task-view-content">
          {showContext && (
            <>
              <div className="task-view-context" style={{ width: contextWidth }}>
                <ContextSidebar
                  session={session}
                  onClose={() => setShowContext(false)}
                  onUpdateSession={onUpdateSession}
                />
              </div>
              <ResizeHandle onResize={(delta) => {
                setContextWidth(w => Math.min(Math.max(w + delta, 200), window.innerWidth * 0.5));
              }} />
            </>
          )}

          <div className="task-view-terminal">
            <TerminalView
              session={session}
              onKillSession={() => { onKillSession?.(session.id); onClose(); }}
              onPauseSession={onPauseSession}
              onResumeSession={onResumeSession}
              onToggleSidebar={() => setShowContext(v => !v)}
              sidebarVisible={showContext}
              settings={settings}
              onUpdateSession={onUpdateSession}
            />
          </div>
        </div>

        {/* Reject Modal */}
        {showRejectModal && (
          <div className="reject-modal-overlay" onClick={() => setShowRejectModal(false)}>
            <div className="reject-modal" onClick={e => e.stopPropagation()}>
              <h3>Reject Session</h3>
              <div className="form-group">
                <label>Reason for rejection *</label>
                <textarea
                  value={rejectReason}
                  onChange={(e) => setRejectReason(e.target.value)}
                  placeholder="Explain why this session is being rejected..."
                  rows={4}
                  autoFocus
                />
              </div>
              <div className="form-group">
                <label>Send back to stage</label>
                <select
                  value={rejectTargetStage}
                  onChange={(e) => setRejectTargetStage(e.target.value)}
                >
                  <option value="">Previous stage (default)</option>
                  {previousStages.map(s => (
                    <option key={s.id} value={s.id}>{s.name}</option>
                  ))}
                </select>
              </div>
              <div className="modal-footer">
                <button
                  className="btn-secondary"
                  onClick={() => setShowRejectModal(false)}
                >
                  Cancel
                </button>
                <button
                  className="btn-warning"
                  onClick={handleRejectSubmit}
                >
                  Reject
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

export default TaskViewModal;

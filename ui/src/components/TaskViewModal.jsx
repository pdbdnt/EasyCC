import { useState, useRef, useEffect } from 'react';
import TerminalView from './TerminalView';
import ContextSidebar from './ContextSidebar';

/**
 * Modal for viewing a task with its assigned agent's terminal and context.
 * Reuses TerminalView and ContextSidebar components.
 */
function TaskViewModal({
  task,
  session, // The session assigned to this task (if any)
  stages,
  onClose,
  onUpdateTask,
  onUpdateSession,
  onAdvance,
  onReject,
  onAssign,
  onUnassign,
  settings
}) {
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [showRejectModal, setShowRejectModal] = useState(false);
  const [rejectReason, setRejectReason] = useState('');
  const [rejectTargetStage, setRejectTargetStage] = useState('');
  const [contextWidth, setContextWidth] = useState(300);
  const modalRef = useRef(null);

  // Get current stage info
  const currentStage = stages?.find(s => s.id === task.stage);
  const previousStages = stages?.filter(s => s.order < (currentStage?.order || 0)) || [];

  // Handle escape key to close
  useEffect(() => {
    const handleKeyDown = (e) => {
      if (e.key === 'Escape') {
        if (showRejectModal) {
          setShowRejectModal(false);
        } else {
          onClose();
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
    onReject?.(task.id, rejectReason.trim(), rejectTargetStage || undefined);
    setShowRejectModal(false);
    setRejectReason('');
    setRejectTargetStage('');
  };

  const getStatusBadge = (status) => {
    const badges = {
      queued: { label: 'Queued', class: 'status-queued' },
      in_progress: { label: 'In Progress', class: 'status-active' },
      blocked: { label: 'Blocked', class: 'status-blocked' },
      done: { label: 'Done', class: 'status-done' }
    };
    return badges[status] || { label: status, class: '' };
  };

  const statusBadge = getStatusBadge(task.status);

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
            <h2>{task.title}</h2>
            <span className={`task-view-status ${statusBadge.class}`}>
              {statusBadge.label}
            </span>
            <span className="task-view-stage">
              {currentStage?.name || task.stage}
            </span>
            <span className="task-view-project">
              {task.project.split(/[/\\]/).pop()}
            </span>
          </div>
          <div className="task-view-actions">
            {/* Advance button (if not in done or review) */}
            {task.stage !== 'done' && currentStage?.poolType !== 'human' && (
              <button
                className="btn-small btn-success"
                onClick={() => onAdvance?.(task.id)}
                title="Move to next stage"
              >
                Advance
              </button>
            )}
            {/* Approve button (in review stage) */}
            {currentStage?.poolType === 'human' && task.stage !== 'done' && (
              <button
                className="btn-small btn-success"
                onClick={() => onAdvance?.(task.id)}
                title="Approve and move to Done"
              >
                Approve
              </button>
            )}
            {/* Reject button (if not in backlog) */}
            {task.stage !== 'backlog' && task.stage !== 'done' && (
              <button
                className="btn-small btn-warning"
                onClick={() => setShowRejectModal(true)}
                title="Reject and send back"
              >
                Reject
              </button>
            )}
            {/* Unassign button (if assigned) */}
            {task.assignedSessionId && (
              <button
                className="btn-small"
                onClick={() => onUnassign?.(task.id)}
                title="Unassign agent"
              >
                Unassign
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
          {/* Context Sidebar */}
          <div className="task-view-context" style={{ width: contextWidth }}>
            {session ? (
              <ContextSidebar
                session={session}
                onClose={() => {}}
                onUpdateSession={onUpdateSession}
                hideCloseButton
              />
            ) : (
              <div className="task-context-placeholder">
                <h3>Task Details</h3>
                <div className="task-detail-section">
                  <label>Description</label>
                  <p>{task.description || 'No description'}</p>
                </div>
                {task.blockedBy?.length > 0 && (
                  <div className="task-detail-section">
                    <label>Blocked By</label>
                    <ul className="blocked-by-list">
                      {task.blockedBy.map(id => (
                        <li key={id}>{id}</li>
                      ))}
                    </ul>
                  </div>
                )}
                {task.rejectionHistory?.length > 0 && (
                  <div className="task-detail-section">
                    <label>Rejection History</label>
                    {task.rejectionHistory.map((r, i) => (
                      <div key={i} className="rejection-item">
                        <span className="rejection-flow">{r.from} → {r.to}</span>
                        <span className="rejection-reason">{r.reason}</span>
                      </div>
                    ))}
                  </div>
                )}
                {task.tags?.length > 0 && (
                  <div className="task-detail-section">
                    <label>Tags</label>
                    <div className="task-tags">
                      {task.tags.map(tag => (
                        <span key={tag} className="task-tag">{tag}</span>
                      ))}
                    </div>
                  </div>
                )}
                <div className="task-detail-section">
                  <label>Status</label>
                  <p>No agent assigned. Task is queued.</p>
                </div>
              </div>
            )}
          </div>

          {/* Terminal */}
          <div className="task-view-terminal">
            {session ? (
              <TerminalView
                session={session}
                onKillSession={() => {}}
                onPauseSession={() => {}}
                onResumeSession={() => {}}
                onToggleSidebar={() => {}}
                sidebarVisible={false}
                settings={settings}
                onUpdateSession={onUpdateSession}
                hideHeader
              />
            ) : (
              <div className="terminal-placeholder">
                <div className="terminal-placeholder-icon">🤖</div>
                <p>No agent assigned to this task</p>
                <p className="text-muted">
                  Drag the task to a stage with agents to assign one
                </p>
              </div>
            )}
          </div>
        </div>

        {/* Reject Modal */}
        {showRejectModal && (
          <div className="reject-modal-overlay" onClick={() => setShowRejectModal(false)}>
            <div className="reject-modal" onClick={e => e.stopPropagation()}>
              <h3>Reject Task</h3>
              <div className="form-group">
                <label>Reason for rejection *</label>
                <textarea
                  value={rejectReason}
                  onChange={(e) => setRejectReason(e.target.value)}
                  placeholder="Explain why this task is being rejected..."
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
                  Reject Task
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

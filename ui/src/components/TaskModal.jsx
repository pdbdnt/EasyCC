import { useMemo, useState, useRef, useEffect } from 'react';
import AgentChipSelector from './AgentChipSelector';
import { AGENT_TEMPLATES } from '../utils/agentTemplates';

const REACTION_EMOJIS = ['\uD83D\uDC4D', '\u2705', '\uD83D\uDC40', '\u2764\uFE0F', '\uD83C\uDF89', '\uD83E\uDD14'];

// Filter spawn-eligible templates (exclude primary, terminal, custom)
const SPAWN_TEMPLATES = AGENT_TEMPLATES.filter(t => !['primary', 'terminal', 'custom', 'codex-agent'].includes(t.id));

const PRIORITIES = [
  { value: 0, label: 'P0', cssClass: 'p0' },
  { value: 1, label: 'P1', cssClass: 'p1' },
  { value: 2, label: 'P2', cssClass: 'p2' },
  { value: 3, label: 'P3', cssClass: 'p3' }
];

const DEFAULT_STAGES = [
  { id: 'todo', label: 'To Do' },
  { id: 'in_progress', label: 'In Progress' },
  { id: 'in_review', label: 'In Review' },
  { id: 'done', label: 'Done' }
];

function TaskModal({
  task,
  agents,
  stages,
  onClose,
  onUpdateTask,
  onDeleteTask,
  onAssignTaskAgents,
  onAddTaskComment,
  onStartTaskRun,
  onStopTaskRun,
  addToast
}) {
  const [activeTab, setActiveTab] = useState('details');
  const [draftTitle, setDraftTitle] = useState(task.title || '');
  const [draftDescription, setDraftDescription] = useState(task.description || '');
  const [draftStage, setDraftStage] = useState(task.stage || 'todo');
  const [draftPriority, setDraftPriority] = useState(task.priority || 0);
  const [commentText, setCommentText] = useState('');
  const [saving, setSaving] = useState(false);
  const [deliveryInfo, setDeliveryInfo] = useState(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [showMentionDropdown, setShowMentionDropdown] = useState(false);
  const [mentionFilter, setMentionFilter] = useState('');
  const [replyingTo, setReplyingTo] = useState(null);
  const [showEmojiPicker, setShowEmojiPicker] = useState(null);
  const commentInputRef = useRef(null);
  const mentionDropdownRef = useRef(null);

  const stageOptions = (stages && stages.length > 0) ? stages : DEFAULT_STAGES;

  const agentsById = useMemo(() => {
    const map = new Map();
    for (const agent of agents || []) {
      if (!agent.deletedAt) map.set(agent.id, agent);
    }
    return map;
  }, [agents]);

  const availableAgents = useMemo(() =>
    (agents || []).filter(a => !a.deletedAt),
    [agents]
  );

  const filteredMentionAgents = useMemo(() => {
    if (!mentionFilter) return availableAgents;
    const lower = mentionFilter.toLowerCase();
    return availableAgents.filter(a => a.name.toLowerCase().includes(lower));
  }, [availableAgents, mentionFilter]);

  // Show spawn templates when user types @spawn: or @new:
  const isSpawnQuery = mentionFilter.startsWith('spawn:') || mentionFilter.startsWith('new:');
  const filteredSpawnTemplates = useMemo(() => {
    if (!isSpawnQuery) return [];
    const query = mentionFilter.replace(/^(spawn|new):/, '').toLowerCase();
    return SPAWN_TEMPLATES.filter(t => !query || t.id.includes(query) || t.name.toLowerCase().includes(query));
  }, [mentionFilter, isSpawnQuery]);

  // Close mention dropdown on outside click
  useEffect(() => {
    if (!showMentionDropdown) return;
    const handleClick = (e) => {
      if (mentionDropdownRef.current && !mentionDropdownRef.current.contains(e.target) &&
          commentInputRef.current && !commentInputRef.current.contains(e.target)) {
        setShowMentionDropdown(false);
      }
    };
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [showMentionDropdown]);

  const handleCommentChange = (e) => {
    const val = e.target.value;
    setCommentText(val);

    // Detect @mention: find last @ before cursor
    const cursorPos = e.target.selectionStart;
    const textBeforeCursor = val.slice(0, cursorPos);
    const lastAtIndex = textBeforeCursor.lastIndexOf('@');

    if (lastAtIndex >= 0) {
      const textAfterAt = textBeforeCursor.slice(lastAtIndex + 1);
      // Only show dropdown if no space after @ (still typing the name)
      if (!textAfterAt.includes(' ')) {
        setMentionFilter(textAfterAt);
        setShowMentionDropdown(true);
        return;
      }
    }
    setShowMentionDropdown(false);
  };

  const handleMentionSelect = (agent) => {
    const cursorPos = commentInputRef.current?.selectionStart || commentText.length;
    const textBeforeCursor = commentText.slice(0, cursorPos);
    const lastAtIndex = textBeforeCursor.lastIndexOf('@');

    if (lastAtIndex >= 0) {
      const before = commentText.slice(0, lastAtIndex);
      const after = commentText.slice(cursorPos);
      setCommentText(`${before}@${agent.name}#${agent.id} ${after}`);
    }
    setShowMentionDropdown(false);
    commentInputRef.current?.focus();
  };

  const handleSpawnSelect = (template) => {
    const cursorPos = commentInputRef.current?.selectionStart || commentText.length;
    const textBeforeCursor = commentText.slice(0, cursorPos);
    const lastAtIndex = textBeforeCursor.lastIndexOf('@');

    if (lastAtIndex >= 0) {
      const before = commentText.slice(0, lastAtIndex);
      const after = commentText.slice(cursorPos);
      setCommentText(`${before}@spawn:${template.id} ${after}`);
    }
    setShowMentionDropdown(false);
    commentInputRef.current?.focus();
  };

  const handleSave = async () => {
    try {
      setSaving(true);
      await onUpdateTask?.(task.id, {
        title: draftTitle,
        description: draftDescription,
        stage: draftStage,
        priority: Number(draftPriority) || 0
      });
      addToast?.('Task updated', 'success');
      onClose?.();
    } catch (error) {
      addToast?.(`Failed to save task: ${error.message}`, 'error');
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async () => {
    try {
      setDeleting(true);
      await onDeleteTask?.(task.id);
      addToast?.('Task deleted', 'success');
      onClose?.();
    } catch (error) {
      addToast?.(`Failed to delete task: ${error.message}`, 'error');
      setConfirmDelete(false);
    } finally {
      setDeleting(false);
    }
  };

  const handleAssignAgent = async (agentId) => {
    const newIds = [...(task.assignedAgents || []), agentId];
    try {
      await onAssignTaskAgents?.(task.id, newIds);
    } catch (error) {
      addToast?.(`Failed to assign agent: ${error.message}`, 'error');
    }
  };

  const handleUnassignAgent = async (agentId) => {
    const newIds = (task.assignedAgents || []).filter(id => id !== agentId);
    try {
      await onAssignTaskAgents?.(task.id, newIds);
    } catch (error) {
      addToast?.(`Failed to unassign agent: ${error.message}`, 'error');
    }
  };

  const handleComment = async () => {
    const text = commentText.trim();
    if (!text) return;
    try {
      const result = await onAddTaskComment?.(task.id, { text, author: 'user', parentId: replyingTo?.id || null });
      setCommentText('');
      setReplyingTo(null);
      setShowMentionDropdown(false);
      setDeliveryInfo({
        delivered: result?.delivered || [],
        skipped: result?.skipped || []
      });
      addToast?.('Comment added', 'success');
    } catch (error) {
      addToast?.(`Failed to add comment: ${error.message}`, 'error');
    }
  };

  const handleToggleReaction = async (commentId, emoji) => {
    try {
      await fetch(`/api/tasks/${task.id}/comments/${commentId}/reactions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ emoji, author: 'user' })
      });
      setShowEmojiPicker(null);
    } catch (error) {
      console.error('Error toggling reaction:', error);
    }
  };

  const renderThreadedTaskComments = (comments) => {
    const topLevel = comments.filter(c => !c.parentId);
    const replyMap = {};
    comments.filter(c => c.parentId).forEach(r => {
      if (!replyMap[r.parentId]) replyMap[r.parentId] = [];
      replyMap[r.parentId].push(r);
    });

    const renderOneComment = (comment, isReply = false) => (
      <div key={comment.id} className={`task-modal-comment ${isReply ? 'comment-reply' : ''}`}>
        <div className="task-modal-comment-header">
          <span className={`task-modal-comment-author ${comment.author === 'user' ? 'user' : 'agent'}`}>
            {comment.author}
          </span>
          <span className="task-modal-comment-time">
            {formatTime(comment.createdAt || comment.timestamp)}
          </span>
        </div>
        <div className="task-modal-comment-text">{comment.text}</div>
        <div className="comment-actions-row">
          {(comment.reactions || []).length > 0 && (
            <div className="comment-reactions">
              {groupReactions(comment.reactions).map(({ emoji, count, hasUser }) => (
                <button
                  key={emoji}
                  className={`comment-reaction ${hasUser ? 'active' : ''}`}
                  onClick={() => handleToggleReaction(comment.id, emoji)}
                >
                  {emoji} {count}
                </button>
              ))}
            </div>
          )}
          <div className="comment-action-btns">
            <button className="comment-reply-btn" onClick={() => { setReplyingTo(comment); commentInputRef.current?.focus(); }}>
              Reply
            </button>
            <div className="emoji-picker-wrapper">
              <button
                className="comment-react-btn"
                onClick={() => setShowEmojiPicker(showEmojiPicker === comment.id ? null : comment.id)}
              >
                +
              </button>
              {showEmojiPicker === comment.id && (
                <div className="emoji-picker">
                  {REACTION_EMOJIS.map(emoji => (
                    <button key={emoji} className="emoji-picker-btn" onClick={() => handleToggleReaction(comment.id, emoji)}>
                      {emoji}
                    </button>
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>
        {replyMap[comment.id]?.map(reply => renderOneComment(reply, true))}
      </div>
    );

    return topLevel.slice(-30).map(c => renderOneComment(c));
  };

  const activeRuns = (task.runHistory || []).filter(run => !run.endedAt);
  const completedRuns = (task.runHistory || []).filter(run => run.endedAt);

  const formatTime = (dateStr) => {
    if (!dateStr) return '';
    const d = new Date(dateStr);
    return d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  };

  const tabs = [
    { id: 'details', label: 'Details' },
    { id: 'runs', label: `Runs${activeRuns.length ? ` (${activeRuns.length})` : ''}` }
  ];

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-content task-modal" onClick={e => e.stopPropagation()}>
        <div className="modal-header">
          <h3>{draftTitle || 'Task Details'}</h3>
          <button className="btn-icon" onClick={onClose}>&times;</button>
        </div>

        <div className="task-modal-tabs">
          {tabs.map(tab => (
            <button
              key={tab.id}
              className={`task-modal-tab ${activeTab === tab.id ? 'active' : ''}`}
              onClick={() => setActiveTab(tab.id)}
            >
              {tab.label}
            </button>
          ))}
        </div>

        <div className="task-modal-body">
          {activeTab === 'details' && (
            <div className="task-modal-details">
              <label className="task-modal-field">
                <span className="task-modal-label">Title</span>
                <input value={draftTitle} onChange={e => setDraftTitle(e.target.value)} />
              </label>

              <div className="task-modal-row">
                <label className="task-modal-field">
                  <span className="task-modal-label">Stage</span>
                  <select value={draftStage} onChange={e => setDraftStage(e.target.value)}>
                    {stageOptions.map(stage => (
                      <option key={stage.id} value={stage.id}>{stage.label}</option>
                    ))}
                  </select>
                </label>

                <div className="task-modal-field">
                  <span className="task-modal-label">Priority</span>
                  <div className="task-modal-priority-selector">
                    {PRIORITIES.map(p => (
                      <button
                        key={p.value}
                        className={`task-modal-priority-badge ${p.cssClass} ${draftPriority === p.value ? 'active' : ''}`}
                        onClick={() => setDraftPriority(p.value)}
                        type="button"
                      >
                        {p.label}
                      </button>
                    ))}
                  </div>
                </div>
              </div>

              <label className="task-modal-field">
                <span className="task-modal-label">Description</span>
                <textarea rows={4} value={draftDescription} onChange={e => setDraftDescription(e.target.value)} />
              </label>

              <div className="task-modal-field">
                <span className="task-modal-label">Assigned Agents</span>
                <AgentChipSelector
                  assignedAgentIds={task.assignedAgents || []}
                  allAgents={agents || []}
                  onAssign={handleAssignAgent}
                  onUnassign={handleUnassignAgent}
                />
              </div>

              {/* Comments section - threaded with reactions */}
              <div className="task-modal-field task-modal-comments-section">
                <span className="task-modal-label">
                  Comments {(task.comments || []).length > 0 && `(${(task.comments || []).length})`}
                </span>
                <div className="task-modal-comments-list">
                  {(task.comments || []).length === 0 ? (
                    <div className="task-modal-empty">No comments yet</div>
                  ) : (
                    renderThreadedTaskComments(task.comments || [])
                  )}
                </div>
                <div className="task-modal-comment-input-wrap">
                  {replyingTo && (
                    <div className="replying-to-banner">
                      Replying to <strong>{replyingTo.author}</strong>
                      <button className="replying-to-cancel" onClick={() => setReplyingTo(null)}>&times;</button>
                    </div>
                  )}
                  <div className="task-modal-comment-input">
                    <input
                      ref={commentInputRef}
                      value={commentText}
                      onChange={handleCommentChange}
                      onKeyDown={e => {
                        if (e.key === 'Escape') {
                          setShowMentionDropdown(false);
                          setReplyingTo(null);
                          return;
                        }
                        if (e.key === 'Enter' && !e.shiftKey && !showMentionDropdown) {
                          e.preventDefault();
                          handleComment();
                        }
                      }}
                      placeholder={replyingTo ? 'Write a reply...' : 'Type @ to mention an agent...'}
                    />
                    <button className="btn btn-small btn-primary" onClick={handleComment}>Send</button>
                  </div>
                  {showMentionDropdown && (filteredMentionAgents.length > 0 || filteredSpawnTemplates.length > 0) && (
                    <div className="task-modal-mention-dropdown" ref={mentionDropdownRef}>
                      {filteredMentionAgents.length > 0 && !isSpawnQuery && (
                        <>
                          <div className="mention-dropdown-section">Agents</div>
                          {filteredMentionAgents.map(agent => (
                            <div
                              key={agent.id}
                              className="task-modal-mention-item"
                              onMouseDown={(e) => {
                                e.preventDefault();
                                handleMentionSelect(agent);
                              }}
                            >
                              <span className="task-modal-mention-name">{agent.name}</span>
                              {agent.role && <span className="task-modal-mention-role">{agent.role.slice(0, 40)}</span>}
                            </div>
                          ))}
                        </>
                      )}
                      {filteredSpawnTemplates.length > 0 && (
                        <>
                          <div className="mention-dropdown-section">Spawn New Agent</div>
                          {filteredSpawnTemplates.map(template => (
                            <div
                              key={template.id}
                              className="task-modal-mention-item spawn-item"
                              onMouseDown={(e) => {
                                e.preventDefault();
                                handleSpawnSelect(template);
                              }}
                            >
                              <span className="task-modal-mention-name">@spawn:{template.id}</span>
                              <span className="task-modal-mention-role">{template.name}</span>
                            </div>
                          ))}
                        </>
                      )}
                      {!isSpawnQuery && filteredMentionAgents.length > 0 && (
                        <>
                          <div className="mention-dropdown-section">Spawn New Agent</div>
                          {SPAWN_TEMPLATES.slice(0, 3).map(template => (
                            <div
                              key={template.id}
                              className="task-modal-mention-item spawn-item"
                              onMouseDown={(e) => {
                                e.preventDefault();
                                handleSpawnSelect(template);
                              }}
                            >
                              <span className="task-modal-mention-name">@spawn:{template.id}</span>
                              <span className="task-modal-mention-role">{template.name}</span>
                            </div>
                          ))}
                        </>
                      )}
                    </div>
                  )}
                </div>
                {deliveryInfo && (
                  <div className="task-modal-delivery-info">
                    Delivered: {deliveryInfo.delivered.length}
                    {deliveryInfo.delivered.some(d => d.queued) && ' (some queued)'}
                    {deliveryInfo.delivered.some(d => d.autoStarted) && ' (auto-started)'}
                    {deliveryInfo.skipped.length > 0 && ` | Skipped: ${deliveryInfo.skipped.length}`}
                  </div>
                )}
              </div>
            </div>
          )}

          {activeTab === 'runs' && (
            <div className="task-modal-runs">
              <div className="task-modal-section-header">Active Runs</div>
              {activeRuns.length === 0 ? (
                <div className="task-modal-empty">No active runs</div>
              ) : (
                activeRuns.map(run => (
                  <div key={`${run.sessionId}-${run.agentId}`} className="task-run-row">
                    <span className="task-run-agent">
                      <span className="task-run-dot active" />
                      {agentsById.get(run.agentId)?.name || run.agentId}
                    </span>
                    <span className="task-run-status">{run.status}</span>
                    <button className="btn btn-small btn-danger" onClick={() => onStopTaskRun?.(task.id, run.agentId)}>Stop</button>
                  </div>
                ))
              )}

              <div className="task-modal-section-header" style={{ marginTop: 16 }}>Start Run</div>
              <div className="task-run-start-buttons">
                {(task.assignedAgents || []).map(agentId => (
                  <button
                    key={agentId}
                    className="btn btn-small"
                    onClick={() => onStartTaskRun?.(task.id, agentId)}
                    disabled={activeRuns.some(run => run.agentId === agentId)}
                  >
                    {agentsById.get(agentId)?.name || agentId}
                  </button>
                ))}
                {(task.assignedAgents || []).length === 0 && (
                  <div className="task-modal-empty">Assign agents first to start runs</div>
                )}
              </div>

              {completedRuns.length > 0 && (
                <>
                  <div className="task-modal-section-header" style={{ marginTop: 16 }}>Run History</div>
                  {completedRuns.slice(-10).reverse().map((run, i) => (
                    <div key={i} className="task-run-row history">
                      <span className="task-run-agent">{agentsById.get(run.agentId)?.name || run.agentId}</span>
                      <span className="task-run-times">
                        {formatTime(run.startedAt)} - {formatTime(run.endedAt)}
                      </span>
                      <span className={`task-run-status ${run.status}`}>{run.status}</span>
                    </div>
                  ))}
                </>
              )}
            </div>
          )}
        </div>

        <div className="task-modal-footer">
          <div className="task-modal-footer-left">
            {!confirmDelete ? (
              <button className="btn btn-danger-outline" onClick={() => setConfirmDelete(true)}>Delete</button>
            ) : (
              <div className="task-modal-delete-confirm">
                <span>Delete this task?</span>
                <button className="btn btn-small btn-danger" onClick={handleDelete} disabled={deleting}>
                  {deleting ? 'Deleting...' : 'Confirm'}
                </button>
                <button className="btn btn-small" onClick={() => setConfirmDelete(false)}>Cancel</button>
              </div>
            )}
          </div>
          <div className="task-modal-footer-right">
            <button className="btn" onClick={onClose}>Cancel</button>
            <button className="btn btn-primary" onClick={handleSave} disabled={saving}>
              {saving ? 'Saving...' : 'Save'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function groupReactions(reactions) {
  const map = {};
  (reactions || []).forEach(r => {
    if (!map[r.emoji]) map[r.emoji] = { emoji: r.emoji, count: 0, hasUser: false };
    map[r.emoji].count++;
    if (r.author === 'user') map[r.emoji].hasUser = true;
  });
  return Object.values(map);
}

export default TaskModal;

import { useState, useEffect } from 'react';
import PlanViewer from './PlanViewer';

const REACTION_EMOJIS = ['\uD83D\uDC4D', '\u2705', '\uD83D\uDC40', '\u2764\uFE0F', '\uD83C\uDF89', '\uD83E\uDD14'];

function SessionDetailsModal({ session, onClose, onUpdate, onPause, onResume, onKill }) {
  const [activeTab, setActiveTab] = useState('details');
  const [name, setName] = useState(session?.name || '');
  const [notes, setNotes] = useState(session?.notes || '');
  const [tagInput, setTagInput] = useState('');
  const [tags, setTags] = useState(session?.tags || []);
  const [teamInstanceId, setTeamInstanceId] = useState(session?.teamInstanceId || '');
  const [teamName, setTeamName] = useState('');
  const [activeTeams, setActiveTeams] = useState([]);
  const [plans, setPlans] = useState([]);
  const [loadingPlans, setLoadingPlans] = useState(false);
  const [saving, setSaving] = useState(false);
  const [commentText, setCommentText] = useState('');
  const [replyingTo, setReplyingTo] = useState(null);
  const [showEmojiPicker, setShowEmojiPicker] = useState(null);

  // Update form when session changes
  useEffect(() => {
    if (session) {
      setName(session.name || '');
      setNotes(session.notes || '');
      setTags(session.tags || []);
      setTeamInstanceId(session.teamInstanceId || '');
    }
  }, [session]);

  useEffect(() => {
    let cancelled = false;
    const loadActiveTeams = async () => {
      try {
        const res = await fetch('/api/team-instances');
        const data = await res.json();
        if (!cancelled) {
          setActiveTeams(data.teamInstances || []);
        }
      } catch (error) {
        if (!cancelled) {
          setActiveTeams([]);
        }
      }
    };
    loadActiveTeams();
    return () => { cancelled = true; };
  }, []);

  // Close on ESC key
  useEffect(() => {
    const handleKeyDown = (e) => {
      if (e.key === 'Escape') {
        onClose();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [onClose]);

  // Load plans when Plans tab is active
  useEffect(() => {
    if (activeTab === 'plans' && session?.id) {
      loadPlans();
    }
  }, [activeTab, session?.id]);

  const loadPlans = async () => {
    setLoadingPlans(true);
    try {
      const response = await fetch(`/api/sessions/${session.id}/plans`);
      if (response.ok) {
        const data = await response.json();
        setPlans(data.plans || []);
      }
    } catch (error) {
      console.error('Error loading plans:', error);
    }
    setLoadingPlans(false);
  };

  const handleSave = async () => {
    setSaving(true);
    try {
      const updates = { name, notes, tags };
      if (teamInstanceId === '__new__') {
        updates.teamAction = 'new';
        if (teamName.trim()) updates.teamName = teamName.trim();
      } else {
        updates.teamInstanceId = teamInstanceId || null;
      }
      await onUpdate(session.id, updates);
    } catch (error) {
      console.error('Error saving session:', error);
    }
    setSaving(false);
  };

  const handleAddTag = (e) => {
    e.preventDefault();
    const tag = tagInput.trim().toLowerCase();
    if (tag && !tags.includes(tag)) {
      setTags([...tags, tag]);
      setTagInput('');
    }
  };

  const handleRemoveTag = (tagToRemove) => {
    setTags(tags.filter(t => t !== tagToRemove));
  };

  const handleKeyDown = (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      handleAddTag(e);
    }
  };

  const handleAddComment = async () => {
    if (!commentText.trim()) return;
    try {
      await fetch(`/api/sessions/${session.id}/comments`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          text: commentText.trim(),
          author: 'user',
          parentId: replyingTo?.id || null
        })
      });
      setCommentText('');
      setReplyingTo(null);
    } catch (error) {
      console.error('Error adding comment:', error);
    }
  };

  const handleToggleReaction = async (commentId, emoji) => {
    try {
      await fetch(`/api/sessions/${session.id}/comments/${commentId}/reactions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ emoji, author: 'user' })
      });
      setShowEmojiPicker(null);
    } catch (error) {
      console.error('Error toggling reaction:', error);
    }
  };

  const renderThreadedComments = (comments, entityId, entityType) => {
    const topLevel = comments.filter(c => !c.parentId);
    const replies = comments.filter(c => c.parentId);
    const replyMap = {};
    replies.forEach(r => {
      if (!replyMap[r.parentId]) replyMap[r.parentId] = [];
      replyMap[r.parentId].push(r);
    });

    const renderComment = (comment, isReply = false) => (
      <div key={comment.id} className={`comment-item ${isReply ? 'comment-reply' : ''}`}>
        <div className="comment-header">
          <span className={`comment-author ${comment.author === 'user' ? 'author-user' : 'author-agent'}`}>
            {comment.author}
          </span>
          <span className="comment-time">
            {formatCommentTime(comment.createdAt || comment.timestamp)}
          </span>
        </div>
        <div className="comment-text">{comment.text}</div>
        <div className="comment-actions-row">
          {(comment.reactions || []).length > 0 && (
            <div className="comment-reactions">
              {groupReactions(comment.reactions).map(({ emoji, count, hasUser }) => (
                <button
                  key={emoji}
                  className={`comment-reaction ${hasUser ? 'active' : ''}`}
                  onClick={() => handleToggleReaction(comment.id, emoji)}
                  title={`${count} reaction${count > 1 ? 's' : ''}`}
                >
                  {emoji} {count}
                </button>
              ))}
            </div>
          )}
          <div className="comment-action-btns">
            <button
              className="comment-reply-btn"
              onClick={() => setReplyingTo(comment)}
            >
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
                    <button
                      key={emoji}
                      className="emoji-picker-btn"
                      onClick={() => handleToggleReaction(comment.id, emoji)}
                    >
                      {emoji}
                    </button>
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>
        {replyMap[comment.id]?.map(reply => renderComment(reply, true))}
      </div>
    );

    return topLevel.map(c => renderComment(c));
  };

  if (!session) return null;

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal modal-large" onClick={e => e.stopPropagation()}>
        <div className="modal-header">
          <h2>Session Details</h2>
          <button className="modal-close" onClick={onClose}>&times;</button>
        </div>

        <div className="modal-tabs">
          <button
            className={`tab-btn ${activeTab === 'details' ? 'active' : ''}`}
            onClick={() => setActiveTab('details')}
          >
            Details
          </button>
          <button
            className={`tab-btn ${activeTab === 'comments' ? 'active' : ''}`}
            onClick={() => setActiveTab('comments')}
          >
            Comments ({(session.comments || []).length})
          </button>
          <button
            className={`tab-btn ${activeTab === 'plans' ? 'active' : ''}`}
            onClick={() => setActiveTab('plans')}
          >
            Plans ({plans.length || session.plans?.length || 0})
          </button>
        </div>

        <div className="modal-content">
          {activeTab === 'details' && (
            <div className="details-tab">
              <div className="session-info">
                <div className="info-row">
                  <span className="info-label">Status:</span>
                  <span className={`session-status ${session.status}`}>
                    {getStatusEmoji(session.status)} {session.status}
                  </span>
                </div>
                <div className="info-row">
                  <span className="info-label">Working Directory:</span>
                  <span className="info-value mono">{session.workingDir}</span>
                </div>
                <div className="info-row">
                  <span className="info-label">Created:</span>
                  <span className="info-value">{formatDate(session.createdAt)}</span>
                </div>
                <div className="info-row">
                  <span className="info-label">Last Activity:</span>
                  <span className="info-value">{formatDate(session.lastActivity)}</span>
                </div>
                <div className="info-row">
                  <span className="info-label">Claude Session ID:</span>
                  <span className="info-value mono">{session.claudeSessionId || '(not synced yet)'}</span>
                </div>
                {session.claudeSessionName && (
                  <div className="info-row">
                    <span className="info-label">Claude Session Name:</span>
                    <span className="info-value">{session.claudeSessionName}</span>
                  </div>
                )}
                {session.previousClaudeSessionIds?.length > 0 && (
                  <div className="info-row">
                    <span className="info-label">Previous Sessions:</span>
                    <div className="previous-sessions-list">
                      {session.previousClaudeSessionIds.map((prevId) => (
                        <span key={prevId} className="info-value mono previous-session-id">
                          {prevId}
                        </span>
                      ))}
                    </div>
                  </div>
                )}
              </div>

              <div className="form-group">
                <label>Session Name</label>
                <input
                  type="text"
                  value={name}
                  onChange={e => setName(e.target.value)}
                  placeholder="Enter session name"
                />
              </div>

              <div className="form-group">
                <label>Notes</label>
                <textarea
                  value={notes}
                  onChange={e => setNotes(e.target.value)}
                  placeholder="Add notes about this session..."
                  rows={4}
                />
              </div>

              <div className="form-group">
                <label>Tags</label>
                <div className="tags-container">
                  {tags.map(tag => (
                    <span key={tag} className="tag">
                      {tag}
                      <button className="tag-remove" onClick={() => handleRemoveTag(tag)}>&times;</button>
                    </span>
                  ))}
                </div>
                <div className="tag-input-row">
                  <input
                    type="text"
                    value={tagInput}
                    onChange={e => setTagInput(e.target.value)}
                    onKeyDown={handleKeyDown}
                    placeholder="Add tag..."
                  />
                  <button className="btn btn-secondary btn-small" onClick={handleAddTag}>Add</button>
                </div>
              </div>

              <div className="form-group">
                <label htmlFor="teamInstance">Team</label>
                <select
                  id="teamInstance"
                  value={teamInstanceId}
                  onChange={(e) => { setTeamInstanceId(e.target.value); if (e.target.value !== '__new__') setTeamName(''); }}
                  className="cli-select"
                >
                  <option value="">None</option>
                  {!session.teamInstanceId && <option value="__new__">+ Create New Team (become orchestrator)</option>}
                  {activeTeams.map((team) => (
                    <option key={team.id} value={team.id}>
                      {team.name} ({team.sessionIds?.length || 0} members)
                    </option>
                  ))}
                </select>
                {teamInstanceId === '__new__' && (
                  <input
                    type="text"
                    value={teamName}
                    onChange={(e) => setTeamName(e.target.value)}
                    placeholder={`${name || session.name || 'Session'}'s Team`}
                    style={{ marginTop: '6px' }}
                  />
                )}
              </div>

              <div className="session-actions">
                {session.status === 'paused' ? (
                  <button className="btn btn-primary" onClick={() => onResume(session.id)}>
                    Resume Session
                  </button>
                ) : session.status !== 'completed' ? (
                  <button className="btn btn-secondary" onClick={() => onPause(session.id)}>
                    Pause Session
                  </button>
                ) : null}
                <button className="btn btn-danger" onClick={() => onKill(session.id)}>
                  Delete Session
                </button>
              </div>
            </div>
          )}

          {activeTab === 'comments' && (
            <div className="comments-tab">
              <div className="comment-input-area">
                {replyingTo && (
                  <div className="replying-to-banner">
                    Replying to <strong>{replyingTo.author}</strong>
                    <button className="replying-to-cancel" onClick={() => setReplyingTo(null)}>&times;</button>
                  </div>
                )}
                <div className="comment-input-row">
                  <textarea
                    className="comment-textarea"
                    value={commentText}
                    onChange={e => setCommentText(e.target.value)}
                    placeholder={replyingTo ? 'Write a reply...' : 'Add a comment...'}
                    rows={2}
                    onKeyDown={e => {
                      if (e.key === 'Enter' && !e.shiftKey) {
                        e.preventDefault();
                        handleAddComment();
                      }
                    }}
                  />
                  <button
                    className="btn btn-primary btn-small"
                    onClick={handleAddComment}
                    disabled={!commentText.trim()}
                  >
                    Send
                  </button>
                </div>
              </div>

              <div className="comments-list">
                {(session.comments || []).length === 0 ? (
                  <div className="empty-state">
                    <p className="text-muted">No comments yet.</p>
                  </div>
                ) : (
                  renderThreadedComments(session.comments || [], session.id, 'session')
                )}
              </div>
            </div>
          )}

          {activeTab === 'plans' && (
            <div className="plans-tab">
              {loadingPlans ? (
                <div className="loading-state">Loading plans...</div>
              ) : plans.length === 0 ? (
                <div className="empty-state">
                  <div className="empty-state-icon">📋</div>
                  <p>No plans associated with this session yet.</p>
                  <p className="text-muted">Plans will appear here when Claude enters plan mode.</p>
                </div>
              ) : (
                <div className="plans-list">
                  {plans.map((plan, index) => (
                    <PlanViewer key={plan.filename || index} plan={plan} />
                  ))}
                </div>
              )}
            </div>
          )}
        </div>

        <div className="modal-actions">
          <button className="btn btn-secondary" onClick={onClose}>Cancel</button>
          <button
            className="btn btn-primary"
            onClick={handleSave}
            disabled={saving}
          >
            {saving ? 'Saving...' : 'Save Changes'}
          </button>
        </div>
      </div>
    </div>
  );
}

function getStatusEmoji(status) {
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
}

function formatDate(dateString) {
  if (!dateString) return 'Unknown';
  const date = new Date(dateString);
  return date.toLocaleString();
}

function formatCommentTime(dateString) {
  if (!dateString) return '';
  const d = new Date(dateString);
  const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  return `${months[d.getMonth()]} ${d.getDate()}, ${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}`;
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

export default SessionDetailsModal;

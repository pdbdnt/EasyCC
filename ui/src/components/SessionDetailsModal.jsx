import { useState, useEffect } from 'react';
import PlanViewer from './PlanViewer';

function SessionDetailsModal({ session, onClose, onUpdate, onPause, onResume, onKill }) {
  const [activeTab, setActiveTab] = useState('details');
  const [name, setName] = useState(session?.name || '');
  const [notes, setNotes] = useState(session?.notes || '');
  const [tagInput, setTagInput] = useState('');
  const [tags, setTags] = useState(session?.tags || []);
  const [plans, setPlans] = useState([]);
  const [loadingPlans, setLoadingPlans] = useState(false);
  const [saving, setSaving] = useState(false);

  // Update form when session changes
  useEffect(() => {
    if (session) {
      setName(session.name || '');
      setNotes(session.notes || '');
      setTags(session.tags || []);
    }
  }, [session]);

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
      await onUpdate(session.id, { name, notes, tags });
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

export default SessionDetailsModal;

import { useMemo, useState, useEffect, useCallback } from 'react';
import NewAgentModal from './NewAgentModal';

const PRIORITIES = [
  { value: 0, label: 'P0', cssClass: 'p0' },
  { value: 1, label: 'P1', cssClass: 'p1' },
  { value: 2, label: 'P2', cssClass: 'p2' },
  { value: 3, label: 'P3', cssClass: 'p3' }
];

const STAGE_OPTIONS = [
  { id: 'todo', label: 'To Do' },
  { id: 'in_progress', label: 'In Progress' },
  { id: 'in_review', label: 'In Review' },
  { id: 'done', label: 'Done' }
];

function getInitials(name) {
  if (!name) return '?';
  const parts = name.trim().split(/[\s-]+/);
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[1][0]).toUpperCase();
}

function formatDate(dateStr) {
  if (!dateStr) return '-';
  const d = new Date(dateStr);
  return d.toLocaleString(undefined, { month: 'short', day: 'numeric', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}

function AgentSidebar({
  agents,
  sessions,
  onCreateAgent,
  onUpdateAgent,
  onDeleteAgent,
  onStartAgent,
  onStopAgent,
  onRestartAgent,
  onRewarmAgent,
  addToast
}) {
  const [selectedAgentId, setSelectedAgentId] = useState(null);
  const [showNewAgentModal, setShowNewAgentModal] = useState(false);

  const visibleAgents = useMemo(() =>
    (agents || []).filter(a => !a.deletedAt), [agents]);

  const selectedAgent = visibleAgents.find(a => a.id === selectedAgentId) || null;

  // Auto-close modal if selected agent is deleted
  useEffect(() => {
    if (selectedAgentId && !selectedAgent) {
      setSelectedAgentId(null);
    }
  }, [selectedAgentId, selectedAgent]);

  return (
    <div className="agent-sidebar">
      <div className="agent-sidebar-header">
        <h3>Agents <span className="agent-count-badge">{visibleAgents.length}</span></h3>
        <button className="btn btn-small btn-primary" onClick={() => setShowNewAgentModal(true)}>
          + New
        </button>
      </div>

      <div className="agent-sidebar-list">
        {visibleAgents.map(agent => {
          const isOnline = !!agent.activeSessionId;
          return (
            <div
              key={agent.id}
              className={`agent-card ${isOnline ? 'online' : ''} ${selectedAgentId === agent.id ? 'selected' : ''}`}
              onClick={() => setSelectedAgentId(selectedAgentId === agent.id ? null : agent.id)}
            >
              <div className={`agent-card-accent ${isOnline ? 'online' : 'offline'}`} />
              <div className="agent-card-body">
                <div className="agent-card-header">
                  <div className="agent-card-title">
                    <div className={`agent-avatar ${isOnline ? 'online' : ''}`}>
                      {getInitials(agent.name)}
                    </div>
                    <div className="agent-card-name-group">
                      <strong>{agent.name}</strong>
                      <span className="agent-card-meta">
                        {agent.cliType} {agent.workingDir ? `\u00B7 ${agent.workingDir.split(/[\\/]/).pop()}` : ''}
                      </span>
                    </div>
                  </div>
                  <div className="agent-card-header-actions">
                    <span className={`agent-status-pill ${isOnline ? 'online' : 'offline'}`}>
                      {isOnline ? 'online' : 'offline'}
                    </span>
                  </div>
                </div>

                {agent.role && (
                  <div className="agent-card-role-preview">
                    {agent.role.length > 80 ? `${agent.role.slice(0, 80)}...` : agent.role}
                  </div>
                )}
              </div>
            </div>
          );
        })}
        {visibleAgents.length === 0 && (
          <div className="agent-empty-state">
            <div className="agent-empty-icon">+</div>
            <div>No agents yet</div>
            <div className="agent-empty-hint">Create one to get started</div>
          </div>
        )}
      </div>

      {selectedAgent && (
        <AgentDetailModal
          agent={selectedAgent}
          sessions={sessions}
          onClose={() => setSelectedAgentId(null)}
          onUpdate={onUpdateAgent}
          onDelete={onDeleteAgent}
          onStart={onStartAgent}
          onStop={onStopAgent}
          onRestart={onRestartAgent}
          onRewarm={onRewarmAgent}
          addToast={addToast}
        />
      )}

      {showNewAgentModal && (
        <NewAgentModal
          onClose={() => setShowNewAgentModal(false)}
          onCreate={onCreateAgent}
        />
      )}
    </div>
  );
}

function AgentDetailModal({
  agent,
  sessions,
  onClose,
  onUpdate,
  onDelete,
  onStart,
  onStop,
  onRestart,
  onRewarm,
  addToast
}) {
  const [expandedSections, setExpandedSections] = useState({});
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [draftNotes, setDraftNotes] = useState(null);

  const session = agent.activeSessionId
    ? (sessions || []).find(s => s.id === agent.activeSessionId)
    : null;
  const isOnline = !!agent.activeSessionId;

  const toggleSection = (section) => {
    setExpandedSections(prev => ({ ...prev, [section]: !prev[section] }));
  };

  const isSectionOpen = (section) => !!expandedSections[section];

  const handleDelete = async () => {
    try {
      setDeleting(true);
      await onDelete?.(agent.id);
      addToast?.('Agent deleted', 'success');
      onClose();
    } catch (error) {
      addToast?.(`Failed to delete agent: ${error.message}`, 'error');
    } finally {
      setDeleting(false);
    }
  };

  const handleKeyDown = useCallback((e) => {
    if (e.key === 'Escape') onClose();
  }, [onClose]);

  return (
    <div className="modal-overlay" onClick={onClose} onKeyDown={handleKeyDown}>
      <div className="modal agent-detail-modal" onClick={e => e.stopPropagation()}>
        <div className="agent-detail-header">
          <div className="agent-detail-title-row">
            <div className={`agent-avatar large ${isOnline ? 'online' : ''}`}>
              {getInitials(agent.name)}
            </div>
            <div>
              <h3>{agent.name}</h3>
              <span className="agent-detail-subtitle">{agent.cliType} agent</span>
            </div>
          </div>
          <button className="modal-close-btn" onClick={onClose}>&times;</button>
        </div>

        <div className="agent-detail-actions">
          <button className="btn btn-small" onClick={() => onStart?.(agent.id)} disabled={isOnline}>Start</button>
          <button className="btn btn-small" onClick={() => onStop?.(agent.id)} disabled={!isOnline}>Stop</button>
          <button className="btn btn-small" onClick={() => onRestart?.(agent.id)}>Restart</button>
          <button className="btn btn-small" onClick={() => onRewarm?.(agent.id)}>Re-warm</button>
          {confirmDelete ? (
            <div className="agent-delete-confirm">
              <button className="btn btn-small btn-danger" onClick={handleDelete} disabled={deleting}>
                {deleting ? '...' : 'Confirm'}
              </button>
              <button className="btn btn-small" onClick={() => setConfirmDelete(false)}>Cancel</button>
            </div>
          ) : (
            <button className="btn btn-small btn-danger-outline" onClick={() => setConfirmDelete(true)}>Delete</button>
          )}
        </div>

        <div className="agent-detail-modal-body">
          {agent.workingDir && (
            <div className="agent-detail-workdir" title={agent.workingDir}>
              {agent.workingDir}
            </div>
          )}

          {(agent.tags || []).length > 0 && (
            <div className="agent-detail-tags">
              {(agent.tags || []).map((tag, i) => (
                <span key={i} className="agent-skill-chip">
                  {tag}
                  <button
                    className="agent-chip-remove"
                    onClick={() => {
                      const updated = (agent.tags || []).filter((_, idx) => idx !== i);
                      onUpdate?.(agent.id, { tags: updated });
                    }}
                  >&times;</button>
                </span>
              ))}
              <input
                className="agent-tag-add-input"
                placeholder="+ tag"
                onKeyDown={e => {
                  if (e.key === 'Enter' && e.target.value.trim()) {
                    e.preventDefault();
                    onUpdate?.(agent.id, { tags: [...(agent.tags || []), e.target.value.trim()] });
                    e.target.value = '';
                  }
                }}
              />
            </div>
          )}

          {session?.startupSequence && (
            <div className="agent-startup-status">
              Startup: {session.startupSequence.active ? 'running' : 'ready'}
              {' '}({session.startupSequence.remaining} remaining)
            </div>
          )}

          {/* Collapsible: Role */}
          <div className="agent-card-section">
            <div className="agent-card-section-header" onClick={() => toggleSection('role')}>
              <span>Role</span>
              <span className="agent-section-toggle">{isSectionOpen('role') ? '\u25B4' : '\u25BE'}</span>
            </div>
            {isSectionOpen('role') && (
              <div className="agent-card-section-body">
                <textarea
                  value={agent.role || ''}
                  rows={3}
                  onChange={e => onUpdate?.(agent.id, { role: e.target.value })}
                  placeholder="System prompt / role description"
                />
              </div>
            )}
          </div>

          {/* Collapsible: Notes */}
          <div className="agent-card-section">
            <div className="agent-card-section-header" onClick={() => toggleSection('notes')}>
              <span>Notes</span>
              <span className="agent-section-toggle">{isSectionOpen('notes') ? '\u25B4' : '\u25BE'}</span>
            </div>
            {isSectionOpen('notes') && (
              <div className="agent-card-section-body">
                <textarea
                  value={draftNotes !== null ? draftNotes : (agent.notes || '')}
                  rows={3}
                  onChange={e => setDraftNotes(e.target.value)}
                  onBlur={() => {
                    if (draftNotes !== null && draftNotes !== (agent.notes || '')) {
                      onUpdate?.(agent.id, { notes: draftNotes });
                    }
                    setDraftNotes(null);
                  }}
                  placeholder="Notes about this agent..."
                />
              </div>
            )}
          </div>

          {/* Collapsible: Skills */}
          <div className="agent-card-section">
            <div className="agent-card-section-header" onClick={() => toggleSection('skills')}>
              <span>Skills ({(agent.skills || []).length})</span>
              <span className="agent-section-toggle">{isSectionOpen('skills') ? '\u25B4' : '\u25BE'}</span>
            </div>
            {isSectionOpen('skills') && (
              <div className="agent-card-section-body">
                <div className="agent-skills-chips">
                  {(agent.skills || []).map((skill, i) => (
                    <span key={i} className="agent-skill-chip">
                      {skill}
                      <button
                        className="agent-chip-remove"
                        onClick={() => {
                          const updated = (agent.skills || []).filter((_, idx) => idx !== i);
                          onUpdate?.(agent.id, { skills: updated });
                        }}
                      >&times;</button>
                    </span>
                  ))}
                </div>
                <input
                  placeholder="Add skill (Enter)"
                  onKeyDown={e => {
                    if (e.key === 'Enter' && e.target.value.trim()) {
                      e.preventDefault();
                      onUpdate?.(agent.id, { skills: [...(agent.skills || []), e.target.value.trim()] });
                      e.target.value = '';
                    }
                  }}
                />
              </div>
            )}
          </div>

          {/* Collapsible: Startup Prompt */}
          <div className="agent-card-section">
            <div className="agent-card-section-header" onClick={() => toggleSection('startup')}>
              <span>Startup Prompt</span>
              <span className="agent-section-toggle">{isSectionOpen('startup') ? '\u25B4' : '\u25BE'}</span>
            </div>
            {isSectionOpen('startup') && (
              <div className="agent-card-section-body">
                <textarea
                  value={agent.startupPrompt || ''}
                  rows={2}
                  onChange={e => onUpdate?.(agent.id, { startupPrompt: e.target.value })}
                  placeholder="Initial prompt on start"
                />
              </div>
            )}
          </div>

          {/* Collapsible: Info */}
          <div className="agent-card-section">
            <div className="agent-card-section-header" onClick={() => toggleSection('info')}>
              <span>Info</span>
              <span className="agent-section-toggle">{isSectionOpen('info') ? '\u25B4' : '\u25BE'}</span>
            </div>
            {isSectionOpen('info') && (
              <div className="agent-card-section-body">
                <div className="agent-detail-info-grid">
                  <div className="agent-detail-info-row">
                    <span className="agent-detail-info-label">Stage</span>
                    <select
                      value={agent.stage || 'todo'}
                      onChange={e => onUpdate?.(agent.id, { stage: e.target.value })}
                      className="agent-detail-info-select"
                    >
                      {STAGE_OPTIONS.map(s => (
                        <option key={s.id} value={s.id}>{s.label}</option>
                      ))}
                    </select>
                  </div>
                  <div className="agent-detail-info-row">
                    <span className="agent-detail-info-label">Priority</span>
                    <div className="agent-detail-priority-selector">
                      {PRIORITIES.map(p => (
                        <button
                          key={p.value}
                          className={`task-modal-priority-badge ${p.cssClass} ${(agent.priority || 0) === p.value ? 'active' : ''}`}
                          onClick={() => onUpdate?.(agent.id, { priority: p.value })}
                          type="button"
                        >
                          {p.label}
                        </button>
                      ))}
                    </div>
                  </div>
                  <div className="agent-detail-info-row">
                    <span className="agent-detail-info-label">Created</span>
                    <span className="agent-detail-info-value">{formatDate(agent.createdAt)}</span>
                  </div>
                  <div className="agent-detail-info-row">
                    <span className="agent-detail-info-label">Last Active</span>
                    <span className="agent-detail-info-value">{formatDate(agent.lastActiveAt)}</span>
                  </div>
                </div>
              </div>
            )}
          </div>

          {/* Collapsible: Memory */}
          <div className="agent-card-section">
            <div className="agent-card-section-header" onClick={() => toggleSection('memory')}>
              <span>Memory ({(agent.memory || []).length})</span>
              <span className="agent-section-toggle">{isSectionOpen('memory') ? '\u25B4' : '\u25BE'}</span>
            </div>
            {isSectionOpen('memory') && (
              <div className="agent-card-section-body">
                <label className="agent-memory-toggle">
                  <input
                    type="checkbox"
                    checked={agent.memoryEnabled !== false}
                    onChange={e => onUpdate?.(agent.id, { memoryEnabled: e.target.checked })}
                  />
                  <span>Memory enabled</span>
                </label>
                {(agent.memory || []).length > 0 ? (
                  <ul className="agent-memory-list">
                    {(agent.memory || []).slice(-5).map((entry, idx) => (
                      <li key={idx}>{entry}</li>
                    ))}
                  </ul>
                ) : (
                  <div className="agent-memory-empty">No memory entries</div>
                )}
              </div>
            )}
          </div>

          {/* Collapsible: Sessions */}
          <div className="agent-card-section">
            <div className="agent-card-section-header" onClick={() => toggleSection('sessions')}>
              <span>Sessions ({(agent.sessionHistory || []).length})</span>
              <span className="agent-section-toggle">{isSectionOpen('sessions') ? '\u25B4' : '\u25BE'}</span>
            </div>
            {isSectionOpen('sessions') && (
              <div className="agent-card-section-body">
                {agent.activeSessionId && (
                  <div className="agent-detail-active-session">
                    <span className="task-run-dot active" />
                    <span>Active: {agent.activeSessionId.slice(0, 8)}...</span>
                  </div>
                )}
                {(agent.sessionHistory || []).length > 0 ? (
                  <ul className="agent-detail-session-list">
                    {(agent.sessionHistory || []).slice(-5).reverse().map((sessionId, idx) => (
                      <li key={idx} className="agent-detail-session-item">
                        <span className="agent-detail-session-id">{sessionId.slice(0, 8)}...</span>
                        {sessionId === agent.activeSessionId && (
                          <span className="agent-status-pill online" style={{ fontSize: 10, padding: '1px 6px' }}>active</span>
                        )}
                      </li>
                    ))}
                  </ul>
                ) : (
                  <div className="agent-memory-empty">No session history</div>
                )}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

export default AgentSidebar;

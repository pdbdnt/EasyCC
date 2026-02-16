import { useMemo, useState } from 'react';
import NewAgentModal from './NewAgentModal';
import AgentChipSelector from './AgentChipSelector';

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

function AgentBoard({
  agents,
  sessions,
  tasks,
  onCreateAgent,
  onStartAgent,
  onStopAgent,
  onRestartAgent,
  onRewarmAgent,
  onUpdateAgent,
  onDeleteAgent,
  onCreateTask,
  onUpdateTask,
  onDeleteTask,
  onAssignTaskAgents,
  onAddTaskComment,
  addToast
}) {
  const [showNewAgentModal, setShowNewAgentModal] = useState(false);
  const [expandedSections, setExpandedSections] = useState({});
  const [confirmDeleteId, setConfirmDeleteId] = useState(null);
  const [deletingId, setDeletingId] = useState(null);
  const [newTaskTitle, setNewTaskTitle] = useState('');
  const [isCreatingTask, setIsCreatingTask] = useState(false);
  const [confirmDeleteTaskId, setConfirmDeleteTaskId] = useState(null);
  const [taskBulkMode, setTaskBulkMode] = useState(false);
  const [selectedTaskIds, setSelectedTaskIds] = useState(new Set());
  const [confirmBulkDelete, setConfirmBulkDelete] = useState(false);
  const [bulkDeleting, setBulkDeleting] = useState(false);
  const [selectedAgentId, setSelectedAgentId] = useState(null);
  // Draft state for editable fields
  const [draftNotes, setDraftNotes] = useState(null);

  const visibleAgents = useMemo(() => agents.filter(a => !a.deletedAt), [agents]);
  const sessionsById = useMemo(() => {
    const map = new Map();
    for (const session of sessions || []) map.set(session.id, session);
    return map;
  }, [sessions]);
  const activeTasks = useMemo(() => (tasks || []).filter(t => !t.archivedAt), [tasks]);

  // Agent selected for detail view
  const selectedAgent = selectedAgentId ? visibleAgents.find(a => a.id === selectedAgentId) : null;
  const selectedAgentSession = selectedAgent?.activeSessionId ? sessionsById.get(selectedAgent.activeSessionId) : null;

  const toggleSection = (agentId, section) => {
    const key = `${agentId}-${section}`;
    setExpandedSections(prev => ({ ...prev, [key]: !prev[key] }));
  };

  const isSectionOpen = (agentId, section) => {
    return !!expandedSections[`${agentId}-${section}`];
  };

  const handleDeleteAgent = async (id) => {
    try {
      setDeletingId(id);
      await onDeleteAgent?.(id);
      addToast?.('Agent deleted', 'success');
      setConfirmDeleteId(null);
      if (selectedAgentId === id) setSelectedAgentId(null);
    } catch (error) {
      addToast?.(`Failed to delete agent: ${error.message}`, 'error');
    } finally {
      setDeletingId(null);
    }
  };

  const handleCreateTask = async (e) => {
    e.preventDefault();
    if (!newTaskTitle.trim() || isCreatingTask) return;
    try {
      setIsCreatingTask(true);
      await onCreateTask?.({ title: newTaskTitle.trim(), description: '' });
      setNewTaskTitle('');
      addToast?.('Task created', 'success');
    } catch (error) {
      addToast?.(`Failed to create task: ${error.message}`, 'error');
    } finally {
      setIsCreatingTask(false);
    }
  };

  const handleDeleteTask = async (taskId) => {
    try {
      await onDeleteTask?.(taskId);
      addToast?.('Task deleted', 'success');
      setConfirmDeleteTaskId(null);
    } catch (error) {
      addToast?.(`Failed to delete task: ${error.message}`, 'error');
    }
  };

  const handleAssignAgent = async (taskId, agentId) => {
    const task = activeTasks.find(t => t.id === taskId);
    if (!task) return;
    const newIds = [...(task.assignedAgents || []), agentId];
    try {
      await onAssignTaskAgents?.(taskId, newIds);
    } catch (error) {
      addToast?.(`Failed to assign: ${error.message}`, 'error');
    }
  };

  const toggleTaskSelect = (taskId) => {
    setSelectedTaskIds(prev => {
      const next = new Set(prev);
      if (next.has(taskId)) next.delete(taskId);
      else next.add(taskId);
      return next;
    });
  };

  const toggleSelectAllTasks = () => {
    setSelectedTaskIds(prev => {
      const allSelected = activeTasks.every(t => prev.has(t.id));
      if (allSelected) return new Set();
      return new Set(activeTasks.map(t => t.id));
    });
  };

  const handleBulkDeleteTasks = async () => {
    if (selectedTaskIds.size === 0) return;
    setBulkDeleting(true);
    const ids = [...selectedTaskIds];
    const results = await Promise.allSettled(ids.map(id => onDeleteTask?.(id)));
    const failed = results.filter(r => r.status === 'rejected').length;
    const succeeded = results.filter(r => r.status === 'fulfilled').length;
    if (failed > 0) {
      addToast?.(`Deleted ${succeeded}, failed ${failed}`, 'warning');
    } else {
      addToast?.(`Deleted ${succeeded} tasks`, 'success');
    }
    setSelectedTaskIds(new Set());
    setConfirmBulkDelete(false);
    setBulkDeleting(false);
    setTaskBulkMode(false);
  };

  const exitTaskBulkMode = () => {
    setTaskBulkMode(false);
    setSelectedTaskIds(new Set());
    setConfirmBulkDelete(false);
  };

  const handleUnassignAgent = async (taskId, agentId) => {
    const task = activeTasks.find(t => t.id === taskId);
    if (!task) return;
    const newIds = (task.assignedAgents || []).filter(id => id !== agentId);
    try {
      await onAssignTaskAgents?.(taskId, newIds);
    } catch (error) {
      addToast?.(`Failed to unassign: ${error.message}`, 'error');
    }
  };

  const getPriorityClass = (priority) => {
    const classes = { 0: 'p0', 1: 'p1', 2: 'p2', 3: 'p3' };
    return classes[priority] || 'p3';
  };

  return (
    <main className="main-content">
      <div className="agent-board">
        {/* Agents Panel */}
        <section className="agent-pane">
          <div className="agent-pane-header">
            <h3>Agents <span className="agent-count-badge">{visibleAgents.length}</span></h3>
            <button className="btn btn-small btn-primary" onClick={() => setShowNewAgentModal(true)}>
              + New
            </button>
          </div>

          <div className="agent-list">
            {visibleAgents.map(agent => {
              const isOnline = !!agent.activeSessionId;
              const isSelected = selectedAgentId === agent.id;

              return (
                <div
                  key={agent.id}
                  className={`agent-card ${isOnline ? 'online' : ''} ${isSelected ? 'selected' : ''}`}
                  onClick={() => setSelectedAgentId(isSelected ? null : agent.id)}
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
        </section>

        {/* Agent Detail Panel */}
        {selectedAgent ? (
          <section className="agent-detail-pane">
            <div className="agent-detail-header">
              <div className="agent-detail-title-row">
                <div className={`agent-avatar large ${selectedAgent.activeSessionId ? 'online' : ''}`}>
                  {getInitials(selectedAgent.name)}
                </div>
                <div>
                  <h3>{selectedAgent.name}</h3>
                  <span className="agent-detail-subtitle">{selectedAgent.cliType} agent</span>
                </div>
              </div>
              <div className="agent-detail-actions">
                <button className="btn btn-small" onClick={() => onStartAgent?.(selectedAgent.id)} disabled={!!selectedAgent.activeSessionId}>Start</button>
                <button className="btn btn-small" onClick={() => onStopAgent?.(selectedAgent.id)} disabled={!selectedAgent.activeSessionId}>Stop</button>
                <button className="btn btn-small" onClick={() => onRestartAgent?.(selectedAgent.id)}>Restart</button>
                <button className="btn btn-small" onClick={() => onRewarmAgent?.(selectedAgent.id)}>Re-warm</button>
                {confirmDeleteId === selectedAgent.id ? (
                  <div className="agent-delete-confirm">
                    <button className="btn btn-small btn-danger" onClick={() => handleDeleteAgent(selectedAgent.id)} disabled={deletingId === selectedAgent.id}>
                      {deletingId === selectedAgent.id ? '...' : 'Confirm'}
                    </button>
                    <button className="btn btn-small" onClick={() => setConfirmDeleteId(null)}>Cancel</button>
                  </div>
                ) : (
                  <button className="btn btn-small btn-danger-outline" onClick={() => setConfirmDeleteId(selectedAgent.id)}>Delete</button>
                )}
              </div>
            </div>

            {/* Working Directory */}
            {selectedAgent.workingDir && (
              <div className="agent-detail-workdir" title={selectedAgent.workingDir}>
                {selectedAgent.workingDir}
              </div>
            )}

            {/* Tags */}
            {(selectedAgent.tags || []).length > 0 && (
              <div className="agent-detail-tags">
                {(selectedAgent.tags || []).map((tag, i) => (
                  <span key={i} className="agent-skill-chip">
                    {tag}
                    <button
                      className="agent-chip-remove"
                      onClick={() => {
                        const updated = (selectedAgent.tags || []).filter((_, idx) => idx !== i);
                        onUpdateAgent?.(selectedAgent.id, { tags: updated });
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
                      onUpdateAgent?.(selectedAgent.id, { tags: [...(selectedAgent.tags || []), e.target.value.trim()] });
                      e.target.value = '';
                    }
                  }}
                />
              </div>
            )}

            {selectedAgentSession?.startupSequence && (
              <div className="agent-startup-status">
                Startup: {selectedAgentSession.startupSequence.active ? 'running' : 'ready'}
                {' '}({selectedAgentSession.startupSequence.remaining} remaining)
              </div>
            )}

            {/* Collapsible: Role */}
            <div className="agent-card-section">
              <div className="agent-card-section-header" onClick={() => toggleSection(selectedAgent.id, 'role')}>
                <span>Role</span>
                <span className="agent-section-toggle">{isSectionOpen(selectedAgent.id, 'role') ? '\u25B4' : '\u25BE'}</span>
              </div>
              {isSectionOpen(selectedAgent.id, 'role') && (
                <div className="agent-card-section-body">
                  <textarea
                    value={selectedAgent.role || ''}
                    rows={3}
                    onChange={e => onUpdateAgent?.(selectedAgent.id, { role: e.target.value })}
                    placeholder="System prompt / role description"
                  />
                </div>
              )}
            </div>

            {/* Collapsible: Notes */}
            <div className="agent-card-section">
              <div className="agent-card-section-header" onClick={() => toggleSection(selectedAgent.id, 'notes')}>
                <span>Notes</span>
                <span className="agent-section-toggle">{isSectionOpen(selectedAgent.id, 'notes') ? '\u25B4' : '\u25BE'}</span>
              </div>
              {isSectionOpen(selectedAgent.id, 'notes') && (
                <div className="agent-card-section-body">
                  <textarea
                    value={draftNotes !== null ? draftNotes : (selectedAgent.notes || '')}
                    rows={3}
                    onChange={e => setDraftNotes(e.target.value)}
                    onBlur={() => {
                      if (draftNotes !== null && draftNotes !== (selectedAgent.notes || '')) {
                        onUpdateAgent?.(selectedAgent.id, { notes: draftNotes });
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
              <div className="agent-card-section-header" onClick={() => toggleSection(selectedAgent.id, 'skills')}>
                <span>Skills ({(selectedAgent.skills || []).length})</span>
                <span className="agent-section-toggle">{isSectionOpen(selectedAgent.id, 'skills') ? '\u25B4' : '\u25BE'}</span>
              </div>
              {isSectionOpen(selectedAgent.id, 'skills') && (
                <div className="agent-card-section-body">
                  <div className="agent-skills-chips">
                    {(selectedAgent.skills || []).map((skill, i) => (
                      <span key={i} className="agent-skill-chip">
                        {skill}
                        <button
                          className="agent-chip-remove"
                          onClick={() => {
                            const updated = (selectedAgent.skills || []).filter((_, idx) => idx !== i);
                            onUpdateAgent?.(selectedAgent.id, { skills: updated });
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
                        onUpdateAgent?.(selectedAgent.id, { skills: [...(selectedAgent.skills || []), e.target.value.trim()] });
                        e.target.value = '';
                      }
                    }}
                  />
                </div>
              )}
            </div>

            {/* Collapsible: Startup Prompt */}
            <div className="agent-card-section">
              <div className="agent-card-section-header" onClick={() => toggleSection(selectedAgent.id, 'startup')}>
                <span>Startup Prompt</span>
                <span className="agent-section-toggle">{isSectionOpen(selectedAgent.id, 'startup') ? '\u25B4' : '\u25BE'}</span>
              </div>
              {isSectionOpen(selectedAgent.id, 'startup') && (
                <div className="agent-card-section-body">
                  <textarea
                    value={selectedAgent.startupPrompt || ''}
                    rows={2}
                    onChange={e => onUpdateAgent?.(selectedAgent.id, { startupPrompt: e.target.value })}
                    placeholder="Initial prompt on start"
                  />
                </div>
              )}
            </div>

            {/* Collapsible: Info (Stage, Priority, Dates) */}
            <div className="agent-card-section">
              <div className="agent-card-section-header" onClick={() => toggleSection(selectedAgent.id, 'info')}>
                <span>Info</span>
                <span className="agent-section-toggle">{isSectionOpen(selectedAgent.id, 'info') ? '\u25B4' : '\u25BE'}</span>
              </div>
              {isSectionOpen(selectedAgent.id, 'info') && (
                <div className="agent-card-section-body">
                  <div className="agent-detail-info-grid">
                    <div className="agent-detail-info-row">
                      <span className="agent-detail-info-label">Stage</span>
                      <select
                        value={selectedAgent.stage || 'todo'}
                        onChange={e => onUpdateAgent?.(selectedAgent.id, { stage: e.target.value })}
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
                            className={`task-modal-priority-badge ${p.cssClass} ${(selectedAgent.priority || 0) === p.value ? 'active' : ''}`}
                            onClick={() => onUpdateAgent?.(selectedAgent.id, { priority: p.value })}
                            type="button"
                          >
                            {p.label}
                          </button>
                        ))}
                      </div>
                    </div>
                    <div className="agent-detail-info-row">
                      <span className="agent-detail-info-label">Created</span>
                      <span className="agent-detail-info-value">{formatDate(selectedAgent.createdAt)}</span>
                    </div>
                    <div className="agent-detail-info-row">
                      <span className="agent-detail-info-label">Last Active</span>
                      <span className="agent-detail-info-value">{formatDate(selectedAgent.lastActiveAt)}</span>
                    </div>
                  </div>
                </div>
              )}
            </div>

            {/* Collapsible: Memory */}
            <div className="agent-card-section">
              <div className="agent-card-section-header" onClick={() => toggleSection(selectedAgent.id, 'memory')}>
                <span>Memory ({(selectedAgent.memory || []).length})</span>
                <span className="agent-section-toggle">{isSectionOpen(selectedAgent.id, 'memory') ? '\u25B4' : '\u25BE'}</span>
              </div>
              {isSectionOpen(selectedAgent.id, 'memory') && (
                <div className="agent-card-section-body">
                  <label className="agent-memory-toggle">
                    <input
                      type="checkbox"
                      checked={selectedAgent.memoryEnabled !== false}
                      onChange={e => onUpdateAgent?.(selectedAgent.id, { memoryEnabled: e.target.checked })}
                    />
                    <span>Memory enabled</span>
                  </label>
                  {(selectedAgent.memory || []).length > 0 ? (
                    <ul className="agent-memory-list">
                      {(selectedAgent.memory || []).slice(-5).map((entry, idx) => (
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
              <div className="agent-card-section-header" onClick={() => toggleSection(selectedAgent.id, 'sessions')}>
                <span>Sessions ({(selectedAgent.sessionHistory || []).length})</span>
                <span className="agent-section-toggle">{isSectionOpen(selectedAgent.id, 'sessions') ? '\u25B4' : '\u25BE'}</span>
              </div>
              {isSectionOpen(selectedAgent.id, 'sessions') && (
                <div className="agent-card-section-body">
                  {selectedAgent.activeSessionId && (
                    <div className="agent-detail-active-session">
                      <span className="task-run-dot active" />
                      <span>Active: {selectedAgent.activeSessionId.slice(0, 8)}...</span>
                    </div>
                  )}
                  {(selectedAgent.sessionHistory || []).length > 0 ? (
                    <ul className="agent-detail-session-list">
                      {(selectedAgent.sessionHistory || []).slice(-5).reverse().map((sessionId, idx) => (
                        <li key={idx} className="agent-detail-session-item">
                          <span className="agent-detail-session-id">{sessionId.slice(0, 8)}...</span>
                          {sessionId === selectedAgent.activeSessionId && (
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
          </section>
        ) : (
          <section className="agent-detail-pane agent-detail-empty">
            <div className="agent-empty-state">
              <div className="agent-empty-icon">&larr;</div>
              <div>Select an agent to view details</div>
            </div>
          </section>
        )}

        {/* Tasks Panel */}
        <section className="agent-task-pane">
          <div className="agent-pane-header">
            <h3>Tasks <span className="agent-count-badge">{activeTasks.length}</span></h3>
            <div style={{ display: 'flex', gap: 6 }}>
              {activeTasks.length > 0 && (
                <button
                  className={`btn btn-small ${taskBulkMode ? 'btn-warning' : 'btn-secondary'}`}
                  onClick={() => taskBulkMode ? exitTaskBulkMode() : setTaskBulkMode(true)}
                >
                  {taskBulkMode ? 'Cancel' : 'Select'}
                </button>
              )}
            </div>
          </div>

          {!taskBulkMode && (
            <form onSubmit={handleCreateTask} className="agent-task-create">
              <input
                value={newTaskTitle}
                onChange={e => setNewTaskTitle(e.target.value)}
                placeholder="New task title..."
              />
              <button className="btn btn-small btn-primary" type="submit" disabled={isCreatingTask}>
                {isCreatingTask ? '...' : 'Add'}
              </button>
            </form>
          )}

          {taskBulkMode && activeTasks.length > 0 && (
            <div className="agent-bulk-bar">
              <input
                type="checkbox"
                className="kanban-bulk-checkbox"
                checked={activeTasks.length > 0 && activeTasks.every(t => selectedTaskIds.has(t.id))}
                onChange={toggleSelectAllTasks}
                title="Select all"
              />
              <span className="kanban-bulk-count">{selectedTaskIds.size} selected</span>
              {selectedTaskIds.size > 0 && (
                !confirmBulkDelete ? (
                  <button className="btn btn-small btn-danger" onClick={() => setConfirmBulkDelete(true)}>Delete</button>
                ) : (
                  <>
                    <span className="kanban-bulk-confirm-text">Delete {selectedTaskIds.size}?</span>
                    <button className="btn btn-small btn-danger" onClick={handleBulkDeleteTasks} disabled={bulkDeleting}>
                      {bulkDeleting ? '...' : 'Yes'}
                    </button>
                    <button className="btn btn-small" onClick={() => setConfirmBulkDelete(false)}>No</button>
                  </>
                )
              )}
            </div>
          )}

          <div className="agent-task-list">
            {activeTasks.map(task => (
              <div
                key={task.id}
                className={`agent-task-card ${taskBulkMode && selectedTaskIds.has(task.id) ? 'selected' : ''}`}
                onClick={taskBulkMode ? () => toggleTaskSelect(task.id) : undefined}
              >
                <div className={`agent-task-priority-bar ${getPriorityClass(task.priority)}`} />
                <div className="agent-task-card-content">
                  <div className="agent-task-card-header">
                    {taskBulkMode && (
                      <input
                        type="checkbox"
                        className="kanban-bulk-checkbox"
                        checked={selectedTaskIds.has(task.id)}
                        onChange={() => toggleTaskSelect(task.id)}
                        onClick={e => e.stopPropagation()}
                      />
                    )}
                    <strong>{task.title}</strong>
                    <span className="agent-task-stage">{task.stage}</span>
                  </div>
                  {!taskBulkMode && task.description && (
                    <div className="agent-task-description">
                      {task.description.length > 100 ? `${task.description.slice(0, 100)}...` : task.description}
                    </div>
                  )}
                  {!taskBulkMode && (
                    <div className="agent-task-field">
                      <span className="agent-task-field-label">Agents:</span>
                      <AgentChipSelector
                        assignedAgentIds={task.assignedAgents || []}
                        allAgents={agents || []}
                        onAssign={agentId => handleAssignAgent(task.id, agentId)}
                        onUnassign={agentId => handleUnassignAgent(task.id, agentId)}
                      />
                    </div>
                  )}
                  {!taskBulkMode && (
                    <div className="agent-task-card-footer">
                      <span className="agent-task-meta-text">
                        {(task.comments || []).length} comments
                        {task.priority !== undefined && (
                          <span className={`agent-task-priority-label ${getPriorityClass(task.priority)}`}>
                            P{task.priority}
                          </span>
                        )}
                      </span>
                      {confirmDeleteTaskId === task.id ? (
                        <div className="agent-delete-confirm">
                          <button className="btn btn-small btn-danger" onClick={() => handleDeleteTask(task.id)}>Yes</button>
                          <button className="btn btn-small" onClick={() => setConfirmDeleteTaskId(null)}>No</button>
                        </div>
                      ) : (
                        <button className="agent-delete-btn" onClick={() => setConfirmDeleteTaskId(task.id)} title="Delete task">&times;</button>
                      )}
                    </div>
                  )}
                </div>
              </div>
            ))}
            {activeTasks.length === 0 && (
              <div className="agent-empty-state">
                <div className="agent-empty-icon">+</div>
                <div>No tasks yet</div>
                <div className="agent-empty-hint">Add one above to get started</div>
              </div>
            )}
          </div>
        </section>
      </div>

      {showNewAgentModal && (
        <NewAgentModal
          onClose={() => setShowNewAgentModal(false)}
          onCreate={onCreateAgent}
        />
      )}
    </main>
  );
}

export default AgentBoard;

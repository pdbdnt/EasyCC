import { useState, useEffect, useCallback, useRef } from 'react';
import PlanViewer from './PlanViewer';
import PromptsModal from './PromptsModal';

const ARCHIVED_PLANS_STORAGE_KEY = 'archivedPlansBySession';

function getPlanKey(plan, index) {
  return plan.path || plan.filename || `${plan.name || 'plan'}-${index}`;
}

function loadArchivedPlanKeys(sessionId) {
  if (!sessionId) return [];
  try {
    const raw = JSON.parse(localStorage.getItem(ARCHIVED_PLANS_STORAGE_KEY) || '{}');
    const archived = raw[sessionId];
    return Array.isArray(archived) ? archived : [];
  } catch {
    return [];
  }
}

function saveArchivedPlanKeys(sessionId, keys) {
  if (!sessionId) return;
  try {
    const raw = JSON.parse(localStorage.getItem(ARCHIVED_PLANS_STORAGE_KEY) || '{}');
    raw[sessionId] = keys;
    localStorage.setItem(ARCHIVED_PLANS_STORAGE_KEY, JSON.stringify(raw));
  } catch {
    // Ignore localStorage failures
  }
}

function ContextSidebar({ session, onClose, onUpdateSession, onFocus, hideCloseButton = false }) {
  const [plans, setPlans] = useState([]);
  const [loadingPlans, setLoadingPlans] = useState(false);
  const [notes, setNotes] = useState(session?.notes || '');
  const [expandedPlanIndex, setExpandedPlanIndex] = useState(null);
  const [archivedPlanKeys, setArchivedPlanKeys] = useState([]);
  const [showPromptsModal, setShowPromptsModal] = useState(false);
  const [showPlanPicker, setShowPlanPicker] = useState(false);
  const [availablePlans, setAvailablePlans] = useState([]);
  const [loadingAvailable, setLoadingAvailable] = useState(false);
  const planPickerRef = useRef(null);
  const [showSessionPicker, setShowSessionPicker] = useState(false);
  const [availableClaudeSessions, setAvailableClaudeSessions] = useState([]);
  const [loadingClaudeSessions, setLoadingClaudeSessions] = useState(false);
  const sessionPickerRef = useRef(null);
  const [showPastePlan, setShowPastePlan] = useState(false);
  const [pastedPlanContent, setPastedPlanContent] = useState('');
  const [pastedPlanName, setPastedPlanName] = useState('');
  const [savingPlan, setSavingPlan] = useState(false);

  // Create a stable key to detect plan changes via WebSocket
  // Reacts to: new plans (array change) or updated plans (plansUpdatedAt change)
  const plansKey = `${JSON.stringify(session?.plans || [])}-${session?.plansUpdatedAt || 0}`;

  // Fetch plans when session changes OR when session.plans array changes (via WebSocket)
  useEffect(() => {
    if (!session?.id) {
      setPlans([]);
      return;
    }

    const fetchPlans = async () => {
      setLoadingPlans(true);
      try {
        const response = await fetch(`/api/sessions/${session.id}/plans`);
        if (response.ok) {
          const { plans: planData } = await response.json();
          setPlans(planData || []);
        }
      } catch (error) {
        console.error('Error fetching plans:', error);
      } finally {
        setLoadingPlans(false);
      }
    };

    fetchPlans();
  }, [session?.id, plansKey]); // plansKey changes when WebSocket updates session.plans

  // Sync notes when session changes
  useEffect(() => {
    setNotes(session?.notes || '');
  }, [session?.id, session?.notes]);

  // Load archived plans for current session.
  useEffect(() => {
    if (!session?.id) {
      setArchivedPlanKeys([]);
      return;
    }
    setArchivedPlanKeys(loadArchivedPlanKeys(session.id));
  }, [session?.id]);

  // Persist archived plans for current session.
  useEffect(() => {
    if (!session?.id) return;
    saveArchivedPlanKeys(session.id, archivedPlanKeys);
  }, [session?.id, archivedPlanKeys]);

  // Keep expansion state consistent with archived state and plan list.
  useEffect(() => {
    if (plans.length === 0) {
      if (expandedPlanIndex !== null) {
        setExpandedPlanIndex(null);
      }
      return;
    }

    if (expandedPlanIndex !== null) {
      const expandedPlan = plans[expandedPlanIndex];
      if (!expandedPlan) {
        setExpandedPlanIndex(null);
        return;
      }
      const expandedKey = getPlanKey(expandedPlan, expandedPlanIndex);
      if (archivedPlanKeys.includes(expandedKey)) {
        setExpandedPlanIndex(null);
      }
      return;
    }

    const firstUnarchivedIndex = plans.findIndex(
      (plan, index) => !archivedPlanKeys.includes(getPlanKey(plan, index))
    );
    if (firstUnarchivedIndex >= 0) {
      setExpandedPlanIndex(firstUnarchivedIndex);
    }
  }, [plans, archivedPlanKeys, expandedPlanIndex]);

  // Close plan picker on click outside
  useEffect(() => {
    if (!showPlanPicker) return;

    const handleClickOutside = (e) => {
      if (planPickerRef.current && !planPickerRef.current.contains(e.target)) {
        setShowPlanPicker(false);
      }
    };

    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [showPlanPicker]);

  // Close session picker on click outside
  useEffect(() => {
    if (!showSessionPicker) return;
    const handleClickOutside = (e) => {
      if (sessionPickerRef.current && !sessionPickerRef.current.contains(e.target)) {
        setShowSessionPicker(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [showSessionPicker]);

  const handleOpenSessionPicker = async () => {
    if (showSessionPicker) {
      setShowSessionPicker(false);
      return;
    }
    setShowSessionPicker(true);
    setLoadingClaudeSessions(true);
    try {
      const response = await fetch(`/api/sessions/${session.id}/available-claude-sessions`);
      if (response.ok) {
        const data = await response.json();
        setAvailableClaudeSessions(data.claudeSessions || []);
      }
    } catch (error) {
      console.error('Error fetching Claude sessions:', error);
    } finally {
      setLoadingClaudeSessions(false);
    }
  };

  const handleLinkClaudeSession = async (claudeSessionId) => {
    try {
      const response = await fetch(`/api/sessions/${session.id}/link-claude-session`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ claudeSessionId }),
      });
      if (response.ok) {
        setShowSessionPicker(false);
        // Session state updates automatically via WebSocket sessionUpdated event
      }
    } catch (error) {
      console.error('Error linking Claude session:', error);
    }
  };

  const handleGenerateClaudeSession = async () => {
    try {
      const response = await fetch(`/api/sessions/${session.id}/generate-claude-session`, {
        method: 'POST',
      });
      if (!response.ok) {
        console.error('Failed to generate Claude session');
      }
      // Session state updates automatically via WebSocket sessionUpdated event
    } catch (error) {
      console.error('Error generating Claude session:', error);
    }
  };

  const handleSavePastedPlan = async () => {
    if (!pastedPlanContent.trim()) return;
    setSavingPlan(true);
    try {
      const response = await fetch('/api/plans', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          content: pastedPlanContent,
          name: pastedPlanName || 'pasted-plan',
          sessionId: session.id
        }),
      });
      if (response.ok) {
        setShowPastePlan(false);
        setPastedPlanContent('');
        setPastedPlanName('');
        // Refresh plans
        const plansRes = await fetch(`/api/sessions/${session.id}/plans`);
        if (plansRes.ok) {
          const { plans: planData } = await plansRes.json();
          setPlans(planData || []);
        }
      }
    } catch (error) {
      console.error('Error saving pasted plan:', error);
    } finally {
      setSavingPlan(false);
    }
  };

  const handleNotesBlur = () => {
    if (notes !== (session?.notes || '')) {
      onUpdateSession?.(session.id, { notes });
    }
  };

  const handleOpenPlanPicker = async () => {
    if (showPlanPicker) {
      setShowPlanPicker(false);
      return;
    }

    setShowPlanPicker(true);
    setLoadingAvailable(true);
    try {
      const response = await fetch(`/api/sessions/${session.id}/available-plans`);
      if (response.ok) {
        const { plans: available } = await response.json();
        setAvailablePlans(available || []);
      }
    } catch (error) {
      console.error('Error fetching available plans:', error);
    } finally {
      setLoadingAvailable(false);
    }
  };

  const handleAddPlan = async (planPath) => {
    try {
      const response = await fetch(`/api/sessions/${session.id}/plans`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ planPath }),
      });
      if (response.ok) {
        const { plans: updatedPlans } = await response.json();
        setPlans(updatedPlans || []);
        setShowPlanPicker(false);
      }
    } catch (error) {
      console.error('Error adding plan:', error);
    }
  };

  const handleTogglePlanArchive = (index) => {
    const plan = plans[index];
    if (!plan) return;
    const planKey = getPlanKey(plan, index);
    setArchivedPlanKeys((prev) => (
      prev.includes(planKey)
        ? prev.filter((key) => key !== planKey)
        : [...prev, planKey]
    ));

    if (expandedPlanIndex === index) {
      setExpandedPlanIndex(null);
    }
  };

  if (!session) {
    return (
      <div className="context-sidebar">
        <div className="context-sidebar-header">
          <h3>Context</h3>
          {!hideCloseButton && (
            <button className="sidebar-close-btn" onClick={onClose} title="Close (Ctrl+B)">
              &times;
            </button>
          )}
        </div>
        <div className="context-section">
          <p className="text-muted">Select a session to view context</p>
        </div>
      </div>
    );
  }

  const promptHistory = session.promptHistory || [];
  const recentPrompts = [...promptHistory].reverse(); // Newest first

  return (
    <div className="context-sidebar" onClick={onFocus}>
      <div className="context-sidebar-header">
        <h3>Context</h3>
        {!hideCloseButton && (
          <button className="sidebar-close-btn" onClick={onClose} title="Close (Ctrl+B)">
            &times;
          </button>
        )}
      </div>

      {/* Claude Session Link Row */}
      <div className="claude-session-row" ref={sessionPickerRef}>
        <span className="claude-session-label">Claude:</span>
        <span className="claude-session-id" title={session.claudeSessionId || 'Not linked'}>
          {session.claudeSessionId ? session.claudeSessionId.slice(0, 8) + '..' : 'Not linked'}
        </span>
        {session.cliType === 'terminal' && !session.claudeSessionId ? (
          <button
            className="claude-session-link-btn"
            onClick={handleGenerateClaudeSession}
            title="Generate session ID and inject cc command into terminal"
          >
            Generate
          </button>
        ) : (
          <button
            className="claude-session-link-btn"
            onClick={handleOpenSessionPicker}
            title="Link to a Claude session"
          >
            {session.claudeSessionId ? 'Change' : 'Link'}
          </button>
        )}
          {showSessionPicker && (
            <div className="claude-session-picker">
              {loadingClaudeSessions ? (
                <div className="claude-session-picker-empty">Loading...</div>
              ) : availableClaudeSessions.length > 0 ? (
                availableClaudeSessions.map((cs) => (
                  <div
                    key={cs.sessionId}
                    className={`claude-session-picker-item ${cs.sessionId === session.claudeSessionId ? 'current' : ''}`}
                    onClick={() => handleLinkClaudeSession(cs.sessionId)}
                  >
                    <div className="claude-session-picker-header">
                      <span className="claude-session-picker-id">
                        {cs.sessionId.slice(0, 8)}..
                        {cs.sessionId === session.claudeSessionId && ' \u2713'}
                      </span>
                      <span className="claude-session-picker-meta">
                        {cs.promptCount} prompt{cs.promptCount !== 1 ? 's' : ''} · {formatRelativeTime(cs.modified)}
                      </span>
                    </div>
                    {cs.firstPrompt && (
                      <div className="claude-session-picker-prompt">
                        {cs.firstPrompt.length > 60 ? cs.firstPrompt.slice(0, 60) + '...' : cs.firstPrompt}
                      </div>
                    )}
                  </div>
                ))
              ) : (
                <div className="claude-session-picker-empty">No Claude sessions found for this directory</div>
              )}
            </div>
          )}
        </div>

      {/* Notes + Recent Prompts (2 columns) */}
      <div className="context-section notes-prompts-row">
        <div className="notes-column">
          <div className="column-label">Notes</div>
          <textarea
            className="context-notes"
            value={notes}
            onChange={e => setNotes(e.target.value)}
            onBlur={handleNotesBlur}
            placeholder="Add notes..."
            rows={3}
          />
        </div>
        <div className="prompts-column">
          <div className="column-label-row">
            <span className="column-label">Recent Prompts</span>
            {recentPrompts.length > 0 && (
              <button
                className="prompts-expand-btn"
                onClick={() => setShowPromptsModal(true)}
                title="View all prompts"
              >
                &#8599;
              </button>
            )}
          </div>
          {recentPrompts.length > 0 ? (
            <div className="prompts-mini-list">
              {recentPrompts.slice(0, 3).map((prompt, index) => (
                <div key={index} className="prompt-mini-item" title={prompt.text}>
                  {prompt.text.length > 40 ? prompt.text.substring(0, 40) + '...' : prompt.text}
                </div>
              ))}
              {recentPrompts.length > 3 && (
                <div className="prompts-more" onClick={() => setShowPromptsModal(true)}>
                  +{recentPrompts.length - 3} more
                </div>
              )}
            </div>
          ) : (
            <p className="text-muted small">No prompts yet</p>
          )}
        </div>
      </div>

      {/* Active Plans - stretches to fill remaining space */}
      <div className="context-section plans-section-stretch">
        <div className="context-section-header">
          <div className="section-header-left">
            <span className="context-section-icon">&#128203;</span>
            <span className="context-section-title">Active Plans</span>
          </div>
          <div className="section-header-right">
            {plans.length > 0 && <span className="section-count">{plans.length}</span>}
            <button
              className="plan-picker-btn"
              onClick={() => setShowPastePlan(!showPastePlan)}
              title="Paste a plan"
            >
              Paste
            </button>
            <div className="plan-picker-wrapper" ref={planPickerRef}>
              <button
                className="plan-picker-btn"
                onClick={handleOpenPlanPicker}
                title="Add existing plan"
              >
                +
              </button>
              {showPlanPicker && (
                <div className="plan-picker-dropdown">
                  {loadingAvailable ? (
                    <div className="plan-picker-empty">Loading...</div>
                  ) : availablePlans.length > 0 ? (
                    availablePlans.map((plan) => (
                      <div
                        key={plan.path}
                        className="plan-picker-item"
                        onClick={() => handleAddPlan(plan.path)}
                      >
                        <span className="plan-picker-name">{plan.name}</span>
                        {plan.modifiedAt && (
                          <span className="plan-picker-date">{formatRelativeTime(plan.modifiedAt)}</span>
                        )}
                      </div>
                    ))
                  ) : (
                    <div className="plan-picker-empty">No other plans available</div>
                  )}
                </div>
              )}
            </div>
          </div>
        </div>
        <div className="plans-content-area">
          {showPastePlan && (
            <div className="paste-plan-form">
              <input
                type="text"
                className="paste-plan-name"
                placeholder="Plan name (optional)"
                value={pastedPlanName}
                onChange={e => setPastedPlanName(e.target.value)}
              />
              <textarea
                className="paste-plan-textarea"
                placeholder="Paste plan content here..."
                value={pastedPlanContent}
                onChange={e => setPastedPlanContent(e.target.value)}
                rows={8}
                autoFocus
              />
              <div className="paste-plan-actions">
                <button
                  className="btn btn-secondary btn-small"
                  onClick={() => { setShowPastePlan(false); setPastedPlanContent(''); setPastedPlanName(''); }}
                  disabled={savingPlan}
                >
                  Cancel
                </button>
                <button
                  className="btn btn-primary btn-small"
                  onClick={handleSavePastedPlan}
                  disabled={savingPlan || !pastedPlanContent.trim()}
                >
                  {savingPlan ? 'Saving...' : 'Save Plan'}
                </button>
              </div>
            </div>
          )}
          {loadingPlans ? (
            <p className="text-muted">Loading plans...</p>
          ) : plans.length > 0 ? (
            <div className="plans-mini-list">
              {plans.slice(0, 5).map((plan, index) => {
                const planKey = getPlanKey(plan, index);
                const isArchived = archivedPlanKeys.includes(planKey);
                const isExpanded = expandedPlanIndex === index;
                return (
                <div key={plan.path || plan.filename || index} className="plan-item-expandable">
                  <div
                    className={`plan-item-header ${isArchived ? 'archived' : ''}`}
                    onClick={() => setExpandedPlanIndex(isExpanded ? null : index)}
                  >
                    <span className="expand-icon">{isExpanded ? '\u25BC' : '\u25B6'}</span>
                    <span className="plan-name">{plan.name || `Plan ${index + 1}`}</span>
                    <div className="plan-item-meta">
                      {plan.modifiedAt && (
                        <span className="plan-date">{formatRelativeTime(plan.modifiedAt)}</span>
                      )}
                      <button
                        type="button"
                        className="plan-archive-btn"
                        onClick={(e) => {
                          e.stopPropagation();
                          handleTogglePlanArchive(index);
                        }}
                      >
                        {isArchived ? 'Restore' : 'Archive'}
                      </button>
                    </div>
                  </div>
                  {isExpanded && (
                    <div className="plan-content-expanded">
                      <PlanViewer plan={plan} compact={true} />
                    </div>
                  )}
                </div>
                );
              })}
              {plans.length > 5 && (
                <p className="text-muted plans-more">+{plans.length - 5} more plan(s)</p>
              )}
            </div>
          ) : (
            <p className="text-muted">No active plans</p>
          )}
        </div>
      </div>

      {/* Prompts Modal */}
      {showPromptsModal && (
        <PromptsModal
          prompts={recentPrompts}
          onClose={() => setShowPromptsModal(false)}
        />
      )}
    </div>
  );
}

function CollapsibleSection({ icon, title, children, defaultOpen = false, count = 0 }) {
  const [isOpen, setIsOpen] = useState(defaultOpen);

  return (
    <div className={`context-section collapsible ${isOpen ? 'open' : ''}`}>
      <div className="context-section-header" onClick={() => setIsOpen(!isOpen)}>
        <div className="section-header-left">
          <span className="expand-icon">{isOpen ? '&#9660;' : '&#9654;'}</span>
          <span className="context-section-icon" dangerouslySetInnerHTML={{ __html: icon }} />
          <span className="context-section-title">{title}</span>
        </div>
        {count > 0 && <span className="section-count">{count}</span>}
      </div>
      {isOpen && <div className="context-section-content">{children}</div>}
    </div>
  );
}

function formatRelativeTime(dateString) {
  if (!dateString) return 'Unknown';

  const date = new Date(dateString);
  const now = new Date();
  const diffMs = now - date;
  const diffSecs = Math.floor(diffMs / 1000);
  const diffMins = Math.floor(diffSecs / 60);
  const diffHours = Math.floor(diffMins / 60);
  const diffDays = Math.floor(diffHours / 24);

  if (diffSecs < 60) return 'Just now';
  if (diffMins < 60) return `${diffMins}m ago`;
  if (diffHours < 24) return `${diffHours}h ago`;
  if (diffDays < 7) return `${diffDays}d ago`;

  return date.toLocaleDateString();
}

export default ContextSidebar;

import { useState, useEffect, useCallback } from 'react';
import PlanViewer from './PlanViewer';
import PromptsModal from './PromptsModal';

function ContextSidebar({ session, onClose, onUpdateSession, onFocus }) {
  const [plans, setPlans] = useState([]);
  const [loadingPlans, setLoadingPlans] = useState(false);
  const [notes, setNotes] = useState(session?.notes || '');
  const [expandedPlanIndex, setExpandedPlanIndex] = useState(0); // Default expand first (latest) plan
  const [showPromptsModal, setShowPromptsModal] = useState(false);

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
          // Auto-expand latest plan when plans load
          if (planData && planData.length > 0) {
            setExpandedPlanIndex(0);
          }
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

  const handleNotesBlur = () => {
    if (notes !== (session?.notes || '')) {
      onUpdateSession?.(session.id, { notes });
    }
  };

  if (!session) {
    return (
      <div className="context-sidebar">
        <div className="context-sidebar-header">
          <h3>Context</h3>
          <button className="sidebar-close-btn" onClick={onClose} title="Close (Ctrl+B)">
            &times;
          </button>
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
        <button className="sidebar-close-btn" onClick={onClose} title="Close (Ctrl+B)">
          &times;
        </button>
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
          {plans.length > 0 && <span className="section-count">{plans.length}</span>}
        </div>
        <div className="plans-content-area">
          {loadingPlans ? (
            <p className="text-muted">Loading plans...</p>
          ) : plans.length > 0 ? (
            <div className="plans-mini-list">
              {plans.slice(0, 5).map((plan, index) => (
                <div key={plan.path || index} className="plan-item-expandable">
                  <div
                    className="plan-item-header"
                    onClick={() => setExpandedPlanIndex(expandedPlanIndex === index ? null : index)}
                  >
                    <span className="expand-icon">{expandedPlanIndex === index ? '\u25BC' : '\u25B6'}</span>
                    <span className="plan-name">{plan.name || `Plan ${index + 1}`}</span>
                    {plan.modifiedAt && (
                      <span className="plan-date">{formatRelativeTime(plan.modifiedAt)}</span>
                    )}
                  </div>
                  {expandedPlanIndex === index && (
                    <div className="plan-content-expanded">
                      <PlanViewer plan={plan} compact={true} />
                    </div>
                  )}
                </div>
              ))}
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

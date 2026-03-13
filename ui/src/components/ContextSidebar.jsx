import { useState, useEffect, useCallback, useRef, Fragment } from 'react';
import PlanViewer from './PlanViewer';
import PromptsModal from './PromptsModal';
import ResizeHandle from './ResizeHandle';

const ARCHIVED_PLANS_STORAGE_KEY = 'archivedPlansBySession';
const MIN_WIDGET_HEIGHT = 60;
const MIN_WIDGET_WIDTH = 80;
const HANDLE_SIZE = 6;

const DEFAULT_WIDGET_LAYOUT = {
  rows: [
    { widgets: ['notes', 'prompts'], ratio: 0.5, colRatios: [0.5, 0.5] },
    { widgets: ['plans'], ratio: 0.5, colRatios: [1] },
  ],
  hiddenWidgets: [],
};

const WIDGET_REGISTRY = {
  notes: { title: 'Notes' },
  prompts: { title: 'Recent Prompts' },
  plans: { title: 'Active Plans' },
};

function sanitizeLayout(layout, registryIds) {
  if (!layout?.rows?.length) return DEFAULT_WIDGET_LAYOUT;
  const validIds = new Set(registryIds);
  const seen = new Set();
  const rows = layout.rows
    .map(row => {
      if (!row?.widgets) return null;
      const widgets = row.widgets.filter(id => validIds.has(id) && !seen.has(id)).slice(0, 2);
      widgets.forEach(id => seen.add(id));
      if (widgets.length === 0) return null;
      const colRatios = widgets.map((_, i) => {
        const r = row.colRatios?.[i];
        return typeof r === 'number' && r > 0 ? r : (1 / widgets.length);
      });
      // Normalize colRatios to sum to 1
      const colSum = colRatios.reduce((a, b) => a + b, 0);
      return {
        widgets,
        ratio: typeof row.ratio === 'number' && row.ratio > 0 ? row.ratio : 1,
        colRatios: colRatios.map(r => r / colSum),
      };
    })
    .filter(Boolean);
  if (rows.length === 0) return DEFAULT_WIDGET_LAYOUT;
  const sum = rows.reduce((a, r) => a + r.ratio, 0);
  return {
    rows: rows.map(r => ({ ...r, ratio: r.ratio / sum })),
    hiddenWidgets: (layout.hiddenWidgets || []).filter(id => validIds.has(id)),
  };
}

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

// ─── Widget Sub-Components ──────────────────────────────────────────

function NotesWidget({ notes, setNotes, handleNotesBlur }) {
  return (
    <textarea
      className="context-notes widget-notes"
      value={notes}
      onChange={e => setNotes(e.target.value)}
      onBlur={handleNotesBlur}
      placeholder="Add notes..."
    />
  );
}

function PromptsWidget({ recentPrompts, onShowModal }) {
  return recentPrompts.length > 0 ? (
    <div className="prompts-mini-list">
      {recentPrompts.slice(0, 5).map((prompt, index) => (
        <div key={index} className="prompt-mini-item" title={prompt.text}>
          {prompt.text}
        </div>
      ))}
      {recentPrompts.length > 5 && (
        <div className="prompts-more" onClick={onShowModal}>
          +{recentPrompts.length - 5} more
        </div>
      )}
    </div>
  ) : (
    <p className="text-muted small">No prompts yet</p>
  );
}

function PlansWidget({
  plans, loadingPlans, expandedPlanIndex, setExpandedPlanIndex,
  archivedPlanKeys, handleTogglePlanArchive, userCollapsedRef,
  showPlanPicker, handleOpenPlanPicker, availablePlans, loadingAvailable,
  handleAddPlan, planPickerRef,
  showPastePlan, setShowPastePlan, pastedPlanName, setPastedPlanName,
  pastedPlanContent, setPastedPlanContent, savingPlan, handleSavePastedPlan,
  pastePlanError, setPastePlanError,
  session,
}) {
  return (
    <>
      {showPastePlan && (
        <div className="paste-plan-form">
          <input
            type="text"
            className="paste-plan-name"
            placeholder="Plan name (optional)"
            value={pastedPlanName}
            onChange={e => {
              setPastedPlanName(e.target.value);
              if (pastePlanError) setPastePlanError('');
            }}
          />
          <textarea
            className="paste-plan-textarea"
            placeholder="Paste plan content here..."
            value={pastedPlanContent}
            onChange={e => {
              setPastedPlanContent(e.target.value);
              if (pastePlanError) setPastePlanError('');
            }}
            rows={6}
            autoFocus
          />
          {pastePlanError && (
            <p className="text-muted small" style={{ color: '#ff7b72' }}>
              {pastePlanError}
            </p>
          )}
          <div className="paste-plan-actions">
            <button
              className="btn btn-secondary btn-small"
              onClick={() => {
                setShowPastePlan(false);
                setPastedPlanContent('');
                setPastedPlanName('');
                setPastePlanError('');
              }}
              disabled={savingPlan}
            >
              Cancel
            </button>
            <button
              className="btn btn-primary btn-small"
              onClick={handleSavePastedPlan}
              disabled={savingPlan || !pastedPlanContent.trim()}
            >
              {savingPlan ? 'Saving...' : 'Save'}
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
                  onClick={() => {
                    if (isExpanded) {
                      userCollapsedRef.current = true;
                      setExpandedPlanIndex(null);
                    } else {
                      userCollapsedRef.current = false;
                      setExpandedPlanIndex(index);
                    }
                  }}
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
                    <PlanViewer plan={plan} compact={true} workingDir={session?.workingDir} />
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
    </>
  );
}

// ─── Main Component ─────────────────────────────────────────────────

function ContextSidebar({ session, agent = null, onClose, onUpdateSession, onFocus, hideCloseButton = false, widgetLayout, onWidgetLayoutChange }) {
  const [plans, setPlans] = useState([]);
  const [loadingPlans, setLoadingPlans] = useState(false);
  const [notes, setNotes] = useState(session?.notes || '');
  const [roleDraft, setRoleDraft] = useState(session?.role || '');
  const [isEditingRole, setIsEditingRole] = useState(false);
  const [isRoleExpanded, setIsRoleExpanded] = useState(false);
  const [expandedPlanIndex, setExpandedPlanIndex] = useState(null);
  const [archivedPlanKeys, setArchivedPlanKeys] = useState([]);
  const [showPromptsModal, setShowPromptsModal] = useState(false);
  const [showPlanPicker, setShowPlanPicker] = useState(false);
  const [availablePlans, setAvailablePlans] = useState([]);
  const [loadingAvailable, setLoadingAvailable] = useState(false);
  const planPickerRef = useRef(null);
  const userCollapsedRef = useRef(false);
  const [showSessionPicker, setShowSessionPicker] = useState(false);
  const [availableClaudeSessions, setAvailableClaudeSessions] = useState([]);
  const [loadingClaudeSessions, setLoadingClaudeSessions] = useState(false);
  const sessionPickerRef = useRef(null);
  const [showPastePlan, setShowPastePlan] = useState(false);
  const [pastedPlanContent, setPastedPlanContent] = useState('');
  const [pastedPlanName, setPastedPlanName] = useState('');
  const [pastePlanError, setPastePlanError] = useState('');
  const [savingPlan, setSavingPlan] = useState(false);
  const [showWidgetPicker, setShowWidgetPicker] = useState(false);
  const widgetPickerRef = useRef(null);

  // Widget layout state
  const registryIds = Object.keys(WIDGET_REGISTRY);
  const [layout, setLayout] = useState(() => sanitizeLayout(widgetLayout, registryIds));
  const widgetContainerRef = useRef(null);
  const layoutRef = useRef(layout);
  layoutRef.current = layout;

  // Sync layout from props when widgetLayout changes externally
  useEffect(() => {
    if (widgetLayout) {
      setLayout(sanitizeLayout(widgetLayout, registryIds));
    }
  }, [widgetLayout]);

  // DnD state
  const [draggedWidget, setDraggedWidget] = useState(null);
  const [dropTarget, setDropTarget] = useState(null); // { rowIdx, colIdx, position }

  // ─── Existing effects (unchanged) ───────────────────────────────

  const plansKey = `${JSON.stringify(session?.plans || [])}-${session?.plansUpdatedAt || 0}`;

  const fetchPlans = useCallback(async () => {
    if (!session?.id) {
      setPlans([]);
      return;
    }
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
  }, [session?.id]);

  useEffect(() => {
    fetchPlans();
  }, [fetchPlans, plansKey]);

  useEffect(() => {
    setNotes(session?.notes || '');
  }, [session?.id, session?.notes]);

  useEffect(() => {
    setRoleDraft(session?.role || '');
    setIsEditingRole(false);
    setIsRoleExpanded(false);
  }, [session?.id, session?.role]);

  useEffect(() => {
    if (!session?.id) {
      setArchivedPlanKeys([]);
      return;
    }
    setArchivedPlanKeys(loadArchivedPlanKeys(session.id));
    userCollapsedRef.current = false;
  }, [session?.id]);

  useEffect(() => {
    if (!session?.id) return;
    saveArchivedPlanKeys(session.id, archivedPlanKeys);
  }, [session?.id, archivedPlanKeys]);

  useEffect(() => {
    if (plans.length === 0) {
      if (expandedPlanIndex !== null) setExpandedPlanIndex(null);
      return;
    }
    if (expandedPlanIndex !== null) {
      const expandedPlan = plans[expandedPlanIndex];
      if (!expandedPlan) { setExpandedPlanIndex(null); return; }
      const expandedKey = getPlanKey(expandedPlan, expandedPlanIndex);
      if (archivedPlanKeys.includes(expandedKey)) setExpandedPlanIndex(null);
      return;
    }
    if (userCollapsedRef.current) return;
    const firstUnarchivedIndex = plans.findIndex(
      (plan, index) => !archivedPlanKeys.includes(getPlanKey(plan, index))
    );
    if (firstUnarchivedIndex >= 0) setExpandedPlanIndex(firstUnarchivedIndex);
  }, [plans, archivedPlanKeys, expandedPlanIndex]);

  useEffect(() => {
    if (!showPlanPicker) return;
    const handleClickOutside = (e) => {
      if (planPickerRef.current && !planPickerRef.current.contains(e.target)) setShowPlanPicker(false);
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [showPlanPicker]);

  useEffect(() => {
    if (!showSessionPicker) return;
    const handleClickOutside = (e) => {
      if (sessionPickerRef.current && !sessionPickerRef.current.contains(e.target)) setShowSessionPicker(false);
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [showSessionPicker]);

  // Close widget picker on click outside
  useEffect(() => {
    if (!showWidgetPicker) return;
    const handleClickOutside = (e) => {
      if (widgetPickerRef.current && !widgetPickerRef.current.contains(e.target)) setShowWidgetPicker(false);
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [showWidgetPicker]);

  // ─── Existing handlers (unchanged) ──────────────────────────────

  const handleOpenSessionPicker = async () => {
    if (showSessionPicker) { setShowSessionPicker(false); return; }
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
      if (response.ok) setShowSessionPicker(false);
    } catch (error) {
      console.error('Error linking Claude session:', error);
    }
  };

  const handleGenerateClaudeSession = async () => {
    try {
      const response = await fetch(`/api/sessions/${session.id}/generate-claude-session`, { method: 'POST' });
      if (response.ok) {
        const data = await response.json();
        await navigator.clipboard.writeText(data.command);
      }
    } catch (error) {
      console.error('Error generating Claude session:', error);
    }
  };

  const handleSavePastedPlan = async () => {
    if (!pastedPlanContent.trim()) return;
    setPastePlanError('');
    setSavingPlan(true);
    try {
      const response = await fetch('/api/plans', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: pastedPlanContent, name: pastedPlanName || 'pasted-plan', sessionId: session.id }),
      });

      if (!response.ok) {
        let message = 'Failed to save pasted plan';
        try {
          const errorData = await response.json();
          if (errorData?.error) {
            message = errorData.error;
          }
        } catch {
          // Keep default error text when response body is not JSON
        }
        setPastePlanError(message);
        return;
      }

      setShowPastePlan(false);
      setPastedPlanContent('');
      setPastedPlanName('');
      setPastePlanError('');
      const plansRes = await fetch(`/api/sessions/${session.id}/plans`);
      if (plansRes.ok) {
        const { plans: planData } = await plansRes.json();
        if (!planData || planData.length === 0) {
          console.warn('[ContextSidebar] Plans fetch returned empty after saving plan for session', session.id);
        }
        setPlans(planData || []);
      }
    } catch (error) {
      console.error('Error saving pasted plan:', error);
      setPastePlanError(error?.message || 'Failed to save pasted plan');
    } finally {
      setSavingPlan(false);
    }
  };

  const handleNotesBlur = () => {
    if (notes !== (session?.notes || '')) {
      onUpdateSession?.(session.id, { notes });
    }
  };

  const handleSaveRole = async () => {
    if (!session?.id) return;
    const normalizedRole = roleDraft.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
    if (normalizedRole === (session?.role || '')) {
      setIsEditingRole(false);
      return;
    }
    const success = await onUpdateSession?.(session.id, { role: normalizedRole });
    if (success !== false) {
      setIsEditingRole(false);
    }
  };

  const handleOpenPlanPicker = async () => {
    if (showPlanPicker) { setShowPlanPicker(false); return; }
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
      prev.includes(planKey) ? prev.filter((key) => key !== planKey) : [...prev, planKey]
    ));
    if (expandedPlanIndex === index) setExpandedPlanIndex(null);
  };

  // ─── Widget Layout: Resize Handlers ─────────────────────────────

  const persistLayout = useCallback((newLayout) => {
    if (onWidgetLayoutChange) onWidgetLayoutChange(newLayout);
  }, [onWidgetLayoutChange]);

  const handleResizeEnd = useCallback(() => {
    persistLayout(layoutRef.current);
  }, [persistLayout]);

  const handleRowResize = useCallback((handleIdx, delta) => {
    setLayout(prev => {
      const container = widgetContainerRef.current;
      if (!container) return prev;
      const totalH = container.clientHeight - ((prev.rows.length - 1) * HANDLE_SIZE);
      if (totalH <= 0) return prev;
      const rows = prev.rows.map(r => ({ ...r }));
      const pxA = rows[handleIdx].ratio * totalH;
      const pxB = rows[handleIdx + 1].ratio * totalH;
      const newA = Math.max(MIN_WIDGET_HEIGHT, pxA + delta);
      const newB = Math.max(MIN_WIDGET_HEIGHT, pxB - delta);
      rows[handleIdx].ratio = newA / totalH;
      rows[handleIdx + 1].ratio = newB / totalH;
      const sum = rows.reduce((a, r) => a + r.ratio, 0);
      return { ...prev, rows: rows.map(r => ({ ...r, ratio: r.ratio / sum })) };
    });
  }, []);

  const handleColResize = useCallback((rowIdx, colIdx, delta) => {
    setLayout(prev => {
      const container = widgetContainerRef.current;
      if (!container) return prev;
      const containerWidth = container.clientWidth;
      if (containerWidth <= 0) return prev;
      const rows = prev.rows.map(r => ({ ...r, colRatios: [...r.colRatios] }));
      const row = rows[rowIdx];
      const pxA = row.colRatios[colIdx] * containerWidth;
      const pxB = row.colRatios[colIdx + 1] * containerWidth;
      const pairSum = row.colRatios[colIdx] + row.colRatios[colIdx + 1];
      const newA = Math.max(MIN_WIDGET_WIDTH, pxA + delta);
      const newB = Math.max(MIN_WIDGET_WIDTH, pxB - delta);
      const total = newA + newB;
      row.colRatios[colIdx] = (newA / total) * pairSum;
      row.colRatios[colIdx + 1] = (newB / total) * pairSum;
      return { ...prev, rows };
    });
  }, []);

  const resetLayout = useCallback(() => {
    const newLayout = sanitizeLayout(DEFAULT_WIDGET_LAYOUT, registryIds);
    setLayout(newLayout);
    persistLayout(newLayout);
  }, [registryIds, persistLayout]);

  const resetColRatios = useCallback((rowIdx) => {
    setLayout(prev => {
      const rows = prev.rows.map((r, i) => {
        if (i !== rowIdx) return r;
        const equal = 1 / r.widgets.length;
        return { ...r, colRatios: r.widgets.map(() => equal) };
      });
      const newLayout = { ...prev, rows };
      persistLayout(newLayout);
      return newLayout;
    });
  }, [persistLayout]);

  // ─── Widget Layout: Drag and Drop ───────────────────────────────

  const handleDragStart = useCallback((e, widgetId) => {
    e.dataTransfer.setData('text/plain', widgetId);
    e.dataTransfer.effectAllowed = 'move';
    setDraggedWidget(widgetId);
  }, []);

  const handleDragEnd = useCallback(() => {
    setDraggedWidget(null);
    setDropTarget(null);
  }, []);

  const handleDragOver = useCallback((e, rowIdx, colIdx) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    if (!draggedWidget) return;

    const rect = e.currentTarget.getBoundingClientRect();
    const relY = (e.clientY - rect.top) / rect.height;
    const relX = (e.clientX - rect.left) / rect.width;

    let position;
    if (relY < 0.25) {
      position = 'above';
    } else if (relY > 0.75) {
      position = 'below';
    } else if (relX < 0.5) {
      position = 'left';
    } else {
      position = 'right';
    }

    setDropTarget(prev => {
      if (prev?.rowIdx === rowIdx && prev?.colIdx === colIdx && prev?.position === position) return prev;
      return { rowIdx, colIdx, position };
    });
  }, [draggedWidget]);

  const handleDragLeave = useCallback((e) => {
    // Only clear if leaving the widget container entirely
    if (e.currentTarget.contains(e.relatedTarget)) return;
    setDropTarget(null);
  }, []);

  const handleDrop = useCallback((e, targetRowIdx, targetColIdx) => {
    e.preventDefault();
    const widgetId = e.dataTransfer.getData('text/plain');
    if (!widgetId || !dropTarget) { setDraggedWidget(null); setDropTarget(null); return; }

    setLayout(prev => {
      const rows = prev.rows.map(r => ({ ...r, widgets: [...r.widgets], colRatios: [...r.colRatios] }));

      // Find and remove widget from current position
      let sourceRowIdx = -1, sourceColIdx = -1;
      for (let ri = 0; ri < rows.length; ri++) {
        const ci = rows[ri].widgets.indexOf(widgetId);
        if (ci >= 0) { sourceRowIdx = ri; sourceColIdx = ci; break; }
      }
      if (sourceRowIdx < 0) return prev;

      // Self-drop check
      if (sourceRowIdx === targetRowIdx && sourceColIdx === targetColIdx &&
          (dropTarget.position === 'left' || dropTarget.position === 'right')) {
        return prev;
      }

      // Remove from source
      rows[sourceRowIdx].widgets.splice(sourceColIdx, 1);
      rows[sourceRowIdx].colRatios.splice(sourceColIdx, 1);
      if (rows[sourceRowIdx].widgets.length === 1) {
        rows[sourceRowIdx].colRatios = [1];
      }

      // Clean empty rows and adjust target index
      let adjustedTargetRowIdx = targetRowIdx;
      const emptySourceRow = rows[sourceRowIdx].widgets.length === 0;
      if (emptySourceRow) {
        const removedRatio = rows[sourceRowIdx].ratio;
        rows.splice(sourceRowIdx, 1);
        // Redistribute removed ratio
        if (rows.length > 0) {
          const share = removedRatio / rows.length;
          rows.forEach(r => { r.ratio += share; });
        }
        if (sourceRowIdx < targetRowIdx) adjustedTargetRowIdx--;
      }

      const { position } = dropTarget;

      if (position === 'above' || position === 'below') {
        // Insert as new row
        const insertIdx = position === 'above' ? adjustedTargetRowIdx : adjustedTargetRowIdx + 1;
        // Split target row's ratio
        const neighborIdx = position === 'above' ? adjustedTargetRowIdx : adjustedTargetRowIdx;
        if (neighborIdx >= 0 && neighborIdx < rows.length) {
          const half = rows[neighborIdx].ratio / 2;
          rows[neighborIdx].ratio = half;
          rows.splice(insertIdx, 0, { widgets: [widgetId], ratio: half, colRatios: [1] });
        } else {
          rows.push({ widgets: [widgetId], ratio: 1 / (rows.length + 1), colRatios: [1] });
        }
      } else {
        // Place side-by-side in existing row
        const row = rows[adjustedTargetRowIdx];
        if (!row) return prev;
        if (row.widgets.length >= 2) {
          // Swap with existing widget at target position
          const replaceIdx = position === 'left' ? 0 : row.widgets.length - 1;
          // Move replaced widget to a new row
          const replacedWidget = row.widgets[replaceIdx];
          row.widgets[replaceIdx] = widgetId;
          // Add replaced as new row below
          const half = row.ratio / 2;
          row.ratio = half;
          rows.splice(adjustedTargetRowIdx + 1, 0, {
            widgets: [replacedWidget], ratio: half, colRatios: [1],
          });
        } else {
          // Add alongside
          if (position === 'left') {
            row.widgets.unshift(widgetId);
            row.colRatios = [0.5, 0.5];
          } else {
            row.widgets.push(widgetId);
            row.colRatios = [0.5, 0.5];
          }
        }
      }

      // Normalize row ratios
      const sum = rows.reduce((a, r) => a + r.ratio, 0);
      const newLayout = { ...prev, rows: rows.map(r => ({ ...r, ratio: r.ratio / sum })) };
      persistLayout(newLayout);
      return newLayout;
    });

    setDraggedWidget(null);
    setDropTarget(null);
  }, [dropTarget, persistLayout]);

  // ─── Widget Picker ──────────────────────────────────────────────

  const isWidgetVisible = useCallback((widgetId) => {
    return layout.rows.some(row => row.widgets.includes(widgetId));
  }, [layout]);

  const toggleWidget = useCallback((widgetId) => {
    setLayout(prev => {
      const visible = prev.rows.some(row => row.widgets.includes(widgetId));
      let newLayout;
      if (visible) {
        // Hide: remove from layout
        const rows = prev.rows.map(r => {
          const idx = r.widgets.indexOf(widgetId);
          if (idx < 0) return r;
          const widgets = r.widgets.filter(id => id !== widgetId);
          const colRatios = widgets.length > 0 ? [1] : [];
          return { ...r, widgets, colRatios };
        }).filter(r => r.widgets.length > 0);
        if (rows.length === 0) return prev; // Don't hide the last widget
        const sum = rows.reduce((a, r) => a + r.ratio, 0);
        newLayout = {
          rows: rows.map(r => ({ ...r, ratio: r.ratio / sum })),
          hiddenWidgets: [...(prev.hiddenWidgets || []), widgetId],
        };
      } else {
        // Show: add as new row at bottom
        const newRatio = 1 / (prev.rows.length + 1);
        const scale = 1 - newRatio;
        const rows = prev.rows.map(r => ({ ...r, ratio: r.ratio * scale }));
        rows.push({ widgets: [widgetId], ratio: newRatio, colRatios: [1] });
        newLayout = {
          rows,
          hiddenWidgets: (prev.hiddenWidgets || []).filter(id => id !== widgetId),
        };
      }
      persistLayout(newLayout);
      return newLayout;
    });
  }, [persistLayout]);

  // ─── Widget Header Actions ──────────────────────────────────────

  const getWidgetHeaderActions = useCallback((widgetId) => {
    if (widgetId === 'prompts') {
      const promptHistory = session?.promptHistory || [];
      const recentPrompts = [...promptHistory].reverse();
      if (recentPrompts.length > 0) {
        return (
          <button className="widget-header-action" onClick={() => setShowPromptsModal(true)} title="View all prompts">
            &#8599;
          </button>
        );
      }
    }
    if (widgetId === 'plans') {
      return (
        <div className="widget-header-actions">
          {plans.length > 0 && <span className="section-count">{plans.length}</span>}
          <button
            className="widget-header-action widget-refresh-btn"
            onClick={fetchPlans}
            title="Refresh plans"
          >
            &#x21bb;
          </button>
          <button
            className="widget-header-action"
            onClick={() => {
              setShowPastePlan(!showPastePlan);
              setPastePlanError('');
            }}
            title="Paste a plan"
          >
            Paste
          </button>
          <div className="plan-picker-wrapper" ref={planPickerRef}>
            <button className="widget-header-action" onClick={handleOpenPlanPicker} title="Add existing plan">+</button>
            {showPlanPicker && (
              <div className="plan-picker-dropdown">
                {loadingAvailable ? (
                  <div className="plan-picker-empty">Loading...</div>
                ) : availablePlans.length > 0 ? (
                  availablePlans.map((plan) => (
                    <div key={plan.path} className="plan-picker-item" onClick={() => handleAddPlan(plan.path)}>
                      <span className="plan-picker-name">{plan.name}</span>
                      {plan.modifiedAt && <span className="plan-picker-date">{formatRelativeTime(plan.modifiedAt)}</span>}
                    </div>
                  ))
                ) : (
                  <div className="plan-picker-empty">No other plans available</div>
                )}
              </div>
            )}
          </div>
        </div>
      );
    }
    return null;
  }, [plans, showPastePlan, showPlanPicker, loadingAvailable, availablePlans, session?.promptHistory, handleOpenPlanPicker, handleAddPlan, fetchPlans]);

  // ─── Render Widget Content ──────────────────────────────────────

  const promptHistory = session?.promptHistory || [];
  const recentPrompts = [...promptHistory].reverse();

  const renderWidgetContent = useCallback((widgetId) => {
    switch (widgetId) {
      case 'notes':
        return <NotesWidget notes={notes} setNotes={setNotes} handleNotesBlur={handleNotesBlur} />;
      case 'prompts':
        return <PromptsWidget recentPrompts={recentPrompts} onShowModal={() => setShowPromptsModal(true)} />;
      case 'plans':
        return (
          <PlansWidget
            plans={plans} loadingPlans={loadingPlans}
            expandedPlanIndex={expandedPlanIndex} setExpandedPlanIndex={setExpandedPlanIndex}
            archivedPlanKeys={archivedPlanKeys} handleTogglePlanArchive={handleTogglePlanArchive}
            userCollapsedRef={userCollapsedRef}
            showPlanPicker={showPlanPicker} handleOpenPlanPicker={handleOpenPlanPicker}
            availablePlans={availablePlans} loadingAvailable={loadingAvailable}
            handleAddPlan={handleAddPlan} planPickerRef={planPickerRef}
            showPastePlan={showPastePlan} setShowPastePlan={setShowPastePlan}
            pastedPlanName={pastedPlanName} setPastedPlanName={setPastedPlanName}
            pastedPlanContent={pastedPlanContent} setPastedPlanContent={setPastedPlanContent}
            pastePlanError={pastePlanError} setPastePlanError={setPastePlanError}
            savingPlan={savingPlan} handleSavePastedPlan={handleSavePastedPlan}
            session={session}
          />
        );
      default:
        return null;
    }
  }, [notes, recentPrompts, plans, loadingPlans, expandedPlanIndex, archivedPlanKeys,
      showPlanPicker, availablePlans, loadingAvailable, showPastePlan, pastedPlanName,
      pastedPlanContent, pastePlanError, savingPlan, session, handleNotesBlur, handleOpenPlanPicker,
      handleAddPlan, handleSavePastedPlan, handleTogglePlanArchive]);

  // ─── Render ─────────────────────────────────────────────────────

  if (!session) {
    return (
      <div className="context-sidebar">
        <div className="context-sidebar-header">
          <h3>Context</h3>
          {!hideCloseButton && (
            <button className="sidebar-close-btn" onClick={onClose} title="Close (Ctrl+B)">&times;</button>
          )}
        </div>
        <div className="context-section">
          <p className="text-muted">Select a session to view context</p>
        </div>
      </div>
    );
  }

  return (
    <div className="context-sidebar" onClick={onFocus}>
      <div className="context-sidebar-header" style={{ position: 'relative' }}>
        <h3>Context</h3>
        <div className="context-header-meta">
          <span
            className="context-meta-role"
            title={session.role || 'No role — click to edit'}
            onClick={() => setIsEditingRole(true)}
          >
            {session.role ? (session.role.length > 20 ? session.role.slice(0, 20) + '…' : session.role) : 'No role'}
          </span>
          <div className="cli-type-selector">
            {[
              { value: 'claude', label: 'CC' },
              { value: 'codex', label: 'CDX' },
              { value: 'terminal', label: 'TRM' },
            ].map(({ value, label }) => (
              <button
                key={value}
                className={`cli-type-btn ${value}${session.cliType === value ? ' active' : ''}`}
                onClick={() => {
                  if (session.cliType !== value) onUpdateSession(session.id, { cliType: value });
                }}
              >
                {label}
              </button>
            ))}
          </div>
          <div className="context-meta-claude-wrap" ref={sessionPickerRef}>
            <span
              className="context-meta-claude"
              title={session.claudeSessionId || 'Not linked — click to link'}
              onClick={session.cliType === 'terminal' && !session.claudeSessionId ? handleGenerateClaudeSession : handleOpenSessionPicker}
            >
              {session.claudeSessionId ? session.claudeSessionId.slice(0, 8) + '..' : '—'}
            </span>
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
        </div>
        <div className="context-sidebar-header-actions">
          <div ref={widgetPickerRef} style={{ position: 'relative' }}>
            <button
              className="widget-picker-btn"
              onClick={() => setShowWidgetPicker(!showWidgetPicker)}
              title="Toggle widgets"
            >
              +
            </button>
            {showWidgetPicker && (
              <div className="widget-picker-dropdown">
                {registryIds.map(id => (
                  <label key={id} className="widget-picker-item">
                    <input
                      type="checkbox"
                      checked={isWidgetVisible(id)}
                      onChange={() => toggleWidget(id)}
                    />
                    {WIDGET_REGISTRY[id].title}
                  </label>
                ))}
                <div className="widget-picker-divider" />
                <button className="widget-picker-reset" onClick={resetLayout}>
                  Reset Layout
                </button>
              </div>
            )}
          </div>
          {!hideCloseButton && (
            <button className="sidebar-close-btn" onClick={onClose} title="Close (Ctrl+B)">&times;</button>
          )}
        </div>
      </div>

      {/* Role editing (expandable below header) */}
      {isEditingRole && (
        <div className="context-role-edit-row">
          <textarea
            className="context-notes"
            value={roleDraft}
            onChange={(e) => setRoleDraft(e.target.value)}
            rows={3}
            placeholder="Optional role/system prompt"
            autoFocus
          />
          <div className="role-edit-actions">
            <button className="claude-session-link-btn" onClick={handleSaveRole}>Save</button>
            <button className="claude-session-link-btn" onClick={() => { setRoleDraft(session?.role || ''); setIsEditingRole(false); }}>Cancel</button>
          </div>
        </div>
      )}

      {agent && (
        <div className="claude-session-row role-row">
          <span className="claude-session-label">Agent:</span>
          <span className="claude-session-id" title={agent.id}>
            {agent.name} ({agent.cliType})
          </span>
          <span className="claude-session-id" title="Skills">
            {(agent.skills || []).join(', ') || 'No skills'}
          </span>
          <span className="claude-session-id" title="Session history">
            history: {(agent.sessionHistory || []).length}
          </span>
        </div>
      )}

      {/* Widget Container */}
      <div className="widget-container" ref={widgetContainerRef}>
        {layout.rows.map((row, rowIdx) => (
          <Fragment key={`row-${rowIdx}`}>
            {rowIdx > 0 && (
              <ResizeHandle
                direction="horizontal"
                onResize={delta => handleRowResize(rowIdx - 1, delta)}
                onResizeEnd={handleResizeEnd}
                onDoubleClick={resetLayout}
              />
            )}
            <div
              className={`widget-row${
                dropTarget?.rowIdx === rowIdx && dropTarget?.position === 'above' ? ' drop-target-above' : ''
              }${
                dropTarget?.rowIdx === rowIdx && dropTarget?.position === 'below' ? ' drop-target-below' : ''
              }`}
              style={{ flex: row.ratio }}
            >
              {row.widgets.map((widgetId, colIdx) => (
                <Fragment key={widgetId}>
                  {colIdx > 0 && (
                    <ResizeHandle
                      direction="vertical"
                      onResize={delta => handleColResize(rowIdx, colIdx - 1, delta)}
                      onResizeEnd={handleResizeEnd}
                      onDoubleClick={() => resetColRatios(rowIdx)}
                    />
                  )}
                  <div
                    className={`widget${
                      draggedWidget === widgetId ? ' dragging' : ''
                    }${
                      dropTarget?.rowIdx === rowIdx && dropTarget?.colIdx === colIdx && dropTarget?.position === 'left' ? ' drop-target-left' : ''
                    }${
                      dropTarget?.rowIdx === rowIdx && dropTarget?.colIdx === colIdx && dropTarget?.position === 'right' ? ' drop-target-right' : ''
                    }`}
                    style={{ flex: row.colRatios[colIdx] }}
                    onDragOver={e => handleDragOver(e, rowIdx, colIdx)}
                    onDragLeave={handleDragLeave}
                    onDrop={e => handleDrop(e, rowIdx, colIdx)}
                  >
                    <div
                      className="widget-header"
                      draggable
                      onDragStart={e => handleDragStart(e, widgetId)}
                      onDragEnd={handleDragEnd}
                    >
                      <span className="widget-drag-handle">&#10495;</span>
                      <span className="widget-title">{WIDGET_REGISTRY[widgetId]?.title || widgetId}</span>
                      {getWidgetHeaderActions(widgetId)}
                    </div>
                    <div className="widget-content">
                      {renderWidgetContent(widgetId)}
                    </div>
                  </div>
                </Fragment>
              ))}
            </div>
          </Fragment>
        ))}
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

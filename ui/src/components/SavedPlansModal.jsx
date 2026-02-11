import { useState, useEffect } from 'react';
import PlanViewer from './PlanViewer';

function SavedPlansModal({ workingDir, dirName, onClose }) {
  const [plans, setPlans] = useState([]);
  const [loading, setLoading] = useState(true);
  const [expandedIndex, setExpandedIndex] = useState(null);
  const [deleteTarget, setDeleteTarget] = useState(null);

  const fetchPlans = async () => {
    setLoading(true);
    try {
      const response = await fetch(`/api/saved-plans?workingDir=${encodeURIComponent(workingDir)}`);
      if (response.ok) {
        const data = await response.json();
        setPlans(data.plans || []);
      }
    } catch (error) {
      console.error('Error fetching saved plans:', error);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchPlans();
  }, [workingDir]);

  const handleDelete = async (planPath) => {
    try {
      const response = await fetch(`/api/saved-plans?path=${encodeURIComponent(planPath)}`, {
        method: 'DELETE'
      });
      if (response.ok) {
        setPlans(prev => prev.filter(p => p.path !== planPath));
        setDeleteTarget(null);
        if (expandedIndex !== null) {
          setExpandedIndex(null);
        }
      }
    } catch (error) {
      console.error('Error deleting plan:', error);
    }
  };

  const openFolder = async () => {
    const plansDir = workingDir + '\\plans';
    await fetch('/api/open-path', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ filePath: plansDir })
    });
  };

  const openInEditor = async (planPath, e) => {
    e.stopPropagation();
    await fetch('/api/open-path', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ filePath: planPath })
    });
  };

  const formatDate = (dateStr) => {
    const date = new Date(dateStr);
    return date.toLocaleDateString('en-US', {
      month: 'short', day: 'numeric', year: 'numeric',
      hour: '2-digit', minute: '2-digit'
    });
  };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal saved-plans-modal" onClick={e => e.stopPropagation()}>
        <div className="modal-header">
          <div className="saved-plans-title-row">
            <h2>Saved Plans — {dirName}</h2>
            <button
              className="saved-plans-open-folder-btn"
              title="Open plans folder in Explorer"
              onClick={openFolder}
            >
              📁
            </button>
          </div>
          <button className="modal-close-btn" onClick={onClose}>✕</button>
        </div>

        <div className="saved-plans-body">
          {loading ? (
            <div className="saved-plans-empty">Loading...</div>
          ) : plans.length === 0 ? (
            <div className="saved-plans-empty">
              No saved plans yet. Use the Save button in the plan viewer to save plan versions here.
            </div>
          ) : (
            <div className="saved-plans-list">
              {plans.map((plan, index) => {
                const isExpanded = expandedIndex === index;
                return (
                  <div key={plan.path} className="saved-plan-item">
                    <div
                      className="saved-plan-header"
                      onClick={() => setExpandedIndex(isExpanded ? null : index)}
                    >
                      <span className="expand-icon">{isExpanded ? '\u25BC' : '\u25B6'}</span>
                      <div className="saved-plan-info">
                        <span className="saved-plan-name">{plan.name}</span>
                        <span className="saved-plan-filename">{plan.filename}</span>
                      </div>
                      <span className="saved-plan-date">{formatDate(plan.modifiedAt)}</span>
                      <button
                        className="saved-plan-open-btn"
                        title="Open in editor"
                        onClick={(e) => openInEditor(plan.path, e)}
                      >
                        📝
                      </button>
                      <button
                        className="saved-plan-delete-btn"
                        title="Delete saved plan"
                        onClick={(e) => {
                          e.stopPropagation();
                          setDeleteTarget(plan);
                        }}
                      >
                        ✕
                      </button>
                    </div>
                    {isExpanded && (
                      <div className="saved-plan-content">
                        <PlanViewer plan={plan} compact={true} />
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {deleteTarget && (
          <div className="modal-overlay" onClick={() => setDeleteTarget(null)}>
            <div className="modal" onClick={e => e.stopPropagation()}>
              <h2>Delete Saved Plan?</h2>
              <p className="settings-description">
                Delete <strong>{deleteTarget.name}</strong>? This cannot be undone.
              </p>
              <div className="modal-actions">
                <button className="btn btn-secondary" onClick={() => setDeleteTarget(null)}>
                  Cancel
                </button>
                <button className="btn btn-danger" onClick={() => handleDelete(deleteTarget.path)}>
                  Delete
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

export default SavedPlansModal;

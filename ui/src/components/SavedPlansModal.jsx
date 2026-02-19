import { useState, useEffect, useMemo } from 'react';
import PlanViewer from './PlanViewer';

function SavedPlansModal({ workingDir, dirName, onClose }) {
  const [plans, setPlans] = useState([]);
  const [commits, setCommits] = useState([]);
  const [isGitRepo, setIsGitRepo] = useState(false);
  const [loading, setLoading] = useState(true);
  const [expandedPlan, setExpandedPlan] = useState(null);
  const [expandedCommit, setExpandedCommit] = useState(null);
  const [deleteTarget, setDeleteTarget] = useState(null);
  const [copiedPath, setCopiedPath] = useState(null);
  const [copiedCommit, setCopiedCommit] = useState(null);

  const fetchData = async () => {
    setLoading(true);

    // Fetch plans and commits independently (one failure doesn't break the other)
    try {
      const response = await fetch(`/api/saved-plans?workingDir=${encodeURIComponent(workingDir)}`);
      if (response.ok) {
        const data = await response.json();
        setPlans(data.plans || []);
      }
    } catch (error) {
      console.error('Error fetching saved plans:', error);
    }

    try {
      const response = await fetch(`/api/git-commits?workingDir=${encodeURIComponent(workingDir)}&limit=20`);
      if (response.ok) {
        const data = await response.json();
        setCommits(data.commits || []);
        setIsGitRepo(data.isGitRepo !== false);
      }
    } catch (error) {
      console.error('Error fetching git commits:', error);
    }

    setLoading(false);
  };

  useEffect(() => {
    fetchData();
  }, [workingDir]);

  // Build merged timeline of plans and commits
  const timeline = useMemo(() => {
    const items = [];

    // Find latest commit date for uncommitted logic
    let latestCommitDate = -Infinity;
    for (const commit of commits) {
      const ts = new Date(commit.date).getTime();
      if (Number.isFinite(ts) && ts > latestCommitDate) {
        latestCommitDate = ts;
      }
    }

    for (const plan of plans) {
      const ts = new Date(plan.modifiedAt).getTime();
      const date = Number.isFinite(ts) ? ts : 0;
      const uncommitted = isGitRepo && commits.length > 0 && date > latestCommitDate;
      items.push({ type: 'plan', data: plan, date, uncommitted });
    }

    for (const commit of commits) {
      const ts = new Date(commit.date).getTime();
      const date = Number.isFinite(ts) ? ts : 0;
      items.push({ type: 'commit', data: commit, date, uncommitted: false });
    }

    items.sort((a, b) => b.date - a.date);
    return items;
  }, [plans, commits, isGitRepo]);

  const handleDelete = async (planPath) => {
    try {
      const response = await fetch(`/api/saved-plans?path=${encodeURIComponent(planPath)}`, {
        method: 'DELETE'
      });
      if (response.ok) {
        setPlans(prev => prev.filter(p => p.path !== planPath));
        setDeleteTarget(null);
        if (expandedPlan === planPath) {
          setExpandedPlan(null);
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

  const copyPath = async (planPath, e) => {
    e.stopPropagation();
    try {
      await navigator.clipboard.writeText(planPath);
      setCopiedPath(planPath);
      setTimeout(() => setCopiedPath(null), 1500);
    } catch {
      // Fallback for non-secure contexts
      const ta = document.createElement('textarea');
      ta.value = planPath;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      document.body.removeChild(ta);
      setCopiedPath(planPath);
      setTimeout(() => setCopiedPath(null), 1500);
    }
  };

  const copyText = async (text, key, e) => {
    if (e) e.stopPropagation();
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      document.body.removeChild(ta);
    }
    setCopiedCommit(key);
    setTimeout(() => setCopiedCommit(null), 1500);
  };

  const formatDate = (dateStr) => {
    const date = new Date(dateStr);
    return date.toLocaleDateString('en-US', {
      month: 'short', day: 'numeric', year: 'numeric',
      hour: '2-digit', minute: '2-digit'
    });
  };

  const formatEpoch = (epoch) => {
    const date = new Date(epoch);
    return date.toLocaleDateString('en-US', {
      month: 'short', day: 'numeric', year: 'numeric',
      hour: '2-digit', minute: '2-digit'
    });
  };

  const hasItems = plans.length > 0 || commits.length > 0;

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal saved-plans-modal" onClick={e => e.stopPropagation()}>
        <div className="modal-header">
          <div className="saved-plans-title-row">
            <h2>Saved Plans — {dirName}</h2>
            <button
              className="saved-plans-open-folder-btn"
              title="Refresh plans and commits"
              onClick={fetchData}
            >
              ↻
            </button>
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
          ) : !hasItems ? (
            <div className="saved-plans-empty">
              No saved plans yet. Use the Save button in the plan viewer to save plan versions here.
            </div>
          ) : (
            <div className="saved-plans-list">
              {timeline.map((item) => {
                if (item.type === 'commit') {
                  const commit = item.data;
                  const isCommitExpanded = expandedCommit === commit.fullHash;
                  const fullMessage = commit.body
                    ? commit.subject + '\n\n' + commit.body
                    : commit.subject;
                  return (
                    <div key={`commit-${commit.fullHash}`} className="git-commit-item">
                      <div
                        className="git-commit-divider"
                        onClick={() => setExpandedCommit(isCommitExpanded ? null : commit.fullHash)}
                      >
                        <span className="git-commit-line" />
                        <span className="git-commit-label">
                          <span className="git-commit-icon">&#9679;</span>
                          <span className="git-commit-hash">{commit.hash}</span>
                          <span className="git-commit-message">{commit.subject}</span>
                        </span>
                        <span className="git-commit-date">{formatEpoch(item.date)}</span>
                        <span className="git-commit-line" />
                      </div>
                      {isCommitExpanded && (
                        <div className="git-commit-body">
                          <div className="git-commit-body-actions">
                            <button
                              className="git-commit-copy-btn"
                              onClick={(e) => copyText(fullMessage, commit.fullHash, e)}
                              title="Copy full commit message"
                            >
                              {copiedCommit === commit.fullHash ? '\u2713 Copied' : '\uD83D\uDCCB Copy'}
                            </button>
                          </div>
                          <pre className="git-commit-body-text">{fullMessage}</pre>
                        </div>
                      )}
                    </div>
                  );
                }

                // Plan item
                const plan = item.data;
                const isExpanded = expandedPlan === plan.path;
                return (
                  <div key={plan.path} className="saved-plan-item">
                    <div
                      className="saved-plan-header"
                      onClick={() => setExpandedPlan(isExpanded ? null : plan.path)}
                    >
                      <span className="expand-icon">{isExpanded ? '\u25BC' : '\u25B6'}</span>
                      <div className="saved-plan-info">
                        <span className="saved-plan-name">
                          {plan.name}
                          {item.uncommitted && (
                            <span className="uncommitted-badge">uncommitted</span>
                          )}
                        </span>
                        <span className="saved-plan-filename">{plan.filename}</span>
                      </div>
                      <span className="saved-plan-date">{formatDate(plan.modifiedAt)}</span>
                      <button
                        className="saved-plan-copy-btn"
                        title={copiedPath === plan.path ? 'Copied!' : 'Copy file path'}
                        onClick={(e) => copyPath(plan.path, e)}
                      >
                        {copiedPath === plan.path ? '\u2713' : '\uD83D\uDCCB'}
                      </button>
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

import { useState, useEffect } from 'react';

const BASE_DIR = 'C:\\Users\\denni\\apps';

function NewSessionModal({ onClose, onCreate }) {
  const [name, setName] = useState('');
  const [cliType, setCliType] = useState('claude');
  const [folders, setFolders] = useState([]);
  const [starredFolders, setStarredFolders] = useState(() => {
    try {
      return JSON.parse(localStorage.getItem('starredFolders') || '[]');
    } catch {
      return [];
    }
  });
  const [selectedFolder, setSelectedFolder] = useState('');
  const [customPath, setCustomPath] = useState('');
  const [loading, setLoading] = useState(false);
  const [loadingFolders, setLoadingFolders] = useState(true);

  // Fetch folders from API on mount
  useEffect(() => {
    fetch(`/api/folders?base=${encodeURIComponent(BASE_DIR)}`)
      .then(res => res.json())
      .then(data => {
        setFolders(data.folders || []);
        setLoadingFolders(false);
      })
      .catch(err => {
        console.error('Failed to load folders:', err);
        setLoadingFolders(false);
      });
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

  const toggleStar = (folder, e) => {
    e.stopPropagation();
    const newStarred = starredFolders.includes(folder)
      ? starredFolders.filter(f => f !== folder)
      : [...starredFolders, folder];
    setStarredFolders(newStarred);
    localStorage.setItem('starredFolders', JSON.stringify(newStarred));
  };

  const handleSubmit = async (e) => {
    e.preventDefault();

    if (!name.trim()) {
      alert('Session name is required');
      return;
    }

    // Determine final working directory
    const workingDir = customPath.trim() ||
      (selectedFolder ? `${BASE_DIR}\\${selectedFolder}` : undefined);

    setLoading(true);
    try {
      await onCreate(name.trim(), workingDir, cliType);
    } finally {
      setLoading(false);
    }
  };

  const handleOverlayClick = (e) => {
    if (e.target === e.currentTarget) {
      onClose();
    }
  };

  // Sort folders: starred first, then alphabetical
  const sortedFolders = [...folders].sort((a, b) => {
    const aStarred = starredFolders.includes(a);
    const bStarred = starredFolders.includes(b);
    if (aStarred && !bStarred) return -1;
    if (!aStarred && bStarred) return 1;
    return a.localeCompare(b);
  });

  return (
    <div className="modal-overlay" onClick={handleOverlayClick}>
      <div className="modal modal-wide">
        <h2>New Session</h2>
        <form onSubmit={handleSubmit}>
          <div className="form-group">
            <label htmlFor="name">Session Name *</label>
            <input
              type="text"
              id="name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="My Session"
              autoFocus
              disabled={loading}
            />
          </div>

          <div className="form-group">
            <label htmlFor="cliType">CLI Type</label>
            <select
              id="cliType"
              value={cliType}
              onChange={(e) => setCliType(e.target.value)}
              disabled={loading}
              className="cli-select"
            >
              <option value="claude">Claude</option>
              <option value="codex">Codex (WSL)</option>
            </select>
          </div>

          <div className="form-group">
            <label>Working Directory</label>
            <div className="folder-selector">
              {loadingFolders ? (
                <div className="folder-loading">Loading folders...</div>
              ) : (
                <div className="folder-list">
                  {sortedFolders.map(folder => (
                    <div
                      key={folder}
                      className={`folder-option ${selectedFolder === folder ? 'selected' : ''} ${starredFolders.includes(folder) ? 'starred' : ''}`}
                      onClick={() => {
                        setSelectedFolder(folder);
                        setCustomPath('');
                      }}
                    >
                      <span className="folder-name">
                        {starredFolders.includes(folder) && <span className="star-icon">*</span>}
                        {folder}
                      </span>
                      <button
                        type="button"
                        className="star-btn"
                        onClick={(e) => toggleStar(folder, e)}
                        title={starredFolders.includes(folder) ? 'Unstar' : 'Star'}
                      >
                        {starredFolders.includes(folder) ? '*' : 'o'}
                      </button>
                    </div>
                  ))}
                </div>
              )}
              <input
                type="text"
                placeholder="Or type custom path..."
                value={customPath}
                onChange={(e) => {
                  setCustomPath(e.target.value);
                  if (e.target.value) setSelectedFolder('');
                }}
                disabled={loading}
                className="custom-path-input"
              />
            </div>
            {(selectedFolder || customPath) && (
              <div className="selected-path">
                Selected: {customPath || `${BASE_DIR}\\${selectedFolder}`}
              </div>
            )}
          </div>

          <div className="modal-actions">
            <button
              type="button"
              className="btn btn-secondary"
              onClick={onClose}
              disabled={loading}
            >
              Cancel
            </button>
            <button
              type="submit"
              className="btn btn-primary"
              disabled={loading}
            >
              {loading ? 'Creating...' : 'Create Session'}
            </button>
          </div>
        </form>
      </div>

      <style>{`
        .modal-wide {
          max-width: 500px;
          width: 90%;
        }
        .cli-select {
          width: 100%;
          padding: 8px 12px;
          font-size: 14px;
          border: 1px solid var(--border-color, #333);
          border-radius: 4px;
          background: var(--input-bg, #1a1a1a);
          color: var(--text-color, #fff);
        }
        .folder-selector {
          border: 1px solid var(--border-color, #333);
          border-radius: 4px;
          overflow: hidden;
        }
        .folder-list {
          max-height: 200px;
          overflow-y: auto;
        }
        .folder-option {
          display: flex;
          justify-content: space-between;
          align-items: center;
          padding: 8px 12px;
          cursor: pointer;
          border-bottom: 1px solid var(--border-color, #222);
        }
        .folder-option:hover {
          background: var(--hover-bg, #2a2a2a);
        }
        .folder-option.selected {
          background: var(--selected-bg, #1a3a5c);
        }
        .folder-option.starred .folder-name {
          font-weight: 500;
        }
        .folder-name {
          display: flex;
          align-items: center;
          gap: 6px;
        }
        .star-icon {
          color: #f5c518;
        }
        .star-btn {
          background: none;
          border: none;
          cursor: pointer;
          padding: 2px 6px;
          font-size: 12px;
          color: var(--text-muted, #888);
          border-radius: 3px;
        }
        .star-btn:hover {
          background: var(--hover-bg, #333);
          color: #f5c518;
        }
        .custom-path-input {
          width: 100%;
          padding: 10px 12px;
          border: none;
          border-top: 1px solid var(--border-color, #333);
          background: var(--input-bg, #1a1a1a);
          color: var(--text-color, #fff);
          font-size: 13px;
        }
        .custom-path-input:focus {
          outline: none;
          background: var(--input-focus-bg, #222);
        }
        .selected-path {
          margin-top: 8px;
          font-size: 12px;
          color: var(--text-muted, #888);
          word-break: break-all;
        }
        .folder-loading {
          padding: 20px;
          text-align: center;
          color: var(--text-muted, #888);
        }
      `}</style>
    </div>
  );
}

export default NewSessionModal;

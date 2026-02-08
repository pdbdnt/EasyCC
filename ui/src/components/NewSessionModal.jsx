import { useState, useEffect } from 'react';

const BASE_DIR = 'C:\\Users\\denni\\apps';

function generateDefaultSessionName() {
  const now = new Date();
  const date = now.toISOString().slice(0, 10);
  const time = now.toTimeString().slice(0, 5).replace(':', '');
  return `Session ${date}-${time}`;
}

function normalizeWindowsPath(input) {
  if (!input || typeof input !== 'string') return '';
  const normalized = input.replace(/\//g, '\\').trim();
  if (/^[A-Za-z]:\\?$/.test(normalized)) {
    return `${normalized[0].toUpperCase()}:\\`;
  }
  return normalized.replace(/\\+$/, '');
}

function joinWindowsPath(base, child) {
  const normalizedBase = normalizeWindowsPath(base);
  if (/^[A-Za-z]:\\$/.test(normalizedBase)) {
    return `${normalizedBase}${child}`;
  }
  return `${normalizedBase}\\${child}`;
}

function getParentWindowsPath(path) {
  const normalized = normalizeWindowsPath(path);
  if (!normalized) return '';
  if (/^[A-Za-z]:\\$/.test(normalized)) return normalized;

  const lastSeparator = normalized.lastIndexOf('\\');
  if (lastSeparator <= 2) {
    return `${normalized.slice(0, 1).toUpperCase()}:\\`;
  }
  return normalized.slice(0, lastSeparator);
}

function getBreadcrumbSegments(path) {
  const normalized = normalizeWindowsPath(path);
  if (!normalized) return [];

  const parts = normalized.replace(/\\$/, '').split('\\').filter(Boolean);
  if (parts.length === 0) return [];

  const segments = [];
  let current = parts[0].endsWith(':') ? `${parts[0]}\\` : `${parts[0]}\\`;
  segments.push({ label: parts[0], path: current });

  for (let i = 1; i < parts.length; i++) {
    current = joinWindowsPath(current, parts[i]);
    segments.push({ label: parts[i], path: current });
  }

  return segments;
}

function NewSessionModal({ onClose, onCreate, defaultWorkingDir = '' }) {
  const normalizedDefaultWorkingDir = normalizeWindowsPath(defaultWorkingDir);
  const [name, setName] = useState(() => generateDefaultSessionName());
  const [cliType, setCliType] = useState('claude');
  const [folders, setFolders] = useState([]);
  const [starredFolders, setStarredFolders] = useState(() => {
    try {
      const raw = JSON.parse(localStorage.getItem('starredFolders') || '[]');
      return Array.isArray(raw)
        ? raw.map(folder => (folder.includes('\\') ? folder : joinWindowsPath(BASE_DIR, folder)))
        : [];
    } catch {
      return [];
    }
  });
  const [selectedPath, setSelectedPath] = useState(() => normalizedDefaultWorkingDir);
  const [customPath, setCustomPath] = useState('');
  const [customPathConfirmed, setCustomPathConfirmed] = useState(false);
  const [currentBase, setCurrentBase] = useState(() => normalizedDefaultWorkingDir || BASE_DIR);
  const [browseRoot, setBrowseRoot] = useState(BASE_DIR);
  const [loading, setLoading] = useState(false);
  const [loadingFolders, setLoadingFolders] = useState(true);
  const [folderError, setFolderError] = useState('');

  // Fetch folders whenever browse base changes
  useEffect(() => {
    let cancelled = false;
    setLoadingFolders(true);
    setFolderError('');

    fetch(`/api/folders?base=${encodeURIComponent(currentBase)}`)
      .then(async (res) => {
        if (!res.ok) {
          const error = await res.json().catch(() => ({ error: 'Failed to load folders' }));
          throw new Error(error.error || 'Failed to load folders');
        }
        return res.json();
      })
      .then((data) => {
        if (cancelled) return;
        setFolders(data.folders || []);
        setBrowseRoot(normalizeWindowsPath(data.root || BASE_DIR));
        if (data.base) {
          setCurrentBase(normalizeWindowsPath(data.base));
        }
      })
      .catch((err) => {
        if (cancelled) return;
        console.error('Failed to load folders:', err);
        setFolderError(err.message || 'Failed to load folders');
        setFolders([]);
      })
      .finally(() => {
        if (!cancelled) {
          setLoadingFolders(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [currentBase]);

  // Initialize from focused session working directory when modal opens.
  useEffect(() => {
    if (!normalizedDefaultWorkingDir) return;
    setCurrentBase(normalizedDefaultWorkingDir);
    setSelectedPath(normalizedDefaultWorkingDir);
    setCustomPath('');
    setCustomPathConfirmed(false);
  }, [normalizedDefaultWorkingDir]);

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

  const toggleStar = (folderPath, e) => {
    e.stopPropagation();
    const newStarred = starredFolders.includes(folderPath)
      ? starredFolders.filter(f => f !== folderPath)
      : [...starredFolders, folderPath];
    setStarredFolders(newStarred);
    localStorage.setItem('starredFolders', JSON.stringify(newStarred));
  };

  const handleBrowseCustomPath = () => {
    const normalized = normalizeWindowsPath(customPath);
    if (!normalized) return;
    setCurrentBase(normalized);
    setSelectedPath('');
    setCustomPathConfirmed(true);
  };

  const handleGoUp = () => {
    const parent = getParentWindowsPath(currentBase);
    if (parent && normalizeWindowsPath(parent) !== normalizeWindowsPath(currentBase)) {
      setCurrentBase(parent);
    }
  };

  const handleSelectCurrentFolder = () => {
    setSelectedPath(currentBase);
    setCustomPath('');
    setCustomPathConfirmed(false);
  };

  const handleSubmit = async (e) => {
    e.preventDefault();

    // Determine final working directory.
    // Selected folder wins over custom text unless custom was explicitly confirmed via Browse.
    const normalizedSelectedPath = normalizeWindowsPath(selectedPath);
    const normalizedCustomPath = normalizeWindowsPath(customPath.trim());
    const workingDir = normalizedSelectedPath ||
      ((customPathConfirmed || !normalizedSelectedPath) ? normalizedCustomPath : '') ||
      undefined;

    setLoading(true);
    try {
      const finalName = name.trim() || generateDefaultSessionName();
      await onCreate(finalName, workingDir, cliType);
    } finally {
      setLoading(false);
    }
  };

  const handleOverlayClick = (e) => {
    if (e.target === e.currentTarget) {
      onClose();
    }
  };

  const atBrowseRoot = normalizeWindowsPath(currentBase).toLowerCase() === normalizeWindowsPath(browseRoot).toLowerCase();
  const breadcrumbSegments = getBreadcrumbSegments(currentBase);

  // Sort folders: starred first, then alphabetical
  const sortedFolders = [...folders].sort((a, b) => {
    const aPath = joinWindowsPath(currentBase, a);
    const bPath = joinWindowsPath(currentBase, b);
    const aStarred = starredFolders.includes(aPath);
    const bStarred = starredFolders.includes(bPath);
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
            <label htmlFor="name">Session Name</label>
            <input
              type="text"
              id="name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Auto-generated"
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
              <option value="terminal">Terminal (PowerShell)</option>
            </select>
          </div>

          <div className="form-group">
            <label>Working Directory</label>
            <div className="folder-selector">
              <div className="folder-browser-toolbar">
                <button
                  type="button"
                  className="btn btn-secondary btn-small folder-nav-btn"
                  onClick={handleGoUp}
                  disabled={loading || loadingFolders || atBrowseRoot}
                  title="Go to parent folder"
                >
                  Up
                </button>
                <div className="folder-breadcrumbs">
                  {breadcrumbSegments.map((segment, index) => (
                    <button
                      key={segment.path}
                      type="button"
                      className="breadcrumb-btn"
                      onClick={() => setCurrentBase(segment.path)}
                      disabled={loading || loadingFolders}
                    >
                      {segment.label}
                      {index < breadcrumbSegments.length - 1 ? ' >' : ''}
                    </button>
                  ))}
                </div>
                <button
                  type="button"
                  className="btn btn-primary btn-small"
                  onClick={handleSelectCurrentFolder}
                  disabled={loading || loadingFolders}
                >
                  Select This Folder
                </button>
              </div>

              {loadingFolders ? (
                <div className="folder-loading">Loading folders...</div>
              ) : folderError ? (
                <div className="folder-loading">{folderError}</div>
              ) : (
                <div className="folder-list">
                  {sortedFolders.length === 0 && (
                    <div className="folder-empty">No subfolders found</div>
                  )}
                  {sortedFolders.map(folder => (
                    (() => {
                      const folderPath = joinWindowsPath(currentBase, folder);
                      const isStarred = starredFolders.includes(folderPath);
                      return (
                    <div
                      key={folderPath}
                      className={`folder-option ${isStarred ? 'starred' : ''}`}
                      onClick={() => {
                        setCurrentBase(folderPath);
                        setCustomPath('');
                        setSelectedPath('');
                        setCustomPathConfirmed(false);
                      }}
                      title={`Browse ${folderPath}`}
                    >
                      <span className="folder-name">
                        {isStarred && <span className="star-icon">*</span>}
                        {folder}
                      </span>
                      <button
                        type="button"
                        className="star-btn"
                        onClick={(e) => toggleStar(folderPath, e)}
                        title={isStarred ? 'Unstar' : 'Star'}
                      >
                        {isStarred ? '*' : 'o'}
                      </button>
                    </div>
                      );
                    })()
                  ))}
                </div>
              )}
              <div className="custom-path-row">
                <input
                  type="text"
                  placeholder="Or type custom path..."
                  value={customPath}
                  onChange={(e) => {
                    setCustomPath(e.target.value);
                    if (e.target.value) {
                      setSelectedPath('');
                    }
                    setCustomPathConfirmed(false);
                  }}
                  disabled={loading}
                  className="custom-path-input"
                />
                <button
                  type="button"
                  className="btn btn-secondary browse-btn"
                  disabled={loading || !customPath.trim()}
                  onClick={handleBrowseCustomPath}
                >
                  Browse...
                </button>
              </div>
            </div>
            {(selectedPath || customPath) && (
              <div className="selected-path">
                Selected: {selectedPath || normalizeWindowsPath(customPath)}
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
        .folder-browser-toolbar {
          display: flex;
          align-items: center;
          gap: 8px;
          padding: 8px;
          border-bottom: 1px solid var(--border-color, #222);
          background: var(--bg-secondary, #141420);
        }
        .folder-nav-btn {
          min-width: 52px;
        }
        .folder-breadcrumbs {
          flex: 1;
          display: flex;
          flex-wrap: wrap;
          gap: 2px;
          min-width: 0;
        }
        .breadcrumb-btn {
          background: none;
          border: none;
          padding: 2px 4px;
          color: var(--text-muted, #888);
          font-size: 11px;
          cursor: pointer;
          white-space: nowrap;
        }
        .breadcrumb-btn:hover:not(:disabled) {
          color: var(--text-color, #fff);
          text-decoration: underline;
        }
        .breadcrumb-btn:disabled {
          cursor: default;
          opacity: 0.6;
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
          flex: 1;
          padding: 10px 12px;
          border: none;
          border-top: 1px solid var(--border-color, #333);
          background: var(--input-bg, #1a1a1a);
          color: var(--text-color, #fff);
          font-size: 13px;
        }
        .custom-path-row {
          display: flex;
          align-items: stretch;
          gap: 0;
          border-top: 1px solid var(--border-color, #333);
        }
        .browse-btn {
          border-radius: 0;
          border-left: 1px solid var(--border-color, #333);
          padding: 0 12px;
        }
        .folder-empty {
          padding: 14px;
          text-align: center;
          color: var(--text-muted, #888);
          font-size: 12px;
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

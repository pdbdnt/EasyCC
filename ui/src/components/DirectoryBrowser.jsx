import { useState, useEffect, useRef } from 'react';

// Fetched from server at runtime via /api/folders defaultRoot
export const BASE_DIR = null;

export function normalizeWindowsPath(input) {
  if (!input || typeof input !== 'string') return '';
  let normalized = input.trim().replace(/\//g, '\\');
  const isUnc = normalized.startsWith('\\\\');
  normalized = normalized.replace(/\\+/g, '\\');
  if (isUnc) normalized = `\\${normalized}`;
  if (/^[A-Za-z]:\\?$/.test(normalized)) {
    return `${normalized[0].toUpperCase()}:\\`;
  }
  if (/^\\\\[^\\]+\\[^\\]+\\?$/.test(normalized)) {
    return normalized.replace(/\\?$/, '');
  }
  return normalized.replace(/\\+$/, '');
}

export function joinWindowsPath(base, child) {
  const normalizedBase = normalizeWindowsPath(base);
  if (/^[A-Za-z]:\\$/.test(normalizedBase)) {
    return `${normalizedBase}${child}`;
  }
  return `${normalizedBase}\\${child}`;
}

export function getParentWindowsPath(path) {
  const normalized = normalizeWindowsPath(path);
  if (!normalized) return '';
  if (/^[A-Za-z]:\\$/.test(normalized)) return normalized;
  if (/^\\\\[^\\]+\\[^\\]+$/.test(normalized)) return normalized;

  const lastSeparator = normalized.lastIndexOf('\\');
  if (normalized.startsWith('\\\\')) {
    const rootMatch = normalized.match(/^\\\\[^\\]+\\[^\\]+/);
    if (rootMatch && lastSeparator <= rootMatch[0].length) return rootMatch[0];
  }
  if (lastSeparator <= 2) {
    return `${normalized.slice(0, 1).toUpperCase()}:\\`;
  }
  return normalized.slice(0, lastSeparator);
}

function getPathRoot(path) {
  const normalized = normalizeWindowsPath(path);
  if (/^[A-Za-z]:\\/.test(normalized)) return `${normalized[0].toUpperCase()}:\\`;
  const uncMatch = normalized.match(/^\\\\[^\\]+\\[^\\]+/);
  return uncMatch ? uncMatch[0] : '';
}

function getBreadcrumbSegments(path) {
  const normalized = normalizeWindowsPath(path);
  if (!normalized) return [];

  if (normalized.startsWith('\\\\')) {
    const root = getPathRoot(normalized);
    if (!root) return [];
    const rest = normalized.slice(root.length).replace(/^\\/, '');
    const parts = rest ? rest.split('\\').filter(Boolean) : [];
    const segments = [{ label: root, path: root }];
    let current = root;
    for (const part of parts) {
      current = joinWindowsPath(current, part);
      segments.push({ label: part, path: current });
    }
    return segments;
  }

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

function getRootIdForPath(path, roots) {
  const normalizedPath = normalizeWindowsPath(path).toLowerCase();
  if (!normalizedPath) return '';
  const match = roots.find(root => {
    const normalizedRoot = normalizeWindowsPath(root.path).toLowerCase();
    return normalizedPath === normalizedRoot || normalizedPath.startsWith(`${normalizedRoot}\\`);
  });
  return match?.id || '';
}

function getStarredMeta(path, roots) {
  const normalized = normalizeWindowsPath(path);
  const rootId = getRootIdForPath(normalized, roots);
  const root = roots.find(item => item.id === rootId);
  const source = root?.label || (normalized.startsWith('\\\\') ? 'WSL' : 'Windows');
  const rootPath = root ? normalizeWindowsPath(root.path) : '';
  const relative = rootPath && normalized.toLowerCase().startsWith(rootPath.toLowerCase())
    ? normalized.slice(rootPath.length).replace(/^\\/, '')
    : normalized.split('\\').filter(Boolean).slice(-2).join('\\');
  return { source, label: relative || normalized };
}

function DirectoryBrowser({
  selectedPath,
  onSelectPath,
  defaultBase,
  preferredRootId = '',
  disabled = false,
  starredFolders = [],
  onToggleStar
}) {
  const initialBase = defaultBase ? normalizeWindowsPath(defaultBase) : '';

  const [folders, setFolders] = useState([]);
  const [roots, setRoots] = useState([]);
  const [activeRootId, setActiveRootId] = useState(preferredRootId || '');
  const [starredCollapsed, setStarredCollapsed] = useState(false);
  const [filterText, setFilterText] = useState('');
  const [customPath, setCustomPath] = useState('');
  const [customPathConfirmed, setCustomPathConfirmed] = useState(false);
  const [currentBase, setCurrentBase] = useState(initialBase);
  const [browseRoot, setBrowseRoot] = useState('');
  const [loadingFolders, setLoadingFolders] = useState(true);
  const [folderError, setFolderError] = useState('');
  const [refreshNonce, setRefreshNonce] = useState(0);
  const [showCreateFolder, setShowCreateFolder] = useState(false);
  const [newFolderName, setNewFolderName] = useState('');
  const [creatingFolder, setCreatingFolder] = useState(false);
  const clickTimerRef = useRef(null);

  useEffect(() => {
    let cancelled = false;
    setLoadingFolders(true);
    setFolderError('');

    const params = new URLSearchParams();
    if (currentBase) params.set('base', currentBase);
    if (!currentBase && activeRootId) params.set('rootId', activeRootId);
    const query = params.toString() ? `?${params.toString()}` : '';

    fetch(`/api/folders${query}`)
      .then(async (res) => {
        if (!res.ok) {
          const error = await res.json().catch(() => ({ error: 'Failed to load folders' }));
          throw new Error(error.error || 'Failed to load folders');
        }
        return res.json();
      })
      .then((data) => {
        if (cancelled) return;
        const nextRoots = (data.roots || []).map(root => ({ ...root, path: normalizeWindowsPath(root.path) }));
        setFolders(data.folders || []);
        setRoots(nextRoots);
        setActiveRootId(data.rootId || getRootIdForPath(data.base || data.root, nextRoots) || activeRootId);
        const serverRoot = normalizeWindowsPath(data.root || data.defaultRoot || '');
        setBrowseRoot(serverRoot);
        if (data.base) {
          setCurrentBase(normalizeWindowsPath(data.base));
        } else if (!currentBase && serverRoot) {
          setCurrentBase(serverRoot);
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
  }, [currentBase, activeRootId, refreshNonce]);

  useEffect(() => {
    if (!defaultBase) return;
    const normalized = normalizeWindowsPath(defaultBase);
    setCurrentBase(normalized);
    onSelectPath?.(normalized);
    setCustomPath('');
    setCustomPathConfirmed(false);
  }, [defaultBase]);

  useEffect(() => {
    if (!preferredRootId || roots.length === 0) return;
    if (activeRootId === preferredRootId) return;
    if (selectedPath) return;
    const root = roots.find(item => item.id === preferredRootId);
    if (!root) return;
    setActiveRootId(root.id);
    setCurrentBase(normalizeWindowsPath(root.path));
    setFilterText('');
  }, [preferredRootId, activeRootId, roots, selectedPath]);

  useEffect(() => {
    return () => {
      if (clickTimerRef.current) clearTimeout(clickTimerRef.current);
    };
  }, []);

  const toggleStar = (folderPath, e) => {
    e.stopPropagation();
    onToggleStar?.(folderPath);
  };

  const handleRootChange = (root) => {
    const nextPath = normalizeWindowsPath(root.path);
    setActiveRootId(root.id);
    setCurrentBase(nextPath);
    onSelectPath?.(nextPath);
    setCustomPath('');
    setCustomPathConfirmed(false);
    setFilterText('');
  };

  const selectPath = (path, browse = false) => {
    const normalized = normalizeWindowsPath(path);
    const rootId = getRootIdForPath(normalized, roots);
    if (rootId) setActiveRootId(rootId);
    if (browse) setCurrentBase(normalized);
    onSelectPath?.(normalized);
    setCustomPath('');
    setCustomPathConfirmed(false);
    setFilterText('');
  };

  const handleBrowseCustomPath = () => {
    const normalized = normalizeWindowsPath(customPath);
    if (!normalized) return;
    const rootId = getRootIdForPath(normalized, roots);
    if (rootId) setActiveRootId(rootId);
    setCurrentBase(normalized);
    onSelectPath?.('');
    setCustomPathConfirmed(true);
    setFilterText('');
  };

  const handleGoUp = () => {
    const parent = getParentWindowsPath(currentBase);
    if (parent && normalizeWindowsPath(parent) !== normalizeWindowsPath(currentBase)) {
      setCurrentBase(parent);
      setFilterText('');
    }
  };

  const handleSelectCurrentFolder = () => {
    onSelectPath?.(currentBase);
    setCustomPath('');
    setCustomPathConfirmed(false);
  };

  const handleRefresh = () => {
    setFolderError('');
    setRefreshNonce(value => value + 1);
  };

  const handleCreateFolder = async (e) => {
    e?.preventDefault();
    const trimmedName = newFolderName.trim();
    if (!trimmedName || creatingFolder) return;

    setCreatingFolder(true);
    setFolderError('');
    try {
      const response = await fetch('/api/folders', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          base: currentBase,
          rootId: activeRootId,
          name: trimmedName
        })
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(data.error || 'Failed to create folder');
      }

      const createdPath = normalizeWindowsPath(data.path);
      setNewFolderName('');
      setShowCreateFolder(false);
      setCurrentBase(createdPath);
      onSelectPath?.(createdPath);
      setCustomPath('');
      setCustomPathConfirmed(false);
      setFilterText('');
      setRefreshNonce(value => value + 1);
    } catch (error) {
      setFolderError(error.message || 'Failed to create folder');
    } finally {
      setCreatingFolder(false);
    }
  };

  const atBrowseRoot = normalizeWindowsPath(currentBase).toLowerCase() === normalizeWindowsPath(browseRoot).toLowerCase();
  const breadcrumbSegments = getBreadcrumbSegments(currentBase);

  const sortedFolders = [...folders].sort((a, b) => {
    const aPath = joinWindowsPath(currentBase, a);
    const bPath = joinWindowsPath(currentBase, b);
    const aStarred = starredFolders.includes(aPath);
    const bStarred = starredFolders.includes(bPath);
    if (aStarred && !bStarred) return -1;
    if (!aStarred && bStarred) return 1;
    return a.localeCompare(b);
  });

  const filteredFolders = filterText
    ? sortedFolders.filter(folder => folder.toLowerCase().includes(filterText.toLowerCase()))
    : sortedFolders;

  return (
    <div className="folder-selector">
      <div className="folder-browser-toolbar">
        <button
          type="button"
          className="btn btn-secondary btn-small folder-nav-btn"
          onClick={handleGoUp}
          disabled={disabled || loadingFolders || creatingFolder || atBrowseRoot}
          title="Go to parent folder"
        >
          Up
        </button>
        <button
          type="button"
          className="btn btn-secondary btn-small folder-icon-btn"
          onClick={handleRefresh}
          disabled={disabled || loadingFolders || creatingFolder}
          title="Refresh folders"
          aria-label="Refresh folders"
        >
          ↻
        </button>
        <button
          type="button"
          className="btn btn-secondary btn-small folder-icon-btn"
          onClick={() => {
            setShowCreateFolder(value => !value);
            setFolderError('');
          }}
          disabled={disabled || loadingFolders || creatingFolder || !currentBase}
          title="Create folder"
          aria-label="Create folder"
        >
          <svg
            className="folder-toolbar-icon"
            viewBox="0 0 24 24"
            aria-hidden="true"
            focusable="false"
          >
            <path d="M3 6.75A2.75 2.75 0 0 1 5.75 4h4.1c.73 0 1.43.29 1.95.81l1.39 1.39c.23.23.55.36.88.36h4.18A2.75 2.75 0 0 1 21 9.31v6.94A2.75 2.75 0 0 1 18.25 19H5.75A2.75 2.75 0 0 1 3 16.25v-9.5Zm2.75-1.25c-.69 0-1.25.56-1.25 1.25v9.5c0 .69.56 1.25 1.25 1.25h12.5c.69 0 1.25-.56 1.25-1.25V9.31c0-.69-.56-1.25-1.25-1.25h-4.18c-.73 0-1.43-.29-1.95-.81l-1.39-1.39a1.25 1.25 0 0 0-.88-.36h-4.1Z" />
            <path d="M12 10.25c.41 0 .75.34.75.75v1.75h1.75a.75.75 0 0 1 0 1.5h-1.75V16a.75.75 0 0 1-1.5 0v-1.75H9.5a.75.75 0 0 1 0-1.5h1.75V11c0-.41.34-.75.75-.75Z" />
          </svg>
        </button>
        {roots.length > 1 && (
          <div className="folder-root-switch" role="group" aria-label="Browse source">
            {roots.map(root => (
              <button
                key={root.id}
                type="button"
                className={`folder-root-btn ${activeRootId === root.id ? 'active' : ''}`}
                onClick={() => handleRootChange(root)}
                disabled={disabled || loadingFolders || creatingFolder}
                title={`Browse ${root.label}`}
              >
                {root.label}
              </button>
            ))}
          </div>
        )}
        <div className="folder-breadcrumbs">
          {breadcrumbSegments.map((segment, index) => (
            <button
              key={segment.path}
              type="button"
              className="breadcrumb-btn"
              onClick={() => selectPath(segment.path, true)}
              disabled={disabled || loadingFolders || creatingFolder}
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
          disabled={disabled || loadingFolders || creatingFolder}
        >
          Select This Folder
        </button>
      </div>

      {showCreateFolder && (
        <div className="folder-create-row">
          <input
            type="text"
            className="folder-create-input"
            value={newFolderName}
            onChange={(e) => setNewFolderName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                handleCreateFolder(e);
              }
            }}
            placeholder="New folder name"
            disabled={disabled || creatingFolder}
            autoFocus
          />
          <button
            type="button"
            className="btn btn-primary btn-small"
            onClick={handleCreateFolder}
            disabled={disabled || creatingFolder || !newFolderName.trim()}
          >
            {creatingFolder ? 'Creating...' : 'Create'}
          </button>
          <button
            type="button"
            className="btn btn-secondary btn-small folder-icon-btn"
            onClick={() => {
              setShowCreateFolder(false);
              setNewFolderName('');
              setFolderError('');
            }}
            disabled={disabled || creatingFolder}
            title="Cancel"
            aria-label="Cancel folder creation"
          >
            x
          </button>
        </div>
      )}

      {loadingFolders ? (
        <div className="folder-loading">Loading folders...</div>
      ) : folderError ? (
        <div className="folder-loading">{folderError}</div>
      ) : (
        <div className="folder-list">
          {sortedFolders.length > 0 && (
            <input
              type="text"
              className="folder-filter-input"
              placeholder="Filter folders..."
              value={filterText}
              onChange={(e) => setFilterText(e.target.value)}
              disabled={disabled}
              autoFocus
            />
          )}
          {starredFolders.length > 0 && (
            <div className="starred-section">
              <div
                className="starred-section-header"
                onClick={() => setStarredCollapsed(!starredCollapsed)}
              >
                <span className="starred-chevron">{starredCollapsed ? '>' : 'v'}</span>
                <span>Starred Folders ({starredFolders.length})</span>
              </div>
              {!starredCollapsed && starredFolders.map(starPath => {
                const normalized = normalizeWindowsPath(starPath);
                const meta = getStarredMeta(normalized, roots);
                const isSelected = normalizeWindowsPath(selectedPath).toLowerCase() === normalized.toLowerCase();
                return (
                  <div
                    key={normalized}
                    className={`starred-folder-item ${isSelected ? 'selected' : ''}`}
                    onClick={() => {
                      if (clickTimerRef.current) clearTimeout(clickTimerRef.current);
                      clickTimerRef.current = setTimeout(() => {
                        selectPath(normalized, true);
                      }, 250);
                    }}
                    onDoubleClick={() => {
                      if (clickTimerRef.current) clearTimeout(clickTimerRef.current);
                      selectPath(normalized, true);
                    }}
                    title={normalized}
                  >
                    <span className="folder-name">
                      <span className="star-icon">*</span>
                      <span className="folder-source-label">{meta.source}</span>
                      {meta.label}
                    </span>
                    <button
                      type="button"
                      className="star-btn"
                      onClick={(e) => toggleStar(normalized, e)}
                      title="Unstar"
                    >
                      *
                    </button>
                  </div>
                );
              })}
              <div className="starred-separator" />
            </div>
          )}
          {filteredFolders.length === 0 && (
            <div className="folder-empty">{filterText ? 'No matching folders' : 'No subfolders found'}</div>
          )}
          {filteredFolders.map(folder => {
            const folderPath = joinWindowsPath(currentBase, folder);
            const isStarred = starredFolders.includes(folderPath);
            const isSelected = normalizeWindowsPath(selectedPath).toLowerCase() === normalizeWindowsPath(folderPath).toLowerCase();
            return (
              <div
                key={folderPath}
                className={`folder-option ${isStarred ? 'starred' : ''} ${isSelected ? 'selected' : ''}`}
                onClick={() => {
                  if (clickTimerRef.current) clearTimeout(clickTimerRef.current);
                  clickTimerRef.current = setTimeout(() => {
                    selectPath(folderPath, false);
                  }, 250);
                }}
                onDoubleClick={() => {
                  if (clickTimerRef.current) clearTimeout(clickTimerRef.current);
                  selectPath(folderPath, true);
                }}
                title="Click to select, double-click to browse"
              >
                <span className="folder-name">
                  {isStarred && <span className="star-icon">*</span>}
                  {folder}
                </span>
                <span className="folder-actions">
                  <button
                    type="button"
                    className="folder-browse-btn"
                    onClick={(e) => {
                      e.stopPropagation();
                      if (clickTimerRef.current) clearTimeout(clickTimerRef.current);
                      selectPath(folderPath, true);
                    }}
                    title={`Browse into ${folder}`}
                  >
                    &gt;
                  </button>
                  <button
                    type="button"
                    className="star-btn"
                    onClick={(e) => toggleStar(folderPath, e)}
                    title={isStarred ? 'Unstar' : 'Star'}
                  >
                    {isStarred ? '*' : 'o'}
                  </button>
                </span>
              </div>
            );
          })}
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
              onSelectPath?.('');
            }
            setCustomPathConfirmed(false);
          }}
          disabled={disabled}
          className="custom-path-input"
        />
        <button
          type="button"
          className="btn btn-secondary browse-btn"
          disabled={disabled || !customPath.trim()}
          onClick={handleBrowseCustomPath}
        >
          Browse...
        </button>
      </div>
      {(selectedPath || customPath) && (
        <div className="selected-path">
          Selected: {selectedPath || normalizeWindowsPath(customPath)}
        </div>
      )}
    </div>
  );
}

export default DirectoryBrowser;

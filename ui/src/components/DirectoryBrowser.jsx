import { useState, useEffect, useRef } from 'react';

// Fetched from server at runtime via /api/folders defaultRoot
export const BASE_DIR = null;

export function normalizeWindowsPath(input) {
  if (!input || typeof input !== 'string') return '';
  const normalized = input.replace(/\//g, '\\').trim();
  if (/^[A-Za-z]:\\?$/.test(normalized)) {
    return `${normalized[0].toUpperCase()}:\\`;
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

function DirectoryBrowser({ selectedPath, onSelectPath, defaultBase, disabled = false }) {
  const initialBase = defaultBase ? normalizeWindowsPath(defaultBase) : '';

  const [folders, setFolders] = useState([]);
  const [starredFolders, setStarredFolders] = useState(() => {
    try {
      const raw = JSON.parse(localStorage.getItem('starredFolders') || '[]');
      return Array.isArray(raw) ? raw.filter(f => typeof f === 'string') : [];
    } catch {
      return [];
    }
  });
  const [filterText, setFilterText] = useState('');
  const [customPath, setCustomPath] = useState('');
  const [customPathConfirmed, setCustomPathConfirmed] = useState(false);
  const [currentBase, setCurrentBase] = useState(initialBase);
  const [browseRoot, setBrowseRoot] = useState('');
  const [loadingFolders, setLoadingFolders] = useState(true);
  const [folderError, setFolderError] = useState('');
  const clickTimerRef = useRef(null);

  // Fetch folders whenever browse base changes
  useEffect(() => {
    let cancelled = false;
    setLoadingFolders(true);
    setFolderError('');

    const query = currentBase ? `?base=${encodeURIComponent(currentBase)}` : '';
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
        setFolders(data.folders || []);
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
  }, [currentBase]);

  // Update currentBase when defaultBase changes
  useEffect(() => {
    if (!defaultBase) return;
    const normalized = normalizeWindowsPath(defaultBase);
    setCurrentBase(normalized);
    onSelectPath?.(normalized);
    setCustomPath('');
    setCustomPathConfirmed(false);
  }, [defaultBase]);

  // Cleanup click timer on unmount
  useEffect(() => {
    return () => {
      if (clickTimerRef.current) clearTimeout(clickTimerRef.current);
    };
  }, []);

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
          disabled={disabled || loadingFolders || atBrowseRoot}
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
              onClick={() => { setCurrentBase(segment.path); setFilterText(''); }}
              disabled={disabled || loadingFolders}
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
          disabled={disabled || loadingFolders}
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
                    onSelectPath?.(folderPath);
                    setCustomPath('');
                    setCustomPathConfirmed(false);
                  }, 250);
                }}
                onDoubleClick={() => {
                  if (clickTimerRef.current) clearTimeout(clickTimerRef.current);
                  setCurrentBase(folderPath);
                  setCustomPath('');
                  onSelectPath?.('');
                  setCustomPathConfirmed(false);
                  setFilterText('');
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
                      setCurrentBase(folderPath);
                      setCustomPath('');
                      onSelectPath?.('');
                      setCustomPathConfirmed(false);
                      setFilterText('');
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

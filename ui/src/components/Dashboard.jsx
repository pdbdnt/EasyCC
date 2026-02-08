import { useMemo, useEffect, useState } from 'react';
import SessionCard from './SessionCard';
import HintBadge from './HintBadge';

// Extract the bottom-level directory name from a path
function getDirectoryName(path) {
  if (!path) return 'Unknown';
  const normalized = path.replace(/\\/g, '/').replace(/\/$/, '');
  const parts = normalized.split('/');
  return parts[parts.length - 1] || 'Unknown';
}

/**
 * Generate unique hint letter for a directory name, avoiding collisions
 * @param {string} dirName - Directory name
 * @param {Set<string>} usedLetters - Already used letters
 * @returns {string} Single letter hint prefix
 */
function getHintLetter(dirName, usedLetters) {
  const name = dirName.toLowerCase();
  // Try each character in the directory name
  for (let i = 0; i < name.length; i++) {
    const char = name[i];
    // Only use alphanumeric characters
    if (/[a-z0-9]/.test(char) && !usedLetters.has(char)) {
      usedLetters.add(char);
      return char;
    }
  }
  // Fallback: find first unused letter
  for (let code = 97; code <= 122; code++) { // a-z
    const char = String.fromCharCode(code);
    if (!usedLetters.has(char)) {
      usedLetters.add(char);
      return char;
    }
  }
  // Ultimate fallback: use number
  for (let i = 0; i <= 9; i++) {
    const char = i.toString();
    if (!usedLetters.has(char)) {
      usedLetters.add(char);
      return char;
    }
  }
  return 'x';
}

function Dashboard({
  sessions,
  selectedId,
  onSelectSession,
  onNewSession,
  onShowDetails,
  onOpenSettings,
  onUpdateSession,
  onKillSession,
  connectionStatus,
  hintModeActive = false,
  typedChars = '',
  hintCodes = {},
  onGroupedSessionsChange
}) {
  const [collapsedGroups, setCollapsedGroups] = useState(() => new Set());
  const [killGroupTarget, setKillGroupTarget] = useState(null); // { dirName, sessionIds }

  // Get hint codes from settings or use defaults
  const newSessionHint = hintCodes.newSession || 'ns';
  const settingsHint = hintCodes.settings || 'st';

  // Group sessions by their working directory with directory-based hint codes
  const groupedSessions = useMemo(() => {
    const groups = new Map();

    sessions.forEach((session, index) => {
      const dirName = getDirectoryName(session.workingDir);
      if (!groups.has(dirName)) {
        groups.set(dirName, []);
      }
      groups.get(dirName).push({ session, globalIndex: index });
    });

    // Within each group, show Claude sessions first and Codex sessions last.
    for (const [, sessionsInGroup] of groups) {
      sessionsInGroup.sort((a, b) => {
        const aCodex = a.session.cliType === 'codex' ? 1 : 0;
        const bCodex = b.session.cliType === 'codex' ? 1 : 0;
        if (aCodex !== bCodex) {
          return aCodex - bCodex;
        }
        return a.globalIndex - b.globalIndex;
      });
    }

    // Sort groups alphabetically (first gets priority for letter)
    const sortedGroups = Array.from(groups.entries()).sort((a, b) => a[0].localeCompare(b[0]));

    // Assign unique hint letters to each group
    const usedLetters = new Set();
    const groupsWithHints = sortedGroups.map(([dirName, sessionsInGroup]) => {
      const hintLetter = getHintLetter(dirName, usedLetters);
      // Assign hint codes to sessions within group
      const sessionsWithHints = sessionsInGroup.map((item, indexInGroup) => ({
        ...item,
        hintCode: `${hintLetter}${indexInGroup + 1}`
      }));
      return [dirName, sessionsWithHints, hintLetter];
    });

    return groupsWithHints;
  }, [sessions]);

  // Notify parent about grouped sessions for navigation
  useEffect(() => {
    if (onGroupedSessionsChange) {
      onGroupedSessionsChange(groupedSessions);
    }
  }, [groupedSessions, onGroupedSessionsChange]);

  // Keep collapse state in sync with active groups
  useEffect(() => {
    setCollapsedGroups((prev) => {
      const activeGroupNames = new Set(groupedSessions.map(([dirName]) => dirName));
      const next = new Set();
      for (const dirName of prev) {
        if (activeGroupNames.has(dirName)) {
          next.add(dirName);
        }
      }
      return next.size === prev.size ? prev : next;
    });
  }, [groupedSessions]);

  // Ensure selected session remains visible
  useEffect(() => {
    if (!selectedId) return;
    const selectedGroup = groupedSessions.find(([, sessionsInGroup]) =>
      sessionsInGroup.some(({ session }) => session.id === selectedId)
    );
    if (!selectedGroup) return;
    const [dirName] = selectedGroup;
    setCollapsedGroups((prev) => {
      if (!prev.has(dirName)) return prev;
      const next = new Set(prev);
      next.delete(dirName);
      return next;
    });
  }, [groupedSessions, selectedId]);

  const toggleGroupCollapsed = (dirName) => {
    setCollapsedGroups((prev) => {
      const next = new Set(prev);
      if (next.has(dirName)) {
        next.delete(dirName);
      } else {
        next.add(dirName);
      }
      return next;
    });
  };

  return (
    <>
      <div className="sidebar-header">
        <h1>Claude Manager</h1>
        <div className="sidebar-header-actions">
          <button className="settings-btn" onClick={onOpenSettings} title="Settings">
            <HintBadge
              code={settingsHint}
              visible={hintModeActive}
              position="top-right"
              action={onOpenSettings}
              typedChars={typedChars}
            />
            ⚙️
          </button>
          <button className="btn btn-primary btn-small" onClick={onNewSession}>
            <HintBadge
              code={newSessionHint}
              visible={hintModeActive}
              position="top-left"
              action={onNewSession}
              typedChars={typedChars}
            />
            + New
          </button>
        </div>
      </div>
      <div className="sessions-list">
        {sessions.length === 0 ? (
          <div className="empty-state">
            <div className="empty-state-icon">📭</div>
            <p>No active sessions</p>
            <p>Create one to get started</p>
          </div>
        ) : (
          groupedSessions.map(([dirName, sessionsInGroup, hintLetter]) => (
            <div key={dirName} className="session-group">
              <button
                type="button"
                className="session-group-header"
                onClick={() => toggleGroupCollapsed(dirName)}
                aria-expanded={!collapsedGroups.has(dirName)}
                aria-label={`${collapsedGroups.has(dirName) ? 'Expand' : 'Collapse'} ${dirName} (${sessionsInGroup.length} sessions)`}
              >
                <span className={`session-group-chevron ${collapsedGroups.has(dirName) ? 'collapsed' : ''}`}>▾</span>
                <span className="session-group-icon">📁</span>
                <span className="session-group-name">{dirName}</span>
                <span className="session-group-count">{sessionsInGroup.length}</span>
                {hintModeActive && (
                  <span className="session-group-hint">{hintLetter}</span>
                )}
                {onKillSession && (
                  <button
                    className="group-kill-btn"
                    title={`Kill all sessions in ${dirName}`}
                    onClick={(e) => {
                      e.stopPropagation();
                      setKillGroupTarget({
                        dirName,
                        sessionIds: sessionsInGroup.map(s => s.session.id)
                      });
                    }}
                  >
                    ✕
                  </button>
                )}
              </button>
              {!collapsedGroups.has(dirName) && sessionsInGroup.map(({ session, globalIndex, hintCode }) => (
                <SessionCard
                  key={session.id}
                  session={session}
                  index={globalIndex}
                  isSelected={session.id === selectedId}
                  onSelect={() => onSelectSession(session.id)}
                  onShowDetails={onShowDetails}
                  onUpdate={onUpdateSession}
                  hintModeActive={hintModeActive}
                  typedChars={typedChars}
                  hintCode={hintCode}
                />
              ))}
            </div>
          ))
        )}
      </div>
      <div className={`connection-status ${connectionStatus}`}>
        <span className={`status-indicator ${connectionStatus === 'connected' ? 'active' : 'idle'}`} />
        {connectionStatus === 'connected' ? 'Connected' :
         connectionStatus === 'connecting' ? 'Connecting...' :
         'Disconnected'}
      </div>
      {killGroupTarget && (
        <div className="modal-overlay" onClick={() => setKillGroupTarget(null)}>
          <div className="modal" onClick={e => e.stopPropagation()}>
            <h2>Kill All Sessions?</h2>
            <p className="settings-description">
              This will kill <strong>{killGroupTarget.sessionIds.length}</strong> session{killGroupTarget.sessionIds.length > 1 ? 's' : ''} in <strong>{killGroupTarget.dirName}</strong>.
            </p>
            <div className="modal-actions">
              <button className="btn btn-secondary" onClick={() => setKillGroupTarget(null)}>
                Cancel
              </button>
              <button
                className="btn btn-danger"
                onClick={async () => {
                  for (const id of killGroupTarget.sessionIds) {
                    await onKillSession(id, { skipConfirm: true });
                  }
                  setKillGroupTarget(null);
                }}
              >
                Kill {killGroupTarget.sessionIds.length} Session{killGroupTarget.sessionIds.length > 1 ? 's' : ''}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

export default Dashboard;

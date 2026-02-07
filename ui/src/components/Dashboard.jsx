import { useMemo, useEffect } from 'react';
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
  connectionStatus,
  hintModeActive = false,
  typedChars = '',
  hintCodes = {},
  onGroupedSessionsChange
}) {
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
              <div className="session-group-header">
                <span className="session-group-icon">📁</span>
                <span className="session-group-name">{dirName}</span>
                <span className="session-group-count">{sessionsInGroup.length}</span>
                {hintModeActive && (
                  <span className="session-group-hint">{hintLetter}</span>
                )}
              </div>
              {sessionsInGroup.map(({ session, globalIndex, hintCode }) => (
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
    </>
  );
}

export default Dashboard;

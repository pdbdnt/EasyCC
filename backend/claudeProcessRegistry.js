const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Claude Code keeps one `<pid>.json` per running process in ~/.claude/sessions,
 * holding the conversation ID that process is on right now (it is rewritten
 * after /clear and /resume). This is the exact identity source for a PTY.
 */
function getClaudeSessionsDir(homeDir = os.homedir()) {
  return path.join(homeDir, '.claude', 'sessions');
}

function isClaudeSessionId(value) {
  return typeof value === 'string' && UUID_PATTERN.test(value);
}

function readClaudeProcessEntry(pid, { sessionsDir = getClaudeSessionsDir(), fsRef = fs } = {}) {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  try {
    const entry = JSON.parse(fsRef.readFileSync(path.join(sessionsDir, `${pid}.json`), 'utf8'));
    if (!entry || entry.pid !== pid || !isClaudeSessionId(entry.sessionId)) return null;
    return entry;
  } catch {
    // Missing or mid-write file: the caller retries on the next registry change.
    return null;
  }
}

function listProcessParents({ platform = process.platform, execFileRef = execFile } = {}) {
  const [command, args] = platform === 'win32'
    ? ['powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
        'Get-CimInstance Win32_Process | ForEach-Object { "$($_.ProcessId) $($_.ParentProcessId)" }']]
    : ['ps', ['-eo', 'pid=,ppid=']];
  return new Promise((resolve) => {
    execFileRef(command, args, { windowsHide: true, timeout: 15000, maxBuffer: 4 * 1024 * 1024 }, (error, stdout) => {
      const parents = new Map();
      if (!error) {
        for (const line of String(stdout).split(/\r?\n/)) {
          const match = line.trim().match(/^(\d+)\s+(\d+)$/);
          if (match) parents.set(Number(match[1]), Number(match[2]));
        }
      }
      resolve(parents);
    });
  });
}

/**
 * Find the Claude process running inside a PTY: the PTY root itself, or its
 * nearest descendant that has a registry entry (on Windows the root is cmd.exe).
 * @returns {Promise<number|null>}
 */
async function findClaudePidForPty(rootPid, options = {}) {
  if (!Number.isInteger(rootPid) || rootPid <= 0) return null;
  if (readClaudeProcessEntry(rootPid, options)) return rootPid;

  const parents = await (options.listProcessParents || listProcessParents)(options);
  const children = new Map();
  for (const [pid, parentPid] of parents) {
    if (!children.has(parentPid)) children.set(parentPid, []);
    children.get(parentPid).push(pid);
  }

  const visited = new Set([rootPid]);
  let level = [rootPid];
  while (level.length > 0) {
    const next = [];
    for (const pid of level) {
      for (const child of children.get(pid) || []) {
        if (visited.has(child)) continue;
        visited.add(child);
        if (readClaudeProcessEntry(child, options)) return child;
        next.push(child);
      }
    }
    level = next;
  }
  return null;
}

module.exports = {
  getClaudeSessionsDir,
  isClaudeSessionId,
  readClaudeProcessEntry,
  findClaudePidForPty
};

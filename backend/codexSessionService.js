const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DEFAULT_SCAN_INTERVAL_MS = 2000;
const DEFAULT_COMMAND_TIMEOUT_MS = 10000;
const DEFAULT_WSL_RETRY_DELAY_MS = 150;
const DEFAULT_HISTORY_CACHE_TTL_MS = 60_000;
const DEFAULT_CONTEXT_CACHE_TTL_MS = 60_000;
const DEFAULT_PROCESS_CACHE_TTL_MS = 2_000;
const DEFAULT_HISTORY_PAGE_SIZE = 100;
const DEFAULT_EMPTY_HISTORY_RETRY_DELAY_MS = 250;
const GROUP_SORTS = new Set(['recent', 'oldest', 'folder-asc', 'folder-desc', 'count-desc', 'count-asc']);
const THREAD_SORTS = new Set(['updated-desc', 'updated-asc', 'created-desc', 'created-asc', 'title-asc', 'title-desc']);
const dateFormatters = new Map();

function quoteForPosixShell(value = '') {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

function normalizePath(value) {
  return String(value || '').trim().replace(/\\/g, '/').replace(/\/$/, '');
}

function windowsPathToWsl(value) {
  const normalized = normalizePath(value);
  const uncMatch = normalized.match(/^\/\/wsl(?:\$|\.localhost)?\/[^/]+(\/.*)?$/i);
  if (uncMatch) return uncMatch[1] || '/';
  const driveMatch = normalized.match(/^([a-z]):(\/.*)?$/i);
  if (driveMatch) return `/mnt/${driveMatch[1].toLowerCase()}${driveMatch[2] || ''}`;
  return normalized;
}

function comparablePath(value) {
  const normalized = normalizePath(windowsPathToWsl(value));
  return /^\/mnt\/[a-z](?:\/|$)/i.test(normalized)
    ? normalized.toLowerCase()
    : normalized;
}

function pathsEqual(left, right) {
  const normalizedLeft = comparablePath(left);
  const normalizedRight = comparablePath(right);
  return !!normalizedLeft && normalizedLeft === normalizedRight;
}

function decodeBase64(value) {
  try {
    return Buffer.from(value || '', 'base64').toString('utf8');
  } catch {
    return '';
  }
}

function encodeCursor(payload) {
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
}

function decodeCursor(cursor) {
  if (!cursor) return null;
  try {
    const value = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
    return /^\d{4}-\d{2}-\d{2}$/.test(value?.beforeDate || '') ? value : null;
  } catch {
    return null;
  }
}

function decodeSortedCursor(cursor, signature) {
  if (!cursor) return 0;
  try {
    const value = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
    return value?.v === 2 && value.signature === signature && Number.isInteger(value.offset) && value.offset >= 0
      ? value.offset
      : 0;
  } catch {
    return 0;
  }
}

function compareText(left, right) {
  return String(left || '').localeCompare(String(right || ''), undefined, { sensitivity: 'base', numeric: true });
}

function compareTimestamp(left, right, direction = 'desc') {
  const leftTime = Date.parse(left || '');
  const rightTime = Date.parse(right || '');
  const leftValid = Number.isFinite(leftTime);
  const rightValid = Number.isFinite(rightTime);
  if (leftValid !== rightValid) return leftValid ? -1 : 1;
  if (!leftValid) return 0;
  return direction === 'asc' ? leftTime - rightTime : rightTime - leftTime;
}

function compareThreads(left, right, sort = 'updated-desc') {
  let result = 0;
  if (sort === 'updated-asc') result = compareTimestamp(left.lastActivity, right.lastActivity, 'asc');
  else if (sort === 'created-desc') result = compareTimestamp(left.createdAt, right.createdAt, 'desc');
  else if (sort === 'created-asc') result = compareTimestamp(left.createdAt, right.createdAt, 'asc');
  else if (sort === 'title-asc') result = compareText(left.threadName, right.threadName);
  else if (sort === 'title-desc') result = compareText(right.threadName, left.threadName);
  else result = compareTimestamp(left.lastActivity, right.lastActivity, 'desc');
  return result || left.id.localeCompare(right.id);
}

function compareGroups(left, right, sort = 'recent') {
  let result = 0;
  if (sort === 'oldest') result = compareTimestamp(left.lastActivity, right.lastActivity, 'asc');
  else if (sort === 'folder-asc') result = compareText(left.name, right.name) || compareText(left.path, right.path);
  else if (sort === 'folder-desc') result = compareText(right.name, left.name) || compareText(right.path, left.path);
  else if (sort === 'count-desc') result = right.count - left.count;
  else if (sort === 'count-asc') result = left.count - right.count;
  else result = compareTimestamp(left.lastActivity, right.lastActivity, 'desc');
  return result || comparablePath(left.key).localeCompare(comparablePath(right.key));
}

function normalizePreview(value, maxCodePoints = 160) {
  const clean = String(value || '')
    .replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, '')
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const points = Array.from(clean);
  return points.length > maxCodePoints
    ? `${points.slice(0, maxCodePoints - 1).join('')}…`
    : clean;
}

function getLocalDate(value, timeZone = 'UTC') {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return null;
  let zone = timeZone || 'UTC';
  let formatter = dateFormatters.get(zone);
  if (!formatter) {
    try {
      formatter = new Intl.DateTimeFormat('en-CA', {
        timeZone: zone,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit'
      });
    } catch {
      zone = 'UTC';
      formatter = dateFormatters.get(zone) || new Intl.DateTimeFormat('en-CA', {
        timeZone: zone,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit'
      });
    }
    dateFormatters.set(zone, formatter);
  }
  const parts = formatter.formatToParts(date);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function buildProcessScanProbe() {
  return String.raw`
const fs = require('fs');
const path = require('path');
const root = String(process.argv[1] || '').replace(/\/$/, '');

for (const pid of fs.readdirSync('/proc').filter((value) => /^\d+$/.test(value))) {
  const proc = '/proc/' + pid;
  let command = '';
  try {
    command = fs.readFileSync(proc + '/cmdline', 'utf8');
  } catch {
    continue;
  }
  if (!command.includes('/codex')) continue;

  let easyccSessionId = '';
  try {
    for (const entry of fs.readFileSync(proc + '/environ', 'utf8').split('\0')) {
      if (entry.startsWith('EASYCC_SESSION_ID=')) easyccSessionId = entry.slice(18);
    }
  } catch {}

  let descriptors = [];
  try {
    descriptors = fs.readdirSync(proc + '/fd');
  } catch {
    continue;
  }

  const seen = new Set();
  for (const descriptor of descriptors) {
    let file;
    try {
      file = fs.readlinkSync(proc + '/fd/' + descriptor);
    } catch {
      continue;
    }
    if (!file.startsWith(root + '/sessions/') || !file.endsWith('.jsonl') || seen.has(file)) continue;
    seen.add(file);

    let handle;
    try {
      handle = fs.openSync(file, 'r');
      const buffer = Buffer.alloc(262144);
      const size = fs.readSync(handle, buffer, 0, buffer.length, 0);
      fs.closeSync(handle);
      handle = undefined;
      const line = buffer.subarray(0, size).toString('utf8').split('\n', 1)[0];
      const record = JSON.parse(line);
      const payload = record.payload || {};
      console.log(JSON.stringify({
        pid: Number(pid),
        sid: easyccSessionId,
        file,
        payload: {
          id: payload.id,
          session_id: payload.session_id,
          cwd: payload.cwd,
          source: typeof payload.source === 'string' ? payload.source : null,
          thread_source: payload.thread_source
        }
      }));
    } catch {
      if (handle !== undefined) {
        try { fs.closeSync(handle); } catch {}
      }
    }
  }
}
`;
}

class CodexSessionService {
  constructor(options = {}) {
    this.platform = options.platform || process.platform;
    this.commandRunner = options.commandRunner || null;
    this.execFile = options.execFile || execFile;
    this.fs = options.fs || fs;
    this.clock = options.clock || (() => Date.now());
    this.commandTimeoutMs = options.commandTimeoutMs || DEFAULT_COMMAND_TIMEOUT_MS;
    this.wslRetryDelayMs = options.wslRetryDelayMs ?? DEFAULT_WSL_RETRY_DELAY_MS;
    this.scanIntervalMs = options.scanIntervalMs || DEFAULT_SCAN_INTERVAL_MS;
    this.codexHomeOverride = options.codexHome !== undefined
      ? options.codexHome
      : (process.env.CODEX_HOME || null);
    this.shellCodexHome = null;
    this.monitorTimer = null;
    this.monitorHooks = null;
    this.stableRoots = new Map();
    this.repoContextResolved = new Set();
    this.scanFailureCount = 0;
    this.scanRunning = false;
    this.scanQueued = false;
    this.shuttingDown = false;
    this.historyCacheTtlMs = options.historyCacheTtlMs ?? DEFAULT_HISTORY_CACHE_TTL_MS;
    this.contextCacheTtlMs = options.contextCacheTtlMs ?? DEFAULT_CONTEXT_CACHE_TTL_MS;
    this.processCacheTtlMs = options.processCacheTtlMs ?? DEFAULT_PROCESS_CACHE_TTL_MS;
    this.emptyHistoryRetryDelayMs = options.emptyHistoryRetryDelayMs ?? DEFAULT_EMPTY_HISTORY_RETRY_DELAY_MS;
    this.historyCache = null;
    this.historyLoadPromise = null;
    this.contextCache = new Map();
    this.previewCache = new Map();
    this.processCache = null;
    this.processLoadPromise = null;
  }

  resolveShellCodexHome() {
    if (this.shellCodexHome) return this.shellCodexHome;
    if (!this.codexHomeOverride) {
      this.shellCodexHome = this.platform === 'win32'
        ? '$HOME/.codex'
        : path.join(os.homedir(), '.codex');
      return this.shellCodexHome;
    }

    const override = String(this.codexHomeOverride);
    if (this.platform === 'win32' && !override.startsWith('/')) {
      this.shellCodexHome = windowsPathToWsl(override);
    } else {
      this.shellCodexHome = normalizePath(override);
    }
    return this.shellCodexHome;
  }

  getRootAssignment() {
    const root = this.resolveShellCodexHome();
    return root === '$HOME/.codex'
      ? 'codex_root="$HOME/.codex";'
      : `codex_root=${quoteForPosixShell(root)};`;
  }

  async runShell(command) {
    if (this.commandRunner) {
      return String(await this.commandRunner(command) || '');
    }
    const executable = this.platform === 'win32' ? 'wsl.exe' : '/bin/bash';
    const args = this.platform === 'win32'
      ? ['--exec', 'bash', '--noprofile', '--norc', '-lc', command]
      : ['-lc', command];
    const attempts = this.platform === 'win32' ? 2 : 1;
    let attemptsMade = 0;
    let lastError = null;

    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      attemptsMade = attempt;
      try {
        return await new Promise((resolve, reject) => {
          this.execFile(executable, args, {
            encoding: 'utf8',
            timeout: this.commandTimeoutMs,
            windowsHide: true,
            maxBuffer: 32 * 1024 * 1024
          }, (error, stdout) => {
            if (error) {
              reject(error);
              return;
            }
            resolve(String(stdout || ''));
          });
        });
      } catch (error) {
        lastError = error;
        if (attempt < attempts && error?.code !== 'ENOENT') {
          await new Promise((resolve) => setTimeout(resolve, this.wslRetryDelayMs));
          continue;
        }
      }
    }

    const code = lastError?.code || 'unknown';
    const signal = lastError?.signal || 'none';
    console.error(`[CodexSessionService] shell helper failed after ${attemptsMade} attempt${attemptsMade === 1 ? '' : 's'} (code=${code}, signal=${signal})`);
    const publicError = new Error(this.platform === 'win32'
      ? 'Could not read Codex data from WSL. Please retry.'
      : 'Could not read Codex data. Please retry.');
    publicError.code = lastError?.code || 'CODEX_SHELL_FAILED';
    publicError.cause = lastError;
    throw publicError;
  }

  async loadIndex() {
    const output = await this.runShell(`${this.getRootAssignment()} cat "$codex_root/session_index.jsonl" 2>/dev/null || true`);
    const byId = new Map();
    let order = 0;
    for (const line of output.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const entry = JSON.parse(trimmed);
        const id = String(entry.id || '').toLowerCase();
        if (!UUID_PATTERN.test(id)) continue;
        const updatedAtMs = Date.parse(entry.updated_at || '') || 0;
        const candidate = {
          id,
          threadName: typeof entry.thread_name === 'string' ? entry.thread_name.trim() : '',
          updatedAt: updatedAtMs ? new Date(updatedAtMs).toISOString() : null,
          updatedAtMs,
          order: order += 1
        };
        const current = byId.get(id);
        if (!current || candidate.updatedAtMs > current.updatedAtMs ||
          (candidate.updatedAtMs === current.updatedAtMs && candidate.order > current.order)) {
          byId.set(id, candidate);
        }
      } catch {
        // Ignore malformed append-only index rows.
      }
    }
    return byId;
  }

  async scanRolloutMetadata() {
    const probe = [
      "const fs=require('fs'),path=require('path');",
      'const root=path.join(process.argv[1],\'sessions\');',
      'const stack=[root];',
      'while(stack.length){const dir=stack.pop();let entries=[];try{entries=fs.readdirSync(dir,{withFileTypes:true})}catch{continue}',
      'for(const entry of entries){const file=path.join(dir,entry.name);if(entry.isDirectory()){stack.push(file);continue}',
      "if(!entry.isFile()||!/^rollout-.*\\.jsonl$/.test(entry.name))continue;",
      'let fd;try{fd=fs.openSync(file,\'r\');const buffer=Buffer.alloc(262144);const size=fs.readSync(fd,buffer,0,buffer.length,0);',
      "const line=buffer.subarray(0,size).toString('utf8').split('\\n',1)[0];const record=JSON.parse(line);const p=record.payload||{};",
      'const stat=fs.fstatSync(fd);console.log(JSON.stringify({file,modifiedAtMs:stat.mtimeMs,timestamp:record.timestamp,payload:{id:p.id,session_id:p.session_id,timestamp:p.timestamp,cwd:p.cwd,source:typeof p.source===\'string\'?p.source:null,thread_source:p.thread_source}}));fs.closeSync(fd);fd=undefined;',
      '}catch{if(fd!==undefined)try{fs.closeSync(fd)}catch{}}}}'
    ].join('');
    const command = `${this.getRootAssignment()} node -e ${quoteForPosixShell(probe)} "$codex_root"`;
    const output = await this.runShell(command);
    const byId = new Map();
    for (const line of output.split('\n')) {
      if (!line.trim()) continue;
      try {
        const record = JSON.parse(line);
        const payload = record.payload || {};
        const filePath = record.file;
        const id = String(payload.id || payload.session_id || '').toLowerCase();
        const fileId = path.basename(filePath).match(/([0-9a-f-]{36})\.jsonl$/i)?.[1]?.toLowerCase();
        const isRootUser = payload.thread_source === 'user' ||
          (payload.thread_source == null && payload.source === 'cli');
        if (!UUID_PATTERN.test(id) || id !== fileId || !payload.cwd || !isRootUser) continue;
        const createdAtMs = Date.parse(payload.timestamp || record.timestamp || '') || 0;
        const modifiedAtMs = Number(record.modifiedAtMs || 0);
        byId.set(id, {
          id,
          filePath,
          workingDir: normalizePath(payload.cwd),
          createdAt: createdAtMs ? new Date(createdAtMs).toISOString() : null,
          createdAtMs,
          modifiedAtMs
        });
      } catch {
        // Ignore malformed or partially written rollouts.
      }
    }
    return byId;
  }

  async resolveRepoContexts(workingDirs) {
    const unique = [...new Set((workingDirs || []).map(normalizePath).filter(Boolean))];
    if (unique.length === 0) return new Map();
    const now = this.clock();
    const contexts = new Map();
    const missing = [];
    for (const cwd of unique) {
      const cached = this.contextCache.get(cwd);
      if (cached && now - cached.loadedAt < this.contextCacheTtlMs) {
        contexts.set(cwd, cached.context);
      } else {
        missing.push(cwd);
      }
    }
    if (missing.length === 0) return contexts;

    const cases = missing.map((cwd) => {
      const cwd64 = Buffer.from(cwd, 'utf8').toString('base64');
      return [
        `cwd=${quoteForPosixShell(cwd)};`,
        `cwd64=${quoteForPosixShell(cwd64)};`,
        'root=$(git -C "$cwd" rev-parse --show-toplevel 2>/dev/null || true);',
        'branch=$(git -C "$cwd" rev-parse --abbrev-ref HEAD 2>/dev/null || true);',
        'root64=$(printf %s "$root" | base64 | tr -d "\\r\\n");',
        'branch64=$(printf %s "$branch" | base64 | tr -d "\\r\\n");',
        'printf "%s\\t%s\\t%s\\n" "$cwd64" "$root64" "$branch64";'
      ].join(' ');
    }).join(' ');
    const output = await this.runShell(cases);
    for (const line of output.split('\n')) {
      const [cwd64, root64, branch64] = line.split('\t');
      const cwd = normalizePath(decodeBase64(cwd64));
      if (!cwd) continue;
      const repoRoot = normalizePath(decodeBase64(root64)) || null;
      const gitBranch = decodeBase64(branch64).trim() || null;
      const context = {
        repoRoot,
        repoName: repoRoot ? path.posix.basename(repoRoot) : null,
        gitBranch,
        groupKey: repoRoot || cwd
      };
      contexts.set(cwd, context);
      this.contextCache.set(cwd, { context, loadedAt: this.clock() });
    }
    for (const cwd of missing) {
      if (!contexts.has(cwd)) {
        const context = { repoRoot: null, repoName: null, gitBranch: null, groupKey: cwd };
        contexts.set(cwd, context);
        this.contextCache.set(cwd, { context, loadedAt: this.clock() });
      }
    }
    return contexts;
  }

  async readPreviews(items) {
    if (!Array.isArray(items) || items.length === 0) return new Map();
    const previews = new Map();
    const missing = [];
    for (const item of items) {
      const cached = this.previewCache.get(item.filePath);
      if (cached && cached.modifiedAtMs === Number(item.modifiedAtMs || 0)) {
        previews.set(item.id, cached.preview);
      } else {
        missing.push(item);
      }
    }
    if (missing.length === 0) return previews;

    const probe = [
      "const fs=require('fs'),path=require('path');",
      'for(const file of process.argv.slice(1)){let fd;try{fd=fs.openSync(file,\'r\');const stat=fs.fstatSync(fd);const size=Math.min(stat.size,2097152);const buffer=Buffer.alloc(size);fs.readSync(fd,buffer,0,size,Math.max(0,stat.size-size));fs.closeSync(fd);fd=undefined;',
      "const lines=buffer.toString('utf8').split('\\n');let message='';for(let i=lines.length-1;i>=0;i--){try{const r=JSON.parse(lines[i]);if(r&&r.type==='event_msg'&&r.payload&&r.payload.type==='user_message'){message=String(r.payload.message||'');break}}catch{}}",
      "const id=path.basename(file).match(/([0-9a-f-]{36})\\.jsonl$/i)?.[1]||'';console.log(id+'\\t'+Buffer.from(message).toString('base64'));",
      '}catch{if(fd!==undefined)try{fs.closeSync(fd)}catch{}}}'
    ].join('');
    const args = missing.map((item) => quoteForPosixShell(item.filePath)).join(' ');
    const output = await this.runShell(`node -e ${quoteForPosixShell(probe)} ${args}`);
    for (const line of output.split('\n')) {
      const tab = line.indexOf('\t');
      if (tab < 0) continue;
      const id = line.slice(0, tab).toLowerCase();
      previews.set(id, normalizePreview(decodeBase64(line.slice(tab + 1))));
    }
    for (const item of missing) {
      const preview = previews.get(item.id) || '';
      previews.set(item.id, preview);
      this.previewCache.set(item.filePath, {
        modifiedAtMs: Number(item.modifiedAtMs || 0),
        preview
      });
    }
    return previews;
  }

  async scanProcesses() {
    if (this.platform === 'darwin') {
      const result = { roots: [], liveRootIds: new Set() };
      this.processCache = { result, loadedAt: this.clock() };
      return result;
    }
    const probe = buildProcessScanProbe();
    const output = await this.runShell(`${this.getRootAssignment()} node -e ${quoteForPosixShell(probe)} "$codex_root"`);
    const roots = [];
    for (const line of output.split('\n')) {
      if (!line.trim()) continue;
      try {
        const record = JSON.parse(line);
        const filePath = record.file;
        const payload = record.payload || {};
        const id = String(payload.id || payload.session_id || '').toLowerCase();
        const fileId = path.basename(filePath).match(/([0-9a-f-]{36})\.jsonl$/i)?.[1]?.toLowerCase();
        const isRootUser = payload.thread_source === 'user' ||
          (payload.thread_source == null && payload.source === 'cli');
        if (!UUID_PATTERN.test(id) || id !== fileId || !isRootUser) continue;
        roots.push({
          pid: Number(record.pid),
          easyccSessionId: record.sid || '',
          id,
          filePath,
          workingDir: normalizePath(payload.cwd)
        });
      } catch {
        // Process exited or FD changed during the scan.
      }
    }
    const result = {
      roots,
      liveRootIds: new Set(roots.map((root) => root.id))
    };
    this.processCache = { result, loadedAt: this.clock() };
    return result;
  }

  async getProcessSnapshot() {
    if (this.processCache && this.clock() - this.processCache.loadedAt < this.processCacheTtlMs) {
      return this.processCache.result;
    }
    if (this.processLoadPromise) return this.processLoadPromise;
    this.processLoadPromise = this.scanProcesses().finally(() => {
      this.processLoadPromise = null;
    });
    return this.processLoadPromise;
  }

  async loadHistorySnapshot() {
    if (this.historyLoadPromise) return this.historyLoadPromise;

    const scan = () => Promise.all([this.loadIndex(), this.scanRolloutMetadata()]);
    this.historyLoadPromise = scan()
      .then(async ([index, rollouts]) => {
        let nextIndex = index;
        let nextRollouts = rollouts;
        const joinedCount = () => [...nextRollouts.keys()].filter((id) => nextIndex.has(id)).length;
        if (this.platform === 'win32' && joinedCount() === 0 && this.emptyHistoryRetryDelayMs >= 0) {
          await new Promise((resolve) => setTimeout(resolve, this.emptyHistoryRetryDelayMs));
          [nextIndex, nextRollouts] = await scan();
        }
        this.historyCache = {
          index: nextIndex,
          rollouts: nextRollouts,
          loadedAt: this.clock(),
          empty: joinedCount() === 0
        };
        return this.historyCache;
      })
      .finally(() => {
        this.historyLoadPromise = null;
      });
    return this.historyLoadPromise;
  }

  async getHistorySnapshot({ force = false, allowStale = false } = {}) {
    const now = this.clock();
    if (!force && this.historyCache && now - this.historyCache.loadedAt < this.historyCacheTtlMs) {
      if (this.historyCache.empty) {
        if (allowStale) void this.loadHistorySnapshot().catch(() => {});
        return { ...this.historyCache, stale: true };
      }
      return { ...this.historyCache, stale: false };
    }
    if (!force && allowStale && this.historyCache) {
      void this.loadHistorySnapshot().catch((error) => {
        console.error(`[CodexSessionService] background history refresh failed: ${error.message}`);
      });
      return { ...this.historyCache, stale: true };
    }
    const snapshot = await this.loadHistorySnapshot();
    return { ...snapshot, stale: !!snapshot.empty };
  }

  warmHistoryCache() {
    void this.getHistorySnapshot({ force: true }).catch((error) => {
      console.error(`[CodexSessionService] history prewarm failed: ${error.message}`);
    });
  }

  invalidateHistoryCache() {
    this.historyCache = null;
  }

  async getThreadsByIds(ids, history = null) {
    const normalizedIds = [...new Set((ids || [])
      .map((id) => String(id || '').toLowerCase())
      .filter((id) => UUID_PATTERN.test(id)))];
    if (normalizedIds.length === 0) return new Map();
    const { index, rollouts } = history || await this.getHistorySnapshot();
    const selectedRollouts = normalizedIds
      .map((id) => rollouts.get(id))
      .filter(Boolean);
    const contexts = await this.resolveRepoContexts(selectedRollouts.map((rollout) => rollout.workingDir));
    const threads = new Map();
    for (const id of normalizedIds) {
      const rollout = rollouts.get(id);
      if (!rollout) continue;
      const indexEntry = index.get(id) || null;
      threads.set(id, {
        codexSessionId: id,
        threadName: indexEntry?.threadName || '',
        workingDir: rollout.workingDir,
        createdAt: rollout.createdAt,
        lastActivity: new Date(Math.max(indexEntry?.updatedAtMs || 0, rollout.modifiedAtMs || 0)).toISOString(),
        repoContext: contexts.get(rollout.workingDir) || {
          repoRoot: null,
          repoName: null,
          gitBranch: null,
          groupKey: rollout.workingDir
        }
      });
    }
    return threads;
  }

  async getThreadById(id) {
    const normalizedId = String(id || '').toLowerCase();
    return (await this.getThreadsByIds([normalizedId])).get(normalizedId) || null;
  }

  async getResumeCatalog({ sessions = [], groupKey = '', easyccSessionId = '', cursor = '', timeZone = 'UTC', query = '', refresh = false, groupBy = '', groupSort = '', threadSort = '' } = {}) {
    const [history, processState] = await Promise.all([
      this.getHistorySnapshot({ force: refresh, allowStale: !refresh }),
      this.getProcessSnapshot()
    ]);
    const { index, rollouts } = history;
    const sessionList = sessions instanceof Map ? [...sessions.values()] : sessions;
    const targetSession = easyccSessionId
      ? sessionList.find((session) => session?.id === easyccSessionId && session.cliType === 'codex' && session.status === 'paused') || null
      : null;
    const effectiveGroupKey = targetSession
      ? (targetSession.groupKey || targetSession.workingDir)
      : groupKey;
    const linkedById = new Map();
    for (const session of sessionList || []) {
      if (session?.codexSessionId) linkedById.set(String(session.codexSessionId).toLowerCase(), session);
    }

    const loweredQuery = String(query || '').trim().toLowerCase();
    let validated = [];
    for (const [id, rollout] of rollouts) {
      const indexEntry = index.get(id);
      if (!indexEntry) continue;
      const searchable = `${id}\n${indexEntry.threadName || ''}\n${rollout.workingDir}`.toLowerCase();
      if (loweredQuery && !searchable.includes(loweredQuery)) continue;
      const linked = linkedById.get(id) || null;
      const live = processState.liveRootIds.has(id);
      const activityMs = Math.max(indexEntry.updatedAtMs || 0, rollout.modifiedAtMs || 0, rollout.createdAtMs || 0);
      if (!activityMs) continue;
      validated.push({
        id,
        filePath: rollout.filePath,
        modifiedAtMs: rollout.modifiedAtMs,
        threadName: indexEntry.threadName || '',
        workingDir: rollout.workingDir,
        createdAt: rollout.createdAt,
        lastActivity: new Date(activityMs).toISOString(),
        localDate: getLocalDate(activityMs, timeZone),
        repoContext: null,
        linked,
        live
      });
    }

    if (targetSession) {
      validated = validated
        .filter((item) => pathsEqual(item.workingDir, targetSession.workingDir))
        .map((item) => ({
          ...item,
          repoContext: {
            repoRoot: targetSession.repoRoot || null,
            repoName: targetSession.repoName || null,
            gitBranch: targetSession.gitBranch || null,
            groupKey: effectiveGroupKey || targetSession.workingDir
          }
        }));
    } else if (effectiveGroupKey) {
      const scopedContexts = await this.resolveRepoContexts(validated.map((item) => item.workingDir));
      validated = validated
        .map((item) => ({
          ...item,
          repoContext: scopedContexts.get(item.workingDir) || { groupKey: item.workingDir }
        }))
        .filter((item) => pathsEqual(item.repoContext.groupKey, effectiveGroupKey));
    }

    const sortedMode = ['folder', 'none'].includes(groupBy) || GROUP_SORTS.has(groupSort) || THREAD_SORTS.has(threadSort);
    const normalizedGroupBy = groupBy === 'none' ? 'none' : 'folder';
    const normalizedGroupSort = GROUP_SORTS.has(groupSort) ? groupSort : 'recent';
    const normalizedThreadSort = THREAD_SORTS.has(threadSort) ? threadSort : 'updated-desc';
    const allContexts = effectiveGroupKey
      ? null
      : await this.resolveRepoContexts(validated.map((item) => item.workingDir));
    for (const item of validated) {
      if (!item.repoContext) {
        item.repoContext = allContexts.get(item.workingDir) || { groupKey: item.workingDir };
      }
    }
    const groupMap = new Map();
    for (const item of validated) {
      const key = item.repoContext.groupKey || item.workingDir;
      if (!groupMap.has(key)) {
        const repoName = item.repoContext.repoName || '';
        groupMap.set(key, {
          key,
          name: repoName || path.posix.basename(normalizePath(key)) || key,
          path: key,
          items: [],
          lastActivity: null,
          count: 0,
          selectableCount: 0,
          selectableSelections: []
        });
      }
      const group = groupMap.get(key);
      group.items.push(item);
      group.count += 1;
      if (compareTimestamp(group.lastActivity, item.lastActivity, 'desc') > 0 || !group.lastActivity) {
        group.lastActivity = item.lastActivity;
      }
    }
    let orderedItems;
    let orderedGroups = [...groupMap.values()];
    if (sortedMode) {
      for (const group of orderedGroups) group.items.sort((left, right) => compareThreads(left, right, normalizedThreadSort));
      orderedGroups.sort((left, right) => compareGroups(left, right, normalizedGroupSort));
      orderedItems = normalizedGroupBy === 'none'
        ? [...validated].sort((left, right) => compareThreads(left, right, normalizedThreadSort))
        : orderedGroups.flatMap((group) => group.items);
    } else {
      orderedItems = validated;
    }

    let pageItems;
    let pageDates;
    let nextCursor = null;
    let hasOlder = false;
    if (sortedMode) {
      const signature = `${normalizedGroupBy}:${normalizedGroupSort}:${normalizedThreadSort}:${loweredQuery}:${effectiveGroupKey || ''}`;
      const offset = decodeSortedCursor(cursor, signature);
      pageItems = orderedItems.slice(offset, offset + DEFAULT_HISTORY_PAGE_SIZE);
      pageDates = [...new Set(pageItems.map((item) => item.localDate).filter(Boolean))];
      hasOlder = offset + pageItems.length < orderedItems.length;
      nextCursor = hasOlder ? encodeCursor({ v: 2, signature, offset: offset + pageItems.length }) : null;
    } else {
      const cursorData = decodeCursor(cursor);
      const dates = [...new Set(validated.map((item) => item.localDate).filter(Boolean))]
        .filter((date) => !cursorData || date < cursorData.beforeDate)
        .sort((a, b) => b.localeCompare(a));
      pageDates = dates.slice(0, 2);
      pageItems = validated
        .filter((item) => pageDates.includes(item.localDate))
        .sort((a, b) => Date.parse(b.lastActivity) - Date.parse(a.lastActivity) || a.id.localeCompare(b.id));
      hasOlder = dates.length > pageDates.length;
      nextCursor = hasOlder && pageDates.length
        ? encodeCursor({ beforeDate: pageDates[pageDates.length - 1] })
        : null;
    }
    const previews = await this.readPreviews(pageItems);
    const threads = pageItems.map((item) => {
      let disabledReason = null;
      if (targetSession && item.linked && item.linked.id !== targetSession.id) {
        disabledReason = 'Already linked to another EasyCC card';
      } else if (item.linked && item.linked.status !== 'paused') disabledReason = 'Already open in EasyCC';
      else if (item.live) disabledReason = item.linked
        ? 'The linked conversation is still running'
        : 'Already open outside EasyCC';
      return {
        codexSessionId: item.id,
        threadName: item.threadName || `Codex ${item.id.slice(0, 8)}`,
        workingDir: item.workingDir,
        createdAt: item.createdAt,
        lastActivity: item.lastActivity,
        preview: previews.get(item.id) || '',
        groupKey: item.repoContext.groupKey,
        linkedEasyccSessionId: item.linked?.id || null,
        live: item.live,
        selectable: !disabledReason,
        disabledReason
      };
    });

    const threadById = new Map(threads.map((thread) => [thread.codexSessionId, thread]));
    for (const group of orderedGroups) {
      const selectableIds = [];
      for (const item of group.items) {
        const linked = item.linked;
        const disabled = (targetSession && linked && linked.id !== targetSession.id) ||
          (linked && linked.status !== 'paused') || item.live;
        if (!disabled) selectableIds.push(item.id);
      }
      group.selectableCount = selectableIds.length;
      group.selectableSelections = selectableIds.map((codexSessionId) => ({
        codexSessionId,
        easyccSessionId: linkedById.get(codexSessionId)?.status === 'paused'
          ? linkedById.get(codexSessionId).id
          : undefined
      }));
    }

    const savedSessions = (sessionList || [])
      .filter((session) => session?.cliType === 'codex' && session.status === 'paused')
      .filter((session) => targetSession
        ? session.id === targetSession.id
        : (!effectiveGroupKey || pathsEqual(session.groupKey || session.workingDir, effectiveGroupKey)))
      .map((session) => {
        const codexId = String(session.codexSessionId || '').toLowerCase();
        const thread = codexId ? rollouts.get(codexId) : null;
        const exact = !!thread && pathsEqual(thread.workingDir, session.workingDir);
        const live = exact && processState.liveRootIds.has(codexId);
        return {
          easyccSessionId: session.id,
          name: session.name,
          workingDir: session.workingDir,
          codexSessionId: exact ? codexId : null,
          mappingState: exact ? 'exact' : 'unresolved',
          selectedByDefault: exact && !live,
          selectable: exact && !live,
          disabledReason: live ? 'The linked conversation is still running' : null
        };
      });

    return {
      savedSessions,
      threads,
      groups: orderedGroups.map(({ items, ...group }) => ({
        ...group,
        loadedCount: items.filter((item) => threadById.has(item.id)).length
      })),
      sort: {
        groupBy: normalizedGroupBy,
        groupSort: normalizedGroupSort,
        threadSort: normalizedThreadSort
      },
      page: {
        dates: pageDates,
        nextCursor,
        hasOlder,
        total: orderedItems.length
      },
      cache: {
        historyStale: !!history.stale,
        historyEmpty: !!history.empty,
        generatedAt: new Date(history.loadedAt).toISOString(),
        diagnostics: {
          codexHome: this.resolveShellCodexHome(),
          indexCount: index.size,
          rolloutCount: rollouts.size,
          joinedCount: [...rollouts.keys()].filter((id) => index.has(id)).length
        }
      }
    };
  }

  startMonitor({ getSessions, onObservation }) {
    this.monitorHooks = { getSessions, onObservation };
    this.shuttingDown = false;
    this.kickMonitor();
  }

  kickMonitor() {
    if (!this.monitorHooks || this.shuttingDown) return;
    if (this.scanRunning) {
      this.scanQueued = true;
      return;
    }
    if (this.monitorTimer) clearTimeout(this.monitorTimer);
    this.monitorTimer = setTimeout(() => { void this.runMonitorScan(); }, 0);
  }

  async runMonitorScan() {
    if (!this.monitorHooks || this.shuttingDown || this.scanRunning) return;
    if (this.monitorTimer) {
      clearTimeout(this.monitorTimer);
      this.monitorTimer = null;
    }
    const sessions = [...(this.monitorHooks.getSessions()?.values?.() || [])];
    const liveSessions = sessions.filter((session) =>
      session?.cliType === 'codex' && session.pty && !['paused', 'completed', 'killed'].includes(session.status)
    );
    if (liveSessions.length === 0) {
      this.monitorTimer = null;
      return;
    }

    this.scanRunning = true;
    let delay = this.scanIntervalMs;
    try {
      const scan = await this.scanProcesses();
      if (!this.monitorHooks || this.shuttingDown) return;
      this.scanFailureCount = 0;
      const countsByRoot = new Map();
      for (const root of scan.roots) countsByRoot.set(root.id, (countsByRoot.get(root.id) || 0) + 1);

      const stableObservations = [];

      for (const session of liveSessions) {
        const roots = scan.roots.filter((root) => root.easyccSessionId === session.id);
        if (roots.length !== 1) {
          this.stableRoots.delete(session.id);
          this.monitorHooks.onObservation({
            sessionId: session.id,
            state: 'unresolved',
            error: roots.length === 0 ? 'Codex root process not found' : 'Multiple Codex root conversations detected'
          });
          continue;
        }
        const root = roots[0];
        const externalCollision = countsByRoot.get(root.id) > 1;
        const ownedByAnother = liveSessions.some((candidate) =>
          candidate.id !== session.id && String(candidate.codexSessionId || '').toLowerCase() === root.id
        );
        if (externalCollision || ownedByAnother) {
          this.stableRoots.delete(session.id);
          this.monitorHooks.onObservation({
            sessionId: session.id,
            state: 'conflict',
            candidateId: root.id,
            error: 'Codex conversation is already open in another session'
          });
          continue;
        }

        const previous = this.stableRoots.get(session.id);
        const now = this.clock();
        const stable = previous?.id === root.id
          ? { id: root.id, count: previous.count + 1, firstSeenAt: previous.firstSeenAt }
          : { id: root.id, count: 1, firstSeenAt: now };
        this.stableRoots.set(session.id, stable);
        if (stable.count >= 2 && now - stable.firstSeenAt >= 500) {
          stableObservations.push({
            session,
            sessionId: session.id,
            state: 'verified',
            candidateId: root.id,
            workingDir: root.workingDir
          });
        }
      }

      if (stableObservations.length > 0) {
        const needsMetadata = stableObservations.filter(({ session, candidateId }) => {
          const switched = String(session.codexSessionId || '').toLowerCase() !== candidateId;
          const titleRetryDue = !session.codexThreadName &&
            this.clock() - Date.parse(session.codexIdentityVerifiedAt || 0) >= 30_000;
          return switched || titleRetryDue || !this.repoContextResolved.has(session.id);
        });
        let index = null;
        let contexts = null;
        if (needsMetadata.length > 0) {
          [index, contexts] = await Promise.all([
            this.loadIndex(),
            this.resolveRepoContexts(needsMetadata.map((item) => item.workingDir))
          ]);
        }
        for (const observation of stableObservations) {
          const metadataRequested = needsMetadata.includes(observation);
          if (metadataRequested && contexts?.has(observation.workingDir)) {
            this.repoContextResolved.add(observation.sessionId);
          }
          this.monitorHooks.onObservation({
            sessionId: observation.sessionId,
            state: observation.state,
            candidateId: observation.candidateId,
            workingDir: observation.workingDir,
            threadName: metadataRequested ? (index?.get(observation.candidateId)?.threadName || '') : undefined,
            repoContext: metadataRequested ? contexts?.get(observation.workingDir) : undefined
          });
        }
      }
    } catch (error) {
      this.scanFailureCount += 1;
      delay = [5000, 10000, 20000][Math.min(this.scanFailureCount - 1, 2)];
    } finally {
      this.scanRunning = false;
      const shouldRunAgain = this.scanQueued;
      this.scanQueued = false;
      if (!this.shuttingDown) {
        this.monitorTimer = setTimeout(() => { void this.runMonitorScan(); }, shouldRunAgain ? 0 : delay);
      }
    }
  }

  stopMonitor() {
    this.shuttingDown = true;
    if (this.monitorTimer) clearTimeout(this.monitorTimer);
    this.monitorTimer = null;
    this.monitorHooks = null;
    this.stableRoots.clear();
    this.repoContextResolved.clear();
  }
}

module.exports = {
  buildProcessScanProbe,
  CodexSessionService,
  decodeCursor,
  encodeCursor,
  getLocalDate,
  normalizePath,
  normalizePreview,
  pathsEqual,
  quoteForPosixShell
};

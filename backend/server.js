const fastify = require('fastify');
const fastifyWebsocket = require('@fastify/websocket');
const fastifyStatic = require('@fastify/static');
const fastifyCors = require('@fastify/cors');
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const SessionManager = require('./sessionManager');
const PlanManager = require('./planManager');
const SettingsManager = require('./settingsManager');
const DataStore = require('./dataStore');
const PlanVersionStore = require('./planVersionStore');
const AgentStore = require('./agentStore');
const TaskStore = require('./taskStore');
const PresetStore = require('./presetStore');
const TeamStore = require('./teamStore');
const { generateSessionName, ensureUniqueSessionName } = require('./sessionNaming');
const { prepareTerminalReplayPayload } = require('./terminalReplayUtils');
const { stripAnsi } = require('./sessionInputUtils');

const app = fastify({ logger: true });
const dataStore = new DataStore();
const sessionManager = new SessionManager();
const planManager = new PlanManager();
const settingsManager = new SettingsManager();
const planVersionStore = new PlanVersionStore();
const agentStore = new AgentStore();
const taskStore = new TaskStore();
const presetStore = new PresetStore();
const teamStore = new TeamStore();
const { sessionStatusToStage } = require('./stagesConfig');

const DEFAULT_FOLDERS_ROOT = process.env.FOLDERS_BROWSE_ROOT || os.homedir();

// Per-session debounce timers for kanban stage sync (3s stability)
const kanbanSyncTimers = new Map();

// Track WebSocket connections
const dashboardClients = new Set();
const terminalClients = new Map(); // sessionId -> Set of clients
const activeChildren = new Set();
// Track recent /ec-send senders: recipientId -> Map<senderId, timestamp>
const recentSenders = new Map();

const VALID_TEAM_STRATEGIES = new Set(['hierarchical', 'parallel']);
const AGENT_TEMPLATES = {
  orchestrator: {
    id: 'orchestrator',
    name: 'Orchestrator',
    cliType: 'claude',
    role: 'Coordinate multiple agents. Spawn sub-agents for subtasks, monitor progress, and collect results. Do not write code directly — delegate to specialized agents.'
  },
  'backend-dev': {
    id: 'backend-dev',
    name: 'Backend Dev',
    cliType: 'claude',
    role: 'Server-side specialist: API routes, database, auth, middleware. Never modify frontend/UI files.'
  },
  'frontend-dev': {
    id: 'frontend-dev',
    name: 'Frontend Dev',
    cliType: 'claude',
    role: 'React components, CSS/Tailwind, UI logic, accessibility. Never modify backend/server files.'
  },
  'test-writer': {
    id: 'test-writer',
    name: 'Test Writer',
    cliType: 'claude',
    role: "Write and run tests (Playwright, Jest). Review coverage gaps. Don't modify source code, only test files."
  },
  'code-reviewer': {
    id: 'code-reviewer',
    name: 'Code Reviewer',
    cliType: 'claude',
    role: 'Review code changes, find bugs, suggest improvements. Read-only - never edit files directly.'
  },
  'bug-hunter': {
    id: 'bug-hunter',
    name: 'Bug Hunter',
    cliType: 'claude',
    role: 'Investigate bugs: read logs, trace code, identify root cause. Propose minimal targeted fixes.'
  },
  devops: {
    id: 'devops',
    name: 'DevOps',
    cliType: 'claude',
    role: 'Docker, CI/CD, deployment, environment config, infrastructure.'
  },
  architect: {
    id: 'architect',
    name: 'Architect',
    cliType: 'claude',
    role: "Design systems, plan architecture, review PRs. Don't write implementation code - produce specs and plans."
  }
};

function normalizeWindowsPath(input) {
  if (!input || typeof input !== 'string') return '';
  if (process.platform !== 'win32' && input.trim().startsWith('/')) {
    const normalizedPosix = path.posix.normalize(input.trim());
    return normalizedPosix === '/' ? normalizedPosix : normalizedPosix.replace(/\/+$/, '');
  }
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

function isPathWithinRoot(targetPath, rootPath) {
  const normalizedTarget = normalizeWindowsPath(targetPath).toLowerCase();
  const normalizedRoot = normalizeWindowsPath(rootPath).toLowerCase();
  if (normalizedTarget === normalizedRoot) return true;
  const separator = normalizedRoot.includes('\\') ? '\\' : '/';
  const rootPrefix = normalizedRoot.endsWith(separator) ? normalizedRoot : `${normalizedRoot}${separator}`;
  return normalizedTarget.startsWith(rootPrefix);
}

function defaultWslBrowseRoot() {
  if (process.env.WSL_FOLDERS_BROWSE_ROOT) return process.env.WSL_FOLDERS_BROWSE_ROOT;
  if (process.platform === 'win32') return '\\\\wsl$\\Ubuntu\\home\\denni\\apps';
  return '/home/denni/apps';
}

function getBrowseRoots() {
  const roots = [];
  const windowsRoot = normalizeWindowsPath(process.env.FOLDERS_BROWSE_ROOT || DEFAULT_FOLDERS_ROOT);
  if (windowsRoot && fs.existsSync(windowsRoot) && fs.statSync(windowsRoot).isDirectory()) {
    roots.push({ id: 'windows', label: 'Windows', path: windowsRoot });
  }

  const wslRoot = normalizeWindowsPath(defaultWslBrowseRoot());
  if (wslRoot && fs.existsSync(wslRoot) && fs.statSync(wslRoot).isDirectory()) {
    const duplicate = roots.some(root => normalizeWindowsPath(root.path).toLowerCase() === wslRoot.toLowerCase());
    if (!duplicate) roots.push({ id: 'wsl', label: 'WSL', path: wslRoot });
  }

  return roots;
}

function getRootForPath(targetPath, roots) {
  const normalizedTarget = normalizeWindowsPath(targetPath).toLowerCase();
  return roots.find(root => {
    const normalizedRoot = normalizeWindowsPath(root.path).toLowerCase();
    if (normalizedTarget === normalizedRoot) return true;
    const separator = normalizedRoot.includes('\\') ? '\\' : '/';
    const rootPrefix = normalizedRoot.endsWith(separator) ? normalizedRoot : `${normalizedRoot}${separator}`;
    return normalizedTarget.startsWith(rootPrefix);
  });
}

function joinBrowsePath(basePath, childName) {
  const normalizedBase = normalizeWindowsPath(basePath);
  if (normalizedBase.startsWith('/') && !normalizedBase.includes('\\')) {
    return path.posix.join(normalizedBase, childName);
  }
  if (/^[A-Za-z]:\\$/.test(normalizedBase)) {
    return `${normalizedBase}${childName}`;
  }
  return `${normalizedBase}\\${childName}`;
}

function validateFolderName(name) {
  const trimmed = typeof name === 'string' ? name.trim() : '';
  if (!trimmed) return { valid: false, error: 'Folder name is required' };
  if (trimmed === '.' || trimmed === '..') return { valid: false, error: 'Folder name cannot be . or ..' };
  if (/[<>:"/\\|?*\x00-\x1F]/.test(trimmed)) return { valid: false, error: 'Folder name contains invalid characters' };
  if (/[. ]$/.test(trimmed)) return { valid: false, error: 'Folder name cannot end with a period or space' };
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(trimmed)) return { valid: false, error: 'Folder name is reserved on Windows' };
  return { valid: true, name: trimmed };
}

function normalizePathKey(filePath) {
  if (!filePath || typeof filePath !== 'string') return '';
  const resolved = path.resolve(filePath);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function buildOrchestratorPrompt(port, sessionId) {
  return `You are an orchestrator session in EasyCC. You manage child sessions.

The user can type /ec- commands which EasyCC handles directly. But you can also call the orchestrator API yourself using curl when working autonomously:

LIST:   curl -s http://localhost:${port}/api/orchestrator/sessions
READ:   curl -s http://localhost:${port}/api/orchestrator/sessions/SESSION_ID/screen?lines=50
SEND:   curl -s -X POST http://localhost:${port}/api/orchestrator/sessions/SESSION_ID/input -H "Content-Type: application/json" -d '{"text":"your message","submit":true,"fromSessionId":"${sessionId}"}'
SPAWN:  curl -s -X POST http://localhost:${port}/api/orchestrator/sessions/spawn -H "Content-Type: application/json" -d '{"name":"Worker","workingDir":"/path","cliType":"claude","role":"...","startupPrompt":"...","parentSessionId":"${sessionId}"}'
STATUS: curl -s http://localhost:${port}/api/orchestrator/sessions/SESSION_ID/status

Your session ID is: ${sessionId}
Poll status before reading screen. Wait for sessions to reach "idle" before reading results.

When you receive a message from another session (prefixed with [From: name#sessionId]), reply using: /ec-send 'name'#sessionId <your response>. The #sessionId allows instant delivery without a lookup.`;
}

const EC_SKILLS_VERSION = 'v6';

function installEcSkills() {
  const skillsDir = path.join(os.homedir(), '.claude', 'skills');
  const nodeGet = (pathExpr) => `node -e "const http=require('http');http.get('http://localhost:'+(process.env.EASYCC_PORT||5010)+'${pathExpr}',r=>{let d='';r.on('data',c=>d+=c);r.on('end',()=>console.log(d))}).on('error',e=>console.error('EasyCC unreachable:',e.message))"`;
  const skills = {
    'ec-list': {
      name: 'ec-list',
      description: 'List all EasyCC sessions with their status, name, type, and working directory',
      hint: '',
      body: `List all active EasyCC sessions by calling the orchestrator API.

## Instructions

1. Run this command using the Bash tool:
\`\`\`bash
${nodeGet('/api/orchestrator/sessions')}
\`\`\`

2. Parse the JSON response and display a formatted table with columns: ID (first 8 chars), Name, Status, Type, Orchestrator (star if true), Parent.

3. Show the total count at the bottom. If unreachable, suggest the user start EasyCC with \`npm run start:web\`.`
    },
    'ec-status': {
      name: 'ec-status',
      description: 'Show compact status of EasyCC sessions or a specific session',
      hint: '[name-or-id]',
      body: `Show compact status of EasyCC sessions.

## Instructions

If $ARGUMENTS provided, find the matching session. If no arguments, show all.

**FAST PATH:** If the argument contains \`#\`, split on \`#\`: left = name, right = full session ID. Use the ID directly in step 2 — skip listing.

1. List all sessions (skip if fast path and specific session requested):
\`\`\`bash
${nodeGet('/api/orchestrator/sessions')}
\`\`\`

2. If a specific session was requested, match by name (case-insensitive partial) or ID prefix, then get its detailed status (replace SESSION_ID):
\`\`\`bash
${nodeGet('/api/orchestrator/sessions/SESSION_ID/status')}
\`\`\`

3. Display as compact one-line-per-session: \`[status] Name (type) - last active Xm ago\``
    },
    'ec-read': {
      name: 'ec-read',
      description: 'Read the last N lines of terminal output from an EasyCC session',
      hint: '<name-or-id> [lines]',
      body: `Read recent terminal output from a specific EasyCC session.

## Instructions

Parse $ARGUMENTS: first word = session name/ID, optional second = lines (default 50).

**FAST PATH:** If the target contains \`#\`, split on \`#\`: left = name, right = full session ID. Use the ID directly in step 3 — skip steps 1-2.

1. List sessions to find target (skip if fast path):
\`\`\`bash
${nodeGet('/api/orchestrator/sessions')}
\`\`\`
2. Match by name (case-insensitive partial) or ID prefix.
3. Read screen (replace SESSION_ID and LINES):
\`\`\`bash
${nodeGet('/api/orchestrator/sessions/SESSION_ID/screen?lines=LINES&format=text')}
\`\`\`
4. Display with header showing session name and status.`
    },
    'ec-send': {
      name: 'ec-send',
      description: 'Send a message or prompt to an EasyCC session',
      hint: '<name-or-id> <message>',
      body: `Send text input to one or more EasyCC sessions.

## Instructions

Parse $ARGUMENTS as target + message. Support natural language targeting: use the longest reasonable target phrase before the message, not just the first word. Example: \`/ec-send the git checker check status\` should target "git checker" and send "check status".

**FAST PATH — skip steps 1-3 entirely when an ID is already known:**
- If the target contains \`#\`, split on \`#\`: left = display name, right = full session ID. Use the ID directly in step 5. This happens when the @ picker was used.
- If replying to a \`[From: name#sessionId]\` message, extract the session ID after \`#\`. Use it directly in step 5.

1. List sessions to find target (skip if fast path):
\`\`\`bash
${nodeGet('/api/orchestrator/sessions')}
\`\`\`
2. Always include ID prefixes when reasoning about matches so ambiguous names can be disambiguated.
3. Resolve target using this order:
   - Broadcast keywords:
     - \`group\` = parent + siblings + children in the current orchestrator context
     - \`children\` = sessions where \`parentSessionId === $EASYCC_SESSION_ID\`
     - \`siblings\` = sessions sharing my \`parentSessionId\`, excluding self
     - \`all\` = every other session
   - Fuzzy name match on the full target text (case-insensitive partial match)
   - ID prefix match, especially when fuzzy matching returns multiple results
4. For broadcasts, loop through each resolved target and send individually. Report success count, failure count, and any sessions skipped.
5. Send. **IMPORTANT: Always use \`node -e\` with JSON.stringify — never curl with inline JSON on Windows.**
Replace SESSION_ID and MESSAGE_TEXT:
\`\`\`bash
node -e "const http=require('http');const data=JSON.stringify({text:'MESSAGE_TEXT',submit:true,fromSessionId:process.env.EASYCC_SESSION_ID||''});const req=http.request({hostname:'localhost',port:process.env.EASYCC_PORT||5010,path:'/api/orchestrator/sessions/SESSION_ID/input',method:'POST',headers:{'Content-Type':'application/json','Content-Length':Buffer.byteLength(data)}},r=>{let d='';r.on('data',c=>d+=c);r.on('end',()=>console.log(d))});req.write(data);req.end()"
\`\`\`
6. Confirm delivery. Report rate limit (429) or loop detection errors.`
    },
    'ec-spawn': {
      name: 'ec-spawn',
      description: 'Spawn a new child session in EasyCC with a role description',
      hint: '<description>',
      body: `Spawn a new child session in EasyCC linked to this session as parent.

## Instructions

$ARGUMENTS = description of what the child should do.

1. Prepare a short name, a detailed role prompt, and an initial startup prompt based on the description.
2. Optionally gather relevant codebase context to enrich the child's role.

3. Spawn. **IMPORTANT: Always use \`node -e\` with JSON.stringify — never curl with inline JSON on Windows.** Use forward slashes in paths.

\`\`\`bash
node -e "
const http = require('http');
const data = JSON.stringify({
  name: 'CHILD_NAME',
  workingDir: 'WORKING_DIR_WITH_FORWARD_SLASHES',
  cliType: 'claude',
  role: 'DETAILED_ROLE_PROMPT',
  startupPrompt: 'INITIAL_TASK_PROMPT',
  parentSessionId: process.env.EASYCC_SESSION_ID || ''
});
const req = http.request({
  hostname: 'localhost',
  port: process.env.EASYCC_PORT || 5010,
  path: '/api/orchestrator/sessions/spawn',
  method: 'POST',
  headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) }
}, r => { let d = ''; r.on('data', c => d += c); r.on('end', () => console.log(d)); });
req.write(data);
req.end();
"
\`\`\`

4. Report new session ID/name. Suggest \`/ec-read CHILD_NAME\` to monitor and \`/ec-send CHILD_NAME message\` for follow-up.

EasyCC automatically gives the child parent/sibling context and instructions for reporting back. The parent is auto-notified when children go idle, and existing siblings are notified when a new child joins.

**Key rules:**
- Use forward slashes in paths (e.g., \`C:/Users/denni/apps/MyProject\`)
- Use \`JSON.stringify()\` for all POST bodies — it handles escaping automatically
- The role should be detailed enough for the child to work autonomously`
    },
    'ec-task-comment': {
      name: 'ec-task-comment',
      description: 'Reply to a task comment in EasyCC (post a comment back to a task)',
      hint: '<task-id> <comment-text>',
      body: `Post a comment to an EasyCC task. Use this to reply to [Task mention] messages.

## Instructions

Parse $ARGUMENTS: first word = task ID, rest = comment text.
If no task ID in arguments, fall back to $EASYCC_TASK_ID environment variable.

1. Post the comment. **Use node -e with JSON.stringify.** Replace TASK_ID and COMMENT_TEXT:
\`\`\`bash
node -e "const http=require('http');const data=JSON.stringify({text:'COMMENT_TEXT',sessionId:process.env.EASYCC_SESSION_ID||''});const req=http.request({hostname:'localhost',port:process.env.EASYCC_PORT||5010,path:'/api/tasks/TASK_ID/auto-comment',method:'POST',headers:{'Content-Type':'application/json','Content-Length':Buffer.byteLength(data)}},r=>{let d='';r.on('data',c=>d+=c);r.on('end',()=>console.log(d))});req.write(data);req.end()"
\`\`\`

2. Confirm: "Comment posted to task TASK_ID".

**Note:** The sessionId is sent automatically via $EASYCC_SESSION_ID — the backend resolves it to your display name. No need to specify an author manually.`
    },
    'ec-kb-columns': {
      name: 'ec-kb-columns',
      description: 'List all kanban board columns (stages) with card counts',
      hint: '',
      body: `List all kanban columns with their card counts.

## Instructions

1. Fetch stages and sessions grouped by stage:
\`\`\`bash
${nodeGet('/api/stages')}
\`\`\`
\`\`\`bash
${nodeGet('/api/sessions/by-stage')}
\`\`\`

2. Parse both JSON responses. For each stage, count the sessions in that stage from the by-stage response.

3. Display a formatted table with columns: Order, Name, ID, Cards (count), Color, Pool Type.

4. Show total card count at the bottom.`
    },
    'ec-kb-cards': {
      name: 'ec-kb-cards',
      description: 'List cards (sessions) in a kanban column, or all columns if no argument',
      hint: '[column-name]',
      body: `List cards in a specific kanban column, or show all columns with counts.

## Instructions

Parse $ARGUMENTS as column name (optional).

1. Fetch sessions grouped by stage:
\`\`\`bash
${nodeGet('/api/sessions/by-stage')}
\`\`\`

2. If no column specified, display a summary: each column name with its card count. Done.

3. If column specified, fuzzy match the argument against stage names and IDs (case-insensitive partial match). If multiple matches, pick the best one or ask user.

4. Display cards in the matched column as a table: Name, Status, CLI Type, Working Dir, Priority, Entered (relative time), Blocked By (if any).

5. If no cards in column, say so.`
    },
    'ec-kb-move': {
      name: 'ec-kb-move',
      description: 'Move a session/card to a specific kanban column',
      hint: '<session-name-or-id> <target-column>',
      body: `Move a session to a specific kanban column.

## Instructions

Parse $ARGUMENTS: everything before the last word(s) = session target, last word(s) = column target. Use judgement to split — column names may be multi-word (e.g., "in progress", "in review").

**FAST PATH:** If the session target contains \`#\`, split on \`#\`: left = name, right = full session ID. Use the ID directly — skip step 1.

1. List sessions to resolve target (skip if fast path):
\`\`\`bash
${nodeGet('/api/orchestrator/sessions')}
\`\`\`

2. Fetch stages to resolve column:
\`\`\`bash
${nodeGet('/api/stages')}
\`\`\`

3. Fuzzy match session by name (case-insensitive partial) or ID prefix.
4. Fuzzy match column by name or ID (case-insensitive partial).

5. Move the session. **Use node -e with JSON.stringify.** Replace SESSION_ID and STAGE_ID:
\`\`\`bash
node -e "const http=require('http');const data=JSON.stringify({stage:'STAGE_ID',reason:'Moved via /ec-kb-move'});const req=http.request({hostname:'localhost',port:process.env.EASYCC_PORT||5010,path:'/api/sessions/SESSION_ID/move',method:'POST',headers:{'Content-Type':'application/json','Content-Length':Buffer.byteLength(data)}},r=>{let d='';r.on('data',c=>d+=c);r.on('end',()=>console.log(d))});req.write(data);req.end()"
\`\`\`

6. Confirm: "Moved [session name] to [column name]".`
    },
    'ec-kb-advance': {
      name: 'ec-kb-advance',
      description: 'Advance a card to the next kanban stage',
      hint: '[session-name-or-id]',
      body: `Advance a session to the next kanban stage.

## Instructions

Parse $ARGUMENTS as session name/ID. If no argument, use the current session via $EASYCC_SESSION_ID.

**FAST PATH:** If the argument contains \`#\`, split on \`#\`: left = name, right = full session ID. Use the ID directly — skip step 1.

1. If argument provided, list sessions to resolve (skip if fast path):
\`\`\`bash
${nodeGet('/api/orchestrator/sessions')}
\`\`\`
Fuzzy match by name or ID prefix. Otherwise use $EASYCC_SESSION_ID directly.

2. Advance. Replace SESSION_ID:
\`\`\`bash
node -e "const http=require('http');const data=JSON.stringify({});const req=http.request({hostname:'localhost',port:process.env.EASYCC_PORT||5010,path:'/api/sessions/SESSION_ID/advance',method:'POST',headers:{'Content-Type':'application/json','Content-Length':Buffer.byteLength(data)}},r=>{let d='';r.on('data',c=>d+=c);r.on('end',()=>console.log(d))});req.write(data);req.end()"
\`\`\`

3. Report result: "Advanced [session name] from [old stage] to [new stage]".`
    },
    'ec-kb-comment': {
      name: 'ec-kb-comment',
      description: 'Add a comment to a kanban card/session',
      hint: '<session-name-or-id> <comment-text>',
      body: `Add a comment to a session's kanban card.

## Instructions

Parse $ARGUMENTS: first word(s) = session target, rest = comment text. Use judgement to split target from comment — session names may be multi-word.

**FAST PATH:** If the session target contains \`#\`, split on \`#\`: left = name, right = full session ID. Use the ID directly — skip step 1.

1. List sessions to resolve target (skip if fast path):
\`\`\`bash
${nodeGet('/api/orchestrator/sessions')}
\`\`\`

2. Fuzzy match by name (case-insensitive partial) or ID prefix.

3. Post comment. **Use node -e with JSON.stringify.** Replace SESSION_ID, COMMENT_TEXT, and AUTHOR:
\`\`\`bash
node -e "const http=require('http');const data=JSON.stringify({text:'COMMENT_TEXT',author:process.env.EASYCC_SESSION_NAME||'External Agent'});const req=http.request({hostname:'localhost',port:process.env.EASYCC_PORT||5010,path:'/api/sessions/SESSION_ID/comments',method:'POST',headers:{'Content-Type':'application/json','Content-Length':Buffer.byteLength(data)}},r=>{let d='';r.on('data',c=>d+=c);r.on('end',()=>console.log(d))});req.write(data);req.end()"
\`\`\`

4. Confirm: "Comment added to [session name]".`
    },
    'ec-kb-stats': {
      name: 'ec-kb-stats',
      description: 'Show kanban board statistics and summary',
      hint: '',
      body: `Show kanban board statistics.

## Instructions

1. Fetch board stats:
\`\`\`bash
${nodeGet('/api/sessions/stats')}
\`\`\`

2. Also fetch sessions by stage for additional detail:
\`\`\`bash
${nodeGet('/api/sessions/by-stage')}
\`\`\`

3. Display a summary:
   - Total sessions across all stages
   - Count per stage (column name: count)
   - Any blocked sessions (sessions with non-empty blockedBy arrays)
   - Recently active sessions (last 10 minutes)

4. Keep it concise — this is a quick dashboard overview.`
    },
    'ec-kb-process': {
      name: 'ec-kb-process',
      description: 'Process all cards in a kanban column by spawning worker agents',
      hint: '<column-name> <action>',
      body: `Process all cards in a kanban column sequentially using worker agents.

## Instructions

Parse $ARGUMENTS: first part = column name, last part = action to run on each card (e.g., "verify-plan", "review", or a custom prompt).

### Step 1: Get cards in column
\`\`\`bash
${nodeGet('/api/sessions/by-stage')}
\`\`\`
Fuzzy match column name. Get all cards (sessions) in that stage.

### Step 2: Group cards by workingDir
Group the cards so all cards from the same repo are processed together. This saves tokens — the worker retains codebase knowledge between cards via /compact.

### Step 3: Process each group
For each workingDir group:

**a) Spawn a worker** in that workingDir using /ec-spawn:
\`\`\`bash
node -e "const http=require('http');const data=JSON.stringify({name:'KB Worker',workingDir:'WORKING_DIR',cliType:'claude',role:'You are a worker agent processing kanban cards. After each task, wait for the next instruction. Report results clearly as PASS or FAIL with a brief reason.',startupPrompt:'Ready for tasks.',parentSessionId:process.env.EASYCC_SESSION_ID||''});const req=http.request({hostname:'localhost',port:process.env.EASYCC_PORT||5010,path:'/api/orchestrator/sessions/spawn',method:'POST',headers:{'Content-Type':'application/json','Content-Length':Buffer.byteLength(data)}},r=>{let d='';r.on('data',c=>d+=c);r.on('end',()=>console.log(d))});req.write(data);req.end()"
\`\`\`

**b) For each card in the group:**
1. Send the action task to the worker via /ec-send: "Process card: [card name]. Action: [action]. Working on: [card description/notes if any]"
2. Wait for worker to go idle (poll via /ec-status every 15s, or watch for idle notification)
3. Read worker output via /ec-read to determine result (PASS/FAIL)
4. Move card based on result:
   - PASS: advance to next stage via POST /api/sessions/CARD_ID/advance
   - FAIL: add comment with failure reason
5. Add comment to card summarizing result
6. Send /compact to worker (type "/compact" via /ec-send) to free context while preserving repo knowledge
7. Proceed to next card

**c) After all cards in group:** optionally stop the worker or keep alive for reuse.

### Step 4: Report summary
Display: total cards processed, passed, failed, per-group breakdown.

**Key rules:**
- Always use \`node -e\` with \`JSON.stringify()\` for POST requests
- Use forward slashes in paths
- Process cards sequentially, not in parallel
- Reuse worker within same workingDir group (send /compact between cards, NOT /clear)
- Spawn fresh worker for different workingDir groups`
    },
    'ec-agent-list': {
      name: 'ec-agent-list',
      description: 'List available agents in the EasyCC roster with their status',
      hint: '',
      body: `List all agents in the EasyCC agent roster.

## Instructions

1. Fetch all agents:
\`\`\`bash
${nodeGet('/api/agents')}
\`\`\`

2. Parse the JSON response (array of agent objects).

3. Display a formatted table with columns:
   - Name
   - Role (first 50 chars)
   - CLI Type
   - Status (Running/Stopped — check if activeSessionId is set and session exists)
   - Working Dir
   - Tags

4. Show total count. Highlight running agents.`
    },
    'ec-agent-start': {
      name: 'ec-agent-start',
      description: 'Start a roster agent, optionally in a different working directory',
      hint: '<agent-name> [workingDir]',
      body: `Start an agent from the EasyCC roster, optionally targeting a specific repo/directory.

## Instructions

Parse $ARGUMENTS: first part = agent name, optional second part = working directory path.

1. Fetch agents to resolve name:
\`\`\`bash
${nodeGet('/api/agents')}
\`\`\`

2. Fuzzy match agent by name (case-insensitive partial match). If multiple matches, pick the best or ask user.

3. Start the agent. **Use node -e with JSON.stringify.** Replace AGENT_ID and optionally include workingDir:
\`\`\`bash
node -e "const http=require('http');const data=JSON.stringify({workingDir:'OPTIONAL_WORKING_DIR_OR_EMPTY'});const req=http.request({hostname:'localhost',port:process.env.EASYCC_PORT||5010,path:'/api/agents/AGENT_ID/start',method:'POST',headers:{'Content-Type':'application/json','Content-Length':Buffer.byteLength(data)}},r=>{let d='';r.on('data',c=>d+=c);r.on('end',()=>console.log(d))});req.write(data);req.end()"
\`\`\`

If no workingDir argument provided, omit it from the JSON body (agent uses its stored default).
If workingDir provided, use forward slashes (e.g., C:/Users/denni/apps/MyApp).

4. Report: "Started agent [name] in [workingDir]" with the session ID.
5. Suggest /ec-read and /ec-send for interacting with the running agent.`
    },
    'ec-agent-stop': {
      name: 'ec-agent-stop',
      description: 'Stop a running roster agent',
      hint: '<agent-name>',
      body: `Stop a running agent from the EasyCC roster.

## Instructions

Parse $ARGUMENTS as agent name.

1. Fetch agents to resolve name:
\`\`\`bash
${nodeGet('/api/agents')}
\`\`\`

2. Fuzzy match agent by name (case-insensitive partial match).

3. Stop the agent. Replace AGENT_ID:
\`\`\`bash
node -e "const http=require('http');const data=JSON.stringify({});const req=http.request({hostname:'localhost',port:process.env.EASYCC_PORT||5010,path:'/api/agents/AGENT_ID/stop',method:'POST',headers:{'Content-Type':'application/json','Content-Length':Buffer.byteLength(data)}},r=>{let d='';r.on('data',c=>d+=c);r.on('end',()=>console.log(d))});req.write(data);req.end()"
\`\`\`

4. Confirm: "Stopped agent [name]".`
    }
  };

  for (const [dir, skill] of Object.entries(skills)) {
    const skillDir = path.join(skillsDir, dir);
    const skillFile = path.join(skillDir, 'SKILL.md');

    // Only auto-overwrite EasyCC-managed skill files.
    try {
      const existing = fs.readFileSync(skillFile, 'utf8');
      if (existing.includes(`<!-- EasyCC ${EC_SKILLS_VERSION} -->`)) continue;
      if (!existing.includes('<!-- EasyCC v')) {
        console.warn(`Skipping ${dir} — user-modified (no version marker)`);
        continue;
      }
    } catch { /* file doesn't exist, create it */ }

    fs.mkdirSync(skillDir, { recursive: true });

    const hintLine = skill.hint ? `\nargument-hint: ${skill.hint}` : '';
    const content = `---
name: ${skill.name}
description: ${skill.description}${hintLine}
---

<!-- EasyCC ${EC_SKILLS_VERSION} -->

${skill.body}
`;
    fs.writeFileSync(skillFile, content, 'utf8');
  }
}

function isAllowedPlanFilePath(filePath) {
  if (!filePath || typeof filePath !== 'string') return false;
  const resolved = path.resolve(filePath);
  if (!resolved.toLowerCase().endsWith('.md')) return false;
  if (!path.isAbsolute(resolved)) return false;
  if (!fs.existsSync(resolved)) return false;

  const parentDir = path.basename(path.dirname(resolved)).toLowerCase();
  if (parentDir !== 'plans') return false;

  const claudePlansDir = path.resolve(path.join(os.homedir(), '.claude', 'plans'));
  const normalizedFile = normalizePathKey(resolved);
  const normalizedClaudePlansDir = normalizePathKey(claudePlansDir);

  if (
    normalizedFile === normalizedClaudePlansDir ||
    normalizedFile.startsWith(`${normalizedClaudePlansDir}${path.sep}`)
  ) {
    return true;
  }

  // Also allow any "<workingDir>/plans/*.md" file.
  return true;
}

function resolvePlanPathForApi({ filename, planPath }) {
  if (planPath) {
    const candidatePath = path.resolve(planPath);
    if (!isAllowedPlanFilePath(candidatePath)) {
      return { error: 'Invalid planPath' };
    }
    return { planPath: candidatePath };
  }

  const fallbackPath = planManager.getPlanPath(filename);
  if (!fallbackPath || !fs.existsSync(fallbackPath)) {
    return { error: 'Plan not found' };
  }
  return { planPath: fallbackPath };
}

function getFirstNonEmptyLine(text) {
  if (typeof text !== 'string') return '';
  const lines = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed) return trimmed;
  }
  return '';
}

function normalizePlanNameBase(input) {
  if (!input || typeof input !== 'string') return '';
  return input
    .replace(/^\s{0,3}(#{1,6}\s*|[-*+]\s+|\d+\.\s+)/, '')
    .replace(/[`*_~[\]()>]/g, '')
    .replace(/[^a-zA-Z0-9-_ ]/g, '-')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 60);
}

function listProjectPlans(workingDir) {
  if (!workingDir || typeof workingDir !== 'string') {
    return [];
  }

  const plansDir = path.join(workingDir, 'plans');
  if (!fs.existsSync(plansDir)) {
    return [];
  }

  try {
    const files = fs.readdirSync(plansDir);
    const plans = [];

    for (const file of files) {
      if (!file.endsWith('.md')) {
        continue;
      }

      const filePath = path.join(plansDir, file);
      const stats = fs.statSync(filePath);
      plans.push({
        filename: file,
        name: file.replace('.md', '').replace(/-/g, ' '),
        path: filePath,
        createdAt: stats.birthtime.toISOString(),
        modifiedAt: stats.mtime.toISOString(),
        size: stats.size
      });
    }

    plans.sort((a, b) => new Date(b.modifiedAt) - new Date(a.modifiedAt));
    return plans;
  } catch (error) {
    console.error('Error listing project plans:', error.message);
    return [];
  }
}

function normalizeRoleInput(role) {
  if (role === undefined || role === null) {
    return { value: '' };
  }
  if (typeof role !== 'string') {
    return { error: 'role must be a string' };
  }

  const normalized = role.replace(/\0/g, '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  if (normalized.length > 4096) {
    return { error: 'role must be 4096 characters or fewer' };
  }

  return { value: normalized };
}

function normalizeStringArray(value) {
  if (!Array.isArray(value)) return [];
  return value
    .filter((entry) => typeof entry === 'string')
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function buildTeamRoster(team) {
  return (team.members || [])
    .map((member) => {
      const template = AGENT_TEMPLATES[member.template];
      const label = template?.name || member.template;
      return `- ${member.role}: ${label}${member.isOrchestrator ? ' (orchestrator)' : ''}`;
    })
    .join('\n');
}

function buildTeamLaunchRole(baseRole, team, goal) {
  const sections = [];
  if (baseRole) sections.push(baseRole);
  sections.push(
    `Team: ${team.name}`,
    `Goal: ${goal || 'No explicit goal provided.'}`,
    `Strategy: ${team.strategy}`,
    `Team roster:\n${buildTeamRoster(team)}`
  );
  if (team.strategy === 'hierarchical') {
    sections.push('You are responsible for deciding when to spawn child sessions to execute the team goal.');
  }
  return sections.filter(Boolean).join('\n\n');
}

function buildChildRoleContext(parentSession, siblings, baseRole) {
  const siblingList = siblings.length > 0
    ? `\nYour siblings: ${siblings.map((s) => `"${s.name}" (${s.id.substring(0, 8)})`).join(', ')}`
    : '';
  const childContext = `You are a child agent in EasyCC, spawned by parent "${parentSession.name}" (ID: ${parentSession.id}).${siblingList}

When you finish your task, report results back to the parent (use ID for reliable targeting):
  /ec-send ${parentSession.id.substring(0, 8)} <your results summary>

You can also communicate with siblings using their name or ID prefix: /ec-send <name-or-id> <message>
When you receive a message from any session (prefixed with [From: name#sessionId]), reply with /ec-send 'name'#sessionId <your response> when done. The #sessionId enables instant delivery.
Discover all sessions: /ec-list | Read output: /ec-read <name-or-id> | Status: /ec-status`;

  return childContext + (baseRole ? '\n\n---\n\n' + baseRole : '');
}

function buildTeamMemberStartupPrompt(team, member, goal, orchestratorSession) {
  const lines = [
    `You are part of the "${team.name}" team.`,
    `Team goal: ${goal || 'No explicit goal provided.'}`,
    `Your assigned role: ${member.role}.`
  ];
  if (orchestratorSession) {
    lines.push(`Report to orchestrator: /ec-send '${orchestratorSession.name}'#${orchestratorSession.id} <message>`);
  }
  lines.push('When you receive a message from any session (prefixed with [From: name#sessionId]), reply with /ec-send \'name\'#sessionId <your response> when done. The #sessionId enables instant delivery.');
  return lines.join('\n');
}

function validateTeamTemplateInput(payload, { partial = false, existing = null } = {}) {
  const normalized = existing ? {
    name: existing.name,
    description: existing.description || '',
    strategy: existing.strategy,
    members: Array.isArray(existing.members) ? existing.members.map((member) => ({ ...member })) : []
  } : {};

  if (!partial || payload.name !== undefined) {
    if (typeof payload.name !== 'string' || !payload.name.trim()) {
      return { error: 'name is required' };
    }
    normalized.name = payload.name.trim();
  }

  if (!partial || payload.description !== undefined) {
    if (payload.description !== undefined && typeof payload.description !== 'string') {
      return { error: 'description must be a string' };
    }
    normalized.description = typeof payload.description === 'string' ? payload.description.trim() : '';
  }

  if (!partial || payload.strategy !== undefined) {
    if (!VALID_TEAM_STRATEGIES.has(payload.strategy)) {
      return { error: 'strategy must be "hierarchical" or "parallel"' };
    }
    normalized.strategy = payload.strategy;
  }

  if (!partial || payload.members !== undefined) {
    if (!Array.isArray(payload.members) || payload.members.length === 0) {
      return { error: 'members must be a non-empty array' };
    }
    const seenRoles = new Set();
    let orchestratorCount = 0;
    normalized.members = [];
    for (const member of payload.members) {
      const role = typeof member?.role === 'string' ? member.role.trim() : '';
      const template = typeof member?.template === 'string' ? member.template.trim() : '';
      const isOrchestrator = !!member?.isOrchestrator;
      if (!role) return { error: 'each member.role is required' };
      if (seenRoles.has(role)) return { error: `duplicate team role: ${role}` };
      if (!AGENT_TEMPLATES[template]) return { error: `unknown agent template: ${template}` };
      if (isOrchestrator) orchestratorCount += 1;
      seenRoles.add(role);
      normalized.members.push({ role, template, isOrchestrator });
    }
    if (orchestratorCount !== 1) {
      return { error: 'exactly one member must have isOrchestrator: true' };
    }
  }

  return { value: normalized };
}

function enrichTeamInstance(instance) {
  if (!instance) return null;
  const sessions = (instance.sessionIds || [])
    .map((sessionId) => sessionManager.getSession(sessionId))
    .filter(Boolean);
  return {
    ...instance,
    sessions,
    sessionIds: sessions.map((session) => session.id)
  };
}

function updateTeamInstanceMembership(previousTeamInstanceId, nextTeamInstanceId, sessionId) {
  if (previousTeamInstanceId && previousTeamInstanceId !== nextTeamInstanceId) {
    const previous = teamStore.getTeamInstance(previousTeamInstanceId);
    if (previous) {
      teamStore.updateTeamInstance(previousTeamInstanceId, {
        sessionIds: (previous.sessionIds || []).filter((id) => id !== sessionId)
      });
    }
  }

  if (nextTeamInstanceId) {
    const next = teamStore.getTeamInstance(nextTeamInstanceId);
    if (next) {
      const nextIds = Array.from(new Set([...(next.sessionIds || []), sessionId]));
      teamStore.updateTeamInstance(nextTeamInstanceId, { sessionIds: nextIds });
    }
  }
}

function refreshTeamInstanceStatus(teamInstanceId) {
  if (!teamInstanceId) return;
  const instance = teamStore.getTeamInstance(teamInstanceId);
  if (!instance || instance.status === 'completed') return;
  const sessionIds = instance.sessionIds || [];
  if (sessionIds.length === 0) return;
  const hasActive = sessionIds.some((sessionId) => {
    const session = sessionManager.getSession(sessionId);
    return session && session.status !== 'completed';
  });
  if (!hasActive) {
    teamStore.updateTeamInstance(teamInstanceId, {
      status: 'completed',
      completedAt: new Date().toISOString()
    });
  }
}

function parseMentions(text) {
  if (typeof text !== 'string') return [];
  // Match @name or @name#agentId patterns
  const matches = text.match(/@([a-zA-Z0-9_-]+(?:#[a-zA-Z0-9-]+)?)/g) || [];
  return matches.map((mention) => {
    const raw = mention.slice(1).trim(); // remove @
    if (raw.includes('#')) {
      const [name, id] = raw.split('#', 2);
      return { name, id };
    }
    return { name: raw, id: null };
  }).filter(m => m.name);
}

function resolveMentionAgentIds(text, explicitMentions = []) {
  const directIds = normalizeStringArray(explicitMentions);
  const mentions = parseMentions(text);
  if (mentions.length === 0) return directIds;
  const agents = agentStore.listAgents();
  const ids = new Set(directIds);
  for (const { name, id } of mentions) {
    // Fast path: if #id was embedded by picker, use it directly
    if (id) {
      const agent = agentStore.getAgent(id);
      if (agent) { ids.add(id); continue; }
    }
    // Fallback: fuzzy name match
    const matched = agents.find((agent) => agent.name.toLowerCase() === name.toLowerCase());
    if (matched) ids.add(matched.id);
  }
  return [...ids];
}

function getActiveRunForAgent(task, agentId) {
  const history = Array.isArray(task?.runHistory) ? task.runHistory : [];
  for (let i = history.length - 1; i >= 0; i -= 1) {
    const run = history[i];
    if (run?.agentId === agentId && !run.endedAt) {
      return run;
    }
  }
  return null;
}

/**
 * Start an agent for a task — creates session if needed, injects task context, creates run entry.
 * Reused by /api/tasks/:id/start-run and auto-spawn on mention.
 * @returns {{ session, agent, createdNewSession, error? }}
 */
function startAgentForTask(agent, task) {
  const taskContext = {
    title: task.title || '',
    description: task.description || '',
    comments: (task.comments || []).slice(-5).map(c => ({
      author: c.author || 'unknown',
      text: (c.text || '').slice(0, 500)
    }))
  };

  let session = null;
  let createdNewSession = false;

  if (agent.activeSessionId) {
    session = sessionManager.getSession(agent.activeSessionId);
  }

  if (!session || session.status === 'completed') {
    try {
      session = sessionManager.createSession(
        agent.name,
        agent.workingDir,
        agent.cliType,
        {},
        agent.role || '',
        { agentId: agent.id, taskId: task.id }
      );
      createdNewSession = true;
      const updatedAgent = agentStore.updateAgent(agent.id, {
        activeSessionId: session.id,
        lastActiveAt: new Date().toISOString(),
        sessionHistory: [...(agent.sessionHistory || []), session.id]
      });
      if (updatedAgent) {
        broadcastDashboard({ type: 'agentUpdated', agent: updatedAgent });
      }
    } catch (error) {
      return { session: null, agent, createdNewSession: false, error: error.message };
    }
  } else {
    const updatedSession = sessionManager.updateSessionMeta(session.id, { taskId: task.id });
    if (updatedSession) session = updatedSession;
  }

  // Inject task context
  if (createdNewSession) {
    sessionManager.appendTaskContext(session.id, taskContext);
  } else {
    const instruction = `You have been assigned a new task:\n\nTitle: ${taskContext.title}` +
      (taskContext.description ? `\n\nDescription:\n${taskContext.description}` : '') +
      `\n\nPlease begin working on this task.\r`;
    sessionManager.sendInput(session.id, instruction);
  }

  // Create or reuse run entry
  const freshTask = taskStore.getTask(task.id);
  const existingRun = getActiveRunForAgent(freshTask, agent.id);
  if (!existingRun || existingRun.sessionId !== session.id) {
    taskStore.appendRun(task.id, {
      sessionId: session.id,
      agentId: agent.id,
      startedAt: new Date().toISOString(),
      status: 'active'
    });
  }

  return { session, agent, createdNewSession };
}

function broadcastDashboard(payload) {
  const message = JSON.stringify(payload);
  for (const client of dashboardClients) {
    try {
      client.send(message);
    } catch (error) {
      console.error('Error sending to dashboard client:', error.message);
    }
  }
}

async function start() {
  // Register plugins
  await app.register(fastifyCors, {
    origin: ['http://localhost:5010', 'http://localhost:5011'],
    credentials: true
  });

  await app.register(fastifyWebsocket, {
    options: {
      verifyClient: function (info, next) {
        const origin = info.origin || info.req.headers.origin || '';
        const allowed = origin.startsWith('http://localhost:');
        next(allowed);
      }
    }
  });

  // Serve static files in production
  const uiDistPath = path.join(__dirname, '..', 'ui', 'dist');
  try {
    await app.register(fastifyStatic, {
      root: uiDistPath,
      prefix: '/'
    });
  } catch (error) {
    console.log('Static file serving not available (dev mode)');
  }

  // REST API Routes

  // Agents API
  app.get('/api/agents', async () => {
    return { agents: agentStore.listAgents() };
  });

  app.post('/api/agents', async (request, reply) => {
    const body = request.body || {};
    const normalizedRole = normalizeRoleInput(body.role);
    if (normalizedRole.error) {
      return reply.status(400).send({ error: normalizedRole.error });
    }

    const agent = agentStore.createAgent({
      name: typeof body.name === 'string' ? body.name : '',
      role: normalizedRole.value,
      cliType: body.cliType,
      workingDir: body.workingDir,
      notes: body.notes,
      tags: normalizeStringArray(body.tags),
      skills: normalizeStringArray(body.skills),
      startupPrompt: typeof body.startupPrompt === 'string' ? body.startupPrompt : ''
    });

    broadcastDashboard({ type: 'agentUpdated', agent });
    return reply.status(201).send({ agent });
  });

  app.patch('/api/agents/:id', async (request, reply) => {
    const { id } = request.params;
    const body = request.body || {};
    const normalizedRole = normalizeRoleInput(body.role);
    if (normalizedRole.error) {
      return reply.status(400).send({ error: normalizedRole.error });
    }

    const updates = { ...body };
    if (body.role !== undefined) updates.role = normalizedRole.value;
    if (body.tags !== undefined) updates.tags = normalizeStringArray(body.tags);
    if (body.skills !== undefined) updates.skills = normalizeStringArray(body.skills);
    if (body.memory !== undefined) updates.memory = normalizeStringArray(body.memory);
    const agent = agentStore.updateAgent(id, updates);
    if (!agent) {
      return reply.status(404).send({ error: 'Agent not found' });
    }
    broadcastDashboard({ type: 'agentUpdated', agent });
    return { agent };
  });

  app.delete('/api/agents/:id', async (request, reply) => {
    const { id } = request.params;
    const agent = agentStore.deleteAgent(id);
    if (!agent) {
      return reply.status(404).send({ error: 'Agent not found' });
    }
    broadcastDashboard({ type: 'agentUpdated', agent });
    return { agent };
  });

  app.post('/api/agents/:id/start', async (request, reply) => {
    const { id } = request.params;
    const { workingDir: overrideWorkingDir } = request.body || {};
    const agent = agentStore.getAgent(id);
    if (!agent || agent.deletedAt) {
      return reply.status(404).send({ error: 'Agent not found' });
    }

    if (agent.activeSessionId) {
      const existing = sessionManager.getSession(agent.activeSessionId);
      if (existing && existing.status !== 'completed') {
        return { session: existing, agent };
      }
    }

    const effectiveWorkingDir = overrideWorkingDir || agent.workingDir;

    try {
      const session = sessionManager.createSession(
        agent.name,
        effectiveWorkingDir,
        agent.cliType,
        {},
        agent.role || '',
        { agentId: agent.id }
      );
      const updatedAgent = agentStore.updateAgent(id, {
        activeSessionId: session.id,
        lastActiveAt: new Date().toISOString(),
        sessionHistory: [...(agent.sessionHistory || []), session.id]
      });
      const liveSession = sessionManager.sessions.get(session.id);
      if (liveSession) {
        sessionManager.runStartupSequence(liveSession, updatedAgent || agent);
      }
      broadcastDashboard({ type: 'agentUpdated', agent: updatedAgent || agent });
      return { session, agent: updatedAgent || agent };
    } catch (error) {
      return reply.status(500).send({ error: error.message });
    }
  });

  app.post('/api/agents/:id/stop', async (request, reply) => {
    const { id } = request.params;
    const agent = agentStore.getAgent(id);
    if (!agent || agent.deletedAt) {
      return reply.status(404).send({ error: 'Agent not found' });
    }
    if (!agent.activeSessionId) {
      return { success: true, agent };
    }
    const snapshotBeforeStop = sessionManager.getSession(agent.activeSessionId);
    sessionManager.killSession(agent.activeSessionId);
    appendAgentMemoryFromSession(agent.id, snapshotBeforeStop);
    const updatedAgent = agentStore.updateAgent(id, {
      activeSessionId: null,
      lastActiveAt: new Date().toISOString()
    });
    broadcastDashboard({ type: 'agentUpdated', agent: updatedAgent || agent });
    return { success: true, agent: updatedAgent || agent };
  });

  app.post('/api/agents/:id/restart', async (request, reply) => {
    const { id } = request.params;
    const agent = agentStore.getAgent(id);
    if (!agent || agent.deletedAt) {
      return reply.status(404).send({ error: 'Agent not found' });
    }
    if (agent.activeSessionId) {
      const snapshotBeforeStop = sessionManager.getSession(agent.activeSessionId);
      sessionManager.killSession(agent.activeSessionId);
      appendAgentMemoryFromSession(id, snapshotBeforeStop);
      agentStore.updateAgent(id, { activeSessionId: null });
    }
    const refreshed = agentStore.getAgent(id);
    try {
      const session = sessionManager.createSession(
        refreshed.name,
        refreshed.workingDir,
        refreshed.cliType,
        {},
        refreshed.role || '',
        { agentId: refreshed.id }
      );
      const updatedAgent = agentStore.updateAgent(id, {
        activeSessionId: session.id,
        lastActiveAt: new Date().toISOString(),
        sessionHistory: [...(refreshed.sessionHistory || []), session.id]
      });
      const liveSession = sessionManager.sessions.get(session.id);
      if (liveSession) {
        sessionManager.runStartupSequence(liveSession, updatedAgent || refreshed);
      }
      broadcastDashboard({ type: 'agentUpdated', agent: updatedAgent || refreshed });
      return { session, agent: updatedAgent || refreshed };
    } catch (error) {
      return reply.status(500).send({ error: error.message });
    }
  });

  app.post('/api/agents/:id/rewarm', async (request, reply) => {
    const { id } = request.params;
    const agent = agentStore.getAgent(id);
    if (!agent || !agent.activeSessionId) {
      return reply.status(404).send({ error: 'Agent or active session not found' });
    }
    const snapshot = sessionManager.getSession(agent.activeSessionId);
    if (snapshot?.status === 'paused') {
      sessionManager.resumeSession(agent.activeSessionId);
    }
    const ok = sessionManager.rewarmSession(agent.activeSessionId, agent);
    if (!ok) {
      return reply.status(400).send({ error: 'Could not re-warm agent session' });
    }
    return { success: true };
  });

  // Team template APIs
  app.get('/api/teams', async () => {
    return { teams: teamStore.listTeams() };
  });

  app.post('/api/teams', async (request, reply) => {
    const normalized = validateTeamTemplateInput(request.body || {});
    if (normalized.error) {
      return reply.status(400).send({ error: normalized.error });
    }
    const team = teamStore.createTeam(normalized.value);
    return reply.status(201).send({ team });
  });

  app.get('/api/teams/:id', async (request, reply) => {
    const team = teamStore.getTeam(request.params.id);
    if (!team) {
      return reply.status(404).send({ error: 'Team not found' });
    }
    return { team };
  });

  app.patch('/api/teams/:id', async (request, reply) => {
    const existing = teamStore.getTeam(request.params.id);
    if (!existing) {
      return reply.status(404).send({ error: 'Team not found' });
    }
    if (existing.builtIn) {
      return reply.status(400).send({ error: 'Built-in teams cannot be modified' });
    }
    const normalized = validateTeamTemplateInput(request.body || {}, { partial: true, existing });
    if (normalized.error) {
      return reply.status(400).send({ error: normalized.error });
    }
    const team = teamStore.updateTeam(request.params.id, normalized.value);
    return { team };
  });

  app.delete('/api/teams/:id', async (request, reply) => {
    const existing = teamStore.getTeam(request.params.id);
    if (!existing) {
      return reply.status(404).send({ error: 'Team not found' });
    }
    if (existing.builtIn) {
      return reply.status(400).send({ error: 'Built-in teams cannot be deleted' });
    }
    teamStore.deleteTeam(request.params.id);
    return { ok: true };
  });

  app.post('/api/teams/:id/launch', async (request, reply) => {
    const team = teamStore.getTeam(request.params.id);
    if (!team) {
      return reply.status(404).send({ error: 'Team not found' });
    }

    const workingDir = typeof request.body?.workingDir === 'string' && request.body.workingDir.trim()
      ? request.body.workingDir.trim()
      : process.cwd();
    const goal = typeof request.body?.goal === 'string' ? request.body.goal.trim() : '';
    const orchestratorMember = (team.members || []).find((member) => member.isOrchestrator);
    const orchestratorTemplate = orchestratorMember ? AGENT_TEMPLATES[orchestratorMember.template] : null;
    if (!orchestratorMember || !orchestratorTemplate) {
      return reply.status(400).send({ error: 'Team is missing a valid orchestrator member' });
    }

    const teamInstance = teamStore.createTeamInstance({
      templateId: team.id,
      name: team.name,
      goal,
      strategy: team.strategy,
      orchestratorSessionId: null,
      sessionIds: [],
      status: 'active',
      completedAt: null
    });

    try {
      const existingNames = sessionManager.getAllSessions().map((session) => session.name);
      const orchestratorName = ensureUniqueSessionName(`${team.name} - ${orchestratorTemplate.name}`, existingNames);
      const orchestratorRole = buildTeamLaunchRole(orchestratorTemplate.role, team, goal);
      const orchestratorSession = sessionManager.createSession(
        orchestratorName,
        workingDir,
        orchestratorTemplate.cliType,
        {},
        orchestratorRole,
        {
          isOrchestrator: true,
          teamInstanceId: teamInstance.id
        }
      );

      let sessionIds = [orchestratorSession.id];
      teamStore.updateTeamInstance(teamInstance.id, {
        orchestratorSessionId: orchestratorSession.id,
        sessionIds
      });
      updateTeamInstanceMembership(null, teamInstance.id, orchestratorSession.id);

      if (orchestratorTemplate.cliType === 'claude' || orchestratorTemplate.cliType === 'codex') {
        const port = process.env.PORT || 5010;
        const bootstrapPrompt = `${buildOrchestratorPrompt(port, orchestratorSession.id)}\n\nTeam goal: ${goal || 'No explicit goal provided.'}\nStrategy: ${team.strategy}\nRoster:\n${buildTeamRoster(team)}`;
        setTimeout(() => {
          sessionManager.sendInput(orchestratorSession.id, bootstrapPrompt + '\r');
        }, 3000);
      }

      if (team.strategy === 'parallel') {
        for (const member of team.members.filter((item) => !item.isOrchestrator)) {
          const template = AGENT_TEMPLATES[member.template];
          if (!template) continue;
          const siblingSessions = sessionIds
            .slice(1)
            .map((sessionId) => sessionManager.getSession(sessionId))
            .filter(Boolean);
          const role = (template.cliType === 'claude' || template.cliType === 'codex')
            ? buildChildRoleContext(orchestratorSession, siblingSessions, template.role)
            : template.role;
          const memberName = ensureUniqueSessionName(`${team.name} - ${template.name}`, sessionManager.getAllSessions().map((session) => session.name));
          const childSession = sessionManager.createSession(
            memberName,
            workingDir,
            template.cliType,
            {},
            role,
            {
              parentSessionId: orchestratorSession.id,
              teamInstanceId: teamInstance.id
            }
          );
          sessionIds = [...sessionIds, childSession.id];
          teamStore.updateTeamInstance(teamInstance.id, { sessionIds });
          updateTeamInstanceMembership(null, teamInstance.id, childSession.id);

          const startupPrompt = buildTeamMemberStartupPrompt(team, member, goal, orchestratorSession);
          if (startupPrompt && (template.cliType === 'claude' || template.cliType === 'codex')) {
            setTimeout(() => {
              sessionManager.sendInput(childSession.id, startupPrompt + '\r');
            }, 2000);
          }
        }
      }

      return reply.status(201).send({ ok: true, teamInstance: enrichTeamInstance(teamStore.getTeamInstance(teamInstance.id)) });
    } catch (error) {
      teamStore.updateTeamInstance(teamInstance.id, {
        status: 'completed',
        completedAt: new Date().toISOString()
      });
      return reply.status(500).send({ error: `Failed to launch team: ${error.message}` });
    }
  });

  app.get('/api/team-instances', async () => {
    return {
      teamInstances: teamStore.listTeamInstances().map((instance) => enrichTeamInstance(instance))
    };
  });

  app.get('/api/team-instances/:id', async (request, reply) => {
    const instance = teamStore.getTeamInstance(request.params.id);
    if (!instance) {
      return reply.status(404).send({ error: 'Team instance not found' });
    }
    return { teamInstance: enrichTeamInstance(instance) };
  });

  // ─── Presets ────────────────────────────────────────────────────────
  app.get('/api/presets', async () => {
    return { presets: presetStore.list() };
  });

  app.get('/api/presets/:id', async (request, reply) => {
    const preset = presetStore.get(request.params.id);
    if (!preset) return reply.status(404).send({ error: 'Preset not found' });
    return { preset };
  });

  app.post('/api/presets', async (request, reply) => {
    try {
      const preset = presetStore.create(request.body);
      return reply.status(201).send({ preset });
    } catch (error) {
      return reply.status(400).send({ error: error.message });
    }
  });

  app.put('/api/presets/:id', async (request, reply) => {
    try {
      const preset = presetStore.update(request.params.id, request.body);
      if (!preset) return reply.status(404).send({ error: 'Preset not found' });
      return { preset };
    } catch (error) {
      return reply.status(400).send({ error: error.message });
    }
  });

  app.delete('/api/presets/:id', async (request, reply) => {
    const preset = presetStore.delete(request.params.id);
    if (!preset) return reply.status(404).send({ error: 'Preset not found' });
    return { ok: true };
  });

  app.post('/api/presets/:id/launch', async (request, reply) => {
    const preset = presetStore.get(request.params.id);
    if (!preset) return reply.status(404).send({ error: 'Preset not found' });

    const launched = [];
    const failed = [];

    for (let i = 0; i < preset.sessions.length; i++) {
      const entry = preset.sessions[i];
      const sessionName = entry.name || `${preset.name} #${i + 1}`;
      try {
        const session = sessionManager.createSession(
          sessionName,
          entry.workingDir,
          entry.cliType || 'claude',
          {},
          entry.role || ''
        );
        launched.push(session.id);

        if (entry.initialPrompt && entry.cliType !== 'terminal' && entry.cliType !== 'wsl') {
          const sid = session.id;
          setTimeout(() => {
            sessionManager.sendInput(sid, entry.initialPrompt + '\r');
          }, 2000);
        }
      } catch (error) {
        failed.push({ index: i, name: sessionName, error: error.message });
      }
    }

    return { launched, failed };
  });

  // List all sessions
  app.get('/api/sessions', async () => {
    return { sessions: sessionManager.getAllSessions() };
  });

  // Create a new session
  app.post('/api/sessions', async (request, reply) => {
    const { name, workingDir, cliType, stage, priority, description, role, isOrchestrator, parentSessionId, teamInstanceId, teamAction, teamName } = request.body || {};
    const normalizedRole = normalizeRoleInput(role);
    if (normalizedRole.error) {
      return reply.status(400).send({ error: normalizedRole.error });
    }

    // Validate cliType
    const validCliTypes = ['claude', 'codex', 'terminal', 'wsl'];
    const normalizedCliType = cliType && validCliTypes.includes(cliType) ? cliType : 'claude';
    const normalizedName = typeof name === 'string' ? name.trim() : '';
    const existingNames = sessionManager.getAllSessions().map(s => s.name);
    const resolvedName = normalizedName || ensureUniqueSessionName(generateSessionName(new Date(), normalizedCliType), existingNames);

    // Resolve team/orchestrator/parent from teamAction (new) or legacy fields
    let resolvedTeamInstanceId = teamInstanceId || null;
    let resolvedIsOrchestrator = !!isOrchestrator;
    let resolvedParentSessionId = parentSessionId || null;

    if (teamAction === 'new') {
      // Auto-create a new team instance, session becomes orchestrator
      const newTeam = teamStore.createTeamInstance({
        name: teamName || `${resolvedName}'s Team`,
        strategy: 'hierarchical',
        orchestratorSessionId: null, // set after session creation
        sessionIds: []
      });
      resolvedTeamInstanceId = newTeam.id;
      resolvedIsOrchestrator = true;
      resolvedParentSessionId = null;
    } else if (teamAction && teamAction !== 'none') {
      // Join existing team — teamAction is the team instance ID
      const team = teamStore.getTeamInstance(teamAction);
      if (!team) {
        return reply.status(400).send({ error: 'Team instance not found' });
      }
      resolvedTeamInstanceId = team.id;
      resolvedParentSessionId = team.orchestratorSessionId || null;
      resolvedIsOrchestrator = false;
    } else if (!teamAction) {
      // Legacy path: use explicit isOrchestrator/parentSessionId/teamInstanceId
      if (parentSessionId) {
        const parentSession = sessionManager.getSession(parentSessionId);
        if (!parentSession) {
          return reply.status(400).send({ error: 'Parent session not found' });
        }
        if (teamInstanceId && parentSession.teamInstanceId && teamInstanceId !== parentSession.teamInstanceId) {
          return reply.status(400).send({ error: 'teamInstanceId must match parent session team' });
        }
        resolvedTeamInstanceId = teamInstanceId || parentSession.teamInstanceId || null;
      }
    }

    if (resolvedTeamInstanceId && !teamStore.getTeamInstance(resolvedTeamInstanceId)) {
      return reply.status(400).send({ error: 'Team instance not found' });
    }

    try {
      const session = sessionManager.createSession(resolvedName, workingDir, normalizedCliType, {
        stage: stage || 'todo',
        priority: priority || 0,
        description: description || ''
      }, normalizedRole.value, {
        isOrchestrator: resolvedIsOrchestrator,
        parentSessionId: resolvedParentSessionId,
        teamInstanceId: resolvedTeamInstanceId
      });

      updateTeamInstanceMembership(null, resolvedTeamInstanceId, session.id);

      // For 'new' team, update orchestratorSessionId now that session exists
      if (teamAction === 'new' && resolvedTeamInstanceId) {
        teamStore.updateTeamInstance(resolvedTeamInstanceId, {
          orchestratorSessionId: session.id
        });
      }

      // Inject orchestrator prompt for AI sessions
      if (resolvedIsOrchestrator && (normalizedCliType === 'claude' || normalizedCliType === 'codex')) {
        const port = process.env.PORT || 5010;
        const orchestratorPrompt = buildOrchestratorPrompt(port, session.id);
        setTimeout(() => {
          sessionManager.sendInput(session.id, orchestratorPrompt + '\r');
        }, 3000);
      }

      return reply.status(201).send({ session });
    } catch (error) {
      return reply.status(500).send({ error: error.message });
    }
  });

  // List folders in a directory (for folder picker)
  app.get('/api/folders', async (request, reply) => {
    const roots = getBrowseRoots();
    const defaultRoot = roots[0] || { id: 'windows', label: 'Windows', path: normalizeWindowsPath(DEFAULT_FOLDERS_ROOT) };
    const requestedRoot = roots.find(root => root.id === request.query.rootId) || defaultRoot;
    const requestedBase = normalizeWindowsPath(request.query.base || requestedRoot.path) || requestedRoot.path;
    const activeRoot = getRootForPath(requestedBase, roots) || requestedRoot;
    const root = normalizeWindowsPath(activeRoot.path);

    try {
      if (!fs.existsSync(requestedBase) || !fs.statSync(requestedBase).isDirectory()) {
        return reply.status(400).send({ error: 'Requested path is not a directory', roots, root, defaultRoot: defaultRoot.path });
      }

      const entries = fs.readdirSync(requestedBase, { withFileTypes: true });
      const folders = entries
        .filter(e => e.isDirectory())
        .map(e => e.name)
        .sort();
      return {
        folders,
        base: requestedBase,
        root,
        rootId: activeRoot.id,
        roots,
        defaultRoot: defaultRoot.path
      };
    } catch (error) {
      return reply.status(500).send({ error: error.message, roots, root, defaultRoot: defaultRoot.path });
    }
  });

  // Create a child folder in the current folder picker directory
  app.post('/api/folders', async (request, reply) => {
    const roots = getBrowseRoots();
    const defaultRoot = roots[0] || { id: 'windows', label: 'Windows', path: normalizeWindowsPath(DEFAULT_FOLDERS_ROOT) };
    const requestedRoot = roots.find(root => root.id === request.body?.rootId) || defaultRoot;
    const requestedBase = normalizeWindowsPath(request.body?.base || requestedRoot.path) || requestedRoot.path;
    const activeRoot = getRootForPath(requestedBase, roots) || requestedRoot;
    const root = normalizeWindowsPath(activeRoot.path);
    const validation = validateFolderName(request.body?.name);

    if (!validation.valid) {
      return reply.status(400).send({ error: validation.error });
    }

    if (!isPathWithinRoot(requestedBase, root)) {
      return reply.status(400).send({ error: 'Requested path is outside the selected browse root' });
    }

    try {
      if (!fs.existsSync(requestedBase) || !fs.statSync(requestedBase).isDirectory()) {
        return reply.status(400).send({ error: 'Requested path is not a directory' });
      }

      const folderPath = joinBrowsePath(requestedBase, validation.name);
      if (fs.existsSync(folderPath)) {
        return reply.status(409).send({ error: 'Folder already exists' });
      }

      fs.mkdirSync(folderPath);
      return reply.status(201).send({
        folder: validation.name,
        path: folderPath,
        base: requestedBase,
        root,
        rootId: activeRoot.id
      });
    } catch (error) {
      return reply.status(500).send({ error: error.message });
    }
  });

  // Get a single session
  app.get('/api/sessions/:id', async (request, reply) => {
    const { id } = request.params;
    const session = sessionManager.getSession(id);

    if (!session) {
      return reply.status(404).send({ error: 'Session not found' });
    }

    return { session };
  });

  app.get('/api/sessions/:id/transcript', async (request, reply) => {
    const { id } = request.params;
    const session = sessionManager.getSession(id);

    if (!session) {
      return reply.status(404).send({ error: 'Session not found' });
    }

    const beforeBytes = request.query.before !== undefined
      ? parseInt(request.query.before, 10)
      : null;
    const limitBytes = request.query.limitBytes !== undefined
      ? parseInt(request.query.limitBytes, 10)
      : undefined;

    const transcript = sessionManager.getSessionTranscript(id, {
      beforeBytes: Number.isFinite(beforeBytes) ? beforeBytes : null,
      limitBytes: Number.isFinite(limitBytes) ? limitBytes : undefined
    });

    return { transcript };
  });

  // Update session metadata
  app.patch('/api/sessions/:id', async (request, reply) => {
    const { id } = request.params;
    const { name, notes, tags, cliType, role, isOrchestrator, parentSessionId, teamInstanceId, teamAction, teamName } = request.body || {};
    const normalizedRole = normalizeRoleInput(role);
    if (normalizedRole.error) {
      return reply.status(400).send({ error: normalizedRole.error });
    }

    const currentSession = sessionManager.getSession(id);
    if (!currentSession) {
      return reply.status(404).send({ error: 'Session not found' });
    }

    let resolvedParentSessionId = currentSession.parentSessionId || null;
    let resolvedTeamInstanceId = currentSession.teamInstanceId || null;
    let resolvedIsOrchestrator = currentSession.isOrchestrator || false;

    // Handle teamAction: 'new' — create a new team with this session as orchestrator
    if (teamAction === 'new') {
      if (currentSession.teamInstanceId) {
        return reply.status(400).send({ error: 'Session is already in a team. Remove it first.' });
      }
      const newTeam = teamStore.createTeamInstance({
        name: teamName || `${currentSession.name || name || 'Session'}'s Team`,
        strategy: 'hierarchical',
        orchestratorSessionId: id,
        sessionIds: [id]
      });
      resolvedTeamInstanceId = newTeam.id;
      resolvedIsOrchestrator = true;
      resolvedParentSessionId = null;
    } else if (parentSessionId !== undefined) {
      if (parentSessionId) {
        if (currentSession.parentSessionId && currentSession.parentSessionId !== parentSessionId) {
          return reply.status(400).send({ error: 'Cannot reparent a session that already has a parent' });
        }
        const parentSession = sessionManager.getSession(parentSessionId);
        if (!parentSession) {
          return reply.status(400).send({ error: 'Parent session not found' });
        }
        resolvedParentSessionId = parentSessionId;
        resolvedTeamInstanceId = teamInstanceId !== undefined
          ? (teamInstanceId || null)
          : (parentSession.teamInstanceId || null);
        if (resolvedTeamInstanceId && parentSession.teamInstanceId && resolvedTeamInstanceId !== parentSession.teamInstanceId) {
          return reply.status(400).send({ error: 'teamInstanceId must match parent session team' });
        }
      } else {
        resolvedParentSessionId = null;
        if (teamInstanceId === undefined) {
          resolvedTeamInstanceId = null;
        }
      }
    }

    if (teamInstanceId !== undefined && parentSessionId === undefined) {
      resolvedTeamInstanceId = teamInstanceId || null;
      // Auto-set parentSessionId to team's orchestrator when joining a team
      if (resolvedTeamInstanceId) {
        const teamInstance = teamStore.getTeamInstance(resolvedTeamInstanceId);
        if (teamInstance && teamInstance.orchestratorSessionId && teamInstance.orchestratorSessionId !== id) {
          resolvedParentSessionId = teamInstance.orchestratorSessionId;
        }
      } else {
        // Removing from team — also clear parent if it was the team orchestrator
        if (currentSession.teamInstanceId) {
          const oldTeam = teamStore.getTeamInstance(currentSession.teamInstanceId);
          if (oldTeam && currentSession.parentSessionId === oldTeam.orchestratorSessionId) {
            resolvedParentSessionId = null;
          }
        }
      }
    }

    if (resolvedTeamInstanceId && teamAction !== 'new') {
      const teamInstance = teamStore.getTeamInstance(resolvedTeamInstanceId);
      if (!teamInstance) {
        return reply.status(400).send({ error: 'Team instance not found' });
      }
      const orchestrator = sessionManager.getSession(teamInstance.orchestratorSessionId);
      if (!orchestrator || orchestrator.status === 'completed') {
        return reply.status(400).send({ error: 'Target team orchestrator is not active' });
      }
    }

    const session = sessionManager.updateSessionMeta(id, {
      name,
      notes,
      tags,
      cliType,
      role: role === undefined ? undefined : normalizedRole.value,
      isOrchestrator: teamAction === 'new' ? resolvedIsOrchestrator : isOrchestrator,
      parentSessionId: resolvedParentSessionId,
      teamInstanceId: resolvedTeamInstanceId
    });

    updateTeamInstanceMembership(currentSession.teamInstanceId || null, resolvedTeamInstanceId, id);

    // Best-effort prompt injection when toggling orchestrator on a running AI session
    if (isOrchestrator === true) {
      const liveSession = sessionManager.getSession(id);
      if (liveSession && liveSession.status !== 'completed' && liveSession.status !== 'paused') {
        const sessionCliType = liveSession.cliType || 'claude';
        if (sessionCliType === 'claude' || sessionCliType === 'codex') {
          const port = process.env.PORT || 5010;
          const orchestratorPrompt = buildOrchestratorPrompt(port, id);
          sessionManager.sendInput(id, orchestratorPrompt + '\r');
        }
      }
    }

    return { session };
  });

  // Kill a session
  app.delete('/api/sessions/:id', async (request, reply) => {
    const { id } = request.params;
    const success = sessionManager.killSession(id);

    if (!success) {
      // Session not in memory — try cleaning from dataStore (orphaned entry)
      const cleaned = sessionManager.dataStore.deleteSession(id);
      if (cleaned) {
        sessionManager.deleteSessionTranscript(id);
        sessionManager.emit('sessionKilled', { sessionId: id, session: { id } });
        return { success: true };
      }
      return reply.status(404).send({ error: 'Session not found' });
    }

    return { success: true };
  });

  // Pause a session
  app.post('/api/sessions/:id/pause', async (request, reply) => {
    const { id } = request.params;
    const success = sessionManager.pauseSession(id);

    if (!success) {
      return reply.status(400).send({ error: 'Could not pause session (not found or already paused/completed)' });
    }

    return { success: true, session: sessionManager.getSession(id) };
  });

  // Resume a paused session
  app.post('/api/sessions/:id/resume', async (request, reply) => {
    const { id } = request.params;
    const { fresh } = request.body || {};
    const success = sessionManager.resumeSession(id, { fresh: !!fresh });

    if (!success) {
      return reply.status(400).send({ error: 'Could not resume session (not found or not paused)' });
    }

    return { success: true, session: sessionManager.getSession(id) };
  });

  // Get plans for a session
  app.get('/api/sessions/:id/plans', async (request, reply) => {
    const { id } = request.params;
    const session = sessionManager.getSession(id);

    if (!session) {
      return reply.status(404).send({ error: 'Session not found' });
    }

    const plans = sessionManager.getSessionPlans(id);
    return { plans };
  });

  // Manually associate a plan with a session
  app.post('/api/sessions/:id/plans', async (request, reply) => {
    const { id } = request.params;
    const { planPath } = request.body || {};

    const session = sessionManager.getSession(id);
    if (!session) {
      return reply.status(404).send({ error: 'Session not found' });
    }

    if (!planPath) {
      return reply.status(400).send({ error: 'planPath is required' });
    }

    sessionManager.addOrUpdatePlanInSession(id, planPath);
    const plans = sessionManager.getSessionPlans(id);
    return { plans };
  });

  // Get Claude session transcript (user prompts from JSONL)
  app.get('/api/sessions/:id/claude-transcript', async (request, reply) => {
    const { id } = request.params;
    const session = sessionManager.getSession(id);

    if (!session) {
      return reply.status(404).send({ error: 'Session not found' });
    }

    if (!session.claudeSessionId) {
      return reply.status(400).send({ error: 'No Claude session ID linked' });
    }

    const transcript = sessionManager.getClaudeSessionTranscript(
      session.claudeSessionId,
      session.workingDir
    );

    if (!transcript) {
      return reply.status(404).send({ error: 'Claude session transcript not found' });
    }

    return { transcript };
  });

  // List available Claude sessions for linking
  app.get('/api/sessions/:id/available-claude-sessions', async (request, reply) => {
    const { id } = request.params;
    const session = sessionManager.getSession(id);

    if (!session) {
      return reply.status(404).send({ error: 'Session not found' });
    }

    const claudeSessions = sessionManager.listClaudeSessionsForLinking(session.workingDir);
    return { claudeSessions, currentClaudeSessionId: session.claudeSessionId };
  });

  // Manually link a Claude session ID to our session
  app.post('/api/sessions/:id/link-claude-session', async (request, reply) => {
    const { id } = request.params;
    const { claudeSessionId } = request.body || {};

    if (!claudeSessionId) {
      return reply.status(400).send({ error: 'claudeSessionId is required' });
    }

    const success = sessionManager.linkClaudeSession(id, claudeSessionId);

    if (!success) {
      return reply.status(404).send({ error: 'Session not found' });
    }

    return { success: true, claudeSessionId };
  });

  // Generate a Claude session ID and inject launch command into terminal
  app.post('/api/sessions/:id/generate-claude-session', async (request, reply) => {
    const { id } = request.params;
    const result = sessionManager.generateAndInjectClaudeSession(id);

    if (!result) {
      return reply.status(404).send({ error: 'Session not found' });
    }

    return { claudeSessionId: result.claudeSessionId, command: result.command };
  });

  // ============================================
  // Orchestrator Endpoints
  // ============================================

  // Rate limiting state for orchestrator endpoints
  const orchestratorRateLimit = new Map(); // sessionId -> { count, resetAt }
  const orchestratorLoopDetect = new Map(); // "fromId->toId" -> timestamps[]

  function checkOrchestratorRateLimit(sessionId) {
    const now = Date.now();
    let entry = orchestratorRateLimit.get(sessionId);
    if (!entry || now > entry.resetAt) {
      entry = { count: 0, resetAt: now + 1000 };
      orchestratorRateLimit.set(sessionId, entry);
    }
    entry.count++;
    return entry.count <= 30;
  }

  function checkLoopPrevention(fromSessionId, toSessionId) {
    const key = `${fromSessionId}->${toSessionId}`;
    const now = Date.now();
    let timestamps = orchestratorLoopDetect.get(key) || [];
    timestamps = timestamps.filter(t => now - t < 10000);
    timestamps.push(now);
    orchestratorLoopDetect.set(key, timestamps);
    return timestamps.length <= 3;
  }

  // Cleanup loop detection every 60 seconds
  setInterval(() => {
    const now = Date.now();
    for (const [key, timestamps] of orchestratorLoopDetect.entries()) {
      const recent = timestamps.filter(t => now - t < 10000);
      if (recent.length === 0) orchestratorLoopDetect.delete(key);
      else orchestratorLoopDetect.set(key, recent);
    }
  }, 60000);

  // 1.1 LIST — Get all sessions for orchestrator consumption
  app.get('/api/orchestrator/sessions', async () => {
    const allSessions = sessionManager.getAllSessions();
    return {
      sessions: allSessions.map(s => ({
        id: s.id,
        name: s.name,
        status: s.status,
        cliType: s.cliType,
        workingDir: s.workingDir,
        parentSessionId: s.parentSessionId || null,
        teamInstanceId: s.teamInstanceId || null,
        isOrchestrator: s.isOrchestrator || false,
        lastActivity: s.lastActivity
      }))
    };
  });

  // 1.2 READ — Read session screen output
  app.get('/api/orchestrator/sessions/:id/screen', async (request, reply) => {
    const { id } = request.params;
    const lines = Math.min(parseInt(request.query.lines) || 50, 500);
    const format = request.query.format || 'text';
    const sinceChunk = request.query.sinceChunk !== undefined ? parseInt(request.query.sinceChunk) : null;

    const output = sessionManager.getSessionOutput(id);
    if (output === null) {
      return reply.status(404).send({ error: 'Session not found' });
    }

    const session = sessionManager.getSession(id);
    let chunks = output;
    let startChunkIndex = 0;

    // Incremental read: only chunks after sinceChunk
    if (sinceChunk !== null && sinceChunk >= 0) {
      // sinceChunk is an absolute index; ring buffer may have rotated
      // We use the buffer length to calculate the offset
      const totalChunks = output.length;
      const startFrom = Math.max(0, sinceChunk);
      if (startFrom < totalChunks) {
        chunks = output.slice(startFrom);
        startChunkIndex = startFrom;
      } else {
        chunks = [];
        startChunkIndex = totalChunks;
      }
    }

    const rawText = chunks.join('');
    const screenText = format === 'raw' ? rawText : stripAnsi(rawText);

    // Take last N lines
    const allLines = screenText.split('\n');
    const lastLines = allLines.slice(-lines).join('\n');

    return {
      screen: lastLines,
      latestChunk: output.length,
      sessionId: id,
      status: session ? session.status : 'unknown'
    };
  });

  // 1.3a SEND by name — Resolve target by name/ID prefix, then send
  app.post('/api/orchestrator/send', async (request, reply) => {
    const { target, text, submit, fromSessionId } = request.body || {};
    if (!target || !text) {
      return reply.status(400).send({ error: 'target and text are required' });
    }

    // Only search active/reachable sessions (not completed/killed)
    const allSessions = sessionManager.getAllSessions().filter(s => s.status !== 'completed');
    // Resolve target in strict order: exact ID → exact name → ID prefix → partial name
    let matched = allSessions.find(s => s.id === target);
    if (!matched) {
      const lower = target.toLowerCase();
      matched = allSessions.find(s => s.name?.toLowerCase() === lower);
    }
    if (!matched) {
      const prefixMatches = allSessions.filter(s => s.id.startsWith(target));
      if (prefixMatches.length === 1) matched = prefixMatches[0];
    }
    if (!matched) {
      const lower = target.toLowerCase();
      const nameMatches = allSessions.filter(s => s.name?.toLowerCase().includes(lower));
      if (nameMatches.length === 1) matched = nameMatches[0];
      else if (nameMatches.length > 1) {
        return reply.status(400).send({
          error: 'Ambiguous target — multiple sessions match',
          matches: nameMatches.map(s => ({ id: s.id.substring(0, 8), name: s.name }))
        });
      }
    }
    if (!matched) {
      return reply.status(404).send({ error: `No session matching "${target}"` });
    }

    // Rate limiting
    if (fromSessionId && !checkOrchestratorRateLimit(fromSessionId)) {
      return reply.status(429).send({ error: 'Rate limit exceeded' });
    }
    if (fromSessionId && !checkLoopPrevention(fromSessionId, matched.id)) {
      return reply.status(429).send({ error: 'Loop detected' });
    }

    // Prepend sender attribution
    let messageText = text;
    if (fromSessionId) {
      const senderSession = sessionManager.getSession(fromSessionId);
      const senderName = senderSession?.name || fromSessionId.substring(0, 8);
      messageText = `[From: ${senderName}#${fromSessionId}] ${text}`;

      if (!recentSenders.has(matched.id)) recentSenders.set(matched.id, new Map());
      recentSenders.get(matched.id).set(fromSessionId, Date.now());
    }

    const inputText = submit ? messageText + '\r' : messageText;
    const result = sessionManager.sendOrEnqueue(matched.id, inputText, { fromSessionId });
    if (result.error === 'session_not_found') {
      return reply.status(404).send({ error: 'Session not found' });
    }
    if (result.error === 'session_completed') {
      return reply.status(404).send({ error: 'Session not active' });
    }
    if (result.error === 'queue_full') {
      return reply.status(429).send({ error: `Message queue full (max ${result.maxSize})` });
    }
    if (result.queued) {
      return { ok: true, queued: true, messageId: result.messageId, queuePosition: result.queuePosition, sessionId: matched.id, sessionName: matched.name };
    }
    return { ok: true, sessionId: matched.id, sessionName: matched.name, sent: text.substring(0, 200) };
  });

  // 1.3b SEND by ID — Send input to a session
  app.post('/api/orchestrator/sessions/:id/input', async (request, reply) => {
    const { id } = request.params;
    const { text, submit, fromSessionId } = request.body || {};

    if (!text || typeof text !== 'string') {
      return reply.status(400).send({ error: 'text is required' });
    }

    // Rate limiting
    if (fromSessionId && !checkOrchestratorRateLimit(fromSessionId)) {
      return reply.status(429).send({ error: 'Rate limit exceeded (30 req/s per session)' });
    }

    // Loop prevention
    if (fromSessionId && !checkLoopPrevention(fromSessionId, id)) {
      return reply.status(429).send({ error: 'Loop detected: too many sends between these sessions' });
    }

    // Prepend sender attribution if fromSessionId is provided
    let messageText = text;
    if (fromSessionId) {
      const senderSession = sessionManager.getSession(fromSessionId);
      const senderName = senderSession?.name || fromSessionId.substring(0, 8);
      messageText = `[From: ${senderName}#${fromSessionId}] ${text}`;

      // Track sender for reply notifications (expire after 5 minutes)
      if (!recentSenders.has(id)) recentSenders.set(id, new Map());
      recentSenders.get(id).set(fromSessionId, Date.now());
      // Clean up expired entries
      const senders = recentSenders.get(id);
      const expiry = Date.now() - 5 * 60 * 1000;
      for (const [sid, ts] of senders) {
        if (ts < expiry) senders.delete(sid);
      }
    }

    const result = sessionManager.sendOrEnqueue(id, messageText, { fromSessionId });

    if (result.error === 'session_not_found') {
      return reply.status(404).send({ error: 'Session not found' });
    }
    if (result.error === 'session_completed') {
      return reply.status(404).send({ error: 'Session not active' });
    }
    if (result.error === 'queue_full') {
      return reply.status(429).send({ error: `Message queue full (max ${result.maxSize})` });
    }

    // Send Enter as a separate write so TUI apps (Codex, Claude) recognize it as a keystroke
    if (submit) {
      if (result.sent) {
        setTimeout(() => sessionManager.sendInput(id, '\r'), 50);
      } else if (result.queued) {
        // Append Enter to the queued text message atomically instead of
        // enqueuing a separate \r. A separate \r would never drain because
        // text without \r doesn't trigger a status change to re-fire drainMessageQueue.
        const sess = sessionManager.sessions.get(id);
        if (sess?.messageQueue?.length) {
          const lastMsg = sess.messageQueue[sess.messageQueue.length - 1];
          if (lastMsg.id === result.messageId && lastMsg.status === 'queued') {
            lastMsg.text += '\r';
          }
        }
      }
    }

    if (result.queued) {
      return { ok: true, queued: true, messageId: result.messageId, queuePosition: result.queuePosition, sessionId: id };
    }

    return { ok: true, sessionId: id, sent: text.substring(0, 200) };
  });

  // 1.4 SPAWN — Create and start a new child session
  app.post('/api/orchestrator/sessions/spawn', async (request, reply) => {
    const { name, workingDir, cliType, role, startupPrompt, parentSessionId, planMode } = request.body || {};

    if (!parentSessionId) {
      return reply.status(400).send({ error: 'parentSessionId is required' });
    }

    // Verify parent exists
    const parentSession = sessionManager.getSession(parentSessionId);
    if (!parentSession) {
      return reply.status(404).send({ error: 'Parent session not found' });
    }

    const sessionName = name || `Child of ${parentSession.name}`;
    const sessionDir = workingDir || parentSession.workingDir;
    const sessionCliType = cliType || 'claude';
    const sessionRole = role || '';
    const inheritedTeamInstanceId = parentSession.teamInstanceId || null;
    let enrichedRole = sessionRole;

    if (sessionCliType === 'claude' || sessionCliType === 'codex') {
      const allSessions = sessionManager.getAllSessions();
      const siblings = allSessions.filter((s) =>
        s.parentSessionId === parentSessionId
      );
      enrichedRole = buildChildRoleContext(parentSession, siblings, sessionRole);
    }

    try {
      const session = sessionManager.createSession(
        sessionName,
        sessionDir,
        sessionCliType,
        {},
        enrichedRole,
        {
          parentSessionId,
          teamInstanceId: inheritedTeamInstanceId,
          startupPrompt: startupPrompt || '',
          planMode: planMode !== undefined ? planMode : (sessionCliType === 'claude')
        }
      );

      updateTeamInstanceMembership(null, inheritedTeamInstanceId, session.id);

      if (sessionCliType === 'claude' || sessionCliType === 'codex') {
        const allSessions = sessionManager.getAllSessions();
        const existingSiblings = allSessions.filter((s) =>
          s.parentSessionId === parentSessionId &&
          s.id !== session.id &&
          s.status !== 'completed'
        );

        for (const sibling of existingSiblings) {
          const siblingClients = terminalClients.get(sibling.id);
          if (!siblingClients) continue;

          const notification = JSON.stringify({
            type: 'easycc-notification',
            message: `New sibling "${sessionName}" (${session.id.substring(0, 8)}) joined the group.`,
            childSessionId: session.id,
            childName: sessionName
          });

          for (const client of siblingClients) {
            try {
              client.send(notification);
            } catch {}
          }
        }
      }

      const snapshot = sessionManager.getSession(session.id);
      return { ok: true, session: snapshot };
    } catch (error) {
      return reply.status(500).send({ error: `Failed to spawn session: ${error.message}` });
    }
  });

  // 1.5 STATUS — Lightweight status check
  app.get('/api/orchestrator/sessions/:id/status', async (request, reply) => {
    const { id } = request.params;
    const session = sessionManager.getSession(id);

    if (!session) {
      return reply.status(404).send({ error: 'Session not found' });
    }

    return {
      sessionId: id,
      status: session.status,
      lastActivity: session.lastActivity
    };
  });

  // Create a new plan from pasted content
  app.post('/api/plans', async (request, reply) => {
    const { content, name, sessionId } = request.body || {};

    if (!content || !content.trim()) {
      return reply.status(400).send({ error: 'Plan content is required' });
    }

    const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const session = sessionId ? sessionManager.getSession(sessionId) : null;
    const useProjectPlans = Boolean(
      session &&
      (session.cliType === 'codex' || session.cliType === 'terminal' || session.cliType === 'wsl') &&
      session.workingDir
    );
    const trimmedName = typeof name === 'string' ? name.trim() : '';
    const titleMatch = content.match(/^#\s+(.+)$/m);
    const titleFromContent = titleMatch ? titleMatch[1].trim() : '';
    const firstNonEmptyLine = getFirstNonEmptyLine(content);
    const randomSuffix = crypto.randomBytes(2).toString('hex');
    const generatedBaseName = `pasted-plan-${timestamp.slice(0, 16).replace(/-/g, '')}-${randomSuffix}`;
    const normalizedProvided = normalizePlanNameBase(trimmedName);
    const normalizedTitle = normalizePlanNameBase(titleFromContent);
    const normalizedFirstLine = normalizePlanNameBase(firstNonEmptyLine);
    const baseName = normalizedProvided ||
      (useProjectPlans ? normalizedFirstLine : normalizedTitle) ||
      normalizedTitle ||
      generatedBaseName;
    const safeName = baseName || generatedBaseName;
    const filename = `${safeName}-${timestamp}.md`;
    const plansDir = useProjectPlans
      ? path.join(session.workingDir, 'plans')
      : path.join(os.homedir(), '.claude', 'plans');
    const scope = useProjectPlans ? 'project' : 'claude-home';

    if (!fs.existsSync(plansDir)) {
      fs.mkdirSync(plansDir, { recursive: true });
    }

    const planPath = path.join(plansDir, filename);
    fs.writeFileSync(planPath, content, 'utf8');

    // Bootstrap into versioning system so PlanViewer shows toolbar + Save button
    planVersionStore.markDirty(planPath, content);
    planVersionStore.createVersion(planPath);

    const normalizedPlanPath = path.resolve(planPath);
    if (sessionId) {
      sessionManager.addOrUpdatePlanInSession(sessionId, normalizedPlanPath);
    }

    return { success: true, path: normalizedPlanPath, filename, scope, name: safeName };
  });

  // List plans not yet associated with a session
  app.get('/api/sessions/:id/available-plans', async (request, reply) => {
    const { id } = request.params;
    const session = sessionManager.getSession(id);

    if (!session) {
      return reply.status(404).send({ error: 'Session not found' });
    }

    const plansByPath = new Map();
    const sessionPlans = session.plans || [];

    for (const plan of planManager.listPlans()) {
      plansByPath.set(normalizePathKey(plan.path), plan);
    }

    if ((session.cliType === 'codex' || session.cliType === 'terminal' || session.cliType === 'wsl') && session.workingDir) {
      for (const plan of listProjectPlans(session.workingDir)) {
        plansByPath.set(normalizePathKey(plan.path), plan);
      }
    }

    const sessionPlanKeys = new Set(sessionPlans.map((planPath) => normalizePathKey(planPath)));
    const available = [...plansByPath.values()]
      .filter((plan) => !sessionPlanKeys.has(normalizePathKey(plan.path)))
      .sort((a, b) => new Date(b.modifiedAt) - new Date(a.modifiedAt));
    return { plans: available };
  });

  // Resize a session's terminal
  app.post('/api/sessions/:id/resize', async (request, reply) => {
    const { id } = request.params;
    const { cols, rows } = request.body || {};

    if (!cols || !rows || typeof cols !== 'number' || typeof rows !== 'number') {
      return reply.status(400).send({ error: 'cols and rows are required and must be numbers' });
    }

    const success = sessionManager.resizeSession(id, cols, rows);

    if (!success) {
      return reply.status(404).send({ error: 'Session not found or completed' });
    }

    return { success: true };
  });

  // Plans API

  // List all plans
  app.get('/api/plans', async () => {
    const plans = planManager.listPlans();
    return { plans };
  });

  // Get a specific plan
  app.get('/api/plans/:filename', async (request, reply) => {
    const { filename } = request.params;
    const plan = planManager.getPlanContent(filename);

    if (!plan) {
      return reply.status(404).send({ error: 'Plan not found' });
    }

    return { plan };
  });

  // Plan Version API

  // Get all versions for a plan
  app.get('/api/plans/:filename/versions', async (request, reply) => {
    const { filename } = request.params;
    const { workingDir, planPath: planPathQuery } = request.query || {};
    const resolved = resolvePlanPathForApi({ filename, planPath: planPathQuery });
    if (resolved.error) {
      const status = resolved.error === 'Invalid planPath' ? 400 : 404;
      return reply.status(status).send({ error: resolved.error });
    }
    const { planPath } = resolved;

    const versions = planVersionStore.getVersions(planPath);

    // If workingDir provided, mark which versions have been saved to {workingDir}/plans/
    let currentIsSaved = false;
    if (workingDir) {
      const savedHashes = new Set();
      const plansDir = path.join(workingDir, 'plans');
      if (fs.existsSync(plansDir)) {
        for (const f of fs.readdirSync(plansDir).filter(f => f.endsWith('.md'))) {
          try {
            const c = fs.readFileSync(path.join(plansDir, f), 'utf8').trim();
            savedHashes.add(crypto.createHash('md5').update(c).digest('hex'));
          } catch { /* skip unreadable files */ }
        }
      }
      versions.forEach(v => {
        if (v.contentHash && savedHashes.has(v.contentHash)) {
          v.isSaved = true;
        } else {
          // Fallback: re-read version file, trim, hash, compare (handles old versions with untrimmed hash)
          const vContent = planVersionStore.getVersionContent(planPath, v.filename);
          if (vContent) {
            v.isSaved = savedHashes.has(crypto.createHash('md5').update(vContent.trim()).digest('hex'));
          } else {
            v.isSaved = false;
          }
        }
      });
      // Check if the live/current plan content is saved
      if (savedHashes.size > 0) {
        const planContent = planManager.getPlanContent(planPath);
        if (planContent?.content) {
          currentIsSaved = savedHashes.has(
            crypto.createHash('md5').update(planContent.content.trim()).digest('hex')
          );
        }
      }
    }

    return { versions, planPath, currentIsSaved };
  });

  // Get a specific version's content
  app.get('/api/plans/:filename/versions/:versionFilename', async (request, reply) => {
    const { filename, versionFilename } = request.params;
    const { planPath: planPathQuery } = request.query || {};
    const resolved = resolvePlanPathForApi({ filename, planPath: planPathQuery });
    if (resolved.error) {
      const status = resolved.error === 'Invalid planPath' ? 400 : 404;
      return reply.status(status).send({ error: resolved.error });
    }
    const { planPath } = resolved;

    const content = planVersionStore.getVersionContent(planPath, versionFilename);

    if (!content) {
      return reply.status(404).send({ error: 'Version not found' });
    }

    return { content, versionFilename };
  });

  // Create a version snapshot manually
  app.post('/api/plans/:filename/versions', async (request, reply) => {
    const { filename } = request.params;
    const { planPath: planPathQuery } = request.query || {};
    const resolved = resolvePlanPathForApi({ filename, planPath: planPathQuery });
    if (resolved.error) {
      const status = resolved.error === 'Invalid planPath' ? 400 : 404;
      return reply.status(status).send({ error: resolved.error });
    }
    const { planPath } = resolved;

    const content = fs.readFileSync(planPath, 'utf8');
    planVersionStore.markDirty(planPath, content);
    const version = planVersionStore.createVersion(planPath);

    if (!version) {
      return { message: 'No changes to save' };
    }

    return { version };
  });

  // Delete a version
  app.delete('/api/plans/:filename/versions/:versionFilename', async (request, reply) => {
    const { filename, versionFilename } = request.params;
    // Sanitize to prevent path traversal (e.g. ../../etc/passwd)
    const safeVersionFilename = path.basename(versionFilename);
    if (!safeVersionFilename.endsWith('.md') && !safeVersionFilename.endsWith('.meta.json')) {
      return reply.status(403).send({ error: 'Invalid version filename' });
    }

    const planPath = planManager.getPlanPath(filename);

    if (!planPath) {
      return reply.status(404).send({ error: 'Plan not found' });
    }

    const planDir = planVersionStore.getPlanDir(planPath);
    const versionPath = path.join(planDir, safeVersionFilename);
    const metaPath = versionPath.replace('.md', '.meta.json');

    try {
      if (fs.existsSync(versionPath)) {
        fs.unlinkSync(versionPath);
      }
      if (fs.existsSync(metaPath)) {
        fs.unlinkSync(metaPath);
      }
      return { success: true };
    } catch (error) {
      return reply.status(500).send({ error: error.message });
    }
  });

  // Get diff between two versions
  app.get('/api/plans/:filename/diff', async (request, reply) => {
    const { filename } = request.params;
    const { from, to, planPath: planPathQuery } = request.query;
    const resolved = resolvePlanPathForApi({ filename, planPath: planPathQuery });
    if (resolved.error) {
      const status = resolved.error === 'Invalid planPath' ? 400 : 404;
      return reply.status(status).send({ error: resolved.error });
    }
    const { planPath } = resolved;

    if (!from || !to) {
      return reply.status(400).send({ error: 'Both "from" and "to" version filenames are required' });
    }

    const content1 = planVersionStore.getVersionContent(planPath, from);
    const content2 = planVersionStore.getVersionContent(planPath, to);

    if (!content1 || !content2) {
      return reply.status(404).send({ error: 'One or both versions not found' });
    }

    const diff = planVersionStore.diffVersions(content1, content2);
    return { diff, from, to };
  });

  // Save a plan version to the project's plans/ directory
  app.post('/api/plans/save', async (request, reply) => {
    const { content, title, versionNumber, versionDate, workingDir } = request.body || {};

    if (!content || !content.trim()) {
      return reply.status(400).send({ error: 'Plan content is required' });
    }
    if (!workingDir) {
      return reply.status(400).send({ error: 'workingDir is required' });
    }

    // Validate workingDir exists and is a real directory
    const resolvedDir = path.resolve(workingDir);
    if (!fs.existsSync(resolvedDir) || !fs.statSync(resolvedDir).isDirectory()) {
      return reply.status(400).send({ error: 'workingDir must be an existing directory' });
    }
    const realDir = fs.realpathSync(resolvedDir);

    const safeTitle = (title || 'plan').replace(/[^a-zA-Z0-9-_ ]/g, '').replace(/\s+/g, '-').slice(0, 60);
    const versionLabel = versionNumber ? `v${versionNumber}` : 'current';
    const dateStr = versionDate
      ? new Date(versionDate).toISOString().replace(/[:.]/g, '-').slice(0, 16)
      : new Date().toISOString().replace(/[:.]/g, '-').slice(0, 16);
    const filename = `${safeTitle}_${versionLabel}_${dateStr}.md`;

    const plansDir = path.join(realDir, 'plans');
    if (!fs.existsSync(plansDir)) {
      fs.mkdirSync(plansDir, { recursive: true });
    }

    const planPath = path.join(plansDir, filename);
    fs.writeFileSync(planPath, content, 'utf8');

    return { success: true, path: planPath, filename };
  });

  // List saved plans in a project's plans/ directory
  // Optional ?planFile= and/or ?planPath= filter: only return plans matching versions of that plan
  app.get('/api/saved-plans', async (request, reply) => {
    const { workingDir, planFile, planPath: planPathQuery } = request.query;
    if (!workingDir) {
      return reply.status(400).send({ error: 'workingDir query param is required' });
    }

    const plansDir = path.join(workingDir, 'plans');
    if (!fs.existsSync(plansDir)) {
      return { plans: [] };
    }

    try {
      const files = fs.readdirSync(plansDir).filter(f => f.endsWith('.md'));
      let plans = files.map(filename => {
        const filePath = path.join(plansDir, filename);
        const stat = fs.statSync(filePath);
        const content = fs.readFileSync(filePath, 'utf8');
        // Extract title from first h1 heading
        const titleMatch = content.match(/^#\s+(.+)$/m);
        const name = titleMatch ? titleMatch[1] : filename.replace(/\.md$/, '');
        return {
          filename,
          name,
          path: filePath,
          content,
          modifiedAt: stat.mtime.toISOString(),
          size: stat.size
        };
      });

      // Filter to only saved plans matching versions of a specific plan file
      if (planPathQuery || planFile) {
        let targetPlanPath = null;
        if (planPathQuery) {
          const resolved = resolvePlanPathForApi({ filename: planFile, planPath: planPathQuery });
          if (resolved.error) {
            const status = resolved.error === 'Invalid planPath' ? 400 : 404;
            return reply.status(status).send({ error: resolved.error });
          }
          targetPlanPath = resolved.planPath;
        } else if (planFile) {
          const resolved = resolvePlanPathForApi({ filename: planFile });
          if (!resolved.error) {
            targetPlanPath = resolved.planPath;
          }
        }

        if (targetPlanPath) {
          const versionHashes = new Set();
          const versions = planVersionStore.getVersions(targetPlanPath);
          versions.forEach(v => { if (v.contentHash) versionHashes.add(v.contentHash); });
          // Also include current/live content hash
          const currentContent = planManager.getPlanContent(targetPlanPath);
          if (currentContent?.content) {
            versionHashes.add(crypto.createHash('md5').update(currentContent.content.trim()).digest('hex'));
          }
          plans = plans.filter(p => {
            const hash = crypto.createHash('md5').update(p.content.trim()).digest('hex');
            return versionHashes.has(hash);
          });
        }
      }

      plans.sort((a, b) => new Date(b.modifiedAt) - new Date(a.modifiedAt));
      return { plans };
    } catch (error) {
      return reply.status(500).send({ error: `Failed to read plans: ${error.message}` });
    }
  });

  // Receive Claude Code lifecycle hook events (Stop, UserPromptSubmit, PreToolUse)
  // Hook script (backend/claude-hook.js) POSTs the JSON payload from stdin here.
  app.post('/api/hook-event', async (request, reply) => {
    const { hook_event_name, cwd, transcript_path } = request.body || {};
    if (!hook_event_name || !cwd) return reply.send({ ok: false });

    // Extract claudeSessionId from transcript filename: .../abc123.jsonl → abc123
    const claudeSessionId = transcript_path
      ? path.basename(transcript_path, '.jsonl')
      : null;

    const statusMap = {
      Stop: 'idle',
      UserPromptSubmit: 'active',
      PreToolUse: 'editing',
      Notification: 'idle',
    };
    const status = statusMap[hook_event_name];
    if (!status) return reply.send({ ok: true });

    sessionManager.applyHookStatus({ cwd, claudeSessionId, status, hookEvent: hook_event_name });
    return reply.send({ ok: true });
  });

  // Open a file or folder in the OS default application
  app.post('/api/open-path', async (request, reply) => {
    const { execFile } = require('child_process');
    const { filePath } = request.body || {};
    if (!filePath) return reply.status(400).send({ error: 'filePath is required' });

    // Validate path exists before opening
    const resolved = path.resolve(filePath);
    if (!fs.existsSync(resolved)) {
      return reply.status(404).send({ error: 'Path not found' });
    }

    try {
      if (process.platform === 'win32') {
        // Use explorer.exe directly — no cmd.exe shell parsing
        execFile('explorer.exe', [resolved]);
      } else if (process.platform === 'darwin') {
        execFile('open', [resolved]);
      } else {
        execFile('xdg-open', [resolved]);
      }
      return reply.send({ success: true });
    } catch (err) {
      return reply.status(500).send({ error: err.message });
    }
  });

  // Delete a saved plan — by path query param OR by content hash in body
  app.delete('/api/saved-plans', async (request, reply) => {
    const { path: filePath } = request.query;
    const { workingDir, content } = request.body || {};

    // Content-based deletion: find and delete files matching the content hash
    if (!filePath && workingDir && content) {
      const resolvedDir = path.resolve(workingDir);
      const plansDir = path.join(resolvedDir, 'plans');
      if (!fs.existsSync(plansDir) || !fs.statSync(plansDir).isDirectory()) {
        return reply.status(404).send({ error: 'No plans/ directory found' });
      }

      const targetHash = crypto.createHash('md5').update(content.trim()).digest('hex');
      const deletedFiles = [];

      try {
        const files = fs.readdirSync(plansDir).filter(f => f.endsWith('.md'));
        for (const file of files) {
          const fp = path.join(plansDir, file);
          const fileContent = fs.readFileSync(fp, 'utf8');
          const fileHash = crypto.createHash('md5').update(fileContent.trim()).digest('hex');
          if (fileHash === targetHash) {
            fs.unlinkSync(fp);
            deletedFiles.push(fp);
          }
        }
      } catch (error) {
        return reply.status(500).send({ error: `Failed to delete: ${error.message}` });
      }

      if (deletedFiles.length === 0) {
        return reply.status(404).send({ error: 'No saved plan matches the given content' });
      }
      return { success: true, deletedFiles };
    }

    // Path-based deletion (existing behavior)
    if (!filePath) {
      return reply.status(400).send({ error: 'path query param or { workingDir, content } body is required' });
    }

    // Security: resolve symlinks, only allow .md files inside plans/ directories
    const normalized = path.resolve(filePath);
    if (!normalized.endsWith('.md')) {
      return reply.status(403).send({ error: 'Can only delete .md files' });
    }

    try {
      if (!fs.existsSync(normalized)) return { success: true };
      // Resolve symlinks to get real path before checking parent
      const realPath = fs.realpathSync(normalized);
      const parentDir = path.basename(path.dirname(realPath));
      if (parentDir !== 'plans') {
        return reply.status(403).send({ error: 'Can only delete files in plans/ directories' });
      }
      fs.unlinkSync(realPath);
      return { success: true };
    } catch (error) {
      return reply.status(500).send({ error: `Failed to delete: ${error.message}` });
    }
  });

  // Get recent git commits for a working directory
  app.get('/api/git-commits', async (request, reply) => {
    const { execFile } = require('child_process');
    const { promisify } = require('util');
    const execFileAsync = promisify(execFile);

    const { workingDir, limit = '20' } = request.query;
    if (!workingDir) {
      return reply.status(400).send({ error: 'workingDir query param is required' });
    }

    // Check if directory is a git repo
    try {
      await execFileAsync('git', ['rev-parse', '--is-inside-work-tree'], {
        cwd: workingDir,
        timeout: 5000
      });
    } catch {
      return { commits: [], isGitRepo: false };
    }

    // Fetch commits (use record separator %x1e between commits to handle multi-line bodies)
    try {
      const n = Math.max(1, Math.min(parseInt(limit, 10) || 20, 100));
      const { stdout } = await execFileAsync('git', [
        'log', '--format=%H%x00%s%x00%b%x00%aI%x1e', `-n`, `${n}`
      ], { cwd: workingDir, timeout: 5000 });

      if (!stdout.trim()) {
        return { commits: [], isGitRepo: true };
      }

      const commits = stdout.split('\x1e')
        .map(record => record.trim())
        .filter(record => record.length > 0)
        .map(record => {
          const parts = record.split('\0');
          return {
            hash: parts[0] ? parts[0].substring(0, 7) : '',
            fullHash: parts[0] || '',
            subject: parts[1] || '',
            body: (parts[2] || '').trim(),
            date: parts[3] || ''
          };
        });

      return { commits, isGitRepo: true };
    } catch {
      return { commits: [], isGitRepo: true };
    }
  });

  // Settings API

  // Export projectAliases to ~/.claude/project-aliases.json for statusline integration
  function exportProjectAliases(aliases) {
    try {
      const claudeDir = path.join(os.homedir(), '.claude');
      if (!fs.existsSync(claudeDir)) {
        fs.mkdirSync(claudeDir, { recursive: true });
      }
      const aliasPath = path.join(claudeDir, 'project-aliases.json');
      fs.writeFileSync(aliasPath, JSON.stringify(aliases || {}, null, 2), 'utf8');
    } catch (e) { /* non-critical */ }
  }

  // Export aliases on startup
  exportProjectAliases(settingsManager.loadSettings().projectAliases);

  // Get current settings
  app.get('/api/settings', async () => {
    return { settings: settingsManager.loadSettings() };
  });

  // Get default settings
  app.get('/api/settings/defaults', async () => {
    return { settings: settingsManager.getDefaults() };
  });

  // Update settings
  app.put('/api/settings', async (request, reply) => {
    const updates = request.body;

    if (!updates || typeof updates !== 'object') {
      return reply.status(400).send({ error: 'Invalid settings payload' });
    }

    const settings = settingsManager.updateSettings(updates);
    exportProjectAliases(settings.projectAliases);
    return { settings };
  });

  // Reset settings to defaults
  app.post('/api/settings/reset', async () => {
    const settings = settingsManager.resetSettings();
    return { settings };
  });

  // Install Claude Code lifecycle hooks into ~/.claude/settings.json
  // so that Stop/UserPromptSubmit/PreToolUse events are forwarded to EasyCC.
  app.post('/api/settings/install-hooks', async (request, reply) => {
    const scriptPath = path.resolve(__dirname, 'claude-hook.js');
    const settingsPath = path.join(os.homedir(), '.claude', 'settings.json');

    // Ensure ~/.claude/ exists
    const claudeDir = path.join(os.homedir(), '.claude');
    if (!fs.existsSync(claudeDir)) {
      fs.mkdirSync(claudeDir, { recursive: true });
    }

    // Read existing settings non-destructively
    let existing = {};
    if (fs.existsSync(settingsPath)) {
      try {
        existing = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
      } catch (e) {
        return reply.status(500).send({ error: `Failed to parse existing settings: ${e.message}` });
      }
    }

    // Build hook command using node with the absolute script path
    const command = `node "${scriptPath}"`;
    const makeEntry = () => [{
      hooks: [{ type: 'command', command, timeout: 5 }]
    }];

    existing.hooks = existing.hooks || {};
    existing.hooks.Stop = makeEntry();
    existing.hooks.UserPromptSubmit = makeEntry();
    existing.hooks.PreToolUse = makeEntry();
    existing.hooks.Notification = [{
      matcher: 'idle_prompt',
      hooks: [{ type: 'command', command, timeout: 5 }]
    }];

    fs.writeFileSync(settingsPath, JSON.stringify(existing, null, 2), 'utf8');
    return { ok: true, settingsPath, events: ['Stop', 'UserPromptSubmit', 'PreToolUse', 'Notification'] };
  });

  // Check if Claude Code hooks are currently installed
  app.get('/api/settings/hooks-status', async () => {
    const settingsPath = path.join(os.homedir(), '.claude', 'settings.json');
    if (!fs.existsSync(settingsPath)) return { installed: false };
    try {
      const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
      const hooks = settings.hooks || {};
      const installed = !!(hooks.Stop && hooks.UserPromptSubmit && hooks.PreToolUse);
      return { installed, hooks: Object.keys(hooks) };
    } catch {
      return { installed: false };
    }
  });

  // Remove EasyCC hooks from ~/.claude/settings.json
  app.post('/api/settings/uninstall-hooks', async (request, reply) => {
    const settingsPath = path.join(os.homedir(), '.claude', 'settings.json');
    if (!fs.existsSync(settingsPath)) return { ok: true };

    try {
      const existing = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
      if (existing.hooks) {
        delete existing.hooks.Stop;
        delete existing.hooks.UserPromptSubmit;
        delete existing.hooks.PreToolUse;
        delete existing.hooks.Notification;
        if (Object.keys(existing.hooks).length === 0) delete existing.hooks;
      }
      fs.writeFileSync(settingsPath, JSON.stringify(existing, null, 2), 'utf8');
      return { ok: true };
    } catch (e) {
      return reply.status(500).send({ error: e.message });
    }
  });

  // ============================================
  // Session Kanban / Stage Routes
  // ============================================

  // Get sessions grouped by stage
  app.get('/api/sessions/by-stage', async () => {
    return { sessionsByStage: sessionManager.getSessionsByStage() };
  });

  // Get session stage stats
  app.get('/api/sessions/stats', async () => {
    return { stats: sessionManager.getStageStats() };
  });

  // Move session to a stage
  app.post('/api/sessions/:id/move', async (request, reply) => {
    const { id } = request.params;
    const { stage, reason } = request.body || {};

    if (!stage) {
      return reply.status(400).send({ error: 'Target stage is required' });
    }

    try {
      const session = sessionManager.moveSession(id, stage, { reason, source: 'manual' });
      return { session };
    } catch (error) {
      if (error.message.includes('not found')) {
        return reply.status(404).send({ error: error.message });
      }
      return reply.status(400).send({ error: error.message });
    }
  });

  // Advance session to next stage
  app.post('/api/sessions/:id/advance', async (request, reply) => {
    const { id } = request.params;

    try {
      const session = sessionManager.advanceSession(id);
      return { session };
    } catch (error) {
      if (error.message.includes('not found')) {
        return reply.status(404).send({ error: error.message });
      }
      return reply.status(400).send({ error: error.message });
    }
  });

  // Reject session to previous stage
  app.post('/api/sessions/:id/reject', async (request, reply) => {
    const { id } = request.params;
    const { reason, targetStage } = request.body || {};

    if (!reason) {
      return reply.status(400).send({ error: 'Rejection reason is required' });
    }

    try {
      const session = sessionManager.rejectSession(id, reason, targetStage);
      return { session };
    } catch (error) {
      if (error.message.includes('not found')) {
        return reply.status(404).send({ error: error.message });
      }
      return reply.status(400).send({ error: error.message });
    }
  });

  // Add dependency between sessions
  app.post('/api/sessions/:id/dependencies', async (request, reply) => {
    const { id } = request.params;
    const { blockerId } = request.body || {};

    if (!blockerId) {
      return reply.status(400).send({ error: 'blockerId is required' });
    }

    try {
      const session = sessionManager.addDependency(id, blockerId);
      return { session };
    } catch (error) {
      if (error.message.includes('not found')) {
        return reply.status(404).send({ error: error.message });
      }
      return reply.status(400).send({ error: error.message });
    }
  });

  // Remove dependency
  app.delete('/api/sessions/:id/dependencies/:blockerId', async (request, reply) => {
    const { id, blockerId } = request.params;

    try {
      const session = sessionManager.removeDependency(id, blockerId);
      return { session };
    } catch (error) {
      if (error.message.includes('not found')) {
        return reply.status(404).send({ error: error.message });
      }
      return reply.status(400).send({ error: error.message });
    }
  });

  // Lock session to current column
  app.post('/api/sessions/:id/lock-placement', async (request, reply) => {
    const { id } = request.params;

    try {
      const session = sessionManager.lockPlacement(id);
      return { session };
    } catch (error) {
      if (error.message.includes('not found')) {
        return reply.status(404).send({ error: error.message });
      }
      return reply.status(500).send({ error: error.message });
    }
  });

  // Reset manual placement
  app.post('/api/sessions/:id/reset-placement', async (request, reply) => {
    const { id } = request.params;

    try {
      const session = sessionManager.resetManualPlacement(id);
      return { session };
    } catch (error) {
      if (error.message.includes('not found')) {
        return reply.status(404).send({ error: error.message });
      }
      return reply.status(500).send({ error: error.message });
    }
  });

  // Add comment to session
  app.post('/api/sessions/:id/comments', async (request, reply) => {
    const { id } = request.params;
    const { text, author, parentId, mentions } = request.body || {};

    if (!text || !text.trim()) {
      return reply.status(400).send({ error: 'Comment text is required' });
    }

    try {
      const comment = sessionManager.addComment(id, {
        text: text.trim(),
        author: author || 'user',
        parentId: parentId || null,
        mentions: Array.isArray(mentions) ? mentions : []
      });
      return { comment };
    } catch (error) {
      if (error.message.includes('not found')) {
        return reply.status(404).send({ error: error.message });
      }
      return reply.status(500).send({ error: error.message });
    }
  });

  // Get comments for session
  app.get('/api/sessions/:id/comments', async (request, reply) => {
    const { id } = request.params;
    const session = sessionManager.getSession(id);

    if (!session) {
      return reply.status(404).send({ error: 'Session not found' });
    }

    return { comments: session.comments || [] };
  });

  // Session message queue API
  app.get('/api/sessions/:id/queue', async (request, reply) => {
    const queue = sessionManager.getMessageQueue(request.params.id);
    if (queue === null) {
      return reply.status(404).send({ error: 'Session not found' });
    }
    return { queue };
  });

  app.delete('/api/sessions/:id/queue', async (request, reply) => {
    const success = sessionManager.clearMessageQueue(request.params.id);
    if (!success) {
      return reply.status(404).send({ error: 'Session not found' });
    }
    return { ok: true };
  });

  // Session comment reactions (toggle)
  app.post('/api/sessions/:id/comments/:commentId/reactions', async (request, reply) => {
    const { emoji, author } = request.body || {};
    if (!emoji) return reply.status(400).send({ error: 'emoji is required' });
    const comment = sessionManager.addReaction(request.params.id, request.params.commentId, emoji, author || 'user');
    if (!comment) return reply.status(404).send({ error: 'Session or comment not found' });
    return { comment };
  });

  // Task comment reactions (toggle)
  app.post('/api/tasks/:id/comments/:commentId/reactions', async (request, reply) => {
    const { emoji, author } = request.body || {};
    if (!emoji) return reply.status(400).send({ error: 'emoji is required' });
    const comment = taskStore.addReaction(request.params.id, request.params.commentId, emoji, author || 'user');
    if (!comment) return reply.status(404).send({ error: 'Task or comment not found' });
    const task = taskStore.getTask(request.params.id);
    broadcastDashboard({ type: 'taskUpdated', task });
    return { comment };
  });

  // Task cards API (first-class task entities)
  app.get('/api/tasks', async () => {
    return { tasks: taskStore.listTasks() };
  });

  app.post('/api/tasks', async (request, reply) => {
    const body = request.body || {};
    if (!body.title || !String(body.title).trim()) {
      return reply.status(400).send({ error: 'title is required' });
    }
    const task = taskStore.createTask({
      title: String(body.title),
      description: typeof body.description === 'string' ? body.description : '',
      planContent: typeof body.planContent === 'string' ? body.planContent : '',
      assignedAgents: normalizeStringArray(body.assignedAgents),
      stage: typeof body.stage === 'string' ? body.stage : 'todo',
      priority: Number.isFinite(body.priority) ? body.priority : 0,
      blockedBy: normalizeStringArray(body.blockedBy),
      blocks: normalizeStringArray(body.blocks)
    });
    broadcastDashboard({ type: 'taskUpdated', task });
    return reply.status(201).send({ task });
  });

  app.get('/api/tasks/:id', async (request, reply) => {
    const task = taskStore.getTask(request.params.id);
    if (!task) return reply.status(404).send({ error: 'Task not found' });
    return { task };
  });

  app.patch('/api/tasks/:id', async (request, reply) => {
    const task = taskStore.updateTask(request.params.id, request.body || {});
    if (!task) return reply.status(404).send({ error: 'Task not found' });
    broadcastDashboard({ type: 'taskUpdated', task });
    return { task };
  });

  app.delete('/api/tasks/:id', async (request, reply) => {
    const task = taskStore.deleteTask(request.params.id);
    if (!task) return reply.status(404).send({ error: 'Task not found' });
    broadcastDashboard({ type: 'taskUpdated', task });
    return { task };
  });

  app.post('/api/tasks/:id/assign', async (request, reply) => {
    const { assignedAgents } = request.body || {};
    const task = taskStore.updateTask(request.params.id, { assignedAgents: normalizeStringArray(assignedAgents) });
    if (!task) return reply.status(404).send({ error: 'Task not found' });
    broadcastDashboard({ type: 'taskUpdated', task });
    return { task };
  });

  app.post('/api/tasks/:id/start-run', async (request, reply) => {
    const task = taskStore.getTask(request.params.id);
    if (!task || task.archivedAt) return reply.status(404).send({ error: 'Task not found' });

    const { agentId } = request.body || {};
    if (!agentId || typeof agentId !== 'string') {
      return reply.status(400).send({ error: 'agentId is required' });
    }

    const agent = agentStore.getAgent(agentId);
    if (!agent || agent.deletedAt) {
      return reply.status(404).send({ error: 'Agent not found' });
    }

    const result = startAgentForTask(agent, task);
    if (result.error) {
      return reply.status(500).send({ error: result.error });
    }

    const taskWithRun = taskStore.getTask(task.id);
    broadcastDashboard({ type: 'taskUpdated', task: taskWithRun });
    return { task: taskWithRun, session: result.session };
  });

  app.post('/api/tasks/:id/stop-run', async (request, reply) => {
    const task = taskStore.getTask(request.params.id);
    if (!task || task.archivedAt) return reply.status(404).send({ error: 'Task not found' });

    const { agentId } = request.body || {};
    if (!agentId || typeof agentId !== 'string') {
      return reply.status(400).send({ error: 'agentId is required' });
    }

    const agent = agentStore.getAgent(agentId);
    if (!agent || agent.deletedAt) {
      return reply.status(404).send({ error: 'Agent not found' });
    }

    const activeRun = getActiveRunForAgent(task, agent.id);
    const targetSessionId = activeRun?.sessionId || null;
    if (!targetSessionId) {
      return reply.status(400).send({ error: 'No active run for this agent on this task' });
    }

    const session = sessionManager.getSession(targetSessionId);
    if (session && session.status !== 'completed' && session.status !== 'killed') {
      sessionManager.killSession(targetSessionId);
    }

    taskStore.closeRun(task.id, {
      sessionId: targetSessionId,
      agentId: agent.id,
      endedAt: new Date().toISOString(),
      status: 'stopped'
    });

    const updatedTask = taskStore.getTask(task.id);
    broadcastDashboard({ type: 'taskUpdated', task: updatedTask });
    return { task: updatedTask };
  });

  app.post('/api/tasks/:id/comments', async (request, reply) => {
    const body = request.body || {};
    let text = typeof body.text === 'string' ? body.text.trim() : '';
    if (!text) return reply.status(400).send({ error: 'Comment text is required' });

    const task = taskStore.getTask(request.params.id);
    if (!task || task.archivedAt) return reply.status(404).send({ error: 'Task not found' });

    // Process @spawn:template-id mentions BEFORE normal mention resolution
    const spawnedAgentIds = [];
    const spawnMatches = text.match(/@(?:spawn|new):(\S+)/g);
    const processedTemplates = new Set();
    if (spawnMatches) {
      for (const match of spawnMatches) {
        const templateId = match.replace(/@(?:spawn|new):/, '');
        if (processedTemplates.has(templateId)) continue; // Skip duplicates
        processedTemplates.add(templateId);

        const template = AGENT_TEMPLATES[templateId];
        if (!template) continue; // Unknown template — will be ignored

        // Create agent from template
        const commentIdSuffix = (body._commentId || require('uuid').v4()).slice(0, 4);
        const newAgent = agentStore.createAgent({
          name: `${template.name}-${commentIdSuffix}`,
          cliType: template.cliType || 'claude',
          role: template.role || '',
          workingDir: process.cwd()
        });

        // Assign agent to task
        const currentAssigned = task.assignedAgents || [];
        if (!currentAssigned.includes(newAgent.id)) {
          taskStore.updateTask(request.params.id, {
            assignedAgents: [...currentAssigned, newAgent.id]
          });
        }

        spawnedAgentIds.push({ agentId: newAgent.id, templateId });
        // Replace @spawn:template in text with @AgentName for stored comment
        text = text.replace(match, `@${newAgent.name}#${newAgent.id}`);
      }
    }

    const mentions = resolveMentionAgentIds(text, body.mentions);
    const comment = taskStore.addComment(request.params.id, {
      author: body.author || 'user',
      text,
      mentions,
      parentId: body.parentId || null
    });
    if (!comment) return reply.status(404).send({ error: 'Task not found' });

    const delivered = [];
    const skipped = [];
    let autoStartedAgents = null;
    const spawnedAgentIdSet = new Set(spawnedAgentIds.map(s => s.agentId));

    // Mention delivery: prefer active run linked to this task, fall back to active agent session.
    // If no session exists, auto-spawn the agent for this task.
    for (const agentId of mentions) {
      const agent = agentStore.getAgent(agentId);
      if (!agent) {
        skipped.push({ agentId, reason: 'agent_not_found' });
        continue;
      }
      let targetSessionId = null;
      const activeRun = getActiveRunForAgent(taskStore.getTask(request.params.id), agent.id);
      if (activeRun?.sessionId) {
        targetSessionId = activeRun.sessionId;
      } else if (agent.activeSessionId) {
        targetSessionId = agent.activeSessionId;
      }
      if (!targetSessionId) {
        // Auto-spawn: start the agent for this task instead of skipping
        const spawnResult = startAgentForTask(agent, taskStore.getTask(request.params.id));
        if (spawnResult.error) {
          skipped.push({ agentId, reason: 'spawn_failed', error: spawnResult.error });
          continue;
        }
        targetSessionId = spawnResult.session.id;
        // Flag that this agent was auto-started
        autoStartedAgents = autoStartedAgents || new Set();
        autoStartedAgents.add(agentId);
      }
      const taskForMention = taskStore.getTask(request.params.id);
      const taskTitle = taskForMention?.title || 'Untitled';
      const agentName = agent.name || 'unknown';
      const instruction = `[Task mention] (task: ${request.params.id} | "${taskTitle}")\nTo: ${agentName} (session: ${targetSessionId})\nMessage: ${text}\nReply with: /ec-task-comment ${request.params.id} <your response>\r`;
      const sendResult = sessionManager.sendOrEnqueue(targetSessionId, instruction);
      const autoStarted = autoStartedAgents?.has(agentId) || false;
      const spawned = spawnedAgentIdSet.has(agentId);
      const extraFlags = { ...(autoStarted && { autoStarted: true }), ...(spawned && { spawned: true }) };
      if (sendResult.sent) {
        delivered.push({ agentId, sessionId: targetSessionId, ...extraFlags });
      } else if (sendResult.queued) {
        delivered.push({ agentId, sessionId: targetSessionId, queued: true, queuePosition: sendResult.queuePosition, ...extraFlags });
      } else {
        skipped.push({ agentId, reason: sendResult.error || 'input_rejected', sessionId: targetSessionId });
      }
    }

    const updatedTask = taskStore.getTask(request.params.id);
    broadcastDashboard({ type: 'taskUpdated', task: updatedTask });
    return { comment, task: updatedTask, delivered, skipped };
  });

  app.post('/api/tasks/:id/auto-comment', async (request, reply) => {
    const body = request.body || {};
    const text = typeof body.text === 'string' ? body.text.trim() : '';
    if (!text) return reply.status(400).send({ error: 'Comment text is required' });
    // Resolve author from sessionId if provided
    let author = body.author || 'agent';
    if (body.sessionId) {
      const sess = sessionManager.getSession(body.sessionId);
      if (sess) author = sess.name || author;
    }
    const comment = taskStore.addComment(request.params.id, {
      author,
      text,
      mentions: normalizeStringArray(body.mentions)
    });
    if (!comment) return reply.status(404).send({ error: 'Task not found' });
    const task = taskStore.getTask(request.params.id);
    broadcastDashboard({ type: 'taskUpdated', task });
    return { comment, task };
  });

  // ============================================
  // Stages API
  // ============================================

  // Get all stages
  app.get('/api/stages', async () => {
    return { stages: sessionManager.getStages() };
  });

  // Update stages configuration
  app.put('/api/stages', async (request, reply) => {
    const { stages } = request.body || {};

    if (!stages || !Array.isArray(stages)) {
      return reply.status(400).send({ error: 'stages array is required' });
    }

    try {
      const updatedStages = sessionManager.updateStages(stages);
      return { stages: updatedStages };
    } catch (error) {
      return reply.status(500).send({ error: error.message });
    }
  });

  // ============================================
  // Transitions API
  // ============================================

  // Get recent transitions (for analytics/audit)
  app.get('/api/transitions', async (request, reply) => {
    const limit = parseInt(request.query.limit || '100', 10);
    return { transitions: dataStore.getRecentTransitions(limit) };
  });

  // WebSocket: Dashboard updates
  app.register(async function (fastify) {
    fastify.get('/socket/dashboard', { websocket: true }, (socket, req) => {
      dashboardClients.add(socket);

      // Send initial sessions list
      socket.send(JSON.stringify({
        type: 'init',
        sessions: sessionManager.getAllSessions(),
        agents: agentStore.listAgents(),
        tasks: taskStore.listTasks()
      }));

      socket.on('close', () => {
        dashboardClients.delete(socket);
      });

      socket.on('error', (error) => {
        console.error('Dashboard WebSocket error:', error.message);
        dashboardClients.delete(socket);
      });
    });
  });

  // WebSocket: Terminal I/O
  app.register(async function (fastify) {
    fastify.get('/socket/sessions/:id/terminal', { websocket: true }, (socket, req) => {
      const { id } = req.params;
      const session = sessionManager.getSession(id);

      if (!session) {
        socket.send(JSON.stringify({ type: 'error', error: 'Session not found' }));
        socket.close();
        return;
      }

      // Add to terminal clients
      if (!terminalClients.has(id)) {
        terminalClients.set(id, new Set());
      }
      terminalClients.get(id).add(socket);

      // Send session status (for paused indicator)
      socket.send(JSON.stringify({
        type: 'status',
        status: session.status
      }));

      // Send buffered output after a short delay to allow proxy to fully establish
      setTimeout(() => {
        const output = sessionManager.getSessionOutput(id);
        if (output && output.length > 0) {
          try {
            const replay = prepareTerminalReplayPayload(output);
            socket.send(JSON.stringify({
              type: 'output',
              data: replay.data
            }));
          } catch (e) {
            // Socket may have closed
          }
        }
      }, 100);

      // Handle incoming messages (user input)
      socket.on('message', (message) => {
        try {
          const parsed = JSON.parse(message.toString());

          if (parsed.type === 'input' && parsed.data) {
            sessionManager.sendInput(id, parsed.data);
          } else if (parsed.type === 'resize' && parsed.cols && parsed.rows) {
            sessionManager.resizeSession(id, parsed.cols, parsed.rows);
          }
        } catch (error) {
          console.error('Error parsing terminal message:', error.message);
        }
      });

      socket.on('close', () => {
        const clients = terminalClients.get(id);
        if (clients) {
          clients.delete(socket);
          if (clients.size === 0) {
            terminalClients.delete(id);
          }
        }
      });

      socket.on('error', (error) => {
        console.error('Terminal WebSocket error:', error.message);
        const clients = terminalClients.get(id);
        if (clients) {
          clients.delete(socket);
        }
      });
    });
  });

  // Session manager event handlers

  const clearActiveSessionFromAgents = (sessionId) => {
    const agents = agentStore.listAgents({ includeDeleted: true });
    for (const agent of agents) {
      if (agent.activeSessionId === sessionId) {
        const updated = agentStore.updateAgent(agent.id, {
          activeSessionId: null,
          lastActiveAt: new Date().toISOString()
        });
        if (updated) {
          broadcastDashboard({ type: 'agentUpdated', agent: updated });
        }
      }
    }
  };

  const appendAgentMemoryFromSession = (agentId, sessionSnapshot) => {
    if (!agentId || !sessionSnapshot) return;
    const agent = agentStore.getAgent(agentId);
    if (!agent || agent.memoryEnabled === false) return;
    const history = Array.isArray(sessionSnapshot.promptHistory) ? sessionSnapshot.promptHistory : [];
    const latest = history.slice(-3).map((entry) => entry?.text).filter(Boolean);
    if (latest.length === 0) return;
    const memory = [...(agent.memory || []), ...latest.map((text) => `Session ${sessionSnapshot.id.slice(0, 8)}: ${text.slice(0, 180)}`)];
    const deduped = [...new Set(memory)].slice(-50);
    const updated = agentStore.updateAgent(agent.id, { memory: deduped });
    if (updated) {
      broadcastDashboard({ type: 'agentUpdated', agent: updated });
    }
  };

  const closeTaskRunForSession = (sessionSnapshot, status = 'completed') => {
    if (!sessionSnapshot?.taskId || !sessionSnapshot?.id) return;
    const closed = taskStore.closeRun(sessionSnapshot.taskId, {
      sessionId: sessionSnapshot.id,
      agentId: sessionSnapshot.agentId || null,
      endedAt: new Date().toISOString(),
      status
    });
    if (!closed) return;
    const updatedTask = taskStore.getTask(sessionSnapshot.taskId);
    if (updatedTask) {
      broadcastDashboard({ type: 'taskUpdated', task: updatedTask });
    }
  };

  // Broadcast output to terminal clients
  sessionManager.on('output', ({ sessionId, data }) => {
    const clients = terminalClients.get(sessionId);
    if (clients) {
      const message = JSON.stringify({ type: 'output', data });
      for (const client of clients) {
        try {
          client.send(message);
        } catch (error) {
          console.error('Error sending to terminal client:', error.message);
        }
      }
    }
  });

  // Broadcast new session creation to all dashboard clients
  sessionManager.on('sessionCreated', ({ id, session }) => {
    broadcastDashboard({ type: 'sessionCreated', session });
  });

  // Broadcast status changes to dashboard clients
  sessionManager.on('statusChange', ({ sessionId, status, currentTask }) => {
    const message = JSON.stringify({
      type: 'statusChange',
      sessionId,
      status,
      currentTask
    });

    for (const client of dashboardClients) {
      try {
        client.send(message);
      } catch (error) {
        console.error('Error sending to dashboard client:', error.message);
      }
    }

    // Also notify terminal clients about status changes (for paused overlay)
    const termClients = terminalClients.get(sessionId);
    if (termClients) {
      const statusMessage = JSON.stringify({ type: 'status', status });
      for (const client of termClients) {
        try {
          client.send(statusMessage);
        } catch (error) {
          console.error('Error sending status to terminal client:', error.message);
        }
      }
    }

    const session = sessionManager.getSession(sessionId);
    if (session?.agentId) {
      const agent = agentStore.getAgent(session.agentId);
      if (agent) {
        const updated = agentStore.updateAgent(agent.id, {
          activeSessionId: sessionId,
          lastActiveAt: new Date().toISOString()
        });
        if (updated) {
          broadcastDashboard({ type: 'agentUpdated', agent: updated });
        }

        // Idle auto-comments removed — they were too noisy.
        // Agents can post meaningful updates via /ec-task-comment instead.
      }
    }
  });

  sessionManager.on('statusChange', ({ sessionId, status }) => {
    if (status === 'thinking' || status === 'active') {
      activeChildren.add(sessionId);
      return;
    }

    if (status === 'completed' || status === 'paused') {
      activeChildren.delete(sessionId);
      return;
    }

    if (status !== 'idle' || !activeChildren.has(sessionId)) return;
    activeChildren.delete(sessionId);

    const session = sessionManager.sessions.get(sessionId);
    if (!session?.parentSessionId) return;
    if (!sessionManager.sessions.has(session.parentSessionId)) return;

    const parentTermClients = terminalClients.get(session.parentSessionId);
    if (!parentTermClients) return;

    const notification = JSON.stringify({
      type: 'easycc-notification',
      message: `Child "${session.name}" (${sessionId.substring(0, 8)}) is now idle. Use /ec-read ${session.name} to see results.`,
      childSessionId: sessionId,
      childName: session.name
    });

    for (const client of parentTermClients) {
      try {
        client.send(notification);
      } catch {}
    }
  });

  // Notify recent senders when a recipient goes idle (reply notification)
  sessionManager.on('statusChange', ({ sessionId, status }) => {
    if (status !== 'idle') return;
    const senders = recentSenders.get(sessionId);
    if (!senders || senders.size === 0) return;

    const session = sessionManager.sessions.get(sessionId);
    if (!session) return;

    const expiry = Date.now() - 5 * 60 * 1000;
    for (const [senderId, ts] of senders) {
      if (ts < expiry) { senders.delete(senderId); continue; }
      // Don't notify if sender is also the parent (already notified above)
      if (senderId === session.parentSessionId) continue;

      const senderClients = terminalClients.get(senderId);
      if (!senderClients) continue;

      const replyNotification = JSON.stringify({
        type: 'easycc-notification',
        message: `"${session.name}" (${sessionId.substring(0, 8)}) finished processing your message. Use /ec-read ${session.name} to see results.`,
        childSessionId: sessionId,
        childName: session.name
      });
      for (const client of senderClients) {
        try { client.send(replyNotification); } catch {}
      }
    }
    // Clear senders after notification
    recentSenders.delete(sessionId);
  });

  // Broadcast session updates to dashboard clients
  sessionManager.on('sessionUpdated', (sessionData) => {
    const message = JSON.stringify({
      type: 'sessionUpdated',
      ...sessionData
    });

    for (const client of dashboardClients) {
      try {
        client.send(message);
      } catch (error) {
        console.error('Error sending to dashboard client:', error.message);
      }
    }
  });

  // Broadcast prompt added to dashboard clients
  sessionManager.on('promptAdded', ({ sessionId, promptHistory }) => {
    const message = JSON.stringify({
      type: 'promptAdded',
      sessionId,
      promptHistory
    });

    for (const client of dashboardClients) {
      try {
        client.send(message);
      } catch (error) {
        console.error('Error sending to dashboard client:', error.message);
      }
    }
  });

  // Broadcast session killed to dashboard clients
  sessionManager.on('sessionKilled', ({ sessionId, session }) => {
    const message = JSON.stringify({
      type: 'sessionKilled',
      sessionId
    });

    for (const client of dashboardClients) {
      try {
        client.send(message);
      } catch (error) {
        console.error('Error sending to dashboard client:', error.message);
      }
    }

    // Also notify terminal clients
    const termClients = terminalClients.get(sessionId);
    if (termClients) {
      for (const client of termClients) {
        try {
          client.send(JSON.stringify({ type: 'sessionEnded' }));
          client.close();
        } catch (error) {
          console.error('Error closing terminal client:', error.message);
        }
      }
      terminalClients.delete(sessionId);
    }
    closeTaskRunForSession(session, 'killed');
    clearActiveSessionFromAgents(sessionId);
    if (session?.agentId) {
      const ended = taskStore.endRunsByAgent(session.agentId, 'killed');
      for (const { taskId } of ended) {
        const t = taskStore.getTask(taskId);
        if (t) broadcastDashboard({ type: 'taskUpdated', task: t });
      }
    }
    refreshTeamInstanceStatus(session?.teamInstanceId);
  });

  // Broadcast session ended to clients
  sessionManager.on('sessionEnded', ({ sessionId, session }) => {
    const message = JSON.stringify({
      type: 'sessionEnded',
      sessionId
    });

    for (const client of dashboardClients) {
      try {
        client.send(message);
      } catch (error) {
        console.error('Error sending to dashboard client:', error.message);
      }
    }

    // Clear debounce timer
    if (kanbanSyncTimers.has(sessionId)) {
      clearTimeout(kanbanSyncTimers.get(sessionId)?.timer);
      kanbanSyncTimers.delete(sessionId);
    }
    closeTaskRunForSession(session, 'completed');
    clearActiveSessionFromAgents(sessionId);
    appendAgentMemoryFromSession(session?.agentId, session);
    if (session?.agentId) {
      const ended = taskStore.endRunsByAgent(session.agentId, 'completed');
      for (const { taskId } of ended) {
        const t = taskStore.getTask(taskId);
        if (t) broadcastDashboard({ type: 'taskUpdated', task: t });
      }
    }
    refreshTeamInstanceStatus(session?.teamInstanceId);
  });

  // Clear debounce timer on session kill
  sessionManager.on('sessionKilled', ({ sessionId }) => {
    if (kanbanSyncTimers.has(sessionId)) {
      clearTimeout(kanbanSyncTimers.get(sessionId)?.timer);
      kanbanSyncTimers.delete(sessionId);
    }
  });

  // Broadcast sessionMoved events to dashboard clients
  sessionManager.on('sessionMoved', (data) => {
    const message = JSON.stringify({ type: 'sessionMoved', ...data });
    for (const client of dashboardClients) {
      try {
        client.send(message);
      } catch (error) {
        console.error('Error sending to dashboard client:', error.message);
      }
    }
  });

  // Broadcast stagesUpdated events
  sessionManager.on('stagesUpdated', (stages) => {
    const message = JSON.stringify({ type: 'stagesUpdated', stages });
    for (const client of dashboardClients) {
      try {
        client.send(message);
      } catch (error) {
        console.error('Error sending to dashboard client:', error.message);
      }
    }
  });

  // Debounced auto-sync: session status → session's own stage (3s stability)
  // kanbanSyncTimers values: { timer, targetStage } — tracks pending target
  // so repeated events for the same target don't restart the debounce window.
  // Hook-sourced events use a shorter debounce since they're authoritative signals.
  sessionManager.on('statusChange', ({ sessionId, status, source }) => {
    const existing = kanbanSyncTimers.get(sessionId);

    // Codex mid-work approvals: don't auto-move to in_review
    const session = sessionManager.getSession(sessionId);
    if (session?.cliType === 'codex' && status === 'waiting') {
      if (existing) clearTimeout(existing.timer);
      kanbanSyncTimers.delete(sessionId);
      return;
    }

    // Don't auto-move sessions out of 'todo' until user has submitted input
    if (session?.stage === 'todo' && !session?.lastSubmittedInputAtMs) {
      if (existing) clearTimeout(existing.timer);
      kanbanSyncTimers.delete(sessionId);
      return;
    }

    const targetStage = sessionStatusToStage(status);
    if (!targetStage) {
      if (existing) clearTimeout(existing.timer);
      kanbanSyncTimers.delete(sessionId);
      return;
    }

    // Don't auto-move on 'active' when already in_progress (prevents jitter from redraws).
    // But DO allow 'active' to move back to in_progress from other stages (e.g. in_review).
    if (status === 'active' && targetStage === 'in_progress') {
      const sess = sessionManager.getSession(sessionId);
      if (sess?.stage === 'in_progress') {
        return;
      }
    }

    // KEY FIX: If a timer is already pending for the SAME target stage,
    // let it fire — don't restart the debounce window. This prevents
    // continuous streaming output from indefinitely resetting the timer.
    if (existing && existing.targetStage === targetStage) {
      return;
    }

    // Don't let brief thinking flickers cancel a pending in_review timer.
    // When a session is waiting for user input (plan approval), transient
    // "thinking" status from cursor animation should not reset the move.
    // Sustained real work will create a new in_progress timer after in_review fires.
    if (existing && existing.targetStage === 'in_review' && targetStage === 'in_progress') {
      return;
    }

    // Different target or no existing timer — (re)start debounce
    if (existing) clearTimeout(existing.timer);

    // Hook-sourced events are authoritative — use short debounce (200ms).
    // PTY regex-based events use 3s debounce for stability.
    const delay = source === 'hook' ? 200 : 3000;
    const timer = setTimeout(() => {
      kanbanSyncTimers.delete(sessionId);
      try {
        sessionManager.moveSession(sessionId, targetStage, { source: 'auto' });
      } catch (err) {
        console.error(`Auto-sync stage failed for session ${sessionId}:`, err.message);
      }
    }, delay);

    kanbanSyncTimers.set(sessionId, { timer, targetStage });
  });

  // ============================================
  // Plan Version Tracking Integration
  // ============================================

  // Watch for plan file changes and mark them as dirty
  planManager.watchPlans((plan) => {
    if (plan && plan.filename && plan.filename.endsWith('.md')) {
      const planPath = plan.path;
      if (planPath && fs.existsSync(planPath)) {
        try {
          const content = fs.readFileSync(planPath, 'utf8');
          planVersionStore.markDirty(planPath, content);
          console.log(`[PlanVersionStore] Marked plan as dirty: ${plan.filename}`);

          // Notify sessions that reference this plan so frontend re-fetches content
          const normalizedPlanPath = planPath.replace(/\\/g, '/').toLowerCase();
          const normalizedFilename = plan.filename.toLowerCase();
          for (const s of sessionManager.getAllSessions()) {
            const refs = s.plans || [];
            const match = refs.some(p => {
              const np = (p || '').replace(/\\/g, '/').toLowerCase();
              return np === normalizedPlanPath || np === normalizedFilename || np.endsWith('/' + normalizedFilename);
            });
            if (match) {
              sessionManager.emit('sessionUpdated', { id: s.id, plansUpdatedAt: Date.now() });
            }
          }
        } catch (error) {
          console.error(`[PlanVersionStore] Error marking plan dirty: ${error.message}`);
        }
      }
    }
  });

  // Create version snapshots when any session goes idle (idle-triggered versioning)
  sessionManager.on('statusChange', ({ sessionId, status }) => {
    if (status === 'idle') {
      // Flush all dirty plans to create version snapshots
      const versions = planVersionStore.flushDirtyPlans();
      if (versions.length > 0) {
        console.log(`[PlanVersionStore] Created ${versions.length} version snapshot(s) on idle`);

        // Notify dashboard clients about new versions
        for (const version of versions) {
          const message = JSON.stringify({
            type: 'planVersionCreated',
            planPath: version.planPath,
            timestamp: version.timestamp
          });

          for (const client of dashboardClients) {
            try {
              client.send(message);
            } catch (error) {
              console.error('Error sending version notification:', error.message);
            }
          }
        }
      }
    }
  });


  // Fallback route for SPA
  app.setNotFoundHandler((request, reply) => {
    if (request.url.startsWith('/api/') || request.url.startsWith('/ws/')) {
      return reply.status(404).send({ error: 'Not found' });
    }
    // Serve index.html for SPA routing
    return reply.sendFile('index.html');
  });

  // Graceful shutdown
  const shutdown = async () => {
    console.log('Shutting down...');
    sessionManager.cleanup();
    await app.close();
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  // Start server
  const host = '127.0.0.1';
  const port = parseInt(process.env.PORT || '5010', 10);

  try {
    sessionManager.port = port;
    try {
      installEcSkills();
      console.log('Installed /ec-* Claude Code skills');
    } catch (err) {
      console.warn('Could not install /ec-* skills:', err.message);
    }
    await app.listen({ port, host });
    console.log(`\nEasyCC running at:`);
    console.log(`  Local:   http://localhost:${port}`);
    console.log(`  Network: http://${getLocalIP()}:${port}\n`);
  } catch (error) {
    console.error('Failed to start server:', error);
    process.exit(1);
  }
}

// Get local IP address for network access info
function getLocalIP() {
  const { networkInterfaces } = require('os');
  const nets = networkInterfaces();

  for (const name of Object.keys(nets)) {
    for (const net of nets[name]) {
      if (net.family === 'IPv4' && !net.internal) {
        return net.address;
      }
    }
  }
  return '0.0.0.0';
}

// Only auto-start if not running in Electron
if (!process.versions.electron) {
  start();
}

// Export for Electron main process
module.exports = { start };

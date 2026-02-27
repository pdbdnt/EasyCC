# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What This Is

EasyCC (Easy CLI Context) is a cross-platform web UI (+ Electron desktop app) for managing multiple CLI sessions (Claude Code, Codex, and any other CLI tool). It combines terminal multiplexing, a Kanban workflow board, an agent/task system, and plan versioning into a single interface.

## Development Commands

```bash

# Development (hot reload) - backend :5010, UI :5011
npm run dev

# Web-only production mode
npm run start:web

# Electron desktop app
npm start

# Build UI to ui/dist
npm run build

# Build Windows installer
npm run electron:build

# Install all sub-package deps
npm run install:all

# Kill stuck process on port (Windows PowerShell)
Stop-Process -Id (Get-NetTCPConnection -LocalPort 5010).OwningProcess -Force
```

No automated tests or linting configured. Manual testing only.

## Project Structure

```
easycc/
├── backend/                    # Fastify + node-pty server
│   ├── server.js               # REST API + WebSocket (app.get/post/etc)
│   ├── sessionManager.js       # PTY lifecycle, status detection, ring buffer
│   ├── dataStore.js            # Session/stage persistence (data/sessions.json)
│   ├── planManager.js          # Watches ~/.claude/plans/ for .md files
│   ├── planVersionStore.js     # Snapshots plans on idle transition
│   ├── agentStore.js           # Agent CRUD (data/agents.json)
│   ├── taskStore.js            # Task CRUD (data/tasks.json)
│   ├── stagesConfig.js         # Kanban stage definitions + enums
│   ├── settingsManager.js      # App settings (data/settings.json)
│   ├── sessionNaming.js        # Auto-generated session names
│   ├── sessionInputUtils.js    # Input/output detection
│   └── terminalReplayUtils.js  # Terminal history replay payloads
├── ui/                         # React 18 + Vite 5
│   └── src/
│       ├── App.jsx             # Main layout, view switching, keyboard handler
│       ├── index.css           # ALL CSS (single file, CSS variables)
│       ├── components/         # 25 components (see below)
│       ├── hooks/              # 7 hooks (see below)
│       └── utils/              # hintRegistry, projectUtils, agentTemplates
├── electron/                   # Electron desktop wrapper
│   └── main.js                 # BrowserWindow, system tray, NSIS installer
└── data/                       # Runtime persistence (gitignored)
    ├── sessions.json
    ├── agents.json
    ├── tasks.json
    ├── stages.json
    ├── settings.json
    └── plan-versions/          # Snapshots per plan
```

## Architecture

### Backend: Fastify + node-pty

**server.js** registers all routes on the `app` instance (not `fastify` — the variable is named `app`):
- `app.get('/api/...')`, `app.post(...)`, etc. for REST
- `fastify.get('/socket/...')` for WebSocket (uses the raw fastify instance)

**SessionManager** (EventEmitter) is the core:
- Spawns PTY processes (`claude`, `codex`, or custom commands)
- Detects status from terminal output patterns (thinking/editing/waiting/idle)
- Ring buffer output: 750 chunks default, 3000 for long sessions
- Emits `statusChange`, `sessionUpdated` events → broadcast via WebSocket

**Key API groups:**
| Prefix | Purpose |
|--------|---------|
| `/api/sessions` | Session CRUD, pause/resume, stage movement, plans, comments |
| `/api/agents` | Agent CRUD, start/stop/restart/rewarm |
| `/api/tasks` | Task CRUD, assign, start-run/stop-run, comments |
| `/api/plans` | Plan files, versions, diffs, save |
| `/api/stages` | Kanban stage configuration |
| `/api/settings` | App settings CRUD |
| `/socket/dashboard` | Real-time broadcast (all sessions/agents/tasks) |
| `/socket/sessions/:id/terminal` | Terminal I/O per session |

### Frontend: React + xterm.js

**Three views** toggled by Ctrl+O with FLIP animations:
1. **Sessions** (default) — sidebar list grouped by directory + terminal
2. **Kanban** — drag-drop board with sessions or tasks in stage columns
3. **Agents** — agent management with session/task assignment

**Layout:** 3-column when context sidebar visible
```
┌────────────┬───────────┬────────────────────────┐
│  Sessions  │  Context  │  Terminal (pane split)  │
│  (280px)   │  (320px)  │       (flex)            │
└────────────┴───────────┴────────────────────────┘
```

**Key hooks:**
- `useSessions` — Session state + WebSocket `/socket/dashboard` connection. Receives `init` message with all data, then incremental updates (`statusChange`, `sessionUpdated`, `agentUpdated`, `taskUpdated`)
- `useWebSocket` — Generic WebSocket with auto-reconnect
- `useSettings` — Settings state + `matchKeyCombo()` for configurable shortcuts
- `useHintMode` — Vimium-style keyboard hints (backtick to toggle)
- `useSessionGroups` — Session grouping/filtering logic

**Pane splitting:** Terminal area supports split right (Alt+Shift+=) and split bottom (Alt+Shift+-). Layout persisted to localStorage.

### Data Flow

```
PTY output → SessionManager detects status pattern
  → emits statusChange → server broadcasts on /socket/dashboard
  → useSessions() parses JSON message → React state updates → UI re-renders
```

Terminal I/O uses a separate WebSocket per session (`/socket/sessions/:id/terminal`).

## Session Status Lifecycle

```
created → active ⇄ idle ⇄ thinking ⇄ editing → completed
                    ↓
                  paused (user-triggered)
```

Detection patterns in `sessionManager.js`:
- `thinking` — cost display pattern (`$0.xx`)
- `editing` — file edit pattern (`Edit(...)`)
- `waiting` — prompt pattern
- `idle` — 10s inactivity

## Plan Association

Plans are matched to sessions via **Claude's session transcript** (authoritative source):
- Transcript: `~/.claude/projects/{project-id}/{claude-session-id}.jsonl`
- `getSessionPlans()` reads transcript `snapshot.trackedFileBackups`, NOT the stored `session.plans` array
- Plan versions are snapshotted by `planVersionStore.js` when sessions transition to idle

## Keyboard Shortcuts

| Shortcut | Action |
|----------|--------|
| `` ` `` (backtick) | Toggle hint mode (Vimium-style) |
| `Ctrl+O` | Toggle sessions ↔ kanban view (with FLIP animation) |
| `Ctrl+W` | Close current session |
| `Ctrl+Shift+W` | Close focused pane |
| `Alt+Shift+=` | Split terminal right |
| `Alt+Shift+-` | Split terminal bottom |
| `Alt+Arrow` | Focus adjacent pane |
| `Ctrl+Alt+←/→` | Resize context sidebar |
| Arrow keys (in kanban) | Navigate kanban cards/columns |

Session navigation shortcuts are **configurable in Settings** via `matchKeyCombo()`. Defaults: `Ctrl+E`/`Ctrl+R` for next/prev session, `Ctrl+3`/`Ctrl+4` for next/prev group.

## CSS

Single file: `ui/src/index.css`. Uses CSS variables:
- Theming: `--bg-primary`, `--bg-secondary`, `--bg-active`
- Status colors: `--status-active`, `--status-idle`, etc.

## Adding New Features

**New session field:** `sessionManager.js` → `getSessionSnapshot()` → `dataStore.js` → UI component → API endpoint in `server.js`

**New kanban entity:** Add store in `backend/`, register CRUD routes in `server.js`, broadcast updates via dashboard WebSocket, add UI component

**New keyboard hint:** Register with `registerHint(code, { action, label })` in component's useEffect, add `<HintBadge>`, unregister in cleanup

## Known Gotchas

1. **Vite dev proxy** — WebSocket terminal I/O unreliable in dev mode. Use `npm run start:web` for testing.
2. **Route variable naming** — server.js uses `app` (not `fastify`) for route registration. `fastify` is only used for WebSocket routes.
3. **Session name editing** — Double-click to edit in both SessionCard and TerminalView header.
4. **FLIP animations** — View transitions (Ctrl+O) capture card positions before/after switch and animate. Controlled by `flipTriggerNonce` and `viewTransition` state in App.jsx.

## Security

This is a **local development tool**. The server binds to `localhost` only and has no authentication by design. It should not be exposed to untrusted networks. Path-based operations (file open, plan save/delete) include validation to prevent traversal and injection, but the trust boundary is the local machine.

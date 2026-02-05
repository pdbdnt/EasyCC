# Claude Manager

A cross-platform CLI session manager with a web UI for managing multiple Claude Code CLI sessions. Users can create, monitor, and interact with concurrent CLI sessions from a browser.

## Features

- **Multiple Sessions**: Run and manage multiple Claude CLI sessions simultaneously
- **Web-Based Terminal**: Full terminal emulation using xterm.js
- **Real-Time Updates**: WebSocket-based live updates for session status
- **Cross-Platform**: Works on Windows, macOS, and Linux
- **LAN Access**: Access your sessions from any device on your network

## Prerequisites

- Node.js 18+
- Claude CLI installed and accessible in PATH (`claude` command)
- npm or yarn

## Installation

```bash
# Clone or navigate to the project directory
cd claude-manager

# Install all dependencies (root, backend, and UI)
npm run install:all
```

## Usage

### Production Mode (Recommended)

Build and run the production server:

```bash
npm run build
npm start
```

Access at: http://localhost:5010

### Development Mode

For UI development with hot-reload:

```bash
npm run dev
```

- Frontend: http://localhost:5011 (Vite dev server with HMR)
- Backend: http://localhost:5010

**Note:** For full functionality including terminal output, use production mode (http://localhost:5010). The Vite dev server proxy has known issues with WebSocket connections for terminal I/O.

### LAN Access

To access from other devices on your network:

1. Find your local IP:
   - **Windows**: `ipconfig`
   - **macOS/Linux**: `ifconfig` or `ip addr`

2. Access from any device: `http://<your-local-ip>:5010`

## Project Structure

```
claude-manager/
├── backend/
│   ├── package.json
│   ├── server.js          # Fastify REST + WebSocket server
│   └── sessionManager.js  # PTY session management
├── ui/
│   ├── src/
│   │   ├── components/    # React components
│   │   ├── hooks/         # Custom React hooks
│   │   ├── App.jsx
│   │   ├── main.jsx
│   │   └── index.css
│   ├── index.html
│   ├── package.json
│   └── vite.config.js
├── package.json
├── start.js
└── README.md
```

## Key Features

### Terminal Emulation

The web UI uses xterm.js for full terminal emulation, supporting:

- Slash commands with autocomplete (`/help`, `/compact`, etc.)
- Keyboard shortcuts (Alt+P for model switch, Ctrl+C, etc.)
- Arrow key navigation and command history
- Tab completion
- ANSI colors and cursor positioning
- Copy/paste support

### Session Status

Sessions display real-time status indicators:

- 🟢 **Active** - Session is running with recent activity
- 🟡 **Idle** - No recent activity
- 🔵 **Thinking** - Claude is processing
- ✏️ **Editing** - Claude is editing files
- ⏳ **Waiting** - Waiting for user input
- ⚪ **Completed** - Session has ended

## API Reference

### REST Endpoints

| Method | Path | Description |
|--------|------|-------------|
| GET | /api/sessions | List all sessions |
| POST | /api/sessions | Create session `{name, workingDir}` |
| DELETE | /api/sessions/:id | Kill session |
| POST | /api/sessions/:id/resize | Resize terminal `{cols, rows}` |

### WebSocket Endpoints

| Path | Description |
|------|-------------|
| /socket/dashboard | Streams all session status changes |
| /socket/sessions/:id/terminal | Real-time terminal I/O for xterm.js |

## Troubleshooting

### Claude CLI not found

Ensure the `claude` command is available in your PATH:

```bash
claude --version
```

### Port already in use

If port 5010 is in use:

**Windows (PowerShell):**
```powershell
Stop-Process -Id (Get-NetTCPConnection -LocalPort 5010).OwningProcess -Force
```

**macOS/Linux:**
```bash
lsof -ti:5010 | xargs kill -9
```

### Build errors

Try cleaning and reinstalling:

```bash
rm -rf node_modules backend/node_modules ui/node_modules
npm run install:all
```

## License

MIT

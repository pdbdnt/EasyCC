# Quick Start Guide

## First Time Setup

```bash
# 1. Install dependencies
npm run install:all

# 2. Build the UI
npm run build
```

## Running the App

### Desktop Mode (Recommended)

```bash
npm start
```

**What happens:**
- Desktop window opens with taskbar icon
- App is ready when you see the UI
- Minimize to tray by closing window
- Right-click tray icon to quit

### Web Mode

```bash
npm run start:web
```

**Then open:** http://localhost:5010

## Creating Your First Session

1. Click **"New Session"** button (or press `` ` `` then type `ns`)
2. Fill in:
   - **Name**: "My First Session"
   - **Working Directory**: Path to your project
   - **Initial Prompt** (optional): "Help me understand this codebase"
3. Click **"Create"**
4. Terminal opens automatically
5. Type commands or chat with Claude

## Common Tasks

### Switch Between Sessions

- **Keyboard**: `Ctrl+]` (next) / `Ctrl+[` (previous)
- **Mouse**: Click session card in left sidebar
- **Hint mode**: Press `` ` `` then type session hint (e.g., `c1`)

### Pause/Resume Session

- Click **"Pause"** button in terminal header
- Or use hint mode: `` ` `` → `tm` (focuses terminal)

### View Session Info

- Click **"Context"** button in top bar
- Or press `` ` `` → `cx`
- Shows:
  - Session metadata
  - Notes
  - Associated plans
  - Recent prompts

### Keyboard Shortcuts

| Shortcut | Action |
|----------|--------|
| `` ` `` | Toggle hint mode (Vimium-style) |
| `Ctrl+]` | Next session in current group |
| `Ctrl+[` | Previous session |
| `Ctrl+'` | Next directory group |
| `Ctrl+Shift+C` | Copy (in terminal) |
| `Ctrl+Shift+V` | Paste (in terminal) |
| `Ctrl+L` | Clear terminal |

See main README for full keyboard shortcut list.

## Troubleshooting

### "Port 5010 already in use"

```powershell
# Kill the process
Stop-Process -Id (Get-NetTCPConnection -LocalPort 5010).OwningProcess -Force
```

### Desktop app won't start

1. Check if UI is built: `npm run build`
2. Try web mode: `npm run start:web`
3. Check console for errors

### Terminal not responding

1. Click terminal area to focus
2. Try clearing: `Ctrl+L`
3. If stuck, create new session

## Next Steps

- **Customize keyboard shortcuts**: Edit settings (press `` ` `` → `st`)
- **Create installer**: Run `npm run package` (see ELECTRON.md)
- **Access from network**: See README → LAN Access section
- **Advanced features**: Read CLAUDE.md in project root

## Need Help?

- Full documentation: See README.md
- Desktop app guide: See ELECTRON.md
- Project architecture: See CLAUDE.md
- Issues: https://github.com/your-repo/issues

# Electron Desktop App Guide

CLIOverlord can now run as a standalone Windows desktop application with its own taskbar icon and system tray integration.

## Quick Start

### Development Mode

**Option 1: Web mode (original)**
```bash
npm run dev
```
- Backend: http://localhost:5010
- UI: http://localhost:5011
- Access via browser

**Option 2: Electron with hot reload**
```bash
npm run electron:dev:full
```
- Launches backend + UI dev servers + Electron app
- All changes hot-reload automatically
- DevTools open by default

**Option 3: Electron only (backend/UI already running)**
```bash
npm run electron:dev
```
- Use when you already have `npm run dev` running
- Just launches the Electron window

### Production Mode

**Run packaged version locally:**
```bash
npm run build          # Build UI first
npm start              # Start Electron app
```

**Create installer:**
```bash
npm run package
```
- Builds UI
- Creates installer in `dist-electron/`
- Output: `Claude Manager Setup 1.0.0.exe`

## Features

### Desktop Integration

✅ **Taskbar Icon**
- App appears as native Windows application
- Shows in taskbar when running

✅ **System Tray**
- Minimize to tray (window hides instead of closing)
- Right-click tray icon for menu:
  - "Show Claude Manager" - Restore window
  - "Quit" - Exit application
- Single click tray icon to restore window

✅ **Native Window**
- Remembers size and position
- Minimum size: 1000x600
- Default size: 1400x900

✅ **Graceful Shutdown**
- Closes all Claude sessions properly
- No orphaned processes

### Keyboard Shortcuts

All existing keyboard shortcuts work in Electron:
- Hint mode: `` ` ``
- Session navigation: `Ctrl+]` / `Ctrl+[`
- Terminal shortcuts: `Ctrl+Shift+C/V`
- See main README for full list

## Architecture

### How It Works

1. **Main Process** (`electron/main.js`)
   - Starts Fastify backend on port 5010
   - Creates BrowserWindow
   - Manages system tray
   - Handles app lifecycle

2. **Backend** (`backend/server.js`)
   - Runs inside Electron process (not separate)
   - Serves REST API + WebSocket
   - Manages PTY sessions

3. **Renderer** (`ui/dist/`)
   - React app loads from `localhost:5010`
   - Same code as web version
   - No changes needed

### Process Model

**Development:**
```
┌─────────────────────────────────────────┐
│  npm run electron:dev:full              │
├─────────────────────────────────────────┤
│  1. nodemon → backend server (5010)     │
│  2. vite → dev server (5011)            │
│  3. electron → window loads from 5011   │
└─────────────────────────────────────────┘
```

**Production:**
```
┌─────────────────────────────────────────┐
│  electron .                             │
├─────────────────────────────────────────┤
│  Electron main process:                 │
│  - Starts backend (5010)                │
│  - Creates window                       │
│  - Window loads from localhost:5010     │
└─────────────────────────────────────────┘
```

## File Structure

```
claude-manager/
├── electron/
│   ├── main.js              # Electron main process
│   ├── preload.js           # IPC bridge (empty for now)
│   ├── icon.ico             # Windows icon (256x256)
│   ├── icon.png             # Source icon
│   └── create-icon.py       # Icon generator script
├── backend/
│   └── server.js            # Now exports start() for Electron
├── start.js                 # Web mode launcher (skips if in Electron)
└── package.json             # Updated with Electron scripts
```

## Configuration

### electron-builder (package.json)

```json
{
  "build": {
    "appId": "com.clioverlord.claudemanager",
    "productName": "Claude Manager",
    "files": [
      "electron/**/*",
      "backend/**/*",
      "ui/dist/**/*",
      "data/**/*"
    ],
    "win": {
      "target": "nsis",
      "icon": "electron/icon.ico"
    },
    "nsis": {
      "oneClick": false,
      "allowToChangeInstallationDirectory": true,
      "createDesktopShortcut": true,
      "createStartMenuShortcut": true
    }
  }
}
```

### Icon Customization

Replace `electron/icon.ico` with your own:

**Requirements:**
- Format: `.ico`
- Minimum: 256x256 pixels
- Recommended: Include multiple sizes (16, 32, 48, 64, 128, 256)

**Tools:**
- [icoconverter.com](https://www.icoconverter.com/) - Upload PNG, get ICO
- GIMP - Export as ICO with multiple sizes
- ImageMagick: `magick icon.png -define icon:auto-resize=256,128,64,48,32,16 icon.ico`
- Included script: `python electron/create-icon.py`

## Troubleshooting

### Port 5010 Already in Use

**Error:**
```
Failed to Start Server
Could not start the backend server. Please check if port 5010 is already in use.
```

**Solution:**
```powershell
# Kill process on port 5010
Stop-Process -Id (Get-NetTCPConnection -LocalPort 5010).OwningProcess -Force

# Then restart
npm start
```

### Window Doesn't Open

**Check:**
1. Backend started successfully? (check console)
2. UI built? Run `npm run build` first
3. Port 5010 accessible? Try `curl http://localhost:5010`

### Dev Mode: "Cannot GET /"

**Cause:** Electron trying to load before Vite dev server ready

**Solution:** Use `npm run electron:dev:full` (includes `wait-on`)

### Icon Not Showing

**Cause:** `electron/icon.ico` missing or invalid

**Solution:**
```bash
python electron/create-icon.py
```

Or copy a valid `.ico` file to `electron/icon.ico`

## Distribution

### Build Installer

```bash
npm run package
```

**Output:**
- `dist-electron/Claude Manager Setup 1.0.0.exe` (~80-100MB)
- NSIS installer with custom install directory option
- Creates desktop + start menu shortcuts

### Installation

1. Run installer
2. Choose install location
3. Select shortcuts to create
4. Wait for installation
5. Launch "Claude Manager" from desktop or start menu

### Uninstallation

**Via Control Panel:**
- Settings → Apps → Claude Manager → Uninstall

**Via Start Menu:**
- Claude Manager → Uninstall Claude Manager

## Development Workflow

### Making Changes

**Frontend (React components):**
1. Run `npm run electron:dev:full`
2. Edit files in `ui/src/`
3. Changes hot-reload instantly

**Backend (API/WebSocket):**
1. Run `npm run electron:dev:full`
2. Edit files in `backend/`
3. nodemon restarts backend automatically
4. Refresh Electron window (Ctrl+R)

**Electron main process:**
1. Edit `electron/main.js`
2. Restart Electron: Close window, run `npm run electron:dev`

### Testing Before Release

```bash
# 1. Build production UI
npm run build

# 2. Test packaged app locally
npm start

# 3. Verify all features work:
#    - Create session
#    - Terminal I/O
#    - Pause/resume
#    - Keyboard shortcuts
#    - System tray
#    - Graceful shutdown

# 4. Build installer
npm run package

# 5. Test installer:
#    - Install to custom directory
#    - Launch from desktop shortcut
#    - Verify it's truly standalone (no npm commands needed)
#    - Test uninstaller
```

## Future Enhancements

Potential features to add:

- [ ] Auto-launch on Windows startup (toggle in settings)
- [ ] Global keyboard shortcut to show/hide (Ctrl+Alt+C)
- [ ] Native file picker for working directory
- [ ] Window state persistence (position, size)
- [ ] Native context menus (right-click terminal)
- [ ] Update notifications
- [ ] Custom protocol handler (`claudemanager://`)

## Comparison: Web vs Desktop

| Feature | Web Mode | Desktop Mode |
|---------|----------|--------------|
| Access | Browser tab | Taskbar app |
| System Tray | ❌ | ✅ |
| Desktop Integration | ❌ | ✅ |
| Installation | None | Installer |
| Auto-launch | ❌ | Possible |
| Global Shortcuts | ❌ | Possible |
| Bundle Size | Small | ~100MB |
| Network Access | ✅ | Same |
| Development | Faster | Slightly slower |

## Notes

- Web mode still works: `npm run dev` unchanged
- Both modes use the same backend code
- UI code is identical (no Electron-specific changes needed)
- WebSocket connections work in both modes
- All existing features preserved

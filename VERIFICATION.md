# Desktop App Verification Checklist

Use this checklist to verify the Electron desktop app implementation is working correctly.

## Pre-Launch Checks

- [ ] Dependencies installed: `npm install` completed
- [ ] UI built: `ui/dist/` folder exists
- [ ] Backend dependencies: `backend/node_modules/` exists
- [ ] Icon created: `electron/icon.ico` exists
- [ ] Port 5010 available (not in use)

## Development Mode Testing

### 1. Electron Development Launch

```bash
npm run electron:dev:full
```

**Expected behavior:**
- [ ] Backend starts on port 5010
- [ ] UI dev server starts on port 5011
- [ ] Electron window opens automatically
- [ ] Window shows UI (not blank)
- [ ] DevTools are open (F12 panel visible)
- [ ] No console errors (check DevTools and terminal)

### 2. Hot Reload Testing

**Backend changes:**
- [ ] Edit `backend/server.js` (add console.log)
- [ ] Backend restarts automatically (nodemon)
- [ ] Electron window stays open

**Frontend changes:**
- [ ] Edit `ui/src/App.jsx` (change text)
- [ ] UI updates instantly without refresh
- [ ] No full page reload

**Main process changes:**
- [ ] Edit `electron/main.js` (change window size)
- [ ] Must manually restart: Close window, run `npm run electron:dev`

## Production Mode Testing

### 3. Production Build

```bash
npm run build
npm start
```

**Expected behavior:**
- [ ] Window opens (no DevTools)
- [ ] Loads from `localhost:5010` (check network tab)
- [ ] UI appears correctly
- [ ] Window title: "Claude Manager"
- [ ] Taskbar shows app icon
- [ ] Icon visible in taskbar (blue CM logo)

### 4. System Tray

- [ ] Window has tray icon in system tray (bottom-right)
- [ ] Hover shows tooltip: "Claude Manager"
- [ ] Click X button on window → window hides (doesn't quit)
- [ ] App still in system tray
- [ ] Single-click tray icon → window restores
- [ ] Right-click tray icon → shows menu
- [ ] Menu has: "Show Claude Manager" and "Quit"
- [ ] Click "Quit" → app exits completely

### 5. Window Behavior

- [ ] Minimize button works (minimizes to taskbar)
- [ ] Maximize button works
- [ ] Restore from minimize works (click taskbar icon)
- [ ] Resize window by dragging edges
- [ ] Minimum size enforced (1000x600)
- [ ] Window can be moved around screen

## Core Functionality Testing

### 6. Session Creation

- [ ] Click "New Session" button
- [ ] Modal opens
- [ ] Fill in:
  - Name: "Test Session"
  - Working Directory: Valid path
  - Initial Prompt: "help me"
- [ ] Click "Create"
- [ ] Session appears in sidebar
- [ ] Terminal view opens
- [ ] Terminal shows PTY output

### 7. Terminal Interaction

- [ ] Click in terminal area
- [ ] Type: `echo hello`
- [ ] Press Enter
- [ ] Output appears: "hello"
- [ ] Copy text: Select text, `Ctrl+Shift+C`
- [ ] Paste text: `Ctrl+Shift+V`
- [ ] Clear terminal: `Ctrl+L`
- [ ] Interrupt: Type command, press `Ctrl+C`

### 8. WebSocket Connection

- [ ] Open DevTools (F12)
- [ ] Go to Network tab → WS (WebSocket)
- [ ] See connection: `ws://localhost:5010/socket/sessions/...`
- [ ] Status: "Connected" (green)
- [ ] Type in terminal → messages appear in WS tab
- [ ] Close and reopen window → reconnects automatically

### 9. Session Management

- [ ] Create second session
- [ ] Both sessions visible in sidebar
- [ ] Switch between sessions (click cards)
- [ ] Terminal switches correctly
- [ ] Each terminal shows correct content
- [ ] Pause session (click Pause button)
- [ ] Status changes to "Paused"
- [ ] Resume session
- [ ] Delete session (hover card, click X)
- [ ] Session removed from sidebar

### 10. Keyboard Shortcuts

- [ ] Press `` ` `` → hint mode activates
- [ ] Hints appear on UI elements
- [ ] Type session hint (e.g., `t1`) → switches to that session
- [ ] Press `` ` `` again → hint mode deactivates
- [ ] `Ctrl+]` → next session in group
- [ ] `Ctrl+[` → previous session
- [ ] `Ctrl+'` → next directory group (if multiple)

### 11. Context Sidebar

- [ ] Click "Context" button (top-right)
- [ ] Sidebar slides in from right
- [ ] Shows session info:
  - Session name (editable)
  - Working directory
  - Status
  - Created time
- [ ] Notes section visible
- [ ] Add note, save
- [ ] Note persists after switching sessions
- [ ] Close sidebar (click "Context" again)

### 12. Settings

- [ ] Press `` ` `` → `st` (or click settings gear)
- [ ] Settings modal opens
- [ ] Shows terminal shortcuts
- [ ] Change a shortcut
- [ ] Click "Save"
- [ ] Test new shortcut works
- [ ] Close settings

## Graceful Shutdown Testing

### 13. Clean Exit

**Test 1: Normal quit**
- [ ] Create 2 active sessions
- [ ] Right-click tray → "Quit"
- [ ] App closes
- [ ] Check Task Manager: No orphaned `node` processes
- [ ] Check port: `Get-NetTCPConnection -LocalPort 5010` → should error (port free)

**Test 2: Window close then quit**
- [ ] Restart app
- [ ] Close window (X button) → minimizes to tray
- [ ] Right-click tray → "Quit"
- [ ] App exits cleanly

**Test 3: Ctrl+C in terminal that launched app**
- [ ] Run `npm start` in terminal
- [ ] Press `Ctrl+C` in that terminal
- [ ] App exits
- [ ] No orphaned processes

## Packaging Testing

### 14. Build Installer

```bash
npm run package
```

**Expected behavior:**
- [ ] Build completes without errors
- [ ] Output in `dist-electron/` folder
- [ ] File exists: `Claude Manager Setup 1.0.0.exe`
- [ ] File size: ~80-100 MB

### 15. Installer Testing

**Installation:**
- [ ] Run installer
- [ ] Shows custom install location option
- [ ] Choose install directory
- [ ] Select "Create desktop shortcut"
- [ ] Installation completes
- [ ] Desktop shortcut created
- [ ] Start menu shortcut created

**First launch:**
- [ ] Double-click desktop shortcut
- [ ] App launches (no console window)
- [ ] Window appears with UI
- [ ] Create test session → works
- [ ] Close app
- [ ] Data persists in `%APPDATA%\claude-manager\` or install dir

**Uninstall:**
- [ ] Settings → Apps → Claude Manager → Uninstall
- [ ] Uninstaller runs
- [ ] App removed from Programs list
- [ ] Desktop shortcut removed
- [ ] Start menu shortcut removed
- [ ] Install directory removed (if empty)

## Web Mode Compatibility

### 16. Web Mode Still Works

```bash
npm run start:web
```

**Expected behavior:**
- [ ] Server starts on port 5010
- [ ] Open browser: `http://localhost:5010`
- [ ] UI loads correctly
- [ ] All features work (sessions, terminal, etc.)
- [ ] Identical to old behavior

### 17. Development Mode (Web)

```bash
npm run dev
```

**Expected behavior:**
- [ ] Backend: port 5010
- [ ] UI: port 5011
- [ ] Browser: Open `http://localhost:5011`
- [ ] Hot reload works
- [ ] Terminal I/O works (if using 5010)

## Error Handling

### 18. Port Conflict

**Setup:**
- [ ] Start app: `npm start`
- [ ] Without closing, run again in new terminal: `npm start`

**Expected:**
- [ ] Second instance shows error dialog
- [ ] Message: "Could not start the backend server. Please check if port 5010 is already in use."
- [ ] Second instance exits
- [ ] First instance still running

### 19. Missing Icon

**Setup:**
- [ ] Rename `electron/icon.ico` to `electron/icon.ico.bak`
- [ ] Run: `npm start`

**Expected:**
- [ ] App still launches
- [ ] Warning in console about missing icon
- [ ] Taskbar shows default Electron icon
- [ ] App still functional

## Performance Testing

### 20. Resource Usage

- [ ] Open Task Manager
- [ ] Check "Claude Manager" process
- [ ] Memory usage: < 500 MB (idle)
- [ ] CPU usage: < 5% (idle)
- [ ] Create 5 sessions
- [ ] Memory increases but stays reasonable
- [ ] Close 4 sessions → memory decreases

### 21. Startup Time

- [ ] Close app completely
- [ ] Time the launch: `npm start`
- [ ] Window appears: < 5 seconds
- [ ] UI fully loaded: < 10 seconds
- [ ] Acceptable performance

## Issues Checklist

If any test fails, check:

### Common Issues

**Window doesn't open:**
- [ ] Check console for errors
- [ ] Verify UI built: `ls ui/dist`
- [ ] Try rebuilding: `npm run build`
- [ ] Check port 5010 available

**Terminal not responding:**
- [ ] Click in terminal area
- [ ] Check if PTY process started (ps aux | grep claude)
- [ ] Try creating new session
- [ ] Check WebSocket connection (DevTools)

**Icon not showing:**
- [ ] Check `electron/icon.ico` exists
- [ ] Regenerate: `python electron/create-icon.py`
- [ ] Check file size > 0 bytes

**App won't quit:**
- [ ] Force quit: Task Manager → End task
- [ ] Check for orphaned processes
- [ ] Kill port: `Stop-Process -Id (Get-NetTCPConnection -LocalPort 5010).OwningProcess -Force`

**WebSocket errors:**
- [ ] Check backend started (console logs)
- [ ] Verify port 5010 open
- [ ] Check firewall settings
- [ ] Try web mode: `npm run start:web`

## Sign-Off

**Date tested:** _____________

**Tester name:** _____________

**Platform:** Windows ___ (version: __________)

**Node version:** _____________

**All critical tests passed:** ☐ Yes ☐ No

**Notes:**
_____________________________________________________________
_____________________________________________________________
_____________________________________________________________

**Ready for production:** ☐ Yes ☐ No

---

## Automated Testing (Future)

These tests should eventually be automated:

- [ ] Unit tests for electron/main.js
- [ ] Integration tests for backend/server.js
- [ ] E2E tests using Playwright
- [ ] CI/CD pipeline for building installers
- [ ] Automated smoke tests after packaging

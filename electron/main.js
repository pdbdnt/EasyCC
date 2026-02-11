/**
 * Electron Main Process
 *
 * Manages:
 * - Application lifecycle
 * - BrowserWindow creation
 * - System tray integration
 * - Backend server startup
 * - Graceful shutdown
 */

const { app, BrowserWindow, Tray, Menu, shell } = require('electron');
const path = require('path');

let mainWindow = null;
let tray = null;
let backendStarted = false;
const BACKEND_PORT = 5010;

/**
 * Start the Fastify backend server
 */
async function startBackend() {
  if (backendStarted) {
    console.log('[Electron] Backend already started');
    return;
  }

  try {
    // Force the port so it doesn't inherit a random PORT from the environment
    process.env.PORT = String(BACKEND_PORT);
    const serverModule = require('../backend/server.js');
    await serverModule.start();
    backendStarted = true;
    console.log(`[Electron] Backend started successfully on port ${BACKEND_PORT}`);
  } catch (error) {
    console.error('[Electron] Failed to start backend:', error);
    // Show error dialog and quit
    const { dialog } = require('electron');
    dialog.showErrorBox(
      'Failed to Start Server',
      `Could not start the backend server. Please check if port 5010 is already in use.\n\nError: ${error.message}`
    );
    app.quit();
  }
}

/**
 * Create the main application window
 */
function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 1000,
    minHeight: 600,
    title: 'Claude Manager',
    icon: path.join(__dirname, 'icon.ico'),
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.js')
    },
    // Better visual appearance
    backgroundColor: '#1a1a1a',
    show: false // Don't show until ready-to-show
  });

  // Determine the URL to load
  const isDev = process.env.NODE_ENV === 'development';
  const startURL = isDev ? 'http://localhost:5011' : `http://localhost:${BACKEND_PORT}`;

  console.log(`[Electron] Loading UI from: ${startURL}`);
  console.log(`[Electron] Mode: ${isDev ? 'development' : 'production'}`);

  // Load the UI
  mainWindow.loadURL(startURL);

  // Show window when ready
  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
    mainWindow.focus();
  });

  // Open DevTools in development mode
  if (isDev) {
    mainWindow.webContents.openDevTools();
  }

  // Handle external links (open in default browser)
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });

  // Minimize to tray instead of closing
  mainWindow.on('close', (event) => {
    if (!app.isQuitting) {
      event.preventDefault();
      mainWindow.hide();
      console.log('[Electron] Window minimized to tray');

      // Show notification on first minimize
      if (!mainWindow.hasMinimizedBefore) {
        mainWindow.hasMinimizedBefore = true;
        // Optional: Could show a native notification here
      }
    }
  });

  // When quitting, bypass the beforeunload dialog from the web page
  mainWindow.webContents.on('will-prevent-unload', (event) => {
    if (app.isQuitting) {
      event.preventDefault();
    }
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

/**
 * Create system tray icon with menu
 */
function createTray() {
  const iconPath = path.join(__dirname, 'icon.ico');

  tray = new Tray(iconPath);
  tray.setToolTip('Claude Manager');

  const contextMenu = Menu.buildFromTemplate([
    {
      label: 'Show Claude Manager',
      click: () => {
        if (mainWindow) {
          mainWindow.show();
          mainWindow.focus();
        } else {
          createWindow();
        }
      }
    },
    {
      type: 'separator'
    },
    {
      label: 'Quit',
      click: () => {
        app.isQuitting = true;
        app.quit();
      }
    }
  ]);

  tray.setContextMenu(contextMenu);

  // Single click to restore window
  tray.on('click', () => {
    if (mainWindow) {
      if (mainWindow.isVisible()) {
        mainWindow.focus();
      } else {
        mainWindow.show();
        mainWindow.focus();
      }
    } else {
      createWindow();
    }
  });

  console.log('[Electron] System tray created');
}

/**
 * Application initialization
 */
app.whenReady().then(async () => {
  console.log('[Electron] App ready, initializing...');

  // Set application menu with reload shortcuts
  const menuTemplate = [
    {
      label: 'View',
      submenu: [
        { role: 'reload', accelerator: 'CmdOrCtrl+R' },
        { role: 'forceReload', accelerator: 'CmdOrCtrl+Shift+R' },
        { role: 'toggleDevTools', accelerator: 'F12' },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' }
      ]
    },
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'selectAll' }
      ]
    }
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(menuTemplate));

  // Start backend first
  await startBackend();

  // Wait a moment for server to be fully ready
  await new Promise(resolve => setTimeout(resolve, 1000));

  // Create window and tray
  createWindow();
  createTray();

  console.log('[Electron] Initialization complete');
});

/**
 * Handle all windows closed
 */
app.on('window-all-closed', () => {
  // On Windows/Linux, keep app running in tray
  // Only quit when explicitly requested via tray menu
  console.log('[Electron] All windows closed, minimized to tray');
});

/**
 * Handle app activation (macOS behavior, but kept for consistency)
 */
app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow();
  } else if (mainWindow) {
    mainWindow.show();
    mainWindow.focus();
  }
});

/**
 * Handle graceful shutdown
 */
app.on('before-quit', async () => {
  console.log('[Electron] Shutting down gracefully...');

  // The backend's SIGTERM handler will clean up sessions
  // We just need to ensure we're flagged as quitting
  app.isQuitting = true;
});

/**
 * Ensure clean exit
 */
process.on('SIGTERM', () => {
  console.log('[Electron] Received SIGTERM, quitting...');
  app.quit();
});

process.on('SIGINT', () => {
  console.log('[Electron] Received SIGINT, quitting...');
  app.quit();
});

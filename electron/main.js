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

const { app, BrowserWindow, Tray, Menu, shell, dialog } = require('electron');
const path = require('path');
const { configurePackagedLogging } = require('./packagedLogging');
const { configurePackagedData } = require('./packagedData');
const { classifyStartupError } = require('./startupErrors');
const { createQuitCoordinator } = require('./quitCoordinator');

// A packaged Windows GUI app has no console handles. Redirect logging before
// the first console call or backend import so writes cannot fail with EBADF.
const packagedLogPaths = configurePackagedLogging({ app });

let mainWindow = null;
let tray = null;
let backendStarted = false;
let serverModule = null;
const BACKEND_PORT = 5010;

const quitCoordinator = createQuitCoordinator({
  app,
  stopBackend: async () => {
    if (serverModule && typeof serverModule.stop === 'function') {
      await serverModule.stop();
    }
  },
  onStopped: () => {
    backendStarted = false;
  }
});
const { requestQuit } = quitCoordinator;

app.on('before-quit', quitCoordinator.handleBeforeQuit);

const hasSingleInstanceLock = app.requestSingleInstanceLock();
if (!hasSingleInstanceLock) {
  app.isQuitting = true;
  app.quit();
} else {
  app.on('second-instance', () => {
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  });
}

/**
 * Start the Fastify backend server
 */
async function startBackend() {
  if (backendStarted) {
    console.log('[Electron] Backend already started');
    return true;
  }

  try {
    configurePackagedData({ app });
    // Force the port so it doesn't inherit a random PORT from the environment
    process.env.PORT = String(BACKEND_PORT);
    serverModule = require('../backend/server.js');
    await serverModule.start();
    backendStarted = true;
    console.log(`[Electron] Backend started successfully on port ${BACKEND_PORT}`);
    return true;
  } catch (error) {
    console.error('[Electron] Failed to start backend:', error);
    const presentation = classifyStartupError(error, {
      port: BACKEND_PORT,
      logPaths: packagedLogPaths
    });
    dialog.showErrorBox(presentation.title, presentation.message);
    await requestQuit(1);
    return false;
  }
}

/**
 * Create the main application window
 */
function createWindow() {
  if (!backendStarted || app.isQuitting) return;
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 1000,
    minHeight: 600,
    title: 'EasyCC',
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
  if (!backendStarted || app.isQuitting) return;
  const iconPath = path.join(__dirname, 'icon.ico');

  tray = new Tray(iconPath);
  tray.setToolTip('EasyCC');

  const contextMenu = Menu.buildFromTemplate([
    {
      label: 'Show EasyCC',
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
      click: async () => {
        if (mainWindow) {
          mainWindow.show();
          mainWindow.focus();
        }
        const { response } = await dialog.showMessageBox(mainWindow, {
          type: 'question',
          buttons: ['Yes', 'No'],
          defaultId: 1,
          cancelId: 1,
          title: 'Quit EasyCC',
          message: 'Are you sure you want to quit EasyCC?',
          detail: 'All active sessions will continue running in their terminals.'
        });
        if (response === 0) {
          await requestQuit(0);
        }
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
  if (!hasSingleInstanceLock || app.isQuitting) return;
  console.log('[Electron] App ready, initializing...');

  // Set application menu with reload shortcuts
  const menuTemplate = [
    {
      label: 'File',
      submenu: [
        {
          label: 'Quit',
          accelerator: 'CmdOrCtrl+Q',
          click: async () => {
            const { response } = await dialog.showMessageBox(mainWindow, {
              type: 'question',
              buttons: ['Yes', 'No'],
              defaultId: 1,
              cancelId: 1,
              title: 'Quit EasyCC',
              message: 'Are you sure you want to quit EasyCC?',
              detail: 'All active sessions will continue running in their terminals.'
            });
            if (response === 0) {
              await requestQuit(0);
            }
          }
        }
      ]
    },
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
  if (!await startBackend()) return;

  // Wait a moment for server to be fully ready
  await new Promise(resolve => setTimeout(resolve, 1000));
  if (!backendStarted || app.isQuitting) return;

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
  if (!backendStarted || app.isQuitting) return;
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow();
  } else if (mainWindow) {
    mainWindow.show();
    mainWindow.focus();
  }
});

/**
 * Ensure clean exit
 */
process.on('SIGTERM', () => {
  console.log('[Electron] Received SIGTERM, quitting...');
  void requestQuit(0);
});

process.on('SIGINT', () => {
  console.log('[Electron] Received SIGINT, quitting...');
  void requestQuit(0);
});

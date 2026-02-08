/**
 * Preload script for Electron
 *
 * This script runs in the renderer process before the web page is loaded.
 * It provides a bridge between the main process and the renderer process.
 *
 * Currently empty - placeholder for future desktop features like:
 * - Native file dialogs
 * - System notifications
 * - Global shortcuts
 * - Window state persistence
 */

const { contextBridge } = require('electron');

// Future IPC methods can be exposed here
// Example:
// contextBridge.exposeInMainWorld('electronAPI', {
//   openFileDialog: () => ipcRenderer.invoke('dialog:openFile'),
// });

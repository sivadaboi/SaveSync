import { app, BrowserWindow, dialog, Tray, Menu, nativeImage } from 'electron';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';

let mainWindow = null;
let tray = null;
let isQuitting = false;

// Valid 16x16 purple gamepad PNG (base64 encoded)
const TRAY_ICON_DATA = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAACXBIWXMAAAsTAAALEwEAmpwYAAABBklEQVQ4jZWTMUsDQRCFv707c0GCEbSxSqcWQrAQLBTtRND/IEFsBAsbwUoQLARBC0EUK1tbwULQQhDBQhCxsBFBEBG8u+PcLZzxknDJBR94u2/evJ3ZXSillFJKKaWUUkrpf3POuU3gbf1cEuBxEEJYdM5tAEdABjRArRBCWgghXMaYI2AB2AKeVoBzYB/YBdaBNWAXWAfmwE/2jRBCWM/zHFhrIYRQKKWUUkrpWSnlFUoFlFIeUEoplVJKKeWVUkoppZRSSimllFJKKaWUUkoZVUqZVUopZRaRlkMopVJKKaWUUkoppVBKKaWUUkqplFJKKaWUUkoppVBKKaWUUkqplFJKKaWUUkqplFJKKaWUUkqplFJKKeUPvgEqkRiEAAAAAElFTkSuQmCC';



// Expose native folder dialog browser to Express API bridge
global.selectDirectoryCallback = async () => {
  const result = await dialog.showOpenDialog({
    properties: ['openDirectory', 'createDirectory']
  });
  return result.filePaths[0];
};

// Expose file selection dialog to Express API bridge
global.selectFileCallback = async () => {
  const result = await dialog.showOpenDialog({
    properties: ['openFile'],
    filters: [
      { name: 'Executables', extensions: ['exe', 'bat', 'lnk', 'cmd'] },
      { name: 'All Files', extensions: ['*'] }
    ]
  });
  return result.filePaths[0];
};

// Expose external URL opening to daemon
global.openExternalUrl = async (url) => {
  const { shell } = await import('electron');
  return shell.openExternal(url);
};

// Expose startup settings manager
global.updateStartupSettings = (enabled) => {
  try {
    app.setLoginItemSettings({
      openAtLogin: enabled,
      path: process.execPath,
      args: ['--hidden']
    });
  } catch (err) {
    console.error('[Startup Settings] Failed to set login item settings:', err.message);
  }
};

// Expose window state hooks to Express REST API
global.minimizeWindow = () => {
  if (mainWindow) mainWindow.minimize();
};

global.maximizeWindow = () => {
  if (mainWindow) {
    if (mainWindow.isMaximized()) {
      mainWindow.unmaximize();
    } else {
      mainWindow.maximize();
    }
  }
};

global.closeWindow = () => {
  if (mainWindow) {
    mainWindow.hide(); // Minimize to system tray
  }
};

import db from './daemon/db.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function createWindow() {
  const settings = db.getSettings();
  const port = settings.port || 8383;
  const shouldHide = process.argv.includes('--hidden') || process.argv.includes('--minimized');

  // Create the native window as frameless for custom OS header title bar
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 900,
    minHeight: 650,
    frame: false,
    title: 'SaveSync — Universal Save Synchronizer',
    backgroundColor: '#05060f', // Match dashboard background
    show: !shouldHide,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true
    }
  });

  // Remove default menu bar
  mainWindow.removeMenu();

  // Load the dashboard hosted locally by the daemon
  mainWindow.loadURL(`http://localhost:${port}`);

  // Prevent app close, hide window to run in system tray background
  mainWindow.on('close', (event) => {
    if (!isQuitting) {
      event.preventDefault();
      mainWindow.hide();
    }
  });

  // Handle open links externally in default browser
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    import('electron').then(({ shell }) => {
      shell.openExternal(url);
    });
    return { action: 'deny' };
  });

  // Create the system tray
  createTray();
}

function createTray() {
  if (tray) return;

  try {
    // Load icon directly from base64 data — no file I/O needed
    const icon = nativeImage.createFromDataURL(TRAY_ICON_DATA);
    tray = new Tray(icon);
  } catch (err) {
    console.error('[Tray] Failed to create tray icon:', err.message);
    // Fall back to an empty icon so the tray still works
    tray = new Tray(nativeImage.createEmpty());
  }

  tray.setToolTip('SaveSync — Running in background');

  const contextMenu = Menu.buildFromTemplate([
    {
      label: 'Open SaveSync',
      click: () => {
        if (mainWindow) {
          mainWindow.show();
          mainWindow.focus();
        }
      }
    },
    {
      label: 'Sync All Games Now',
      click: async () => {
        try {
          const settings = db.getSettings();
          const port = settings.port || 8383;
          const res = await fetch(`http://localhost:${port}/api/games/sync-all`, { method: 'POST' });
          if (res.ok) {
            console.log('[Tray] Sync-all triggered successfully.');
          }
        } catch (e) {
          console.error('[Tray] Sync-all trigger failed:', e.message);
        }
      }
    },
    { type: 'separator' },
    {
      label: 'Quit',
      click: () => {
        isQuitting = true;
        app.quit();
      }
    }
  ]);

  tray.setContextMenu(contextMenu);
  tray.on('double-click', () => {
    if (mainWindow) {
      mainWindow.show();
      mainWindow.focus();
    }
  });
}

const gotTheLock = app.requestSingleInstanceLock();

if (!gotTheLock) {
  console.log('[App] Another instance is already running. Quitting.');
  app.quit();
} else {
  app.on('second-instance', () => {
    // Focus the existing window if user tries to open it again
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.show();
      mainWindow.focus();
    }
  });

  // Start the background daemon dynamically to avoid running it in secondary instances
  import('./daemon/index.js')
    .then(() => {
      // Electron Startup
      app.whenReady().then(() => {
        // Sync startup settings with database state
        const settings = db.getSettings();
        if (global.updateStartupSettings) {
          global.updateStartupSettings(!!settings.startOnBoot);
        }

        createWindow();

        app.on('activate', () => {
          if (BrowserWindow.getAllWindows().length === 0) {
            createWindow();
          }
        });
      });
    })
    .catch((err) => {
      console.error('Failed to start SaveSync background daemon:', err);
      app.quit();
    });

  // Quit when all windows are closed
  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
      app.quit();
    }
  });
}

import { app, BrowserWindow, Tray, Menu, nativeImage, shell } from 'electron';
import { fileURLToPath, pathToFileURL } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const PORT = 3838;
let mainWindow = null;
let tray = null;
let serverStarted = false;

// Check if running from packaged app
const isPackaged = app.isPackaged;
const appPath = isPackaged ? dirname(app.getPath('exe')) : join(__dirname, '..');

// Start the backend server by importing it directly
async function startServer() {
  try {
    // In packaged app, files are in app directory
    const serverPath = isPackaged
      ? join(app.getAppPath(), 'server', 'index.js')
      : join(__dirname, '..', 'server', 'index.js');

    console.log('Starting server from:', serverPath);
    console.log('isPackaged:', isPackaged);
    console.log('app.getAppPath():', app.getAppPath());

    // Set PORT before importing
    process.env.PORT = PORT.toString();

    // Import the server module directly - this runs it in the same process
    // On Windows, we need to use a file:// URL for dynamic import
    const serverUrl = pathToFileURL(serverPath).href;
    await import(serverUrl);
    serverStarted = true;
    console.log('Server started successfully');

    // Give the server a moment to bind to the port
    await new Promise(resolve => setTimeout(resolve, 1000));
  } catch (err) {
    console.error('Failed to start server:', err);
    throw err;
  }
}

// Create system tray
function createTray() {
  // Create a simple icon (16x16 pixels)
  const icon = nativeImage.createFromDataURL(
    'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAABHNCSVQICAgIfAhkiAAAAAlwSFlzAAAAbwAAAG8B8aLcQwAAABl0RVh0U29mdHdhcmUAd3d3Lmlua3NjYXBlLm9yZ5vuPBoAAAE6SURBVDiNpZMxSwNBEIW/TbyISUJwcHBwcHBw8ATk4OLg4OLg4OLg4OLg4OCjonDwB3BwcHBwcHBwcHABW0gPwsHFxRlwcXFxBXRycnJ2cXV1dXV1RYwottN2d3f3b5ILeILffYFmZ2e30Ojv7w/xOBEhhIj8DkBEVv8agIj6kQCIyG8BICK/RwAichsNQET6+QSAyG8JgIj8jAAQkd8EgIjsDAAR2f8CABHZmQGIyG8JQEQGgAjkVwIQUf9KAP4LmJmZYeovnH++gdnZ2PmfiLhBZmbm/4P4DRCR1RqAiPxOC0BEfqUFeHpm5v+D+AsQkY0agIjsTAZQ+f8J/pcBiMj/OAAi8pcFICI7C4CI/AoARHZ6ACIyCwAi8ocCiMj/CgAR2XEAIlL7P4Av0p6j8v9l7I8AAAAASUVORK5CYII='
  );

  tray = new Tray(icon);

  const contextMenu = Menu.buildFromTemplate([
    {
      label: 'Open Dashboard',
      click: () => {
        if (mainWindow) {
          mainWindow.show();
        } else {
          createWindow();
        }
      }
    },
    {
      label: 'Open in Browser',
      click: () => {
        shell.openExternal(`http://localhost:${PORT}`);
      }
    },
    { type: 'separator' },
    {
      label: 'Quit',
      click: () => {
        app.isQuitting = true;
        app.quit();
      }
    }
  ]);

  tray.setToolTip('Framework Control');
  tray.setContextMenu(contextMenu);

  tray.on('double-click', () => {
    if (mainWindow) {
      mainWindow.show();
    } else {
      createWindow();
    }
  });
}

// Create main window
function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1000,
    height: 700,
    minWidth: 800,
    minHeight: 600,
    title: 'Framework Control',
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
    },
    autoHideMenuBar: true,
    backgroundColor: '#0d1117',
  });

  // Load the local web app
  mainWindow.loadURL(`http://localhost:${PORT}`);

  mainWindow.on('close', (event) => {
    if (!app.isQuitting) {
      event.preventDefault();
      mainWindow.hide();
    }
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

// App lifecycle
app.whenReady().then(async () => {
  try {
    console.log('Starting Framework Control...');
    await startServer();
    console.log('Server started');

    createTray();
    createWindow();

    console.log('Framework Control is running');
  } catch (err) {
    console.error('Failed to start:', err);
    app.quit();
  }
});

// Handle protocol for deep linking (optional)
app.setAsDefaultProtocolClient('framework-control');

// Quit when all windows are closed (except on macOS)
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow();
  }
});

// Cleanup on quit
app.on('before-quit', () => {
  app.isQuitting = true;
  // Server runs in main process, no need to kill separately
});

// Handle single instance
const gotTheLock = app.requestSingleInstanceLock();

if (!gotTheLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) {
        mainWindow.restore();
      }
      mainWindow.show();
      mainWindow.focus();
    }
  });
}

import { app, BrowserWindow, Tray, Menu, nativeImage, shell } from 'electron';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { spawn } from 'child_process';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const PORT = 3838;
let mainWindow = null;
let tray = null;
let serverProcess = null;

// Check if running from packaged app
const isPackaged = app.isPackaged;
const appPath = isPackaged ? dirname(app.getPath('exe')) : join(__dirname, '..');

// Start the backend server as a child process
function startServer() {
  return new Promise((resolve, reject) => {
    const serverPath = isPackaged
      ? join(process.resourcesPath, 'server', 'index.js')
      : join(__dirname, '..', 'server', 'index.js');

    const nodePath = process.execPath;

    console.log('Starting server from:', serverPath);
    console.log('Using node:', nodePath);

    serverProcess = spawn(nodePath, [serverPath], {
      env: { ...process.env, PORT: PORT.toString() },
      stdio: ['pipe', 'pipe', 'pipe', 'ipc'],
      detached: false,
      shell: false
    });

    let serverReady = false;

    serverProcess.stdout.on('data', (data) => {
      const msg = data.toString();
      console.log(`Server: ${msg}`);
      if (!serverReady && (msg.includes('SERVER_READY') || msg.includes('http://localhost'))) {
        serverReady = true;
        resolve();
      }
    });

    serverProcess.stderr.on('data', (data) => {
      console.error(`Server Error: ${data}`);
    });

    serverProcess.on('error', (err) => {
      console.error('Failed to start server:', err);
      reject(err);
    });

    serverProcess.on('exit', (code) => {
      if (code !== 0 && code !== null) {
        console.error(`Server exited with code ${code}`);
      }
    });

    // Timeout fallback - resolve after 10 seconds even if server doesn't print
    setTimeout(() => {
      if (!serverReady) {
        console.log('Server startup timeout, continuing...');
        resolve();
      }
    }, 10000);
  });
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

  if (serverProcess) {
    serverProcess.kill();
  }
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

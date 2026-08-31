'use strict';

/**
 * NEXORAOSP RESTAURANT — desktop staff console.
 *
 * The desktop app is a thin, hardened Electron shell around the same Express
 * server that powers the web deployment:
 *
 *   1. A free local port is reserved.
 *   2. The bundled server (app/server.cjs) is started as a child process with
 *      NODE_ENV=production, HOST=127.0.0.1, DIST_DIR=<bundled web build> and
 *      DATA_DIR=<user data>/data, so all orders/menu data live in a writable,
 *      per-user folder (never inside the install directory).
 *   3. The window loads http://127.0.0.1:<port>/admin once /api/health answers.
 *
 * The renderer is a normal browser context: no Node integration, sandboxed,
 * with a single contextBridge API exposed by preload.cjs.
 */

const { app, BrowserWindow, Menu, dialog, ipcMain, shell } = require('electron');
const { fork } = require('child_process');
const http = require('http');
const net = require('net');
const path = require('path');
const fs = require('fs');

const APP_NAME = 'NEXORAOSP RESTAURANT';
const WINDOW_TITLE = `${APP_NAME} — Staff Console`;
const SERVER_READY_TIMEOUT_MS = 30000;
const SERVER_POLL_MS = 250;
/** First-choice ports for the local server; the next free one is used. */
const PORT_CANDIDATES = [38245, 38246, 38247, 38248, 38249, 38250];

const resourcesDir = () => path.join(__dirname, 'app');
const distDir = () => path.join(resourcesDir(), 'dist');
const serverEntry = () => path.join(resourcesDir(), 'server.cjs');
const dataDir = () => path.join(app.getPath('userData'), 'data');

let serverProcess = null;
let serverPort = null;
let mainWindow = null;
let isQuitting = false;
let serverLogTail = [];

// ── Local server lifecycle ──────────────────────────────────────────────────

/** Reserve an unused TCP port so the server can be started on it. */
function reservePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

function waitForServer(port, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const attempt = () => {
      const req = http.get(
        { host: '127.0.0.1', port, path: '/api/health', timeout: 2000 },
        (res) => {
          res.resume();
          if (res.statusCode === 200) resolve();
          else if (Date.now() > deadline) reject(new Error(`Health check returned HTTP ${res.statusCode}`));
          else setTimeout(attempt, SERVER_POLL_MS);
        }
      );
      req.on('error', () => {
        if (Date.now() > deadline) reject(new Error('Server did not become ready in time'));
        else setTimeout(attempt, SERVER_POLL_MS);
      });
      req.on('timeout', () => req.destroy());
    };
    attempt();
  });
}

function spawnServer(port) {
  const child = fork(serverEntry(), [], {
    execPath: process.execPath,
    cwd: resourcesDir(),
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: '1',
      NODE_ENV: 'production',
      HOST: '127.0.0.1',
      PORT: String(port),
      DIST_DIR: distDir(),
      DATA_DIR: dataDir(),
      APP_URL: `http://127.0.0.1:${port}`,
    },
  });

  const collect = (chunk) => {
    const line = chunk.toString().trim();
    if (!line) return;
    serverLogTail.push(line);
    if (serverLogTail.length > 40) serverLogTail.shift();
    console.log(`[server] ${line}`);
  };
  child.stdout?.on('data', collect);
  child.stderr?.on('data', collect);

  return child;
}

/** Start (or restart) the bundled local server, retrying on a busy port. */
async function ensureServer(preferredPort) {
  const attempts = preferredPort ? [preferredPort, ...PORT_CANDIDATES] : PORT_CANDIDATES;

  for (let i = 0; i < attempts.length; i += 1) {
    const port = i === 0 && preferredPort ? preferredPort : await reservePort();
    try {
      fs.mkdirSync(dataDir(), { recursive: true });
    } catch {
      // A missing data directory is reported by the server itself.
    }

    serverLogTail = [];
    const child = spawnServer(port);
    serverProcess = child;

    let exitedEarly = null;
    child.once('exit', (code, signal) => {
      if (serverProcess === child) {
        serverProcess = null;
        exitedEarly = new Error(`Local server exited (code=${code}, signal=${signal})`);
      }
    });

    try {
      await waitForServer(port, SERVER_READY_TIMEOUT_MS);
      serverPort = port;
      return port;
    } catch (error) {
      if (serverProcess === child) {
        child.kill('SIGKILL');
        serverProcess = null;
      }
      const message = exitedEarly ? `${error.message}\n${exitedEarly.message}` : error.message;
      if (i === attempts.length - 1) throw new Error(`${message}\n\n${serverLogTail.slice(-12).join('\n')}`);
      console.error(`[desktop] server did not start on port ${port}: ${message} — trying another port`);
    }
  }

  throw new Error('Could not start the local server on any port.');
}

function stopServer() {
  const child = serverProcess;
  serverProcess = null;
  if (!child) return;
  try {
    child.kill('SIGTERM');
  } catch {
    // Already gone.
  }
}

// ── Window ──────────────────────────────────────────────────────────────────

function iconPath() {
  const candidates =
    process.platform === 'win32'
      ? ['icon.ico', 'icon.png']
      : process.platform === 'darwin'
        ? ['icon.icns', 'icon.png']
        : ['icon.png'];
  for (const name of candidates) {
    const full = path.join(__dirname, 'build', name);
    if (fs.existsSync(full)) return full;
  }
  return undefined;
}

function createWindow(port) {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1024,
    minHeight: 700,
    show: false,
    backgroundColor: '#faf8f5',
    title: WINDOW_TITLE,
    autoHideMenuBar: true,
    icon: iconPath(),
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
    },
  });

  mainWindow.once('ready-to-show', () => mainWindow?.show());
  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  const localOrigin = `http://127.0.0.1:${port}`;

  // Any link that leaves the local app opens in the system browser instead of
  // replacing the console.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url) && !url.startsWith(localOrigin)) {
      shell.openExternal(url).catch(() => undefined);
    }
    return { action: 'deny' };
  });

  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (!url.startsWith(localOrigin)) {
      event.preventDefault();
      if (/^https?:\/\//i.test(url)) shell.openExternal(url).catch(() => undefined);
    }
  });

  mainWindow.webContents.on('render-process-gone', (_event, details) => {
    if (isQuitting || details.reason === 'clean-exit') return;
    dialog.showErrorBox(
      `${APP_NAME} stopped responding`,
      `The interface had to be reloaded (${details.reason}).`
    );
    mainWindow?.loadURL(`${localOrigin}/admin`);
  });

  return mainWindow.loadURL(`${localOrigin}/admin`);
}

async function restartServerAndReload() {
  if (!mainWindow) return;
  stopServer();
  try {
    const port = await ensureServer(serverPort);
    await createWindow(port);
  } catch (error) {
    dialog.showErrorBox(`${APP_NAME}: local server failed`, String(error?.message || error));
  }
}

function buildMenu() {
  const isMac = process.platform === 'darwin';
  const template = [
    ...(isMac ? [{ role: 'appMenu' }] : []),
    { role: 'editMenu' },
    { role: 'viewMenu' },
    { role: 'windowMenu' },
    {
      label: 'Console',
      submenu: [
        {
          label: 'Open Data Folder',
          click: () => shell.openPath(dataDir()),
        },
        {
          label: 'Restart Local Server',
          click: () => void restartServerAndReload(),
        },
        { type: 'separator' },
        isMac ? { role: 'close' } : { role: 'quit' },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// ── Renderer bridge (see preload.cjs) ───────────────────────────────────────

ipcMain.handle('desktop:info', () => ({
  isDesktop: true,
  platform: process.platform,
  arch: process.arch,
  appVersion: app.getVersion(),
  electronVersion: process.versions.electron,
  serverPort,
  dataDir: dataDir(),
}));

ipcMain.handle('desktop:open-data-folder', async () => {
  try {
    fs.mkdirSync(dataDir(), { recursive: true });
  } catch {
    // The error string returned below tells the user what happened.
  }
  return shell.openPath(dataDir());
});

// ── App bootstrap ───────────────────────────────────────────────────────────

async function showStartupError(error) {
  await dialog.showMessageBox({
    type: 'error',
    title: `${APP_NAME} could not start`,
    message: 'The local order server did not start.',
    detail: String(error?.message || error),
    buttons: ['Close'],
  });
}

const gotSingleInstanceLock = app.requestSingleInstanceLock();

if (!gotSingleInstanceLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  });

  app.whenReady().then(async () => {
    app.setAboutPanelOptions({
      applicationName: APP_NAME,
      applicationVersion: app.getVersion(),
      copyright: 'NEXORAOSP RESTAURANT',
    });
    buildMenu();

    try {
      const port = await ensureServer();
      await createWindow(port);
    } catch (error) {
      await showStartupError(error);
      app.quit();
      return;
    }

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0 && serverPort) {
        void createWindow(serverPort);
      }
    });
  });
}

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => {
  isQuitting = true;
  stopServer();
});

process.on('exit', stopServer);

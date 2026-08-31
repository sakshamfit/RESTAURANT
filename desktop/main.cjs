'use strict';

/**
 * NEXORAOSP RESTAURANT — desktop staff console.
 *
 * The desktop app is a thin, hardened Electron shell around the same Express
 * server that powers the web deployment:
 *
 *   1. A free local port is reserved.
 *   2. The bundled server (app/server.cjs) is started as a child process with
 *      NODE_ENV=production, HOST=0.0.0.0, DIST_DIR=<bundled web build> and
 *      DATA_DIR=<user data>/data, so all orders/menu data live in a writable,
 *      per-user folder (never inside the install directory). Binding to
 *      0.0.0.0 (not 127.0.0.1) is what lets customer phones on the café
 *      Wi-Fi open the printed table QR codes — the loopback-only address is
 *      not reachable from another device.
 *   3. The window loads http://127.0.0.1:<port>/admin once /api/health answers.
 *
 * The renderer is a normal browser context: no Node integration, sandboxed,
 * with a single contextBridge API exposed by preload.cjs.
 */

const { app, BrowserWindow, Menu, dialog, ipcMain, shell, clipboard } = require('electron');
const { fork } = require('child_process');
const http = require('http');
const net = require('net');
const os = require('os');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
// Auto-update via electron-updater. The package reads its configuration
// from the `build.publish` block in desktop/package.json — by default it
// expects GitHub Releases under the same org/repo as the project. Set
// `GH_TOKEN` in the build env to publish, and `autoUpdater` will
// download new installers from the release page when the user runs
// `Check for updates` from the Help menu.
let autoUpdater = null;
try {
  ({ autoUpdater } = require('electron-updater'));
  // Don't auto-install on quit unless the user OK'd it. Showing the
  // update dialog is controlled by the renderer (see Console menu).
  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = false;
} catch (error) {
  // electron-updater is an optional dep. Older self-built dev shells
  // might not have it. Don't crash — just disable the menu entry.
  console.warn('[desktop] electron-updater not available, auto-update disabled:', error?.message || error);
}

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

// ── Network helpers ────────────────────────────────────────────────────────

/**
 * Returns the machine's non-internal IPv4 addresses so the printed table QR
 * codes can point at a URL a customer's phone on the same Wi-Fi can actually
 * open. The desktop server must be bound to 0.0.0.0 (see spawnServer) for
 * these to be reachable from another device.
 *
 * Order is "most-likely-the-café-wifi-first": physical/Wi-Fi adapters sort
 * before virtual/VPN ones, and we de-duplicate.
 */
function getLanAddresses() {
  const interfaces = os.networkInterfaces();
  const out = [];
  const seen = new Set();
  for (const name of Object.keys(interfaces)) {
    for (const info of interfaces[name] || []) {
      if (info.family !== 'IPv4' || info.internal) continue;
      if (seen.has(info.address)) continue;
      seen.add(info.address);
      // Heuristic: physical / Wi-Fi adapters come first on every desktop OS we
      // support, virtual adapters (Docker, WSL, VPNs, virtual hosts) come last.
      const isVirtual = /virtual|vmware|hyper-v|hyperv|docker|wsl|veth|tunnel|utun|tap|tun|loopback|pseudo/i.test(name);
      if (isVirtual) out.push({ address: info.address, interface: name, priority: 1 });
      else out.push({ address: info.address, interface: name, priority: 0 });
    }
  }
  out.sort((a, b) => a.priority - b.priority);
  return out;
}

function buildLanUrls(port) {
  return getLanAddresses().map((entry) => ({
    url: `http://${entry.address}:${port}`,
    address: entry.address,
    interface: entry.interface,
  }));
}

/**
 * A stable per-machine identifier used for license binding. The hash
 * inputs (hostname, platform, arch, CPU model, total memory) survive
 * reboots and minor OS patches but change if the user moves the disk
 * to a new computer — which is exactly the "this is a different machine"
 * signal the license server needs. We don't include MAC addresses, disk
 * serials, or anything else that requires elevated privileges.
 */
let cachedFingerprint = null;
function getMachineFingerprint() {
  if (cachedFingerprint) return cachedFingerprint;
  const cpus = os.cpus() || [];
  const firstCpu = cpus[0] || {};
  const inputs = [
    os.hostname(),
    os.platform(),
    os.arch(),
    firstCpu.model || 'unknown-cpu',
    String(os.totalmem()),
    String(cpus.length),
  ];
  const hash = crypto.createHash('sha256').update(inputs.join('|')).digest('hex');
  cachedFingerprint = `desktop-${hash.slice(0, 32)}`;
  return cachedFingerprint;
}

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
      // Bind to every interface so customer phones on the same Wi-Fi can
      // reach the table QR URLs. 127.0.0.1 alone would make the printed QR
      // codes point at the staff machine's loopback — a phone scanning them
      // gets "Safari could not connect to the server".
      HOST: '0.0.0.0',
      PORT: String(port),
      DIST_DIR: distDir(),
      DATA_DIR: dataDir(),
      APP_URL: `http://127.0.0.1:${port}`,
      // Tells the server it's running inside the packaged desktop app, so
      // /api/health reports isDesktop=true and the staff console hides the
      // "set DATABASE_URL in Vercel" tip. DESKTOP_LAN_URLS carries the JSON
      // list of LAN addresses the server is also listening on, so the QR
      // codes point at a URL a customer's phone can reach.
      DESKTOP_APP: '1',
      DESKTOP_LAN_URLS: JSON.stringify(buildLanUrls(port)),
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
          label: 'Copy LAN address for QR codes',
          click: () => {
            const urls = buildLanUrls(serverPort || 0);
            if (urls.length === 0) {
              dialog.showMessageBox({
                type: 'info',
                title: APP_NAME,
                message: 'No LAN address detected',
                detail: 'This machine does not appear to have a Wi-Fi or Ethernet IPv4 address. Connect the staff computer to the café Wi-Fi and choose Console → Restart Local Server.',
              });
              return;
            }
            const primary = urls[0].url;
            clipboard.writeText(primary);
            const detail =
              urls.length === 1
                ? `Copied ${primary} to the clipboard.\n\nPrint QR codes from Admin → Tables & QRs. Customer phones on the same Wi-Fi will open the menu at this address.`
                : `Copied ${primary} to the clipboard. Other addresses on this machine:\n\n${urls.map((u) => `• ${u.url}  (${u.interface})`).join('\n')}\n\nUse the one matching your café Wi-Fi.`;
            dialog.showMessageBox({
              type: 'info',
              title: APP_NAME,
              message: 'LAN address copied',
              detail,
            });
          },
        },
        {
          label: 'Restart Local Server',
          click: () => void restartServerAndReload(),
        },
        { type: 'separator' },
        {
          label: 'Check for updates',
          click: () => void checkForUpdatesInteractive(),
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
  /** Loopback URL the staff window is loaded from. */
  localUrl: serverPort ? `http://127.0.0.1:${serverPort}` : null,
  /** Every LAN IPv4 the bundled server is also listening on. The first one
   *  is the one the printed table QR codes should use. */
  lanUrls: serverPort ? buildLanUrls(serverPort) : [],
}));

ipcMain.handle('desktop:open-data-folder', async () => {
  try {
    fs.mkdirSync(dataDir(), { recursive: true });
  } catch {
    // The error string returned below tells the user what happened.
  }
  return shell.openPath(dataDir());
});

ipcMain.handle('desktop:machine-fingerprint', () => getMachineFingerprint());

// ── Auto-update ────────────────────────────────────────────────────────────
// Uses electron-updater. Configuration is read from desktop/package.json's
//  block. When  is not present (dev builds
// without electron-updater installed) every call is a no-op that returns
// ok:false so the renderer can show "auto-update not available" cleanly.

function safeUpdaterCall(fn) {
  if (!autoUpdater) return Promise.resolve(null);
  return Promise.resolve()
    .then(() => fn())
    .catch((error) => {
      console.warn('[updater] error:', error?.message || error);
      return null;
    });
}

async function checkForUpdatesInteractive() {
  if (!autoUpdater) {
    await dialog.showMessageBox({
      type: 'info',
      title: APP_NAME,
      message: 'Auto-update is not available in this build.',
      detail: 'This usually means the desktop app was built without electron-updater. Reinstall the latest release from your download site.',
    });
    return;
  }
  try {
    const result = await autoUpdater.checkForUpdates();
    const update = result && (result.updateInfo || result);
    if (update && update.version && update.version !== app.getVersion()) {
      const releaseNotes = (update.releaseNotes && typeof update.releaseNotes === 'string')
        ? update.releaseNotes
        : 'A new version is available.';
      const choice = await dialog.showMessageBox({
        type: 'info',
        title: 'Update available',
        message: `Version ${update.version} is available (you have ${app.getVersion()}).`,
        detail: releaseNotes,
        buttons: ['Download and install', 'Later'],
        defaultId: 0,
        cancelId: 1,
      });
      if (choice.response === 0) {
        await autoUpdater.downloadUpdate();
        const install = await dialog.showMessageBox({
          type: 'question',
          title: 'Restart to apply update',
          message: 'The new version has been downloaded. Restart now?',
          detail: 'The app will close, install the update, and reopen with your data intact.',
          buttons: ['Restart now', 'On next launch'],
          defaultId: 0,
          cancelId: 1,
        });
        if (install.response === 0) {
          // isForceRunAfter = true, restart immediately.
          autoUpdater.quitAndInstall(false, true);
        } else {
          autoUpdater.autoInstallOnAppQuit = true;
        }
      }
    } else {
      await dialog.showMessageBox({
        type: 'info',
        title: APP_NAME,
        message: `You're on the latest version (${app.getVersion()}).`,
      });
    }
  } catch (error) {
    await dialog.showMessageBox({
      type: 'warning',
      title: 'Update check failed',
      message: 'Could not check for updates.',
      detail: error?.message || String(error),
    });
  }
}

ipcMain.handle('desktop:check-for-updates', () => checkForUpdatesInteractive());

ipcMain.handle('desktop:get-update-state', async () => {
  if (!autoUpdater) {
    return { available: false, reason: 'not-configured' };
  }
  try {
    const result = await safeUpdaterCall(() => autoUpdater.checkForUpdates());
    const update = result && (result.updateInfo || result);
    if (!update || !update.version) return { available: false };
    return {
      available: update.version !== app.getVersion(),
      currentVersion: app.getVersion(),
      latestVersion: update.version,
    };
  } catch (error) {
    return { available: false, reason: 'error', error: error?.message || String(error) };
  }
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

    // Background update check: on startup and every 4 hours. Silent
    // failures only — the renderer asks for the result via the
    // bridge.getUpdateState() call when it boots.
    if (autoUpdater) {
      const silentCheck = () => {
        autoUpdater.checkForUpdates().catch((error) => {
          console.warn('[updater] background check failed:', error?.message || error);
        });
      };
      // 5-second delay so the renderer has time to wire up its IPC
      // listener before the first check resolves.
      setTimeout(silentCheck, 5_000);
      setInterval(silentCheck, 4 * 60 * 60 * 1000);
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

'use strict';

/**
 * NEXORAOSP RESTAURANT — desktop staff console (portable launcher).
 *
 * Starts the bundled Express server (resources/server.cjs) on a free
 * loopback port, waits for /api/health, then opens the admin console in
 * the default browser. All orders/menu/settings data lives in
 * ~/.nexoraosp-restaurant/data (override with NEXORAOSP_DATA_DIR) — it
 * never leaves this machine unless you configure a database.
 *
 * Requires Node.js 18+ (the Electron build in desktop/ is the
 * self-contained alternative with its own runtime).
 */

const { fork, spawn } = require('child_process');
const http = require('http');
const net = require('net');
const path = require('path');
const fs = require('fs');
const os = require('os');

const APP_NAME = 'NEXORAOSP RESTAURANT';
const APP_DIR = path.resolve(__dirname);
const RESOURCES = path.join(APP_DIR, 'resources');
const SERVER_ENTRY = path.join(RESOURCES, 'server.cjs');
const DIST_DIR = path.join(RESOURCES, 'dist');
const DATA_DIR = process.env.NEXORAOSP_DATA_DIR || path.join(os.homedir(), '.nexoraosp-restaurant', 'data');
const READY_TIMEOUT_MS = 30000;
const POLL_MS = 250;

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
      const req = http.get({ host: '127.0.0.1', port, path: '/api/health', timeout: 2000 }, (res) => {
        res.resume();
        if (res.statusCode === 200) resolve();
        else if (Date.now() > deadline) reject(new Error(`Health check returned HTTP ${res.statusCode}`));
        else setTimeout(attempt, POLL_MS);
      });
      req.on('error', () => {
        if (Date.now() > deadline) reject(new Error('Server did not become ready in time'));
        else setTimeout(attempt, POLL_MS);
      });
      req.on('timeout', () => req.destroy());
    };
    attempt();
  });
}

function openBrowser(url) {
  if (process.env.NEXORAOSP_NO_OPEN === '1') return;
  let cmd;
  if (process.platform === 'darwin') cmd = 'open';
  else if (process.platform === 'win32') cmd = 'cmd';
  else cmd = 'xdg-open';
  try {
    const args = process.platform === 'win32' ? ['/c', 'start', '', url] : [url];
    spawn(cmd, args, { detached: true, stdio: 'ignore' }).unref();
  } catch {
    console.log(`\n  (could not open a browser automatically — open ${url} manually)`);
  }
}

function printUrl(port) {
  console.log(`
  ${APP_NAME} — Staff Console
  ─────────────────────────────────────────────────
  Open:  http://127.0.0.1:${port}/admin
  Data:  ${DATA_DIR}
  ─────────────────────────────────────────────────
  Keep this window open while the app is in use.
  Press Ctrl+C to stop the app.`);
}

(async () => {
  const port = await reservePort();
  fs.mkdirSync(DATA_DIR, { recursive: true });

  const child = fork(SERVER_ENTRY, [], {
    cwd: RESOURCES,
    stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
    env: {
      ...process.env,
      NODE_ENV: 'production',
      HOST: '127.0.0.1',
      PORT: String(port),
      DIST_DIR,
      DATA_DIR,
      APP_URL: `http://127.0.0.1:${port}`,
    },
  });

  let stopping = false;
  child.once('exit', (code, signal) => {
    if (!stopping) {
      console.error(`\n${APP_NAME} local server exited (code=${code}, signal=${signal}).`);
      process.exit(code ?? 1);
    }
  });

  try {
    await waitForServer(port, READY_TIMEOUT_MS);
  } catch (err) {
    console.error(`\n${APP_NAME} local server failed to start:\n  ${err.message}`);
    child.kill('SIGTERM');
    process.exit(1);
  }

  printUrl(port);
  openBrowser(`http://127.0.0.1:${port}/admin`);

  const stop = () => {
    if (stopping) return;
    stopping = true;
    console.log('\nStopping NEXORAOSP RESTAURANT...');
    child.kill('SIGTERM');
    setTimeout(() => process.exit(0), 800);
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
})().catch((err) => {
  console.error(`${APP_NAME} failed to start:\n  ${err.message}`);
  process.exit(1);
});

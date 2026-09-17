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

function getLanAddresses() {
  const interfaces = os.networkInterfaces();
  const out = [];
  const seen = new Set();
  for (const name of Object.keys(interfaces)) {
    for (const info of interfaces[name] || []) {
      if (info.family !== 'IPv4' || info.internal) continue;
      if (seen.has(info.address)) continue;
      seen.add(info.address);
      const isVirtual = /virtual|vmware|hyper-v|hyperv|docker|wsl|veth|tunnel|tap|tun|loopback|pseudo|bridge|br-/i.test(name);
      const isUtun = /^utun\d+$/i.test(name);
      let rangePriority = 10;
      if (info.address.startsWith('192.168.')) rangePriority = 0;
      else if (info.address.startsWith('10.')) rangePriority = 1;
      else if (/^172\.(1[6-9]|2\d|3[01])\./.test(info.address)) rangePriority = 2;
      else if (info.address.startsWith('169.254.')) rangePriority = 100;
      let priority = rangePriority + (isVirtual ? 50 : 0) + (isUtun ? 60 : 0);
      if (/^(en0|eth0|wlan0|wi-fi|wifi|wlp)/i.test(name)) priority -= 5;
      out.push({ address: info.address, interface: name, priority });
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

function printUrl(port, lanUrls) {
  const primary = lanUrls[0]?.url || `http://127.0.0.1:${port}`;
  console.log(`
  ${APP_NAME} — Staff Console (QR FIXED)
  ─────────────────────────────────────────────────
  Admin:  http://127.0.0.1:${port}/admin  (this PC)
  LAN:    ${primary}/admin  (for phones on same Wi-Fi)
  ${lanUrls.length > 1 ? `Other:  ${lanUrls.slice(1).map(u=>u.url).join(', ')}` : ''}
  Data:  ${DATA_DIR}
  QR:     QR codes now use LAN IP (${primary}) not 127.0.0.1
  ─────────────────────────────────────────────────
  Keep this window open while the app is in use.
  Press Ctrl+C to stop the app.`);
  if (lanUrls.length === 0) {
    console.log(`\n  ⚠ No LAN IP detected! QR will show 127.0.0.1 and phones can't open it.`);
    console.log(`  Connect to Wi-Fi and restart, or set APP_URL env to your LAN IP.`);
  }
}

(async () => {
  const port = await reservePort();
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const lanUrls = buildLanUrls(port);

  const child = fork(SERVER_ENTRY, [], {
    cwd: RESOURCES,
    stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
    env: {
      ...process.env,
      NODE_ENV: 'production',
      HOST: '0.0.0.0',
      PORT: String(port),
      DIST_DIR,
      DATA_DIR,
      DESKTOP_APP: '1',
      DESKTOP_LAN_URLS: JSON.stringify(lanUrls),
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

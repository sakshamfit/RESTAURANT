import express from 'express';
import path from 'path';
import os from 'os';
import dotenv from 'dotenv';
// Explicit .js specifiers so this file also runs correctly as native ESM
// ("type": "module") after a plain tsc/esbuild transpile without bundling.
import { store } from './src/server/store.js';
import { initAdminAuth } from './src/server/auth.js';
import { createApp } from './src/server/app.js';
import { startBackupScheduler } from './src/server/backup/index.js';

dotenv.config();

const app = createApp();
const PORT = Number(process.env.PORT || 3000);
// The packaged desktop app runs the server for one local window only, so it
// binds 127.0.0.1 instead of every network interface.
const HOST = process.env.HOST || '0.0.0.0';

function pgUrlSafe() {
  // Hostname only — never log credentials.
  try {
    return new URL(process.env.DATABASE_URL || '');
  } catch {
    return new URL('postgresql://unconfigured');
  }
}

async function startServer() {
  await initAdminAuth();
  await store.waitUntilReady();
  if (process.env.NODE_ENV !== 'production') {
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      server: {
        middlewareMode: true,
        // Allow LAN IPs, preview domains, ngrok, etc — otherwise phones
        // scanning QR codes get blocked by Vite's host check.
        allowedHosts: true,
      },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distPath = process.env.DIST_DIR
      ? path.resolve(process.env.DIST_DIR)
      : path.join(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('*', (_req, res) => res.sendFile(path.join(distPath, 'index.html')));
  }

  // Automatic backups (one daily run + catch-up if the machine was off, then the
  // cloud retry timer). Started after the store is ready and deliberately NOT
  // started in vercel-api/index.ts: a serverless function must not leave a timer
  // behind. It never blocks or delays the requests above, and every failure inside
  // it is recorded instead of thrown.
  try {
    startBackupScheduler();
  } catch (error) {
    console.warn('[backup] automatic backup scheduler could not start:', (error as Error)?.message || error);
  }

  app.listen(PORT, HOST, () => {
    console.log(`NEXORAOSP RESTAURANT server running on http://${HOST}:${PORT} (persistence: ${store.provider})`);
    if (store.provider === 'postgres') {
      console.log(`Persistence: direct Postgres via DATABASE_URL (${new URL(pgUrlSafe()).host}).`);
    } else {
      console.log('Persistence: local file data/restaurant.json. No cloud services used.');
    }
    // Show LAN URLs so staff knows which URL to print on QR codes
    try {
      const nets = os.networkInterfaces();
      const ips: { iface: string; addr: string }[] = [];
      for (const name of Object.keys(nets)) {
        for (const net of nets[name] || []) {
          if ((net as any).family === 'IPv4' && !(net as any).internal) ips.push({ iface: name, addr: (net as any).address });
        }
      }
      if (ips.length > 0) {
        console.log(`LAN addresses for QR codes (phones must be on same Wi-Fi):`);
        ips.forEach(({ iface, addr }) => console.log(`  - ${iface}: ${addr} => http://${addr}:${PORT}`));
        console.log(`If QR still shows 127.0.0.1, set APP_URL env or qrBaseUrl in Admin Settings to your LAN URL.`);
      } else {
        console.log('No LAN IPv4 detected — connect this machine to Wi-Fi/Ethernet for QR codes to work on phones.');
      }
      if (process.env.APP_URL) {
        console.log(`APP_URL override active: ${process.env.APP_URL} — QR codes will use this.`);
      }
    } catch {}
  });
}

startServer().catch((error) => {
  console.error('Failed to start server:', error);
  process.exit(1);
});

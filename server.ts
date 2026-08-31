import express from 'express';
import path from 'path';
import dotenv from 'dotenv';
// Explicit .js specifiers so this file also runs correctly as native ESM
// ("type": "module") after a plain tsc/esbuild transpile without bundling.
import { store } from './src/server/store.js';
import { initAdminAuth } from './src/server/auth.js';
import { createApp } from './src/server/app.js';

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
    // Imported lazily so a production bundle (web host or packaged desktop app)
    // never needs Vite installed.
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      server: {
        middlewareMode: true,
        allowedHosts: ['.e2b.app', 'localhost'],
      },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    // DIST_DIR lets the packaged desktop app point at its bundled assets;
    // everywhere else the Vite build sits next to the server in ./dist.
    const distPath = process.env.DIST_DIR
      ? path.resolve(process.env.DIST_DIR)
      : path.join(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('*', (_req, res) => res.sendFile(path.join(distPath, 'index.html')));
  }

  app.listen(PORT, HOST, () => {
    console.log(`NEXORAOSP RESTAURANT server running on http://${HOST}:${PORT} (persistence: ${store.provider})`);
    if (store.provider === 'postgres') {
      console.log(`Persistence: direct Postgres via DATABASE_URL (${new URL(pgUrlSafe()).host}).`);
    } else {
      console.log('Persistence: local file data/restaurant.json. No cloud services used.');
    }
  });
}

startServer().catch((error) => {
  console.error('Failed to start server:', error);
  process.exit(1);
});

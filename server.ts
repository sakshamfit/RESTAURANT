import express from 'express';
import path from 'path';
import { createServer as createViteServer } from 'vite';
import dotenv from 'dotenv';
import { store } from './src/server/store';
import { initAdminAuth } from './src/server/auth';
import { createApp } from './src/server/app';

dotenv.config();

const app = createApp();
const PORT = Number(process.env.PORT || 3000);

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
    const vite = await createViteServer({
      server: {
        middlewareMode: true,
        allowedHosts: ['.e2b.app', 'localhost'],
      },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('*', (_req, res) => res.sendFile(path.join(distPath, 'index.html')));
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`Nagori Chai Point server running on http://0.0.0.0:${PORT} (persistence: ${store.provider})`);
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

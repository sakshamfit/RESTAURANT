import express from 'express';
import path from 'path';
import { createServer as createViteServer } from 'vite';
import dotenv from 'dotenv';
// Explicit .js specifiers so this file also runs correctly as native ESM
// ("type": "module") after a plain tsc/esbuild transpile without bundling.
import { store } from './src/server/store.js';
import { initAdminAuth } from './src/server/auth.js';
import { createApp } from './src/server/app.js';

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

  // A dead database must be impossible to miss at start-up. Nothing exits here
  // on purpose (the background recovery can still heal a paused database), but
  // the operator gets the reason and the fix in the first lines of output.
  const diagnostics = store.getDiagnostics();
  if (diagnostics.failingLoudly) {
    console.error(
      `\n*** DATABASE UNAVAILABLE — the server is starting, but every data request will return 503. ***\n` +
        `    host:  ${diagnostics.postgresHost || '(DATABASE_URL not configured)'}\n` +
        `    error: ${diagnostics.postgresError?.message || 'unknown error'}\n` +
        `    fix:   ${diagnostics.postgresError?.hint || 'Set DATABASE_URL correctly and restart.'}\n`
    );
  }
  if (diagnostics.localFileFallbackActive) {
    console.error(
      `\n*** DATABASE UNAVAILABLE — falling back to the local file ${diagnostics.dataFile} (development only). ***\n` +
        `    error: ${diagnostics.postgresError?.message || 'unknown error'}\n` +
        `    fix:   ${diagnostics.postgresError?.hint || 'Check DATABASE_URL.'}\n`
    );
  }
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

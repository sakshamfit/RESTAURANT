// Vercel serverless entry point.
// All /api/* routes are handled by the Express app; the built React app in /dist
// is served by Vercel as static files (see vercel.json).
import { initAdminAuth } from '../src/server/auth';
import { store } from '../src/server/store';
import { createApp } from '../src/server/app';
import express from 'express';

// Initialize asynchronously on cold start.
let initPromise: Promise<void> | null = null;
let initError: Error | null = null;

function ensureInit(): Promise<void> {
  if (!initPromise) {
    initPromise = (async () => {
      try {
        await initAdminAuth();
        await store.waitUntilReady();
      } catch (err) {
        initError = err as Error;
        console.error('[api] Initialization error:', err);
      }
    })();
  }
  return initPromise;
}

// Wrap the Express app so initialization completes before any request is handled.
const wrapper = express();

// Initialization middleware — runs first, before the API routes below.
wrapper.use(async (_req, res, next) => {
  await ensureInit();
  if (initError) {
    return res.status(500).json({
      error: 'Server initialization failed',
      details: initError.message,
    });
  }
  next();
});

// Mount the actual API routes.
const apiApp = createApp();
wrapper.use(apiApp);

export default wrapper;

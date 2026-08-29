// Vercel serverless entry point.
// All /api/* routes are handled by this function; the built React app in /dist
// is served by Vercel as static files (see vercel.json).
import { initAdminAuth } from '../src/server/auth';
import { store } from '../src/server/store';
import { createApp } from '../src/server/app';
import type { IncomingMessage, ServerResponse } from 'http';

let app: ReturnType<typeof createApp> | null = null;
let ready: Promise<void> | null = null;
let readyError: Error | null = null;

async function ensureReady() {
  if (!ready) {
    ready = (async () => {
      try {
        await initAdminAuth();
        await store.waitUntilReady();
        app = createApp();
      } catch (err) {
        readyError = err as Error;
        throw err;
      }
    })();
  }
  await ready;
  return app as ReturnType<typeof createApp>;
}

export default async function handler(req: IncomingMessage, res: ServerResponse) {
  try {
    const expressApp = await ensureReady();
    expressApp(req, res);
  } catch (error: any) {
    console.error('[api] Handler error:', error);
    if (!res.writableEnded) {
      const message = error?.message || 'Internal server error';
      res.statusCode = 500;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ error: 'Server initialization failed', details: message }));
    }
  }
}

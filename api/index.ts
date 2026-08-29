// Vercel serverless entry point.
// All /api/* routes are handled by this function; the built React app in /dist
// is served by Vercel as static files (see vercel.json).
import { initAdminAuth } from '../src/server/auth';
import { store } from '../src/server/store';
import { createApp } from '../src/server/app';
import type { IncomingMessage, ServerResponse } from 'http';

let app: ReturnType<typeof createApp> | null = null;
let ready: Promise<void> | null = null;

async function ensureReady() {
  if (!ready) {
    ready = (async () => {
      await initAdminAuth();
      await store.waitUntilReady();
      app = createApp();
    })();
  }
  await ready;
  return app as ReturnType<typeof createApp>;
}

export default async function handler(req: IncomingMessage, res: ServerResponse) {
  const expressApp = await ensureReady();
  expressApp(req, res);
}

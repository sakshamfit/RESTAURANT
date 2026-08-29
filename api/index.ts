// Vercel serverless entry point.
//
// This delegates to the very same Express app that the local and self-hosted
// servers run (src/server/app.ts), so the deployed API can never drift from the
// one that is developed and tested against.
//
// It used to be a separate ~730-line in-memory reimplementation. That caused
// three concrete failures on Vercel:
//   1. Every serverless instance kept its own private copy of the data and each
//      cold start reset it, so orders and menu edits appeared and disappeared
//      depending on which instance answered the request.
//   2. It never read process.env at all, so the ADMIN_PASSWORD that DEPLOY.md
//      tells you to configure was silently ignored in favour of a hardcoded
//      password, and "Update Password" replied success without changing it.
//   3. Its seeded menu, tables and routes were copied by hand and could fall out
//      of sync with src/server/seed.ts and src/server/app.ts.
//
// Persistence on Vercel: /tmp/restaurant-data by default (survives warm
// invocations of an instance, resets on cold start — see DEPLOY.md option A),
// or your own Postgres when DATABASE_URL is set, which is what makes the data
// stable across instances and redeploys (option B).
import type { IncomingMessage, ServerResponse } from 'http';
import { createApp } from '../src/server/app';
import { initAdminAuth } from '../src/server/auth';
import { store } from '../src/server/store';

const app = createApp();

// Cold start: load (or create) the admin credentials from ADMIN_PASSWORD and let
// the store finish its one-time initialisation before serving anything. Both are
// idempotent and the promise is memoised, so warm invocations pass straight
// through.
let bootstrapped: Promise<void> | null = null;

function bootstrap(): Promise<void> {
  if (!bootstrapped) {
    bootstrapped = (async () => {
      await initAdminAuth();
      await store.waitUntilReady();
    })().catch((error) => {
      // Never cache a failed start: let the next invocation try again.
      bootstrapped = null;
      throw error;
    });
  }
  return bootstrapped;
}

export default async function handler(req: IncomingMessage, res: ServerResponse) {
  try {
    await bootstrap();
  } catch (error) {
    res.statusCode = 503;
    res.setHeader('Content-Type', 'application/json');
    res.end(
      JSON.stringify({
        error: 'The café backend is still starting up. Please retry in a moment.',
        details: (error as Error)?.message || String(error),
      })
    );
    return;
  }

  app(req, res);
}

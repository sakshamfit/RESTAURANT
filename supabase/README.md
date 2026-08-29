# Supabase setup

The app persists to the Supabase PostgreSQL database through one of two paths
(automatic, in this order):

1. **Supabase API** — when `SUPABASE_URL` + `SUPABASE_SERVICE_ROLE_KEY`
   (or `SUPABASE_SECRET_KEY`) are set. Gives you Realtime kitchen updates and
   Storage-hosted product photos.
2. **Direct Postgres** — when `DATABASE_URL` is set (used when Supabase API
   keys are absent, or as an automatic fallback if the Supabase API is
   unreachable). Product photos are then stored inline (data URLs) and UI
   updates use the built-in polling fallbacks instead of Realtime.

Admin login is **one single login in both modes**: the app's own
single-admin flow at `/api/admin/login` using `ADMIN_EMAIL` /
`ADMIN_PASSWORD` (Supabase Auth is not involved). The returned session is an
HMAC-signed token valid for 7 days, verified locally and surviving server
restarts.

If neither is configured the app boots with memory-only preview data.

## 1. Create the project & apply the schema

1. Create a Supabase project.
2. Apply the schema with the migration CLI (reads `DIRECT_URL`, falling back
   to `DATABASE_URL`, from `.env`):

   ```bash
   node supabase/migrate.mjs
   ```

   or run [`schema.sql`](./schema.sql) manually in the Supabase SQL Editor.
   The schema is idempotent, and the app also applies it automatically on
   first start when the tables are missing.
3. Add the environment variables from the repository root `.env.example`
   (`DATABASE_URL` / `DIRECT_URL`, the admin credentials, and the Supabase
   keys if you want Realtime/Storage).
4. Start the app with `npm run dev`.

## Connection notes

- `DATABASE_URL` is what the app connects with; `DIRECT_URL` is used for
  schema migrations. For a single Supabase database both are normally the
  same direct-connection string.
- The **pooler** (`aws-0-<region>.pooler.supabase.com`) path is **IPv4-only**;
  the app forces IPv4 for all Postgres connections. TLS is negotiated when the
  server offers it (Supabase always does) and skipped for non-TLS servers.
- The Express API is the only writer in either mode. In Supabase API mode it
  uses the service-role key for server-side access and never sends it to the
  browser; RLS is enabled in the SQL file. In direct-Postgres mode the app
  connects as the database user from `DATABASE_URL`.
- There is exactly one admin account (`ADMIN_EMAIL` / `ADMIN_PASSWORD`) and
  exactly one way to log in. No Supabase Auth users are required.
- The tables intentionally use a small JSONB document layer. This keeps the
  existing menu/order contract intact, allows Supabase Realtime to notify the
  kitchen immediately (API mode), and avoids exposing private order columns to
  anonymous clients.

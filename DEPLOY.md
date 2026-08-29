# Deploy to Vercel (free) — nagori-restaurent.vercel.app

The app is fully self-contained: React frontend + Express API + local JSON data.
No Firebase, no Supabase, no paid services.

## One-time setup

1. Push this repo to GitHub (already done).
2. Go to **https://vercel.com** → sign in **with GitHub**.
3. Click **Add New → Project**, pick this repo (`sakshamfit/RESTAURANT`).
   - Framework preset: **Vite** (auto-detected).
   - Build command: `npm run build` (comes from `vercel.json`).
   - Output directory: `dist` (comes from `vercel.json`).
4. Give the project the exact name **`nagori-restaurent`**.
   → Your URL will be **https://nagori-restaurent.vercel.app**
5. Click **Deploy**. Done.

## Important: admin password on Vercel

Serverless instances only keep files in `/tmp`, and `/tmp` is wiped on redeploys
or cold starts. So on Vercel set the admin password as an environment variable:

Vercel → Project → **Settings → Environment Variables**:
- `ADMIN_PASSWORD` → your password (e.g. `9852120609@`)

Every deploy/cold start will use that as the admin password — stable and safe.
Set `ADMIN_EMAIL` too if you want a different admin email label. On Vercel,
`ADMIN_PASSWORD` is required for admin access: if it is missing, only admin
endpoints return a clear HTTP 503 explaining how to configure it; customer APIs
remain available.

The checked-in Vercel Function entry point is `api/index.ts`; it delegates to
`vercel-api/index.ts`, and `npm run build` also pre-bundles that handler to
`api/index.cjs`. Keeping `api/index.ts` in Git is important: Vercel matches the
`functions` configuration against source files in `api/`, not an artifact that
is only created by the build command. The function runs the same Express app as
the local server, so `ADMIN_PASSWORD` really is the source of truth there. Note
that a password changed from Admin → Café Settings is written to `/tmp` and
therefore reverts to `ADMIN_PASSWORD` on the next cold start — treat the env var
as the permanent password and the settings screen as a temporary override.

## Options

### A) No database (simplest)
Works out of the box. Data lives in `/tmp/restaurant-data` **on each running
instance**, so it survives warm invocations of that instance but is not shared
between instances and resets on every cold start or redeploy. Fine for a
demo/preview, not for real customers' order history — two guests can be served
by different instances and see different data. Use option B for real use.

### B) Free Postgres (recommended for real use) — keeps all data forever
1. Create a free Postgres database (e.g. **Neon** at neon.tech, or any
   Postgres host — even a plain Supabase **database**, if you only use its DB).
2. Vercel → Settings → Environment Variables:
   - `DATABASE_URL` → `postgresql://user:pass@host:5432/dbname`
   - `DIRECT_URL` → same value (used only for the first schema migration)
3. Redeploy. The app applies `db/schema.sql` automatically on first start.
   Menu, tables, orders, feedbacks etc. now persist across redeploys.

### C) Keep using Supabase Auth users?
Not needed. The app has one admin login: **Admin → password only**. If you
create users in Supabase Dashboard → Authentication → Users, that does not
touch this app at all (the Supabase SDK was removed). Use `ADMIN_PASSWORD` and
the "Update Password" screen in Admin → Café Settings instead.

## After deploying

- Open `https://nagori-restaurent.vercel.app/admin` (or the Admin button) and
  log in with the `ADMIN_PASSWORD` you set.
- Customer view: click any table / scan QR at
  `https://nagori-restaurent.vercel.app/order/nagori_tbl_tok_table1_9a2f7c`.

## Checking backend health

`https://nagori-restaurent.vercel.app/api/health` reports exactly where data is
stored and why:

- `"persistence": "postgres"` → real database in use, data is durable. ✅
- `"persistence": "file"` + `"postgresConfigured": true` → the database URL is
  set but unreachable. The `postgres.error` field shows the exact failure
  (message, code, phase) and the backend keeps retrying in the background
  (30s → 5min backoff), so it heals itself the moment the database comes back.
- `"persistence": "file"` + `"postgresConfigured": false` → no database
  configured: data is per-instance temporary storage and resets on cold starts
  (see Options A/B above).

The Admin dashboard also shows a warning banner whenever data is not going to
the real database.

## Local development

```bash
npm install
npm run dev      # http://localhost:3000
npm run build    # production build (dist + server.cjs + api/index.cjs)
```

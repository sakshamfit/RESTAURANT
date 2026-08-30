# Deploy to Vercel (free) — nagori-restaurent.vercel.app

The app is fully self-contained: React frontend + Express API + local JSON data.
No Firebase, no Supabase, no paid services.

## Live site not working? — 2-minute triage

Open **`https://nagori-restaurent.vercel.app/api/health`** and read one field:

| What you see | What it means | What to do |
| --- | --- | --- |
| `"persistence": "postgres"` + `"status": "connected"` | Backend **and** database are fine. | Hard-refresh the site (Ctrl/Cmd+Shift+R). If a page still misbehaves, note the exact URL + action and check the Vercel logs (below). |
| `"failingLoudly": true` | `DATABASE_URL` is set but the database refused/failed. The app is **refusing to read or write café data** — every data route answers `503 POSTGRES_UNAVAILABLE` with a `hint`. Nothing is being served from a local file, so no data can silently vanish. | Read `postgres.error.message` + `hint`. Most common cause by far: the **free Supabase project auto-paused** after inactivity → open **supabase.com → your project → Restore**; the app reconnects by itself within a minute. Wrong/rotated password → re-copy the connection string (table below). |
| `"postgresConfigured": false` | `DATABASE_URL` is **not set** in this deployment's environment. In production the app also fails loudly here (it will not silently use `/tmp`). | Vercel → Project → Settings → Environment Variables → add `DATABASE_URL` (and `ADMIN_PASSWORD`) → **Redeploy**. |
| `"localFileFallbackActive": true` | Development-only fallback in use: the database is down and the local file is serving data. | Never expected on Vercel — it means `ALLOW_LOCAL_FILE_FALLBACK=true` is set. Remove it so an outage fails loudly instead of showing divergent data. |

Other quick checks:

- **Vercel runtime logs** (the real crash evidence): Vercel → Project →
  **Deployments** → latest → **Functions/Runtime Logs**. Red bars show the exact
  error (e.g. `FUNCTION_INVOCATION_FAILED`, timeout, a stack trace).
- **Changed env vars?** They only apply to **new** deployments — always click
  **Redeploy** afterwards.
- **Old tab open?** A stale tab keeps calling old assets; hard-refresh first.
- The backend already survives transient failures on its own: pooled database
  connections killed by a freeze/eviction are retried on a fresh connection,
  cold-start 503s and dropped requests are retried by the client, and
  "Place Order" carries an idempotency key so a retry can never double-order.

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

### A) No database — local development only
Works out of the box **on your machine**, where one process owns one real file.
Do **not** use this on Vercel: serverless instances do not share `/tmp`, so each
one keeps its own private copy of `data/restaurant.json` and the copy is wiped on
every cold start. That is the "my menu items and orders keep disappearing and
reappearing" bug. On Vercel the app therefore **fails loudly** (HTTP 503) instead
of serving per-instance data — see option B, which is the supported deployment.

### B) Free Postgres (recommended for real use) — keeps all data forever
1. Create a free Postgres database (e.g. **Neon** at neon.tech, or any
   Postgres host — even a plain Supabase **database**, if you only use its DB).
2. Vercel → Settings → Environment Variables:
   - `DATABASE_URL` → `postgresql://user:pass@host:5432/dbname`
   - `DIRECT_URL` → same value (used only for the first schema migration)
3. Redeploy. The app applies `db/schema.sql` automatically on first start.
   Menu, tables, orders, feedbacks etc. now persist across redeploys.

With `DATABASE_URL` set, Postgres is the **only** store: every read and write of
menu items, orders, feedbacks, tables, categories and settings goes through one
shared connection pool. If the database becomes unreachable the API returns
`503 POSTGRES_UNAVAILABLE` with an actionable hint and reads/writes nothing —
it never silently falls back to a local JSON file. The instance keeps retrying
in the background and heals itself once the database answers, with no redeploy.

The starter menu (categories, 6 tables, the sample products) is seeded into a
**fresh** database exactly once. Deleting a menu item in the admin panel is
permanent — a cold start will not bring it back.

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
  (message, code, phase) plus an actionable `hint`, and the backend keeps
  retrying in the background (30s → 5min backoff), so it heals itself the
  moment the database comes back. Anything recorded locally while the
  database was down is automatically carried over into Postgres on reconnect,
  so orders and feedback never disappear at the moment the connection heals.
- `"persistence": "file"` + `"postgresConfigured": false` → no database
  configured: data is per-instance temporary storage and resets on cold starts
  (see Options A/B above).

The Admin dashboard also shows a warning banner whenever data is not going to
the real database, including the exact error and the hint from the table
below.

### Common `postgres.error` codes and how to fix them

| `code` | What it means | Fix |
| --- | --- | --- |
| `28P01` | Postgres rejected the login: the password in `DATABASE_URL` is wrong/stale, or the username was hand-edited (on Supabase it must be the full `postgres.<project-ref>`, not just `postgres`). | Supabase → Project → **Settings → Database → Connection string** → copy the current **Session pooler** URI and paste it verbatim into Vercel → **Settings → Environment Variables → `DATABASE_URL`** (and `DIRECT_URL` if set) → **redeploy**. |
| `3D000` | The database name in the URL does not exist. | Re-copy the connection string; check the project was not paused/deleted. |
| `57P03` | The database is asleep or starting up (free projects pause when idle). | Nothing — the backend retries automatically and connects when it wakes. |
| `ENOTFOUND` / `EAI_AGAIN` | Hostname in the URL cannot be resolved. | Re-copy the connection string from the provider dashboard. |
| `ECONNREFUSED` / `ETIMEDOUT` | Host/port unreachable (or IP allowlists block Vercel). | Check host/port match the dashboard; allow connections from anywhere. |
| SSL errors | The server refused the TLS handshake. | Use the provider's TLS host (Supabase pooler, port 6543). |
| parse errors | The URL is not a valid `postgresql://` string. | Copy it verbatim from the dashboard — don't hand-edit. |

Note: changing environment variables in Vercel only affects **new**
deployments, so always redeploy after updating `DATABASE_URL`.

## Local development

```bash
npm install
npm run dev      # http://localhost:3000
npm run build    # production build (dist + server.cjs + api/index.cjs)
```

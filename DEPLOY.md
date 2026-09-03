# Deploy to Vercel (free) — nexoraosp-restaurant.vercel.app

The app is fully self-contained: React frontend + Express API + local JSON data.
No Firebase, no Supabase, no paid services.

## Live site not working? — 2-minute triage

### Step 0 — the URL shows a Vercel error page instead of the app

If `https://nexoraosp-restaurant.vercel.app/api/health` does **not** return JSON
at all, the problem is the project's **domain / access settings**, not the code.
The build can be green and the deployment perfectly healthy while the public
hostname points at nothing. Fix it in the Vercel dashboard (the project
connected to this repo is currently **`restaurant`** in the **`near-connect`**
team — the Vercel bot comment on every pull request links straight to it):

| What you see | What it means | What to do |
| --- | --- | --- |
| Vercel page **`404: NOT_FOUND`**, code **`DEPLOYMENT_NOT_FOUND`** | No deployment is attached to this hostname: the project has **no production domain** (it was removed, or the project was created/renamed under a different name). | Vercel → Project → **Settings → Domains → Add** `nexoraosp-restaurant.vercel.app` (if Vercel says it is taken, pick another `<name>.vercel.app`) and leave it assigned to **Production**. Renaming the project to `nexoraosp-restaurant` under **Settings → General → Project Name** assigns that domain automatically. Takes effect within seconds — **no redeploy needed** (redeploying does not attach a domain). |
| Redirect to **vercel.com/login** ("Protected Deployment") | You opened a *deployment* URL (`restaurant-<hash>-<team>.vercel.app`, `restaurant-git-main-<team>.vercel.app`, `restaurant-<team>.vercel.app`) and **Deployment Protection** is on — those URLs are staff-only by design and are **not** the customer-facing site. | Use the production domain above. If the production domain *itself* asks for a Vercel login, go to **Settings → Deployment Protection** and set Vercel Authentication to **Standard Protection** (production public, previews private) or **Disabled**, then reload. |
| **Error** / red status on the latest deployment under **Deployments** | The code did not build. | Open the failed deployment → **Build Logs**; reproduce locally with `npm run build`. |

Once the domain answers, continue below.

### Step 1 — read `/api/health`

Open **`https://nexoraosp-restaurant.vercel.app/api/health`** and read one field:

| What you see | What it means | What to do |
| --- | --- | --- |
| `"persistence": "postgres"` + `"status": "connected"` | Backend **and** database are fine. | Hard-refresh the site (Ctrl/Cmd+Shift+R). If a page still misbehaves, note the exact URL + action and check the Vercel logs (below). |
| `"postgresConfigured": true` + `"status": "unavailable"` | `DATABASE_URL` is set but the database refused/failed. Read `postgres.error.message` + `hint`. | Most common cause by far: the **free Supabase project auto-paused** after inactivity → open **supabase.com → your project → Restore**; the app reconnects by itself within a minute. Wrong/rotated password → re-copy the connection string (table below). |
| `"persistence": "file"` + `"postgresConfigured": false` | `DATABASE_URL` is **not set** in this deployment's environment. | Vercel → Project → Settings → Environment Variables → add `DATABASE_URL` (and `ADMIN_PASSWORD`) → **Redeploy**. |

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
4. Give the project the exact name **`nexoraosp-restaurant`**.
   → Your URL will be **https://nexoraosp-restaurant.vercel.app**
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

- Open `https://nexoraosp-restaurant.vercel.app/admin` (or the Admin button) and
  log in with the `ADMIN_PASSWORD` you set.
- Customer view: click any table / scan QR at
  `https://nexoraosp-restaurant.vercel.app/order/nexoraosp_tbl_tok_table1_9a2f7c`.

## Spoken order and waiter alerts on the admin dashboard

- New orders are read from the protected all-table feed
  `/api/admin/orders?scope=all-tables`. It is a **GET-only** feed: it never
  changes, removes, or recreates orders, tables, menu items, or other saved
  data.
- The dashboard recognizes a new immutable order ID from every active table
  (Table 1, Table 2, Table 3, and tables added later), then announces: “New
  order from Table … Please check the order panel.” New waiter calls are
  announced the same way and shown in a persistent banner until attended.
- Speech uses the browser's own text-to-speech engine (nothing is recorded or
  sent anywhere). The preference is a speaker toggle in the dashboard header
  and in the Live Orders toolbar, remembered per device.
- Each spoken announcement has a hard **15-second maximum** and is queued, so
  simultaneous table orders are announced one at a time. There are no synthetic
  alarm tones or looping sirens in the app.

## Checking backend health

`https://nexoraosp-restaurant.vercel.app/api/health` reports exactly where data is
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

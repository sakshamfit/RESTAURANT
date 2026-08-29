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
Set `ADMIN_EMAIL` too if you want a different admin email label.

## Options

### A) No database (simplest)
Works out of the box. Data lives in `/tmp/restaurant-data` on the running
instance and **resets when Vercel redeploys**. Fine for demo/preview, not for
real customers' order history.

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

## Local development

```bash
npm install
npm run dev      # http://localhost:3000
npm run build    # production build (dist + server.cjs)
```

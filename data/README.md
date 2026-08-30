# Data directory

Runtime data (`restaurant.json` — menu, tables, orders, feedbacks) and the
single admin account (`admin.json` — scrypt-hashed password) are stored here
automatically. Both files are created on first start and are **not** committed
to Git (see `.gitignore`).

- `restaurant.json` — app data (local persistence; no cloud services used).
- `admin.json` — the single admin password (hashed). Delete it to reset the
  password to the `ADMIN_PASSWORD` value from `.env`.

If `DATABASE_URL` is set, app data moves to your own PostgreSQL database
instead (see `db/README.md`) and **this directory is never read or written** —
Postgres becomes the single source of truth. Admin credentials
(`admin.json`) always stay local.

**On Vercel / in production** the local JSON file is not used as a fallback for
app data at all: serverless instances do not share `/tmp`, so an unreachable
database makes the API return `503 POSTGRES_UNAVAILABLE` instead of serving
per-instance data that appears and disappears. See `DEPLOY.md` option B.
**Tip for Vercel:** set `ADMIN_PASSWORD` *and* `DATABASE_URL` in Vercel →
Settings → Environment Variables.

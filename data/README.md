# Data directory

Runtime data (`restaurant.json` — menu, tables, orders, feedbacks) and the
single admin account (`admin.json` — scrypt-hashed password) are stored here
automatically. Both files are created on first start and are **not** committed
to Git (see `.gitignore`).

- `restaurant.json` — app data (local persistence; no cloud services used).
- `admin.json` — the single admin password (hashed). Delete it to reset the
  password to the `ADMIN_PASSWORD` value from `.env`.
- `license.json` — only present in distributed (`LICENSE_REQUIRED=true`)
  builds; contains the signed JWT that authorises the admin console. Created
  by the Setup Wizard on first activation. The data lives next to the app
  data so a OneDrive / Google Drive backup of this folder also backs up the
  license — restore by reinstalling the app, pointing `DATA_DIR` here, and
  re-running activation with the same key + email.
- `.license-signing-secret` — only present in self-hosted builds that have
  `LICENSE_ALLOW_SELF_ISSUE=true`; the HS256 secret used to mint local keys
  for testing. Never used in distributed builds.

If `DATABASE_URL` is set in `.env`, app data moves to your own PostgreSQL
database instead (see `db/README.md`); admin credentials always stay local.
On Vercel a writable override (`DATA_DIR=/tmp/restaurant-data`, automatic) is
used. **Tip for Vercel:** set `ADMIN_PASSWORD` (and optionally `DATABASE_URL`)
in Vercel → Settings → Environment Variables — see `DEPLOY.md`.

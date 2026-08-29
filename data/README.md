# Data directory

Runtime data (`restaurant.json` — menu, tables, orders, feedbacks) and the
single admin account (`admin.json` — scrypt-hashed password) are stored here
automatically. Both files are created on first start and are **not** committed
to Git (see `.gitignore`).

- `restaurant.json` — app data (local persistence; no cloud services used).
- `admin.json` — the single admin password (hashed). Delete it to reset the
  password to the `ADMIN_PASSWORD` value from `.env`.

If `DATABASE_URL` is set in `.env`, app data moves to your own PostgreSQL
database instead (see `db/README.md`); admin credentials always stay local.

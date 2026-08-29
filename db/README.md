# Optional: plain PostgreSQL

The app is fully self-contained and works with **no database at all** — it
persists to a local file at `data/restaurant.json` (created automatically).

If you have your own PostgreSQL server, set `DATABASE_URL` in `.env` and the app
will use it instead. On first start it applies [`schema.sql`](./schema.sql)
automatically. `DIRECT_URL` (optional) is used for that migration connection.

```bash
# .env
DATABASE_URL="postgresql://user:password@host:5432/restaurant"
```

If Postgres is unreachable the app falls back to the local JSON file, so the
admin login and app always keep working.

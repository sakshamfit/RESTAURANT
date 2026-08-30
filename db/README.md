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

## If Postgres is unreachable

**In production (`VERCEL`, or `NODE_ENV=production`) there is no fallback.**
Every read and write of menu items, orders, feedbacks, tables, categories and
settings fails with `503 POSTGRES_UNAVAILABLE` plus an actionable hint. The app
deliberately does *not* fall back to the local JSON file: on a serverless
platform each instance has its own private `/tmp`, so a "fallback" would serve
every visitor a different copy of the data and lose it on the next cold start.
The instance keeps retrying in the background and reconnects by itself.

**In local development** (`ALLOW_LOCAL_FILE_FALLBACK` defaults to `true`) an
unreachable database falls back to `data/restaurant.json`, and that fallback is
logged at `error` level with the reason and the fix — it is never silent. Set
`ALLOW_LOCAL_FILE_FALLBACK=false` to make your dev machine behave like
production.

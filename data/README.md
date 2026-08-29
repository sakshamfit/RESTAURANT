# Data directory

The restaurant no longer stores runtime data in this directory. Persistence
lives in PostgreSQL — either through the Supabase API (Realtime, Storage,
Auth) or directly via `DATABASE_URL`. See [`supabase/README.md`](../supabase/README.md)
and `supabase/schema.sql`.

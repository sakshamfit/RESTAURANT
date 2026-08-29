# Supabase setup

1. Create a Supabase project.
2. Run [`schema.sql`](./schema.sql) in the Supabase SQL Editor.
3. In **Authentication → Users**, create the admin user with the email and password from `ADMIN_EMAIL` and `ADMIN_PASSWORD`.
4. Add the environment variables from the repository root `.env.example`.
5. Start the app with `npm run dev`.

The Express API uses `SUPABASE_SERVICE_ROLE_KEY` for server-side PostgreSQL and Storage access. It is never sent to the browser. Customer requests remain public through the API, while admin sessions are Supabase Auth access tokens. Product photos sent from the admin UI are uploaded to the `product-images` Storage bucket and only their public URL is stored in the product record.

The tables intentionally use a small JSONB document layer. This keeps the existing menu/order contract intact, allows Supabase Realtime to notify the kitchen immediately, and avoids exposing private order columns to anonymous clients. RLS is enabled in the SQL file; do not replace the service-role key with the anon key on the server.

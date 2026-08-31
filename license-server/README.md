# NEXORAOSP RESTAURANT — Central License Server

A small, self-contained Vercel-deployable service that mints signed
license JWTs for the NEXORAOSP RESTAURANT desktop app, tracks which
keys are paid for, and exposes an admin page to issue and revoke
keys.

The contract between this server and the desktop app is documented
in [`../LICENSE_SERVER.md`](../LICENSE_SERVER.md). Read that first if
you want to know *why* the API is shaped the way it is.

## One-time deploy

### 1. Create a Postgres database

Free options:

- **[Vercel Postgres](https://vercel.com/docs/storage/vercel-postgres)**
  — one click, lives next to your deploy, connection string is
  exposed as `POSTGRES_URL` automatically.
- **[Supabase](https://supabase.com)** — free Postgres, gives you a
  `DATABASE_URL`.
- **Neon** — same idea, free tier is generous.

Copy the connection string. You'll paste it into Vercel in step 3.

### 2. Push the code to a Git repo

```bash
cd license-server
git init
git add .
git commit -m "Initial license server"
gh repo create nexoraosp-license --public --source=. --push
```

### 3. Deploy to Vercel

```bash
# First time: link the project
npx vercel link

# Set the three required env vars.
#   LICENSE_SIGNING_SECRET — the same HS256 secret you baked into
#     the desktop build. Use 64+ random bytes. NEVER rotate without
#     re-releasing the desktop app or every install locks itself out.
#   LICENSE_ADMIN_PASSWORD — the password the admin page asks for.
#   POSTGRES_URL (or DATABASE_URL) — your Postgres connection string.
npx vercel env add LICENSE_SIGNING_SECRET production
npx vercel env add LICENSE_ADMIN_PASSWORD production
npx vercel env add POSTGRES_URL production

# First deploy.
npx vercel --prod
```

### 4. Run the migration once

From your laptop (with the same `POSTGRES_URL` you set on Vercel):

```bash
POSTGRES_URL='postgres://user:pass@host:5432/db' node scripts/migrate.js
```

You should see `Tables ready.`. (The `api/license/activate.ts` and
`api/admin/*.ts` handlers also call `ensureSchema()` on every cold
start, so this script is a belt-and-braces first-run helper, not a
hard requirement.)

### 5. Open the admin page

```
https://<your-project>.vercel.app/
```

Sign in with the value of `LICENSE_ADMIN_PASSWORD`. The page shows a
form to issue keys (`NEX-XXXX-XXXX-XXXX`) and a table of existing
keys with a Revoke button per row.

## Wiring the desktop app to this server

When you build the desktop installer (or the web app), set
`LICENSE_API_BASE` to the deployed URL of this server:

```bash
# desktop/package.json's build block, or as an env var when running
# `npm run dist`:
LICENSE_API_BASE=https://nexoraosp-license.vercel.app \
LICENSE_SIGNING_SECRET=<the same secret> \
LICENSE_REQUIRED=true \
npm run dist
```

Customers in the Setup Wizard will type the email + key you sent
them. Their first activation hits `POST /api/license/activate` here
and gets back the signed JWT. The desktop app stores it locally and
trusts it for the next 30 days; every ~6h it does a heartbeat
(`POST /api/license/heartbeat`) so a Revoke from this admin page
propagates within 6h at the latest.

## API summary

| Method | Path | Auth | Body | Notes |
| --- | --- | --- | --- | --- |
| `POST` | `/api/license/activate` | none | `{ licenseKey, email, cafeName, fingerprint }` | First activation. Returns `{ ok, token, payload }`. |
| `POST` | `/api/license/heartbeat` | none | `{ keyId, fingerprint }` | Refresh token. Returns `{ ok, status, newToken? }`. |
| `POST` | `/api/license/rebind` | none | `{ licenseKey, email, newFingerprint }` | Move to a new machine. Rate-limited to 1 / 5 min / key. |
| `POST` | `/api/admin/login` | password in body | `{ password }` | Sets the session cookie. |
| `POST` | `/api/admin/logout` | session cookie | — | Clears the session cookie. |
| `GET`  | `/api/admin/keys` | session cookie | — | Lists all keys. |
| `POST` | `/api/admin/keys` | session cookie | `{ email, plan }` | Mints a new key. `plan ∈ { monthly, yearly, lifetime, trial }`. |
| `POST` | `/api/admin/revoke` | session cookie | `{ keyId }` | Marks a key revoked. The customer's next heartbeat will get `status: "revoked"`. |

## Local dev

```bash
npm install
# In one terminal:
POSTGRES_URL=postgres://postgres:postgres@localhost:5432/nexoraosp_licenses \
LICENSE_SIGNING_SECRET=devsecret \
LICENSE_ADMIN_PASSWORD=admin \
npx vercel dev
# In another:
open http://localhost:3000/
```

The schema is created on first request, so a brand-new Postgres
needs no migration step in dev.

## Security notes

- The `LICENSE_SIGNING_SECRET` is the only thing standing between an
  attacker and a forged license. 64+ random bytes (e.g. from
  `openssl rand -hex 32`) is the right size. Treat it like a
  database password.
- `LICENSE_ADMIN_PASSWORD` only gates the admin page. Choose a
  strong one. Brute force is rate-limited at 5 attempts per minute
  per IP, so offline cracking is the only viable attack.
- Cookies are `HttpOnly` + `Secure` + `SameSite=Lax`. Sessions last
  24h.
- All admin endpoints check the session cookie on every request;
  there is no token cache.
- The license server is the **only** place where `status: 'revoked'`
  can be set. The desktop app cannot self-revoke — it can only
  report what the server told it.

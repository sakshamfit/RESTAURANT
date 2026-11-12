# Central License Server

The desktop and web apps are distributed as a single binary. The license
gate (`LICENSE_REQUIRED=true`) is enforced by the embedded server itself,
not by a third-party DRM tool — but every install still needs a real
license key to be valid, and the key has to come from a system that knows
which keys are paid for and which machines they're bound to. That system
is the **central license server**, which you (the vendor) host and run.

This document specifies the contract between the app and your license
server. The app code in `src/server/license.ts` is the source of truth
for the request/response shapes; this file explains *why* the contract
looks the way it does so a server implementation in any language is
straightforward.

## What the app sends

### `POST /api/license/activate`

First-time activation. The app collects a license key, an email, a café
name, and a machine fingerprint from the user, then calls this endpoint.

Request:
```json
{
  "licenseKey": "NEX-XXXX-XXXX-XXXX",
  "email": "owner@yourcafe.com",
  "cafeName": "The Green Café",
  "fingerprint": "desktop-3a8f9b2c1d4e5f6a7b8c9d0e1f2a3b4c"
}
```

The server checks:
1. `licenseKey` exists, is not revoked, and is paid for.
2. Either the key has no machine bound yet, or its bound fingerprint
   matches `fingerprint` (re-activation on the same machine).
3. If the key is bound to a *different* fingerprint, reject with
   `errorCode: "KEY_BOUND_TO_OTHER_MACHINE"`. The user must use the
   Rebind flow (see below) to move the license.

On success, the server:
1. Records `fingerprint` as the bound machine for this key.
2. Mints a signed JWT containing the payload below. **Sign it with the
   RSA private key in `LICENSE_PRIVATE_KEY` — the matching public key is
   baked into the desktop build (`license-keys/public.pem`), so the
   installer contains no secret at all.** (Legacy HS256 via
   `LICENSE_SIGNING_SECRET` still works for existing deployments.)
3. Returns `{ ok: true, token, payload }`.

The JWT payload (matches `LicensePayload` in `src/server/license.ts`):
```json
{
  "keyId": "NEX-XXXX-XXXX-XXXX",
  "cafeName": "The Green Café",
  "email": "owner@yourcafe.com",
  "plan": "monthly",            // or "yearly" | "lifetime" | "trial"
  "iat": 1730000000000,         // ms since epoch
  "exp": 1732592000000,         // ms since epoch, or null for lifetime
  "fingerprint": "desktop-...",
  "activated": true
}
```

The desktop app stores this token in `data/license.json` and trusts it
offline. The `exp` claim is the source of truth for "is this subscription
still valid" — the server doesn't need to be reachable for the app to
keep working in the same month.

### `POST /api/license/heartbeat`

Called every ~6 hours when the app has internet. The app sends the keyId
+ fingerprint, the server replies with the current state.

Request:
```json
{
  "keyId": "NEX-XXXX-XXXX-XXXX",
  "fingerprint": "desktop-..."
}
```

Response (active):
```json
{
  "ok": true,
  "status": "active",
  "newToken": "eyJ..."    // optional: only if you extended the plan
}
```

Response (revoked — refund, chargeback, etc.):
```json
{ "ok": true, "status": "revoked" }
```

The app will write a token with `exp` in the past, which immediately
moves the local license to the "expired" state.

If the response is `{ ok: false }` or the request fails, the app
**trusts the local JWT** — heartbeat failures are never fatal. The user
keeps working; a yellow banner appears the moment the JWT itself expires.

### `POST /api/license/rebind`

Called from Café Settings → Subscription → "Transfer to a new computer".
Releases the old fingerprint and binds the key to the new one.

Request:
```json
{
  "licenseKey": "NEX-XXXX-XXXX-XXXX",
  "email": "owner@yourcafe.com",
  "newFingerprint": "desktop-..."
}
```

The server should:
1. Look up the key.
2. Verify the email matches what was on file (case-insensitive).
3. Update the bound fingerprint.
4. Mint and return a fresh signed JWT with the new `fingerprint`.
5. Optionally rate-limit this endpoint (e.g. 5 per key per day) to
   prevent abuse — a customer who's moving a license between two
   machines shouldn't be doing it hundreds of times.

## Reference implementation

A complete reference implementation lives in [`license-server/`](license-server/) —
a Vercel-deployable Node.js + Postgres app that exposes all three
endpoints plus a single-page admin UI for issuing and revoking keys.

First generate an RSA keypair (once, keep it safe):

```bash
mkdir -p license-keys
openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:2048 -out license-keys/private-key.pem
openssl pkey -in license-keys/private-key.pem -pubout -out license-keys/public.pem
```

- `license-keys/public.pem` goes into the app repo (it is committed there
  as `license-keys/public.pem`) and is baked into every installer.
- `license-keys/private-key.pem` NEVER enters a repo — paste it into the
  license server's `LICENSE_PRIVATE_KEY` env var (Vercel secrets panel
  accepts multi-line values).
- Rotating keys = deploy the new private key on the server AND commit the
  new public key + rebuild every installer.

Then deploy:

```bash
cd license-server
npm install
npx vercel link
npx vercel env add LICENSE_PRIVATE_KEY production
npx vercel env add LICENSE_ADMIN_PASSWORD production
npx vercel env add POSTGRES_URL production
POSTGRES_URL=... node scripts/migrate.js
npx vercel --prod
```

See [`license-server/README.md`](license-server/README.md) for the
full deploy guide and the API summary table.

---

The two tables you need (also defined in `license-server/lib/store.ts`):

```sql
CREATE TABLE license_keys (
  key_id        text PRIMARY KEY,        -- "NEX-XXXX-XXXX-XXXX"
  email         text NOT NULL,
  plan          text NOT NULL,          -- "monthly" | "yearly" | "lifetime"
  status        text NOT NULL,          -- "active" | "revoked"
  fingerprint   text,                   -- bound machine, null until first activation
  activated_at  timestamptz,
  expires_at    timestamptz,            -- null for lifetime
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE license_events (
  id            bigserial PRIMARY KEY,
  key_id        text REFERENCES license_keys(key_id),
  event         text NOT NULL,          -- "activate" | "heartbeat" | "rebind" | "revoke"
  fingerprint   text,
  ip            text,
  user_agent    text,
  at            timestamptz NOT NULL DEFAULT now()
);
```

Use the same Postgres you might already be using for the app — or a
free Supabase / Neon project. The license server is small enough to
deploy on Vercel's free tier as a single serverless function; just
point `LICENSE_API_BASE` at the deployed URL when you build the
desktop installer.

## Wiring the release build to your server

`LICENSE_API_BASE` and the RSA **public key** are baked into the
installer by `scripts/build-desktop.mjs` (see `build-env.json` in
`desktop/README.md`) — the packaged app cannot read a builder's
environment. The public key is read from `license-keys/public.pem` in
the repo, so the CI workflow (`.github/workflows/desktop-release.yml`)
needs no secrets at all; only the optional Variable `LICENSE_API_BASE`
(defaults to `https://license.nexoraosp.com`). The private key stays on
the license server. If the public key baked into the installer does not
match the private key on the server, activation fails with
`invalid signature` — that is the correct failure mode.

## Why a JWT, not a server-roundtrip-per-request

A naïve license check would call the server on every admin page load.
That breaks when the café's internet is down (which, for many Indian
small businesses, is *frequently*). The signed JWT model means:

- **Online:** heartbeat catches revocations and plan upgrades within
  ~6 hours.
- **Offline:** the app works for the full month using just the JWT.
- **No double-billing risk:** revocation propagates the next time the
  device goes online; in the worst case a refunded customer gets up to
  ~6 hours of unpaid use, which is the same as every other on-premise
  POS.

This is the same model Slack, 1Password, Notion, Adobe Creative Cloud,
and every other on-premise-or-hybrid software uses. It's not new, but
it works.

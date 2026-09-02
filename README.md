# NEXORAOSP RESTAURANT

QR-based café food ordering with a complete staff console: live order tracking,
permanent table QR codes, waiter-call alerts, customer reviews, sales reports
and café settings. The same codebase runs as a hosted web app (Vercel) and as
an installable **desktop console** (Windows / Linux / macOS).

No external services are required: with no configuration, everything is stored
on the machine that runs the server (a single JSON file). Point
`DATABASE_URL` at any PostgreSQL database to make storage permanent across
hosts.

## Quick start

```bash
npm install
npm run dev          # http://localhost:3000  (dev server with hot reload)
```

- Customer view (table QR target): `http://localhost:3000/order/<table-token>`
- Staff console: `http://localhost:3000/admin` — login with the owner
  password set in `.env` (`ADMIN_PASSWORD`, see `.env.example`). Change it
  from **Café Settings → Update Password** after first login.

Production:

```bash
npm run build        # web build → dist/ + bundled server → dist/server.cjs
npm start            # serves dist/ and the API
```

## What's inside

| Area | Where | Notes |
| --- | --- | --- |
| Customer menu / cart / tracking | `src/App.tsx`, `src/components/Customer*`, `CartDrawer` | One page per table QR; orders carry an idempotency key so flaky mobile submits never double-order. |
| Staff console | `src/components/Admin*` | Live orders (5s poll), waiter calls, feedbacks, menu/tables/QR management, reports, settings. |
| API | `src/server/app.ts` | Express, single-admin HMAC sessions, throttle + idempotency for order placement, `/api/health` reports exactly where data lives. |
| Storage | `src/server/store.ts` | Local JSON file by default (`data/restaurant.json`); optional Postgres via `DATABASE_URL` with automatic `db/schema.sql` migration. |
| Alerts | `src/utils/spokenAlerts.ts`, `src/utils/browserNotifications.ts` | New orders / waiter calls raise a persistent dashboard banner plus one queued spoken announcement (browser speech). No alarm tones, no looping sirens. |
| Desktop console | `desktop/` | Electron shell around the bundled server; see below. |

## Desktop console (installable app)

The desktop app runs the exact same server as a local, loopback-only service
and opens the staff console in a native window. Orders, menu and settings are
stored in the OS user-data folder of that machine — nothing leaves it unless
you configure a database.

```bash
npm run desktop:stage    # build web app + bundle server into desktop/app
npm --prefix desktop start   # run the desktop app from source (needs display)
npm run desktop:build    # package installers into release/ (needs internet)
```

`desktop:build` produces, per platform you run it on:

- Windows: `nexoraosp-restaurant-<ver>-win-x64.exe` (NSIS installer) + portable zip
- Linux: `nexoraosp-restaurant-<ver>-linux-x86_64.AppImage` + `.deb`
- macOS: `nexoraosp-restaurant-<ver>-mac-x64.dmg`

Packaging downloads the Electron toolchain, so it needs normal internet
access. The repo ships a GitHub Actions workflow (`.github/workflows/
desktop-release.yml`) that builds all three installers on GitHub runners and
attaches them as artifacts — push a `v*` tag or use the Actions tab. See
`desktop/README.md` for details.

### No-Electron Linux package (optional)

If you only need a lightweight Linux desktop launcher (no Electron, no
downloads), run:

```bash
npm run desktop:linux   # → release/nexoraosp-restaurant-<ver>-linux-x64.tar.gz + .deb
```

The `.deb` (Debian/Ubuntu, `amd64`) installs a `NEXORAOSP RESTAURANT` app-menu
entry that starts the local order server and opens the staff console in your
browser. It requires Node.js 18+ on the machine; data is stored in
`~/.nexoraosp-restaurant/data`.

## Deploying the web app

See `DEPLOY.md` for the Vercel setup (Postgres optional but recommended for
durable order history) and the exact behaviour of `/api/health`.

## Scripts

| Script | Purpose |
| --- | --- |
| `npm run dev` | Express + Vite dev server on :3000 |
| `npm run build` | Production web build + bundled Node server |
| `npm start` | Run the production server |
| `npm run lint` | `tsc --noEmit` type check |
| `npm run desktop:stage` | Stage `desktop/app/` without packaging |
| `npm run desktop:build` | Package Electron desktop installers into `release/` |
| `npm run desktop:linux` | Build the lightweight no-Electron Linux package (.deb + tar.gz) |

## Distributing the desktop app to paying customers

The desktop installer is shipped the same way Marg / Petpooja / any
on-premise POS is: customers download a binary, enter the credentials
**you emailed them** (license key + email), and the app activates on
that machine. There is no signup anywhere in the customer flow, and
the trial choice is compiled out of customer builds — the wizard goes
straight to the credential form.

### Customer build flow

1. Install the EXE (Windows / macOS / Linux).
2. First launch → **Activate your license**: café name + the email and
   key you sent. Activation is verified by your central license server
   (online, once — the same machine can re-activate offline afterwards).
3. **Create the staff-console password** (one-time, local, not an
   account). The console is now open.
4. **All café data stays on the customer's own computer** in the user
   data folder (`…/NEXORAOSP RESTAURANT/data/`). Nothing leaves the
   machine, no database or cloud service is required. Optionally a
   `DATABASE_URL` can be baked in for multi-machine setups.

### Build a customer-ready installer

Distribution settings are **baked into the installer** by the build
script (the packaged app cannot read the builder's environment), so
set them before running it:

```bash
export LICENSE_REQUIRED=true
export LICENSE_API_BASE=https://license.yourcompany.com
export LICENSE_ALLOW_SELF_ISSUE=false
export LICENSE_TRIAL_DAYS=0          # no trial — login only

npm run desktop:build                 # current platform
# or, for every platform (macOS DMG requires macOS):
npm run desktop:build -- --win --linux
```

`scripts/build-desktop.mjs` writes these into `desktop/app/build-env.json`
inside the staged app; `desktop/main.cjs` merges them into the bundled
server's environment on every launch. It also bakes the RSA **public**
key from `license-keys/public.pem`, so nothing secret is ever embedded
in a customer installer — the private key lives only on your license
server (`LICENSE_PRIVATE_KEY`, see `license-server/README.md`). Keep
that private key out of Git and off build machines.

The output in `release/` is a per-platform installer that, on first
launch, shows the activation wizard (café name + email + license key).
The customer cannot use the admin console until the key is activated.
On a fresh machine the wizard also asks for a one-time staff-console
password before the console opens.

### Automated GitHub releases

`.github/workflows/desktop-release.yml` builds Windows + Linux +
macOS installers with the license gate baked in and attaches them to
a GitHub Release. It needs **no repository secrets** — the public key
ships in the repo:

1. (Optional) Set the repository **Variable** `LICENSE_API_BASE` to
   your license server URL (defaults to
   `https://license.nexoraosp.com`); optional `ADMIN_EMAIL`.
2. Deploy the license server with the matching private key
   (`LICENSE_PRIVATE_KEY` in Vercel).
3. Push a `v1.0.1`-style tag (or run the workflow manually from the
   Actions tab).

### License server endpoints (you host this)

Your license server needs three POST endpoints (request/response
shapes in `src/server/license.ts`):

- `POST /api/license/activate` — verifies the key, marks it bound
  to the machine fingerprint, returns a signed JWT.
- `POST /api/license/heartbeat` — checks key is still active,
  optionally returns a new token if the plan was extended.
- `POST /api/license/rebind` — releases the old machine and binds
  the key to a new fingerprint (requires the original email).

A minimal implementation is a tiny Node/Express service backed by a
Postgres table of `{ key_id, email, plan, status, fingerprint,
activated_at, expires_at }`. It signs JWTs with the RSA private key
(`LICENSE_PRIVATE_KEY`); the matching public key is baked into the
desktop build from `license-keys/public.pem`.

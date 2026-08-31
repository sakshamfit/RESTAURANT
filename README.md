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
on-premise POS is: customers download a binary, enter a license key
emailed to them, and the app activates on that machine.

### Build a customer-ready installer

```bash
# 1. Set the license env vars (one-time per build)
export LICENSE_REQUIRED=true
export LICENSE_API_BASE=https://license.yourcompany.com
export LICENSE_SIGNING_SECRET="$(openssl rand -hex 32)"
export LICENSE_ALLOW_SELF_ISSUE=false

# 2. Build the installers
npm run build
npm run desktop:build
```

The output in `release/` is a per-platform installer that, on first
launch, shows a one-screen activation wizard (café name + email +
license key). The customer cannot use the admin console until the
key is activated.

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
activated_at, expires_at }`. The signing secret MUST match the one
baked into the desktop build above.

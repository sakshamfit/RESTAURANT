# NEXORAOSP RESTAURANT — Desktop Console

An installable staff terminal for the restaurant: the production web build and
the Express API are bundled into a single Electron app. At startup the app
spawns the bundled server on a free loopback port (`127.0.0.1` only), stores
all data in the OS user-data folder, and opens the admin console.

There is deliberately **no** cloud dependency: menu, orders, waiter calls and
settings live in `<user data>/NEXORAOSP RESTAURANT/data/` as JSON (or in your own
PostgreSQL if you set `DATABASE_URL` before launching).

## Layout

```
desktop/
  main.cjs        Electron main process: local server lifecycle + window
  preload.cjs     sandboxed contextBridge (desktop info, open data folder)
  package.json    electron-builder config (win nsis/zip, linux AppImage/deb, mac dmg)
  build/icon.png  app icon source
  app/            STAGED by scripts/build-desktop.mjs (git-ignored):
    dist/         Vite production build of the web app
    server.cjs    single-file Express server (esbuild bundle)
    db/schema.sql Postgres migration used only if DATABASE_URL is set
```

## Run from source

```bash
# from the repo root
npm install
npm run desktop:stage            # builds web app + bundles server into desktop/app
cd desktop && npm install        # installs Electron + electron-builder
npm start                        # launches the desktop app (needs a display)
```

The window opens at `/admin` (staff login). Customers keep using the hosted
web app / table QR codes; the desktop console observes the same API.

## Package installers

```bash
# from the repo root (needs internet to download the Electron toolchain)
npm run desktop:build            # current platform → release/
npm run desktop:build -- --win   # Windows NSIS installer + portable zip
npm run desktop:build -- --linux # Linux AppImage + deb
npm run desktop:build -- --mac   # macOS dmg (build on macOS)
```

Installers land in `release/` at the repo root, named
`nexoraosp-restaurant-<version>-<os>-<arch>.<ext>`.

### Baking distribution settings (license gate, admin identity)

The packaged app cannot read the environment of the machine that built
the installer, so `scripts/build-desktop.mjs` writes the settings you
export into `desktop/app/build-env.json`, and `desktop/main.cjs` merges
that file into the bundled server's environment on every launch. Baked
keys: `LICENSE_REQUIRED`, `LICENSE_API_BASE`, `LICENSE_PUBLIC_KEY`,
(optional legacy `LICENSE_SIGNING_SECRET`), `LICENSE_ALLOW_SELF_ISSUE`,
`LICENSE_TRIAL_DAYS`, `ADMIN_PASSWORD`, `ADMIN_EMAIL`,
`ADMIN_SESSION_SECRET`, `DATABASE_URL`, `DIRECT_URL`.

In license-gated builds the RSA **public** key comes from
`license-keys/public.pem` in the repo (or an explicit
`LICENSE_PUBLIC_KEY`); the private key never leaves the license server.

Customer builds use `LICENSE_REQUIRED=true`, `LICENSE_TRIAL_DAYS=0`,
`LICENSE_ALLOW_SELF_ISSUE=false` and no `ADMIN_PASSWORD` — the owner
picks their own staff password right after license activation.

## Automated builds

`.github/workflows/desktop-release.yml` packages all three platforms on
GitHub runners (where the Electron binaries are always reachable) and
publishes them to a GitHub Release. It runs on `v*` tags and can also be
launched manually from the Actions tab once merged into `main`. It reads
`LICENSE_API_BASE` from the optional repository **variable**
`LICENSE_API_BASE` (default `https://license.nexoraosp.com`) and needs
no secrets — the public key ships in the repo.

## Notes for operators

- **Data folder**: *Console → Open Data Folder* (or the button in
  Café Settings → Desktop Console) opens it. Back it up like any POS database.
- **One instance**: a second launch focuses the running window instead of
  starting a second server.
- **Local-only**: the server binds to `127.0.0.1`, so the desktop console is
  not reachable from other devices on the LAN.
- **Renderer security**: no Node integration, sandboxed renderer; the only
  bridge is `window.nagoriDesktop` from `preload.cjs`.

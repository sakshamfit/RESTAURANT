# QR Fix — Safari "could not connect to server" (127.0.0.1)

## Root Cause
Old builds generated QR codes with `http://127.0.0.1:PORT/order/...` because:
1. `window.location.origin` was used directly — if admin opened `http://127.0.0.1:53338/admin`, the QR encoded that loopback address.
2. Desktop `main.cjs` set `APP_URL=http://127.0.0.1:PORT`, so server's health endpoint thought the public URL was loopback.
3. `127.0.0.1` is **this computer only** — a phone scanning it has no route to it, so Safari says "could not connect to server".

## What Was Fixed (new build)

### 1. Server auto-detects LAN IP
- New module `src/server/network.ts`:
  - Scans `os.networkInterfaces()` for non-internal IPv4.
  - Prioritizes `192.168.x` > `10.x` > `172.16-31.x` > others > link-local `169.254`.
  - Physical adapters (`en0`, `eth0`, `wlan0`) first, virtual (docker, vmware) last.
  - `buildLanUrls(port)` returns `http://<lan-ip>:port` list.
  - `getBestBaseUrl()` picks best URL: `APP_URL` > `DESKTOP_LAN_URLS` > LAN > request origin (if not loopback).

- `/api/health` now returns:
  ```json
  {
    "localUrl": "http://127.0.0.1:3000",
    "lanUrls": [{"url":"http://192.168.1.42:3000","address":"192.168.1.42","interface":"wlan0"}],
    "qrBaseUrl": "http://192.168.1.42:3000",
    "qrBaseSource": "lan"
  }
  ```

- New endpoints:
  - `GET /api/network` — detailed network info + `bestBaseUrl`
  - `GET /api/server-info` — alias redirect

- Server binds to `0.0.0.0` (not 127.0.0.1) in both dev and prod:
  - `server.ts` HOST defaults to `0.0.0.0`
  - `vite.config.ts` host `0.0.0.0`, `allowedHosts: true`
  - Logs LAN IPs on startup.

### 2. Desktop app fix
- `desktop/main.cjs`:
  - **Removed** `APP_URL=http://127.0.0.1:port` env (was causing QR to be loopback).
  - Improved `getLanAddresses()` with range priority and link-local handling.
  - Still passes `DESKTOP_LAN_URLS` (LAN list) to server, which now correctly uses it.

### 3. Frontend QR logic (no more 127.0.0.1)
- New utility `src/utils/qrBaseUrl.ts`:
  - `fetchNetworkInfo()` fetches `/api/network` (cached 30s)
  - `pickBestQrBaseUrl()` priority:
    1. `settings.qrBaseUrl` / `publicBaseUrl` (admin override)
    2. `desktopInfo.lanUrls[0]` (Electron)
    3. `networkInfo.bestBaseUrl` (server's LAN detection)
    4. `networkInfo.lanUrls[0]`
    5. `window.location.origin` if NOT loopback
    6. Fallback loopback with warning

- `QRPrintModal.tsx` completely rewritten:
  - Fetches both desktop info AND network info in parallel.
  - Shows which URL QR points at, source, and warns if loopback.
  - Shows all LAN URLs.
  - Copy button, download, print.
  - If loopback detected, shows fix instructions.

- `AdminTables.tsx`:
  - Same logic for "Open Menu" links — now uses LAN URL, not `/order/...` relative.
  - Header shows current QR base URL with green (good) / red (loopback) badge.

- `AdminSettings.tsx`:
  - New field **QR Base URL** — custom override for all QR codes.
  - Example: `http://192.168.1.42:3000` or `https://mycafe.ngrok.io`
  - Stored in `settings.qrBaseUrl`, read by `/api/health` and `/api/network`.

### 4. Env template
- `.env.example`:
  - `APP_URL` now empty by default (auto-detect).
  - Documented how to set LAN IP or public domain.
  - Added `HOST=0.0.0.0` and `PORT=3000`.

## How to Use New Build

### Option A: Web build (npm run dev / npm run start)
1. Pull latest:
   ```bash
   git pull origin arena/01a0adc8-restaurant
   npm install
   npm run build
   ```
2. Run with LAN binding:
   ```bash
   HOST=0.0.0.0 PORT=3000 npm start
   # or
   HOST=0.0.0.0 PORT=3000 npm run dev
   ```
3. Check logs — should show:
   ```
   LAN addresses for QR codes:
     - wlan0: 192.168.1.42 => http://192.168.1.42:3000
   ```
4. Open admin via **LAN IP**, not 127.0.0.1:
   - Bad: `http://127.0.0.1:3000/admin` → QR would be loopback (now fixed to LAN anyway)
   - Good: `http://192.168.1.42:3000/admin`
5. Go to **Admin → Tables & QRs** — header should show green badge with your LAN URL, not red loopback.
6. Click **View / Print QR** — modal should show QR points at `http://192.168.1.42:3000/order/...` (your LAN), not 127.0.0.1.
7. Scan with phone on **same Wi-Fi** — should open menu.

### Option B: Desktop build
1. Build:
   ```bash
   npm run build
   node scripts/build-desktop.mjs --stage-only
   npm --prefix desktop start   # test
   # or full installer:
   node scripts/build-desktop.mjs --win   # Windows
   ```
2. In app, **Admin → Tables & QRs** → QR modal now shows LAN URL.
3. If no LAN detected, connect staff PC to Wi-Fi and **Console → Restart Local Server**.

### If QR Still Shows 127.0.0.1
1. **Set APP_URL env**:
   ```bash
   APP_URL=http://192.168.1.42:3000 HOST=0.0.0.0 PORT=3000 npm start
   ```
2. **Or set in Admin Settings**:
   - Admin → Settings → **QR Base URL** → `http://192.168.1.42:3000` → Save
   - Re-open QR modal — should now use that.

3. **Firewall**: On Windows, allow Node/Electron through firewall for private networks.

4. **Same Wi-Fi**: Phone and staff PC must be on same Wi-Fi/network.

## Test Loop Results (this build)
```
Test 1: Auto-detect LAN — PASS (qrBaseUrl = http://169.254.0.21:53350, not 127.0.0.1)
Test 2: APP_URL override — PASS (http://192.168.1.42:53351)
Test 3: Public domain — PASS (https://mycafe.com)
Test 4: Desktop mode — PASS (DESKTOP_LAN_URLS = http://192.168.1.42:53353)
```

## Files Changed
- `src/server/network.ts` (new)
- `src/server/app.ts` (health + /api/network)
- `src/utils/qrBaseUrl.ts` (new)
- `src/components/QRPrintModal.tsx` (rewrite)
- `src/components/AdminTables.tsx` (LAN-aware)
- `src/components/AdminSettings.tsx` (qrBaseUrl field)
- `src/types.ts` (qrBaseUrl)
- `server.ts` (0.0.0.0 + LAN logs)
- `vite.config.ts` (host 0.0.0.0)
- `desktop/main.cjs` (fix APP_URL bug + better LAN detection)
- `.env.example` (docs)

## New Build Artifacts
- `dist/` — web build (after `npm run build`)
- `desktop/app/` — staged desktop app (after `node scripts/build-desktop.mjs --stage-only`)
- Installers in `release/` after full electron-builder run.

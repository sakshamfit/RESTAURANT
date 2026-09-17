# Windows Fix — HOST=0.0.0.0 not recognized + QR 127.0.0.1

You saw this error on PowerShell:
```
HOST=0.0.0.0 : The term 'HOST=0.0.0.0' is not recognized
```

That syntax is for Mac/Linux bash. On Windows PowerShell it fails. **New build fixes it** — you don't need to set HOST anymore (server defaults to 0.0.0.0).

## Quick Fix (Windows)

### Option 1: Just run (simplest) — server already binds 0.0.0.0
```powershell
npm install
npm run build
npm start
```
Check console — should show:
```
LAN addresses for QR codes:
  - Wi-Fi: 192.168.1.42 => http://192.168.1.42:3000
```
If QR still shows 127.0.0.1, use Option 2.

### Option 2: PowerShell with $env: (correct Windows syntax)
```powershell
# Find your LAN IP first
npm run find-ip

# Then start with that IP
$env:HOST="0.0.0.0"
$env:PORT="3000"
$env:APP_URL="http://192.168.1.42:3000"   # <-- replace with your IP from find-ip
npm start
```

### Option 3: Use our Windows starter scripts (easiest)
```powershell
# PowerShell
.\start-windows.ps1

# OR CMD
start-windows.bat
```
These auto-find your LAN IP and set everything.

### Option 4: Create .env file (recommended, works everywhere)
Create file `.env` in project root:
```
HOST=0.0.0.0
PORT=3000
APP_URL=http://192.168.1.42:3000
```
Replace `192.168.1.42` with your IP (run `ipconfig` to find it, look for 192.168.x).

Then just:
```powershell
npm run build
npm start
```

### Option 5: Set via Admin Settings (no env needed)
1. `npm start`
2. Open `http://localhost:3000/admin` (or your LAN IP)
3. Admin → Settings → **QR Base URL** → `http://192.168.1.42:3000` → Save
4. Re-open Tables → QR → now shows LAN IP, not 127.0.0.1

## Why QR was 127.0.0.1?

- Old code used `window.location.origin` — if you opened admin via `http://127.0.0.1:3000/admin`, QR encoded `127.0.0.1`
- Phone can't reach `127.0.0.1` (that's itself), so Safari says "could not connect to server"
- New code auto-detects LAN IP (`192.168.x`) and uses that for QR.

## Verify Fix

1. Start server: `npm start`
2. Check `/api/health` in browser: `http://localhost:3000/api/health`
   Should show:
   ```json
   "qrBaseUrl": "http://192.168.1.42:3000",
   "lanUrls": [{"url":"http://192.168.1.42:3000"}]
   ```
   NOT `127.0.0.1`

3. Tables → View QR → should show `http://192.168.1.42:3000/order/...`

4. Phone on same Wi-Fi → scan → menu opens.

## Still not working?

- Firewall: Windows Defender → Allow Node.js on Private networks
- Same Wi-Fi: Phone and PC must be same Wi-Fi
- Try `http://<your-ip>:3000/order/<token>` directly in phone browser first
- If that works, QR will work
- If not, check `ipconfig` → use that IP in `APP_URL` or Admin Settings

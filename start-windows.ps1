# NEXORAOSP RESTAURANT — Windows PowerShell starter
# Fixes "HOST=0.0.0.0 is not recognized" error on Windows
# Usage: right-click → Run with PowerShell, or in PowerShell: .\start-windows.ps1

Write-Host "=== NEXORAOSP RESTAURANT — Windows Starter ===" -ForegroundColor Cyan

# Find LAN IP
$ips = Get-NetIPAddress -AddressFamily IPv4 | Where-Object { $_.IPAddress -notlike "127.*" -and $_.IPAddress -notlike "169.254.*" -and $_.PrefixOrigin -ne "WellKnown" } | Sort-Object -Property { 
  if ($_.IPAddress -like "192.168.*") { 0 }
  elseif ($_.IPAddress -like "10.*") { 1 }
  elseif ($_.IPAddress -like "172.16.*" -or $_.IPAddress -like "172.17.*" -or $_.IPAddress -like "172.18.*") { 2 }
  else { 10 }
}

if (-not $ips -or $ips.Count -eq 0) {
  Write-Host "No LAN IP found, trying ipconfig..." -ForegroundColor Yellow
  ipconfig | Select-String "IPv4"
  $bestIp = "192.168.1.42"
} else {
  $best = $ips[0]
  $bestIp = $best.IPAddress
  Write-Host "Found LAN IPs:" -ForegroundColor Green
  $ips | ForEach-Object { Write-Host "  $($_.IPAddress) ($($_.InterfaceAlias))" }
  Write-Host "`nBest IP: $bestIp" -ForegroundColor Green
}

$port = if ($env:PORT) { $env:PORT } else { "3000" }
$appUrl = "http://${bestIp}:$port"

Write-Host "`nSetting env vars for Windows PowerShell:" -ForegroundColor Cyan
Write-Host "  HOST=0.0.0.0"
Write-Host "  PORT=$port"
Write-Host "  APP_URL=$appUrl"

$env:HOST = "0.0.0.0"
$env:PORT = $port
$env:APP_URL = $appUrl

Write-Host "`nStarting server..." -ForegroundColor Cyan
Write-Host "QR codes will be: $appUrl/order/<token>" -ForegroundColor Green
Write-Host "Phone must be on same Wi-Fi as this PC!" -ForegroundColor Yellow
Write-Host ""

# Check if dist exists, build if not
if (-not (Test-Path "dist/server.cjs")) {
  Write-Host "Building first..." -ForegroundColor Yellow
  npm run build
}

npm start

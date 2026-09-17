@echo off
REM NEXORAOSP RESTAURANT — Windows CMD starter
REM Fixes HOST=0.0.0.0 not recognized error
echo === NEXORAOSP RESTAURANT — Windows CMD Starter ===

REM Find LAN IP via ipconfig
for /f "tokens=2 delims=:" %%a in ('ipconfig ^| findstr /c:"IPv4 Address"') do (
  set IP=%%a
  goto :found
)
:found
set IP=%IP: =%
if "%IP%"=="" set IP=192.168.1.42

set PORT=3000
if not "%PORT%"=="" set PORT=%PORT%

set HOST=0.0.0.0
set APP_URL=http://%IP%:%PORT%

echo Found IP: %IP%
echo Setting:
echo   HOST=%HOST%
echo   PORT=%PORT%
echo   APP_URL=%APP_URL%
echo.
echo QR will be: %APP_URL%/order/<token>
echo Phone must be on same Wi-Fi!
echo.

if not exist dist\server.cjs (
  echo Building...
  call npm run build
)

call npm start

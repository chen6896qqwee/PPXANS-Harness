@echo off
chcp 65001 >nul 2>&1
cd /d "%~dp0"
set PPX_PROVIDER=lmstudio
title PPX Server (local lmstudio) 127.0.0.1:8899
echo.
echo  [PPX] starting PPX server  (local model lmstudio)
echo  [PPX] http://127.0.0.1:8899   close this window to stop
echo.
node src/server.js
pause

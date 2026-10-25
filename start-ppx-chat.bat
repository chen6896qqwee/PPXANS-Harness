@echo off
chcp 65001 >nul 2>&1
cd /d "%~dp0"
set PPX_PROVIDER=lmstudio
title PPX CLI Chat (local lmstudio)
echo.
echo  [PPX] starting PPX CLI  (local model lmstudio)
echo  [PPX] type your message, Ctrl+C to exit
echo.
node src/cli.js
pause

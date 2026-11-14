@echo off
setlocal
chcp 65001 >nul 2>&1
title 皮皮虾
cd /d "%~dp0"

REM 本机若继承 ELECTRON_RUN_AS_NODE, electron.exe 会退化成 node, 必须清掉
set "ELECTRON_RUN_AS_NODE="
set "ELECTRON_NO_ATTACH_CONSOLE=1"

set "ELECTRON=%~dp0node_modules\electron\dist\electron.exe"
if exist "%ELECTRON%" goto :run

echo.
echo   首次启动需要安装桌面运行时 (Electron, 约 100MB, 只需一次)。
echo   按任意键开始安装, 按 Ctrl+C 取消。
echo.
pause >nul

where npm >nul 2>&1
if errorlevel 1 (
  echo   [失败] 未检测到 npm, 请先安装 Node.js 20 或更高版本: https://nodejs.org
  pause
  exit /b 1
)

call npm install
if errorlevel 1 (
  echo.
  echo   [失败] 依赖安装失败, 请检查网络后重试。
  pause
  exit /b 1
)

if not exist "%ELECTRON%" (
  echo.
  echo   [失败] 未找到 Electron 运行时, 请查看上方 npm 输出。
  pause
  exit /b 1
)

:run
echo.
echo   皮皮虾 桌面端 —— 正在启动...
echo   数据与日志: %LOCALAPPDATA%\PPXANS-Harness-Desktop
echo.
start "" "%ELECTRON%" "%~dp0electron\main.js"
exit /b 0

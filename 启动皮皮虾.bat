@echo off
setlocal enabledelayedexpansion
chcp 936 >nul 2>&1
title 皮皮虾 一键启动
cd /d "%~dp0"

echo.
echo   皮皮虾 PPXANS-Harness · Web 应用一键启动
echo   ============================================
echo.

REM 优先使用自带 runtime\node.exe，否则用系统 node
set "NODE=node"
if exist "%~dp0runtime\node.exe" set "NODE=%~dp0runtime\node.exe"

where node >nul 2>&1
if errorlevel 1 (
  echo   [错误] 未检测到 Node.js，请先安装 Node 20 或更高版本:
  echo          https://nodejs.org
  echo.
  pause
  exit /b 1
)

REM 获取端口（与后端同源，防止写死）
set "PORT="
for /f "delims=" %%p in ('"%NODE%" "%~dp0bin\ppx-web.js" --print-port 2^>nul') do set "PORT=%%p"
if "%PORT%"=="" set "PORT=8899"

REM 清理旧监听（若端口被占用）
set "OLD="
for /f "tokens=5" %%p in ('netstat -ano ^| findstr /C:":%PORT% " ^| findstr LISTENING') do set "OLD=%%p"
if defined OLD (
  echo   [清理] 检测到旧服务进程 PID !OLD!，正在结束...
  taskkill /F /PID !OLD! >nul 2>&1
  ping -n 2 127.0.0.1 >nul
)

REM 后台最小化启动
echo   [启动] 内核 + 界面（自动开浏览器，端口 %PORT%）
start "皮皮虾 Web" /min /d "%~dp0" "%NODE%" "%~dp0bin\ppx-web.js" --port %PORT%

REM 等待端口就绪（最多约 30 秒）
set /a N=0
:wait
ping -n 2 127.0.0.1 >nul
netstat -ano | findstr /C:":%PORT% " | findstr LISTENING >nul && goto up
set /a N+=1
if %N% GEQ 15 goto fail
goto wait

:up
echo   [就绪] http://127.0.0.1:%PORT%
echo   [提示] 关闭最小化窗口即停止服务；或双击 停止皮皮虾.bat
echo.
exit /b 0

:fail
echo   [失败] 30 秒内未监听到端口 %PORT%
echo   请在本目录手动运行查看报错:
echo          node bin\ppx-web.js
echo.
pause
exit /b 1

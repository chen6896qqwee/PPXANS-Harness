@echo off
setlocal enabledelayedexpansion
chcp 936 >nul 2>&1
title 皮皮虾 一键启动

cd /d "%~dp0"

REM 由 VBS 静默调用时传 q: 不等待按键, 避免出现"看不见的等待进程"
set "QUIET="
if /i "%~1"=="q" set "QUIET=1"

echo.
echo   皮皮虾 PPXANS-Harness · Web 应用一键启动
echo   ============================================
echo.

where node >nul 2>&1
if errorlevel 1 (
  echo   [错误] 未检测到 Node.js。请先安装 Node 20 或更高版本:
  echo          https://nodejs.org
  echo.
  if not defined QUIET pause
  exit /b 1
)

REM ---- 读取端口 (与内核配置同源, 不写死) ----
set "PORT="
for /f "delims=" %%p in ('node "%~dp0bin\ppx-web.js" --print-port 2^>nul') do set "PORT=%%p"
if "%PORT%"=="" set "PORT=8899"

REM ---- 清理上一次遗留的监听进程 (幂等, 避免端口占用) ----
set "OLD="
for /f "tokens=5" %%p in ('netstat -ano ^| findstr ":%PORT% " ^| findstr LISTENING') do set "OLD=%%p"
if defined OLD (
  echo   [清理] 结束上一次的服务进程 PID !OLD!
  taskkill /F /PID !OLD! >nul 2>&1
  ping -n 2 127.0.0.1 >nul
)

REM ---- 后台最小化启动 (内核与界面同进程同端口) ----
echo   [启动] 内核 + 界面 (单进程, 端口 %PORT%)
start "皮皮虾 Web" /min %ComSpec% /k node "%~dp0bin\ppx-web.js" --port %PORT%

REM ---- 轮询就绪 (最多约 30 秒) ----
set /a N=0
:wait
ping -n 2 127.0.0.1 >nul
netstat -ano | findstr ":%PORT% " | findstr LISTENING >nul && goto up
set /a N+=1
if %N% GEQ 15 goto fail
goto wait

:up
echo   [就绪] http://127.0.0.1:%PORT%
echo   [提示] 浏览器应已自动打开; 停止服务请双击「停止皮皮虾.bat」
echo.
exit /b 0

:fail
echo   [失败] 30 秒内未监听端口 %PORT%。
echo   请在本目录执行下面命令查看具体错误:
echo          node bin\ppx-web.js
echo.
if not defined QUIET pause
exit /b 1

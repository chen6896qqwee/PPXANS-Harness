@echo off
setlocal enabledelayedexpansion
chcp 936 >nul 2>&1
title 皮皮虾 停止服务

cd /d "%~dp0"

set "PORT="
for /f "delims=" %%p in ('node "%~dp0bin\ppx-web.js" --print-port 2^>nul') do set "PORT=%%p"
if "%PORT%"=="" set "PORT=8899"

set "FOUND="
for /f "tokens=5" %%p in ('netstat -ano ^| findstr ":%PORT% " ^| findstr LISTENING') do set "FOUND=%%p"

REM 注意: 括号块内的 echo 不能出现半角小括号, 否则会被 cmd 当作块结束符
if not defined FOUND (
  echo.
  echo   皮皮虾服务未在运行, 端口 %PORT% 无监听。
  echo.
  ping -n 3 127.0.0.1 >nul
  exit /b 0
)

echo.
echo   正在停止皮皮虾服务, 端口 %PORT%, PID !FOUND! ...
taskkill /F /PID !FOUND! >nul 2>&1
ping -n 2 127.0.0.1 >nul

netstat -ano | findstr ":%PORT% " | findstr LISTENING >nul
if errorlevel 1 (
  echo   已停止。
) else (
  echo   停止失败, 请在任务管理器中结束 PID !FOUND!。
)
echo.
ping -n 3 127.0.0.1 >nul
exit /b 0

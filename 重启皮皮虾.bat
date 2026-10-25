@echo off
chcp 936 >nul 2>&1
title 皮皮虾 重启服务
cd /d "%~dp0"

echo.
echo   正在重启皮皮虾服务...
echo.

echo   [1/2] 停止旧服务
call "%~dp0停止皮皮虾.bat"

echo.
echo   [2/2] 启动新服务
call "%~dp0启动皮皮虾.bat"
exit /b 0

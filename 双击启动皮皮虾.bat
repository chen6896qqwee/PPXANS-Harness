@echo off
chcp 936 >nul 2>&1
REM 一键启动入口 (转发到 启动皮皮虾.bat, 保持单一份实现)
call "%~dp0启动皮皮虾.bat"

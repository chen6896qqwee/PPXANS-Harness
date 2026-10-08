@echo off
chcp 936 >nul 2>&1
title 皮皮虾 高级菜单
cd /d "%~dp0"

:menu
cls
echo.
echo   ============================================
echo     皮皮虾 PPXANS-Harness v3.2.2 高级菜单
echo   ============================================
echo.
echo    [1] Web 应用      (内核+界面 单进程, 自动开浏览器)
echo    [2] Web 应用      (同上, 但不自动开浏览器)
echo    [3] HTTP 服务     (仅接口, 含 /mcp 端点)
echo    [4] CLI 聊天      (终端直接对话)
echo    [5] 自愈体检      (启动体检 + 审计链校验)
echo    [6] 全量测试      (node --test)
echo    [7] 退出
echo.
set /p choice=  请选择 (1-7): 

if "%choice%"=="1" goto web
if "%choice%"=="2" goto webnoopen
if "%choice%"=="3" goto serve
if "%choice%"=="4" goto chat
if "%choice%"=="5" goto selfheal
if "%choice%"=="6" goto test
if "%choice%"=="7" exit /b 0
echo  无效选择，按任意键重试...
pause >nul
goto menu

:web
echo.
echo  [PPX] 启动 Web 应用 (Ctrl+C 退出)
echo.
node bin\ppx-web.js
pause
goto menu

:webnoopen
echo.
echo  [PPX] 启动 Web 应用, 不打开浏览器 (Ctrl+C 退出)
echo.
node bin\ppx-web.js --no-open
pause
goto menu

:serve
echo.
echo  [PPX] 启动 HTTP 服务：http://127.0.0.1:8899  (含 /mcp 端点)
echo.
node src\server.js
pause
goto menu

:chat
echo.
echo  [PPX] 启动 CLI 对话，Ctrl+C 退出
echo.
node src\cli.js
pause
goto menu

:selfheal
echo.
echo  [PPX] 运行自愈体检...
echo.
call npm run selfheal
echo.
echo  [PPX] 校验审计哈希链...
echo.
call npm run audit:verify
pause
goto menu

:test
echo.
echo  [PPX] 全量测试...
echo.
call npm test
pause
goto menu

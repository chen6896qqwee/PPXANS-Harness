// scripts/package.js - PC 端打包: Windows 便携版 zip + 单文件自解压安装器 (.cmd)
// 零依赖: 仅用 Node 内置模块 + 系统 zip/python3 (构建机) + 目标机 Windows 内置 PowerShell。
// 安装器不写注册表: 解压到 %LOCALAPPDATA%\PPXANS-Harness + 桌面/开始菜单快捷方式 + 卸载器。
//
// 用法:
//   node scripts/package.js              # 便携版 + 安装器 全部构建
//   node scripts/package.js portable     # 仅便携版
//   node scripts/package.js installer    # 仅安装器 (内嵌与便携版同一 payload)
//   node scripts/package.js --node v22.14.0   # 指定内置 Node 版本 (默认 v22.14.0 LTS)
import { execFileSync, spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const DIST = path.join(ROOT, "dist");
const CACHE = path.join(DIST, ".cache");
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
const VER = pkg.version;

// ---- 参数解析 ----
const args = process.argv.slice(2);
let nodeVer = "v22.14.0";
let targets = [];
for (let i = 0; i < args.length; i++) {
  if (args[i] === "--node") nodeVer = args[++i].startsWith("v") ? args[++i] : args[i];
  else if (["portable", "installer", "all"].includes(args[i])) targets.push(args[i]);
}
if (!targets.length) targets = ["portable", "installer"];
const NODE_ZIP_URL = `https://nodejs.org/dist/${nodeVer}/node-${nodeVer}-win-x64.zip`;
const SHASUMS_URL = `https://nodejs.org/dist/${nodeVer}/SHASUMS256.txt`;

const log = (s) => console.log(s);
const die = (s) => { console.error(`[package] 错误: ${s}`); process.exit(1); };

// ---- 打包内容清单 (排除源仓运行数据/测试/构建机专用) ----
const APP_DIRS = ["src", "bin", "config", "public", "skills"];
const APP_FILES = ["package.json", "README.md", "LICENSE",
  "启动皮皮虾.bat", "停止皮皮虾.bat", "高级菜单.bat",
  "启动皮皮虾.vbs", "皮皮虾 Web.vbs",
  "start-ppx-server.bat", "start-ppx-chat.bat", "双击启动皮皮虾.bat"];

function run(cmd, cmdArgs, opts = {}) {
  const r = spawnSync(cmd, cmdArgs, { stdio: opts.capture ? ["ignore", "pipe", "inherit"] : "inherit", cwd: ROOT, ...opts });
  if (r.status !== 0) die(`${cmd} 退出码 ${r.status}`);
  return r.stdout ? r.stdout.toString() : "";
}

// ---- 1. 下载并校验 Windows Node 运行时 (SHA-256 对官网上比对) ----
function ensureNodeRuntime() {
  fs.mkdirSync(CACHE, { recursive: true });
  const zipPath = path.join(CACHE, `node-${nodeVer}-win-x64.zip`);
  if (!fs.existsSync(zipPath)) {
    log(`[1/5] 下载内置运行时 ${NODE_ZIP_URL}`);
    run("curl", ["-fSL", "--retry", "3", "-o", zipPath, NODE_ZIP_URL]);
  } else {
    log(`[1/5] 复用缓存运行时 ${path.basename(zipPath)}`);
  }
  // SHA-256 校验 (供应链防线: 与官方 SHASUMS256.txt 逐字比对)
  const shasums = run("curl", ["-fsSL", SHASUMS_URL], { capture: true });
  const expect = shasums.split("\n").find((l) => l.endsWith(`node-${nodeVer}-win-x64.zip`));
  if (!expect) die(`SHASUMS256.txt 中找不到 ${nodeVer} win-x64 条目`);
  const got = crypto.createHash("sha256").update(fs.readFileSync(zipPath)).digest("hex");
  if (got !== expect.split(/\s+/)[0]) die(`Node 运行时 SHA-256 不匹配!\n  期望 ${expect.split(/\s+/)[0]}\n  实际 ${got}`);
  log(`      SHA-256 校验通过 (${got.slice(0, 16)}...)`);
  return zipPath;
}

// ---- 2. 组装应用目录 ----
function stageApp(zipPath) {
  log("[2/5] 组装应用目录 (src/bin/config/public/skills + 启动器)");
  const stage = path.join(DIST, ".stage");
  fs.rmSync(stage, { recursive: true, force: true });
  fs.mkdirSync(stage, { recursive: true });
  for (const d of APP_DIRS) {
    // 2026-10-03 修复 (P1): config 目录原样递归复制会把 config/ppx.json (可能含明文
    // api_key / channels auth_token, 由 ppx-setup 向导落盘) 一起打进发布物发给最终用户。
    // 打包时排除 ppx.json, 只带 example 模板。
    const filter = d === "config"
      ? (src) => path.basename(src) !== "ppx.json"
      : undefined;
    fs.cpSync(path.join(ROOT, d), path.join(stage, d), { recursive: true, filter });
  }
  for (const f of APP_FILES) {
    if (fs.existsSync(path.join(ROOT, f))) fs.copyFileSync(path.join(ROOT, f), path.join(stage, f));
    else log(`      警告: 清单文件不存在, 跳过 ${f}`);
  }
  // 内置运行时: 从 node zip 抽出 node.exe → runtime/node.exe
  // 2026-10-03 修复 (P2): 原 execFileSync("python3") 在裸 Windows 上必挂 (无 python3,
  // 且易撞微软商店假别名), 与零依赖叙事不符。改用系统自带 PowerShell Expand-Archive。
  fs.mkdirSync(path.join(stage, "runtime"), { recursive: true });
  const tmpUnzip = path.join(DIST, ".unzip-tmp");
  fs.rmSync(tmpUnzip, { recursive: true, force: true });
  fs.mkdirSync(tmpUnzip, { recursive: true });
  run("powershell", ["-NoProfile", "-Command",
    `Expand-Archive -Path '${zipPath.replace(/'/g, "''")}' -DestinationPath '${tmpUnzip.replace(/'/g, "''")}' -Force`]);
  const found = (function findNode(dir) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) { const r = findNode(p); if (r) return r; }
      else if (e.name === "node.exe") return p;
    }
    return null;
  })(tmpUnzip);
  if (!found) die("node zip 中找不到 node.exe");
  fs.copyFileSync(found, path.join(stage, "runtime", "node.exe"));
  fs.rmSync(tmpUnzip, { recursive: true, force: true });
  // 打包专属启动器: 运行时优先的 Web 启动入口 (快捷方式指向它)
  fs.writeFileSync(path.join(stage, "ppx-web.cmd"), [
    "@echo off",
    'set "NODE=%~dp0runtime\\node.exe"',
    'if not exist "%NODE%" set "NODE=node"',
    '"%NODE%" "%~dp0bin\\ppx-web.js"',
  ].join("\r\n") + "\r\n", "utf8");
  const sz = (p) => (fs.statSync(p).size / 1048576).toFixed(1) + "MB";
  log(`      runtime/node.exe: ${sz(path.join(stage, "runtime", "node.exe"))}`);
  return stage;
}

// ---- 3. zip 打包 (PowerShell Compress-Archive; withTopDir=便携版带顶层目录, 安装器 payload 平铺) ----
// 2026-10-03 修复 (P2): 原依赖外部 Info-ZIP `zip` 命令, 裸 Windows 不存在 → 打包必挂。
// 改用系统自带 PowerShell (目标机解压侧本就依赖 Expand-Archive, 同源无兼容问题)。
function makeZip(stage, outPath, withTopDir) {
  fs.rmSync(outPath, { force: true });
  const psQuote = (s) => "'" + s.replace(/'/g, "''") + "'";
  if (withTopDir) {
    // 便携版: 顶层目录 PPXANS-Harness/
    const tmpTop = path.join(path.dirname(outPath), "PPXANS-Harness");
    fs.rmSync(tmpTop, { recursive: true, force: true });
    fs.cpSync(stage, tmpTop, { recursive: true });
    run("powershell", ["-NoProfile", "-Command",
      `Compress-Archive -Path ${psQuote(tmpTop)} -DestinationPath ${psQuote(outPath)} -Force`]);
    fs.rmSync(tmpTop, { recursive: true, force: true });
  } else {
    // 安装器 payload: 平铺 (解压目标目录即安装根)
    run("powershell", ["-NoProfile", "-Command",
      `Compress-Archive -Path ${psQuote(path.join(stage, "*"))} -DestinationPath ${psQuote(outPath)} -Force`]);
  }
}

// ---- 4. 安装器: payload base64 内嵌进自解压 .cmd ----
// 目标机仅需 Windows 10/11 内置 PowerShell 5.1 (Expand-Archive), 不写注册表, 卸载干净。
const INSTALLER_TMPL = String.raw`
@echo off
chcp 65001 >nul
setlocal
title 皮皮虾 PPXANS-Harness v__VER__ 安装向导
echo.
echo   ================================================
echo     皮皮虾 PPXANS-Harness v__VER__ 安装向导
echo     智能体内核 + Web 界面 (内置 Node __NODEVER__, 免装环境)
echo   ================================================
echo.
echo   [1/4] 正在解包内置文件 ...
REM 标记串在此处拆开拼接, 保证全文件仅末尾一处完整标记, IndexOf 才能命中 payload 起点
powershell -NoProfile -ExecutionPolicy Bypass -Command "$f=[IO.File]::ReadAllText('%~f0'); $m='<<<PPX-' + 'PAYLOAD-DO-NOT-EDIT>>>'; $i=$f.IndexOf($m); if($i -lt 0){Write-Host 'PAYLOAD MISSING' -ForegroundColor Red; exit 1}; $z=Join-Path $env:TEMP 'ppxans-payload.zip'; [IO.File]::WriteAllBytes($z,[Convert]::FromBase64String($f.Substring($i+$m.Length).Trim())); Write-Host '         OK'"
if errorlevel 1 goto :fail

set "DEST=%LOCALAPPDATA%\PPXANS-Harness"
echo   [2/4] 正在安装到 %DEST% ...
echo         (如文件被占用, 请先关闭正在运行的皮皮虾窗口)
powershell -NoProfile -ExecutionPolicy Bypass -Command "Expand-Archive -Path (Join-Path $env:TEMP 'ppxans-payload.zip') -DestinationPath '%DEST%' -Force"
if errorlevel 1 goto :fail

echo   [3/4] 正在创建快捷方式 (桌面 + 开始菜单) ...
powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "$ws=New-Object -ComObject WScript.Shell;" ^
  "$desk=[Environment]::GetFolderPath('Desktop'); $sm=[Environment]::GetFolderPath('Programs')+'\PPXANS-Harness'; New-Item -ItemType Directory -Path $sm -Force | Out-Null;" ^
  "$d=$ws.CreateShortcut($desk+'\PPXANS-Harness.lnk'); $d.TargetPath='%DEST%\ppx-web.cmd'; $d.WorkingDirectory='%DEST%'; $d.WindowStyle=7; $d.Save();" ^
  "$m=$ws.CreateShortcut($sm+'\PPXANS-Harness.lnk'); $m.TargetPath='%DEST%\ppx-web.cmd'; $m.WorkingDirectory='%DEST%'; $m.WindowStyle=7; $m.Save();" ^
  "$u=$ws.CreateShortcut($sm+'\Uninstall.lnk'); $u.TargetPath='%DEST%\uninstall.cmd'; $u.WorkingDirectory='%DEST%'; $u.Save()"

echo   [4/4] 正在写入卸载器 ...
> "%DEST%\uninstall.cmd" (
echo @echo off
echo chcp 65001 ^>nul
echo echo   正在卸载皮皮虾 PPXANS-Harness ...
echo powershell -NoProfile -ExecutionPolicy Bypass -Command "Remove-Item -LiteralPath ([Environment]::GetFolderPath('Desktop')+'\PPXANS-Harness.lnk') -ErrorAction SilentlyContinue; Remove-Item -LiteralPath ([Environment]::GetFolderPath('Programs')+'\PPXANS-Harness') -Recurse -Force -ErrorAction SilentlyContinue"
echo start "" /min cmd /c "timeout /t 2 /nobreak ^>nul & rmdir /s /q "%DEST%""
echo exit /b 0
)

del /q "%TEMP%\ppxans-payload.zip" >nul 2>&1
echo.
echo   ================================================
echo   安装完成!
echo     启动方式: 桌面快捷方式 "PPXANS-Harness"
echo     安装位置: %DEST%
echo     卸载方式: 开始菜单 ^> PPXANS-Harness ^> Uninstall
echo     安全说明: 本安装器不写注册表, 卸载即彻底移除
echo   ================================================
echo.
echo   按任意键关闭向导并立即启动皮皮虾...
pause >nul
start "" "%DEST%\ppx-web.cmd"
exit /b 0

:fail
echo.
echo   安装失败。请关闭正在运行的皮皮虾窗口后重新双击本安装器。
echo   按任意键退出...
pause >nul
exit /b 1
__MARKER__
`;

function makeInstaller(payloadZip, outPath) {
  log("[4/5] 生成单文件自解压安装器 (PowerShell 内置解压, 不写注册表)");
  const b64 = fs.readFileSync(payloadZip).toString("base64").replace(/(.{4096})/g, "$1\n");
  const cmd = INSTALLER_TMPL
    .replaceAll("__VER__", VER)
    .replaceAll("__NODEVER__", nodeVer)
    .replaceAll("__MARKER__", "<<<PPX-PAYLOAD-DO-NOT-EDIT>>>")
    .replace(/\n/g, "\r\n") + b64.replace(/\n/g, "\r\n") + "\r\n";
  fs.writeFileSync(outPath, cmd, "utf8");
  // 自校验: 重新读回, 从标记后解码 base64, 比对 SHA-256 与 payload zip 一致
  const back = fs.readFileSync(outPath, "utf8");
  const m = "<<<PPX-PAYLOAD-DO-NOT-EDIT>>>";
  // 守卫: 全文件仅允许一处完整标记 (脚本内已拆串), 否则运行时 IndexOf 会错位
  const first = back.indexOf(m), last = back.lastIndexOf(m);
  if (first !== last) die("安装器内标记串出现多次, 运行时 IndexOf 会错位, 拒绝发布");
  const decoded = Buffer.from(back.substring(last + m.length).trim(), "base64");
  const h1 = crypto.createHash("sha256").update(decoded).digest("hex");
  const h2 = crypto.createHash("sha256").update(fs.readFileSync(payloadZip)).digest("hex");
  if (h1 !== h2) die("安装器自校验失败: 内嵌 payload SHA-256 与源 zip 不一致");
  log(`      自校验通过: payload SHA-256 ${h2.slice(0, 16)}...`);
}

// ---- main ----
const mb = (p) => (fs.statSync(p).size / 1048576).toFixed(1) + "MB";
fs.mkdirSync(DIST, { recursive: true });
const nodeZip = ensureNodeRuntime();
const stage = stageApp(nodeZip);

const portableZip = path.join(DIST, `PPXANS-Harness-v${VER}-portable-win64.zip`);
const payloadZip = path.join(CACHE, "ppxans-payload.zip");
const installer = path.join(DIST, `PPXANS-Harness-v${VER}-Setup-win64.cmd`);

if (targets.includes("portable")) {
  log("[3/5] 生成便携版 zip (带顶层目录, 解压即用)");
  makeZip(stage, portableZip, true);
  log(`      产物: ${path.basename(portableZip)} (${mb(portableZip)})`);
}
if (targets.includes("installer")) {
  log("[3/5] 生成安装器 payload zip (平铺)");
  makeZip(stage, payloadZip, false);
  makeInstaller(payloadZip, installer);
  log(`      产物: ${path.basename(installer)} (${mb(installer)})`);
}
log("[5/5] 打包完成 ✓");
fs.rmSync(stage, { recursive: true, force: true });

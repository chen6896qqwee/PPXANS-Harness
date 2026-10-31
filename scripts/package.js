// scripts/package.js - PC 端打包: Windows 便携版 zip + 单文件自解压安装器 (.cmd)
// 零依赖: 仅用 Node 内置模块 + 构建机 Windows 自带 PowerShell/tar (Win10 1803+)。
//   · zip 写入: System32\tar.exe (bsdtar, 条目使用标准正斜杠)
//   · node.exe 抽取: PowerShell .NET ZipFile (只取运行时入口, 不解全包)
// 安装器不写注册表: 解压到 %LOCALAPPDATA%\PPXANS-Harness + 桌面/开始菜单快捷方式 + 卸载器。
//
// 用法:
//   node scripts/package.js              # 便携版 + 安装器 全部构建
//   node scripts/package.js portable     # 仅便携版
//   node scripts/package.js installer    # 仅安装器 (内嵌与便携版同一 payload)
//   node scripts/package.js --node v22.14.0   # 指定内置 Node 版本 (默认 v22.14.0 LTS)
import { spawnSync } from "node:child_process";
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
  if (args[i] === "--node") {
    const v = args[++i] || "";
    if (!v) die("--node 需要一个版本号, 例如 --node v22.14.0");
    nodeVer = v.startsWith("v") ? v : `v${v}`;
  } else if (["portable", "installer", "all"].includes(args[i])) targets.push(args[i]);
}
if (!targets.length) targets = ["portable", "installer"];
const NODE_ZIP_URL = `https://nodejs.org/dist/${nodeVer}/node-${nodeVer}-win-x64.zip`;
const SHASUMS_URL = `https://nodejs.org/dist/${nodeVer}/SHASUMS256.txt`;

const log = (s) => console.log(s);
const die = (s) => { console.error(`[package] 错误: ${s}`); process.exit(1); };

// ---- 打包内容清单 (排除源仓运行数据/测试/构建机专用) ----
// 2026-10-30: config 不再整目录复制 —— 本机 ppx.json 可能含 API Key / apply 模式自改开关,
//   ppx.json.bak-* 还带历史密钥。只发模板与身份文件。
const APP_DIRS = ["src", "bin", "public", "skills"];
const CONFIG_FILES = ["ppx.json.example", "identity.md", "ishiki.md"];
const APP_FILES = ["package.json", "README.md", "LICENSE", "NOTICE", "THIRD-PARTY-NOTICES.md",
  "启动皮皮虾.bat", "停止皮皮虾.bat", "高级菜单.bat",
  "启动皮皮虾.vbs", "皮皮虾 Web.vbs",
  "start-ppx-server.bat", "start-ppx-chat.bat", "双击启动皮皮虾.bat"];

function run(cmd, cmdArgs, opts = {}) {
  const r = spawnSync(cmd, cmdArgs, { stdio: opts.capture ? ["ignore", "pipe", "inherit"] : "inherit", cwd: ROOT, ...opts });
  if (r.status !== 0) die(`${cmd} 退出码 ${r.status}`);
  return r.stdout ? r.stdout.toString() : "";
}

// Windows 自带 bsdtar (Win10 1803+): 写 zip 时条目用正斜杠, 兼容各解压工具。
// 注意: Git Bash 的 /usr/bin/tar 是 GNU tar, 不支持写 zip, 必须走 System32。
const TAR = path.join(process.env.SystemRoot || "C:\\Windows", "System32", "tar.exe");

function powershell(script, extraEnv = {}) {
  const r = spawnSync("powershell", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", script], {
    stdio: "inherit", env: { ...process.env, ...extraEnv },
  });
  if (r.status !== 0) die(`PowerShell 退出码 ${r.status}`);
}

// 从 zip 里按后缀抽单个文件 (node.exe / LICENSE), 不解整包
function extractZipEntry(zipPath, entryPattern, outPath) {
  powershell([
    "Add-Type -AssemblyName System.IO.Compression.FileSystem",
    "$z=[IO.Compression.ZipFile]::OpenRead($env:PPX_ZIP)",
    "try {",
    "  $e=$z.Entries | Where-Object { $_.FullName -like $env:PPX_ENTRY } | Select-Object -First 1",
    "  if(-not $e){ Write-Error ('压缩包内找不到 ' + $env:PPX_ENTRY); exit 2 }",
    "  [IO.Compression.ZipFileExtensions]::ExtractToFile($e,$env:PPX_OUT,$true)",
    "} finally { if($z){ $z.Dispose() } }",
  ].join("; "), { PPX_ZIP: zipPath, PPX_ENTRY: entryPattern, PPX_OUT: outPath });
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
  log("[2/5] 组装应用目录 (src/bin/public/skills + 配置模板 + 启动器)");
  const stage = path.join(DIST, ".stage");
  fs.rmSync(stage, { recursive: true, force: true });
  fs.mkdirSync(stage, { recursive: true });
  for (const d of APP_DIRS) fs.cpSync(path.join(ROOT, d), path.join(stage, d), { recursive: true });
  fs.mkdirSync(path.join(stage, "config"), { recursive: true });
  for (const f of CONFIG_FILES) {
    const from = path.join(ROOT, "config", f);
    if (fs.existsSync(from)) fs.copyFileSync(from, path.join(stage, "config", f));
    else log(`      警告: 配置模板不存在, 跳过 config/${f}`);
  }
  for (const f of APP_FILES) {
    if (fs.existsSync(path.join(ROOT, f))) fs.copyFileSync(path.join(ROOT, f), path.join(stage, f));
    else log(`      警告: 清单文件不存在, 跳过 ${f}`);
  }
  // 产物安全扫描: 任何用户配置/备份/明文凭据都会在这里中止打包
  const scan = spawnSync(process.execPath, [path.join(ROOT, "scripts", "package-scan.js"), stage], { stdio: "inherit" });
  if (scan.status !== 0) die("产物安全扫描未通过, 已中止打包");
  // 内置运行时 + Node 许可证: 只从 zip 抽两个文件, 满足再分发合规
  const runtimeDir = path.join(stage, "runtime");
  fs.mkdirSync(runtimeDir, { recursive: true });
  extractZipEntry(zipPath, "*/node.exe", path.join(runtimeDir, "node.exe"));
  extractZipEntry(zipPath, "*/LICENSE", path.join(runtimeDir, "LICENSE.node.txt"));
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

// ---- 3. zip 打包 (Windows 内置 tar; withTopDir=便携版带顶层目录, 安装器 payload 平铺) ----
function makeZip(stage, outPath, withTopDir) {
  if (!fs.existsSync(TAR)) die(`缺少 ${TAR}; 需要 Windows 10 1803+ 自带的 tar.exe`);
  fs.rmSync(outPath, { force: true });
  if (withTopDir) {
    // 便携版: 顶层目录 PPXANS-Harness/
    const tmpTop = path.join(path.dirname(outPath), "PPXANS-Harness");
    fs.rmSync(tmpTop, { recursive: true, force: true });
    fs.cpSync(stage, tmpTop, { recursive: true });
    try {
      run(TAR, ["-a", "-c", "-f", outPath, "-C", path.dirname(outPath), "PPXANS-Harness"]);
    } finally {
      fs.rmSync(tmpTop, { recursive: true, force: true });
    }
  } else {
    // 安装器 payload: 平铺 (解压目标目录即安装根)
    // 目录不要带尾斜杠: bsdtar 会自行补目录条目, 传 "dir/" 反而报 Couldn't visit directory
    const names = fs.readdirSync(stage);
    run(TAR, ["-a", "-c", "-f", outPath, "-C", stage, ...names]);
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

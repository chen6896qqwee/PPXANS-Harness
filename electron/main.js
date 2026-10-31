// electron/main.js — 皮皮虾桌面端主进程
//
// 职责边界: Electron 只做"壳", 内核仍是 bin/ppx-web.js 的同源单端口服务。
//   1) 单实例: 重复启动只聚焦已有窗口
//   2) 工作副本: 打包版把内置代码播种到可写目录 (自改代码闭环需要可写 root)
//   3) 服务生命周期: 以 ELECTRON_RUN_AS_NODE 拉起子进程, 窗口关闭即回收
//   4) 桌面体验: 窗口状态记忆、启动页、菜单、麦克风权限、外链走系统浏览器
//
// 端口策略: 首选配置端口; 若已被本应用占用则直接接入; 否则向后找空闲端口。
//
// 环境变量:
//   PPX_ROOT          覆盖工作副本目录 (dev 默认仓库根, 打包版默认 userData/workspace)
//   PPX_PORT          覆盖首选端口
//   PPX_DESKTOP_SMOKE 1 = 冒烟模式: 不显示窗口, 加载完成后截图退出
//   PPX_DESKTOP_SMOKE_OUT 冒烟截图输出路径
import { app, BrowserWindow, Menu, dialog, shell, session, clipboard, screen } from "electron";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DEV_ROOT = path.resolve(HERE, "..");
// 打包后 electron/main.js 位于 resources/app/electron/, 代码根是上一级
const APP_ROOT = app.isPackaged ? path.join(process.resourcesPath, "app") : DEV_ROOT;
const APP_NAME = "皮皮虾";
const SPAWN_DIRS = ["bin", "src", "skills", "experts", "plugins", "references", "public", "scripts", "test", "bench", "fixtures"];
// config 不再整目录播种: ppx.json 是用户配置, 打包机上的版本绝不能被复制给用户。
const SPAWN_CONFIG_FILES = ["ppx.json.example", "identity.md", "ishiki.md"];
const SPAWN_FILES = ["package.json", "README.md", "LICENSE", "CHANGELOG.md", "PPX.md"];
// 升级时这些用户资产已存在就不覆盖 (代码目录仍整体更新, 旧版先完整备份)
const USER_OWNED = new Set(["config/ppx.json", "config/identity.md", "config/ishiki.md", "PPX.md"]);
const UPGRADE_BACKUP_DIRS = [...SPAWN_DIRS, "config"];

// 桌面端数据统一放"本机应用数据目录" (工作副本含代码, 不适合漫游):
//   Windows %LOCALAPPDATA% / macOS ~/Library/Application Support / Linux ~/.config
const APP_DATA_HOME = process.platform === "win32"
  ? (process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local"))
  : app.getPath("appData");
app.setPath("userData", path.join(APP_DATA_HOME, "PPXANS-Harness-Desktop"));

const SMOKE = process.env.PPX_DESKTOP_SMOKE === "1";
const ICON = path.join(APP_ROOT, "electron", process.platform === "win32" ? "icon.ico" : "icon.png");

// 任务栏分组与通知归属 (Windows)
if (process.platform === "win32") app.setAppUserModelId("com.ppxans.harness");

let win = null;
let serverChild = null;
let serverOwned = false;
let appUrl = "";
let booted = false;
let quitting = false;
let quitReady = false;
let logStream = null;
// 每次启动生成的一次性握手密钥: 只有自己拉起的子进程知道, 用来证明端口上的服务确实是本实例。
const DESKTOP_SECRET = crypto.randomBytes(32).toString("hex");

function argOf(name) {
  const argv = process.argv.slice(2);
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : "";
}

function log(...args) {
  const line = `[${new Date().toISOString()}] ${args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" ")}`;
  if (!app.isPackaged) console.log(line);
  try { logStream?.write(line + os.EOL); } catch { /* 日志失败不致命 */ }
}

// ---- 工作副本 ----
// 2026-10-30: 版本化播种。旧实现只在缺少 bin/ppx-web.js 时播种, 安装包升级后工作副本
//   永远停在首次安装的代码 —— UI 显示新版本号, 实际跑的是旧内核。现在:
//   · 首次安装: 全量播种
//   · 版本变化: 先把旧代码+配置完整备份到 workspace.backup-<旧版本>-<时间>,
//     再覆盖代码目录; data/uploads/.ppx/用户配置/身份文件/PPX.md 原样保留。
function readSeedMarker(ws) {
  try {
    return JSON.parse(fs.readFileSync(path.join(ws, ".desktop-seed.json"), "utf8")) || {};
  } catch { return {}; }
}

function copySpawn(fromRoot, toDir, { skipExisting = false } = {}) {
  for (const dir of SPAWN_DIRS) {
    const from = path.join(fromRoot, dir);
    if (fs.existsSync(from)) fs.cpSync(from, path.join(toDir, dir), { recursive: true, force: true });
  }
  fs.mkdirSync(path.join(toDir, "config"), { recursive: true });
  for (const f of SPAWN_CONFIG_FILES) {
    const from = path.join(fromRoot, "config", f);
    const to = path.join(toDir, "config", f);
    if (!fs.existsSync(from)) continue;
    if (skipExisting && fs.existsSync(to)) continue;
    fs.copyFileSync(from, to);
  }
  for (const f of SPAWN_FILES) {
    const from = path.join(fromRoot, f);
    const to = path.join(toDir, f);
    if (!fs.existsSync(from)) continue;
    if (skipExisting && USER_OWNED.has(f) && fs.existsSync(to)) continue;
    fs.copyFileSync(from, to);
  }
}

function writeSeedMarker(ws, extra = {}) {
  fs.writeFileSync(path.join(ws, ".desktop-seed.json"), JSON.stringify({
    version: app.getVersion(), seededAt: new Date().toISOString(), source: APP_ROOT, ...extra,
  }, null, 2));
}

function seedWorkspace(ws) {
  const hasCode = fs.existsSync(path.join(ws, "bin", "ppx-web.js"));
  const marker = readSeedMarker(ws);
  const version = app.getVersion();

  if (!hasCode) {
    const tmp = ws + ".seeding";
    fs.rmSync(tmp, { recursive: true, force: true });
    fs.mkdirSync(tmp, { recursive: true });
    copySpawn(APP_ROOT, tmp);
    fs.mkdirSync(path.join(tmp, "uploads"), { recursive: true });
    writeSeedMarker(tmp);
    // 播种目录整体替换, 避免半成品被当成已完成
    fs.rmSync(ws, { recursive: true, force: true });
    fs.renameSync(tmp, ws);
    log(`工作副本已播种: ${ws} (v${version})`);
    return;
  }

  // 版本未变: 不动盘 (尊重用户自改后的代码)
  if (marker.version === version) return;

  // 版本升级: 备份旧代码+配置, 再覆盖代码; 数据与用户配置保留
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const backup = `${ws}.backup-${marker.version || "unknown"}-${stamp}`;
  try {
    fs.mkdirSync(backup, { recursive: true });
    for (const dir of UPGRADE_BACKUP_DIRS) {
      const from = path.join(ws, dir);
      if (fs.existsSync(from)) fs.cpSync(from, path.join(backup, dir), { recursive: true, force: true });
    }
    for (const f of SPAWN_FILES) {
      const from = path.join(ws, f);
      if (fs.existsSync(from)) fs.copyFileSync(from, path.join(backup, f));
    }
    copySpawn(APP_ROOT, ws, { skipExisting: true });
    fs.mkdirSync(path.join(ws, "uploads"), { recursive: true });
    writeSeedMarker(ws, { upgradedFrom: marker.version || null, backup });
    log(`工作副本已升级: v${marker.version || "?"} → v${version}; 旧代码备份于 ${backup}`);
  } catch (e) {
    // 升级失败不阻断启动: 旧工作副本仍可运行, 错误留给日志排查
    log(`工作副本升级失败 (继续使用旧代码): ${e?.message || e}`);
  }
}

function resolveRoot() {
  const override = argOf("--root") || process.env.PPX_ROOT;
  if (override) return path.resolve(override);
  if (!app.isPackaged) return DEV_ROOT;
  const ws = path.join(app.getPath("userData"), "workspace");
  seedWorkspace(ws);
  return ws;
}

function configPort(root) {
  try {
    const p = path.join(root, "config", "ppx.json");
    if (fs.existsSync(p)) {
      const n = Number(JSON.parse(fs.readFileSync(p, "utf8"))?.channels?.http?.port);
      if (Number.isFinite(n) && n > 0) return n;
    }
  } catch { /* 配置缺失/损坏 → 默认端口 */ }
  return 8899;
}

// ---- 端口探测 ----
// 2026-10-30: 不再只看 /health.app 字符串 —— 本机任何服务都能返回同名 JSON。
//   端口上跑的是不是"我们拉起的那个内核", 用一次性密钥的 HMAC 挑战应答证明。
function probe(port, timeout = 1200, secret = DESKTOP_SECRET) {
  return new Promise((resolve) => {
    const challenge = crypto.randomBytes(16).toString("hex");
    const req = http.get({
      host: "127.0.0.1", port, path: "/health", timeout,
      headers: { "x-ppx-desktop-challenge": challenge },
    }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (c) => { body += c; });
      res.on("end", () => {
        try {
          const j = JSON.parse(body);
          if (secret && res.headers["x-ppx-desktop-proof"]) {
            const want = crypto.createHmac("sha256", secret).update(challenge).digest("hex");
            const got = String(res.headers["x-ppx-desktop-proof"]);
            const a = Buffer.from(want), b = Buffer.from(got);
            j.__verified = a.length === b.length && crypto.timingSafeEqual(a, b);
          }
          resolve(j);
        } catch { resolve(null); }
      });
    });
    req.on("error", () => resolve(null));
    req.on("timeout", () => { req.destroy(); resolve(null); });
  });
}

function portFree(port) {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.once("error", () => resolve(false));
    srv.once("listening", () => srv.close(() => resolve(true)));
    srv.listen(port, "127.0.0.1");
  });
}

async function pickPort(preferred) {
  const health = await probe(preferred);
  if (health?.app === "ppxans-harness" && health.__verified) {
    log(`端口 ${preferred} 已有本实例验证通过的服务, 直接接入`);
    return { port: preferred, owned: false };
  }
  if (health?.app === "ppxans-harness" && !health.__verified) {
    log(`端口 ${preferred} 上有同名但未通过握手验证的服务, 不复用 (避免接入伪造/旧实例)`);
  }
  if (await portFree(preferred)) return { port: preferred, owned: true };
  for (let p = preferred + 1; p <= preferred + 30; p++) {
    if (await portFree(p)) {
      log(`端口 ${preferred} 被占用, 改用 ${p}`);
      return { port: p, owned: true };
    }
  }
  throw new Error(`端口 ${preferred} 及后续 30 个端口均不可用`);
}

// ---- 服务子进程 ----
function openLog() {
  try {
    const dir = path.join(app.getPath("userData"), "logs");
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `server-${new Date().toISOString().slice(0, 10)}.log`);
    if (fs.existsSync(file) && fs.statSync(file).size > 5 * 1024 * 1024) fs.truncateSync(file, 0);
    logStream = fs.createWriteStream(file, { flags: "a" });
  } catch { /* 日志不可写不阻塞启动 */ }
}

function startServer(root, port) {
  openLog();
  const env = {
    ...process.env,
    ELECTRON_RUN_AS_NODE: "1",
    PPX_ROOT: root,
    PPX_DESKTOP: "1",
    PPX_DESKTOP_SECRET: DESKTOP_SECRET,
  };
  delete env.ELECTRON_NO_ATTACH_CONSOLE;
  const child = spawn(process.execPath, [
    path.join(root, "bin", "ppx-web.js"), "--no-open", "--root", root, "--port", String(port),
  ], {
    env,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
    // POSIX: 独立进程组, 退出时能一次回收内核派生的工具子进程
    detached: process.platform !== "win32",
  });

  const pipe = (stream, tag) => {
    stream.setEncoding("utf8");
    let buf = "";
    stream.on("data", (chunk) => {
      buf += chunk;
      let i;
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i).trimEnd();
        buf = buf.slice(i + 1);
        if (line) log(`[${tag}] ${line}`);
      }
    });
  };
  pipe(child.stdout, "svc");
  pipe(child.stderr, "svc!");

  child.on("exit", (code, sig) => {
    if (serverChild === child) serverChild = null;
    if (quitting) return;
    if (serverOwned && booted) onServerGone(code ?? sig);
  });
  return child;
}

async function waitReady(port, timeoutMs = 60000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const h = await probe(port, 800);
    if (h?.app === "ppxans-harness") return true;
    if (serverOwned && !serverChild) return false;
    await new Promise((r) => setTimeout(r, 300));
  }
  return false;
}

// ---- 窗口 ----
function loadState() {
  try {
    const s = JSON.parse(fs.readFileSync(path.join(app.getPath("userData"), "window-state.json"), "utf8"));
    if (Number.isFinite(s.width) && Number.isFinite(s.height)) return s;
  } catch { /* 首次启动 */ }
  return { width: 1280, height: 860 };
}

function saveState() {
  if (!win || win.isDestroyed()) return;
  try {
    const b = win.getNormalBounds();
    fs.writeFileSync(path.join(app.getPath("userData"), "window-state.json"), JSON.stringify({
      x: b.x, y: b.y, width: b.width, height: b.height, maximized: win.isMaximized(),
    }));
  } catch { /* 状态记忆失败不致命 */ }
}

function withinDisplays(s) {
  if (!Number.isFinite(s.x) || !Number.isFinite(s.y)) return false;
  return screen.getAllDisplays().some((d) => {
    const a = d.workArea;
    return s.x >= a.x - 40 && s.y >= a.y - 40 && s.x < a.x + a.width - 120 && s.y < a.y + a.height - 80;
  });
}

function isAppUrl(url) {
  if (!appUrl) return false;
  return url === appUrl || url.startsWith(appUrl);
}

function createWindow() {
  const st = loadState();
  win = new BrowserWindow({
    ...(withinDisplays(st) ? { x: st.x, y: st.y } : {}),
    width: st.width,
    height: st.height,
    minWidth: 960,
    minHeight: 640,
    show: false,
    title: APP_NAME,
    icon: ICON,
    backgroundColor: "#0b0b0a",
    autoHideMenuBar: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
      devTools: !app.isPackaged || process.env.PPX_DESKTOP_DEVTOOLS === "1",
    },
  });
  if (st.maximized) win.maximize();
  win.once("ready-to-show", () => { if (!SMOKE) win.show(); });
  win.on("close", saveState);
  win.on("closed", () => { win = null; });

  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url) && !isAppUrl(url)) shell.openExternal(url);
    return { action: "deny" };
  });
  win.webContents.on("will-navigate", (e, url) => {
    if (!isAppUrl(url)) {
      e.preventDefault();
      if (/^https?:/i.test(url)) shell.openExternal(url);
    }
  });
  win.webContents.on("render-process-gone", (_e, details) => {
    if (quitting) return;
    log("渲染进程异常退出", details);
    dialog.showMessageBox(win ?? undefined, {
      type: "error", title: APP_NAME, message: "界面进程异常退出", detail: "重新加载窗口即可恢复。",
      buttons: ["重新加载", "退出"], defaultId: 0, cancelId: 1,
    }).then((r) => { if (r.response === 0 && win && !win.isDestroyed()) win.reload(); else app.quit(); });
  });

  win.loadFile(path.join(APP_ROOT, "electron", "loading.html"));
  return win;
}

function setStatus(text) {
  if (!win || win.isDestroyed()) return;
  win.webContents.executeJavaScript(
    `(() => { const el = document.getElementById("status"); if (el) el.textContent = ${JSON.stringify(text)}; })()`
  ).catch(() => {});
}

async function showFailure(title, detail) {
  log(`启动失败: ${title} — ${detail}`);
  if (win && !win.isDestroyed()) {
    await win.webContents.executeJavaScript(
      `(() => { document.body.classList.add("failed"); const t = document.getElementById("title"); const s = document.getElementById("status");
        if (t) t.textContent = ${JSON.stringify(title)}; if (s) s.textContent = ${JSON.stringify(detail)}; })()`
    ).catch(() => {});
  }
  if (SMOKE) { quitting = true; killServer(); app.exit(1); return; }
  const r = await dialog.showMessageBox(win ?? undefined, {
    type: "error", title: APP_NAME, message: title, detail,
    buttons: ["重试", "退出"], defaultId: 0, cancelId: 1,
  });
  if (r.response === 0) { app.relaunch(); app.quit(); } else app.quit();
}

function onServerGone(code) {
  dialog.showMessageBox(win ?? undefined, {
    type: "error", title: APP_NAME,
    message: "内核服务已退出",
    detail: `退出码: ${code ?? "未知"}。可查看日志定位原因。`,
    buttons: ["重启服务", "查看日志", "退出"], defaultId: 0, cancelId: 2,
  }).then((r) => {
    if (r.response === 0) { app.relaunch(); app.quit(); }
    else if (r.response === 1) shell.openPath(path.join(app.getPath("userData"), "logs"));
    else app.quit();
  });
}

// ---- 权限: 只放行本应用窗口的麦克风/通知 ----
function hardenSession() {
  const allowed = new Set(["media", "notifications", "clipboard-sanitized-write", "fullscreen", "pointerLock"]);
  session.defaultSession.setPermissionRequestHandler((wc, permission, cb, details) => {
    if (!isAppUrl(wc.getURL()) || !allowed.has(permission)) return cb(false);
    if (permission === "media" && (details?.mediaTypes || []).includes("video")) return cb(false);
    cb(true);
  });
  session.defaultSession.setPermissionCheckHandler((_wc, permission, origin) => {
    const ok = origin === appUrl || origin === appUrl.replace(/\/$/, "");
    return ok && allowed.has(permission);
  });
}

// ---- 菜单 ----
function buildMenu(root) {
  const isDev = !app.isPackaged;
  const template = [
    {
      label: "应用",
      submenu: [
        { label: "打开工作副本目录", click: () => shell.openPath(root) },
        { label: "打开日志目录", click: () => shell.openPath(path.join(app.getPath("userData"), "logs")) },
        { label: "复制面板地址", click: () => appUrl && clipboard.writeText(appUrl) },
        { type: "separator" },
        {
          label: "重置工作副本…",
          click: async () => {
            const r = await dialog.showMessageBox(win ?? undefined, {
              type: "warning", title: APP_NAME,
              message: "重置工作副本？",
              detail: "当前工作副本会备份到同目录的 workspace.backup-<时间>，然后用内置版本重新播种。数据目录 (data/uploads/config/ppx.json) 会保留。",
              buttons: ["取消", "重置并重启"], defaultId: 0, cancelId: 0,
            });
            if (r.response !== 1) return;
            try {
              const backup = `${root}.backup-${Date.now()}`;
              fs.renameSync(root, backup);
              const tmp = `${root}.seeding`;
              fs.rmSync(tmp, { recursive: true, force: true });
              fs.mkdirSync(tmp, { recursive: true });
              for (const dir of SPAWN_DIRS) {
                const from = path.join(APP_ROOT, dir);
                if (fs.existsSync(from)) fs.cpSync(from, path.join(tmp, dir), { recursive: true });
              }
              for (const file of SPAWN_FILES) {
                const from = path.join(APP_ROOT, file);
                if (fs.existsSync(from)) fs.cpSync(from, path.join(tmp, file));
              }
              for (const keep of ["data", "uploads", ".ppx", "config/ppx.json", "PPX.md"]) {
                const from = path.join(backup, keep);
                if (fs.existsSync(from)) fs.cpSync(from, path.join(tmp, keep), { recursive: true });
              }
              fs.renameSync(tmp, root);
              log(`工作副本已重置, 备份: ${backup}`);
            } catch (e) {
              dialog.showErrorBox(APP_NAME, `重置失败: ${e.message}`);
              return;
            }
            quitting = true;
            killServer();
            app.relaunch();
            app.quit();
          },
        },
        { type: "separator" },
        { label: "退出", accelerator: "Alt+F4", click: () => app.quit() },
      ],
    },
    {
      label: "编辑",
      submenu: [
        { role: "undo", label: "撤销" }, { role: "redo", label: "重做" }, { type: "separator" },
        { role: "cut", label: "剪切" }, { role: "copy", label: "复制" }, { role: "paste", label: "粘贴" },
        { role: "selectAll", label: "全选" },
      ],
    },
    {
      label: "视图",
      submenu: [
        { role: "reload", label: "重新加载" }, { role: "forceReload", label: "强制重新加载" },
        { type: "separator" },
        { role: "resetZoom", label: "实际大小" }, { role: "zoomIn", label: "放大" }, { role: "zoomOut", label: "缩小" },
        { type: "separator" },
        { role: "togglefullscreen", label: "全屏" },
        ...(isDev ? [{ type: "separator" }, { role: "toggleDevTools", label: "开发者工具" }] : []),
      ],
    },
    {
      label: "帮助",
      submenu: [
        { label: `关于 ${APP_NAME}`, click: () => dialog.showMessageBox(win ?? undefined, {
          type: "info", title: `关于 ${APP_NAME}`, message: `${APP_NAME} ${app.getVersion()}`,
          detail: `PPXANS-Harness 桌面端\n工作副本: ${root}\n内核地址: ${appUrl || "(启动中)"}`,
        }) },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// ---- 生命周期 ----
// Windows 上 child.kill() 只结束直接子进程, 内核派生的工具子进程会变成孤儿继续跑。
// 用 taskkill /T 结束整棵进程树; POSIX 用进程组 (spawn 时 detached) 兜底。
function killServerTree({ graceful = false } = {}) {
  const child = serverChild;
  if (!child || child.killed) { serverChild = null; return; }
  const pid = child.pid;
  serverChild = null;
  if (process.platform === "win32") {
    const r = spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
    if (r.error) { try { child.kill(); } catch { /* 已退出 */ } }
    return;
  }
  try {
    process.kill(-pid, graceful ? "SIGTERM" : "SIGKILL");
  } catch {
    try { child.kill(graceful ? "SIGTERM" : "SIGKILL"); } catch { /* 已退出 */ }
  }
}

function killServer() {
  killServerTree();
}

async function boot() {
  createWindow();
  const root = resolveRoot();
  const preferred = Number(argOf("--port") || process.env.PPX_PORT || 0) || configPort(root);
  const { port, owned } = await pickPort(preferred);
  serverOwned = owned;
  appUrl = `http://127.0.0.1:${port}/`;
  log(`启动桌面端 root=${root} url=${appUrl} owned=${owned}`);

  if (owned) {
    setStatus("正在启动内核服务…");
    serverChild = startServer(root, port);
  }
  const ok = await waitReady(port);
  if (!ok) {
    return showFailure("内核服务启动失败", "服务未在 60 秒内就绪。请查看日志目录了解详情。");
  }

  hardenSession();
  buildMenu(root);
  booted = true;
  setStatus("正在加载界面…");
  await win.loadURL(appUrl);

  if (SMOKE) {
    const out = process.env.PPX_DESKTOP_SMOKE_OUT || path.join(app.getPath("userData"), "smoke.png");
    setTimeout(async () => {
      try {
        const img = await win.webContents.capturePage();
        fs.writeFileSync(out, img.toPNG());
        log(`smoke 截图: ${out}`);
        app.quit();
      } catch (e) {
        log(`smoke 失败: ${e.message}`);
        quitting = true;
        killServer();
        app.exit(1);
      }
    }, 3000);
  }

  // 2026-10-31 (队列⑤): 桌面端更新检查 —— 查 GitHub Releases latest tag, 24h TTL 缓存
  //   (userData/update-check.json), 有新版弹系统通知, 点击打开下载页。只提示不代装:
  //   安装包未签名时静默自装会撞 SmartScreen, 且 electron-updater 是重依赖 (零依赖红线)。
  //   仅打包版检查 (dev 源码版走 git pull / ppx update); SMOKE 冒烟与 PPX_UPDATE_CHECK=0 跳过。
  if (app.isPackaged && !SMOKE && process.env.PPX_UPDATE_CHECK !== "0") {
    const { checkForUpdate, RELEASES_URL } = await import("../src/update/index.js");
    const check = await checkForUpdate({
      currentVersion: app.getVersion(),
      dataDir: app.getPath("userData"),
      channel: "github",
    }).catch(() => null);
    if (check && check.ok && check.updateAvailable) {
      try {
        const { Notification } = await import("electron");
        const n = new Notification({
          title: `皮皮虾有新版本 v${check.latest}`,
          body: `当前 v${check.current} — 点击前往下载页 (运行 ppx update 也可升级 CLI)`,
        });
        n.on("click", () => shell.openExternal(RELEASES_URL));
        n.show();
      } catch (e) {
        log(`更新通知不可用: ${e.message}`);
      }
    }
  }
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (win) {
      if (win.isMinimized()) win.restore();
      win.show();
      win.focus();
    }
  });

  app.on("window-all-closed", () => app.quit());

  app.on("before-quit", (e) => {
    if (quitReady) return;
    quitting = true;
    saveState();
    // 自己拉起的服务: 先回收整棵进程树再退出, 给内核一点落盘时间 (最多 3 秒)
    if (serverOwned && serverChild && !serverChild.killed) {
      e.preventDefault();
      const child = serverChild;
      const finish = () => {
        if (quitReady) return;
        quitReady = true;
        app.quit();
      };
      const timer = setTimeout(finish, 3000);
      child.once("exit", () => { clearTimeout(timer); serverChild = null; finish(); });
      killServerTree({ graceful: true });
      return;
    }
    killServer();
  });

  app.whenReady().then(() => {
    if (SMOKE) {
      setTimeout(() => { log("smoke 超时"); quitting = true; killServer(); app.exit(1); }, 90000);
    }
    boot().catch((e) => showFailure("桌面端启动异常", String(e?.message || e)));
  });
}

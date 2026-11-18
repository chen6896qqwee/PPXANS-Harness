// electron/main.js — 皮皮虾桌面端主进程
//
// 职责边界: Electron 是唯一的用户入口; 内核以本地回环服务在应用内部运行,
//   端口与地址不对用户暴露 (无浏览器、无面板地址、无需手动起服务)。
//   1) 单实例: 重复启动只聚焦已有窗口
//   2) 工作副本: 打包版把内置代码播种到可写目录 (自改代码闭环需要可写 root)
//   3) 服务生命周期: 以 ELECTRON_RUN_AS_NODE 拉起子进程, 窗口关闭即回收
//   4) 桌面体验: 窗口状态记忆、启动页、菜单、麦克风权限、外链走系统浏览器
//
// 端口策略: 首选配置端口; 若已被本应用占用则直接接入; 否则向后找空闲端口。
//
// 结构 (2026-11-03 拆分): 纯函数域已拆到 app-meta / app-log / seed / server-proc /
//   update-flow / smoke / diagnostics; 本文件保留生命周期状态的唯一所有权
//   (win/tray/serverChild/quitting/quit 链…), 域模块经 ctx getter 借读, 不共享可变量。
//
// 环境变量:
//   PPX_ROOT          覆盖工作副本目录 (dev 默认仓库根, 打包版默认 userData/workspace)
//   PPX_PORT          覆盖首选端口
//   PPX_DESKTOP_SMOKE 1 = 冒烟模式: 不显示窗口, 加载后跑 DOM/API 断言, 截图并写 JSON 结果
//   PPX_DESKTOP_SMOKE_OUT 冒烟截图输出路径
//   PPX_DESKTOP_SMOKE_RESULT 冒烟结果 JSON 路径 (缺省 = 截图同目录 .result.json)
//   PPX_DESKTOP_USER_DATA 覆盖桌面 userData 目录 (冒烟/多实例测试隔离)
//   PPX_DATA_DIR 透传给内核, 隔离 data/ (冒烟脚本使用临时目录)
import { app, BrowserWindow, Menu, Tray, Notification, dialog, globalShortcut, nativeImage, shell, session, screen } from "electron";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { readPrefs, setPref } from "../src/services/desktop/prefs.js";
import { APP_ROOT, APP_NAME, APP_DATA_HOME, DEV_ROOT, ICON, SMOKE, UI_CAPTURE } from "./app-meta.js";
import { log } from "./app-log.js";
import { seedWorkspace, resetWorkspace } from "./seed.js";
import { createWindowState, isAppUrl } from "./window-state.js";
import { configPort, pickPort, requestGracefulShutdown, createServerProc, probe, desktopSecret } from "./server-proc.js";
import { createLivenessSupervisor } from "./liveness.js";
import { createUpdateFlow } from "./update-flow.js";
import { smokeErrors, createSmoke } from "./smoke.js";
import { createDiagnostics } from "./diagnostics.js";
import { createUiCapture } from "./ui-capture.js";

app.setPath("userData", process.env.PPX_DESKTOP_USER_DATA
  ? path.resolve(process.env.PPX_DESKTOP_USER_DATA)
  : path.join(APP_DATA_HOME, "PPXANS-Harness-Desktop"));

// 任务栏分组与通知归属 (Windows)
if (process.platform === "win32") app.setAppUserModelId("com.ppxans.harness");

let win = null;
let tray = null;
let prefs = readPrefs(path.join(app.getPath("userData"), "desktop-prefs.json"));
const windowState = createWindowState({ app, screen });
let currentRoot = "";
let trayHintShown = false;
let serverChild = null;
let serverOwned = false;
let serverPort = 0;
let renderService = null; // 桌面渲染服务 (v5.0: browse 工具的 Chromium 通道)
let appUrl = "";
let booted = false;
let quitting = false;
let quitReady = false;
let quitPending = false; // 优雅退出链已启动 (before-quit 可能因 window-all-closed 再次进入)

// 域模块接线: 状态所有权在本文件, 域模块经 ctx 借读 (getter, 不持有引用)
const serverProc = createServerProc({
  isQuitting: () => quitting,
  isBooted: () => booted,
  isOwned: () => serverOwned,
  getServerChild: () => serverChild,
  setServerChild: (c) => { serverChild = c; },
  onGone: (...a) => onServerGone(...a),
});

// 外部存活监督 (2026-11-05): 跑在主进程 —— agent 进程死掉后它仍活着, 负责自动拉起。
//   探活覆盖"进程在但服务卡死"; 指数退避 + 5 分钟窗口最多 3 次, 超限才交回人工对话框。
const liveness = createLivenessSupervisor({
  probe: () => probe(serverPort, 1200),
  restart: restartServer,
  onExhausted: (reason) => showServerGoneDialog(reason),
  onEvent: (type, payload) => log(`[supervisor] ${type} ${JSON.stringify(payload || {})}`),
  isQuitting: () => quitting,
});

function killServer() {
  liveness.stop();
  serverProc.killServerTree();
}

const { checkForUpdatesInteractive, promptUpdate } = createUpdateFlow({
  getWin: () => win,
  notify,
  setQuitting: (v) => { quitting = v; },
});

const { runSmoke } = createSmoke({
  getWin: () => win,
  getServerPort: () => serverPort,
  getAppUrl: () => appUrl,
  killServer,
  setQuitting: (v) => { quitting = v; },
});

const { exportDiagnostics } = createDiagnostics({
  getWin: () => win,
  getRoot: () => currentRoot,
  getServerPort: () => serverPort,
});

const { runUiCapture } = createUiCapture({
  getWin: () => win,
  getServerPort: () => serverPort,
  getAppUrl: () => appUrl,
  killServer,
  setQuitting: (v) => { quitting = v; },
});

function argOf(name) {
  const argv = process.argv.slice(2);
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : "";
}

function resolveRoot() {
  const override = argOf("--root") || process.env.PPX_ROOT;
  if (override) return path.resolve(override);
  if (!app.isPackaged) return DEV_ROOT;
  const ws = path.join(app.getPath("userData"), "workspace");
  seedWorkspace(ws);
  return ws;
}

// ---- 桌面常驻 (2026-11-03): 托盘 / 自启 / 全局热键 / 通知 ----
function prefsFile() {
  return path.join(app.getPath("userData"), "desktop-prefs.json");
}

function showWindow() {
  if (!win || win.isDestroyed()) return;
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

function toggleWindow() {
  if (!win || win.isDestroyed()) return;
  if (win.isVisible() && win.isFocused()) win.hide();
  else showWindow();
}

function notify(title, body, onClick) {
  try {
    if (!Notification.isSupported()) return null;
    const n = new Notification({ title, body, icon: ICON });
    if (onClick) n.on("click", onClick);
    n.show();
    return n;
  } catch (e) {
    log(`系统通知失败: ${e?.message || e}`);
    return null;
  }
}

function applyLoginItem(enabled) {
  try {
    if (process.platform === "linux") {
      const dir = path.join(os.homedir(), ".config", "autostart");
      const file = path.join(dir, "ppxans-harness.desktop");
      if (!enabled) { fs.rmSync(file, { force: true }); return; }
      const devArg = app.isPackaged ? "" : ` "${path.join(APP_ROOT, "electron", "main.js").replace(/"/g, '\\"')}"`;
      const exec = `"${process.execPath.replace(/"/g, '\\"')}"${devArg}`;
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(file, [
        "[Desktop Entry]",
        "Type=Application",
        `Name=${APP_NAME}`,
        `Exec=${exec}`,
        "X-GNOME-Autostart-enabled=true",
        "Terminal=false",
        "",
      ].join("\n"));
      return;
    }
    app.setLoginItemSettings({
      openAtLogin: Boolean(enabled),
      openAsHidden: true,
      path: process.execPath,
      args: app.isPackaged ? [] : [path.join(APP_ROOT, "electron", "main.js")],
    });
  } catch (e) {
    log(`开机自启设置失败: ${e?.message || e}`); // swallowed-ok(2026-11-03): 已 log 记录
  }
}

function registerHotkey() {
  try { globalShortcut.unregisterAll(); } catch { /* 未注册 */ }
  if (!prefs.hotkeyEnabled || !prefs.globalHotkey) return;
  try {
    const ok = globalShortcut.register(prefs.globalHotkey, toggleWindow);
    if (!ok) log(`全局快捷键注册失败 (可能被占用): ${prefs.globalHotkey}`);
  } catch (e) {
    log(`全局快捷键注册异常: ${e?.message || e}`);
  }
}

function updatePref(key, value) {
  prefs = setPref(prefsFile(), prefs, key, value);
  if (key === "launchAtLogin") applyLoginItem(prefs.launchAtLogin);
  if (key === "hotkeyEnabled" || key === "globalHotkey") registerHotkey();
  if (currentRoot) buildMenu(currentRoot);
  refreshTrayMenu();
}

function newChat() {
  showWindow();
  if (!win || win.isDestroyed()) return;
  win.webContents.executeJavaScript(
    `(() => { const b = document.getElementById("btnNew"); if (b && b.offsetParent !== null) b.click(); })()`
  ).catch(() => {});
}

function refreshTrayMenu() {
  if (!tray || tray.isDestroyed()) return;
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: "显示皮皮虾", click: showWindow },
    { label: "新建对话", click: newChat },
    { type: "separator" },
    { label: "检查更新…", click: () => { checkForUpdatesInteractive().catch((e) => log(`检查更新失败: ${e?.message || e}`)); } },
    { label: "打开日志目录", click: () => shell.openPath(path.join(app.getPath("userData"), "logs")) },
    { type: "separator" },
    { label: "退出", click: () => app.quit() },
  ]));
}

function createTray() {
  if (SMOKE) return;
  try {
    let img = nativeImage.createFromPath(path.join(APP_ROOT, "electron", "icon.png"));
    if (img.isEmpty()) {
      log("托盘图标缺失, 跳过托盘");
      return;
    }
    if (process.platform !== "darwin") img = img.resize({ width: 16, height: 16 });
    tray = new Tray(img);
    tray.setToolTip(APP_NAME);
    tray.on("click", toggleWindow);
    tray.on("double-click", showWindow);
    refreshTrayMenu();
  } catch (e) {
    log(`托盘创建失败: ${e?.message || e}`);
  }
}

function createWindow() {
  const st = windowState.load();
  win = new BrowserWindow({
    // UI 截图回合: 固定 x/y≈40 的可见窗口 (隐藏窗口 capturePage 会拿到过期帧)
    ...(UI_CAPTURE ? { x: 40, y: 40 } : (windowState.withinDisplays(st) ? { x: st.x, y: st.y } : {})),
    width: st.width,
    height: st.height,
    minWidth: 960,
    minHeight: 640,
    show: false,
    title: APP_NAME,
    icon: ICON,
    backgroundColor: "#0b0b0a",
    autoHideMenuBar: true,
    skipTaskbar: SMOKE || UI_CAPTURE,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
      devTools: !app.isPackaged || process.env.PPX_DESKTOP_DEVTOOLS === "1",
    },
  });
  if (st.maximized && !UI_CAPTURE) win.maximize();
  win.once("ready-to-show", () => { if (!SMOKE || UI_CAPTURE) win.show(); });
  win.on("close", (e) => {
    windowState.save(win);
    if (quitting || !prefs.closeToTray) return;
    e.preventDefault();
    win.hide();
    if (!trayHintShown) {
      trayHintShown = true;
      notify("皮皮虾仍在后台运行", "点击托盘图标或按全局快捷键恢复窗口；从菜单可退出。", showWindow);
    }
  });
  win.on("closed", () => { win = null; });

  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url) && !isAppUrl(url, appUrl)) shell.openExternal(url);
    return { action: "deny" };
  });
  win.webContents.on("will-navigate", (e, url) => {
    if (!isAppUrl(url, appUrl)) {
      e.preventDefault();
      if (/^https?:/i.test(url)) shell.openExternal(url);
    }
  });
  // 冒烟/截图: 收集渲染进程的 error/warning 与加载失败 (只看截图不够 ——
  //   白屏也能截出一张纯色图)。仅 SMOKE/UI_CAPTURE 模式挂监听, 正常桌面运行零开销。
  if (SMOKE || UI_CAPTURE) {
    win.webContents.on("console-message", (_e, level, message, line, sourceId) => {
      if (level >= 2) smokeErrors.push({ level, message: String(message).slice(0, 500), line: line || 0, source: String(sourceId || "") });
    });
    win.webContents.on("did-fail-load", (_e, code, desc, url) => {
      smokeErrors.push({ level: 3, message: `did-fail-load ${code} ${desc} ${url}` });
    });
  }
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

async function restartServer() {
  if (!serverOwned || quitting) return false;
  try {
    setStatus("内核服务重启中…");
    serverChild = serverProc.startServer(currentRoot, serverPort);
    const ok = await serverProc.waitReady(serverPort);
    if (!ok) return false;
    if (win && !win.isDestroyed()) {
      try { await win.loadURL(appUrl); } catch { try { win.reload(); } catch { /* 窗口已销毁 */ } }
    }
    setStatus("已恢复");
    return true;
  } catch (e) {
    log(`内核服务重启失败: ${e?.message || e}`);
    return false;
  }
}

// 自动重启次数耗尽 (或非本实例拥有的服务) 才回到人工处置
function showServerGoneDialog(code) {
  dialog.showMessageBox(win ?? undefined, {
    type: "error", title: APP_NAME,
    message: "内核服务已退出",
    detail: `退出码: ${code ?? "未知"}；自动重启多次未恢复。可查看日志定位原因。`,
    buttons: ["重启应用", "查看日志", "退出"], defaultId: 0, cancelId: 2,
  }).then((r) => {
    if (r.response === 0) { app.relaunch(); app.quit(); }
    else if (r.response === 1) shell.openPath(path.join(app.getPath("userData"), "logs"));
    else app.quit();
  });
}

function onServerGone(code) {
  if (quitting) return;
  liveness.noteGone(code).catch((e) => log(`监督重启异常: ${e?.message || e}`));
}

// ---- 权限: 只放行本应用窗口的麦克风/通知 ----
function hardenSession() {
  const allowed = new Set(["media", "notifications", "clipboard-sanitized-write", "fullscreen", "pointerLock"]);
  session.defaultSession.setPermissionRequestHandler((wc, permission, cb, details) => {
    // appUrl 必须显式传入: 少传时 isAppUrl 一律 false, 麦克风/通知会被全部拒掉。
    if (!isAppUrl(wc.getURL(), appUrl) || !allowed.has(permission)) return cb(false);
    if (permission === "media" && (details?.mediaTypes || []).includes("video")) return cb(false);
    cb(true);
  });
  session.defaultSession.setPermissionCheckHandler((_wc, permission, origin) => {
    const ok = isAppUrl(origin, appUrl);
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
        { label: "显示窗口", click: showWindow },
        { label: "新建对话", click: newChat },
        { type: "separator" },
        { label: "关闭时隐藏到托盘", type: "checkbox", checked: prefs.closeToTray, click: (item) => updatePref("closeToTray", item.checked) },
        { label: "开机自启", type: "checkbox", checked: prefs.launchAtLogin, click: (item) => updatePref("launchAtLogin", item.checked) },
        { label: `全局快捷键 (${prefs.globalHotkey})`, type: "checkbox", checked: prefs.hotkeyEnabled, click: (item) => updatePref("hotkeyEnabled", item.checked) },
        { type: "separator" },
        { label: "检查更新…", click: () => { checkForUpdatesInteractive().catch((e) => log(`检查更新失败: ${e?.message || e}`)); } },
        { label: "导出诊断包…", click: () => { exportDiagnostics().catch((e) => log(`诊断导出失败: ${e?.message || e}`)); } },
        { type: "separator" },
        { label: "打开工作副本目录", click: () => shell.openPath(root) },
        { label: "打开日志目录", click: () => shell.openPath(path.join(app.getPath("userData"), "logs")) },
        { type: "separator" },
        {
          label: "重置工作副本…",
          click: () => {
            resetWorkspace({ root, win, onBeforeRelaunch: () => { quitting = true; killServer(); } })
              .catch((e) => log(`重置失败: ${e?.message || e}`));
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
          detail: `PPXANS-Harness 桌面端\n工作副本: ${root}`,
        }) },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

async function boot() {
  createWindow();
  const root = resolveRoot();
  currentRoot = root;
  if (prefs.launchAtLogin) applyLoginItem(true);
  registerHotkey();
  createTray();
  const preferred = Number(argOf("--port") || process.env.PPX_PORT || 0) || configPort(root);
  const { port, owned } = await pickPort(preferred);
  serverOwned = owned;
  serverPort = port;
  appUrl = `http://127.0.0.1:${port}/`;
  log(`启动桌面端 root=${root} url=${appUrl} owned=${owned}`);

  if (owned) {
    setStatus("正在启动内核服务…");
    // 桌面渲染服务 (v5.0 P2.3): browse 工具的 Chromium 渲染通道 —— 端口经环境变量
    // 传给内核子进程 (server-proc 的 env 透传 process.env)。失败不阻断启动 (browse 退直抓)。
    try {
      const { startRenderService } = await import("./render-svc.js");
      const svc = await startRenderService({ secret: desktopSecret() });
      if (svc) {
        renderService = svc;
        process.env.PPX_DESKTOP_RENDER_PORT = String(svc.port);
      }
    } catch (e) {
      log(`[render] 渲染服务启动失败 (browse 将退化为直抓): ${e?.message || e}`);
    }
    serverChild = serverProc.startServer(root, port);
  }
  const ok = await serverProc.waitReady(port);
  if (!ok) {
    return showFailure("内核服务启动失败", "服务未在 60 秒内就绪。请查看日志目录了解详情。");
  }

  hardenSession();
  buildMenu(root);
  booted = true;
  if (owned) liveness.startProbeLoop();
  setStatus("正在加载界面…");
  await win.loadURL(appUrl);

  if (SMOKE) {
    // 给前端首屏请求留出时间; runSmoke 内部还会轮询一级导航渲染 直到完成/8s 超时
    setTimeout(() => { runSmoke().catch((e) => { log(`smoke 失败: ${e.message}`); quitting = true; killServer(); app.exit(1); }); }, 1500);
  }
  if (UI_CAPTURE && !SMOKE) {
    setTimeout(() => {
      runUiCapture().then(({ shots, errors }) => {
        log(`ui-capture 完成: ${shots.length} 帧, ${errors.length} 个错误`);
      }).catch((e) => { log(`ui-capture 失败: ${e.message}`); quitting = true; killServer(); app.exit(1); });
    }, 1500);
  }

  // 桌面端更新检查: 查 GitHub Releases latest tag, 24h TTL 缓存; 有新版弹系统通知,
  //   点击进入"下载 → SHA-256 校验 → 启动安装器"流程。启动检查只提示, 不静默安装。
  //   仅打包版检查 (dev 源码版走 git pull / ppx update); SMOKE 冒烟与 PPX_UPDATE_CHECK=0 跳过。
  if (app.isPackaged && !SMOKE && process.env.PPX_UPDATE_CHECK !== "0") {
    const { checkForUpdate } = await import("../src/services/update.js");
    const check = await checkForUpdate({
      currentVersion: app.getVersion(),
      dataDir: app.getPath("userData"),
      channel: "github",
    }).catch(() => null);
    if (check && check.ok && check.updateAvailable) {
      notify(
        `皮皮虾有新版本 v${check.latest}`,
        `当前 v${check.current} — 点击查看更新`,
        () => { promptUpdate(check).catch((e) => log(`更新流程失败: ${e?.message || e}`)); }
      );
    }
  }
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", () => showWindow());
  app.on("activate", () => showWindow());

  app.on("window-all-closed", () => app.quit());

  app.on("will-quit", () => {
    try { globalShortcut.unregisterAll(); } catch { /* 未注册 */ }
    try { tray?.destroy(); } catch { /* 已销毁 */ }
    tray = null;
    try { renderService?.close?.(); renderService = null; } catch { /* 已关 */ }
  });

  app.on("before-quit", (e) => {
    if (quitReady) return;
    quitting = true;
    windowState.save(win);
    // 自己拉起的服务: 先请内核优雅收口 (记忆落盘/军团回收/投递队列), 超时才强制结束进程树。
    // 2026-11-02: Windows 原先这里直接 taskkill /F, 内核收不到任何退出信号, shutdown 链被跳过。
    if (serverOwned && serverChild && !serverChild.killed) {
      e.preventDefault();
      if (quitPending) return; // 退出链已在跑, 重复的 before-quit 只取消本次 quit
      quitPending = true;
      const child = serverChild;
      let hardTimer = null;
      let finishTimer = null;
      const finish = () => {
        if (quitReady) return;
        quitReady = true;
        quitPending = false;
        if (hardTimer) clearTimeout(hardTimer);
        if (finishTimer) clearTimeout(finishTimer);
        app.quit();
      };
      finishTimer = setTimeout(finish, 4000);
      hardTimer = setTimeout(() => {
        if (quitReady) return;
        log("优雅退出超时, 强制结束内核进程树");
        serverProc.killServerTree();
      }, 2800);
      child.once("exit", () => { serverChild = null; finish(); });
      requestGracefulShutdown(serverPort).then((accepted) => {
        if (!accepted && !quitReady) {
          // 旧内核没有该端点 / 请求失败: 留一点响应时间后走硬杀兜底
          setTimeout(() => { if (!quitReady) serverProc.killServerTree(); }, 200);
        }
      });
      return;
    }
    killServer();
  });

  app.whenReady().then(() => {
    if (SMOKE) {
      setTimeout(() => { log("smoke 超时"); quitting = true; killServer(); app.exit(1); }, 90000);
    }
    if (UI_CAPTURE && !SMOKE) {
      setTimeout(() => { log("ui-capture 超时"); quitting = true; killServer(); app.exit(1); }, 120000);
    }
    boot().catch((e) => showFailure("桌面端启动异常", String(e?.message || e)));
  });
}

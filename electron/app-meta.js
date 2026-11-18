// electron/app-meta.js — 桌面端应用级常量 (安装根/名称/图标/冒烟开关)
// 拆自 main.js (2026-11-03): seed/server-proc/update-flow 等域模块与主入口共用这些值,
//   常量必须有单一出处, 否则 APP_ROOT 的计算会在每个模块里各抄一份。
import { app } from "electron";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const DEV_ROOT = path.resolve(HERE, "..");
// 打包后 electron/main.js 位于 resources/app/electron/, 代码根是上一级
export const APP_ROOT = app.isPackaged ? path.join(process.resourcesPath, "app") : DEV_ROOT;
export const APP_NAME = "皮皮虾";

// 桌面端数据统一放"本机应用数据目录" (工作副本含代码, 不适合漫游):
//   Windows %LOCALAPPDATA% / macOS ~/Library/Application Support / Linux ~/.config
export const APP_DATA_HOME = process.platform === "win32"
  ? (process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local"))
  : app.getPath("appData");

export const SMOKE = process.env.PPX_DESKTOP_SMOKE === "1";
// UI 截图回合 (2026-11-18): 真实可见窗口 + executeJavaScript 驱动 + 逐帧 capturePage
export const UI_CAPTURE = process.env.PPX_UI_CAPTURE === "1";
export const ICON = path.join(APP_ROOT, "electron", process.platform === "win32" ? "icon.ico" : "icon.png");

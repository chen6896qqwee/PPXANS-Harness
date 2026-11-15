// src/services/desktop/prefs.js — 桌面端本地偏好 (2026-11-03; 2026-11-12 并入 services)
// 只放"用户可见、可离线读写"的桌面行为开关; 不碰内核配置 (config/ppx.json)。
// 文件损坏/字段非法一律回退默认值 —— 桌面偏好永远不应该阻止应用启动。
import fs from "node:fs";
import path from "node:path";
import { noteCatch } from "../../utils/catch-log.js";

const DEFAULT_HOTKEY = "CommandOrControl+Shift+Space";

export const DEFAULT_PREFS = Object.freeze({
  closeToTray: true,
  launchAtLogin: false,
  hotkeyEnabled: true,
  globalHotkey: DEFAULT_HOTKEY,
});

const MODIFIERS = new Set([
  "commandorcontrol", "cmdorctrl", "command", "cmd", "control", "ctrl",
  "alt", "option", "shift", "super", "meta",
]);
const NAMED_KEYS = new Set([
  "space", "tab", "enter", "return", "escape", "esc", "backspace", "delete", "insert",
  "home", "end", "pageup", "pagedown", "up", "down", "left", "right",
  "plus", "minus", "comma", "period", "slash", "backslash", "semicolon", "quote",
  "bracketleft", "bracketright", "backquote",
]);

function normalizeKeyPart(part) {
  const p = String(part || "").trim();
  if (!p) return "";
  const low = p.toLowerCase();
  if (MODIFIERS.has(low)) {
    // Electron 接受的两种写法统一保留原样 (CommandOrControl / CmdOrCtrl)
    return p;
  }
  if (/^[a-z0-9]$/i.test(p)) return p.toUpperCase();
  if (/^f([1-9]|1[0-9]|2[0-4])$/i.test(p)) return p.toUpperCase();
  if (NAMED_KEYS.has(low)) return low.charAt(0).toUpperCase() + low.slice(1);
  return "";
}

// 只做"形状检查", 真正的可用性交给 globalShortcut.register 判断。
// 返回合法字符串或空串 (空串 = 不启用热键)。
export function normalizeHotkey(raw) {
  const s = String(raw || "").trim();
  if (!s || s.length > 64) return "";
  const parts = s.split("+").map((x) => x.trim()).filter(Boolean);
  if (parts.length < 2) return "";
  const key = normalizeKeyPart(parts[parts.length - 1]);
  if (!key) return "";
  const mods = [];
  for (const m of parts.slice(0, -1)) {
    const mm = normalizeKeyPart(m);
    if (!mm || !MODIFIERS.has(mm.toLowerCase())) return "";
    if (!mods.some((x) => x.toLowerCase() === mm.toLowerCase())) mods.push(mm);
  }
  if (!mods.length) return "";
  return [...mods, key].join("+");
}

function bool(v, fallback) {
  return typeof v === "boolean" ? v : fallback;
}

export function normalizePrefs(raw) {
  const src = raw && typeof raw === "object" ? raw : {};
  const hotkey = src.globalHotkey === undefined ? DEFAULT_PREFS.globalHotkey : normalizeHotkey(src.globalHotkey);
  const resolvedHotkey = hotkey || DEFAULT_PREFS.globalHotkey;
  const hotkeyEnabled = bool(src.hotkeyEnabled, DEFAULT_PREFS.hotkeyEnabled) && Boolean(resolvedHotkey);
  return {
    closeToTray: bool(src.closeToTray, DEFAULT_PREFS.closeToTray),
    launchAtLogin: bool(src.launchAtLogin, DEFAULT_PREFS.launchAtLogin),
    hotkeyEnabled,
    globalHotkey: resolvedHotkey,
  };
}

export function readPrefs(file) {
  try {
    const raw = JSON.parse(fs.readFileSync(file, "utf8"));
    return normalizePrefs(raw);
  } catch {
    return { ...DEFAULT_PREFS };
  }
}

export function writePrefs(file, prefs) {
  const next = normalizePrefs(prefs);
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(next, null, 2));
    fs.renameSync(tmp, file);
    return next;
  } catch (e) {
    noteCatch(e);
    return next;
  }
}

export function setPref(file, prefs, key, value) {
  if (!(key in DEFAULT_PREFS)) return normalizePrefs(prefs);
  const next = { ...normalizePrefs(prefs), [key]: value };
  return writePrefs(file, next);
}

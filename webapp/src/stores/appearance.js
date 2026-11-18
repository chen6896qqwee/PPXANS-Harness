// webapp/src/stores/appearance.js - 外观运行时 (配色/壁纸/材质)
// 首屏由 public/theme.js 同步写入 data-* 防闪烁；本 store 负责设置面板的响应式状态、
// 变更落盘与运行时应用。两者共用 appearance-data.js 的 ID 与校验口径。
import { reactive, watch } from "vue";
import {
  APPEARANCE_KEY,
  appearanceAttrs,
  defaultAppearance,
  normalizeAppearance,
} from "./appearance-data.js";

function load() {
  try {
    return normalizeAppearance(localStorage.getItem(APPEARANCE_KEY));
  } catch {
    return defaultAppearance();
  }
}

export const appearance = reactive(load());

export function applyAppearance() {
  if (typeof document === "undefined") return;
  const root = document.documentElement;
  for (const [key, value] of Object.entries(appearanceAttrs(appearance))) {
    if (key.startsWith("--")) root.style.setProperty(key, value);
    else root.setAttribute(key, value);
  }
}

function persist() {
  try {
    localStorage.setItem(APPEARANCE_KEY, JSON.stringify({ ...appearance }));
  } catch { /* 隐私模式/配额满: 本次会话生效, 不阻断界面 */ }
}

export function setAppearance(patch = {}) {
  Object.assign(appearance, normalizeAppearance({ ...appearance, ...patch }));
  persist();
  applyAppearance();
}

export function resetAppearance() {
  Object.assign(appearance, defaultAppearance());
  persist();
  applyAppearance();
}

watch(
  () => [appearance.palette, appearance.wallpaper, appearance.material, appearance.wallpaperOpacity],
  applyAppearance,
  { immediate: true },
);

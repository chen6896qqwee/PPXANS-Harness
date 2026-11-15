// webapp/src/stores/theme.js - 主题三态 (system/light/dark)
// 判定口径与 public/theme.js (首屏防 FOUC) 同一套: ppx_theme_pref ∈ system/light/dark。
// v5.0: data-theme 直接 = 解析结果, 双主题由 tokens.css 变量驱动。

import { reactive, watch } from "vue";

export const LABEL = { system: "跟随系统", light: "亮色", dark: "深色" };

function initialPref() {
  try {
    const p = localStorage.getItem("ppx_theme_pref");
    if (p === "system" || p === "light" || p === "dark") return p;
    const old = localStorage.getItem("ppx_theme");
    return old === "light" ? "light" : "dark";
  } catch { return "dark"; }
}

function resolve(pref) {
  if (pref !== "system") return pref;
  try {
    return matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark";
  } catch { return "dark"; }
}

export const theme = reactive({
  pref: initialPref(),
  resolved: resolve(initialPref()),
});

function applyTheme() {
  document.documentElement.setAttribute("data-theme", theme.resolved);
}

export function setTheme(pref) {
  theme.pref = pref;
  theme.resolved = resolve(pref);
  try {
    localStorage.setItem("ppx_theme_pref", pref);
    localStorage.removeItem("ppx_theme");
  } catch { /* 隐私模式忽略 */ }
  applyTheme();
}

export function cycleTheme() {
  const order = ["system", "light", "dark"];
  const next = order[(order.indexOf(theme.pref) + 1) % order.length];
  setTheme(next);
  return next;
}

try {
  matchMedia("(prefers-color-scheme: light)").addEventListener("change", () => {
    if (theme.pref === "system") {
      theme.resolved = resolve("system");
      applyTheme();
    }
  });
} catch { /* 老浏览器忽略 */ }

watch(() => theme.resolved, applyTheme, { immediate: true });

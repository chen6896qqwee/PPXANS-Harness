// webapp/src/stores/appearance-data.js - 外观数据与纯函数 (2026-11-16 前端重构)
//
// 设计参考 Tobs (BotHarness/DeepSeekBot, MIT) 的"配色预设 + 面板材质 + 壁纸"分层：
// 四套预设的明暗主色与"壁纸降低面板不透明度"的思路来自其公开界面；
// 实现为本仓自研 CSS 变量 + 本地存储，不复制其源码。
// 本文件刻意不 import Vue/DOM：设置面板、首屏脚本与 Node 测试共用同一份 ID/校验口径。

export const APPEARANCE_KEY = "ppx_appearance_v1";

export const DEFAULT_APPEARANCE = Object.freeze({
  palette: "coral",
  wallpaper: "none",
  material: "solid",
  wallpaperOpacity: 0.55,
});

export const PALETTES = Object.freeze([
  { id: "coral", label: "珊瑚", hint: "皮皮虾默认", light: "#e0532c", dark: "#f0653c" },
  { id: "blue", label: "雾蓝", hint: "冷静克制", light: "#4176e6", dark: "#7aaaff" },
  { id: "violet", label: "雾紫", hint: "柔和专注", light: "#7957c9", dark: "#b19af0" },
  { id: "forest", label: "森林", hint: "沉稳自然", light: "#287454", dark: "#7cc7a0" },
  { id: "amber", label: "琥珀", hint: "温暖明亮", light: "#94600d", dark: "#e6b75c" },
]);

export const WALLPAPERS = Object.freeze([
  { id: "none", label: "无壁纸" },
  { id: "aurora", label: "极光" },
  { id: "mist", label: "薄雾" },
  { id: "grid", label: "网格" },
  { id: "dusk", label: "暮色" },
]);

export const MATERIALS = Object.freeze([
  { id: "solid", label: "实色", hint: "面板不透明，最大可读性" },
  { id: "translucent", label: "通透", hint: "面板透出壁纸，带轻微模糊" },
]);

const PALETTE_IDS = new Set(PALETTES.map((p) => p.id));
const WALLPAPER_IDS = new Set(WALLPAPERS.map((w) => w.id));
const MATERIAL_IDS = new Set(MATERIALS.map((m) => m.id));

export function defaultAppearance() {
  return { ...DEFAULT_APPEARANCE };
}

export function clampWallpaperOpacity(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return DEFAULT_APPEARANCE.wallpaperOpacity;
  return Math.min(0.9, Math.max(0.15, Math.round(n * 100) / 100));
}

export function normalizeAppearance(raw) {
  let value = raw;
  if (typeof raw === "string") {
    try { value = JSON.parse(raw); } catch { value = null; }
  }
  const o = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  return {
    palette: PALETTE_IDS.has(o.palette) ? o.palette : DEFAULT_APPEARANCE.palette,
    wallpaper: WALLPAPER_IDS.has(o.wallpaper) ? o.wallpaper : DEFAULT_APPEARANCE.wallpaper,
    material: MATERIAL_IDS.has(o.material) ? o.material : DEFAULT_APPEARANCE.material,
    wallpaperOpacity: clampWallpaperOpacity(o.wallpaperOpacity),
  };
}

// 首屏 theme.js 与运行时 store 共用的属性映射；CSS 变量与 data-* 都从这里来。
export function appearanceAttrs(state) {
  const s = normalizeAppearance(state);
  return {
    "data-palette": s.palette,
    "data-wallpaper": s.wallpaper,
    "data-material": s.material,
    "--wallpaper-opacity": String(s.wallpaperOpacity),
  };
}

export function paletteById(id) {
  return PALETTES.find((p) => p.id === id) || PALETTES[0];
}

// webapp/public/theme.js - 首屏主题/外观防闪烁 (FOUC)
// 必须在 <head> 中同步加载, 首次绘制前完成明暗与外观判定。
// v5.0: 双主题由 CSS 变量 ([data-theme="dark"|"light"]) 驱动, 判定口径与运行时
// stores/theme.js 同一套 (ppx_theme_pref ∈ system/light/dark, 旧 key ppx_theme 兼容)。
// 2026-11-16: 外观 v2 (配色/壁纸/材质) 也在首屏写入 data-* 与 --wallpaper-opacity;
//   ID 白名单与 stores/appearance-data.js 对齐 (Node 测试会比对两边).
(function () {
  var pref = null;
  try { pref = localStorage.getItem("ppx_theme_pref"); } catch (e) {}
  if (pref !== "system" && pref !== "light" && pref !== "dark") {
    var old = null;
    try { old = localStorage.getItem("ppx_theme"); } catch (e) {}
    pref = old === "light" ? "light" : "dark"; // v4 旧值 dark 缺省 → 新版缺省深色
  }
  var resolved = pref;
  if (pref === "system") {
    resolved = (window.matchMedia && matchMedia("(prefers-color-scheme: light)").matches) ? "light" : "dark";
  }
  document.documentElement.setAttribute("data-theme", resolved);

  var appearance = null;
  try { appearance = JSON.parse(localStorage.getItem("ppx_appearance_v1") || "null"); } catch (e) {}
  var a = appearance && typeof appearance === "object" && !Array.isArray(appearance) ? appearance : {};
  var PALETTES = { coral: 1, blue: 1, violet: 1, forest: 1, amber: 1 };
  var WALLPAPERS = { none: 1, aurora: 1, mist: 1, grid: 1, dusk: 1 };
  var MATERIALS = { solid: 1, translucent: 1 };
  var has = function (map, id) {
    return typeof id === "string" && Object.prototype.hasOwnProperty.call(map, id);
  };
  var palette = has(PALETTES, a.palette) ? a.palette : "coral";
  var wallpaper = has(WALLPAPERS, a.wallpaper) ? a.wallpaper : "none";
  var material = has(MATERIALS, a.material) ? a.material : "solid";
  var opacity = Number(a.wallpaperOpacity);
  if (!isFinite(opacity)) opacity = 0.55;
  opacity = Math.min(0.9, Math.max(0.15, opacity));

  var root = document.documentElement;
  root.setAttribute("data-palette", palette);
  root.setAttribute("data-wallpaper", wallpaper);
  root.setAttribute("data-material", material);
  root.style.setProperty("--wallpaper-opacity", String(opacity));
})();

// webapp/public/theme.js - 首屏主题防闪烁 (FOUC)
// 必须在 <head> 中同步加载, 首次绘制前完成明暗判定。
// v5.0: 双主题由 CSS 变量 ([data-theme="dark"|"light"]) 驱动, 判定口径与运行时
// stores/theme.js 同一套 (ppx_theme_pref ∈ system/light/dark, 旧 key ppx_theme 兼容)。
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
})();

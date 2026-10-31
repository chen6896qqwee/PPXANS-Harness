// public/theme.js - 首屏主题防闪烁 (FOUC)
// 2026-10-30: 从 index.html 内联脚本外置为独立文件。
// 原因: 内联脚本必须把 sha256 钉进 CSP, 任何微调都会导致 CSP 拦截且容易漏同步;
// 外置后 CSP 只保留 script-src 'self', 不再依赖内容哈希。
// 注意: 这个脚本必须在 <head> 中同步加载, 首次绘制前完成外壳明暗判定。
// 与 app.js 的 themePref() 同一套判定口径 (ppx_theme_pref ∈ system/light/dark, 旧 key ppx_theme 兼容)。
(function () {
  var p = null;
  try { p = localStorage.getItem("ppx_theme_pref"); } catch (e) {}
  if (p !== "system" && p !== "light" && p !== "dark") {
    var old = null;
    try { old = localStorage.getItem("ppx_theme"); } catch (e) {}
    p = old === "dark" ? "dark" : "light";
  }
  var white = p === "system" ? !(window.matchMedia && matchMedia("(prefers-color-scheme: dark)").matches) : p === "light";
  document.documentElement.setAttribute("data-theme", "dark");
  document.documentElement.classList.toggle("ppx-white-shell", white);
})();

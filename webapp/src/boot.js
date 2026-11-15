// webapp/src/boot.js - 引导数据解析 (服务端注入的 ppx-boot JSON 节点)
// 服务端 renderIndex() 在 </head> 前注入 <script type="application/json" id="ppx-boot">
// —— 数据节点不可执行, 不受 CSP script-src 约束。解析一次缓存到 window.__PPX_BOOTSTRAP__
// (Electron 冒烟与外部脚本都读这个全局名, 是公开契约)。
export function bootData() {
  if (window.__PPX_BOOTSTRAP__) return window.__PPX_BOOTSTRAP__;
  const el = document.getElementById("ppx-boot");
  if (!el) return null;
  try {
    window.__PPX_BOOTSTRAP__ = JSON.parse(el.textContent || "{}");
  } catch {
    return null;
  }
  return window.__PPX_BOOTSTRAP__;
}

export function authToken() {
  const b = bootData();
  if (b && b.authToken) return b.authToken;
  try { return localStorage.getItem("ppx_token") || ""; } catch { return ""; }
}

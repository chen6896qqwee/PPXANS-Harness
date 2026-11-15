// webapp/src/api/url.js - 请求地址与鉴权头的纯函数层 (2026-11-14, 战役遗留项 #8)
//
// client.js 与 sse.js 共用的同一对函数: 此前 sse.js 自拼 "/message/stream" 与 Bearer 头,
//   绕过了 base/token 的统一口径 (裸 fetch 不走 401 钩子)。现在"怎么拼地址、怎么带头"
//   只有这一份实现 —— 两个模块行为必然一致。
// 纯函数, 不 import boot.js / client.js (那两个是浏览器模块), node 里可直测。
//
// 行为保持: 与旧 client.js 的 `base() + path` / `if (tok) headers.Authorization = "Bearer "+tok`
//   逐字同语义, 不做尾斜杠归一化等"顺手改进" (契约字面量测试钉着请求串)。

/** 拼接请求地址: base 为空 = 同源; base 来自 boot 注入 (桌面壳/反向代理场景)。 */
export function apiUrl(base, path) {
  return String(base || "") + String(path || "");
}

/** 鉴权头: 有 token 才带 Authorization; 调用方已给的 Authorization 优先 (不被覆盖)。 */
export function authHeaders(token, headers = {}) {
  const out = { ...headers };
  const t = String(token || "");
  if (t && !out.Authorization) out.Authorization = "Bearer " + t;
  return out;
}

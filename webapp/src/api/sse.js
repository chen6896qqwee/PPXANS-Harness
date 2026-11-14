// webapp/src/api/sse.js - 两路实时通道
// 1) streamChat: POST /message/stream 的逐帧解析 (delta/reasoning/tool/step/done/
//    approval/question/plan/diff/error), 与旧 app.js doSend 的 pump 同语义。
// 2) openEventBus: GET /events (EQ 结构化事件总线) 的订阅 —— v5.0 起前端真正消费这条
//    服务端早已建好的总线 (带 since 补播/断线重连), 审批/提问/工单/生命周期不再纯靠轮询。

import { authToken } from "../boot.js";
import { base, markUnauthorized } from "./client.js";
import { apiUrl, authHeaders } from "./url.js";

/** 逐帧解析 /message/stream。返回 { promise } —— resolve 于流结束, reject 于请求失败。
 *  2026-11-14 (战役遗留项 #8): 地址/鉴权头改走 url.js 纯函数, 与 client.js 同一实现
 *  (此前裸 fetch 自拼路径与 Bearer 头, 绕过 base 口径与 401 刷新钩子)。 */
export function streamChat({ message, sessionId, permission, files, signal, onFrame }) {
  const headers = authHeaders(authToken(), { "Content-Type": "application/json" });
  return fetch(apiUrl(base(), "/message/stream"), {
    method: "POST",
    headers,
    cache: "no-store",
    signal,
    body: JSON.stringify({ message, sessionId, permission, files: files && files.length ? files : undefined }),
  }).then(async (r) => {
    if (!r.ok || !r.body) {
      if (r.status === 401) markUnauthorized();
      const j = await r.json().catch(() => null);
      throw new Error((j && j.error) || ("请求失败 HTTP " + r.status));
    }
    const reader = r.body.getReader();
    const dec = new TextDecoder();
    let buf = "";
    for (;;) {
      const res = await reader.read();
      if (res.done) break;
      buf += dec.decode(res.value, { stream: true });
      let i;
      while ((i = buf.indexOf("\n\n")) !== -1) {
        const chunk = buf.slice(0, i);
        buf = buf.slice(i + 2);
        for (const line of chunk.split("\n")) {
          if (line.indexOf("data:") !== 0) continue;
          let j;
          try { j = JSON.parse(line.slice(5).trim()); } catch { continue; }
          if (onFrame) onFrame(j);
        }
      }
    }
  });
}

/** /events 事件总线订阅。自动重连 (指数退避), 断点 since 补播。
 *  返回 { close() }。onEvent({type, payload, seq, thread})。 */
export function openEventBus({ types, onEvent, onState } = {}) {
  let es = null;
  let closed = false;
  let lastSeq = 0;
  let attempt = 0;
  let timer = null;

  function connect() {
    if (closed) return;
    const qs = new URLSearchParams();
    const tok = authToken();
    if (tok) qs.set("token", tok);
    if (lastSeq) qs.set("since", String(lastSeq));
    if (types && types.length) qs.set("types", types.join(","));
    try {
      // EventSource 无法带自定义 header, token 走 query; 地址仍走统一 apiUrl (base 口径一致)
      es = new EventSource(apiUrl(base(), "/events?" + qs.toString()));
    } catch {
      scheduleRetry();
      return;
    }
    es.onopen = () => { attempt = 0; if (onState) onState("connected"); };
    es.onmessage = (ev) => {
      let j;
      try { j = JSON.parse(ev.data); } catch { return; }
      if (j.type === "connected") { if (onState) onState("connected"); return; }
      if (typeof j.seq === "number" && j.seq > lastSeq) lastSeq = j.seq;
      if (onEvent) { try { onEvent(j); } catch { /* 消费者异常不能打断总线 */ } }
    };
    es.onerror = () => {
      if (es) { try { es.close(); } catch { /* 已关闭 */ } es = null; }
      if (onState) onState("reconnecting");
      scheduleRetry();
    };
  }
  function scheduleRetry() {
    if (closed || timer) return;
    const wait = Math.min(30000, 1000 * Math.pow(2, attempt++));
    timer = setTimeout(() => { timer = null; connect(); }, wait);
  }
  connect();
  return {
    close() {
      closed = true;
      if (timer) { clearTimeout(timer); timer = null; }
      if (es) { try { es.close(); } catch { /* 已关闭 */ } es = null; }
      if (onState) onState("closed");
    },
  };
}

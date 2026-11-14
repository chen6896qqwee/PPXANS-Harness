// src/channels/http-chat.js - 对话/会话 REST 路由 (从 http.js 拆出, mixin 挂回 prototype)
import { SSE_HEADERS } from "../utils/http.js";
import { publicErrorMessage } from "./http-shared.js";
import { noteCatch } from "../utils/catch-log.js";
import { createTrigger } from "../flow/trigger.js";
import { createTicketLink } from "../flow/worklink.js";

export const chatHttpMethods = {
// 工单链接 (2026-11-05 调度闭环收口 ①): Web UI 对话此前直调 agent.chat 绕过账本 ——
//   /work 面板 / watchdog / 审计链看不到 HTTP 入站。source=http, messageId 留空
//   (store.findDuplicate 对空 messageId 恒 null), 每条消息独立建单; 文本为空不建。
//   账本失败降级 ticket=null, 不阻断回复 (与 base.handleTrigger 同款口径)。
_httpTicketLink(text, sessionKey) {
  const t = String(text ?? "");
  if (!t.trim()) return null;
  return createTicketLink(this.agent?.work || null, createTrigger({
    source: "http", from: sessionKey || "local", text: t,
  }), { sessionKey: sessionKey || null });
},

// 2026-10-11: 最近一次 LLM usage 快照 → 前端底部状态条 (上下文长度/缓存命中)。
//   兼容 DeepSeek 专属字段 (prompt_cache_hit_tokens/prompt_cache_miss_tokens) 与
//   OpenAI 形态 (prompt_tokens_details.cached_tokens); 无缓存字段时 cacheHitPct 为 null。
_usageSnapshot() {
  const u = this.agent?.lastUsage;
  if (!u) return null;
  const prompt = Number(u.prompt_tokens) || 0;
  const completion = Number(u.completion_tokens) || 0;
  const cacheHit = u.prompt_cache_hit_tokens ?? u.prompt_tokens_details?.cached_tokens ?? null;
  const cacheMiss = u.prompt_cache_miss_tokens ?? null;
  const cacheHitPct = (cacheHit != null && prompt > 0) ? Math.round((cacheHit / prompt) * 100) : null;
  return {
    prompt,
    completion,
    total: Number(u.total_tokens) || prompt + completion,
    cacheHit,
    cacheMiss,
    cacheHitPct,
  };
},

async _routeChat(req, res, post, reqPath) {
  if (!post) return false;

  // 非流式对话: POST /message
  if (reqPath === "/message") {
    const req0 = await this._readChatRequest(req, res);
    if (!req0) return true;
    const { text, sessionKey, fileRefs } = req0;
    if (!this._acquire(res)) return true;
    const link = this._httpTicketLink(text, sessionKey);
    link?.begin();
    try {
      const reply = await this.agent.chat(String(text), { sessionKey, fileRefs });
      link?.done(reply);
      this._json(res, 200, { reply, sessionId: sessionKey, agent: this.agent.config.agent?.name || "ppx", tokens: this._usageSnapshot() });
    } catch (e) {
      link?.fail(e);
      this._fail(res, e, 500);
    } finally { this._release(); }
    return true;
  }

  // SSE 流式对话: POST /message/stream 或 /chat
  if (reqPath === "/message/stream" || reqPath === "/chat") {
    const req0 = await this._readChatRequest(req, res);
    if (!req0) return true;
    const { text, sessionKey, fileRefs } = req0;
    // 2026-09-17 修复 (P0-3 / P1-1):
    //   ① 并发护栏必须在 writeHead(200) 之前判定 —— 原先先发 200 SSE 头再 _acquire,
    //      超限时 _acquire 内的 writeHead(429) 抛 ERR_HTTP_HEADERS_SENT, 被外层 catch
    //      转成一条 SSE error 事件, 客户端拿到 "HTTP 200 + text/event-stream" 却永远等不到
    //      内容 (实测可复现), 同时把 Node 内部错误原文泄漏给了客户端。
    //   ② 发完 200 后立刻 flushHeaders() —— 否则响应头要等到第一次 res.write 才下发,
    //      LLM 慢首包时客户端迟迟收不到任何响应头 (实测 6s 无任何响应)。
    if (!this._acquire(res)) return true;
    const link = this._httpTicketLink(text, sessionKey); // 429 拒绝时未走到这里, 不建单
    link?.begin();
    res.writeHead(200, SSE_HEADERS);
    if (typeof res.flushHeaders === "function") res.flushHeaders();
    // 2026-11-08 修复「关掉页面模型还在跑」: 此前这条流没有任何 close 监听 ——
    //   客户端断开后 send() 抛错被 catch {} 吞掉, chatStream 照常跑到收尾, token 白烧。
    //   现在断连即 interrupt(sessionKey): 置会话中断位 + abort _streamAborts 里在途的
    //   AbortController (上游请求真正掐断), 未答的 ask_user 也一并收口。
    //   下一轮开头 clearInterrupt(sessionKey) 自动复位, 不会污染后续对话;
    //   没有 sessionKey 时宁可不中断 —— 无参 interrupt 是全局的, 会误伤其它会话。
    let finished = false;
    const onResClose = () => {
      if (finished) return;
      if (!sessionKey) return;
      try { this.agent.interrupt(sessionKey); } catch (e) { noteCatch("src/channels/http-chat.js#res-close", e); }
    };
    res.on("close", onResClose);
    let onApproval = null; // (R13) 审批 sink, finally 里摘除 (作用域须在 try 外)
    let onQuestion = null; // (2026-11-02) 提问 sink, 同上
    let offResolved = null; // (2026-11-02) 审批结束广播 (含终端/另一窗口裁决与超时)
    try {
      const send = (obj) => { if (!res.writableEnded) res.write("data: " + JSON.stringify(obj) + "\n\n"); };
      // 2026-10-24 (R13 审批闭环): 流式通道接线审批事件 —— agent._requestApproval 此前
      //   只推 EQ (/events 桥, 前端未订阅) + 轮询兜底 (仅流结束后跑), 正在等待审批的
      //   这条流自己从不发 approval 事件 → UI 审批卡片在等待期内不出现, 只能干等
      //   120s 超时被拒 (真浏览器 E2E 实锤)。现每条流注册一个审批 sink, agent 的
      //   _onApprovalEvent 广播给全部活跃 sink (跨会话可见性与 pollApprovals 一致)。
      const approvalSinks = this._ensureApprovalSinks();
      onApproval = (a) => { try { send({ type: "approval", id: a.id, kind: a.kind, tool: a.tool, args: a.args, summary: a.summary, reason: a.reason, rememberable: a.rememberable === true }); } catch {} };
      approvalSinks.add(onApproval);
      // 提问与审批同理: ask_user 等待期内, 正在跑的这一条流必须实时把问题递到 UI,
      //   否则工具会一直挂到超时 (BOT 的 ask_user_question 也走同一条流式事件面)。
      const questionSinks = this._ensureQuestionSinks();
      onQuestion = (ev) => { try { send(ev); } catch {} };
      questionSinks.add(onQuestion);
      // 审批结束 (批准/拒绝/超时/别处裁决) 也要推给这条流: 前端据此收起卡片。
      //   否则在终端或另一窗口裁决后, 这边的卡片会一直留着, 再点只能拿到 404。
      offResolved = this.agent.bus?.on?.("approval/resolved", (ev) => {
        const p = ev?.payload || {};
        if (p.id) { try { send({ type: "approval.close", id: p.id, decision: p.decision }); } catch {} }
      });
      let full = "";
      const reply = await this.agent.chatStream(String(text), {
        sessionKey,
        fileRefs,
        onDelta: (d) => { full += d; try { send({ type: "delta", content: d }); } catch {} },
        // 工具调用可视化: done 事件带 result (agent 已截到 300 字符预览) 与 ts, 前端据此渲染
        // 折叠结果行 (此前只转 status/args, 结果永远显示不出来, 卡片只能看到参数)。
        onTool: (ev) => { try { send({ type: "tool", tool: ev.tool, id: ev.id, status: ev.type, args: ev.args, ok: ev.ok, durationMs: ev.durationMs, result: ev.result, ts: ev.ts }); } catch {} },
        onStep: (ev) => { try { send({ type: "step", round: ev.round, maxRounds: ev.maxRounds }); } catch {} }, // turn/step 推理轮次进度
        // 思考链: 推理模型的 reasoning_content 增量, 前端渲染为可折叠的思考块 (与正文分离)。
        onReasoning: (t) => { if (t) { try { send({ type: "reasoning", content: t }); } catch (e) { noteCatch("src/channels/http-chat.js#reasoning", e); /* 思考块发送失败不阻断正文 */ } } },
      });
      const finalContent = full || reply;
      link?.done(finalContent);
      send({ type: "done", content: finalContent, sessionId: sessionKey, tokens: this._usageSnapshot() });
      if (!res.writableEnded) res.end();
    } catch (e) {
      link?.fail(e);
      // 不外泄内部实现细节 (如 ERR_HTTP_HEADERS_SENT 之类)
      try { res.write("data: " + JSON.stringify({ type: "error", error: publicErrorMessage(e) }) + "\n\n"); } catch {}
      try { res.end(); } catch {}
    } finally {
      // 先标记收口再摘监听: res.end() 之后 close 事件是异步的, 这里同步置位能挡住它
      finished = true;
      try { res.off?.("close", onResClose); } catch { /* 响应已销毁 */ }
      try { this._approvalSinks?.delete(onApproval); } catch {}
      try { this._questionSinks?.delete(onQuestion); } catch {}
      try { if (typeof offResolved === "function") offResolved(); } catch {}
      this._release();
    }
    return true;
  }

  return false;
},

// ---- 路由域 3: 会话管理 (列表/历史/重命名/删除/重置/中断) ----
async _routeSessions(req, res, get, post, reqPath) {
  if (get && reqPath === "/sessions") {
    if (!this._requireAuth(req, res)) return true;
    const list = (this.agent.sessionStore && this.agent.sessionStore.list) ? this.agent.sessionStore.list() : [];
    this._json(res, 200, { sessions: list });
    return true;
  }
  // 2026-11-03: 会话全文检索 ?q=... — 扫消息正文, 每个会话取最新一条命中
  if (get && reqPath === "/sessions/search") {
    if (!this._requireAuth(req, res)) return true;
    const u = new URL(req.url || "/", "http://127.0.0.1");
    const q = String(u.searchParams.get("q") || "").trim();
    if (!q) { this._json(res, 400, { ok: false, error: "缺少 q" }); return true; }
    const store = this.agent.sessionStore;
    if (!store || typeof store.search !== "function") { this._json(res, 501, { ok: false, error: "会话存储不支持检索" }); return true; }
    const limit = Math.min(50, Math.max(1, Number(u.searchParams.get("limit")) || 20));
    this._json(res, 200, { ok: true, query: q, hits: store.search(q, { limit }) });
    return true;
  }
  if (get && /^\/sessions\/[^/]+\/history$/.test(reqPath)) {
    if (!this._requireAuth(req, res)) return true;
    const key = decodeURIComponent(reqPath.split("/")[2]);
    const msgs = this.agent.sessionStore && typeof this.agent.sessionStore.deriveMessages === "function"
      ? this.agent.sessionStore.deriveMessages(key)
      : [];
    this._json(res, 200, { sessionId: key, messages: msgs });
    return true;
  }
  // 2026-10-11: 会话标题覆盖 { key, title } — 改名不改内容/归属/排序 (list 已优先读覆盖标题)
  if (post && reqPath === "/sessions/title") {
    if (!this._requireAuth(req, res)) return true;
    const data = await this._readJson(req, res);
    if (data === null) return true;
    const store = this.agent.sessionStore;
    if (!store || typeof store.setTitle !== "function") { this._json(res, 501, { ok: false, error: "会话存储不支持标题" }); return true; }
    const key = String(data?.key || "");
    if (!key) { this._json(res, 400, { ok: false, error: "缺少 key" }); return true; }
    const ok = store.setTitle(key, data?.title);
    this._json(res, ok ? 200 : 404, { ok });
    return true;
  }
  // 2026-10-11: 会话归档/恢复 { key, archived: true|false } — 不删数据, 仅打标记 (自动归档的手动对偶)
  if (post && reqPath === "/sessions/archive") {
    if (!this._requireAuth(req, res)) return true;
    const data = await this._readJson(req, res);
    if (data === null) return true;
    const store = this.agent.sessionStore;
    if (!store || typeof store.archive !== "function") { this._json(res, 501, { ok: false, error: "会话存储不支持归档" }); return true; }
    const key = String(data?.key || "");
    if (!key) { this._json(res, 400, { ok: false, error: "缺少 key" }); return true; }
    const ok = data?.archived === false ? store.unarchive(key) : store.archive(key);
    this._json(res, ok ? 200 : 404, { ok });
    return true;
  }
  // 2026-11-03: 会话回卷入口 (前端「重新生成 / 编辑重发」的前置)。
  //   语义与 /rewind 命令一致: fork 到新分支, 原会话完整保留; 返回新 key 供前端切换。
  if (post && reqPath === "/sessions/rewind") {
    if (!this._requireAuth(req, res)) return true;
    const data = await this._readJson(req, res);
    if (data === null) return true;
    const key = String(data?.sessionId || data?.key || "");
    if (!key) { this._json(res, 400, { ok: false, error: "缺少 sessionId" }); return true; }
    if (typeof this.agent.rewindSession !== "function") {
      this._json(res, 501, { ok: false, error: "当前内核不支持会话回卷" });
      return true;
    }
    // 上限 20 轮: 回卷是人在环的纠正动作, 一次退太多更像是想换会话
    const turns = Math.max(1, Math.min(Number(data?.turns) || 1, 20));
    const r = this.agent.rewindSession(key, turns) || {};
    this._json(res, r.ok ? 200 : 409, { ...r, sessionId: key });
    return true;
  }
  // 2026-11-03: 会话置顶/取消置顶 { key, pinned } — 只影响列表排序, 不删不改内容
  if (post && reqPath === "/sessions/pin") {
    if (!this._requireAuth(req, res)) return true;
    const data = await this._readJson(req, res);
    if (data === null) return true;
    const store = this.agent.sessionStore;
    if (!store || typeof store.pin !== "function") { this._json(res, 501, { ok: false, error: "会话存储不支持置顶" }); return true; }
    const key = String(data?.key || data?.sessionKey || "");
    if (!key) { this._json(res, 400, { ok: false, error: "缺少 key" }); return true; }
    const want = data?.pinned !== false;
    const ok = want ? store.pin(key) : store.unpin(key);
    this._json(res, ok ? 200 : 404, ok ? { ok: true, pinned: want } : { ok: false, error: want ? "会话不存在" : "该会话未置顶" });
    return true;
  }
  if (post && reqPath === "/sessions/rename") {
    if (!this._requireAuth(req, res)) return true;
    // 2026-09-18 修复 (缺陷 #1): 原实现把 _readBody 的【原始字符串】当对象用 —— body.from / body.to
    //   恒为 undefined, rename 实际收到 (undefined, undefined) 后恒返回 false, 前端
    //   post("/sessions/rename", {from,to}) 的契约从未生效 (重命名一直失败)。改为解析 JSON body。
    const data = await this._readJson(req, res);
    if (data === null) return true;
    const ok = this.agent.sessionStore && typeof this.agent.sessionStore.rename === "function"
      ? this.agent.sessionStore.rename(data.from, data.to) : false;
    this._json(res, ok ? 200 : 404, { ok });
    return true;
  }
  if (post && reqPath === "/sessions/delete") {
    if (!this._requireAuth(req, res)) return true;
    // 2026-09-18 修复 (缺陷 #2): 同上 —— 原实现 body.key 恒为 undefined → `|| "default"` 兜底,
    //   于是"删除某个会话"实际删掉的是 default 主会话 (误删数据)。改为解析 JSON body。
    // 2026-10-09 二次修复 (缺陷 #2 回归): 前端 delSession 发的是 { sessionKey }, 后端读 data.key
    //   → 仍恒为 undefined → 仍兜底删掉 default 主会话。同一缺陷以"字段名不对齐"的形式复发。
    //   两处一起改: 后端同时接受 key / sessionKey, 且【缺字段时拒绝而不是兜底 default】——
    //   兜底才是误删的根因, 宁可 400 也不要静默删掉用户的主会话。
    //   契约由 test/session-api-contract.test.js 锁死, 防第三次复发。
    const data = await this._readJson(req, res);
    if (data === null) return true;
    const delKey = data.key || data.sessionKey;
    if (!delKey) {
      this._json(res, 400, { ok: false, error: "缺少 key (会话标识不能为空, 拒绝兜底删除 default)" });
      return true;
    }
    if (this.agent.sessionStore) this.agent.sessionStore.delete(delKey);
    this._json(res, 200, { ok: true });
    return true;
  }
  if (post && reqPath === "/reset") {
    if (!this._requireAuth(req, res)) return true;
    const data = await this._readJson(req, res);
    if (data === null) return true;
    this.agent.resetSession(data.sessionId || "default");
    this._json(res, 200, { ok: true });
    return true;
  }
  if (post && reqPath === "/interrupt") {
    if (!this._requireAuth(req, res)) return true;
    const body = await this._readBody(req, res);
    if (body === null) return true;
    try {
      const data = JSON.parse(body || "{}");
      // 2026-11-14 (双轨收敛轮, G-E): 带 sessionId = 只掐该会话 (与 SSE 断连同款会话级口径);
      //   不带 = 全局中断 (旧兼容)。此前读了 sessionId 却调无参 interrupt —— 会话级退化成全局,
      //   并发会话被误伤。
      const sessionId = String(data.sessionId || "").trim();
      if (typeof this.agent.interrupt === "function") this.agent.interrupt(sessionId || undefined);
      this._json(res, 200, { ok: true, interrupted: true, sessionId: sessionId || "default" });
    } catch (e) {
      this._fail(res, e);
    }
    return true;
  }

  return false;
}
};

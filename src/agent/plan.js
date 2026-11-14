// src/agent/plan.js - 记忆提炼/计划模式/会话重置 (从 index.js 拆出, mixin 挂回 prototype)

export const planMethods = {
// P1#9: LLM 结构化记忆提炼 (实现已迁 src/services/memory-service.js, 此处分发保持公共 API)
async _extractMemory(user, assistant, existing = []) {
  return this.memorySvc.extractMemory(user, assistant, existing);
},

// 辅助 LLM 调用前置健康探测 (v1.0.7): 模型不可用 (本地服务未运行/远端不可达) 时快速跳过,
// 不发起 10s 超时等待 — 本地未运行的 health() 是 ECONNREFUSED 毫秒级失败, 开销可忽略
// (记忆/学习方法已用 service 内部版本, 此处保留供 _maybeCompact 等使用)
// 2026-11-01 (v4.2 优化): health 结果接入 _healthCache TTL 缓存 (与 _llmWithFallback 同源,
//   config.agent.health_cache_ms 默认 30s)。此前这里每轮裸探一次: _loadHistory 每轮先走
//   _maybeCompact, 对远程 provider 等于每轮串行多一次 /models 网络往返 (健康时 50-500ms,
//   异常时最长 3s), 直接加在首 token 延迟上。缓存只影响"要不要探", 不影响判定语义 ——
//   误判健康的代价是压缩的 chat 调用失败, 那里本就静默降级交给硬裁剪。
async _auxLlmReady() {
  if (!this.llm) return false;
  if (typeof this.llm.health !== "function") return true;
  const ttl = Number(this.config.agent?.health_cache_ms ?? 30000);
  const cache = (this._healthCache ||= new Map());
  const hit = cache.get(this.llm);
  if (hit && (Date.now() - hit.ts) < ttl) return hit.ok;
  let ok = false;
  try { ok = !!(await this.llm.health()); } catch { ok = false; }
  cache.set(this.llm, { ok, ts: Date.now() });
  return ok;
},

// 用 LLM 把旧对话浓缩成语义摘要 (实现已迁 memory-service, 此处分发)
async _summarizeMemory(raw) {
  return this.memorySvc.summarizeMemory(raw);
},

// P1: LLM 查询扩展 (实现已迁 memory-service, 此处分发)
async _expandQuery(q) {
  return this.memorySvc.expandQuery(q);
},

// P1: 语义记忆检索 (实现已迁 memory-service, 此处分发)
async _memoryQuery(q, { limit = 5, scope = null } = {}) {
  return this.memorySvc.query(q, { limit, scope });
},

// 重置某会话历史 (新会话): 删除事件日志 + 清计划态 (全新会话不得幸存旧 plan)
resetSession(sessionKey) {
  const orig = sessionKey || "default";
  // 2026-10-24 (R9 审计): 重定向感知 —— 回卷/恢复后实际会话在分支 key 上,
  //   直接删原始 key 会"删了旧的、分支还在", 用户重置无感知。先解析再删,
  //   并清空指向该会话的重定向 (回到原始命名空间); 陈旧的原始日志也一并删除。
  const key = this._redirectSession ? this._redirectSession(orig) : orig;
  this.sessionStore.delete(key);
  if (key !== orig) this.sessionStore.delete(orig);
  this._planSessions.delete(key);
  this._planSessions.delete(orig);
  for (const [k, v] of this._sessionRedirect || []) {
    if (k === orig || v === key || k === key) this._sessionRedirect.delete(k);
  }
},

// ---- plan 模式状态 (按会话, 2026-10-05) ----
isPlanMode(sessionKey) { return this._planSessions.has(sessionKey || "default"); },

setPlanMode(sessionKey, on) {
  const key = sessionKey || "default";
  if (on) this._planSessions.add(key); else this._planSessions.delete(key);
  return this;
},

planModeSessions() { return [...this._planSessions]; },

// 认领 /plan /do 命令 intent (其余命令/非法输入返回 null, 不劫持链路)。
// 由 chat 在进入 LLM 前调用 —— 命中即翻转状态并直接回文案, 不调 LLM。
_consumePlanCommand(userMsg, sessionKey) {
  if (!this.commands || typeof this.commands.execute !== "function") return null;
  let intent;
  try { intent = this.commands.execute(String(userMsg), { sessionKey }); } catch { return null; }
  if (intent && intent.type === "intent"
    && (intent.action === "enter_plan_mode" || intent.action === "exit_plan_mode")) {
    return intent;
  }
  return null;
}
};

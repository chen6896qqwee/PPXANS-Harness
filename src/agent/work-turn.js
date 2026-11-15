// src/agent/work-turn.js - 轮内意图漏斗 + 学习/统计/proactive/watchdog (2026-11-08 自 work.js 拆出)
// work.js 863 行巨石的三路拆分之一: 这一半是 '本轮怎么便宜地答' 与 '轮收口后怎么变强/被看见'。
import { noteCatch } from '../utils/catch-log.js';
import { isToolErrorResult } from '../core/errors.js';
// EventType 未直接引用但 protocol/index.js 靠本 import 进模块图 (import 即注册), 不能断
import { EventType as _EventType } from '../protocol/index.js';
import { watchdogHeartbeat } from '../ans/watchdog.js';
import { suggestProactive, markTaskDone } from '../ans/proactive.js';
import { buildDispatchHint, layer1Resolve, layer2Signals } from '../intent/funnel.js';
import { matchSkill } from '../skills/search.js';
import { logicalDay } from '../utils/store.js';
import { info, warn } from '../utils/logger.js';

export const workTurnMethods = {

// 离线工具路由: 无 LLM 时识别简单工具指令
// ---- 内核自主决策: 本地意图预判层 (P2-7, v4.2 升级为漏斗 L1) ----
// 规则匹配已抽到 src/intent/funnel.js (纯函数可单测): 内置白名单 + .ppx/intent-rules.json
// 用户扩展。这里只做"解析 → 执行": 命中即本地直答/调工具, 不调 LLM, 省成本更快。
async _localIntent(userMsg, sessionKey = null) {
  const hit = layer1Resolve(userMsg, this._intentRules);
  if (!hit) return null;
  try {
    return await this._execIntentAction(hit.rule.action, hit.match, userMsg, sessionKey);
  } catch (e) {
    warn("[intent] L1 规则执行失败 (转交 LLM 兜底):", e?.message || e);
    return null;
  }
},

// L1 规则动作执行 (与漏斗解耦: funnel 判定, agent 执行)
async _execIntentAction(action, m, rawMsg, sessionKey = null) {
  if (!action) return null;
  if (action.type === "reply") {
    if (action.variant === "literal") return action.text;
    const text = String(rawMsg || "");
    if (action.variant === "chitchat") {
      if (/再见|拜拜|bye/i.test(text)) return "再见兄弟, 有事随时喊我。";
      if (/谢谢|感谢|辛苦/i.test(text)) return "客气啥, 应该的。";
      return "在的兄弟, 说。";
    }
    if (action.variant === "help") {
      // 2026-11-04 实测修复 (P2): 原先把工具数写死 "76 个", 实际已注册 103 个 ——
      //   数字随装配漂移, 每次加工具都要改这句。改为从目录即时取数。
      const toolCount = this.tools?.tools?.size || 0;
      const toolHint = toolCount > 0 ? `自带 ${toolCount} 个工具` : "自带一批工具";
      return [
        "我能做这些:",
        `- 对话问答 / 长任务执行 (${toolHint}: 文件/命令/搜索/记忆/日程…)`,
        "- `记住: XXX` 写记忆 · 直接问「你记得XXX」查记忆",
        "- `/plan` 计划模式 · `/review` 审查 · `/task` 任务面板 · `/help` 全部命令",
        "- 复杂任务直接说需求, 我会拆解并调用工具执行。",
      ].join("\n");
    }
    return null;
  }
  if (action.type === "tool") {
    if (!this._markWorkReplayUnsafe(action.tool, sessionKey)) {
      return "账本不可用, 已拒绝执行有副作用工具 (fail-closed; 自动重放安全无法保证)。";
    }
    const args = action.argsFrom ? action.argsFrom(m) : (action.args || {});
    const out = this._humanToolResult(await this.tools.call(action.tool, args));
    return action.prefix ? action.prefix + out : out;
  }
  if (action.type === "memory_query") {
    const q = String(m[action.group ?? 0] || "").trim();
    const res = await this._memoryQuery(q || rawMsg, { limit: 3 });
    return res.length ? "我记得:\n" + res.map(r => `- ${r.content}`).join("\n") : `(记忆里没找到关于"${q || rawMsg}"的)`;
  }
  if (action.type === "memory_add") {
    if (!this._markWorkReplayUnsafe("memory_add", sessionKey)) {
      return "账本不可用, 已拒绝写入记忆 (fail-closed; 自动重放安全无法保证)。";
    }
    const content = String(m[action.group ?? 1] || "").trim();
    const r = String(await this.tools.call("memory_add", { content }) ?? "");
    if (isToolErrorResult(r)) return "没记上: " + this._humanToolResult(r);
    return `好, 记下了: ${content}`;
  }
  return null;
},

// ---- v4.2: 漏斗 L2 辅助 ----
// L2 上下文层: 打分 + 组装分流提示块注入本轮 user 消息尾部 (雷仔范式: 提示不接管决策)。
// 注入的内容同时经 _turnHistoryTexts 落入会话历史 —— wire 与历史逐字节一致 (append-only 契约),
// 记忆抽取仍用原文 (见 _persistTurn)。层流量统计随 recordTurn 落盘。
// 全部状态按 sessionKey 隔离 (见构造器注释), opts.record=false 供降级复跑时只算提示不重复计数。
_armIntentHint(userMsg, sessionKey, { record = true } = {}) {
  const sk = sessionKey || "default";
  try {
    this._turnIntentHints.delete(sk);
    this._turnHistoryTexts.delete(sk);
    if (!this.intentState) return false;
    // 技能打分的输入只需 id/name/description —— 走 catalog() (不逐文件 stat), 稳态每轮省
    // 67 次 statSync。内容改动落后一轮对"提示级"路由无影响; 冷缓存时 catalog() 内部照常
    // _load, 与 list() 结果一致。系统提示里的技能清单仍由 _context() 的 list() 权威校验。
    let skillView = this.skills || null;
    if (skillView && typeof skillView.catalog === "function") {
      try { const catalog = skillView.catalog(); skillView = { list: () => catalog }; } catch (e) { noteCatch("src/agent/work.js#_armIntentHint", e); }
    }
    const ctx = {
      skills: skillView,
      matchSkill,
      experts: this._expertFeatures(),
      activeTask: this._activeTaskLabel(),
      prevState: this.intentState.get(sessionKey),
    };
    const signals = layer2Signals(userMsg, ctx);
    const hint = buildDispatchHint(signals);
    if (hint) {
      this._turnIntentHints.set(sk, hint);
      this._turnHistoryTexts.set(sk, this._userWireText(userMsg, sk));
    }
    if (record) this.intentState.recordTurn(sessionKey, { userMsg, layer: hint ? "context" : "llm", intent: signals.intent });
    return !!hint;
  } catch {
    this._turnIntentHints.delete(sk);
    this._turnHistoryTexts.delete(sk);
    return false;
  }
},

// 本轮 user 消息的 wire 文本 (含 L2 提示块) —— 会话历史按此落库, 与 wire 逐字节一致
_userWireText(userMsg, sessionKey) {
  try {
    const c = this._userContent(userMsg, sessionKey);
    if (typeof c === "string") return c;
    const texts = (Array.isArray(c) ? c : []).filter((p) => p && p.type === "text").map((p) => p.text);
    return texts.join("") || String(userMsg);
  } catch { return String(userMsg); }
},

// 层流量记录 (L1 命中路径用; L2/L3 由 _armIntentHint 记)
_intentRecord(sessionKey, userMsg, layer, intent) {
  this._turnHistoryTexts.delete(sessionKey || "default"); // 规则直答不进 LLM, 无需 wire 历史
  try { this.intentState?.recordTurn(sessionKey, { userMsg, layer, intent }); } catch (e) { noteCatch("src/agent/work.js#_intentRecord", e); /* 观测不阻断 */ }
},

// 专家特征源: 专家包 manifest 的 id/label/domain → L2 匹配特征
_expertFeatures() {
  try {
    const packs = this.expertPacks?.list?.() || [];
    return packs.map((p) => ({ id: p.id, label: p.label || "", domain: p.domain || "", description: p.description || "" }));
  } catch { return []; }
},

// 当前任务标签 (WorkStack 是任务栈唯一事实源, 漏斗只读不写)
_activeTaskLabel() {
  try {
    const t = this.workStack?.active?.();
    if (!t || !t.goal) return null;
    return String(t.goal).slice(0, 40);
  } catch { return null; }
},

// ---- Session Replay: 从 l0 原始日志恢复某会话历史 (跨天/崩溃续跑) ----
replaySession(sessionKey = "default", { days = 7, limit = 40 } = {}) {
  const msgs = [];
  const now = new Date();
  for (let d = days - 1; d >= 0; d--) {
    const day = logicalDay(new Date(now.getTime() - d * 86400000));
    const recs = this.l0.read(day, 2000);
    for (const r of recs) {
      if (r.sessionKey !== sessionKey) continue;
      if (r.role === "user" || r.role === "assistant") msgs.push({ role: r.role, content: r.content, ts: r.timestamp });
    }
  }
  msgs.sort((a, b) => (a.ts || 0) - (b.ts || 0));
  return msgs.slice(-limit).map(({ role, content }) => ({ role, content }));
},

// 用户主动经验学习 (实现已迁 memory-service, 此处分发)
_learnFromTurn(userMsg, reply) {
  return this.memorySvc.learnFromTurn(userMsg, reply);
},

// P3: 自我进化闭环 - 失败→经验 (实现已迁 learning-service, 此处分发保持公共 API)
async refine({ limit = 20 } = {}) {
  return this.learningSvc.refine({ limit });
},

// P2: 自我进化闭环 (下) - 成功→技能 (实现已迁 learning-service, 此处分发保持公共 API)
async refineSkill({ limit = 50, minFreq = 2 } = {}) {
  return this.learningSvc.refineSkill({ limit, minFreq });
},

// 用中自进化 (实现已迁 learning-service, 此处分发保持公共 API)
async upgradeSkill(id, { minUses = 3, limit = 40 } = {}) {
  return this.learningSvc.upgradeSkill(id, { minUses, limit });
},

// L2 场景归档 (实现已迁 memory-service, 此处分发)
_archiveScenes() {
  return this.memorySvc.archiveScenes();
},

// 可观测: 聚合各层状态 (记忆 L0-L3 / 轨迹 / 工具 / 经验 / 自愈)
// 顶层展平 traces.stats() 字段 (count/failed/failRate/slowTools), 向后兼容 web 前端
stats() {
  const sessions = this.sessionStore ? this.sessionStore.list() : [];
  const eventsTotal = sessions.reduce((a, s) => a + (s.count || 0), 0);
  const tools = this.tools ? this.tools.listDetailed() : [];
  return {
    ...(this.traces && typeof this.traces.stats === "function" ? this.traces.stats() : {}),
    agent: {
      name: this.config.agent?.name || "ppx",
      mode: this.config.agent?.mode || "react",
      llm: this.llm ? (this.llm.backend || this.llm.model || "configured") : "none",
    },
    memory: {
      l0: { events_total: eventsTotal, sessions: sessions.length },
      l1: this.facts && this.facts.stats ? this.facts.stats() : {},
      l2: this.scenes && this.scenes.count ? { scenes: this.scenes.count() } : {},
      l3: this.personaStore && this.personaStore.stats ? this.personaStore.stats() : {},
      ...(this.memory && this.memory.stats ? this.memory.stats() : {}),
    },
    tools: {
      total: tools.length,
      enabled: tools.filter((t) => t.enabled).length,
      list: tools.map((t) => ({ name: t.name, enabled: t.enabled, category: t.category })),
    },
    // 策略订阅者熔断状态 (2026-09-17 接入 circuit-breaker 后可观测): 只列非闭合项, 正常时为空数组
    policyGuard: this.tools && typeof this.tools.policyStatus === "function"
      ? this.tools.policyStatus().filter((s) => s.state && s.state !== "closed")
      : [],
    skills: this.skills && typeof this.skills.list === "function"
      ? this.skills.list().map((s) => ({ id: s.id, description: s.description }))
      : [],
    mcp: this._mcp ? { connected: true, count: this._mcp.count || 0 } : { connected: false, count: 0 },
    experience: this.experience ? { lessons: this.experience.lessons.length } : {},
    health: this.health || null,
  };
},

// 主动任务生成 (ANS 自主性): 扫描 L1 记忆里的待办/偏好, 生成主动提醒 (委托 ans/proactive 模块)
// 返回可直接投递的文本 (保持兼容); 结构化数据见 startProactiveTicker 回调的 payload
async proactiveSuggest() {
  const out = await suggestProactive(this);
  return out ? out.text : null;
},

// 标记待办完成 (ANS): 之后不再主动提醒 (窗口去重 + 完成跟踪)
proactiveMarkDone(id) {
  return markTaskDone(this, id);
},

// 启动主动任务生成定时器 (config.agent.proactive.enabled 才启用)
// 回调契约: cb(payload) → { ts, items: [{content, importance, source, id}], text }
startProactiveTicker(cb) {
  const cfg = this.config.agent?.proactive;
  if (!cfg || !cfg.enabled) return null;
  const ms = Number(cfg.interval_ms) || 3600000;
  // 2026-09-18 修复 (P2): suggestProactive 耗时超过 interval 时会重叠执行 (扫描/LLM 调用堆积),
  //   加防重入闸门: 上一轮未结束直接跳过本轮。
  let _proactiveRunning = false;
  this._proactiveTimer = setInterval(async () => {
    if (_proactiveRunning) return;
    _proactiveRunning = true;
    try {
      const payload = await suggestProactive(this);
      if (payload && typeof cb === "function") { try { cb(payload); } catch {} }
    } catch {} finally { _proactiveRunning = false; }
  }, ms);
  info(`[proactive] 主动任务生成已启动 (每 ${Math.round(ms / 60000)} 分钟)`);
  return this._proactiveTimer;
},

stopProactiveTicker() {
  if (this._proactiveTimer) { clearInterval(this._proactiveTimer); this._proactiveTimer = null; }
},

// 启动 Watchdog 控制回路 (config.agent.watchdog.enabled 才启用; 2026-10-31 v4.1 平台化)
// 回调契约: cb({ts, level, text, signals}) —— level ∈ ok|warn|crit; 低打扰: 仅 warn/crit 才回调
// (server.js 把回调接到 manager.broadcast)。防重入与 proactive ticker 同款。
startWatchdog(cb) {
  const cfg = this.config.agent?.watchdog;
  if (!cfg || !cfg.enabled) return null;
  if (this._watchdogTimer) return this._watchdogTimer;
  const ms = Math.max(5, Number(cfg.interval_minutes) || 30) * 60000;
  let _watchdogRunning = false;
  this._watchdogTimer = setInterval(async () => {
    if (_watchdogRunning) return;
    _watchdogRunning = true;
    try {
      const r = await watchdogHeartbeat(this);
      if (r && r.level !== "ok" && typeof cb === "function") { try { cb(r); } catch {} }
    } catch { /* 心跳不带回崩主服务 */ } finally { _watchdogRunning = false; }
  }, ms);
  info(`[watchdog] 控制回路已启动 (每 ${Math.round(ms / 60000)} 分钟, 异常才广播)`);
  return this._watchdogTimer;
},

stopWatchdog() {
  if (this._watchdogTimer) { clearInterval(this._watchdogTimer); this._watchdogTimer = null; }
}
};

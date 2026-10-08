// src/agent/context.js - Agent 历史/上下文管理 (从 index.js 拆分, mixin 挂回 prototype)
// 重构第三刀后续 (2026-09-15): 历史裁剪/token 预算/会话压缩从 PPXAgent 类中抽出,
// 方法以 mixin 方式挂回 prototype, 实例行为与调用方完全不变 (测试走 agent._xxx 不受影响)。
//
// 2026-10-06 结构性修复 (上下文失忆 / 工具证据不可抹改):
//   旧实现的三处"只认 user+assistant"合起来等于结构性失忆 ——
//     · _pushTurn 只落 user/message + assistant/message: 工具调用与回执从不进会话日志;
//     · _maybeCompact 的 tail 过滤同样只认这两类: 压缩区间里凡是证据一律无声丢弃;
//     · _getSession 直接吃 sessionStore.deriveCompacted (其投影也只认这两类):
//       即使日志里有 tool/call + tool/result (mode/graph.js 早就在写), 模型也永远看不见。
//   结果: 压缩后/重启后, agent 只记得"自己说过什么", 不记得"自己做过什么" ——
//   对以"append-only + 证据支撑的每一轮"为价值主张的 harness, 这是最重的结构缺陷。
//   现在: ① 证据按 seq 单调进入投影; ② 压缩游标只从"已落盘的真相"推导;
//        ③ 折叠前后有一道免模型的保真校验 (pin-set 逐字 + 配对完整 + 钉住记录不越线);
//        ④ 一条完全不调用模型的确定性重建路径 (对标 Codex compact_token_budget)。
//   零 API/零配额: 上述路径都不碰 provider, 固定请求开销 (system prompt + 工具 schema) 不变。

import { estimateTokens } from "../utils/text.js";
import { transcriptToText, buildCompactionMessages } from "../memory/compaction.js";
import { currentTrace } from "../core/trace.js";

// 辅助 LLM 调用短超时 (压缩/提炼等非主对话调用):
// 模型不可用/网络不通时快速失败降级, 避免阻塞主对话
const AUX_LLM_TIMEOUT_MS = 10000;
// 上下文窗口感知: 未知窗口的保守默认 (绝不放大历史) + 历史占用窗口的安全比例上限
const DEFAULT_CONTEXT_WINDOW = 8192;
const DEFAULT_CONTEXT_RATIO = 0.6;

// ---- 事件类型字面量 (与 memory/session.EVENTS 同名; 此处不 import 以避免
//     memory/** 的兄弟改动面与本文件产生耦合 —— 字符串即契约, 有测试守两侧一致) ----
const EV_USER = "user/message";
const EV_ASSISTANT = "assistant/message";
const EV_TOOL_CALL = "tool/call";
const EV_TOOL_RESULT = "tool/result";
const EV_COMPACTION = "compaction/summary";
const CONVERSATION_TYPES = new Set([EV_USER, EV_ASSISTANT]);
const EVIDENCE_TYPES = new Set([EV_TOOL_CALL, EV_TOOL_RESULT]);

// ---- 工具证据的体积闸门 (单条工具结果可达几百 KB, 一律"写时折叠 + 读时再折叠") ----
const EVIDENCE_MARK = "【工具证据】";
const EVIDENCE_RESULT_CHARS = 300;   // 结果摘要落盘上限 (与 _emitToolDone 同口径)
const EVIDENCE_ARGS_CHARS = 160;     // 入参摘要上限 (入参是"做了什么"的第一手证据)
const EVIDENCE_READ_CHARS = 320;     // 投影侧对既有大字段再折叠 (graph.js 旧行可能整段塞 content)
const EVIDENCE_TURN_MAX = 40;        // 单轮采集上限
const EVIDENCE_PENDING_MAX = 120;    // 未落盘证据缓冲上限 (长跑进程防泄漏)
// 无 ALS trace 时 (MCP 直调 _runTool / 测试裸调用) 证据归入此桶, 由下一次 _pushTurn 承接
const EVIDENCE_UNATTRIBUTED = "__unattributed__";
const EVIDENCE_TOKEN_FLOOR = 600;    // 证据在模型可见窗口里的默认总预算 (tok)
const EVIDENCE_SHARE = 0.25;         // 证据预算 = min(FLOOR, history_token_budget * SHARE)

// ---- 压缩保真 (pin-set) ----
// 一个 pin = "摘要无法改写它" 的字面标识符 (路径/URL/ID/哈希/版本/百分比/金额)。
// 散文与单个位数的数字属于"可改写"内容, 不进硬 pin —— 否则任何摘要都过不了闸门,
// 压缩会永久失效 (硬 pin 只收不可改写的高价值标识符, 语义与"工具证据不可抹改"一致)。
const PIN_MAX = 12;                  // 单次折叠的硬 pin 上限
const PIN_ITEM_CHARS = 80;
const PIN_LINE_CHARS = 1200;
const ROLLUP_ITEM_CHARS = 90;        // 确定性重建里每条原文的首行截断
const ROLLUP_MAX_CHARS = 3000;       // 确定性折叠文本上限: 装不下的记录留作原文, 绝不做有损折叠

const PIN_PATTERNS = [
  /https?:\/\/[^\s"'`()<>\u4e00-\u9fff，。；]+/g,
  /[A-Za-z]:[\\/][^\s"'`,;，。；)）]+/g,
  /(?:[\w.-]+[\\/])+[\w.-]+\.[A-Za-z0-9]{1,8}/g,
  /\b[\w.-]+\.(?:js|jsx|ts|tsx|mjs|cjs|py|go|rs|java|kt|cpp|cc|c|h|hpp|md|json|ya?ml|toml|ini|txt|csv|log|sh|ps1|bat|sql|html|css|vue|pdf|docx?|xlsx?|env)\b/g,
  /\b[a-z][a-z0-9_]*[_-][A-Za-z0-9]{6,}\b/g,
  /\b[0-9a-f]{16,40}\b/gi,
  /\bv?\d+(?:\.\d+)+\b/g,
  /\b\d+(?:\.\d+)?%/g,
  /[¥$]\s?\d[\d,.]*/g,
  /\b\d{5,}\b/g,
];

// 头 2/3 + 尾 1/3: 大结果的大部分内容在头部, 但结论/统计常在尾部
function foldText(s, cap) {
  const str = String(s == null ? "" : s);
  if (str.length <= cap) return str;
  const head = Math.max(0, Math.floor(cap * 0.7));
  const tail = Math.max(0, cap - head);
  return str.slice(0, head) + `…[已折叠, 原 ${str.length} 字符]…` + (tail ? str.slice(-tail) : "");
}

function oneLine(s, cap) {
  const str = String(s == null ? "" : s).replace(/\s+/g, " ").trim();
  return str.length <= cap ? str : str.slice(0, cap) + "…";
}

// 事件的"可投影文本" (对话正文 / 证据摘要 / 旧版 graph.js 的 content 字段)
function eventText(e) {
  const d = (e && e.data) || {};
  if (CONVERSATION_TYPES.has(e.type)) return String(d.content == null ? "" : d.content);
  if (e.type === EV_TOOL_RESULT) return String(d.digest ?? d.content ?? d.error ?? "");
  if (e.type === EV_TOOL_CALL) return String(d.args ?? "");
  return String(d.content ?? "");
}

function isPinnedEvent(e) {
  const d = (e && e.data) || {};
  return d.pinned === true || d.keep === true;
}

function evidenceBudgetTokens(cfg) {
  const hist = Number(cfg?.memory?.history_token_budget) || 4000;
  return Math.max(120, Math.min(EVIDENCE_TOKEN_FLOOR, Math.floor(hist * EVIDENCE_SHARE)));
}

export const contextMethods = {
  // ---- 多轮会话历史 (吸收 dsh "会话即事实源") ----
  // 历史从事件日志投影, 再按预算裁剪 (裁剪只发生在投影层, 日志本身不可变)
  // v0.6.6 优化: 信息量感知裁剪 (学自 Claude Code Microcompact 思路)
  //   旧版: 纯按条数硬截 + 尾部 token 预算, 可能裁掉关键决策/工具结果轮次
  //   新版: 优先保留"含关键信息"的轮次(指令/数字/路径/结论/工具结果), 纯寒暄让位
  _historyPriority(m) {
    const s = String(m?.content || "");
    if (!s) return 0;
    // 工具证据行: 价值在"最近做过什么", 承压时优先于闲聊让位、但不至于先于正文被挤掉
    // 工具证据行: 价值在"最近做过什么", 承压时优先于闲聊让位、但不至于先于正文被挤掉
    //   注: 折叠占位行与证据正文同优先级 (-1) —— 条数/token 淘汰的既有语义不因本修复而变形;
    //       "证据被折叠"这件事在投影层 (_projectMessages/_renderUnits) 恒定可见, 压缩自检也按此计数
    if (s.startsWith(EVIDENCE_MARK)) return -1;
    let p = 0;
    // 长消息(含工具结果/详细决策)权重高
    if (s.length > 120) p += 2;
    // 含指令/结论/数字/路径/文件等关键信号
    if (/[查|算|计算|写|建|改|创建|删除|修复|总结|分析|设置|配置|执行|运行|启动|停止|提交|部署|安装|生成|编译|测试]/.test(s)) p += 2;
    if (/[0-9]{2,}|[%.¥$元%]|[:：][0-9]/.test(s)) p += 1;
    if (/[A-Za-z]:[\\\/]|\.(js|py|md|json|txt|ts|go|rs|cpp|java|log)\b/.test(s)) p += 2;
    if (/失败|错误|报错|异常|成功|完成|结果|结论|决定|方案|建议/.test(s)) p += 2;
    // 纯寒暄/简短确认权重低
    if (/^(你好|hi|hello|在吗|谢谢|好的|ok|嗯|是的|对|收到|知道|了解|再见|拜拜)/i.test(s.trim())) p -= 3;
    return p;
  },

  // provider 上下文窗口 -> 历史 token 预算硬上限:
  // 用 llm.context_window(未配置回退 config.memory.context_window) * 安全比例, 与显式预算取小。
  // 目的: 本地小上下文模型即使没配 history_token_budget, 也不会把历史塞爆窗口。
  _histTokenCap() {
    const window = Number(this.llm?.context_window) || Number(this.config?.memory?.context_window) || DEFAULT_CONTEXT_WINDOW;
    const ratio = Number(this.config?.memory?.context_window_ratio) || DEFAULT_CONTEXT_RATIO;
    return Math.max(200, Math.floor(window * ratio));
  },

  // 会话历史裁剪 (中心函数): 条数上限 + token 预算, 信息量感知, 必保最近一条。
  // opts.budget / opts.maxItems 可覆盖 (溢出降档重试时传更紧预算)。
  // token 预算 = min(显式 history_token_budget, 窗口硬上限), 两者都收紧, 取小者。
  _trimHistory(hist, opts = {}) {
    let h = [...hist];
    const maxItems = opts.maxItems != null ? opts.maxItems : (Number(this.config.memory?.max_history_items) || 40);
    const cfgBudget = Number(this.config.memory?.history_token_budget) || 4000;
    const tokenBudget = opts.budget != null ? opts.budget : Math.min(cfgBudget, this._histTokenCap());
    // 1) 条数上限: 超限时按信息量淘汰 (低信息量优先, 从旧到新)
    if (h.length > maxItems) {
      const scored = h.map((m, i) => ({ m, i, p: this._historyPriority(m) }));
      scored.sort((a, b) => (a.p - b.p) || (a.i - b.i));
      const drop = scored.length - maxItems;
      const dropped = new Set(scored.slice(0, drop).map((x) => x.i));
      scored.sort((a, b) => a.i - b.i);
      h = scored.filter((x) => !dropped.has(x.i)).map((x) => x.m);
    }
    // 2) token 预算: 信息量感知裁剪 (替代旧版"丢最旧前缀")
    //    必保最近一条, 其余按信息量从高到低补足, 低信息量轮次让位
    let total = h.reduce((a, m) => a + estimateTokens(m.content), 0);
    if (total > tokenBudget) {
      const keep = new Set();
      let used = 0;
      const lastIdx = h.length - 1;
      keep.add(lastIdx); used += estimateTokens(h[lastIdx].content);
      const rest = h.slice(0, lastIdx)
        .map((m, i) => ({ m, i, p: this._historyPriority(m) }))
        .sort((a, b) => (b.p - a.p) || (a.i - b.i));
      for (const { m, i } of rest) {
        const t = estimateTokens(m.content);
        if (used + t > tokenBudget) continue;
        keep.add(i); used += t;
      }
      h = h.filter((_, i) => keep.has(i));
    }
    return h;
  },

  // 绝对硬裁剪兜底 (第九轮 review P1: 不依赖 LLM 也能保证历史放得下):
  // 在 _trimHistory 基础上再加一道绝对底线 — 超条数则保留最近 N 轮,
  // 超 token 则从最新向前贪心保留到预算内 (最近信息优先, 必保最后一条)。
  // 即便 config 异常 (预算极大/极小的模型), 注入的历史也不会超过窗口安全比例。
  // 注: 钉住(pinned)的证据在压缩闸门里绝不越线, 但本函数是"窗口放不下"时的最后防线,
  //     它按信息量淘汰一切低分项 (证据行 -1) —— 兜底优先于保真, 语义与本修复前一致。
  _ensureContextFit(hist, { budget = this._histTokenCap(), maxItems } = {}) {
    let h = [...hist];
    const itemCap = maxItems != null ? maxItems : (Number(this.config.memory?.max_history_items) || 40);
    // 环节 1: 条数绝对兜底 — 超上限只留最近 itemCap 条
    if (h.length > itemCap) h = h.slice(-itemCap);
    // 环节 2: token 绝对兜底 — 最近优先贪心直到塞满预算 (必保最后一条)
    let total = h.reduce((a, m) => a + estimateTokens(m.content), 0);
    if (total > budget && h.length) {
      const keep = [];
      let used = 0;
      for (let i = h.length - 1; i >= 0; i--) {
        const t = estimateTokens(h[i].content);
        // 至少保留最后一条 (当前对话), 其余超预算跳过
        if (keep.length === 0 || used + t <= budget) {
          keep.unshift(h[i]); used += t;
        }
      }
      h = keep;
    }
    return h;
  },

  // 溢出降档: 把已组好的消息数组按「更紧历史预算」重建 (消息完整性安全版)。
  //  - 保留全部 system (角色/记忆/经验)
  //  - 自最后一条 user 起的一切消息原样保留 (含 in-flight 的 assistant tool_calls + tool 配对,
  //    绝不剪切成"孤立的 tool 消息"导致 API 400)
  //  - 只对最后一条 user 之前的旧历史做最近优先硬裁剪到 budget 内
  _shrinkMessagesForOverflow(messages, budget) {
    let i = 0;
    while (i < messages.length && messages[i] && messages[i].role === "system") i++;
    const systems = messages.slice(0, i);
    const rest = messages.slice(i);
    if (!rest.length) return messages; // 只有 system, 无裁剪空间, 原样返回
    // 从后向前找最后一条 user 作为「进行中单元」起点 (含其后的 tool 配对)
    let lastUser = rest.length - 1;
    while (lastUser > 0 && rest[lastUser].role !== "user") lastUser--;
    const tail = rest.slice(lastUser);          // 完整保留 (结束于 user 或 in-flight 工具单元)
    const mid = rest.slice(0, lastUser);        // 仅剪这里的历史
    const itemCap = Math.max(2, Number(this.config.memory?.max_history_items) || 40);
    const trimmed = this._ensureContextFit(mid, { budget, maxItems: itemCap });
    return [...systems, ...trimmed, ...tail];
  },

  // ================= 工具证据采集 (免调用方改动) =================
  // 证据来源: 运行时总线的 tool/call + tool/result (agent._runTool 每次都发, 成败都发),
  // 成功结果正文另由 PostToolUse 钩子补一份摘要 (该钩子只在成功时触发, 失败正文走总线的 error 字段)。
  // 归属会话: 从 ALS trace 的 sessionKey 取 (与 _turnsUsedTools 同一口径), 并发会话不串台。
  // 注册时机: 本轮任何工具执行之前 —— _loadHistory/_getSession 都在 buildMessages 里先于工具循环被调用,
  //           故首个真实轮次的证据也在采集窗口内 (懒注册, 不改 agent 构造函数/索引文件)。
  _ensureEvidenceCapture() {
    if (!this._evidencePending) this._evidencePending = new Map();
    if (this._evidenceCaptured) return this._evidencePending;
    this._evidenceCaptured = true;
    const unbind = [];
    const bus = this.bus;
    if (bus && typeof bus.on === "function") {
      const offCall = bus.on("tool/call", (ev) => this._captureEvidenceEvent(ev, EV_TOOL_CALL));
      const offResult = bus.on("tool/result", (ev) => this._captureEvidenceEvent(ev, EV_TOOL_RESULT));
      if (typeof offCall === "function") unbind.push(offCall);
      if (typeof offResult === "function") unbind.push(offResult);
    }
    if (this.hooks && typeof this.hooks.on === "function") {
      try {
        const off = this.hooks.on("PostToolUse", (p) => {
          // 纯内存记账, 返回 undefined => 不参与 additionalContext, 不改工具结果
          try { this._captureToolDigest(p); } catch { /* 采集失败绝不影响工具链 */ }
        });
        if (typeof off === "function") unbind.push(off);
      } catch { /* 钩子事件名不认 (旧版注册表) 则只靠总线, 证据降级但不丢正文以外信息 */ }
    }
    this._evidenceUnbind = unbind;
    return this._evidencePending;
  },

  _evidenceSlotKey() {
    // 会话归属与 _turnsUsedTools 同口径: ALS trace 的 sessionKey。
    // trace 缺失 (MCP 直调 _runTool / 测试裸调用) 时归入"未归属"桶, 由下一次 _pushTurn 承接 ——
    // 宁可挂到相邻轮次, 也绝不静默丢掉一份工具证据。
    const t = currentTrace();
    return (t && t.sessionKey) ? String(t.sessionKey) : EVIDENCE_UNATTRIBUTED;
  },

  _pendingEvidence(k) {
    const map = this._ensureEvidenceCapture();
    let list = map.get(k);
    if (!list) { list = []; map.set(k, list); }
    if (list.length > EVIDENCE_PENDING_MAX) list.splice(0, list.length - EVIDENCE_PENDING_MAX);
    return list;
  },

  // 同一次调用的 call/result 按 callId 合并成一个槽位 (落盘时再拆成两条不可变事件)
  _captureEvidenceEvent(ev, expectType) {
    const p = (ev && ev.payload) || {};
    const type = expectType || (ev && ev.type) || "";
    if (!EVIDENCE_TYPES.has(type)) return;
    const list = this._pendingEvidence(this._evidenceSlotKey());
    const callId = p.callId == null ? null : String(p.callId);
    let slot = callId ? list.find((s) => s.callId === callId) : null;
    if (!slot) {
      slot = { callId, tool: p.name || p.tool || null, hasCall: false, hasResult: false };
      list.push(slot);
      if (list.length > EVIDENCE_TURN_MAX * 2) list.splice(0, list.length - EVIDENCE_TURN_MAX * 2);
    }
    if (type === EV_TOOL_CALL) {
      slot.hasCall = true;
      slot.tool = p.name || slot.tool;
      slot.args = p.args;
    } else {
      slot.hasResult = true;
      slot.tool = p.name || slot.tool;
      slot.ok = p.ok !== false;
      slot.durationMs = Number(p.durationMs) || 0;
      if (slot.ok === false && p.error) slot.digest = p.error;
    }
    // 变更类工具 (非幂等 = 往世界上写了东西) 的证据钉住: 压缩永不允许越过它
    try {
      if (typeof this._toolIdempotent === "function" && slot.tool && this._toolIdempotent(slot.tool) === false) {
        slot.pinned = true;
      }
    } catch { /* 元数据查询失败: 不钉住, 证据仍照记 */ }
  },

  // PostToolUse 拿到的是加工后的最终结果正文 (注入标注/病历回灌都在它之前)
  _captureToolDigest(payload) {
    const p = payload || {};
    const callId = p.callId == null ? null : String(p.callId);
    if (!callId) return;
    const list = this._pendingEvidence(this._evidenceSlotKey());
    const slot = list.find((s) => s.callId === callId);
    if (!slot) return;
    slot.digest = typeof p.result === "string" ? p.result : String(p.result == null ? "" : p.result);
    if (slot.ok === undefined) slot.ok = true;
  },

  _takePendingEvidence(k) {
    const map = this._evidencePending;
    if (!map || !map.has(k)) return [];
    const list = map.get(k) || [];
    map.delete(k);
    return list;
  },

  // 采集到的槽位 -> 待落盘事件 (call 与 result 各一条, seq 单调即真实时序)
  // 输入既可以是总线采集的槽位 (hasCall/hasResult), 也可以是调用方显式给出的证据
  // ({tool, args, ok, result|digest, durationMs, callId, pinned}) —— 后者是 handoff 里
  // _persistTurn 直接传权威事实的形状, 两种形状在这里归一, 调用方无需知道槽位概念。
  _evidenceRecords(slots) {
    const out = [];
    for (const s of (Array.isArray(slots) ? slots : [])) {
      if (!s || typeof s !== "object") continue;
      const explicit = s.hasCall === undefined && s.hasResult === undefined;
      const hasCall = explicit ? (s.args !== undefined || s.callId !== undefined) : !!s.hasCall;
      const hasResult = explicit ? ("ok" in s || "result" in s || "digest" in s || "error" in s) : !!s.hasResult;
      if (!hasCall && !hasResult) continue;
      const meta = { tool: s.tool || "tool", callId: s.callId == null ? null : String(s.callId) };
      if (s.pinned === true) meta.pinned = true;
      const argsRaw = s.args == null ? "" : (typeof s.args === "string" ? s.args : safeJson(s.args));
      if (hasCall) out.push({ type: EV_TOOL_CALL, data: { ...meta, args: foldText(argsRaw, EVIDENCE_ARGS_CHARS) } });
      if (hasResult) out.push({
        type: EV_TOOL_RESULT,
        data: {
          ...meta,
          ok: s.ok !== false,
          durationMs: Number(s.durationMs) || 0,
          digest: foldText(s.digest ?? s.result ?? s.error ?? "", EVIDENCE_RESULT_CHARS),
        },
      });
    }
    return out;
  },

  _getSession(sessionKey) {
    // 先信息量感知裁剪, 再 + 绝对硬兜底: 即便 config 异常/压缩失败, 历史也放得下
    const raw = this._projectMessages(sessionKey);
    return this._ensureContextFit(this._trimHistory(raw));
  },

  // 追加一轮对话为不可变事件 (append-only, 永不重写日志)
  // v1.1.1: user+assistant 一次批量落盘 (skipFlush), 一轮对话只写一次磁盘而非两次
  // 2026-10-06: 同批把本轮工具证据 (tool/call + tool/result) 一起落盘 ——
  //   落在 user 与 assistant 之间, 因为这就是真实时序 (先动手, 后说话);
  //   evidence 形参可显式传入 (供调用方/测试给出权威事实), 缺省取总线+钩子采集到的缓冲。
  _pushTurn(sessionKey, userMsg, assistant, evidence) {
    const k = sessionKey || "default";
    this._ensureEvidenceCapture();
    let items = Array.isArray(evidence) && evidence.length ? evidence : this._takePendingEvidence(k);
    if (!items.length) items = this._takePendingEvidence(EVIDENCE_UNATTRIBUTED); // 无 trace 的采集兜底
    const records = this._evidenceRecords(items);
    this.sessionStore.append(k, EV_USER, { content: String(userMsg) }, Date.now(), { skipFlush: true });
    for (const r of records) this.sessionStore.append(k, r.type, r.data, Date.now(), { skipFlush: true });
    if (assistant) this.sessionStore.append(k, EV_ASSISTANT, { content: String(assistant) }, Date.now(), { skipFlush: true });
    this.sessionStore.flush(k);
  },

  // 加载历史: 先尝试结构化压缩(超阈值), 再按预算裁剪
  async _loadHistory(sessionKey) {
    const k = sessionKey || "default";
    this._ensureEvidenceCapture(); // 必须先于本轮任何工具执行完成订阅
    await this._maybeCompact(k);
    return this._getSession(k).map((m) => ({ ...m }));
  },

  // ================= 投影: 事件日志 -> 模型可见窗口 =================
  // 与 sessionStore.deriveCompacted 的分工 (有意为之, 不改 memory/**):
  //   · store 的投影继续服务既有消费者 (deriveCompacted/deriveMessages 语义一字未动);
  //   · 模型可见窗口由本层投影: 对话 + 工具证据 + 压缩摘要, seq 单调, 证据有独立 token 预算。
  // 游标一律按"已落盘的最大 seq"再钳一次: 内存里未落盘的事件不能算进压缩区间。
  _durableMaxSeq(sessionKey) {
    const store = this.sessionStore;
    if (!store) return 0;
    const k = typeof store._safe === "function" ? store._safe(sessionKey) : String(sessionKey || "default");
    try {
      // 首选公共访问器 (见报告 handoff: memory/session.js 应公开 durableMaxSeq(key))
      if (typeof store.durableMaxSeq === "function") {
        const v = Number(store.durableMaxSeq(sessionKey));
        return Number.isFinite(v) ? v : 0;
      }
      // 过渡兜底: 读同一份磁盘游标的既有实现 (只读 8KB 尾, 无副作用)
      if (typeof store._diskMaxSeq === "function") {
        const v = Number(store._diskMaxSeq(k));
        return Number.isFinite(v) ? v : 0;
      }
    } catch { /* 读盘失败退回内存视图, 绝不因此放大游标 */ }
    try {
      const evs = store.replay ? store.replay(sessionKey) : [];
      return evs.length ? Number(evs[evs.length - 1].seq) || 0 : 0;
    } catch { return 0; }
  },

  _durableEvents(sessionKey) {
    const store = this.sessionStore;
    if (!store || typeof store.replay !== "function") return [];
    try { return store.replay(sessionKey) || []; } catch { return []; }
  },

  // 事件流 -> 投影单元 (含配对后的证据单元), 按 (事件数, 尾事件引用) 记忆化。
  // append-only 下尾引用不变即无新增; set/rename/fork 会换数组 -> 尾引用变 -> 整体重算。
  _contextUnits(sessionKey) {
    const k = sessionKey || "default";
    const events = this._durableEvents(k);
    const cache = this._ctxUnitsCache || (this._ctxUnitsCache = new Map());
    const ck = this.sessionStore && typeof this.sessionStore._safe === "function"
      ? this.sessionStore._safe(k) : String(k);
    const tailRef = events.length ? events[events.length - 1] : null;
    const hit = cache.get(ck);
    if (hit && hit.len === events.length && hit.tailRef === tailRef) return hit.units;
    const units = this._buildUnits(k, events);
    cache.set(ck, { len: events.length, tailRef, units });
    return units;
  },

  _buildUnits(sessionKey, events) {
    let lastComp = null;
    let compCount = 0;
    for (const e of events) if (e.type === EV_COMPACTION) { lastComp = e; compCount++; }
    const rawUpTo = Number(lastComp?.data?.upToSeq);
    let upToSeq = Number.isFinite(rawUpTo) ? rawUpTo : 0;
    if (upToSeq > 0) {
      const dm = this._durableMaxSeq(sessionKey);
      // 游标超过已落盘 seq = 日志宣称压掉了盘上还没有的记录 -> 钳回磁盘真相
      if (Number.isFinite(dm) && dm > 0 && upToSeq > dm) upToSeq = dm;
    }
    const items = [];
    if (lastComp && lastComp.data && lastComp.data.summary) {
      items.push({ kind: "summary", seq: lastComp.seq, content: String(lastComp.data.summary) });
    }
    const openCalls = new Map();
    let evidenceTotal = 0;
    for (const e of events) {
      if (!e || e.seq <= upToSeq) continue;
      if (CONVERSATION_TYPES.has(e.type)) {
        items.push({
          kind: "dialogue", seq: e.seq, role: e.type === EV_USER ? "user" : "assistant",
          content: String(e.data?.content == null ? "" : e.data.content), pinned: isPinnedEvent(e),
        });
        continue;
      }
      if (e.type === EV_TOOL_CALL) {
        const unit = { kind: "evidence", seq: e.seq, call: e, result: null, pinned: isPinnedEvent(e) };
        items.push(unit);
        evidenceTotal++;
        const cid = e.data && e.data.callId != null ? String(e.data.callId) : null;
        if (cid) openCalls.set(cid, unit);
        continue;
      }
      if (e.type === EV_TOOL_RESULT) {
        const cid = e.data && e.data.callId != null ? String(e.data.callId) : null;
        const unit = cid ? openCalls.get(cid) : null;
        if (unit && !unit.result) {
          unit.result = e;
          if (isPinnedEvent(e)) unit.pinned = true;
          openCalls.delete(cid);
        } else {
          items.push({ kind: "evidence", seq: e.seq, call: null, result: e, pinned: isPinnedEvent(e) });
          evidenceTotal++;
        }
      }
      // 其它类型 (system / 未知) 保持原有不可见语义, 不擅自进模型窗口
    }
    return { upToSeq, lastCompSeq: lastComp?.seq || 0, items, evidenceTotal, compCount };
  },

  // 单条证据 -> 一行模型可见文本 (call 与 result 合成一行, 这就是"证据不炸窗口"的关键)
  _evidenceLine(unit) {
    const d = (unit.call && unit.call.data) || {};
    const r = (unit.result && unit.result.data) || null;
    const tool = d.tool || (r && r.tool) || "tool";
    const status = !r ? "无回执" : (r.ok === false ? "失败" : "成功");
    const ms = r && Number(r.durationMs) ? ` ${Number(r.durationMs)}ms` : "";
    const cid = d.callId || (r && r.callId) || null;
    const head = `${EVIDENCE_MARK}${tool} ${status}${ms}${cid ? ` #${cid}` : ""}`;
    const args = d.args ? ` 入参=${oneLine(d.args, EVIDENCE_ARGS_CHARS)}` : "";
    // eventText 认的是"事件" (e.data), 不是 data 本身 —— 传错形状会让结果正文静默变成空串
    const body = unit.result ? eventText(unit.result) : "";
    const out = body ? ` 结果=${foldText(body, EVIDENCE_READ_CHARS)}` : "";
    return head + args + out;
  },

  // 单元 -> 模型可见消息数组。证据行有独立 token 预算: 钉住的先占位, 其余从新到旧补足,
  // 被折叠的只数不数内容, 并留一行可判读的占位 (原文仍在事件日志, 压缩/裁剪都不改日志)。
  _renderUnits(units) {
    const items = (units && units.items) || [];
    const cap = evidenceBudgetTokens(this.config);
    const texts = new Map();
    for (const it of items) if (it.kind === "evidence") texts.set(it, this._evidenceLine(it));
    const evidence = items.filter((it) => it.kind === "evidence");
    const keep = new Set();
    let used = 0;
    let pinnedKept = 0;
    for (const it of evidence) { // 钉住的先占位: 它们的预算优先于"最近优先"次序
      if (!it.pinned) continue;
      const t = estimateTokens(texts.get(it));
      keep.add(it); used += t; pinnedKept++;
    }
    for (let i = evidence.length - 1; i >= 0; i--) {
      const it = evidence[i];
      if (keep.has(it)) continue;
      const t = estimateTokens(texts.get(it));
      if (used + t > cap) continue;
      keep.add(it); used += t;
    }
    const folded = evidence.length - keep.size;
    let placeholderDone = false;
    const msgs = [];
    const placeholder = () => {
      if (placeholderDone || !folded) return;
      placeholderDone = true;
      msgs.push({ role: "assistant", content: `${EVIDENCE_MARK}更早 ${folded} 条工具执行记录已按预算折叠 (原文仍在会话事件日志)` });
    };
    for (const it of items) {
      if (it.kind === "summary") { msgs.push({ role: "system", content: it.content }); continue; }
      if (it.kind === "dialogue") { msgs.push({ role: it.role, content: it.content }); continue; }
      if (keep.has(it)) { placeholder(); msgs.push({ role: "assistant", content: texts.get(it) }); }
    }
    if (!placeholderDone && folded) placeholder(); // 一条没留下时占位仍要给, 让模型知道有证据被折叠
    return { msgs, folded, kept: keep.size, pinnedKept, pinnedTotal: evidence.filter((it) => it.pinned).length, cap };
  },

  _projectMessages(sessionKey) {
    const units = this._contextUnits(sessionKey);
    return this._renderUnits(units).msgs;
  },

  // ================= 压缩保真校验 (免模型, 确定性) =================
  _extractPins(records) {
    const seen = new Set();
    const pins = [];
    for (const e of (records || [])) {
      const d = (e && e.data) || {};
      const text = [eventText(e), d.args, d.digest, d.content].filter(Boolean).join(" ");
      for (const re of PIN_PATTERNS) {
        re.lastIndex = 0;
        let m;
        while ((m = re.exec(text)) !== null) {
          const raw = String(m[0] || "").trim();
          if (raw.length < 4) continue;
          const pin = raw.length > PIN_ITEM_CHARS ? raw.slice(0, PIN_ITEM_CHARS) : raw;
          const key = pin.toLowerCase();
          if (seen.has(key)) continue;
          seen.add(key);
          pins.push(pin);
          if (pins.length >= PIN_MAX) return pins;
        }
      }
    }
    return pins;
  },

  _missingPins(summary, pins) {
    const s = String(summary || "");
    return (pins || []).filter((p) => !s.includes(p));
  },

  // 纯函数式校验: 传入"将要成为的整份事件流"与折叠信息, 返回逐项闸门结果。
  // 写前 (候选事件流) 与写后 (durable 日志) 用同一份实现, 两侧口径不可能漂移。
  _fidelityCheck(sessionKey, events, { upToSeq, summary, region = null, durableMax = null, prevSummaryLines = null } = {}) {
    const checks = [];
    const add = (name, ok, detail) => { checks.push({ name, ok: !!ok, detail: detail || "" }); return !!ok; };
    const comps = (events || []).filter((e) => e.type === EV_COMPACTION);
    const dm = Number.isFinite(durableMax) ? durableMax : this._durableMaxSeq(sessionKey);
    const memMax = events && events.length ? events[events.length - 1].seq : 0;

    const comp = comps.length ? comps[comps.length - 1] : null;
    const water = Number.isFinite(upToSeq) ? upToSeq : Number(comp?.data?.upToSeq) || 0;
    add("watermark-durable", !(water > 0 && dm > 0 && water > dm), `upToSeq=${water} durableMax=${dm} memMax=${memMax}`);
    add("watermark-self", !comp || !(water >= comp.seq), comp ? `compSeq=${comp.seq}` : "无压缩事件");
    let mono = true;
    let prev = -1;
    for (const c of comps) {
      const u = Number(c.data?.upToSeq) || 0;
      if (u < prev) mono = false;
      prev = u;
    }
    add("watermark-monotonic", mono, `压缩事件 ${comps.length} 条`);

    // 钉住的记录绝不落在水位线之下 (压缩永不能丢它)
    const pinnedBelow = (events || []).filter((e) => e.type !== EV_COMPACTION && isPinnedEvent(e) && e.seq <= water);
    add("pinned-survives", pinnedBelow.length === 0, pinnedBelow.map((e) => `${e.type}#${e.seq}`).join(","));

    // 硬 pin 必须逐字活过折叠
    const regionRecords = region || (events || []).filter((e) => e.type !== EV_COMPACTION && e.seq <= water);
    const pins = this._extractPins(regionRecords);
    const missing = summary ? this._missingPins(summary, pins) : pins.slice();
    // 注: 违规明细只报计数, 绝不回显 pin/正文原文 (标识符可能是 URL 带参、十六进制串 = 敏感值)
    add("pins-verbatim", missing.length === 0, `pin ${pins.length} 缺 ${missing.length}`);

    // 续载完整: 上一轮折叠正文 (水位线以下记录的唯一可见替身) 必须逐行还在新正文里,
    //   否则"第二次压缩"会把第一次的内容凭空抹掉 —— 确定性路径对此零容忍
    const carry = prevSummaryLines || [];
    const missingCarry = carry.filter((l) => !String(summary || "").includes(l));
    add("rollup-carries-previous", missingCarry.length === 0, `续载 ${carry.length} 行, 缺 ${missingCarry.length} 行`);

    // 工具单元配对完整: 回执在水位线之上而其调用已被折叠 = 孤儿 (入参证据丢失)
    const callsById = new Map();
    for (const e of events || []) if (e.type === EV_TOOL_CALL && e.data?.callId != null) callsById.set(String(e.data.callId), e);
    const orphans = [];
    for (const e of events || []) {
      if (e.type !== EV_TOOL_RESULT || e.seq <= water) continue;
      const cid = e.data && e.data.callId != null ? String(e.data.callId) : null;
      const call = cid ? callsById.get(cid) : null;
      if (call && call.seq <= water) orphans.push(`#${cid}`);
    }
    add("pairing-complete", orphans.length === 0, orphans.slice(0, 5).join(","));

    // 窗口完整性 + 次序: 用同一投影器对候选事件流重投影, 数得对得上
    const units = this._buildUnits(sessionKey, events || []);
    const rendered = this._renderUnits(units);
    const dialogueAbove = (events || []).filter((e) => CONVERSATION_TYPES.has(e.type) && e.seq > units.upToSeq).length;
    const dialogueShown = rendered.msgs.filter((m) => m.role === "user"
      || (m.role === "assistant" && !String(m.content).startsWith(EVIDENCE_MARK))).length;
    add("dialogue-complete", dialogueAbove === dialogueShown, `应有 ${dialogueAbove} 显示 ${dialogueShown}`);
    const evidenceEventsAbove = (events || []).filter((e) => EVIDENCE_TYPES.has(e.type) && e.seq > units.upToSeq).length;
    const evidenceUnits = units.items.filter((it) => it.kind === "evidence");
    add("evidence-accounted",
      evidenceUnits.length <= evidenceEventsAbove && rendered.kept + rendered.folded === evidenceUnits.length,
      `事件 ${evidenceEventsAbove} 单元 ${evidenceUnits.length} 留 ${rendered.kept} 折叠 ${rendered.folded}`);
    // 钉住的证据: 预算之内必须全在窗口里 (预算溢出属于"可见的降级", 由本项把它记成违规而不是静默)
    add("pinned-in-window", rendered.pinnedKept === rendered.pinnedTotal,
      `钉住 ${rendered.pinnedTotal} 显示 ${rendered.pinnedKept}`);
    // 次序: 摘要节点在头部是既有约定 (deriveCompacted 同形), 其余单元必须 seq 单调
    const body = units.items.filter((it) => it.kind !== "summary");
    let mono2 = true;
    for (let i = 1; i < body.length; i++) if (body[i].seq < body[i - 1].seq) mono2 = false;
    add("seq-monotonic", mono2, `单元 ${body.length}`);

    return { ok: checks.every((c) => c.ok), checks, violations: checks.filter((c) => !c.ok), pins: pins.length };
  },

  // 对当前 durable 日志做一次保真体检 (可被外部门/测试直接调用)
  _verifyCompactionFidelity(sessionKey) {
    const k = sessionKey || "default";
    const events = this._durableEvents(k);
    if (!events.length) return { ok: true, checks: [], violations: [], pins: 0, detail: "空会话" };
    let lastComp = null;
    const comps = [];
    for (const e of events) if (e.type === EV_COMPACTION) { lastComp = e; comps.push(e); }
    if (!lastComp) return { ok: true, checks: [], violations: [], pins: 0, detail: "尚无压缩" };
    // 只有确定性路径才要求"逐字续载上一轮正文" (LLM 摘要按设计是改写, 由 pins-verbatim 兜住)
    const prevComp = comps.length >= 2 ? comps[comps.length - 2] : null;
    const prevSummaryLines = (lastComp.data?.method === "deterministic"
      && prevComp && prevComp.data && prevComp.data.summary)
      ? String(prevComp.data.summary).split("\n").map((l) => l.trim())
        .filter((l) => l && !l.startsWith("【上下文折叠"))
      : null;
    return this._fidelityCheck(k, events, {
      upToSeq: Number(lastComp.data?.upToSeq) || 0,
      summary: String(lastComp.data?.summary || ""),
      durableMax: this._durableMaxSeq(k),
      prevSummaryLines,
    });
  },

  // ================= 折叠区域选择 (对话+证据同池, 三道人证闸门) =================
  // tail = 水位线之后所有"可投影"记录 (对话 + 工具证据; 旧实现只认对话 -> 证据被静默丢)
  _compactionTail(events, upToSeq) {
    return (events || []).filter((e) => e && e.seq > upToSeq
      && (CONVERSATION_TYPES.has(e.type) || EVIDENCE_TYPES.has(e.type)));
  },

  // 区域末端绝不切断一个工具单元: 尾部若是没有回执配对的 tool/call, 把它挪回保留区
  _closeRegionUnits(region, kept) {
    const r = [...region];
    const k = [...kept];
    while (r.length) {
      const last = r[r.length - 1];
      if (last.type !== EV_TOOL_CALL) break;
      const cid = last.data && last.data.callId != null ? String(last.data.callId) : null;
      const paired = cid ? r.some((e) => e !== last && e.type === EV_TOOL_RESULT && String(e.data?.callId) === cid) : true;
      if (paired) break;
      k.unshift(r.pop());
    }
    return { region: r, kept: k };
  },

  // 免模型确定性折叠文本: 按字符预算逐条吞入, 装不下的记录留原文 (水位线只推到已吞前缀的末端)
  // -> "有损折叠"在这个路径上结构性不可能: 每条被压掉的记录都在文本里有它自己的行。
  // 关键: 上一轮的折叠正文必须逐字搬进本轮 (水位线以下的旧记录不能因"第二次压缩"而凭空蒸发);
  //       装不下就整体拒绝而不是丢旧正文 —— 确定性路径宁可不再压缩, 不能压缩后失真。
  _deterministicFold(regionRecords, prevSummary = null) {
    const lines = [];
    let used = 0;
    const covered = [];
    const pins = [];
    const seenPin = new Set();
    const pushLine = (s) => {
      const cost = s.length + 1;
      if (used + cost > ROLLUP_MAX_CHARS) return false;
      lines.push(s); used += cost; return true;
    };
    const header = `【上下文折叠·确定性重建】以下记录由免模型路径逐字折叠 (原文仍在会话事件日志, 永不改写):`;
    if (!pushLine(header)) return null;
    // 旧正文逐字续载 (去掉它自己的表头, 保留记录行与标识符行)
    const prevLines = String(prevSummary || "").split("\n")
      .map((l) => l.trim()).filter((l) => l && !l.startsWith("【上下文折叠"));
    for (const l of prevLines) {
      if (!pushLine(l)) return null; // 续载失败 = 预算容不下两次折叠 -> 拒绝本轮, 上一轮正文继续有效
      for (const p of this._extractPins([{ type: EV_ASSISTANT, data: { content: l } }])) {
        if (!seenPin.has(p.toLowerCase()) && pins.length < PIN_MAX) { seenPin.add(p.toLowerCase()); pins.push(p); }
      }
    }
    for (const e of regionRecords) {
      const localPins = this._extractPins([e]);
      const body = oneLine(eventText(e), ROLLUP_ITEM_CHARS);
      let s;
      if (CONVERSATION_TYPES.has(e.type)) s = (e.type === EV_USER ? "- 用户: " : "- 助手: ") + body;
      else if (e.type === EV_TOOL_CALL) s = `- 调用 ${oneLine(e.data?.tool || "tool", 40)} 入参=${body}`;
      else s = `- 回执 ${oneLine(e.data?.tool || "tool", 40)} ${e.data?.ok === false ? "失败" : "成功"} ${body}`;
      // 预演 pin 行: 标识符必须逐字在里面, 放不下就停在"未纳入该记录"之前 (该记录留原文)
      const addPins = localPins.filter((p) => !seenPin.has(p.toLowerCase()));
      const pinCost = addPins.reduce((a, p) => a + p.length + 3, 0);
      if (pins.length + addPins.length > PIN_MAX || used + s.length + pinCost > ROLLUP_MAX_CHARS) break;
      for (const p of addPins) { seenPin.add(p.toLowerCase()); pins.push(p); }
      pushLine(s);
      covered.push(e);
    }
    if (covered.length < 2) return null;
    if (pins.length) {
      const pinLine = oneLine("- 关键标识符(逐字保留): " + pins.join(" | "), PIN_LINE_CHARS);
      lines.splice(1, 0, pinLine);
    }
    const summary = lines.join("\n");
    const missing = this._missingPins(summary, this._extractPins(covered));
    if (missing.length) return null; // 构造上不该发生; 真发生就拒绝折叠而不是产出有损摘要
    return { summary, covered, upToSeq: covered[covered.length - 1].seq, pins: pins.length };
  },

  // 折叠主流程 (LLM 路径与免模型路径共用同一套闸门):
  //  mode=llm          : 模型产摘要 -> pin 闸门不过则拒绝写入 (退化为既有硬裁剪/驱逐)
  //  mode=deterministic: 完全不调模型, 由 _deterministicFold 逐字重建, 天然含全部 pin
  async _compactRegion(sessionKey, { mode = "llm", threshold = true, reason = "auto" } = {}) {
    const k = sessionKey || "default";
    const store = this.sessionStore;
    if (!store || typeof store.append !== "function") return { ok: false, reason: "no-store" };
    // 1) 先把内存里 skipFlush 的待写事件落盘, 让内存视图与磁盘游标对齐
    //    (旧实现在可能过期的 replay() 上直接算 upToSeq, 于是游标可以指向盘上不存在的记录)
    try { store.flush(k); } catch { /* 落盘失败交给下一步的磁盘闸门拒绝压缩 */ }
    const events = this._durableEvents(k);
    if (!events.length) return { ok: false, reason: "empty" };
    const memMax = events[events.length - 1].seq;
    const durableMax = this._durableMaxSeq(k);
    // 2) 磁盘比内存新 = 兄弟进程写过而我们看不见 -> 区域里会有读不到的记录, 本轮拒绝压缩
    if (Number.isFinite(durableMax) && durableMax > memMax) {
      return { ok: false, reason: "stale-replay", durableMax, memMax };
    }
    let upToSeq = 0;
    let prevComp = null;
    for (const e of events) if (e.type === EV_COMPACTION) { upToSeq = Number(e.data?.upToSeq) || 0; prevComp = e; }
    if (upToSeq > durableMax && durableMax > 0) upToSeq = durableMax; // 既有游标越界先钳回真相
    const tail = this._compactionTail(events, upToSeq);
    if (!tail.length) return { ok: false, reason: "nothing-above-watermark" };
    const tokenBudget = Number(this.config.memory?.history_token_budget) || 4000;
    const total = tail.reduce((a, e) => a + estimateTokens(eventText(e)) + estimateTokens(e.data?.args), 0);
    if (threshold && total <= tokenBudget * 1.5) return { ok: false, reason: "under-threshold", total, tokenBudget };
    const split = Math.floor(tail.length / 2);
    let region = tail.slice(0, split);
    let kept = tail.slice(split);
    // 3) 钉住的记录绝不进折叠区: 区域在第一条 pinned 之前停下 (压缩永不能丢它)
    const pinIdx = region.findIndex((e) => isPinnedEvent(e));
    if (pinIdx >= 0) { kept = region.slice(pinIdx).concat(kept); region = region.slice(0, pinIdx); }
    if (region.length < 2) return { ok: false, reason: "pinned-guard" };
    ({ region, kept } = this._closeRegionUnits(region, kept));
    if (region.length < 2) return { ok: false, reason: "too-few-after-pairing" };
    const pins = this._extractPins(region);

    let summary = null;
    let method = null;
    let covered = region;
    let carryLines = []; // 确定性路径: 上一轮折叠正文必须逐字出现在新正文里
    if (mode === "llm") {
      const transcript = transcriptToText(region.map((e) => ({
        role: e.type === EV_USER ? "user" : e.type === EV_ASSISTANT ? "assistant" : "工具",
        content: CONVERSATION_TYPES.has(e.type)
          ? foldText(eventText(e), 400)
          : foldText(this._evidenceLine({
            call: e.type === EV_TOOL_CALL ? e : null,
            result: e.type === EV_TOOL_RESULT ? e : null,
          }), 400),
      })));
      try {
        const r = await this.llm.chat(buildCompactionMessages(transcript), { timeoutMs: AUX_LLM_TIMEOUT_MS, retryMax: 0 });
        summary = r?.content ? String(r.content) : null;
        method = "llm";
      } catch {
        return { ok: false, reason: "llm-failed" }; // 压缩失败静默降级, 交给 _trimHistory 硬裁剪
      }
    } else {
      const prevSummary = prevComp && prevComp.data && prevComp.data.summary ? String(prevComp.data.summary) : null;
      const det = this._deterministicFold(region, prevSummary);
      if (!det) return { ok: false, reason: "deterministic-no-fit" };
      summary = det.summary;
      method = "deterministic";
      covered = det.covered;
      carryLines = prevSummary ? String(prevSummary).split("\n").map((l) => l.trim())
        .filter((l) => l && !l.startsWith("【上下文折叠")) : [];
    }
    // 4) 保真闸门 (免模型, 确定性): 候选事件流先自检, 任一 violation 即不写压缩事件
    const upToSeqNew = Math.min(covered[covered.length - 1].seq, Number.isFinite(durableMax) && durableMax > 0 ? durableMax : covered[covered.length - 1].seq);
    const candidate = [...events, { seq: memMax + 1, ts: Date.now(), type: EV_COMPACTION, data: { summary, upToSeq: upToSeqNew } }];
    const gate = this._fidelityCheck(k, candidate, { upToSeq: upToSeqNew, summary, region: covered, durableMax: memMax, prevSummaryLines: carryLines });
    if (!gate.ok) {
      return {
        ok: false, reason: "fidelity-refused", method, pins: pins.length,
        violations: gate.violations.map((v) => `${v.name}:${v.detail}`),
      };
    }
    store.append(k, EV_COMPACTION, { summary, upToSeq: upToSeqNew, method, pins: pins.length, reason });
    const post = this._verifyCompactionFidelity(k);
    return {
      ok: true, method, upToSeq: upToSeqNew, covered: covered.length,
      pins: pins.length, tokens: estimateTokens(summary), fidelity: post.ok,
      violations: post.violations.map((v) => v.name),
    };
  },

  // 会话压缩: 未压缩部分超 token 阈值时, 把最旧一半压成结构化摘要并持久化到日志
  // (吸收 OpenClaw compaction: 摘要替换被压缩区间, 日志本身不可变)
  // 保持既有对外语义: 无 LLM / 模型不健康 -> 直接跳过 (交给 _trimHistory 硬裁剪), 不写任何事件。
  async _maybeCompact(sessionKey, opts = {}) {
    if (!this.llm) return { ok: false, reason: "no-llm" };
    if (!(await this._auxLlmReady())) return { ok: false, reason: "llm-unhealthy" };
    return this._compactRegion(sessionKey, { mode: opts.mode || "llm", threshold: opts.threshold !== false });
  },

  // 免模型确定性上下文重置 (对标 Codex compact_token_budget: 换一个装得下的窗口, 零总结调用):
  // 全程不碰 this.llm, 只做"逐字前缀折叠 + 游标推进 + 保真校验", 因此 CI 可确定性验证。
  // 复用既有重建机制: 写同一种 compaction/summary 事件, 于是 memory/session.js 的
  // seq 重排 (_rebuildSeqs) 与游标修复 (_repairCompactionCursors / _ensureUniqueSeq) 一行都不用改。
  async resetContextWithoutLlm(sessionKey, opts = {}) {
    const k = sessionKey || "default";
    const before = this._projectMessages(k).length;
    const r = await this._compactRegion(k, {
      mode: "deterministic", threshold: opts.threshold === true, reason: String(opts.reason || "manual"),
    });
    return { ...r, before, after: this._projectMessages(k).length };
  }
};

function safeJson(v) {
  try { return JSON.stringify(v); } catch { return String(v); }
}

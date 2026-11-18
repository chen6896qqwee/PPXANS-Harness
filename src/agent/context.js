// src/agent/context.js - Agent 历史/上下文管理 (从 index.js 拆分, mixin 挂回 prototype)
// 重构第三刀后续 (2026-09-15): 历史裁剪/token 预算/会话压缩从 PPXAgent 类中抽出,
// 方法以 mixin 方式挂回 prototype, 实例行为与调用方完全不变 (测试走 agent._xxx 不受影响)。

import { estimateTokens } from "../utils/text.js";
import { planContextBudget, summarizeBudget } from "./context-budget.js";
import { noteCatch } from "../utils/catch-log.js";
import { compactSession } from "../memory/compact-engine.js";

// 辅助 LLM 调用短超时已随压缩逻辑移入 memory/compact-engine.js (压缩是唯一消费者)
// 上下文窗口感知: 未知窗口的保守默认 (绝不放大历史) + 历史占用窗口的安全比例上限
export const DEFAULT_CONTEXT_WINDOW = 8192;
export const DEFAULT_CONTEXT_RATIO = 0.6;
// system 段占窗口的比例上限 + 字符/token 粗估系数 (供 prompts._systemCharBudget 复用同一口径)
export const DEFAULT_SYSTEM_RATIO = 0.5;
export const CHARS_PER_TOKEN = 1.6;

// v5.0 真 token 预算 (P2.2): 预算键为 0 时按 provider 真实窗口自适应 (配置显式值优先)。
//   旧默认 (40 条 / 4000 tok) 是按 8K 窗口定的保守值 —— 对 128K 窗口的云端模型,
//   上下文利用率只有 ~3%, 大半窗口白白空着。自适应上限有硬帽, 不放大到失控。
function fnv1a(s) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = (h * 0x01000193) >>> 0;
  }
  return h.toString(36);
}

export const contextMethods = {
  // ---- 多轮会话历史 (设计溯源 docs/PROVENANCE.md#dsh "会话即事实源") ----
  // 历史从事件日志投影, 再按预算裁剪 (裁剪只发生在投影层, 日志本身不可变)
  // v0.6.6 优化: 信息量感知裁剪 (学自 Claude Code Microcompact 思路)
  //   旧版: 纯按条数硬截 + 尾部 token 预算, 可能裁掉关键决策/工具结果轮次
  //   新版: 优先保留"含关键信息"的轮次(指令/数字/路径/结论/工具结果), 纯寒暄让位
  _historyPriority(m) {
    const s = String(m?.content || "");
    if (!s) return 0;
    let p = 0;
    // 长消息(含工具结果/详细决策)权重高
    if (s.length > 120) p += 2;
    // 含指令/结论/数字/路径/文件等关键信号
    if (/[查|算|计算|写|建|改|创建|删除|修复|总结|分析|设置|配置|执行|运行|启动|停止|提交|部署|安装|生成|编译|测试]/.test(s)) p += 2;
    if (/[0-9]{2,}|[%.¥$元%]|[:：][0-9]/.test(s)) p += 1;
    // eslint-disable-next-line no-useless-escape
    if (/[A-Za-z]:[\\\/]|\.(js|py|md|json|txt|ts|go|rs|cpp|java|log)\b/.test(s)) p += 2;
    if (/失败|错误|报错|异常|成功|完成|结果|结论|决定|方案|建议/.test(s)) p += 2;
    // 纯寒暄/简短确认权重低
    if (/^(你好|hi|hello|在吗|谢谢|好的|ok|嗯|是的|对|收到|知道|了解|再见|拜拜)/i.test(s.trim())) p -= 3;
    return p;
  },

  // 工具 schema 的 token 开销 (架构优化 ④ 消费侧, 2026-11-16):
  //   曝光名单在一次装配内恒定, 按 (数量 + 名字序列) 做键缓存; 每轮只做一次 O(n) 拼接,
  //   不重复 JSON.stringify 十几 KB 的 schema。
  _toolSchemaTokens() {
    try {
      const exposed = this.tools?.toOpenAI?.() || [];
      const key = exposed.length + ":" + exposed.map((t) => t?.function?.name || "").join(",");
      if (this._toolSchemaTokensCache?.key === key) return this._toolSchemaTokensCache.tokens;
      const tokens = estimateTokens(JSON.stringify(exposed));
      this._toolSchemaTokensCache = { key, tokens };
      return tokens;
    } catch { return 0; }
  },

  // 本轮固定开销 (token): tools schema (缓存) + system (本轮 _context 实测, 未装配则按
  //   预算上限保守估计)。历史预算从这里扣 —— 固定开销不是"别人的事"。
  _fixedContextTokens() {
    const stats = this._lastContextStats || {};
    const toolTokens = Number.isFinite(stats.toolTokens) ? stats.toolTokens : this._toolSchemaTokens();
    const systemTokens = Number.isFinite(stats.systemTokens)
      ? stats.systemTokens
      : Math.ceil(this._systemCharBudget() / CHARS_PER_TOKEN);
    return { tools: toolTokens, system: systemTokens };
  },

  // 历史 token 预算 (单一入口): legacy 公式与全局配额规划取小。
  //   2026-11-16 (架构优化 ④ 落地): 旧实现只按 window*0.3 给历史发预算, tools/system
  //   的真实开销不进账 —— 小窗口 + 大 schema 时"公式说放得下, 实际必 400"。
  //   现在用 planContextBudget 把窗口切块, 历史额度 = min(legacy, planned):
  //     · 只收紧不放大 —— 大窗口下现网行为不变 (planned >= legacy);
  //     · 固定开销超出配额时按既定让位顺序从记忆/历史扣;
  //     · memory.adaptive_budget=false 可回退纯 legacy (逃生开关, 行为逐字不变)。
  _historyBudget() {
    const cfgBudgetRaw = Number(this.config.memory?.history_token_budget);
    const legacy = Math.min(cfgBudgetRaw > 0 ? cfgBudgetRaw : this._autoHistoryBudget(), this._histTokenCap());
    if (this.config.memory?.adaptive_budget === false) return legacy;
    const window = Number(this.llm?.context_window) || Number(this.config?.memory?.context_window) || DEFAULT_CONTEXT_WINDOW;
    let plan = null;
    try {
      plan = planContextBudget({ window, fixed: this._fixedContextTokens() });
    } catch { /* 规划失败退回 legacy, 预算体检不得阻断主链 */ }
    if (!plan) return legacy;
    // 硬约束口径: 历史最多能占 = 窗口 − 输出预留 − tools − system − 记忆预留。
    //   不用 plan.sections.history 原值 —— 那是"配额建议值"(0.3 份额), 直接取会在大窗口下
    //   无端砍掉 20% 历史。这里只回答一个问题: 现网 formula 会不会超窗?
    //   不会 → 保持 legacy (行为不变); 会 → 收到放得下的最大值, 但不超过 legacy。
    const s = plan.sections;
    const fixed = Number(s.output) + (Number(s.fixedTools) || 0) + (Number(s.fixedSystem) || 0);
    const memoryReserve = Math.min(Number(s.memory) || 0, Math.max(0, window - fixed - 2000));
    const maxFit = window - fixed - memoryReserve;
    return Math.max(200, Math.min(legacy, Math.max(plan.sections.history, maxFit)));
  },

  // provider 上下文窗口 -> 历史 token 预算硬上限:
  // 用 llm.context_window(未配置回退 config.memory.context_window) * 安全比例, 与显式预算取小。
  // 目的: 本地小上下文模型即使没配 history_token_budget, 也不会把历史塞爆窗口。
  _histTokenCap() {
    const window = Number(this.llm?.context_window) || Number(this.config?.memory?.context_window) || DEFAULT_CONTEXT_WINDOW;
    const ratio = Number(this.config?.memory?.context_window_ratio) || DEFAULT_CONTEXT_RATIO;
    return Math.max(200, Math.floor(window * ratio));
  },

  // v5.0 自适应预算 (P2.2): history_token_budget / max_history_items 配 0 = 随窗口自适应。
  _autoHistoryBudget() {
    const window = Number(this.llm?.context_window) || Number(this.config?.memory?.context_window) || DEFAULT_CONTEXT_WINDOW;
    return Math.max(2000, Math.min(24000, Math.floor(window * 0.3)));
  },
  _autoMaxItems() {
    const window = Number(this.llm?.context_window) || Number(this.config?.memory?.context_window) || DEFAULT_CONTEXT_WINDOW;
    if (window >= 64000) return 80;
    if (window >= 32000) return 60;
    return 40;
  },

  // 架构优化 ④(2026-11-13): 全局配额体检 (只读)。
  //   历史预算仍走既有公式 (不在这里改行为), 但把 tools schema 的真实开销算进去,
  //   溢出时给出"该从哪让位"的顺序 —— 以前只能等 provider 报 400 才知道超窗。
  contextBudget() {
    const window = Number(this.llm?.context_window) || Number(this.config?.memory?.context_window) || DEFAULT_CONTEXT_WINDOW;
    // 2026-11-16: 体检与消费同源 —— fixed 必须包含 system 实测, 否则报告里"历史还有多少"
    //   会系统性偏大 (report 说放得下, 实际 _historyBudget 已经收紧)。
    const fixed = this._fixedContextTokens();
    const plan = planContextBudget({ window, fixed });
    const legacyHistory = Math.min(this._autoHistoryBudget(), this._histTokenCap());
    return {
      ...plan,
      sections: { ...plan.sections, history: legacyHistory, plannedHistory: plan.sections.history },
      legacyHistory,
      summary: summarizeBudget(plan),
    };
  },

  // 会话历史裁剪 (中心函数): 条数上限 + token 预算, 信息量感知, 必保最近一条。
  // opts.budget / opts.maxItems 可覆盖 (溢出降档重试时传更紧预算)。
  // token 预算 = min(显式 history_token_budget, 窗口硬上限), 两者都收紧, 取小者。
  // v5.0 (P2.2 链式召回二期): 被裁掉的旧轮次 ≥1500 字符时全文归档 spill (确定性 id,
  //   同一批只归档一次), 首次归档当轮在时间线尾部插一条带 spill_id 的续读提示 ——
  //   "被裁历史"从死路变成 context_read 可续读 (与工具结果 spill 同语义)。
  _trimHistory(hist, opts = {}) {
    let h = [...hist];
    const maxItemsCfg = Number(this.config.memory?.max_history_items);
    const maxItems = opts.maxItems != null ? opts.maxItems : (maxItemsCfg > 0 ? maxItemsCfg : this._autoMaxItems());
    // 2026-11-16: 预算统一走 _historyBudget (legacy 与全局配额规划取小), 不再各自拼公式
    const tokenBudget = opts.budget != null ? opts.budget : this._historyBudget();
    const before = h;
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
    const archived = this._archiveTrimmedHistory(before, h);
    return archived ? [...h, archived] : h;
  },

  // 归档被裁历史 (链式召回二期): 摘出本轮被裁的消息, 内容够大才归档 (确定性 id,
  //   同一批只归档一次); 归档成功且**本次新建**才返回续读提示消息 (老归档不重复提示,
  //   避免每轮投影都插一条噪音)。失败静默返回 null —— 归档是增强, 不是依赖。
  _archiveTrimmedHistory(before, after) {
    try {
      if (!Array.isArray(before) || after.length >= before.length) return null;
      const kept = new Set(after);
      const dropped = before.filter((m) => !kept.has(m));
      const text = dropped.map((m) => (m.role === "user" ? "用户: " : "皮皮虾: ") + String(m.content || "")).join("\n\n");
      if (text.length < 1500) return null;
      const spill = this._spillStore?.();
      if (!spill || typeof spill.putWithId !== "function") return null;
      const id = `hs-${fnv1a(text)}`;
      const r = spill.putWithId(id, text, { tool: "history", sessionKey: this._activeSessionKey || "" });
      if (!r || !r.created) return null; // 已归档过: 不再插提示 (每轮投影都到这里, 不能刷屏)
      return {
        role: "user",
        content: `[系统] 更早的 ${dropped.length} 轮对话超出上下文预算被裁剪, 全文 ${text.length} 字符已归档 (spill_id=${id})。需要时用 context_read 工具按 id 续读。`,
      };
    } catch (e) { noteCatch(e); return null; }
  },

  // 把消息序列按「不可拆单元」分组: assistant(tool_calls) + 紧随其后的 tool 结果 = 一组。
  // 2026-11-12 修复: 溢出降档时按消息贪心裁剪会把 assistant(tool_calls) 与 tool 结果拆开,
  //   留下一串孤立 tool 消息 —— OpenAI 兼容后端直接 400, 降档反而让整轮硬失败。
  //   孤立 tool (前一条不是本组的 assistant call) 单独成组并标记不可保留: 它已无配对, 留着必 400。
  _historyUnits(list) {
    const units = [];
    for (let i = 0; i < list.length; i++) {
      const m = list[i];
      if (m && m.role === "assistant" && Array.isArray(m.tool_calls) && m.tool_calls.length) {
        const unit = [m];
        let j = i + 1;
        while (j < list.length && list[j] && list[j].role === "tool") { unit.push(list[j]); j++; }
        units.push({ msgs: unit, orphan: false });
        i = j - 1;
      } else if (m && m.role === "tool") {
        units.push({ msgs: [m], orphan: true });
      } else {
        units.push({ msgs: [m], orphan: false });
      }
    }
    return units;
  },

  // 绝对硬裁剪兜底 (第九轮 review P1: 不依赖 LLM 也能保证历史放得下):
  // 在 _trimHistory 基础上再加一道绝对底线 — 超条数则保留最近 N 轮,
  // 超 token 则从最新向前贪心保留到预算内 (最近信息优先, 必保最后一条)。
  // 即便 config 异常 (预算极大/极小的模型), 注入的历史也不会超过窗口安全比例。
  // 以「tool_calls 单元」为最小裁剪粒度, 保证永远不产出孤立 tool 消息 (见 _historyUnits)。
  _ensureContextFit(hist, { budget = this._historyBudget(), maxItems } = {}) {
    let units = this._historyUnits(hist);
    const itemCapCfg = Number(this.config.memory?.max_history_items);
    const itemCap = maxItems != null ? maxItems : (itemCapCfg > 0 ? itemCapCfg : this._autoMaxItems());
    // 环节 1: 条数绝对兜底 — 超上限只留最近 itemCap 组
    if (units.length > itemCap) units = units.slice(-itemCap);
    // 环节 2: token 绝对兜底 — 最近优先贪心直到塞满预算 (必保最后一组)
    const cost = (u) => u.msgs.reduce((a, m) => a + estimateTokens(m.content), 0);
    let total = units.reduce((a, u) => a + cost(u), 0);
    if (total > budget && units.length) {
      const keep = [];
      let used = 0;
      for (let i = units.length - 1; i >= 0; i--) {
        const u = units[i];
        const t = cost(u);
        // 至少保留最后一组 (当前对话); 孤立 tool 组永不保留 (无配对 = 必 400)
        if ((keep.length === 0 && !u.orphan) || (!u.orphan && used + t <= budget)) {
          keep.unshift(u); used += t;
        }
      }
      units = keep;
    }
    return units.flatMap((u) => u.msgs);
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

  _getSession(sessionKey) {
    // 先信息量感知裁剪, 再 + 绝对硬兜底: 即便 config 异常/压缩失败, 历史也放得下
    const raw = this.sessionStore.deriveCompacted(sessionKey || "default");
    return this._ensureContextFit(this._trimHistory(raw));
  },

  // 追加一轮对话为不可变事件 (append-only, 永不重写日志)
  // v1.1.1: user+assistant 一次批量落盘 (skipFlush), 一轮对话只写一次磁盘而非两次
  _pushTurn(sessionKey, userMsg, assistant) {
    const k = sessionKey || "default";
    this.sessionStore.append(k, "user/message", { content: String(userMsg) }, Date.now(), { skipFlush: true });
    if (assistant) this.sessionStore.append(k, "assistant/message", { content: String(assistant) }, Date.now(), { skipFlush: true });
    this.sessionStore.flush(k);
  },

  // 加载历史: 先尝试结构化压缩(超阈值), 再按预算裁剪
  async _loadHistory(sessionKey) {
    const k = sessionKey || "default";
    await this._maybeCompact(k);
    return this._getSession(k).map((m) => ({ ...m }));
  },

  // 会话压缩: 未压缩部分超 token 阈值时, 把最旧一半压成结构化摘要并持久化到日志
  // (设计溯源 docs/PROVENANCE.md#openclaw compaction: 摘要替换被压缩区间, 日志本身不可变)
  // 会话压缩 (架构优化 ⑨): 逻辑搬进 memory/compact-engine.js —— 事件/锁/保真/归档都在那边。
  //   这里只给预算与策略: 上下文侧不做保真闸门 (保留原行为), 归档开着。
  async _maybeCompact(sessionKey) {
    if (!this.llm) return;
    if (!(await this._auxLlmReady())) return; // 模型不可用时跳过压缩 (交给 _trimHistory 硬裁剪)
    const rawBudget = Number(this.config.memory?.history_token_budget);
    return compactSession(this, {
      sessionKey,
      budget: rawBudget > 0 ? rawBudget : this._historyBudget(),
      reason: "context",
      fidelity: false,
      archive: true,
    });
  }
};

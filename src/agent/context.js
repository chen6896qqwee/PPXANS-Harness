// src/agent/context.js - Agent 历史/上下文管理 (从 index.js 拆分, mixin 挂回 prototype)
// 重构第三刀后续 (2026-09-15): 历史裁剪/token 预算/会话压缩从 PPXAgent 类中抽出,
// 方法以 mixin 方式挂回 prototype, 实例行为与调用方完全不变 (测试走 agent._xxx 不受影响)。

import { estimateTokens } from "../utils/text.js";
import { transcriptToText, buildCompactionMessages } from "../memory/compaction.js";

// 辅助 LLM 调用短超时 (压缩/提炼等非主对话调用):
// 模型不可用/网络不通时快速失败降级, 避免阻塞主对话
const AUX_LLM_TIMEOUT_MS = 10000;
// 上下文窗口感知: 未知窗口的保守默认 (绝不放大历史) + 历史占用窗口的安全比例上限
const DEFAULT_CONTEXT_WINDOW = 8192;
const DEFAULT_CONTEXT_RATIO = 0.6;

export const contextMethods = {
  // ---- 多轮会话历史 (吸收 dsh "会话即事实源") ----
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
  // (吸收 OpenClaw compaction: 摘要替换被压缩区间, 日志本身不可变)
  async _maybeCompact(sessionKey) {
    if (!this.llm) return;
    if (!(await this._auxLlmReady())) return; // 模型不可用时跳过压缩 (交给 _trimHistory 硬裁剪)
    const events = this.sessionStore.replay(sessionKey);
    let upToSeq = 0;
    for (const e of events) if (e.type === "compaction/summary") upToSeq = e.data?.upToSeq || 0;
    const tail = events.filter((e) => e.seq > upToSeq && (e.type === "user/message" || e.type === "assistant/message"));
    if (!tail.length) return;
    const tokenBudget = Number(this.config.memory?.history_token_budget) || 4000;
    const total = tail.reduce((a, e) => a + estimateTokens(e.data?.content), 0);
    if (total <= tokenBudget * 1.5) return; // 未超阈值不压缩
    const split = Math.floor(tail.length / 2);
    const old = tail.slice(0, split);
    if (old.length < 2) return; // 太少不值得压
    const lastSeq = old[old.length - 1].seq;
    const transcript = transcriptToText(old.map((e) => ({ role: e.type === "user/message" ? "user" : "assistant", content: e.data?.content })));
    try {
      const r = await this.llm.chat(buildCompactionMessages(transcript), { timeoutMs: AUX_LLM_TIMEOUT_MS, retryMax: 0 });
      const summary = r?.content;
      if (summary) this.sessionStore.append(sessionKey, "compaction/summary", { summary, upToSeq: lastSeq });
    } catch {
      // 压缩失败静默降级, 交给 _trimHistory 硬裁剪
    }
  }
};

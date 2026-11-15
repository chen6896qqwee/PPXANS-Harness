// src/agent/turn-record.js — 单轮落库 / 证据归档 / 轮内草稿 (2026-11-03 从 index.js 下沉)
// 行为与拆分前完全一致; 以 prototype descriptor 方式挂回 PPXAgent, 调用方无感知.
import { currentTrace } from "../core/trace.js";

class TurnRecordMixin {
  // 单轮落库公共路径 (chat / chatStream 共用, 2026-09-18 重构去重):
  //   会话事件日志追加 → L0/L1 记忆写入 → (可选) 记忆升降级协调 (L2 归档/经验学习/L3 画像刷新)
  // 注意: 写入的始终是"模型原文" —— 用户可见的降级提示由调用方在落库之后再拼接。
  // 2026-10-10: 同时把"本轮证据 + 轮内中间草稿"交给 memory.recordTurn, 落进 memory/turns 的
  //   可重建上下文档。桶在进入本方法时立即排空 —— 即便 recordTurn 抛错, 本轮残渣也不留给下一轮。
  async _persistTurn(sessionKey, userMsg, assistantText, { afterTurn = false, historyText = null } = {}) {
    const k = sessionKey || "default";
    const drafts = this._takeDrafts(k);
    const pending = (this._evidencePending && this._evidencePending.get(k)) || [];
    // 采集器把 call/result 合并成一条 (按 callId); 归档层按 e.type 分类, 故此处拆回
    // "tool/call + tool/result" 两条; args 序列化为 JSON 字符串 (可读载体, 投影侧再 parse)。
    const evidence = this._evidenceForArchive(pending);
    // v4.2: historyText = 本轮 user 消息的 wire 形态 (含 L2 分流提示块) —— 会话历史按它落库,
    //   保证下一轮重建的 wire 历史与上一轮真实所见逐字节一致 (append-only 契约, cache-audit 门禁);
    //   记忆抽取 (memory.recordTurn / afterTurn) 仍用原文, 提示块不进记忆。
    this._pushTurn(k, String(historyText ?? userMsg), assistantText, pending);
    await this.memory.recordTurn(userMsg, assistantText, { drafts, evidence, sessionKey: k });
    if (afterTurn) {
      this.bus?.emit("memory/record", { userMsg, reply: assistantText }, { source: "agent.chat" });
      this.memorySvc.afterTurn(userMsg, assistantText);
    }
  }

  // 把采集器的合并条目展开成带 type 的归档条目 (memory/turns 消费)
  _evidenceForArchive(pending) {
    const out = [];
    for (const e of (Array.isArray(pending) ? pending : [])) {
      if (!e || typeof e !== "object") continue;
      if (e.type) { out.push(e); continue; }
      const callId = e.callId != null ? String(e.callId) : undefined;
      let argsTxt = "";
      if (e.args && typeof e.args === "object") { try { argsTxt = JSON.stringify(e.args); } catch { argsTxt = ""; } }
      else if (typeof e.args === "string") argsTxt = e.args;
      out.push({ type: "tool/call", tool: e.tool, callId, args: argsTxt });
      out.push({
        type: "tool/result", tool: e.tool, callId,
        ok: e.ok !== false, durationMs: e.durationMs || 0,
        result: e.result ?? e.extra ?? "", error: e.error ?? null,
      });
    }
    return out;
  }

  // 取走并清空某会话的轮内草稿桶 (幂等: 不存在即空数组)
  _takeDrafts(sessionKey) {
    const k = sessionKey || "default";
    if (!this._draftPending) return [];
    const arr = this._draftPending.get(k) || [];
    this._draftPending.delete(k);
    return arr;
  }

  // 记录一条轮内中间草稿 (只留文本 + 工具名, 不留工具入参值): 由工具循环的 onAssistantMsg 回调驱动
  // 2026-11-01 (二期②): 附带 thinking (该轮推理模型思考链, 截 2000 字符, 供记忆归档诊断用)
  // 2026-11-03: policy 的 onAssistantMsg 传的字段名是 reasoning —— 此前这里只认 thinking,
  //   思考链每轮都被静默丢弃。两个名字都收, 调用方不必猜。
  _recordDraft({ content = "", toolCalls = [], thinking = null, reasoning = null, sessionKey = null } = {}) {
    const text = String(content || "").replace(/\r/g, "").trim();
    if (!text) return;
    if (!this._draftPending) this._draftPending = new Map();
    const k = sessionKey || currentTrace()?.sessionKey || this._activeSessionKey || "default";
    const arr = this._draftPending.get(k) || [];
    const tools = (Array.isArray(toolCalls) ? toolCalls : [])
      .map((tc) => tc?.function?.name || tc?.name)
      .filter(Boolean);
    const think = thinking || reasoning;
    // 条数封顶 (与 memory-ticker.TURN_ARCHIVE_ITEMS 同量级): 防长跑轮次把桶撑爆
    arr.push({ text, tools, ...(think ? { thinking: String(think).slice(0, 2000) } : {}) });
    if (arr.length > 24) arr.splice(0, arr.length - 24);
    this._draftPending.set(k, arr);
  }
}

const d = Object.getOwnPropertyDescriptors(TurnRecordMixin.prototype);
delete d.constructor;
export const turnRecordMethods = d;

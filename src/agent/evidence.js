// src/agent/evidence.js - 工具证据进上下文 + 压缩保真 + 免模型确定性重置 (mixin)
// 病根 (2026-10-06 审计, 2026-10-10 落地): context.js 三处"只认 user/assistant" = 结构性失忆:
//   _pushTurn 不落工具证据 -> _maybeCompact 的 tail 只认对话 -> deriveCompacted 也只认对话。
//   结果: 压缩后/重启后 agent 只记得说过什么, 不记得做过什么。
// 本模块补齐:
//   · _pushTurn 把 tool/call + tool/result 落进会话日志 (时序 user < call < result < assistant)
//   · _contextUnits / _renderUnits / _projectMessages: 证据进模型可见窗口, 有子预算 + 可见折叠
//   · _maybeCompact: LLM 摘要丢失字面标识符 (pin) 就拒绝压缩 (退化为硬裁剪, 绝不静默丢证据)
//   · _compactRegion / resetContextWithoutLlm: 免模型确定性折叠 (零 LLM 调用)
//   · _verifyCompactionFidelity: 写后/重启后 durable 保真自检 (pin 存活/钉住存活/配对完整/续载)
// 零依赖, 全离线可测。
import { estimateTokens } from "../utils/text.js";
import { EVENTS } from "../memory/session.js";
import { transcriptToText, buildCompactionMessages } from "../memory/compaction.js";
import { currentTrace } from "../core/trace.js";
import { debug } from "../utils/logger.js";

const EVIDENCE_MARK = "【工具证据】";
const AUX_LLM_TIMEOUT_MS = 10000;

// 单个工具结果落盘/展示时的折叠 (头 70% + 尾 30% + 可见占位), 与 memory-ticker 同形
function foldText(s, budget) {
  const t = String(s ?? "");
  if (t.length <= budget) return t;
  const head = Math.floor(budget * 0.7);
  const tail = budget - head;
  return t.slice(0, head) + ` …(已折叠 ${t.length - budget} 字符)… ` + t.slice(-tail);
}

// 会话事件里 tool/call 的 args 是 JSON 字符串 (可读载体); 投影时解析成对象。
// 向后兼容: 若历史事件里是对象 (旧格式), 原样返回。
function _parseArgs(a) {
  if (a && typeof a === "object") return a;
  if (typeof a === "string") { try { const o = JSON.parse(a); return o && typeof o === "object" ? o : {}; } catch { return {}; } }
  return {};
}

export const evidenceMethods = {
  // ---- 证据采集: 总线 + PostToolUse 钩子 ----
  // 采集缓冲 (sessionKey -> [{tool, callId, args, ok, durationMs, result, digest, extra}])
  // 懒注册订阅 (首次 _loadHistory/_pushTurn 时), 幂等。
  _ensureEvidenceCollectors() {
    if (this._evidenceCollectorsInstalled) return;
    this._evidenceCollectorsInstalled = true;
    this._evidencePending ||= new Map();
    const bucketOf = () => {
      const t = currentTrace();
      return (t && t.sessionKey) || this._activeSessionKey || "default";
    };
    const upsert = (patch) => {
      const k = bucketOf();
      const arr = this._evidencePending.get(k) || [];
      let item;
      if (patch.callId) item = arr.find((x) => x.callId === patch.callId);
      if (!item) { item = { callId: patch.callId || `anon-${arr.length}-${Math.random().toString(36).slice(2, 6)}` }; arr.push(item); }
      // 逐字段合并而非整对象覆盖: tool/result 常带 `args: {}` (空壳), 不得把 tool/call 存的入参覆盖掉
      for (const [key, val] of Object.entries(patch)) {
        if (key === "args") {
          if (val && Object.keys(val).length) item.args = val; // 只在非空时更新
          continue;
        }
        item[key] = val;
      }
      this._evidencePending.set(k, arr);
    };
    try {
      this.bus?.on("tool/call", (ev) => {
        const p = ev?.payload || {};
        upsert({ tool: p.name, callId: p.callId, args: p.args || {} });
      });
      this.bus?.on("tool/result", (ev) => {
        const p = ev?.payload || {};
        upsert({ tool: p.name, callId: p.callId, ok: p.ok !== false, durationMs: p.durationMs || 0, error: p.error || null });
      });
    } catch { /* 总线不可用: 采集降级, 不影响主链 */ }
    try {
      this.hooks?.on("PostToolUse", (p) => {
        // PostToolUse 的 result 是补到的正文摘要 (真实产物文本); 归到同一 callId
        upsert({ tool: p?.tool, callId: p?.callId, extra: String(p?.result ?? "") });
        return null;
      });
    } catch { /* 钩子不可用: 采集降级 */ }
  },

  // 加载历史: 先尝试结构化压缩(超阈值), 再按预算裁剪。
  // 2026-10-10: 这里是"懒注册"采集器的挂点 (buildMessages 必然先跑它) —— 注册订阅并把
  //   当前会话记为活跃, 于是之后不带 trace 的总线事件也能正确归桶。
  async _loadHistory(sessionKey) {
    const k = sessionKey || "default";
    this._ensureEvidenceCollectors();
    this._activeSessionKey = k;
    await this._maybeCompact(k);
    return this._getSession(k).map((m) => ({ ...m }));
  },

  // ---- 落盘: 一轮对话 (+ 可选证据) 写成不可变事件 ----
  _pushTurn(sessionKey, userMsg, assistant, evidence) {
    const k = sessionKey || "default";
    this._ensureEvidenceCollectors();
    const pending = this._evidencePending.get(k) || [];
    this._evidencePending.set(k, []); // 本轮证据到此排空, 不留到下一轮
    const list = (Array.isArray(evidence) && evidence.length) ? evidence : pending;
    this.sessionStore.append(k, EVENTS.USER, { content: String(userMsg) }, Date.now(), { skipFlush: true });
    for (const e of list) {
      const callId = e.callId || `c${this.sessionStore.count(k)}`;
      const args = e.args || {};
      const pinned = e.pinned === true;
      this.sessionStore.append(k, EVENTS.TOOL_CALL, {
        // args 落盘为 JSON 字符串 (证据本体的可读载体; 事件里恒为字符串, 投影侧解析)
        tool: e.tool, callId, args: JSON.stringify(args), ...(pinned ? { pinned: true } : {}),
      }, Date.now(), { skipFlush: true });
      const digest = e.error != null
        ? String(e.error).slice(0, 300)
        : foldText(e.result ?? e.extra ?? "", 260);
      this.sessionStore.append(k, EVENTS.TOOL_RESULT, {
        tool: e.tool, callId, ok: e.ok !== false, digest,
        durationMs: e.durationMs || 0, error: e.error != null ? String(e.error).slice(0, 300) : null,
        ...(pinned ? { pinned: true } : {}),
      }, Date.now(), { skipFlush: true });
    }
    if (assistant) this.sessionStore.append(k, EVENTS.ASSISTANT, { content: String(assistant) }, Date.now(), { skipFlush: true });
    this.sessionStore.flush(k);
  },

  // ---- 投影单元: 日志 -> 有序单元 (summary / user / assistant / evidence) ----
  _contextUnits(sessionKey) {
    const k = sessionKey || "default";
    const evs = this.sessionStore.replay(k);
    let upToSeq = 0, lastComp = null;
    for (const e of evs) if (e.type === EVENTS.COMPACTION) { upToSeq = e.data?.upToSeq || 0; lastComp = e; }
    const items = [];
    if (lastComp?.data?.summary) {
      items.push({ kind: "summary", seq: lastComp.seq, role: "system", content: String(lastComp.data.summary) });
    }
    const calls = new Map();
    const paired = new Set();
    for (const e of evs) {
      if (e.seq <= upToSeq) continue;
      if (e.type === EVENTS.USER) items.push({ kind: "user", seq: e.seq, role: "user", content: e.data?.content });
      else if (e.type === EVENTS.ASSISTANT) items.push({ kind: "assistant", seq: e.seq, role: "assistant", content: e.data?.content });
      else if (e.type === EVENTS.TOOL_CALL) calls.set(e.data?.callId ?? `s${e.seq}`, e);
      else if (e.type === EVENTS.TOOL_RESULT) {
        const id = e.data?.callId ?? `s${e.seq}`;
        const call = calls.get(id);
        if (call) paired.add(id);
        items.push(this._evidenceUnit(e, call));
      }
    }
    // 只有 call 没有 result: 也投影 (显示"无回执"), 绝不静默丢
    for (const [id, call] of calls) {
      if (paired.has(id)) continue;
      items.push(this._evidenceUnit(null, call));
    }
    items.sort((a, b) => a.seq - b.seq);
    const cap = Math.max(120, Math.floor(this._histTokenCap() * 0.25));
    return { items, cap };
  },

  _evidenceUnit(resultEv, callEv) {
    const seq = callEv ? callEv.seq : resultEv.seq;
    const tool = resultEv?.data?.tool || callEv?.data?.tool || "tool";
    const args = _parseArgs(callEv?.data?.args);
    const ok = resultEv ? resultEv.data?.ok !== false : false;
    let body = "";
    if (resultEv) {
      body = String(resultEv.data?.digest ?? resultEv.data?.content ?? "");
      if (resultEv.data?.error) body = String(resultEv.data.error);
    }
    const argsTxt = Object.entries(args).slice(0, 4)
      .filter(([, v]) => v != null && v !== "")
      .map(([kk, v]) => `${kk}=${String(v).replace(/\s+/g, " ").slice(0, 60)}`)
      .join(", ");
    const status = ok ? "成功" : "失败";
    const pieces = [`${EVIDENCE_MARK}${tool} ${status}`];
    if (argsTxt) pieces.push(`参数: ${argsTxt}`);
    pieces.push(body ? `→ ${foldText(body, 480)}` : "(无回执)");
    return {
      kind: "evidence", seq, role: "user", tool, ok,
      content: pieces.join(" | "),
      pinned: resultEv?.data?.pinned === true || callEv?.data?.pinned === true,
    };
  },

  // ---- 渲染: 证据子预算 + 溢出可见折叠 ----
  _renderUnits(unitsArg) {
    const items = Array.isArray(unitsArg) ? unitsArg : (unitsArg?.items || []);
    const cap = Array.isArray(unitsArg)
      ? Math.max(120, Math.floor(this._histTokenCap() * 0.25))
      : (unitsArg?.cap ?? Math.max(120, Math.floor(this._histTokenCap() * 0.25)));
    const evIdx = [];
    items.forEach((it, i) => { if (it.kind === "evidence") evIdx.push(i); });
    const keepIdx = new Set();
    let used = 0, folded = 0;
    for (let j = evIdx.length - 1; j >= 0; j--) {
      const it = items[evIdx[j]];
      const t = estimateTokens(it.content);
      if (used + t <= cap) { keepIdx.add(evIdx[j]); used += t; }
      else folded++;
    }
    const out = [];
    let placeholderDone = false;
    let cursor = 0;
    for (let i = 0; i < items.length; i++) {
      const it = items[i];
      if (it.kind !== "evidence") { out.push(it); continue; }
      if (keepIdx.has(i)) { out.push(it); }
      else if (!placeholderDone) {
        placeholderDone = true;
        out.push({
          kind: "evidence", seq: it.seq, role: "user", placeholder: true,
          content: `${EVIDENCE_MARK}已按预算折叠 ${folded} 条更早的证据 (原文仍在会话日志, 可用 read_file 回溯)`,
        });
      }
    }
    return { kept: keepIdx.size, folded, cap, items: out };
  },

  _projectMessages(sessionKey) {
    const rendered = this._renderUnits(this._contextUnits(sessionKey));
    return rendered.items.map((u) => ({ role: u.role || "user", content: u.content }));
  },

  _getSession(sessionKey) {
    const raw = this._projectMessages(sessionKey || "default");
    return this._ensureContextFit(this._trimHistory(raw));
  },

  // ---- pin 抽取: 压缩必须逐字保留的字面标识符 (文件路径) ----
  _extractPins(events) {
    const seen = new Set();
    const out = [];
    const RE = /[A-Za-z0-9_./\\-]+\.(?:js|mjs|cjs|ts|tsx|jsx|md|json|txt|ya?ml|log|py|go|rs|cpp|java|sh)\b/g;
    const scan = (s) => {
      for (const m of String(s ?? "").matchAll(RE)) {
        if (!seen.has(m[0])) { seen.add(m[0]); out.push(m[0]); }
      }
    };
    for (const e of (events || [])) {
      if (e.type === EVENTS.USER || e.type === EVENTS.ASSISTANT) scan(e.data?.content);
      else if (e.type === EVENTS.TOOL_CALL) {
        const a = _parseArgs(e.data?.args);
        for (const key of ["path", "file_path", "filePath", "command", "dest", "destination"]) scan(a[key]);
      } else if (e.type === EVENTS.TOOL_RESULT) scan(e.data?.digest);
    }
    return out;
  },

  // ---- 单元切分 (水位线之上): 把事件按"整单元"分组, 保证 call+result 不被拆散 ----
  _unitsAbove(evs, afterSeq) {
    const units = [];
    const calls = new Map();
    for (const e of evs) {
      if (e.seq <= afterSeq) continue;
      if (e.type === EVENTS.TOOL_CALL) { calls.set(e.data?.callId ?? `s${e.seq}`, e); units.push({ minSeq: e.seq, maxSeq: e.seq, pinned: e.data?.pinned === true }); }
      else if (e.type === EVENTS.TOOL_RESULT) {
        const u = units[units.length - 1];
        if (u) { u.maxSeq = Math.max(u.maxSeq, e.seq); u.pinned = u.pinned || e.data?.pinned === true; }
        else units.push({ minSeq: e.seq, maxSeq: e.seq, pinned: e.data?.pinned === true });
      } else if (e.type === EVENTS.USER || e.type === EVENTS.ASSISTANT) {
        units.push({ minSeq: e.seq, maxSeq: e.seq, pinned: e.data?.pinned === true });
      }
    }
    return units;
  },

  // ---- 确定性折叠 (零 LLM): 生成可续载的多行正文 ----
  _deterministicSummary(covered, prevComp, upTo) {
    const lines = [];
    if (prevComp?.data?.summary) {
      for (const l of String(prevComp.data.summary).split("\n")) {
        if (l.trim() && !l.startsWith("【上下文折叠")) lines.push(l);
      }
    }
    for (const e of covered) {
      if (e.type === EVENTS.USER) lines.push(`- [user] ${String(e.data?.content ?? "").slice(0, 80)}`);
      else if (e.type === EVENTS.ASSISTANT) lines.push(`- [assistant] ${String(e.data?.content ?? "").slice(0, 80)}`);
      else if (e.type === EVENTS.TOOL_CALL) {
        const a = e.data?.args || {};
        const hint = ["path", "command", "file_path"].map((kk) => a[kk]).filter(Boolean).join(" / ");
        lines.push(`- [tool] ${e.data?.tool || "?"} ${String(hint).slice(0, 80)}`);
      } else if (e.type === EVENTS.TOOL_RESULT) {
        lines.push(`- [tool] ${e.data?.tool || "?"} ${e.data?.ok === false ? "fail" : "ok"}`);
      }
    }
    const text0 = lines.join("\n");
    for (const p of this._extractPins(covered)) if (!text0.includes(p)) lines.push(`- pin: ${p}`);
    return `【上下文折叠】确定性折叠 ${covered.length} 条事件 (水位线 seq=${upTo})\n${lines.join("\n")}`;
  },

  // ---- 确定性折叠区间 (免模型) ----
  async _compactRegion(sessionKey, { mode = "deterministic", threshold = true } = {}) {
    const k = sessionKey || "default";
    const evs0 = this.sessionStore.replay(k);
    const memMax = evs0.reduce((m, e) => Math.max(m, e.seq), 0);
    const durableMax = typeof this.sessionStore.durableMaxSeq === "function"
      ? this.sessionStore.durableMaxSeq(k) : memMax;
    // 过期水位线: 磁盘比内存新 (兄弟进程写过) -> 内存视图不可信, 拒绝压缩
    if (durableMax > memMax) return { ok: false, reason: "stale-replay", durableMax };

    this.sessionStore.flush(k); // 压缩前先把 skipFlush 的待写记录落盘 (游标只引用磁盘真相)
    const evs = this.sessionStore.replay(k);
    let prevUpTo = 0, prevComp = null;
    for (const e of evs) if (e.type === EVENTS.COMPACTION) { prevUpTo = e.data?.upToSeq || 0; prevComp = e; }

    const pinnedSeqs = evs.filter((e) => e.data && e.data.pinned === true).map((e) => e.seq);
    const units = this._unitsAbove(evs, prevUpTo);
    const candidates = units.filter((u) => !u.pinned);
    if (!candidates.length) return { ok: false, reason: "nothing-above-watermark" };

    let boundary;
    if (pinnedSeqs.length) {
      // 钉住的单元之前停下 —— 绝不压掉带 pinned 标记的记录
      const minPin = Math.min(...pinnedSeqs);
      const before = units.filter((u) => u.maxSeq < minPin);
      if (!before.length) return { ok: false, reason: "pinned-guard" };
      boundary = before[before.length - 1].maxSeq;
    } else {
      // 压最旧一半, 保留较新的一半 (最近上下文不丢)
      if (candidates.length < 4) return { ok: false, reason: "too-few-after-pairing" };
      const take = Math.max(1, Math.floor(candidates.length / 2));
      boundary = candidates[take - 1].maxSeq;
    }

    const covered = evs.filter((e) => e.seq > prevUpTo && e.seq <= boundary && e.type !== EVENTS.COMPACTION);
    if (!covered.length) return { ok: false, reason: "nothing-above-watermark" };
    const dialogue = covered.filter((e) => e.type === EVENTS.USER || e.type === EVENTS.ASSISTANT).length;
    if (dialogue < 2) return { ok: false, reason: "too-few-after-pairing" };

    const summary = this._deterministicSummary(covered, prevComp, boundary);
    this.sessionStore.append(k, EVENTS.COMPACTION, { summary, upToSeq: boundary, method: mode, fidelity: true });
    this.sessionStore.flush(k);
    return { ok: true, method: mode, upToSeq: boundary, summary };
  },

  // ---- 免模型重置 (对外入口): 确定性折叠 + 写后保真自检 ----
  async resetContextWithoutLlm(sessionKey) {
    const k = sessionKey || "default";
    const before = this._getSession(k).length;
    const r = await this._compactRegion(k, { mode: "deterministic", threshold: false });
    if (!r.ok) return { ok: false, reason: r.reason, violations: r.violations || [], durableMax: r.durableMax };
    const after = this._getSession(k).length;
    const fid = this._verifyCompactionFidelity(k);
    return { ok: true, method: "deterministic", fidelity: fid.ok, before, after, upToSeq: r.upToSeq };
  },

  // ---- 保真自检 (写后 / 重启后同一套闸门) ----
  _verifyCompactionFidelity(sessionKey) {
    const k = sessionKey || "default";
    const evs = this.sessionStore.replay(k);
    const comps = evs.filter((e) => e.type === EVENTS.COMPACTION);
    const checks = [];
    const violations = [];
    if (!comps.length) return { ok: true, violations, checks };

    const last = comps[comps.length - 1];
    const upTo = last.data?.upToSeq || 0;
    const summary = String(last.data?.summary ?? "");

    // ① pin 逐字存活
    const covered = evs.filter((e) => e.seq <= upTo && e.type !== EVENTS.COMPACTION);
    const pins = this._extractPins(covered);
    const missing = pins.filter((p) => !summary.includes(p));
    checks.push({ name: "pins-verbatim", ok: missing.length === 0, detail: missing.length ? `缺失: ${missing.join(", ")}` : `保留 ${pins.length} 个标识符` });
    for (const p of missing) violations.push({ name: "pins-verbatim", detail: p });

    // ② 钉住记录必须在水位线之上
    const pinned = evs.filter((e) => e.data && e.data.pinned === true);
    const pinOk = pinned.every((e) => e.seq > upTo);
    checks.push({ name: "pinned-survives", ok: pinOk, detail: pinOk ? `${pinned.length} 条钉住记录幸存` : "有钉住记录被压进水位线之下" });
    if (!pinOk) violations.push({ name: "pinned-survives", detail: "pinned event below watermark" });

    // ③ 配对完整: 窗口内的回执不能变成孤儿 (它的调用被压掉)
    const above = evs.filter((e) => e.seq > upTo);
    const results = above.filter((e) => e.type === EVENTS.TOOL_RESULT).map((e) => e.data?.callId);
    const calls = new Set(above.filter((e) => e.type === EVENTS.TOOL_CALL).map((e) => e.data?.callId));
    const orphans = results.filter((id) => id != null && !calls.has(id));
    checks.push({ name: "pairing-complete", ok: orphans.length === 0, detail: orphans.length ? `孤儿回执: ${orphans.join(", ")}` : "无孤儿回执" });
    if (orphans.length) violations.push({ name: "pairing-complete", detail: orphans.join(", ") });

    // ④ 多次压缩必须逐字续载上一次的正文
    if (comps.length >= 2) {
      const prev = comps[comps.length - 2];
      const prevLines = String(prev.data?.summary ?? "").split("\n")
        .map((l) => l.trim()).filter((l) => l && !l.startsWith("【上下文折叠"));
      const notCarried = prevLines.filter((l) => !summary.includes(l));
      const ok = notCarried.length === 0;
      checks.push({ name: "rollup-carries-previous", ok, detail: ok ? `续载 ${prevLines.length}/${prevLines.length} 行` : `未续载 ${notCarried.length} 行` });
      if (!ok) violations.push({ name: "rollup-carries-previous", detail: notCarried.join(" | ") });
    }

    return { ok: violations.length === 0, violations, checks };
  },

  // ---- LLM 压缩 (覆盖 context 版): 加保真闸门 ----
  async _maybeCompact(sessionKey) {
    const k = sessionKey || "default";
    if (!this.llm || typeof this.llm.chat !== "function") return;
    const events = this.sessionStore.replay(k);
    let upToSeq = 0;
    for (const e of events) if (e.type === EVENTS.COMPACTION) upToSeq = e.data?.upToSeq || 0;
    const tail = events.filter((e) => e.seq > upToSeq && (e.type === EVENTS.USER || e.type === EVENTS.ASSISTANT));
    if (!tail.length) return;
    const tokenBudget = Number(this.config.memory?.history_token_budget) || 4000;
    const total = tail.reduce((a, e) => a + estimateTokens(e.data?.content), 0);
    if (total <= tokenBudget * 1.5) return;
    const split = Math.floor(tail.length / 2);
    const old = tail.slice(0, split);
    if (old.length < 2) return;
    const lastSeq = old[old.length - 1].seq;
    const transcript = transcriptToText(old.map((e) => ({ role: e.type === EVENTS.USER ? "user" : "assistant", content: e.data?.content })));
    try { if (this.hooks) await this.hooks.emit("PreCompact", { sessionKey: k, upToSeq: lastSeq }); } catch { /* 指针失败不阻断 */ }
    let summary;
    try {
      const r = await this.llm.chat(buildCompactionMessages(transcript), { timeoutMs: AUX_LLM_TIMEOUT_MS, retryMax: 0 });
      summary = r?.content;
    } catch (e) { return; }
    if (!summary) return;
    // 保真闸门: 摘要丢了字面标识符 -> 拒绝压缩 (退化为既有硬裁剪, 绝不静默丢证据)
    const covered = events.filter((e) => e.seq <= lastSeq && e.type !== EVENTS.COMPACTION);
    const pins = this._extractPins(covered);
    const missing = pins.filter((p) => !String(summary).includes(p));
    if (missing.length) {
      debug(`[compact] 保真闸门拒绝压缩: ${missing.length}/${pins.length} 个字面标识符未保留`);
      return { ok: false, reason: "fidelity-refused", violations: missing.map((p) => `pins-verbatim: ${p}`) };
    }
    this.sessionStore.append(k, EVENTS.COMPACTION, { summary, upToSeq: lastSeq, method: "llm", fidelity: true });
    return { ok: true, method: "llm", upToSeq: lastSeq };
  },
};

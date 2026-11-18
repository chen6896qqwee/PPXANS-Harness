// src/agent/approval.js - 工具执行循环 / 审批面 / 溢出暂存 (从 index.js 拆出, mixin 挂回 prototype)
// 2026-11-12 再拆: 审批记忆移入 ./approval-memory.js, 回合内提问移入 ./questions.js ——
//   本文件只保留「一次工具调用怎么走完、什么时候要问人」。
import { TOOL_ERROR_PREFIX, isToolErrorResult } from "../core/errors.js";
import { runToolLoop } from "./loop/policy.js";
import { currentTrace } from "../core/trace.js";
import { EventType } from "../protocol/index.js";
import { scanInjection, wrapUntrusted, reportSuspicious, stripProtoKeys } from "../security/injection.js";
import { noteCatch } from "../utils/catch-log.js";

// 2026-11-06 (评估 P1-6): 待审批清单参数脱敏的白名单键与敏感键名判定 (模块级, 非 mixin 成员)
const APPROVAL_ARG_DISPLAY_KEYS = new Set(["command", "cmd", "script", "code", "path", "file_path", "url", "query"]);
const APPROVAL_ARG_SENSITIVE_RE = /pass|pwd|secret|token|apikey|api_key|credential|auth|cookie|session/i;

function redactApprovalArgs(args) {
  if (args == null || typeof args !== "object") return args;
  const out = {};
  for (const [k, v] of Object.entries(args)) {
    if (APPROVAL_ARG_SENSITIVE_RE.test(k)) { out[k] = "<已脱敏>"; continue; }
    if (APPROVAL_ARG_DISPLAY_KEYS.has(k) && (typeof v === "string" || typeof v === "number" || typeof v === "boolean")) {
      out[k] = typeof v === "string" && v.length > 2000 ? v.slice(0, 2000) + "…[截断]" : v;
      continue;
    }
    out[k] = "<略>";
  }
  return out;
}

const DENIED_BY_DESIGN_RE = /\[permission\]|\[role\]|\[ans_lane\]|\[hook\]|\[workgraph\]|plan 模式|策略拦截|需要人工审批|审批被拒绝|白名单|未开启|路径越界/i;

export function evalToolCategory(result, ok = !isToolErrorResult(result)) {
  const text = String(result ?? "");
  if (/未知工具[:：]/i.test(text)) return "unknown_tool";
  if (/参数错误|无法解析.*JSON|JSON.*无法解析|参数不是完整 JSON|参数不是 JSON/i.test(text)) return "parameter_hallucination";
  if (DENIED_BY_DESIGN_RE.test(text)) return "denied_by_design";
  if (!ok) return "hard_fail";
  if (/^\[exit=\d+/i.test(text)) return "exit_nonzero";
  if (isToolErrorResult(text)) return "soft_error";
  return "success";
}

export const approvalMethods = {
// 单次工具事实只写一条 eval/tool; category 是账本显式口径, 不再靠结果文本二次猜分类。
_recordEvalTool({ tool, args, result, ok, durationMs = 0, callId = null, category = null, flags, safety = false, shadow_call = false }) {
  const resolved = category || evalToolCategory(result, ok);
  try {
    return this.traces?.recordEval?.("eval/tool", {
      tool: tool || "unknown",
      args: args ?? {},
      result: String(result ?? ""),
      ok: ok === true,
      durationMs: Math.max(0, Math.round(Number(durationMs) || 0)),
      callId: callId || "unknown",
      category: resolved,
      ...(Array.isArray(flags) && flags.length ? { flags } : {}),
      ...(shadow_call ? { shadow_call: true } : {}),
    }, { safety: safety || resolved === "denied_by_design" });
  } catch (e) { noteCatch(e); return null; /* 评测观测不得改变工具执行结果 */ }
},

// 统一工具执行入口 (http 原生 tool_calls + 文本工具调用修复) [P0#1]
// v1.0.7: 移除未使用的 llmInstance 死参数, 所有工具执行统一走此入口 (trace/事件只此一份)
// 2026-09-17 体检修复: start/done 事件带唯一 callId。
//   原先 Web UI 只能按"工具名"匹配起止事件, 同一轮里出现两个 read_file 时,
//   后到的事件会回填到前一张卡片上 (旧前端 app.js 的实现注释里也自述了这个缺陷)。
// v3.0 (codex 对齐): PreToolUse 钩子(可否决/改参) → 权限引擎(deny/ask/allow) → 执行 → PostToolUse 钩子
async _runTool(name, args) {
  const t0 = Date.now();
  this._lastTurnUsedTools = true;
  // 会话级"本轮用过工具"标记 (chat/chatStream 收口时按会话清除) —— 供军团进度上报/可视区分。
  this._turnsUsedTools?.set(currentTrace()?.sessionKey || this._activeSessionKey || "default", true);
  // 原型污染消毒: 剥离 __proto__/constructor/prototype 键 (LLM JSON 可携带恶意键)
  const stripped = stripProtoKeys(args);
  if (stripped.stripped.length) {
    this.tracer.event("security/proto-stripped", { tool: name, keys: stripped.stripped });
    args = stripped.clean;
  }
  const callId = `t${++this._toolCallSeq}-${t0.toString(36)}`;

  // --- 2026-10-24 (R2): provider 回退重放防双执行 ---
  // 降级重放 (_llmWithFallback 换 provider 从头跑循环) 会重新遇到已执行过的工具调用。
  // 只读/幂等工具重跑无害; 非幂等工具 (写文件/发请求) 二次执行 = 真实副作用翻倍。
  // 方案: 每轮对话 (chat/chatStream 入口) 建回放缓存, 非幂等调用记 [工具|参数] → 结果;
  //   仅当本轮已发生降级 (_turnAttempt > 0) 时消费缓存 —— 正常轮内刻意重复调用不受影响。
  if (!this._toolIdempotent(name) && (this._turnAttempt || 0) > 0) {
    const key = name + "|" + JSON.stringify(args ?? null);
    // 2026-11-06 (评估 P1-4): 回放缓存按会话分桶, 不再跨会话误复用
    const prev = this._turnExecCacheFor?.().get(key);
    if (prev && typeof prev.value === "string") {
      this.tracer.event("tool/replay-memo", { tool: name, callId });
      const ok = !isToolErrorResult(prev.value);
      this._recordEvalTool({ tool: name, args, result: prev.value, ok, callId, flags: ["replay_memo"] });
      this._emitToolDone(callId, name, args, ok, 0, prev.value);
      return prev.value + "\n[回放缓存] 此调用在降级前的尝试中已真实执行过, 返回先前结果 (未重复执行)。若确需重复, 请改变参数后再试。";
    }
  }

  // --- v3.0: PreToolUse 钩子链 (claude-code 语义: 可否决/可改参) ---
  if (this.hooks) {
    try {
      const h = await this.hooks.emit("PreToolUse", { tool: name, args, callId });
      if (h && h.blocked) {
        const msg = `[hook] 工具 ${name} 被 PreToolUse 钩子否决: ${h.reason || "无理由"}`;
        this.tracer.event("tool/hook-blocked", { tool: name, reason: h.reason });
        // 2026-11-14 (评测 P1-1): 否决发生在 bus "tool/call" 之前, 此前证据采集器看不到,
        //   会话 jsonl 零留痕 ("被拒"自述无法对账)。按执行路径同形双发, 与 traces 互补。
        this.bus?.emit("tool/call", { name, args, callId }, { source: "agent._runTool.hook-blocked" });
        this.bus?.emit("tool/result", {
          name, callId, ok: false, args, durationMs: Date.now() - t0, error: msg.slice(0, 300),
        }, { source: "agent._runTool.hook-blocked" });
        this._recordEvalTool({ tool: name, args, result: msg, ok: false, durationMs: Date.now() - t0, callId, category: "denied_by_design", safety: true });
        this._emitToolDone(callId, name, args, false, Date.now() - t0, msg);
        return TOOL_ERROR_PREFIX + msg;
      }
      if (h && h.args && typeof h.args === "object") args = h.args; // 钩子改参
    } catch {} // 钩子自身异常不阻断主链
  }

  // --- v3.0: 权限引擎 (codex AskForApproval + SandboxPolicy + 规则链) ---
  // 2026-10-10: 准入判定统一收敛到 _admitToolCall (plan 模式 + 权限引擎 + 审批缓存),
  //   消除"测试调 _admitToolCall / 生产走内联"的双份实现漂移; 引擎异常 fail-closed。
  {
    const admit = await this._admitToolCall(name, args, callId);
    if (admit && admit.args && typeof admit.args === "object") args = admit.args;
    if (!admit.ok) {
      // 2026-11-14 (评测 P1-1): 被拒调用也进证据链 —— 准入拒绝发生在 bus "tool/call" 之前,
      //   采集器永远看不到 (会话 jsonl 零留痕, 模型自述"被拒"无法对账)。按执行路径同形
      //   双发 call/result(ok=false), _pushTurn 会写进会话日志; 与 traces 的 perm-denied 互补。
      this.bus?.emit("tool/call", { name, args, callId }, { source: "agent._runTool.admit-denied" });
      this.bus?.emit("tool/result", {
        name, callId, ok: false, args, durationMs: Date.now() - t0,
        error: String(admit.error ?? "").slice(0, 300),
      }, { source: "agent._runTool.admit-denied" });
      this._recordEvalTool({ tool: name, args, result: admit.error, ok: false, durationMs: Date.now() - t0, callId, category: "denied_by_design", safety: true });
      this._emitToolDone(callId, name, args, false, Date.now() - t0, admit.error);
      return TOOL_ERROR_PREFIX + admit.error;
    }
  }

  this.bus?.emit("tool/call", { name, args, callId }, { source: "agent._runTool" });
  if (this._onToolEvent) { try { this._onToolEvent({ type: "start", id: callId, tool: name, args, ts: Date.now() }); } catch {} }
  // 2026-10-25 (EQ 事件面): TOOL_CALLED 进事件流 —— 此前 16 种事件类型只有 4 种有
  //   生产者, 工具事件只走 _onToolEvent 回调旁路, /events SSE 消费者看不到工具轨迹。
  //   现在 EQ 与回调双发 (回调供 UI 精确配对, EQ 供外部时间线消费), payload 控制在紧凑尺寸。
  this._eqPushRef(EventType.TOOL_CALLED, { tool: name, callId, sessionKey: currentTrace()?.sessionKey || null, argsPreview: this._eqPreview(args) }, { sessionKey: currentTrace()?.sessionKey || null, ref: callId });
  // 2026-11-05 (Step 6): 副作用写前事实 —— 崩溃恢复只自动重放"整轮未碰过有副作用工具"的指派。
  //   必须在 tools.call **之前**落账: 工具执行到一半崩溃时, "碰过副作用"已经是账本事实。
  //   账本不可用 → 拒绝执行有副作用工具 (fail-closed), 不拿"可能翻倍副作用"换一次执行。
  {
    const sk = currentTrace()?.sessionKey || this._activeSessionKey || null;
      if (!this._markWorkReplayUnsafe(name, sk)) {
        const msg = `[workgraph] 工具 ${name} 有副作用且写前事实无法落账 (账本不可用), 已拒绝执行 (fail-closed)`;
        this.tracer.event("tool/replay-fact-failed", { tool: name, sessionKey: sk });
        // 2026-11-14 (评测 P1-1): call 已入证据链 (上一行 bus emit), 补发 result(ok=false) 防孤儿调用
        this.bus?.emit("tool/result", {
          name, callId, ok: false, args, durationMs: Date.now() - t0, error: msg.slice(0, 300),
        }, { source: "agent._runTool.replay-fact-failed" });
        this._recordEvalTool({ tool: name, args, result: msg, ok: false, durationMs: Date.now() - t0, callId, category: "denied_by_design", safety: true });
        this._emitToolDone(callId, name, args, false, Date.now() - t0, msg);
        return TOOL_ERROR_PREFIX + msg;
      }
  }
  // 2026-11-05 (Step 7): 断点续执行 —— 上一轮中断前已完成的只读/幂等调用直接复用结果。
  //   只在 resumeUnstartedTickets 挂上续跑上下文的本轮生效; 有副作用的调用永不复用。
  const resumeSk = currentTrace()?.sessionKey || this._activeSessionKey || null;
  {
    const memo = this._turnResumeMemos?.get(String(resumeSk || "default")) || null;
    if (memo && memo.size && this._toolReplaySafe(name)) {
      const hit = memo.get(this._checkpointKey(name, args));
      if (hit && hit.tool === name) {
        const cached = String(hit.result ?? "");
        this.tracer.event("tool/resume-memo", { tool: name, callId });
        this._recordEvalTool({ tool: name, args, result: cached, ok: !isToolErrorResult(cached), callId, flags: ["resume_memo"] });
        this._recordWorkCheckpoint(name, args, cached, true, callId, resumeSk);
        this._emitToolDone(callId, name, args, true, 0, cached);
        return cached + "\n[断点续执行] 此调用在上一轮中断前已完成, 直接复用当时结果 (未重复执行)。若依赖已变化, 请改变参数后重试。";
      }
    }
  }
  // let 而非 const: PostToolUse 钩子的 additionalContext 会追加到结果尾部
  // (2026-09-18 修复: 原为 const, 钩子追加时抛 "Assignment to constant variable" 被 catch {} 静默吞掉,
  //  additionalContext 特性从未生效)
  let result;
  try {
    result = await this.tools.call(name, args, { agent: this, timeoutMs: Number(this.config.agent?.tool_timeout_ms) || 0 });
  } catch (e) {
    this._recordEvalTool({
      tool: name, args, result: e?.message || String(e), ok: false,
      durationMs: Date.now() - t0, callId, category: "hard_fail",
    });
    throw e;
  }
  const ok = !isToolErrorResult(result);
  // 提示注入防线 (2026-10-03 红队驱动): 工具输出 = 不可信数据。
  // 疑似注入 → 原文外包"不可信"标注 + 安全事件上 tracer (数据不删, 指令不执行语义靠标注传达给模型)。
  try {
    if (ok && typeof result === "string" && result.length > 20 && !result.startsWith("{")) {
      const scan = scanInjection(result);
      if (scan.suspicious) {
        reportSuspicious(name, scan, { tracer: this.tracer });
        // 2026-11-13 (评测 P2-5): 注入命中不只发事件 —— 写哈希链 + 给本会话打标,
        //   后续工具调用在轨迹里带 flags, 才能回答"检出之后模型做了什么"。
        const sk = currentTrace()?.sessionKey || this._activeSessionKey || "default";
        this._securityFlags ??= new Map();
        this._securityFlags.set(String(sk), { id: "injection-suspect", since: Date.now(), tool: name });
        try {
          this.audit?.appendEvent?.({
            event: "security_injection_suspect",
            fields: { tool: name, hits: scan.hits.map((h) => h.id), sessionKey: String(sk) },
            ok: true,
          });
        } catch { /* 审计降级不阻断 */ }
        result = wrapUntrusted(name, result, scan);
      }
    }
  } catch { /* 扫描异常不阻断工具结果 */ }
  if (name === "spawn_agent") this.tracer.event("agent/spawn", { args });
  const secFlag = this._securityFlags?.get(String(resumeSk || "default"));
  const flags = secFlag && Date.now() - secFlag.since < 30 * 60 * 1000 ? [secFlag.id] : undefined;
  this.bus?.emit("tool/result", {
    name,
    callId,
    ok,
    args,
    durationMs: Date.now() - t0,
    error: ok ? null : result.slice(0, 300),
    flags,
  }, { source: "agent._runTool" });
  this.traces.record({
    tool: name,
    args,
    result: result.slice(0, 800),
    ok,
    durationMs: Date.now() - t0,
    error: ok ? null : result,
    flags,
  });
  this._recordEvalTool({
    tool: name, args, result, ok, durationMs: Date.now() - t0, callId, flags,
    safety: Array.isArray(flags) && flags.includes("injection-suspect"),
  });

  // --- v3.0: PostToolUse 钩子链 (可附加上下文, 追加在结果尾部) ---
  // 2026-10-24 (R3): 失败也触发 (claude-code 语义) —— 此前仅成功时 emit, 钩子永远
  //   看不到失败事件, 观测/审计型钩子对失败盲。payload 带 ok 供区分。
  if (this.hooks) {
    try {
      const h = await this.hooks.emit("PostToolUse", { tool: name, args, result, callId, ok });
      // 2026-09-18 修复 (第二处): 原实现 map h.results 里的 r.additionalContext,
      //   但 results 条目结构是 { result: res }, 恒取到 undefined —— 收集结果实际在
      //   h.additionalContext (hooks/index.js 统一收集)。原特性从未生效。
      const extra = (Array.isArray(h?.additionalContext) ? h.additionalContext : [])
        .filter(Boolean).map(String).join("\n");
      if (extra) result = result + "\n" + extra;
    } catch {}
  }
  this._emitToolDone(callId, name, args, ok, Date.now() - t0, result);
  // 2026-11-05 (Step 7): 重放安全工具的结果落 per-assignment 检查点 (默认关; 只读文件不改进程状态)。
  this._recordWorkCheckpoint(name, args, result, ok, callId, resumeSk);
  // 2026-10-24 (R2): 非幂等工具的执行结果记入回放缓存 (本轮内有效), 供降级重放时防双执行
  if (!this._toolIdempotent(name)) {
    try {
      // 2026-11-06 (评估 P1-4): 写入本会话的回放缓存桶
      this._turnExecCacheFor?.().set(name + "|" + JSON.stringify(args ?? null), { value: result });
    } catch { /* 循环参数无法序列化时跳过缓存 */ }
  }
  return result;
},

// v3.0: 统一 done 事件发射 (原内联三处, 收敛为一个私有方法)
_emitToolDone(callId, name, args, ok, durationMs, result) {
  if (this._onToolEvent) { try { this._onToolEvent({ type: "done", id: callId, tool: name, args, ok, durationMs, result: String(result == null ? "" : result).slice(0, 300), ts: Date.now() }); } catch {} }
  // 2026-10-25 (EQ 事件面): TOOL_OUTPUT 统一在此收口 —— 覆盖全部出口
  //   (成功/失败/钩子否决/权限拒绝/回放缓存), 与 TOOL_CALLED 经 callId 配对。
  this._eqPushRef(EventType.TOOL_OUTPUT, { tool: name, callId, ok, durationMs, resultPreview: this._eqPreview(result) }, { sessionKey: currentTrace()?.sessionKey || null, ref: callId });
  // 2026-11-01 (三期投机复现): 轮内失败清单 —— 轮收口时静默复现用 (只收 idempotent
  //   判定前的原始失败; 过滤在 schedule 里做, 非幂等绝不重放)
  if (!ok) {
    // 按当前轮会话分桶 (2026-11-12): 并发会话不得互相消费失败清单 (见 work.js _turnFailuresOf)
    const failed = this._turnFailuresOf(currentTrace()?.sessionKey || this._activeSessionKey);
    if (failed.length < 32) failed.push({ name, args, error: String(result == null ? "" : result).slice(0, 500) });
  }
},

// v3.0 (codex approval flow): 产生审批请求并等待 Web UI/通道裁决
// 返回: { updatedInput? } 表示批准; null 表示拒绝/超时
// 审批面 (2026-10-09 补): 是否存在"能把 ask 递到人面前"的入口。
// headless (CLI 批处理 / 测试 / 无人值守) 没有审批面 —— 此时 ask 必须直接拒绝,
// 且拒绝消息要带上可自纠的 modelHint, 否则模型既改不了也换不了路子, 只会幻觉"已修复"。
hasApprovalSurface() {
  if (typeof this._onApprovalEvent === "function" || typeof this._approvalSurface === "function") return true;
  return !!(this._approvalSurfaces && this._approvalSurfaces.size);
},

// 除指定审批面外, 是否还有别的面能接住 ask。
// 场景 (2026-11-02 修复): TUI 网关常与 Web 同进程启动, 但桌面端没有终端客户端。
// 旧逻辑在"本面无屏幕"时直接 resolveApproval("deny") —— 把 Web 上正等待的审批抢答拒绝,
// 用户随后点批准只能拿到 404。判定要排除自己: 事件回调 (HTTP 流) 或其它具名面存在即让位。
hasApprovalSurfaceExcept(name) {
  const skip = String(name || "");
  if (this._approvalSurfaces && [...this._approvalSurfaces].some((s) => s !== skip)) return true;
  if (typeof this._approvalSurface === "function") return true;
  return typeof this._onApprovalEvent === "function";
},

// 注册外部审批面 (Web/CLI/渠道)。
//   传函数 = 审批事件回调 (旧用法, 兼容保留, 返回解绑函数);
//   传字符串 = 登记一个具名审批面 (Web 端 "http" / CLI "cli" 等), 供 hasApprovalSurface
//   做"是否存在能把 ask 递到人面前的入口"的判定 —— 多个面可并存, 用 Set 去重。
registerApprovalSurface(fn) {
  if (typeof fn === "function") {
    this._approvalSurface = fn;
    return () => { this._approvalSurface = null; };
  }
  if (!this._approvalSurfaces) this._approvalSurfaces = new Set();
  const name = String(fn || "default");
  this._approvalSurfaces.add(name);
  return () => { this._approvalSurfaces.delete(name); };
},

// 注销审批面 (具名版): 传名字则只注销该面, 不传则清空全部。
unregisterApprovalSurface(name = null) {
  if (!this._approvalSurfaces) this._approvalSurfaces = new Set();
  if (name == null) this._approvalSurfaces.clear();
  else this._approvalSurfaces.delete(String(name));
  this._approvalSurface = null;
},

// 人类在场标记 (CLI 聊天等"有人但无审批面"的形态): 与审批面【分开】维护 ——
//   CLI 有终端用户能答话, 但审批仍走 headless 快拒 (没有可点击的审批入口),
//   两个口径互不污染。供 clarify 判定"问题有没有人能接"。
markHumanChannel(flag = true) {
  this._humanChannel = !!flag;
},

// 是否存在"能把问题递到人面前"的通道: 审批面 OR CLI 人类标记。
// 都没有 = headless (批处理/测试/无人值守) —— 此时 clarify 不得反问, 应给推进指引。
hasHumanChannel() {
  return this.hasApprovalSurface() || this._humanChannel === true;
},

_requestApproval({ tool, args, reason }) {
  return new Promise((resolve) => {
    const id = `ap_${++this._approvalSeq}_${Date.now().toString(36)}`;
    const kind = /run_command|shell|exec|bash/.test(tool) ? "bash"
      : /edit|write|apply_patch|create_file/.test(tool) ? "edit"
      : /plan/.test(tool) ? "plan" : "tool";
    const summary = args?.command || args?.cmd || args?.path || args?.file_path || JSON.stringify(args || {}).slice(0, 160);
    // 「记住」只对命令类工具开放 (非命令工具没有稳定 key, 记住等于按工具名全放行, 风险面太大)
    const rememberable = !!this._approvalCacheKey(tool, args || {}) && this.config?.agent?.approval_cache !== false;
    // 前缀放行候选 (2026-11-03): 仅单条简单命令给出首词, UI 据此展示「前缀放行」按钮
    const prefix = rememberable ? this._approvalPrefixToken(args || {}) : "";
    // (R13) 会话归属随 req 外投 —— 消费方 (UI/桥) 可按会话过滤审批卡片
    const req = { id, kind, tool, args, summary: String(summary || ""), reason: reason || "", ts: Date.now(), sessionKey: currentTrace()?.sessionKey || null, rememberable, prefix: prefix || undefined };
    const timeoutMs = Number(this.config.agent?.approval_timeout_ms) || 120000;
    const entry = { req, resolve, timer: null };
    entry.timer = setTimeout(() => {
      this._pendingApprovals.delete(id);
      // 超时也要通知各审批面收口 (Web 卡片否则会一直留着, 点下去只能 404)
      // 2026-11-13 (评测 P2-6): 超时路径原来只发 bus, 不写 WAL —— 于是 requested 93 /
      //   resolved 91 永远差 2 条。协议总线是审批计数的唯一事实源, 三条出口必须同源。
      this.tracer.event("approval/resolved", { id, decision: "timeout" });
      this.protocolBus?.eq?.push?.({ type: "APPROVAL_RESOLVED", payload: { id, decision: "timeout" } });
      this.bus?.emit("approval/resolved", { id, decision: "timeout" }, { source: "agent.approval" });
      try {
        this.audit?.appendEvent?.({
          event: "approval_resolved",
          fields: { id, tool: req.tool, decision: "timeout", ok: false },
        });
      } catch { /* 审计降级不阻断审批 */ }
      resolve(null); // 超时视为拒绝 (codex: 等待审批超时不静默放行)
    }, timeoutMs);
    // 2026-11-13 修复 (架构审计顺带): 这里**不能** unref —— 审批是"有人在等一个答案",
    //   定时器一 unref, 进程无事可做就退出, 超时永不触发, 调用方拿到的是永不 resolve 的
    //   Promise (实测 approval / questions 共 12 个用例因此挂死)。
    //   "进程能自然退出"改由 shutdown() 显式收口 (cancelApprovals), 语义更准:
    //   有人在等就活着, 说不等了才退出。
    this._pendingApprovals.set(id, entry);
    // 事件外投: SSE onApproval / tracer / 协议总线
    this.tracer.event("approval/requested", { id, tool, kind });
    this.protocolBus?.eq?.push?.({ type: "APPROVAL_REQUESTED", payload: req });
    if (this._onApprovalEvent) { try { this._onApprovalEvent(req); } catch {} }
    this.bus?.emit("approval/requested", req, { source: "agent.approval" });
  });
},

// v3.0: 审批裁决入口 (HTTP POST /api/approvals/:id 调用)
// 返回 true 表示存在该审批且已裁决
// decision 五档 (2026-11-03):
//   approve = 仅本次; always = 本会话相同命令放行; persist = 永久放行 (落盘, 跨重启);
//   prefix = 本会话前缀放行 (同首词的单条简单命令不再问, 只入内存不落盘);
//   deny = 拒绝。仅命令类工具参与缓存, 非命令工具记住等于按工具名全放行, 不做。
// 2026-11-06 (评估 P1-6): sessionKey 可选 —— 调用方传了且与审批归属会话不符时拒绝裁决
//   (跨会话抢答: A 会话的界面裁决 B 会话的审批)。req.sessionKey 为 null (无 trace 旧路径)
//   时不强校验, 保持兼容。
resolveApproval(id, decision, sessionKey = null) {
  const entry = this._pendingApprovals.get(id);
  if (!entry) return false;
  const reqSk = entry.req?.sessionKey ?? null;
  if (sessionKey != null && reqSk != null && String(sessionKey) !== String(reqSk)) {
    this.tracer.event("approval/session-mismatch", { id, decision, reqSession: reqSk, callerSession: String(sessionKey) });
    return false;
  }
  clearTimeout(entry.timer);
  this._pendingApprovals.delete(id);
  const approved = decision === "approve" || decision === "always" || decision === "persist" || decision === "prefix";
  if (approved && (decision === "always" || decision === "persist") && entry.req?.tool) {
    const key = this._approvalCacheKey?.(entry.req.tool, entry.req.args || {});
    if (key) this._applyApprovalDecision?.(key, decision, entry.req?.reason || "");
  }
  if (approved && decision === "prefix" && entry.req?.tool) {
    const pkey = this._approvalPrefixKey?.(entry.req.tool, entry.req.args || {});
    // 复合命令拿不到前缀 key → 自动退化为"仅本次放行", 不会悄悄扩大放行面
    if (pkey) this._applyApprovalDecision?.(pkey, "always", entry.req?.reason || "");
  }
  this.tracer.event("approval/resolved", { id, decision });
  this.protocolBus?.eq?.push?.({ type: "APPROVAL_RESOLVED", payload: { id, decision } });
  // 审批是"人对副作用放行"的决定点, 必须与工具调用同链可追责 (只记工具/裁决, 不记参数正文)
  try {
    this.audit?.appendEvent?.({
      event: "approval_resolved",
      fields: { id, tool: entry.req?.tool || null, decision, ok: approved },
    });
  } catch { /* 审计降级不阻断审批 */ }
  // 广播给各审批面 (HTTP 的 /message/stream 据此发 approval.close, 让另一处打开的卡片同步收口)
  this.bus?.emit("approval/resolved", { id, decision }, { source: "agent.approval" });
  entry.resolve(approved ? { decision } : null);
  return true;
},

// 关闭路径: 收口所有挂起审批 (视为拒绝) —— 替代过去的 timer.unref()。
//   返回收口条数; 不抛错 (退出路径不允许被单个坏条目阻断)。
cancelApprovals(reason = "shutdown") {
  let n = 0;
  for (const [id, entry] of this._pendingApprovals) {
    try {
      clearTimeout(entry.timer);
      this._pendingApprovals.delete(id);
      this.tracer?.event?.("approval/resolved", { id, decision: "timeout", reason });
      this.protocolBus?.eq?.push?.({ type: "APPROVAL_RESOLVED", payload: { id, decision: "timeout", reason } });
      this.bus?.emit?.("approval/resolved", { id, decision: "timeout", reason }, { source: "agent.approval" });
      entry.resolve(null);
      n += 1;
    } catch { /* 单条收口失败不阻断整体退出 */ }
  }
  return n;
},

// v3.0: 待审批清单 (HTTP GET /api/approvals/pending)
// 2026-11-06 (评估 P1-6): 返回脱敏副本; 可选 sessionKey 过滤 (多会话各看各的审批)。
//   args 可能携带凭据/内网地址, 清单接口只需要人类裁决所需的展示字段; 完整参数仍经
//   审批卡事件 (approval/requested) 发给真正的裁决面。白名单键保留展示, 其余键隐藏,
//   敏感键名 (key/secret/token/password…) 一律掩码。
pendingApprovals(sessionKey = null) {
  return [...this._pendingApprovals.values()]
    .map((e) => e.req)
    .filter((req) => (sessionKey == null || req?.sessionKey == null ? true : String(req.sessionKey) === String(sessionKey)))
    .map((req) => ({ ...req, args: redactApprovalArgs(req?.args) }));
},

// 链式召回 (2026-11-01 二期③): 取 spill 归档存储 (toolsPlugin 装配, 单例)。
// 未装配/关闭 context_recall 时返回 null —— 裁剪回落纯裁剪旧行为。
_spillStore() {
  if (this.__spill === undefined) {
    try { this.__spill = this.ctx?.consume?.("spill") || null; } catch (e) { noteCatch(e); this.__spill = null; }
  }
  return this.__spill;
},

// LLM + 工具调用循环 (带 provider 回退)
// 重构第一刀 (2026-09-14): 循环驱动/探索熔断/重复检测/溢出降档/错误重试
// 全部收敛到 src/agent/loop/policy.js runToolLoop, 此处只注入依赖, 策略可独立测试/替换。
// 2026-10-24 (R4): onDelta/signal 透传 —— chatStream 的流式工具循环入口。
// 2026-11-01 (二期②): onReasoning 透传 (推理模型思考链); 调用方未传时积累进
//   this._lastReasoning, 供 worker 汇报信封/诊断读取 (不进正文; 轮内草稿带截断副本供归档)。
async _llmWithTools(seedMessages, llmInstance = this.llm, onDelta = null, signal = null, onReasoning = null) {
  this._lastReasoning = "";
  const reasoningSink = onReasoning
    || ((t) => { this._lastReasoning += t; });
  // 2026-10-30: 本轮运行统计 (轮次/工具步数/输出速度), 落 this.lastRun 供底部状态条与
  //   /api/run.state 复用。此前这套数只在前端内存里算, 页面一刷新就没了 ——
  //   "1 轮 33 步 · 241 tok/s" 刷新后消失, 看着像功能不存在。
  const run = { rounds: 0, steps: 0, t0: Date.now(), tokps: 0, at: new Date().toISOString() };
  this.lastRun = run;
  try {
    return await runToolLoop({
      seedMessages,
      llm: llmInstance,
      // 传函数而非快照: tool_schema 在本轮把隐藏工具加入曝光集合后, 下一轮 apiChat 立即生效。
      tools: () => (this.toolsEnabled ? this.tools.toOpenAI() : []),
      config: this.config,
      // 2026-11-06 (评估 P1-4): 中断判定走会话隔离入口 —— 只认本会话 (或全局) 的中断,
      //   其它会话 interrupt() 不再掐断本会话在途工具循环。
      isInterrupted: () => this._isInterrupted(),
      onDelta,
      onReasoning: reasoningSink,
      signal,
      onStep: (ev) => {
        // runToolLoop 的 round 从 0 起算 (首轮 = 0), 故轮次数 = round + 1。
        //   此前用 `ev.round > run.rounds` 判断, 0 > 0 恒假 → 单次生成永远记成 0 轮。
        if (typeof ev.round === "number") run.rounds = Math.max(run.rounds, ev.round + 1);
        if (this._onStepEvent) { try { this._onStepEvent(ev); } catch {} }
        // Step 3: 轮次 → assignment_progress (只观测; 服务层 500ms 合并)
        try { this._workProgressTick?.(this._activeSessionKey, ev); } catch { /* 观测不阻断 */ }
      },
      // 轮内中间草稿采集 (2026-10-10): 每轮模型回包内容进草稿桶, 落库时并入 memory/turns
      onAssistantMsg: (ev) => this._recordDraft(ev),
      onToolEarlyResult: (ev) => this._recordEvalTool(ev),
      runTool: (name, args) => {
        run.steps += 1;
        (run.toolNames ||= []).push(name);
        // v5.0 信封 v2 (2026-11-07): 采集可验证交付物 —— 实际执行的命令与写盘产物。
        //   worker 汇报信封、工单账本与 UI 透出; 采集失败不影响工具执行本身。
        try {
          const a = args || {};
          if (name === "run_command" || name === "code_act") {
            const cmd = a.command || a.cmd || a.code || "";
            if (cmd) {
              (run.commands ||= []).push({ cmd: String(cmd).slice(0, 200) });
              if (run.commands.length > 16) run.commands.length = 16;
            }
          }
          const p = a.path || a.file || a.file_path || null;
          if (p && (name === "write_file" || name === "append_file" || name === "apply_patch" || name === "move_file")) {
            (run.artifacts ||= []).push({ path: String(p).slice(0, 300), kind: "file" });
            if (run.artifacts.length > 16) run.artifacts.length = 16;
          }
        } catch { /* 采集失败不影响工具执行 */ }
        return this._runTool(name, args);
      },
      shrinkMessages: (messages, budget) => this._shrinkMessagesForOverflow(messages, budget),
      // 2026-11-16: 与 _trimHistory/_ensureContextFit 同一预算入口, 不再绕过全局配额
      histTokenCap: () => this._historyBudget(),
      onEvent: (type, payload) => { this._onPolicyEvent(type, payload); this.tracer.event(type, payload); },
      // v1.6.0 第四刀: 超时重试决策 (幂等才重试) + 超时预算查询 (事件采集)
      isIdempotentTool: (name) => this._toolIdempotent(name),
      toolTimeoutOf: (name) => this._toolTimeoutOf(name),
      // 2026-10-24: 循环内预算闸门 —— 每轮 LLM 调用前消费入口闸的判定 (_budgetBlocked
      // 返回非空 = 预算耗尽文案)。首轮跳过 (入口已查), 只拦"循环中途烧穿"的情形。
      budgetBlocked: () => this._budgetBlocked(),
      // 回合级后置校验闸门 (2026-10-05): 收尾前 harness 自己跑确定性检查, 不过则经 steering
      // 通道把失败喂回模型 (修正机会 ≤2), 用尽诚实上报。rootDir 缺省时不启用。
      postCondition: {
        rootDir: this.root,
        capabilityOf: (n) => (this.tools && this.tools.getCapability ? this.tools.getCapability(n) : null),
      },
      // 链式召回 (2026-11-01 二期③): 超长工具结果全文归档, 告示牌带 spill_id 供 context_read 续读
      spill: this._spillStore(),
    });
  } finally {
    // 输出速度: 只在真有 completion 数时算, 否则留 0 (状态条据此不显示 tok/s)。
    //   分母含工具往返 —— 与前端 done 事件里的口径一致, 不另造一套。
    const out = Number(this.lastUsage?.completion_tokens);
    const secs = (Date.now() - run.t0) / 1000;
    if (Number.isFinite(out) && out > 0 && secs > 0.3) run.tokps = Math.round((out / secs) * 10) / 10;
    run.ms = Date.now() - run.t0;
  }
},

// 政策事件回流: 默认转 tracer 埋点; 对会沉淀智力的关键事件 (B3 反思闸门拦停) 额外写入经验库
// 反思闭环: 硬拒绝类失败不只"这次不重试", 还自动记住"以后不这么干"。
//   幂等: Experience.learn 本身去重 (同 lesson 命中 uses+1), 高频触发只会强化不会写放大。
_onPolicyEvent(type, payload = {}) {
  try {
    if (type === "tool/self_review_stop" && this.experience) {
      this.experience.learn({
        task: "工具调用被反思闸门拦停",
        outcome: "硬拒绝类错误 (黑名单拦截/审批被拒/权限拒绝/DENY_HINT), 盲目重试或改写命令会绕过安全闸门",
        lesson: "硬拒绝类错误不应重试或改写命令绕过 — 停下说明原因或请用户调整 security 配置。工具: " + String(payload?.reason || ""),
        tags: ["auto-self-review", "tool-denied"],
      });
    }
  } catch (e) { noteCatch(e); /* 经验沉淀失败不阻断主链 (不因记教训崩掉干活) */ }
},

// 工具是否幂等 (可安全超时重试): 读取工具元数据, 未声明默认 true (只读/查询类)
_toolIdempotent(name) {
  try {
    const m = this.tools && typeof this.tools.metaOf === "function" ? this.tools.metaOf(name) : null;
    return m ? !!m.idempotent : true;
  } catch { return true; }
},

// 工具超时预算 (ms, 0/无声明 = 用全局默认; 事件采集用)
_toolTimeoutOf(name) {
  try {
    const m = this.tools && typeof this.tools.metaOf === "function" ? this.tools.metaOf(name) : null;
    return m ? (m.timeoutMs > 0 ? m.timeoutMs : (Number(this.config.agent?.tool_timeout_ms) || 0)) : (Number(this.config.agent?.tool_timeout_ms) || 0);
  } catch { return Number(this.config.agent?.tool_timeout_ms) || 0; }
},

// 工具原始结果 → 人类可读文本 (仅供 _localIntent 直接回给用户时使用)
// v1.0.8 修复 (P2-1): 原实现 `return \`[工具] ${await this.tools.call(...)}\`` 直接拼字符串,
//   把内部标记 `[工具]`、错误前缀与原始 JSON (如 {"ok":true,"id":"..."}) 原封不动喷给用户。
//   这一层做"外向化": 错误 → 可读失败语; JSON → 抽取载荷字段; 数组 → 逐项罗列; 其余原样。
//   注意: 这是**用户可见文本**的专用通道, 模型侧上下文里的工具结果不走这里 (保持原始保真)。
_humanToolResult(raw) {
  const s = String(raw ?? "").trim();
  if (!s) return "(没有返回内容)";
  if (isToolErrorResult(s)) {
    const idx = s.indexOf(TOOL_ERROR_PREFIX);
    return "没办成: " + s.slice(idx + TOOL_ERROR_PREFIX.length).trim();
  }
  if (s.startsWith("{") || s.startsWith("[")) {
    let obj;
    try { obj = JSON.parse(s); } catch { return s; }
    if (Array.isArray(obj)) {
      return obj.length
        ? obj.map((x) => (typeof x === "string" ? x : (x && (x.name || x.path || x.title)) || JSON.stringify(x))).join("\n")
        : "(空)";
    }
    if (obj && typeof obj === "object") {
      if (obj.error) return "没办成: " + String(obj.error);
      for (const k of ["text", "content", "message", "result", "data", "output"]) {
        const v = obj[k];
        if (typeof v === "string" && v.trim()) return v;
      }
    }
    return s; // 结构无法识别: 原样返回, 不丢信息
  }
  return s;
}
};

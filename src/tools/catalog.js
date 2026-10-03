// src/tools/catalog.js - 工具注册表 (参考 openhanako tool-catalog + deepseek Capability Seam)
// 升级: 能力缝三分法(Definition元数据/Provider实现/Consumer策略) + 热挂载(enable/disable/unregister) + 元数据枚举
// P0 (2026-09-15): 策略订阅者链 + deny-wins 合并 (吸收 Aegis/HookBus 治理语义) ——
//   安全策略 (命令守卫/免疫闸门/防注入) 挂到工具执行唯一收口, 成为架构不变量而非可选行为
import { info } from "../utils/logger.js";
import { normalizeMeta, runWithPolicy, toDescriptor, TOOL_ERROR_PREFIX } from "./seam.js";
// 熔断器 (src/bus/): 保护策略链不被故障订阅者反复拖累 —— 这正是该模块注释声明的设计意图。
// 接线前它是"完整实现但零消费者"的预留件 (2026-09-17 接入)。
import { CircuitBreaker } from "../bus/circuit-breaker.js";

export { TOOL_ERROR_PREFIX };

// 策略订阅者默认熔断参数: 60s 窗口内 3 次异常 → 熔断, 冷却 10s 后放行单个探测
const DEFAULT_SUBSCRIBER_BREAKER = { threshold: 3, windowMs: 60000, cooldownMs: 10000 };

// ---- Deny-Wins 决策合并 (HookBus consolidate 语义) ----
// 多个策略订阅者对同一工具调用给出冲突决策时:
//   任一 deny 一票否决 (取最高优先级 reason); 否则任一 ask → ask; 否则 allow
// 保证安全策略不能被低优先级 allow 投票覆盖 (纵深防御: 治理/合规/预算可叠加互不干扰)
export function consolidateDecisions(decisions) {
  const denies = decisions.filter((d) => d && d.decision === "deny");
  if (denies.length > 0) {
    const top = denies.reduce((a, b) => ((a.priority || 0) >= (b.priority || 0) ? a : b));
    return { decision: "deny", reason: top.reason || "策略拒绝", priority: top.priority || 0 };
  }
  const asks = decisions.filter((d) => d && d.decision === "ask");
  if (asks.length > 0) {
    const top = asks.reduce((a, b) => ((a.priority || 0) >= (b.priority || 0) ? a : b));
    return { decision: "ask", reason: top.reason || "需要审批", priority: top.priority || 0 };
  }
  return { decision: "allow", reason: null, priority: 0 };
}

// ---- 参数校验 (2026-10-03, "想记做学评"框架第 3 条: 参数要校验) ----
// 工具声明了 JSON Schema 但此前运行时零校验 — 参数错误浪费一整轮 LLM 交互。
// 轻量子集: required / type / enum (顶层), 未知键放行 (LLM 常带冗余键, 不因苛刻而误杀)。
// 返回 null = 通过; 字符串 = 可行动错误信息。
export function validateArgs(meta, args) {
  const schema = meta?.parameters;
  if (!schema || schema.type !== "object") return null;
  const a = (args && typeof args === "object" && !Array.isArray(args)) ? args : {};
  const problems = [];
  for (const key of schema.required || []) {
    const v = a[key];
    if (v === undefined || v === null || (typeof v === "string" && !v.trim())) {
      problems.push(`缺少必填参数 "${key}"`);
    }
  }
  for (const [key, ps] of Object.entries(schema.properties || {})) {
    const v = a[key];
    if (v === undefined) continue;
    const t = Array.isArray(v) ? "array" : typeof v;
    if (ps.type && t !== ps.type) {
      // 数字宽容: "42" 这类字符串数字自动转换语义提示, 不直接判死
      if (ps.type === "number" && t === "string" && v.trim() !== "" && !isNaN(Number(v))) {
        a[key] = Number(v);
        continue;
      }
      problems.push(`参数 "${key}" 应为 ${ps.type}, 实际 ${t}`);
      continue;
    }
    if (ps.enum && !ps.enum.includes(v)) {
      problems.push(`参数 "${key}" 应为: ${ps.enum.join(" / ")}, 实际 "${v}"`);
    }
  }
  return problems.length ? problems.join("; ") : null;
}

export class ToolCatalog {
  constructor() {
    this.tools = new Map(); // name -> meta (Definition + Provider)
    this.policySubscribers = []; // 策略订阅者: { fn(name,args,ctx)->Decision|null, priority, name }
    // 工具披露策略 (2026-10-03, 上下文工程): 与 enabled **正交** —— 控制"给 LLM 看哪些",
    // 不影响"能调用哪些"。动机: 59 个工具的 JSON schema 实测约占 6725 tok/请求,
    // 占空会话固定开销的 82%, 而单个任务通常只用 3–5 个工具。
    // 未披露的工具仍可被 catalog.call 调用 (内部链路与既有测试完全不受影响),
    // 只是不出现在 toOpenAI() 的 tools 参数里; agent 可通过 enable_capability 动态披露。
    this.exposeSet = null; // null = 全部披露 (向后兼容默认)
  }

  // ---- Definition + Provider 注册 ----
  register(def) {
    if (!def || typeof def.execute !== "function") {
      throw new Error(`工具注册失败: 需 name + execute (got ${def && def.name})`);
    }
    const meta = normalizeMeta(def); // 关键: execute 缺失由 normalizeMeta 的 name 校验兜底
    this.tools.set(meta.name, meta);
    info(`能力已注册: ${meta.name} [${meta.category}/${meta.power}]`);
    return this;
  }

  // ---- 热挂载: 卸载 ----
  unregister(name) {
    const had = this.tools.delete(name);
    if (had) info(`能力已卸载: ${name}`);
    return had;
  }

  // ---- 能力声明查询 (ZCode PermissionToolCapability 语义) ----
  // 未声明时按 category/power 推断保守默认: system 域一律视为高风险
  getCapability(name) {
    const t = this.tools.get(name);
    if (!t) return null;
    if (t.capability) return t.capability;
    if (t.category === "system") return { riskLevel: "high", destructive: true, sideEffect: "system" };
    if (t.category === "net") return { riskLevel: "high", sideEffect: "network" };
    return { riskLevel: "low", readOnly: true, sideEffect: "none" };
  }

  // ---- 热挂载: 启用/禁用 ----
  enable(name) {
    const t = this.tools.get(name);
    if (!t) return false;
    t.enabled = true;
    return true;
  }

  disable(name) {
    const t = this.tools.get(name);
    if (!t) return false;
    t.enabled = false;
    return true;
  }

  // ---- OpenAI 兼容的 tools 格式 (给 LLM 用, 只含 启用且已披露 的项) ----
  toOpenAI() {
    return [...this.tools.values()]
      .filter((t) => t.enabled && this.isExposed(t.name))
      .map((t) => ({
        type: "function",
        function: { name: t.name, description: t.description, parameters: t.parameters },
      }));
  }

  // ---- 披露策略 (与 enabled 正交) ----
  // setExposure(["read_file", ...]) → 只把列出的工具给 LLM; setExposure(null) → 恢复全量
  setExposure(names) {
    if (names === null || names === undefined) {
      this.exposeSet = null;
      return;
    }
    this.exposeSet = new Set(names);
  }

  expose(name) {
    if (this.exposeSet) this.exposeSet.add(name);
    return this;
  }

  isExposed(name) {
    return this.exposeSet === null || this.exposeSet.has(name);
  }

  // 已注册但未披露给 LLM 的工具名 (供 _context 生成"按需启用"提示)。只算 enabled 的 ——
  // 被 tools.disabled 显式关掉的工具既不可调用也不该提示。
  hiddenFromLLM() {
    if (!this.exposeSet) return [];
    return [...this.tools.values()]
      .filter((t) => t.enabled && !this.exposeSet.has(t.name))
      .map((t) => t.name);
  }

  // ---- 审计: 可选注入审计哈希链 (未注入时零开销, 保持向后兼容) ----
  // 吸收自 ppx-v2: 每次工具调用落一条 append-only + SHA-256 链式记录, 防审计日志被悄悄改写
  setAudit(auditLog) {
    this.audit = auditLog || null;
    return this;
  }

  // ---- 策略订阅者 (P0): 工具执行唯一收口上的安全策略链 ----
  // fn(name, args, ctx) -> Promise<{decision:'allow'|'deny'|'ask', reason?, priority?}> | null (null/undefined = 弃权)
  // priority: 高者优先 (合并冲突决策时取高优先级 reason); 默认 0
  // 订阅者异常不拖垮工具执行: 记日志并视同弃权 (fail-open), 且由 per-subscriber 熔断器兜底 ——
  //   连续异常达阈值后进入熔断期, 期间该订阅者直接跳过错开 (不再反复调用 + 不再刷日志), 冷却后半开探测。
  addPolicySubscriber(fn, { priority = 0, name = "", breaker = null } = {}) {
    if (typeof fn !== "function") throw new Error("策略订阅者需为函数");
    const sub = {
      fn,
      priority: Number(priority) || 0,
      name: name || `policy-${this.policySubscribers.length + 1}`,
      // fail-closed: 熔断期 before() 返回 {allowed:false}, 由策略链跳过该订阅者 (弃权) 而非放行
      breaker: new CircuitBreaker({
        ...DEFAULT_SUBSCRIBER_BREAKER,
        ...(breaker || {}),
        failPolicy: "fail-closed",
      }),
    };
    this.policySubscribers.push(sub);
    return () => {
      const i = this.policySubscribers.indexOf(sub);
      if (i >= 0) this.policySubscribers.splice(i, 1);
    };
  }

  // 策略订阅者熔断状态 (可观测): 谁在闭合/熔断/半开, 调用数/熔断次数/窗口内失败数
  policyStatus() {
    return this.policySubscribers.map((s) => ({
      name: s.name,
      priority: s.priority,
      ...(s.breaker && typeof s.breaker.stats === "function" ? s.breaker.stats() : {}),
    }));
  }

  // 未注入策略订阅者时零开销 (空数组循环天然跳过)
  async _runPolicyChain(name, args, ctx) {
    if (!this.policySubscribers.length) return { decision: "allow", reason: null, priority: 0 };
    const results = await Promise.all(this.policySubscribers.map(async (sub) => {
      const breaker = sub.breaker;
      // 熔断期: 跳过故障订阅者 (视同弃权), 避免反复调用 + 日志刷屏
      const verdict = breaker && typeof breaker.before === "function" ? breaker.before() : { allowed: true };
      if (!verdict.allowed) {
        info(`[policy] 订阅者 ${sub.name} 熔断中 (${verdict.reason}), 本轮弃权`);
        return null;
      }
      try {
        const d = await sub.fn(name, args, ctx);
        breaker?.after?.(true);
        if (!d || !d.decision) return null;
        return { decision: d.decision, reason: d.reason || null, priority: d.priority ?? sub.priority };
      } catch (e) {
        breaker?.after?.(false);
        const st = breaker && typeof breaker.state === "string" ? breaker.state : "closed";
        info(`[policy] 订阅者 ${sub.name} 异常, 视同弃权: ${e?.message || e}${st === "open" ? " (已熔断)" : ""}`);
        return null;
      }
    }));
    return consolidateDecisions(results.filter(Boolean));
  }

  // ---- Consumer: 统一策略执行 ----
  async call(name, args, ctx = {}) {
    const meta = this.tools.get(name);
    if (!meta) {
      return `${TOOL_ERROR_PREFIX} 未知工具: ${name}`;
    }
    // 参数校验先行 (在权限/策略之前: 参数都错了就别问权限)
    const argProblem = validateArgs(meta, args);
    if (argProblem) {
      const hint = Object.keys(meta.parameters?.properties || {}).length
        ? ` 可用参数: ${Object.keys(meta.parameters.properties).join(", ")}`
        : "";
      return `${TOOL_ERROR_PREFIX} ${name}: 参数错误 — ${argProblem}.${hint}`;
    }
    info(`tool: ${name}(${JSON.stringify(args)})`);
    // P0: 策略链先行 (deny-wins) —— 免疫闸门/命令守卫/防注入在此拦截, 不可被旁路
    const policy = await this._runPolicyChain(name, args, ctx);
    if (policy.decision === "deny") {
      return `${TOOL_ERROR_PREFIX} ${name}: 策略拦截: ${policy.reason || "未授权"}`;
    }
    if (policy.decision === "ask") {
      return `${TOOL_ERROR_PREFIX} ${name}: 需要人工审批: ${policy.reason || "敏感操作"}`;
    }
    if (!this.audit) return runWithPolicy(meta, args, ctx);
    const t0 = Date.now();
    try {
      const r = await runWithPolicy(meta, args, ctx);
      const failed = typeof r === "string" && r.startsWith(TOOL_ERROR_PREFIX);
      this.audit.append({ tool: name, args, ok: !failed, error: failed ? String(r).slice(0, 200) : null, ms: Date.now() - t0 });
      return r;
    } catch (e) {
      this.audit.append({ tool: name, args, ok: false, error: e?.message || String(e), ms: Date.now() - t0 });
      throw e;
    }
  }

  has(name) {
    return this.tools.has(name);
  }

  // 元数据查询 (v1.6.0 第四刀: 超时重试需要知道工具是否幂等/超时预算)
  metaOf(name) {
    return this.tools.get(name) || null;
  }

  list() {
    return [...this.tools.keys()];
  }

  // ---- 元数据枚举 (供 selfmod / 追踪) ----
  listDetailed() {
    return [...this.tools.values()].map(toDescriptor);
  }
}

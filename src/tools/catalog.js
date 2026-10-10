// src/tools/catalog.js - 工具注册表 (参考 openhanako tool-catalog + deepseek Capability Seam)
// 升级: 能力缝三分法(Definition元数据/Provider实现/Consumer策略) + 热挂载(enable/disable/unregister) + 元数据枚举
// P0 (2026-09-15): 策略订阅者链 + deny-wins 合并 (吸收 Aegis/HookBus 治理语义) ——
//   安全策略 (命令守卫/免疫闸门/防注入) 挂到工具执行唯一收口, 成为架构不变量而非可选行为
import { info } from "../utils/logger.js";
import { normalizeMeta, runWithPolicy, toDescriptor, TOOL_ERROR_PREFIX } from "./seam.js";
// 熔断器 (src/bus/): 保护策略链不被故障订阅者反复拖累 —— 这正是该模块注释声明的设计意图。
// 接线前它是"完整实现但零消费者"的预留件 (2026-09-17 接入)。
import { CircuitBreaker } from "../bus/circuit-breaker.js";
import { toolResultStatus } from "../core/tool-result.js";

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
// 轻量子集: required / type / enum / 显式 additionalProperties:false (顶层)。
// 未声明拒绝未知参数的自定义工具保留原有字段。
// 返回 null = 通过; 字符串 = 可行动错误信息。
export function validateArgs(meta, args) {
  const schema = meta?.parameters;
  if (!schema || schema.type !== "object") return null;
  const a = (args && typeof args === "object" && !Array.isArray(args)) ? args : {};
  const problems = [];
  if (schema.additionalProperties === false) {
    for (const key of Object.keys(a)) {
      if (!Object.hasOwn(schema.properties || {}, key)) problems.push(`未知参数 "${key}"`);
    }
  }
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
    // 按需工具暴露名单: null = 全部对 LLM 可见; Set = 仅该名单进函数数组,
    //   其余降级为【按需工具】静态区名单 (名字可见、schema 不占 tool 数组)。
    this._exposure = null;
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
    if (t.category === "system") return { readOnly: false, riskLevel: "high", destructive: true, sideEffect: "system" };
    if (t.category === "net") return { readOnly: false, riskLevel: "high", destructive: false, sideEffect: "network" };
    return { readOnly: false, riskLevel: "medium", destructive: false, sideEffect: "unknown" };
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

  // ---- OpenAI 兼容的 tools 格式 (给 LLM 用, 只含启用项) ----
  // 2026-10-05 契约 E: 输出恒按【名称字节升序】—— 注册时序抖动 (插件加载顺序/Map 插入序)
  //   不得改变数组字节序, 否则每次启动都作废 provider 端的前缀缓存。
  toOpenAI() {
    return [...this.tools.values()]
      .filter((t) => t.enabled && this._isExposed(t.name))
      .map((t) => ({
        type: "function",
        function: { name: t.name, description: t.description, parameters: t.parameters },
      }))
      .sort((a, b) => (a.function.name < b.function.name ? -1 : a.function.name > b.function.name ? 1 : 0));
  }

  // ---- 按需工具 (2026-10-05 前缀缓存契约 E) ----
  // setExposure(names): 限定进 LLM 函数数组的工具; 其余启用工具降级为"按需"——
  //   名字仍出现在 system 静态区【按需工具】名单里 (见 agent prompts), schema 不占 tool 数组。
  //   传 null/非数组 = 撤销限制 (全部可见)。返回 this 便于链式。
  setExposure(names) {
    this._exposure = Array.isArray(names) ? new Set(names.map(String)) : null;
    return this;
  }

  _isExposed(name) {
    return !this._exposure || this._exposure.has(name);
  }

  // 被隐藏出 LLM 函数数组的启用工具名 (供静态区【按需工具】名单使用), 恒名称升序。
  hiddenFromLLM() {
    if (!this._exposure) return [];
    return [...this.tools.values()]
      .filter((t) => t.enabled && !this._isExposed(t.name))
      .map((t) => t.name)
      .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
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
  // Security policies are mandatory by default. Only explicitly optional
  // observation subscribers may abstain when unavailable.
  addPolicySubscriber(fn, { priority = 0, name = "", breaker = null, mandatory = true } = {}) {
    if (typeof fn !== "function") throw new Error("策略订阅者需为函数");
    const sub = {
      fn,
      priority: Number(priority) || 0,
      name: name || `policy-${this.policySubscribers.length + 1}`,
      mandatory: mandatory !== false,
      // Mandatory subscriber unavailability becomes deny, including open circuits.
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
      mandatory: s.mandatory,
      ...(s.breaker && typeof s.breaker.stats === "function" ? s.breaker.stats() : {}),
    }));
  }

  // 未注入策略订阅者时零开销 (空数组循环天然跳过)
  async _runPolicyChain(name, args, ctx) {
    if (!this.policySubscribers.length) return { decision: "allow", reason: null, priority: 0 };
    const results = await Promise.all(this.policySubscribers.map(async (sub) => {
      const breaker = sub.breaker;
      // Avoid re-invoking an open circuit, without removing required protection.
      const verdict = breaker && typeof breaker.before === "function" ? breaker.before() : { allowed: true };
      if (!verdict.allowed) {
        info(`[policy] 订阅者 ${sub.name} 熔断中 (${verdict.reason})`);
        return sub.mandatory
          ? { decision: "deny", reason: `安全策略 ${sub.name} 不可用 (熔断), 已拒绝执行`, priority: sub.priority }
          : null;
      }
      try {
        const d = await sub.fn(name, args, ctx);
        if (d && !["allow", "deny", "ask"].includes(d.decision)) {
          throw new Error("策略返回了无效决策");
        }
        breaker?.after?.(true);
        if (!d) return null; // A healthy policy may legitimately have no restriction.
        return { decision: d.decision, reason: d.reason || null, priority: d.priority ?? sub.priority };
      } catch (e) {
        breaker?.after?.(false);
        const st = breaker && typeof breaker.state === "string" ? breaker.state : "closed";
        info(`[policy] 订阅者 ${sub.name} 异常${st === "open" ? " (已熔断)" : ""}`);
        return sub.mandatory
          ? { decision: "deny", reason: `安全策略 ${sub.name} 不可用 (异常), 已拒绝执行`, priority: sub.priority }
          : null;
      }
    }));
    return consolidateDecisions(results.filter(Boolean));
  }

  // ---- Consumer: 统一策略执行 ----
  async call(name, args, ctx = {}) {
    const refuse = (result) => {
      if (typeof ctx.onOutcome === "function") ctx.onOutcome({ ...toolResultStatus(result), dispatched: false });
      return result;
    };
    const meta = this.tools.get(name);
    if (!meta) {
      return refuse(`${TOOL_ERROR_PREFIX} 未知工具: ${name}`);
    }
    // args 归一 (2026-10-10 修复): 无必填参数的工具常被 LLM 以 undefined/null 调用,
    //   一路透传到 execute 里做 `args.path` 即 TypeError。在统一收口处归一为 {}，
    //   让 execute 永远拿到对象; 有必填参数的工具仍由 validateArgs 正常判"参数错误"
    //   (归一不得把"缺参"变成静默成功)。
    if (args === undefined || args === null) args = {};
    // 参数校验先行 (在权限/策略之前: 参数都错了就别问权限)
    const argProblem = validateArgs(meta, args);
    if (argProblem) {
      const hint = Object.keys(meta.parameters?.properties || {}).length
        ? ` 可用参数: ${Object.keys(meta.parameters.properties).join(", ")}`
        : "";
      return refuse(`${TOOL_ERROR_PREFIX} ${name}: 参数错误 — ${argProblem}.${hint}`);
    }
    // F5 不变量 (2026-10-05): 调用日志只打参数名清单, 不打任何参数值 ——
    // 旧实现 JSON.stringify(args) 会把 200KB 正文/密钥/token 原样写进 stdout。
    info(`tool: ${name}(${Object.keys(meta.parameters?.properties || {}).join(", ")})`);
    // P0: 策略链先行 (deny-wins) —— 免疫闸门/命令守卫/防注入在此拦截, 不可被旁路
    const policy = await this._runPolicyChain(name, args, ctx);
    if (policy.decision === "deny") {
      const reason = `策略拦截: ${policy.reason || "未授权"}`;
      // 2026-10-10 修复 (P1-2): 被拦调用原先直接 return, 账本里查无此条 ——
      // "可审计"的核心恰恰是"拦了什么"。补记 ok=false + 原因 (审计写入失败不阻断)。
      try { this.audit?.append({ tool: name, args, ok: false, error: reason, ms: 0 }); } catch { /* 审计降级不阻塞 */ }
      return refuse(`${TOOL_ERROR_PREFIX} ${name}: ${reason}`);
    }
    if (policy.decision === "ask") {
      const reason = `需要人工审批: ${policy.reason || "敏感操作"}`;
      try { this.audit?.append({ tool: name, args, ok: false, error: reason, ms: 0 }); } catch { /* 审计降级不阻塞 */ }
      return refuse(`${TOOL_ERROR_PREFIX} ${name}: ${reason}`);
    }
    if (!this.audit) return runWithPolicy(meta, args, ctx);
    const t0 = Date.now();
    try {
      let outcome = null;
      const r = await runWithPolicy(meta, args, { ...ctx, onOutcome: (status) => {
        outcome = status;
        if (typeof ctx.onOutcome === "function") ctx.onOutcome(status);
      } });
      const failed = !(outcome || toolResultStatus(r)).ok;
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

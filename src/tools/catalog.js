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

export class ToolCatalog {
  constructor() {
    this.tools = new Map(); // name -> meta (Definition + Provider)
    this.policySubscribers = []; // 策略订阅者: { fn(name,args,ctx)->Decision|null, priority, name }
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
  toOpenAI() {
    return [...this.tools.values()]
      .filter((t) => t.enabled)
      .map((t) => ({
        type: "function",
        function: { name: t.name, description: t.description, parameters: t.parameters },
      }));
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

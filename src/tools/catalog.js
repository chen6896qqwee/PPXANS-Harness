// src/tools/catalog.js - 工具注册表 (参考 openhanako tool-catalog + deepseek Capability Seam)
// 升级: 能力缝三分法(Definition元数据/Provider实现/Consumer策略) + 热挂载(enable/disable/unregister) + 元数据枚举
// P0 (2026-09-15): 策略订阅者链 + deny-wins 合并 (吸收 Aegis/HookBus 治理语义) ——
//   安全策略 (命令守卫/免疫闸门/防注入) 挂到工具执行唯一收口, 成为架构不变量而非可选行为
import { info, warn } from "../utils/logger.js";
import { normalizeMeta, runWithPolicy, toDescriptor, deprecatedHint, TOOL_ERROR_PREFIX } from "./seam.js";
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

// F5 (2026-10-05): 控制台日志只呈现"调用形状" —— 参数名列表, 取值一律不落 stdout。
// 有意不复用 audit-chain 的 scrubArgs: 那是"落盘账本"的截断+掩码策略, 值本身仍会进文件;
// 控制台没有取证需求, 少一个泄密面比多一个预览更省事 (参见 catalog.call)。
function argNamesOf(args) {
  if (!args || typeof args !== "object" || Array.isArray(args)) return "";
  return Object.keys(args).join(", ");
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
    this._deprecatedWarned = new Set(); // 弃用告警去重 (见 call 内注释)
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
  // F1 (2026-10-05): 兜底必须是**失败关闭**。
  // 旧兜底把一切未声明工具报成 {riskLevel:"low", readOnly:true, sideEffect:"none"}, 而
  // permissions 的能力门正是拿 readOnly 判 plan 模式与只读沙箱 —— 于是 46/64 个未声明工具
  // 里包含 code_act / spawn_agent / git_commit / memory_import 这类执行与写入工具, 它们
  // 在「只读」标签下被直通 (实测: plan+READ_ONLY 全部 allow)。现改为非只读兜底:
  //   - readOnly:false → plan 模式一律拒绝、只读沙箱升级审批 (permissions 侧按声明裁定)
  //   - riskLevel:"medium" → 默认(workspace-write/on-request)模式下**不**新增审批:
  //     能力门只对 high/critical/alwaysAsk 升级 (见 src/permissions/index.js askByCap),
  //     所以新工具忘了声明能力时失去的是「只读」豁免, 而不是把正常模式变成处处弹窗。
  //   - 真正该静默只读的工具必须由注册方显式声明 readOnly:true (test/capability-guard.test.js
  //     用真目录把这条钉成不变量: 任何 catalog.register 缺 capability 直接红)。
  // 例外: category=system/net 的保守默认保留 (system 仍按高风险破坏性处理)。
  getCapability(name) {
    const t = this.tools.get(name);
    if (!t) return null;
    if (t.capability) return t.capability;
    if (t.category === "system") return { riskLevel: "high", readOnly: false, destructive: true, sideEffect: "system" };
    if (t.category === "net") return { riskLevel: "medium", readOnly: false, destructive: false, sideEffect: "network" };
    // 未知能力 = 不假定只读 (fail closed)
    return { riskLevel: "medium", readOnly: false, destructive: false, sideEffect: "unknown" };
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
  // 前缀缓存加固 (2026-10-05, cache-audit 检查 c 的观测项): 按名称字节序输出, 不再依赖
  // Map 注册时序。tools 数组位于请求序列化最前端, 是 provider 最长公共前缀的第一段 ——
  // 注册顺序今天恒定, 但任何装配时序改动 (插件加载顺序/条件注册) 都会静默作废整个缓存前缀。
  // 纯排序: 条目内容与集合完全不变, 只有输出次序确定化。
  toOpenAI() {
    return [...this.tools.values()]
      .filter((t) => t.enabled && this.isExposed(t.name))
      .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
      .map((t) => ({
        type: "function",
        function: {
          name: t.name,
          // 弃用标记直接进描述: LLM 只看得到 description, 标记不进这里等于没标
          description: t.deprecated ? `${deprecatedHint(t.deprecated)} ${t.description}` : t.description,
          parameters: t.parameters,
        },
      }));
  }

  // 已弃用工具清单 (供自省与迁移检查)
  deprecatedTools() {
    return [...this.tools.values()]
      .filter((t) => t.deprecated)
      .map((t) => ({ name: t.name, ...t.deprecated }))
      .sort((a, b) => (a.name < b.name ? -1 : 1));
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
  // 排序 (2026-10-05): 这份名单被拼进 system 静态区的【按需工具】块, 与 toOpenAI 同理,
  // Map 注册序一旦抖动就作废前缀缓存 —— 纯排序, 集合不变。
  hiddenFromLLM() {
    if (!this.exposeSet) return [];
    return [...this.tools.values()]
      .filter((t) => t.enabled && !this.exposeSet.has(t.name))
      .map((t) => t.name)
      .sort();
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
    // 参数形态归一 (2026-10-05 真跑基准里 list_dir 的"执行报错"来源之一): 无必填参数的工具
    // 被以 undefined/null 调用时 (模型给空调用、provider 回传 "null" 字面量), validateArgs
    // 已按 {} 放过校验, 但 execute 里 args.path 直接 TypeError → [工具错误]。
    // 原则: 通过校验的 args 形状必须就是 execute 拿到的形状, 校验与执行不能各看一份。
    if (!args || typeof args !== "object") args = {};
    // 弃用告警 (只打一次/工具/进程): 存量链路还要跑完, 这里只提醒不阻断。
    // 用 Set 去重 —— 不加会让一个被反复调用的弃用工具把日志刷爆, 反而没人看得见。
    if (meta.deprecated && !this._deprecatedWarned.has(name)) {
      this._deprecatedWarned.add(name);
      const d = meta.deprecated;
      warn(`[tools] 调用了已弃用工具 ${name}${d.replacedBy ? ` (改用 ${d.replacedBy})` : ""}${d.since ? ` — 自 ${d.since} 起` : ""}${d.note ? `: ${d.note}` : ""}`);
    }
    // 参数校验先行 (在权限/策略之前: 参数都错了就别问权限)
    const argProblem = validateArgs(meta, args);
    if (argProblem) {
      const hint = Object.keys(meta.parameters?.properties || {}).length
        ? ` 可用参数: ${Object.keys(meta.parameters.properties).join(", ")}`
        : "";
      return `${TOOL_ERROR_PREFIX} ${name}: 参数错误 — ${argProblem}.${hint}`;
    }
    // F5 (2026-10-05): 只打**参数名**, 不打值。
    // 旧实现 `tool: ${name}(${JSON.stringify(args)})` 把整份 args 原样写进控制台:
    //   实测一次 write_file(200KB) 输出 205,233 字节, 且 content 里的 api_key=… 明文可见。
    //   审计链那边是 scrubArgs(500 字截断 + 密钥掩码) 后落盘 (src/audit/audit-chain.js),
    //   这一行等于把同一个洞重新打开; .bat/.vbs 启动器还常开着可见控制台。
    // 参数值如需取证请看审计账本, 控制台只留调用形状 (工具名 + 形参名)。
    info(`tool: ${name}(${argNamesOf(args)})`);
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

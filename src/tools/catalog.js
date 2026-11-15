// src/tools/catalog.js - 工具注册表 (设计溯源 docs/PROVENANCE.md#hanaagent / #dsh; 自研)
// 升级: 能力缝三分法(Definition元数据/Provider实现/Consumer策略) + 热挂载(enable/disable/unregister) + 元数据枚举
// P0 (2026-09-15): 策略订阅者链 + deny-wins 合并 (设计溯源 docs/PROVENANCE.md#aegis; 治理语义自研) ——
//   安全策略 (命令守卫/免疫闸门/防注入) 挂到工具执行唯一收口, 成为架构不变量而非可选行为
import { info, warn as catalogWarn } from "../utils/logger.js";
import { normalizeMeta, runWithPolicy, toDescriptor, TOOL_ERROR_PREFIX } from "./seam.js";
import { isToolErrorResult } from "../core/errors.js";
// 熔断器 (src/bus/): 保护策略链不被故障订阅者反复拖累 —— 这正是该模块注释声明的设计意图。
// 接线前它是"完整实现但零消费者"的预留件 (2026-09-17 接入)。
import { CircuitBreaker } from "../bus/circuit-breaker.js";
import { noteCatch } from "../utils/catch-log.js";
// 架构优化 ②(2026-11-13): 审计条目带 runId —— 与 trace/工单/委派同一条血缘
import { currentRunId } from "../core/run-context.js";

export { TOOL_ERROR_PREFIX };

// 策略订阅者默认熔断参数: 60s 窗口内 3 次异常 → 熔断, 冷却 10s 后放行单个探测
const DEFAULT_SUBSCRIBER_BREAKER = { threshold: 3, windowMs: 60000, cooldownMs: 10000 };

// ---- 按需工具: 核心曝光名单 (2026-10-30) ----
// 为什么要它: 工具 schema 是全仓最贵的固定开销 —— 实测 96 个工具 schema ≈ 11.2k tok/请求,
//   占固定上下文 (14.5k) 的 77%。而 data/logs/traces 的真实轨迹 (2026-10-23~10-30, 327 条)
//   里只有约 30 个工具被调用过, 前 10 个占 2/3 调用量: 长尾工具一辈子难得调一次, 却每轮付钱。
// 机制不是新造的: ToolCatalog.setExposure 早就实现了"名单内下发 schema, 其余只留名字",
//   但此前**零调用方**(注释写"见 agent prompts", 而 prompts 里并没有那一段) —— 属于典型的
//   "完整实现 + 半截接线"。本常量 + agent._applyToolExposure + prompts._toolsPrompt 把它接通。
// 默认值已是 "core" (2026-11-02 起, src/config/index.js; 实测固定开销 11.2k → 5.9k tok/请求)。
// 要全量下发就设 agent.tool_exposure: "all"。 (此行曾写反默认值 —— 评测-II 杂项修正)
export const CORE_TOOL_EXPOSURE = [
  // 文件读写与改代码 (主干闭环: 找 → 读 → 改 → 验)
  "read_file", "write_file", "append_file", "delete_file", "move_file", "undo_file",
  "list_dir", "search_files", "grep", "lsp", "apply_patch", "edit_lines",
  // 执行
  "run_command", "shell", "run_background", "job", "code_act", "code_run",
  // 文档/图片
  "read_document", "read_image",
  // 网络
  "web_search", "fetch_page", "http_request",
  // 记忆
  "memory_search", "memory_add",
  // 链式召回 (二期③): 被裁剪工具结果的续读入口 (schema 必须常驻 ——
  // 告示牌引导模型调用它, 若 schema 按需才下发, 模型看得见名字却拿不到参数定义)
  "context_read",
  // 回合内计划 (v5.0): 多步任务的工作记忆, 常驻下发才能"开工就列计划"
  "update_plan",
  // 技能 (渐进加载的入口: 只列名 → skill_search → load_skill)
  "load_skill", "skill_search",
  // 委派 (一次性派活 / 长驻话题驻派)
  "spawn_agent", "follow_thread",
  // 人机与环境
  "get_time", "notify", "clarify", "ask_user",
  // 元能力 (取 schema / 枚举能力) + 自审 (自优化闭环的主动入口)
  "tool_schema", "list_capabilities", "self_audit",
];

// 任何曝光名单都必须保留的元工具 —— 否则模型连"怎么把别的工具的参数取出来"都不知道,
// 按需模式会退化成"看得到名字但永远调不对"。自定义名单会被强制并入这两项。
export const META_TOOLS_ALWAYS = ["tool_schema", "list_capabilities"];

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

// 未知工具名 → 最相近的已注册工具 (编辑距离 + 子串包含)。错别字是最常见的调用失败,
// 给两个候选比"未知工具"四个字有用得多, 也让模型下一轮能自己改对。
function nearestToolNames(name, available, max = 2) {
  const needle = String(name || "").toLowerCase();
  if (!needle) return [];
  const dist = (a, b) => {
    const m = a.length, n = b.length;
    if (!m) return n;
    if (!n) return m;
    let prev = Array.from({ length: n + 1 }, (_, i) => i);
    for (let i = 1; i <= m; i++) {
      const cur = [i];
      for (let j = 1; j <= n; j++) {
        cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      }
      prev = cur;
    }
    return prev[n];
  };
  return available
    .map((x) => {
      const lower = x.toLowerCase();
      let d = dist(needle, lower);
      if (lower.includes(needle) || needle.includes(lower)) d = Math.min(d, 1);
      return { x, d };
    })
    .filter((e) => e.d <= Math.max(2, Math.floor(needle.length / 3)))
    .sort((a, b) => a.d - b.d || a.x.localeCompare(b.x))
    .slice(0, max)
    .map((e) => e.x);
}

export class ToolCatalog {  constructor() {
    this.tools = new Map(); // name -> meta (Definition + Provider)
    this.policySubscribers = []; // 策略订阅者: { fn(name,args,ctx)->Decision|null, priority, name }
    // 按需工具暴露名单: null = 全部对 LLM 可见; Set = 仅该名单进函数数组,
    //   其余降级为【按需工具】静态区名单 (名字可见、schema 不占 tool 数组)。
    this._exposure = null;
    // 运行期临时曝光 (2026-11-02): 模型用 tool_schema 取过某个隐藏工具的 schema 后,
    //   把它加入本集合 —— 从下一轮工具循环开始该工具回到函数数组, 不用再"取一次、猜一次"。
    //   生命周期 = 本次装配 (setExposure 会清空), 不写盘、不影响 hiddenFromLLM 的静态名单。
    this._dynamicExposed = new Set();
    // 永久隐藏 (架构优化 ①, 2026-11-13): 被意图门面收编的原工具 —— 名字仍可 call,
    //   但永不出现在对模型下发的函数数组里 (即使 tool_exposure="all")。
    //   与 _exposure 的区别: 那个是"本次装配的收窄策略", 这个是"这个工具不该单独给模型看"。
    this._hidden = new Set();
  }

  // 永久隐藏: 传名字数组或单个名字。返回实际隐藏数量 (未注册的名字不算)。
  hide(names) {
    let n = 0;
    for (const name of Array.isArray(names) ? names : [names]) {
      if (!name || !this.tools.has(String(name))) continue;
      if (!this._hidden.has(String(name))) { this._hidden.add(String(name)); n += 1; }
    }
    return n;
  }

  hiddenNames() {
    return [...this._hidden].sort();
  }

  // ---- Definition + Provider 注册 ----
  register(def) {
    if (!def || typeof def.execute !== "function") {
      throw new Error(`工具注册失败: 需 name + execute (got ${def && def.name})`);
    }
    const meta = normalizeMeta(def); // 关键: execute 缺失由 normalizeMeta 的 name 校验兜底
    // 2026-10-24 (R2): 重名注册出声 —— 此前 Map.set 静默覆盖, 内置/MCP/用户插件撞名时
    //   先注册的实现无声消失, 排障全靠运气。保留 last-wins 语义 (用户插件可覆写内置工具
    //   是 compose 系统的既定能力), 但覆盖必须留痕。
    if (this.tools.has(meta.name)) {
      catalogWarn(`[catalog] 工具重名覆盖: "${meta.name}" 已存在, 新注册方将替换旧实现 (来源: ${def.source || "unspecified"})`);
    }
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
    this._dynamicExposed.clear(); // 名单变更 = 重新装配, 临时曝光一并失效
    return this;
  }

  // 把已隐藏工具临时放回函数数组 (tool_schema 取过参数后调用)。返回实际生效的名字。
  //   只在收窄模式下有意义; 全量模式本就可见, 直接返回空数组 (不制造无意义状态)。
  expose(names) {
    if (!this._exposure) return [];
    const added = [];
    for (const n of Array.isArray(names) ? names : [names]) {
      const name = String(n || "");
      if (!name || this._exposure.has(name) || this._dynamicExposed.has(name)) continue;
      if (!this.tools.has(name)) continue;
      this._dynamicExposed.add(name);
      added.push(name);
    }
    return added;
  }

  _isExposed(name) {
    // 永久隐藏优先于一切曝光策略 (门面收编的原工具不单独下发)
    if (this._hidden.has(name)) return false;
    if (!this._exposure) return true;
    if (this._exposure.has(name) || this._dynamicExposed.has(name)) return true;
    // MCP 外部工具豁免按需收窄 (2026-11-02): 连接哪个 MCP 服务器是用户显式配置,
    //   工具数量有限且名字在连接时就已确定 —— 把它们藏进【按需工具】等于让"接入外部工具"
    //   需要先取一次 schema 才能用, connectMcp 之后立刻不可见。故 category=mcp 恒下发。
    const t = this.tools.get(name);
    return t?.category === "mcp";
  }

  // 被隐藏出 LLM 函数数组的启用工具名 (供静态区【按需工具】名单使用), 恒名称升序。
  //   已经临时曝光的工具不再出现在这里 —— 否则 system 说"没下发", 实际 tool 数组里有, 自相矛盾。
  hiddenFromLLM() {
    // 全量曝光模式: 除了"永久隐藏"的都在数组里, 而永久隐藏的已有门面作唯一入口,
    //   不该再进按需名单 (名单语义 = "模型可以按需取到的工具")。故这里为空。
    if (!this._exposure) return [];
    // 永久隐藏的工具不进这份名单: 它们已有门面作为唯一入口, 再列一遍等于
    //   把 67 个名字重新塞回 system prompt(架构优化 ① 的目的就没了)。
    return [...this.tools.values()]
      .filter((t) => t.enabled && !this._isExposed(t.name) && !this._hidden.has(t.name))
      .map((t) => t.name)
      .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  }

  // ---- 审计: 可选注入审计哈希链 (未注入时零开销, 保持向后兼容) ----
  // 承接自 ppx-v2: 每次工具调用落一条 append-only + SHA-256 链式记录, 防审计日志被悄悄改写
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
      const near = nearestToolNames(name, [...this.tools.keys()]);
      const hint = near.length ? ` (相近: ${near.join(", ")}; 用 list_capabilities 枚举全部)` : " (用 list_capabilities 枚举可用工具)";
      return `${TOOL_ERROR_PREFIX} 未知工具: ${name}${hint}`;
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
      return `${TOOL_ERROR_PREFIX} ${name}: 参数错误 — ${argProblem}.${hint}`;
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
      try { this.audit?.append({ runId: currentRunId(), tool: name, args, ok: false, error: reason, ms: 0 }); } catch (e) { noteCatch(e); /* 审计降级不阻塞 */ }
      return `${TOOL_ERROR_PREFIX} ${name}: ${reason}`;
    }
    if (policy.decision === "ask") {
      const reason = `需要人工审批: ${policy.reason || "敏感操作"}`;
      try { this.audit?.append({ runId: currentRunId(), tool: name, args, ok: false, error: reason, ms: 0 }); } catch (e) { noteCatch(e); /* 审计降级不阻塞 */ }
      return `${TOOL_ERROR_PREFIX} ${name}: ${reason}`;
    }
    if (!this.audit) return runWithPolicy(meta, args, ctx);
    const t0 = Date.now();
    try {
      const r = await runWithPolicy(meta, args, ctx);
      const failed = isToolErrorResult(r);
      this.audit.append({ runId: currentRunId(), tool: name, args, ok: !failed, error: failed ? String(r).slice(0, 200) : null, ms: Date.now() - t0 });
      return r;
    } catch (e) {
      this.audit.append({ runId: currentRunId(), tool: name, args, ok: false, error: e?.message || String(e), ms: Date.now() - t0 });
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

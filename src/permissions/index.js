// src/permissions/index.js — 三合一权限引擎
// 设计溯源 docs/PROVENANCE.md#codex / #opencode / #claude-code; 三合一自研:
//   codex(AskForApproval + SandboxPolicy 语义) + opencode(通配符规则链 last-match-wins) + CASDK(canUseTool 回调)
// 纯 Node、零运行时依赖、ESM、简体中文注释。
// 2026-11-03 拆分: 路径/越界静态分析 (isWithinRoot / findEscape / provePatchTargets 及其
//   全部私有辅助) 迁往 ./path-guard.js —— 那是一块自洽的"命令词法 → 落点证明"子域, 与
//   决策逻辑 (ask/deny 映射、审批档位、应答者链) 之间只有三个函数调用点。本文件保留决策引擎;
//   isWithinRoot 经此重导出, intersection.js 与 permission-intersection.test.js 的旧 import 路径不变。

import { isWithinRoot, findEscape, provePatchTargets } from "./path-guard.js";
import { noteCatch } from "../utils/catch-log.js";
import { markEscalation } from "../security/escalation-flag.js";

// 2026-10-09 起 isWithinRoot 由本模块导出 (permission-intersection.test.js 与 tools/v3.js 依赖);
// 实现已在 path-guard.js, 这里保持旧 import 路径不变。
export { isWithinRoot };

// ---- codex: 审批模式四档 ----
export const AskForApproval = {
  UNLESS_TRUSTED: "unless-trusted", // 仅非白名单工具需审批
  ON_FAILURE: "on-failure",         // 默认放行, 失败时才问 (本引擎无失败回灌, 视作放行)
  ON_REQUEST: "on-request",         // 仅工具自带 requires_approval 语义时审批
  NEVER: "never",                   // 全自动, ask 降级为 deny (codex: never 不询问)
};

// ---- codex: 沙箱策略三档 + 网络开关 ----
export const SandboxPolicy = {
  READ_ONLY: "read-only",                 // 禁止一切写/执行类工具 (除非 allow 规则命中)
  WORKSPACE_WRITE: "workspace-write",     // 仅允许工作区内写, 路径越界拒绝
  DANGER_FULL_ACCESS: "danger-full-access", // 完全放开
};

// ---- 可信工具白名单 (unless-trusted 模式自动放行) ----
export const TRUSTED_TOOLS = [
  "get_time", "list_dir", "read_file", "read", "memory_search",
  "repo_map", "goal_board", "status", "list_files", "glob", "grep", "search_files",
];

// ---- 档位 rank 表 (2026-10-31: /api/permissions 双门与 /api/bot.manage 收紧共用) ----
//   数值越高 = 越放任。放宽类变更 = 新档位 rank 高于当前档位。
export const APPROVAL_RANK = { "unless-trusted": 0, "on-failure": 1, "on-request": 2, "never": 3 };
export const SANDBOX_RANK = { "read-only": 0, "workspace-write": 1, "danger-full-access": 2 };

/**
 * 识别放宽类权限变更 (提权检测)。收紧/持平返回 []。
 *   cur  当前引擎态 ({ approvalMode, sandbox, networkAccess })
 *   next 意图变更 ({ approvalMode?, sandbox?, networkAccess? })
 * 返回人类可读的变更描述数组 (与 /api/permissions 双门的输出同形)。
 */
export function detectEscalations(cur, next = {}) {
  const escalations = [];
  if (next.approvalMode != null && APPROVAL_RANK[next.approvalMode] > (APPROVAL_RANK[cur.approvalMode] ?? 0)) {
    escalations.push(`approvalMode: ${cur.approvalMode} → ${next.approvalMode}`);
  }
  if (next.sandbox != null && SANDBOX_RANK[next.sandbox] > (SANDBOX_RANK[cur.sandbox] ?? 0)) {
    escalations.push(`sandbox: ${cur.sandbox} → ${next.sandbox}`);
  }
  if (next.networkAccess === true && cur.networkAccess === false) {
    escalations.push("networkAccess: off → on");
  }
  return escalations;
}

/**
 * 提权留痕 (2026-11-13, 评测 P1-3): tracer 之外再写哈希链 + 主动通知。
 *   旧实现只发 tracer 事件 —— 事件流会轮转, 而"谁在何时把沙箱放宽到 danger-full-access"
 *   属于必须与工具调用同链可追责的决定点。审计写入失败不阻断权限变更 (可观测降级),
 *   但会留下 tracer 与通知, 不会静默。
 */
export function recordEscalation(agent, changes, via = "http", dir = null) {
  const list = Array.isArray(changes) ? changes.filter(Boolean) : [];
  if (!list.length) return;
  try {
    agent?.tracer?.event?.("security/permission-escalated", { changes: list, via });
  } catch (e) { noteCatch("src/permissions/index.js#recordEscalation.tracer", e); }
  try {
    // 评测-II P1-1: audit 通道缺失 (config.audit.enabled=false → consume 返回 null) 不再静默 ——
    //   旧实现双重可选链无声跳过, 提权这一安全决策点的审计通道消失得无影无踪。
    if (!agent?.audit?.appendEvent) {
      noteCatch("src/permissions/index.js#recordEscalation.audit-missing",
        new Error("audit 通道不可用 (enabled=false 或未装配), 提权仅剩 tracer/flag/notify 三通道"));
    } else {
      const auditEntry = agent.audit.appendEvent({
        event: "security_permission_escalated",
        fields: { changes: list, via, severity: "high" },
        ok: true,
      });
      if (!auditEntry) {
        noteCatch("src/permissions/index.js#recordEscalation.audit-empty",
          new Error("appendEvent 返回空 (event 名为空?), 提权未入哈希链"));
      }
    }
  } catch (e) { noteCatch("src/permissions/index.js#recordEscalation.audit", e); }
  try {
    // 2026-11-14 (评测 P1-1): 第四通道 —— 持久标志, 看门狗心跳 24h 内 CRIT 广播。
    //   前三通道要么轮转要么被动查阅, "非本人提权"场景心跳无感 (生产 11-03 实测 10 次提权心跳恒 ok)。
    markEscalation({ via, changes: list }, dir);
  } catch (e) { noteCatch("src/permissions/index.js#recordEscalation.flag", e); }
  try {
    if (typeof agent?.notify === "function") {
      agent.notify(`权限已提升 (${via}): ${list.join("; ")}`);
    }
  } catch (e) { noteCatch("src/permissions/index.js#recordEscalation.notify", e); }
}

/**
 * 可选 TTL 自动回落 (评测-II P1-2): security.escalation_ttl_minutes > 0 时, 提权后
 *   N 分钟自动回落到提权前档位。默认 0 = 关闭 —— "即时生效"语义不变 (2026-11-03
 *   用户拍板拆除确认门的决策不反转), TTL 是给想要兜底的部署准备的 opt-in。
 * 回落是完整留痕的安全事件: tracer security/permission-reverted + 哈希链 + notify。
 * 只回落 approvalMode/sandbox (提权签名的两个成员); networkAccess 由用户显式开关管理。
 * 快照守卫: 回落只发生在引擎态仍等于提权后快照时 —— 用户中途手动变更则尊重用户决策。
 */
function armEscalationRevert(permissions, agent, { prev, ttlMinutes }) {
  if (permissions._revertTimer) { clearTimeout(permissions._revertTimer); permissions._revertTimer = null; }
  const ttlMs = Number(ttlMinutes) > 0 ? Math.round(Number(ttlMinutes) * 60000) : 0;
  if (!ttlMs) return;
  const escalated = { approvalMode: permissions.approvalMode, sandbox: permissions.sandbox };
  const revert = () => {
    permissions._revertTimer = null;
    if (permissions.approvalMode !== escalated.approvalMode || permissions.sandbox !== escalated.sandbox) return;
    const changes = [
      `approvalMode: ${escalated.approvalMode} → ${prev.approvalMode}`,
      `sandbox: ${escalated.sandbox} → ${prev.sandbox}`,
    ];
    permissions.approvalMode = prev.approvalMode;
    permissions.sandbox = prev.sandbox;
    try { agent?.tracer?.event?.("security/permission-reverted", { changes, via: "ttl", ttlMinutes: Number(ttlMinutes) }); } catch (e) { noteCatch("src/permissions/index.js#revert.tracer", e); }
    try {
      if (agent?.audit?.appendEvent) {
        agent.audit.appendEvent({ event: "security_permission_reverted", fields: { changes, via: "ttl", severity: "info" }, ok: true });
      }
    } catch (e) { noteCatch("src/permissions/index.js#revert.audit", e); }
    try {
      if (typeof agent?.notify === "function") agent.notify(`权限已到期回落 (TTL ${ttlMinutes} 分钟): ${changes.join("; ")}`);
    } catch (e) { noteCatch("src/permissions/index.js#revert.notify", e); }
  };
  permissions._revertTimer = setTimeout(revert, ttlMs);
  if (typeof permissions._revertTimer.unref === "function") permissions._revertTimer.unref();
}

/**
 * 权限热更新的单一实现 (2026-11-14, 战役遗留项 #8): 校验 → 提权留痕 → 落引擎字段。
 *   此前 POST /api/permissions (http-api-v3) 与 /api/bot.manage action=permission
 *   (web/bot-api) 各写一份"rank 校验 + detectEscalations + 落字段", 同步靠注释自觉 ——
 *   安全语义的双轨迟早漂移, 收敛到一个函数, 两个入口只保留各自的响应形态。
 *
 *   permissions  引擎实例 (agent.permissions)
 *   patch        { approvalMode?, sandbox?, networkAccess? } —— planEnabled/sessionKey
 *                是会话级开关, 不属于引擎三字段, 由 http 侧自行处理
 *   opts.agent   传 agent 用于提权留痕 (tracer/哈希链/通知); 缺省则只改状态不留痕
 *   opts.source  留痕标注来源 ("http" / "bot.manage" / 测试自定)
 *
 * 抛错 = 值非法 (fail-closed, 消息与两入口旧文案逐字一致); 返回 { escalations }。
 */
export function applyPermissionUpdate(permissions, patch = {}, { agent = null, source = "http", dir = null } = {}) {
  if (!permissions) throw new Error("权限引擎未装配");
  if (patch.approvalMode != null && APPROVAL_RANK[patch.approvalMode] == null) {
    throw new Error(`approvalMode 非法: ${patch.approvalMode} (合法: ${Object.keys(APPROVAL_RANK).join("/")})`);
  }
  if (patch.sandbox != null && SANDBOX_RANK[patch.sandbox] == null) {
    throw new Error(`sandbox 非法: ${patch.sandbox} (合法: ${Object.keys(SANDBOX_RANK).join("/")})`);
  }
  const prevSnapshot = { approvalMode: permissions.approvalMode, sandbox: permissions.sandbox };
  const escalations = detectEscalations(permissions, patch);
  if (escalations.length) recordEscalation(agent, escalations, source, dir);
  if (patch.approvalMode) permissions.approvalMode = String(patch.approvalMode);
  if (patch.sandbox) permissions.sandbox = String(patch.sandbox);
  if (patch.networkAccess != null) permissions.networkAccess = !!patch.networkAccess;
  // TTL 回落只在真实提权时武装; 收紧/持平 (用户已介入) 解除未触发的回落定时器。
  if (escalations.length) {
    armEscalationRevert(permissions, agent, {
      prev: prevSnapshot,
      ttlMinutes: agent?.config?.security?.escalation_ttl_minutes,
    });
  } else if (permissions._revertTimer) {
    clearTimeout(permissions._revertTimer);
    permissions._revertTimer = null;
  }
  return { escalations };
}


// 写/执行类工具 (只读沙箱下需升级为 ask, 工作区沙箱下需校验路径)
const WRITE_EXEC_TOOLS = new Set([
  "run_command", "run_background", "shell", "exec", "bash", "apply_patch", "edit_file",
  "write_file", "create_file", "delete_file", "move_file", "rm", "write", "edit",
  "undo_file", // 2026-10-24 (R2): 恢复文件 = 写类副作用
]);

// 网络类工具 (networkAccess=false 时升级 ask)
const HTTP_TOOLS = new Set([
  "http_request", "fetch_page", "fetch", "web_fetch", "curl", "request",
]);

// ON_REQUEST 模式下默认需要审批的工具 (其余按 args.requires_approval 决定)
const REQUIRES_APPROVAL_TOOLS = new Set([
  "run_command", "run_background", "shell", "exec", "bash", "apply_patch", "delete_file", "rm",
]);

// ---- 通配符匹配 (opencode 语义) ----
//  '*'         -> 匹配任意
//  'git *'     -> 前缀匹配 (git / git push ...)
//  'git push'  -> 精确或前缀(后面带空格) 匹配
function wildcardMatch(pattern, str) {
  str = String(str || "").toLowerCase();
  if (pattern === "*") return true;
  const pat = String(pattern || "").toLowerCase();
  if (pat.endsWith(" *")) {
    const pre = pat.slice(0, -2);
    return str === pre || str.startsWith(pre + " ");
  }
  // 无通配: 精确或前缀(带空格)
  return str === pat || str.startsWith(pat + " ");
}

// 规则是否命中: 同时校验工具名, 以及命令型工具的 command 字符串
function ruleMatches(rule, toolName, args) {
  const candidates = [toolName];
  if (typeof args?.command === "string") candidates.push(args.command);
  return candidates.some((c) => wildcardMatch(rule.pattern, c));
}

// ---- 兼容 CASDK canUseTool 回调的返回 ----
// 允许 { behavior:'allow'|'deny' } 或字符串 'allow'/'deny'
export function parseDecision(result) {
  if (!result) return null;
  if (typeof result === "string") return result;
  if (typeof result.behavior === "string") return result.behavior;
  if (typeof result.decision === "string") return result.decision;
  return null;
}

// ---- DSH (DeepSeek Harness) 对齐: 具名权限预设 ----
// 沙箱模式 × 审批策略捆绑成单一「权限」选择器, 客户端一个开关完成授权 (DSH PresetSpec 语义)。
// danger-full-access 捆绑 never (全自动): 按官方事故复盘, 只应配给一次性、可丢弃的沙箱环境。
export const PERMISSION_PRESETS = {
  "workspace-write": {
    sandbox: SandboxPolicy.WORKSPACE_WRITE,
    approval: AskForApproval.ON_REQUEST,
    desc: "可写工作区 + 路径越界拒绝, 高危操作问人 (默认)",
  },
  "read-only": {
    sandbox: SandboxPolicy.READ_ONLY,
    approval: AskForApproval.ON_REQUEST,
    desc: "只读巡检, 写/执行类工具一律审批",
  },
  "danger-full-access": {
    sandbox: SandboxPolicy.DANGER_FULL_ACCESS,
    approval: AskForApproval.NEVER,
    desc: "完全放开不询问 — 仅用于可丢弃环境 (沙箱容器/临时机器)",
  },
};

// 应用具名预设: 校验 → 热更新引擎两个 knob, 返回生效状态 (未知预设抛错, fail closed)
export function applyPreset(engine, presetName) {
  const p = PERMISSION_PRESETS[presetName];
  if (!p) {
    throw new Error(`未知权限预设: ${presetName} (可用: ${Object.keys(PERMISSION_PRESETS).join(", ")})`);
  }
  engine.sandbox = p.sandbox;
  engine.approvalMode = p.approval;
  return { preset: presetName, sandbox: p.sandbox, approval: p.approval, desc: p.desc };
}

// 折叠当前 knob 组合 → 预设名; 组合不匹配任何预设时返回 "custom" (DSH: custom 保留给派生状态)
export function currentPreset(engine) {
  const cfg = engine.config;
  for (const [name, p] of Object.entries(PERMISSION_PRESETS)) {
    if (p.sandbox === cfg.sandbox && p.approval === cfg.approvalMode) return name;
  }
  return "custom";
}

// ---- 工厂: 创建权限引擎 ----
export function createPermissionEngine({
  approvalMode = AskForApproval.ON_REQUEST,
  sandbox = SandboxPolicy.WORKSPACE_WRITE,
  workspaceRoot = process.cwd(),
  networkAccess = false,
  rules = [],
  canUseTool = null,
  onAsk = null, // 可选 ask 应答者 (DSH 应答者链): 提供时 ask 自动询问; 异常/空值 → deny (fail closed)
  // ZCode 工具能力门 (设计溯源 docs/PROVENANCE.md#zcode): getCapability 工具→能力元数据; capabilityGate 总开关
  getCapability = null,
  capabilityGate = false,
  planEnabled = false, // plan 模式: 只读非破坏工具直通, 其余拒绝
  autoApproveHighRisk = false, // high 风险免确认 (critical 永不免)
  // 2026-11-08: 额外允许的根目录 (config.agent.workspace_allow)
  //   "工作区内修改"档位下也能访问这几个目录, 不必把沙箱开到整机放开。
  allowRoots = [],
} = {}) {
  const _rules = Array.isArray(rules) ? rules.map((r) => ({ pattern: r.pattern, action: r.action })) : [];
  // DSH 一次性提权: 人工批准的显式沙箱模式, 胜过会话策略, 单次 check 消费后自动还原
  let _escalation = null;
  // ZCode 能力门状态 (可运行时热切换: plan 模式进出 / 配置热更新)
  let capGetter = getCapability;
  let capGate = capabilityGate;
  let planOn = planEnabled;
  let approveHigh = autoApproveHighRisk;

  function addRule(pattern, action) {
    if (!["allow", "deny", "ask"].includes(action)) {
      throw new Error("addRule action 必须为 allow|deny|ask");
    }
    _rules.push({ pattern, action });
    return _rules.length;
  }

  // 决策主流程
  async function check(toolName, args = {}, ctx = {}) {
    args = args || {};

    // (0) DSH 一次性提权: 人工已批准的显式模式胜过会话沙箱策略, 本次调用后自动还原。
    //     提权只放宽沙箱, 不改审批策略 — ask 类审批照常走 (审批是审批, 沙箱是沙箱)。
    let effectiveSandbox = sandbox;
    let escalated = false;
    if (_escalation) {
      effectiveSandbox = _escalation.mode;
      escalated = true;
      if (_escalation.oneShot) _escalation = null;
    }

    // (a) canUseTool 回调优先 (CASDK)
    if (typeof canUseTool === "function") {
      let res = null;
      try {
        res = await canUseTool(toolName, args, ctx);
      } catch {
        res = null;
      }
      const beh = parseDecision(res);
      if (beh === "allow" || beh === "deny") {
        return {
          decision: beh,
          rule: undefined,
          reason: (res && (res.message || res.reason)) || "canUseTool 回调决策",
        };
      }
    }

    // (b) 规则链 last-match-wins + deny-wins
    let matched = null;
    for (const r of _rules) {
      if (ruleMatches(r, toolName, args)) matched = r;
    }
    if (matched && matched.action === "deny") {
      return { decision: "deny", rule: matched, reason: `命中 deny 规则: ${matched.pattern}` };
    }
    const allowRuleHit = !!(matched && matched.action === "allow");

    // (b2) ZCode 工具能力门: 声明式元数据裁定 (2026-10-02 设计溯源 docs/PROVENANCE.md#zcode PermissionService)
    //   - alwaysAsk 压过一切放行分支 (yolo/白名单直通都要问)
    //   - riskLevel critical → 必问; high → 默认问 (autoApproveHighRisk 可放)
    //   - plan 模式: 只允许 readOnly 非破坏工具 (ZCode mode.plan.readOnly)
    //   - capabilityGate=false 时本门完全关闭 (向后兼容)
    const cap = capGate && typeof capGetter === "function"
      ? capGetter(toolName, args)
      : null;
    // plan 模式 (引擎级 planEnabled OR 调用注入的 ctx.planEnabled, 按会话):
    //   只读非破坏工具直通; 其余 (含能力声明不可证 = getter 返回 null) 一律拒绝 (fail closed)。
    //   旧实现在这里静默直通 —— 死命令的另一半 (文档说计划模式, 出厂代码拦不住任何工具)。
    const planActive = planOn || ctx.planEnabled === true;
    if (planActive && !(cap && cap.readOnly && !cap.destructive)) {
      return {
        decision: "deny",
        rule: matched,
        reason: "plan 模式: 只允许只读非破坏工具",
        modelHint: "当前处于计划模式 (plan mode), 仅允许只读工具。请先产出计划交用户审阅; 审阅通过后输入 /do 退出计划模式再执行。",
      };
    }
    if (cap) {
      const askByCap = cap.alwaysAsk ||
        cap.riskLevel === "critical" ||
        (cap.riskLevel === "high" && !approveHigh);
      if (askByCap) {
        if (approvalMode === AskForApproval.NEVER) {
          // 2026-11-08 修复「完全权限反而最不能用」:
          //   UI 的 danger-full-access 档位捆绑 approvalMode=never, 而 run_command 的
          //   capability 是 riskLevel=high → 原先一律命中下面那条"降级拒绝", 结果选了
          //   最宽的档位连命令都跑不了 (受限档位 on-request 反而会弹审批卡让人点批准)。
          //   现在把「完全访问沙箱 + never」视为用户显式选择的"不问也不拦":
          //     · 仅放行 riskLevel=high; critical 仍然永不放行
          //     · alwaysAsk 的工具仍然拒绝 (它的语义是"必须有人点头", never 下没人可点)
          //     · 受限沙箱 (read-only / workspace-write) 行为完全不变 —— 那里"高危不可静默放行"
          //       依然成立, 因为用户没有表达过"整台机器都交给它"。
          if (effectiveSandbox === SandboxPolicy.DANGER_FULL_ACCESS && cap.riskLevel !== "critical" && !cap.alwaysAsk) {
            return { decision: "allow", rule: matched, reason: "完全访问沙箱 + never: 高危能力按用户选择放行" };
          }
          return { decision: "deny", rule: matched, reason: "高风险能力 + never 模式: 降级拒绝 (高危不可静默放行)" };
        }
        if (typeof onAsk === "function") {
          const v = await onAsk(toolName, args, `高风险能力 (riskLevel=${cap.riskLevel || "high"}${cap.alwaysAsk ? "/alwaysAsk" : ""}) 需人工确认`);
          const d = typeof v === "string" ? v : v?.decision;
          if (d === "allow") return { decision: "allow", rule: matched, reason: "能力门 ask → 应答者放行" };
          return { decision: "deny", rule: matched, reason: "能力门 ask → 应答者拒绝" };
        }
        return { decision: "ask", rule: matched, reason: `高风险能力 (riskLevel=${cap.riskLevel || "high"}${cap.alwaysAsk ? "/alwaysAsk" : ""}) 需人工确认` };
      }
    }

    // (c) 沙箱检查
    let sandboxAsk = false;
    let sandboxDeny = false;
    let reason = "";
    let patchProven = false;   // apply_patch 落点已证明全在根内 → 免审批直通
    let patchHint = null;      // unprovable 时给模型的可自纠提示 (随 ask/deny 一起交给调用方)

    if (effectiveSandbox === SandboxPolicy.READ_ONLY) {
      // 只读档位拦截有两路: ①硬编码写/执行名单 (历史语义) ②能力声明的 readOnly=false (ZCode 能力门)
      // 后者覆盖"名单外但确实有副作用"的工具 (如 code_run/append_file 等), 避免披着只读标签静默直通。
      if ((WRITE_EXEC_TOOLS.has(toolName) || (cap && cap.readOnly === false)) && !allowRuleHit) {
        sandboxAsk = true;
        reason = "只读沙箱: 写/执行类工具需审批" + (escalated ? " [本次已提权]" : "");
      }
    } else if (effectiveSandbox === SandboxPolicy.WORKSPACE_WRITE) {
      const escape = findEscape(args, workspaceRoot, { allowRoots });
      if (escape) {
        // args 级越界 (args.path 等) 口径不变: 直接 deny
        sandboxDeny = true;
        reason = `工作区写沙箱: 路径越界 ${escape}`;
      } else if (toolName === "apply_patch") {
        // 补丁落点证明: allow 直通 / escapes 升级审批 / unprovable 给可自纠提示
        const proof = provePatchTargets(args, workspaceRoot);
        if (proof.state === "escapes") {
          sandboxAsk = true;
          reason = proof.reason;
        } else if (proof.state === "unprovable") {
          sandboxAsk = true;
          reason = proof.reason;
          patchHint = proof.modelHint || null;
        } else {
          patchProven = true;
        }
      }
    }

    // 网络开关
    if (!networkAccess && HTTP_TOOLS.has(toolName) && !allowRuleHit) {
      sandboxAsk = true;
      if (!reason) reason = "禁止网络访问: 网络类工具需审批";
    }

    if (sandboxDeny) {
      return { decision: "deny", rule: matched, reason };
    }

    // (d) DSH 应答者链: ask 交给 onAsk 应答者; 异常/空值/未知决策一律 deny (fail closed —
    //     DSH 语义: 缺失或抛异常的应答者产生 unavailable, 调用方对 unavailable 一律拒绝)。
    //     NEVER 模式不进应答者链 — never 在分发之前强制执行 (DSH: prepend 应答者也绕不过)。
    const needAsk = approvalMode !== AskForApproval.NEVER && (
      sandboxAsk || (matched && matched.action === "ask") ||
      (approvalMode === AskForApproval.UNLESS_TRUSTED && !TRUSTED_TOOLS.includes(toolName)) ||
      (approvalMode === AskForApproval.ON_REQUEST &&
        (args.requires_approval === true || (REQUIRES_APPROVAL_TOOLS.has(toolName) && !patchProven))));
    if (needAsk && typeof onAsk === "function") {
      const askReason = sandboxAsk ? reason
        : matched ? `命中 ask 规则: ${matched.pattern}`
        : approvalMode === AskForApproval.UNLESS_TRUSTED ? "unless-trusted: 非白名单工具需审批"
        : "on-request: 工具需审批";
      try {
        const verdict = await onAsk(toolName, args, askReason);
        const decision = typeof verdict === "string" ? verdict : verdict?.decision;
        if (decision === "allow") return { decision: "allow", rule: matched, reason: `${askReason} → 应答者放行` };
        return { decision: "deny", rule: matched, reason: `${askReason} → 应答者拒绝` };
      } catch (e) {
        return { decision: "deny", rule: matched, reason: `${askReason} → 应答者异常, fail closed (${e.message})` };
      }
    }

    // (e) never 模式: ask 降级为 deny
    if (sandboxAsk && approvalMode === AskForApproval.NEVER) {
      return { decision: "deny", rule: matched, reason: `${reason} (never 模式降级拒绝)`, ...(patchHint ? { modelHint: patchHint } : {}) };
    }
    if (sandboxAsk) {
      return { decision: "ask", rule: matched, reason, ...(patchHint ? { modelHint: patchHint } : {}) };
    }

    // (f) 规则命中后的最终映射
    if (matched && matched.action === "allow") {
      return { decision: "allow", rule: matched, reason: `命中 allow 规则: ${matched.pattern}` };
    }
    if (matched && matched.action === "ask") {
      if (approvalMode === AskForApproval.NEVER) {
        return { decision: "deny", rule: matched, reason: "never 模式降级拒绝" };
      }
      return { decision: "ask", rule: matched, reason: `命中 ask 规则: ${matched.pattern}` };
    }

    // 未命中规则: approvalMode 映射
    if (approvalMode === AskForApproval.UNLESS_TRUSTED) {
      return TRUSTED_TOOLS.includes(toolName)
        ? { decision: "allow", reason: "白名单工具自动放行" }
        : { decision: "ask", reason: "unless-trusted: 非白名单工具需审批" };
    }
    if (approvalMode === AskForApproval.ON_REQUEST) {
      // 与上面 needAsk 同源: apply_patch 落点已证明在根内时免审批 (patchProven)
      const need = args.requires_approval === true || (REQUIRES_APPROVAL_TOOLS.has(toolName) && !patchProven);
      return need
        ? { decision: "ask", reason: "on-request: 工具需审批" }
        : { decision: "allow", reason: "on-request: 无需审批" };
    }
    // ON_FAILURE / NEVER 默认放行
    return { decision: "allow", reason: "默认放行 (on-failure/never)" };
  }

  // DSH 一次性提权: 人工批准后调用, 下一次 check 以显式沙箱模式执行 (oneShot=true 消费后自动还原)
  function requestEscalation(mode, { oneShot = true } = {}) {
    if (!Object.values(SandboxPolicy).includes(mode)) {
      throw new Error(`无效沙箱模式: ${mode} (可用: ${Object.values(SandboxPolicy).join(", ")})`);
    }
    _escalation = { mode, oneShot };
    return { escalated: true, mode, oneShot };
  }

  return {
    addRule,
    check,
    requestEscalation, // DSH 一次性提权
    // 暴露配置与内部状态, 便于调试/集成
    get config() {
      return { approvalMode, sandbox, workspaceRoot, networkAccess };
    },
    get rules() {
      return _rules.slice();
    },
    // v3.0 集成: 运行时热更新 (HTTP POST /api/permissions)
    get approvalMode() { return approvalMode; },
    set approvalMode(v) { approvalMode = v; },
    get sandbox() { return sandbox; },
    set sandbox(v) { sandbox = v; },
    get networkAccess() { return networkAccess; },
    set networkAccess(v) { networkAccess = !!v; },
    // ZCode 能力门运行时热切换
    get getCapability() { return capGetter; },
    set getCapability(v) { capGetter = v; },
    get capabilityGate() { return capGate; },
    set capabilityGate(v) { capGate = !!v; },
    get planEnabled() { return planOn; },
    set planEnabled(v) { planOn = !!v; },
    get autoApproveHighRisk() { return approveHigh; },
    set autoApproveHighRisk(v) { approveHigh = !!v; },
  };
}

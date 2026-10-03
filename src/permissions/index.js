// src/permissions/index.js — 三合一权限引擎
// 吸收: codex(AskForApproval + SandboxPolicy) + opencode(通配符规则链 last-match-wins) + CASDK(canUseTool 回调)
// 纯 Node、零运行时依赖、ESM、简体中文注释。

import path from "node:path";

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

// 写/执行类工具 (只读沙箱下需升级为 ask, 工作区沙箱下需校验路径)
const WRITE_EXEC_TOOLS = new Set([
  "run_command", "shell", "exec", "bash", "apply_patch", "edit_file",
  "write_file", "create_file", "delete_file", "move_file", "rm", "write", "edit",
]);

// 网络类工具 (networkAccess=false 时升级 ask)
const HTTP_TOOLS = new Set([
  "http_request", "fetch_page", "fetch", "web_fetch", "curl", "request",
]);

// ON_REQUEST 模式下默认需要审批的工具 (其余按 args.requires_approval 决定)
const REQUIRES_APPROVAL_TOOLS = new Set([
  "run_command", "shell", "exec", "bash", "apply_patch", "delete_file", "rm",
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

// ---- 路径规范化 (Windows 大小写不敏感 + 分隔符统一) ----
function toCompare(p) {
  return path.resolve(String(p)).toLowerCase().replace(/\\/g, "/");
}
function isWithinRoot(p, root) {
  const a = toCompare(p);
  const b = toCompare(root);
  if (a === b) return true;
  const sep = b.endsWith("/") ? b : b + "/";
  return a.startsWith(sep);
}

// 从 args 收集需要校验的候选路径
function collectPaths(args) {
  const out = [];
  for (const key of ["path", "file_path", "filePath", "cwd", "dir", "destination", "dest"]) {
    if (typeof args?.[key] === "string" && args[key]) out.push(args[key]);
  }
  if (typeof args?.command === "string") {
    // 先剔除 URL (scheme://...): 否则 "curl http://x" 里的 "p:/" 会被盘符正则误判为
    // Windows 绝对路径 "p://x", 进而触发"路径越界"误拒 (任何带 URL 的命令都跑不了)。
    const cmd = args.command.replace(/[a-zA-Z][a-zA-Z0-9+.-]*:\/\/[^\s"']*/g, " ");
    const m = cmd.match(/(?:[A-Za-z]:[\\/][^\s"']+|\/[^\s"']+)/g);
    if (m) out.push(...m);
  }
  return out;
}
function findEscape(args, root) {
  for (const p of collectPaths(args)) {
    if (path.isAbsolute(p) && !isWithinRoot(p, root)) return p;
  }
  return null;
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
  // ZCode 工具能力门 (2026-10-02 吸收): getCapability 工具→能力元数据; capabilityGate 总开关
  getCapability = null,
  capabilityGate = false,
  planEnabled = false, // plan 模式: 只读非破坏工具直通, 其余拒绝
  autoApproveHighRisk = false, // high 风险免确认 (critical 永不免)
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

    // (b2) ZCode 工具能力门: 声明式元数据裁定 (2026-10-02 吸收 ZCode PermissionService)
    //   - alwaysAsk 压过一切放行分支 (yolo/白名单直通都要问)
    //   - riskLevel critical → 必问; high → 默认问 (autoApproveHighRisk 可放)
    //   - plan 模式: 只允许 readOnly 非破坏工具 (ZCode mode.plan.readOnly)
    //   - capabilityGate=false 时本门完全关闭 (向后兼容)
    const cap = capGate && typeof capGetter === "function"
      ? capGetter(toolName, args)
      : null;
    if (cap) {
      if (planOn && !(cap.readOnly && !cap.destructive)) {
        return { decision: "deny", rule: matched, reason: "plan 模式: 只允许只读非破坏工具" };
      }
      const askByCap = cap.alwaysAsk ||
        cap.riskLevel === "critical" ||
        (cap.riskLevel === "high" && !approveHigh);
      if (askByCap) {
        if (approvalMode === AskForApproval.NEVER) {
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

    if (effectiveSandbox === SandboxPolicy.READ_ONLY) {
      if (WRITE_EXEC_TOOLS.has(toolName) && !allowRuleHit) {
        sandboxAsk = true;
        reason = "只读沙箱: 写/执行类工具需审批" + (escalated ? " [本次已提权]" : "");
      }
    } else if (effectiveSandbox === SandboxPolicy.WORKSPACE_WRITE) {
      const escape = findEscape(args, workspaceRoot);
      if (escape) {
        sandboxDeny = true;
        reason = `工作区写沙箱: 路径越界 ${escape}`;
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
        (args.requires_approval === true || REQUIRES_APPROVAL_TOOLS.has(toolName))));
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
      return { decision: "deny", rule: matched, reason: `${reason} (never 模式降级拒绝)` };
    }
    if (sandboxAsk) {
      return { decision: "ask", rule: matched, reason };
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
      const need = args.requires_approval === true || REQUIRES_APPROVAL_TOOLS.has(toolName);
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

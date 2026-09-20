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
    const m = args.command.match(/(?:[A-Za-z]:[\\/][^\s"']+|\/[^\s"']+)/g);
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

// ---- 工厂: 创建权限引擎 ----
export function createPermissionEngine({
  approvalMode = AskForApproval.ON_REQUEST,
  sandbox = SandboxPolicy.WORKSPACE_WRITE,
  workspaceRoot = process.cwd(),
  networkAccess = false,
  rules = [],
  canUseTool = null,
} = {}) {
  const _rules = Array.isArray(rules) ? rules.map((r) => ({ pattern: r.pattern, action: r.action })) : [];

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

    // (c) 沙箱检查
    let sandboxAsk = false;
    let sandboxDeny = false;
    let reason = "";

    if (sandbox === SandboxPolicy.READ_ONLY) {
      if (WRITE_EXEC_TOOLS.has(toolName) && !allowRuleHit) {
        sandboxAsk = true;
        reason = "只读沙箱: 写/执行类工具需审批";
      }
    } else if (sandbox === SandboxPolicy.WORKSPACE_WRITE) {
      if (sandbox !== SandboxPolicy.DANGER_FULL_ACCESS) {
        const escape = findEscape(args, workspaceRoot);
        if (escape) {
          sandboxDeny = true;
          reason = `工作区写沙箱: 路径越界 ${escape}`;
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

    // (d) never 模式: ask 降级为 deny
    if (sandboxAsk && approvalMode === AskForApproval.NEVER) {
      return { decision: "deny", rule: matched, reason: `${reason} (never 模式降级拒绝)` };
    }
    if (sandboxAsk) {
      return { decision: "ask", rule: matched, reason };
    }

    // (e) 规则命中后的最终映射
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

  return {
    addRule,
    check,
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
  };
}

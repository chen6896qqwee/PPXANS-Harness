// src/permissions/index.js — 三合一权限引擎
// 吸收: codex(AskForApproval + SandboxPolicy) + opencode(通配符规则链 last-match-wins) + CASDK(canUseTool 回调)
// 纯 Node、零运行时依赖、ESM、简体中文注释。

import path from "node:path";
import { parseEditBlocks, codexPatchPaths, MISSING_TARGET_HELP, patchTargetPreview } from "../edit/editblock.js";

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
// 破坏性/可执行类留在这里: 命令能做任何事、删除不可逆, 必须问人。
// apply_patch 于 2026-10-05 移出 (见 WORKSPACE_AUTO_TOOLS): 它被披露进核心 schema,
// 却与 run_command 同列审批名单, headless 下 agent/index.js 直接快速拒绝 ——
// 等于把模型一个永远用不了的工具塞给它 (真跑基准 json-edit 就是这么失败的)。
const REQUIRES_APPROVAL_TOOLS = new Set([
  "run_command", "shell", "exec", "bash", "delete_file", "rm",
]);

// 路径受限的补丁/编辑类工具: 免审批的前提是"能证明每个落点都在工作区根内"。
// 依据: write_file (整体覆盖, 落点更宽) 本来就不审批, 却单独卡住比它更窄、且落点已被
// safePath 关在工作区内的 apply_patch, 口径不自洽。这里补上自洽的那半边 ——
// 越界/落点不明的补丁仍然照旧升级审批, 不是无条件放行。
// (edit_file 不在此列: 它从来没进过 REQUIRES_APPROVAL_TOOLS, 也就从来没被审批门卡过,
//  而且当前没有任何工具以该名注册 —— 只在 WRITE_EXEC_TOOLS 里作为只读沙箱的别名存在。)
const WORKSPACE_AUTO_TOOLS = new Set(["apply_patch"]);

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
// 唯一的路径包含判定真相源 (safePath 同款口径)。导出给 src/permissions/intersection.js 复用 ——
// 权限交集绝不许再写第二份包含逻辑 (2026-10-05 safePath 双实现教训: 两层都以为对方查过)。
export function isWithinRoot(p, root) {
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
    // 相对路径也要判 (2026-10-05): 旧实现只看 path.isAbsolute, 于是 ../../evil.txt
    // 这类相对穿越被完全忽略 —— "在工作区内"的正确定义是先按 root 解析再做包含检查,
    // 绝对路径同样走这条路 (resolve 对绝对路径是幂等的), 判定口径只留一个。
    if (!isWithinRoot(path.resolve(root, p), root)) return p;
  }
  return null;
}

// apply_patch 的落点优先在 content 的 SEARCH/REPLACE 块头行里, collectPaths/findEscape
// 看不见它。这里复用工具自己的解析器 (src/edit/editblock.js), 保证"权限看到的落点清单"
// 与"工具真正写盘的路径"同源, 不会各说各话。
// 2026-10-05: 块无路径 → 与 tools/v3 execute 同口径兜底到 args.path (args.path 本身
// 已在下方键值收集里); 块与 args.path 都没有 → unprovable, 整份补丁升级审批 (fail closed)。
// 2026-10-05 (rename-symbol 复盘): 第三种常见写法是 codex 风格补丁, 落点写在
// `*** Update File:` / `*** Add File:` / `*** Delete File:` 表头里, SR 解析器给出 0 块
// → 落点清单为空 → 一律升级审批 → headless 即拒。现同口径抽取这些表头路径, 让工作区内
// 的 codex 补丁能自证落点。注意方向: 抽取只会让清单更长 (paths.every(在根内) 更难成立),
// 不可能把越界补丁证明成合规 —— 证明不了仍然 ask, 失败关闭不变。
function collectPatchPaths(args) {
  const paths = [];
  let argsPath = "";
  for (const key of ["path", "file_path", "filePath"]) {
    if (typeof args?.[key] === "string" && args[key]) {
      if (!argsPath) argsPath = args[key];
      paths.push(args[key]);
    }
  }
  let unprovable = false;
  if (typeof args?.content === "string" && args.content) {
    try {
      for (const b of parseEditBlocks(args.content)) {
        if (b.path) paths.push(b.path);
        else if (!argsPath) unprovable = true;
      }
      for (const p of codexPatchPaths(args.content)) paths.push(p);
    } catch { unprovable = true; /* 解析失败 → 落点清单不可信 */ }
  }
  return { paths, unprovable };
}

// 补丁工具落点三态 (2026-10-05 "已修复"幻觉复盘): 旧布尔把两种性质完全不同的失败压成
// 同一个 ask → headless 通用审批文案, 模型无从自纠。现拆开:
//   allow     — 每个落点都可证明在 root 内 (免审批)
//   escapes   — 补丁被证明触碰 root 之外的文件 (照旧升级审批, 不放宽)
//   unprovable— 根本确定不了落点 (缺目标 = 请求格式错误, 文案改为点名三种合法写法)
// 失败关闭不变: 权限引擎对 unprovable 的决策仍是 ask/deny, 只有文案变得可行动。
function patchWorkspaceStatus(args, root) {
  const { paths, unprovable } = collectPatchPaths(args);
  if (unprovable || !paths.length) return { status: "unprovable" };
  const escape = paths.find((p) => !isWithinRoot(path.resolve(root, p), root));
  return escape ? { status: "escapes", escape } : { status: "allow" };
}

// unprovable 的可行动文案: 三种约定 + 实际收到的前两行 content (与 tools/v3 同源)。
// 同时作为 decision.modelHint 透传给 agent 的 headless 拒绝消息 (agent/index.js)。
function unprovablePatchReason(args) {
  return MISSING_TARGET_HELP + " 收到的内容前两行: " + patchTargetPreview(args?.content);
}

// ON_REQUEST 模式下"这个调用需不需要审批"的唯一判定 (原先在 needAsk 与最终映射里各写一遍)。
function requiresApproval(toolName, args, root) {
  if (args?.requires_approval === true) return true;
  if (REQUIRES_APPROVAL_TOOLS.has(toolName)) return true;
  if (WORKSPACE_AUTO_TOOLS.has(toolName)) return patchWorkspaceStatus(args, root).status !== "allow";
  return false;
}

// 补丁类工具的 ask 文案按三态分路: unprovable → 教模型怎么补目标; escapes → 维持原审批口径。
function workspaceToolAskReason(toolName, args, root) {
  if (WORKSPACE_AUTO_TOOLS.has(toolName) && patchWorkspaceStatus(args, root).status === "unprovable") {
    return unprovablePatchReason(args);
  }
  return "on-request: 补丁落点无法证明都在工作区内, 需审批";
}

// plan 模式拒绝的可行动文案 (走既有 modelHint 通道, 由 agent/index.js 的拒绝消息原样带给模型):
// 拒绝必须给出下一步 (本项目 standing rule: 模型无从自纠的拒绝只会诱发重试)。
export const PLAN_MODE_MODEL_HINT =
  "[plan 模式] 当前会话为只读: 请输出执行计划 (步骤 / 落点文件 / 验证方式) 交用户审阅;"
  + " 用户同意执行时由用户发送 /do 退出计划模式后再来。不要重复发起该写/执行调用。";

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
  planEnabled = false, // plan 模式 (引擎级): 只允许只读非破坏工具; 按会话开关走 check 的 ctx.planEnabled
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
    // plan 模式有两个来源: 引擎级 planEnabled (进程级兜底/测试注入) 与按会话 ctx.planEnabled
    // (集成层 /plan 命令翻转后经 agent 准入链传入)。二者等价, ctx 只增不减。
    const planActive = planOn || ctx?.planEnabled === true;
    if (planActive) {
      // 失败关闭 (2026-10-05 /plan 死命令复盘): 旧实现只在拿到能力声明时才判只读 ——
      // capGate 关闭 / 能力未声明时 cap=null, plan 模式下写/执行/派生全部静默直通,
      // "计划模式"只是文案。现在: 拿不出"只读且非破坏"的正向证明就拒绝 (deny 不新增审批,
      // 默认 plan 关闭时本节完全不动, 常规工作区流程零变化)。
      const readOnlySafe = !!(cap && cap.readOnly === true && cap.destructive !== true);
      if (!readOnlySafe) {
        return {
          decision: "deny",
          rule: matched,
          reason: "plan 模式: 只允许只读非破坏工具",
          modelHint: PLAN_MODE_MODEL_HINT,
        };
      }
    }
    if (cap) {
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
      } else if (cap && !cap.readOnly && !allowRuleHit) {
        // F1 (2026-10-05): 只读档位此前**只**按工具名硬名单 (WRITE_EXEC_TOOLS) 判,
        // 名单外的 code_act / spawn_agent / git_commit / memory_import / create_skill /
        // enable_capability / http_request 在「只读巡检」下全部静默放行 (实测)。
        // 现按声明式能力裁定: 任何自认"非只读"的工具在只读沙箱一律升级审批 ——
        // 这是同一条不变量的声明式版本, 新增工具默认落入其中, 不需要再维护名字名单。
        // 不放宽任何既有分支: allow 规则命中仍然放行 (与旧 WRITE_EXEC 口径一致);
        // capabilityGate=false (引擎默认) 时 cap 为 null, 行为与今天完全相同。
        sandboxAsk = true;
        reason = `只读沙箱: 能力声明非只读 (sideEffect=${cap.sideEffect || "unknown"}) 需审批`
          + (escalated ? " [本次已提权]" : "");
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
      (approvalMode === AskForApproval.ON_REQUEST && requiresApproval(toolName, args, workspaceRoot)));
    if (needAsk && typeof onAsk === "function") {
      const askReason = sandboxAsk ? reason
        : matched ? `命中 ask 规则: ${matched.pattern}`
        : approvalMode === AskForApproval.UNLESS_TRUSTED ? "unless-trusted: 非白名单工具需审批"
        : WORKSPACE_AUTO_TOOLS.has(toolName)
          ? workspaceToolAskReason(toolName, args, workspaceRoot)
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
      const need = requiresApproval(toolName, args, workspaceRoot);
      if (!need) return { decision: "allow", reason: "on-request: 无需审批" };
      // unprovable 补丁: reason 已是可行动文案, 另挂 modelHint 供 agent 的 headless 拒绝
      // 消息原样带给模型 (其他工具的 ask 不带此字段 → run_command/delete_file/rm 文案不变)。
      const unprovable = WORKSPACE_AUTO_TOOLS.has(toolName)
        && patchWorkspaceStatus(args, workspaceRoot).status === "unprovable";
      return unprovable
        ? { decision: "ask", reason: unprovablePatchReason(args), modelHint: unprovablePatchReason(args) }
        : { decision: "ask", reason: workspaceToolAskReason(toolName, args, workspaceRoot) };
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

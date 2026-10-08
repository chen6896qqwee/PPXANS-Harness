// src/permissions/intersection.js — 委派权限交集 (吸收 Codex permission_profile_intersection)
// 不变量原文 (codex-rs/protocol/src/permission_profile_intersection.rs):
//   "A policy cannot be intersected without weakening either input."
//   —— 两个权限档位的交集结果**永远不得比任何一个输入更宽**。
//
// 规则 (与 Codex 对齐, 全部在 intersectPermissionProfiles 内实现并被属性测试钉住):
//   1. deny 永远赢: 任一侧 deny 的 pattern, 结果里就是 deny; ask 压过 allow;
//      显式 allow 只有**两侧都显式 allow 同一 pattern** 才保留 (写权需要双亲同意)。
//   2. 网络需一致: 任一侧 networkAccess=false → 结果 false。
//   3. 沙箱/审批取更严档: 序见下方两张 RANK 表 (显式声明并测试, 不是默认假设);
//      不可序/冲突输入 → 取更严结果。
//   4. 任何东西解析不了 (非对象档位 / 未知沙箱或审批值 / 畸形规则 / 含 glob 或设备
//      命名空间前缀的路径 / 两侧工作区根互不包含) → **终止交集**, 输出全锁死档位
//      (READ_ONLY + UNLESS_TRUSTED + 断网 + "*"[deny] 规则), 绝不"沉默放行"。
//   5. 路径包含判定只复用 src/permissions/index.js 的 isWithinRoot (safePath 同源口径) ——
//      本文件不写第二份包含逻辑 (2026-10-05 教训: 两层各以为对方查过, Windows 穿越才活下来)。
//
// 纯 JS、零依赖、无 I/O、无 LLM。planEnabled 按"限制"参与交集: OR 语义 (任一在 plan → 子必只读)。

import path from "node:path";
import { SandboxPolicy, AskForApproval, isWithinRoot } from "./index.js";

// ---- 限制性排序 (rank 越大越严格; 显式声明, 测试锁定, 不许"想当然") ----
// 沙箱: READ_ONLY ⊂ WORKSPACE_WRITE ⊂ DANGER_FULL_ACCESS (从左到右越来越宽)。
export const SANDBOX_RESTRICTION_RANK = {
  [SandboxPolicy.READ_ONLY]: 2,
  [SandboxPolicy.WORKSPACE_WRITE]: 1,
  [SandboxPolicy.DANGER_FULL_ACCESS]: 0,
};
// 审批: never = 全自动 (最不限制人介入), unless-trusted = 非白名单一律问 (最限制)。
// on-failure 在本引擎文档语义是"视作放行", 但不会像 never 那样把 ask 静默降级 —— 故严格度居中。
export const APPROVAL_RESTRICTION_RANK = {
  [AskForApproval.NEVER]: 0,
  [AskForApproval.ON_FAILURE]: 1,
  [AskForApproval.ON_REQUEST]: 2,
  [AskForApproval.UNLESS_TRUSTED]: 3,
};
// 规则动作的严格度 (deny 最大)。
export const RULE_ACTION_RANK = { allow: 0, ask: 1, deny: 2 };

const MOST_RESTRICTIVE_SANDBOX = SandboxPolicy.READ_ONLY;
const MOST_RESTRICTIVE_APPROVAL = AskForApproval.UNLESS_TRUSTED;

function lockDown(reasons, workspaceRoot) {
  // 终止交集 = 全锁死, 而不是回落 allow。"*" deny 规则让任何以本档位建的引擎拒绝一切调用。
  return {
    sandbox: MOST_RESTRICTIVE_SANDBOX,
    approvalMode: MOST_RESTRICTIVE_APPROVAL,
    networkAccess: false,
    rules: [{ pattern: "*", action: "deny" }],
    workspaceRoot,
    planEnabled: true,
    terminated: true,
    reasons,
  };
}

// 工作区根解析: 只判定"能不能解析成可比较的普通路径", 包含关系一律交给 isWithinRoot。
// 返回 { root } | { none: true } (未提供) | { bad: reason } (不可解析 → 终止交集)。
function resolveRoot(raw, label) {
  if (raw === undefined || raw === null || raw === "") return { none: true };
  if (typeof raw !== "string") return { bad: `${label}.workspaceRoot 非字符串, 无法判定包含` };
  const s = raw.trim();
  if (!s) return { none: true };
  // glob 字符: 落点集合无法穷举 → 不可解析 (Codex: glob terminates the intersection)。
  if (/[*?\[\]<>|"]/.test(s)) return { bad: `${label}.workspaceRoot 含通配/非法字符: ${s}` };
  // 设备命名空间与 UNC (symlink-ish 重解析路径): isWithinRoot 的字符串包含保证不了真实落点,
  // 且 reparse point 背后是什么在纯函数里不可判 → 终止, 不假装查过。
  if (s.startsWith("\\\\?\\")) return { bad: `${label}.workspaceRoot 是 Windows 设备命名空间路径 (reparse 不可判): ${s}` };
  if (/^\\\\[^\\]/.test(s)) return { bad: `${label}.workspaceRoot 是 UNC 路径 (符号目标不可判): ${s}` };
  let abs;
  try { abs = path.resolve(s); } catch { return { bad: `${label}.workspaceRoot 无法解析: ${s}` }; }
  return { root: abs };
}

// 单侧规则表校验 + 折叠: 同 pattern 多次出现按 deny>ask>allow 折叠 (deny 赢)。
// 返回 { map } 或 { bad: reason }。
function foldRules(rules, label) {
  const map = new Map();
  if (rules === undefined || rules === null) return { map };
  if (!Array.isArray(rules)) return { bad: `${label}.rules 不是数组` };
  for (const r of rules) {
    if (!r || typeof r !== "object") return { bad: `${label} 存在非对象规则: ${JSON.stringify(r)}` };
    if (typeof r.pattern !== "string" || !r.pattern.trim()) return { bad: `${label} 规则缺 pattern 或 pattern 为空: ${JSON.stringify(r)}` };
    if (!Object.prototype.hasOwnProperty.call(RULE_ACTION_RANK, r.action)) {
      return { bad: `${label} 规则 action 不可解析 (须 allow|ask|deny): ${JSON.stringify(r)}` };
    }
    const prev = map.get(r.pattern);
    if (prev === undefined || RULE_ACTION_RANK[r.action] > RULE_ACTION_RANK[prev]) map.set(r.pattern, r.action);
  }
  return { map };
}

// ---- 核心: 交集 ----
// profile 形状: { sandbox?, approvalMode?, networkAccess?, rules?: [{pattern, action}],
//                 workspaceRoot?, planEnabled? }
// 缺失字段按"沉默"处理 = 取最严档 (fail closed); 非法字段按"不可解析" = 终止交集。
export function intersectPermissionProfiles(a, b) {
  if (!a || typeof a !== "object") return lockDown([`档位输入 a 不是对象: ${JSON.stringify(a)}`, "b 侧结论无法单独采信"], undefined);
  if (!b || typeof b !== "object") return lockDown([`档位输入 b 不是对象: ${JSON.stringify(b)}`, "a 侧结论无法单独采信"], undefined);

  // 沙箱: 两者都可序时取更严; 未知值 = 不可序 → 直接终止。
  const rankS = (v, label) => {
    if (v === undefined || v === null) return { rank: SANDBOX_RESTRICTION_RANK[MOST_RESTRICTIVE_SANDBOX], value: MOST_RESTRICTIVE_SANDBOX, silent: true };
    const rank = Object.prototype.hasOwnProperty.call(SANDBOX_RESTRICTION_RANK, v) ? SANDBOX_RESTRICTION_RANK[v] : null;
    if (rank === null) return { bad: `${label}.sandbox 不可序 (未知档位): ${JSON.stringify(v)}` };
    return { rank, value: v };
  };
  const sa = rankS(a.sandbox, "a"); const sb = rankS(b.sandbox, "b");
  if (sa.bad || sb.bad) return lockDown([sa.bad, sb.bad].filter(Boolean), undefined);
  const sandbox = sa.rank >= sb.rank ? sa.value : sb.value; // 取更严

  const rankA = (v, label) => {
    if (v === undefined || v === null) return { rank: APPROVAL_RESTRICTION_RANK[MOST_RESTRICTIVE_APPROVAL], value: MOST_RESTRICTIVE_APPROVAL, silent: true };
    if (!Object.prototype.hasOwnProperty.call(APPROVAL_RESTRICTION_RANK, v)) return { bad: `${label}.approvalMode 不可序 (未知档位): ${JSON.stringify(v)}` };
    return { rank: APPROVAL_RESTRICTION_RANK[v], value: v };
  };
  const aa = rankA(a.approvalMode, "a"); const ab = rankA(b.approvalMode, "b");
  if (aa.bad || ab.bad) return lockDown([aa.bad, ab.bad].filter(Boolean), undefined);
  const approvalMode = aa.rank >= ab.rank ? aa.value : ab.value;

  // 网络: 一致同意才开 (unanimity)。缺失视为关。
  const networkAccess = a.networkAccess === true && b.networkAccess === true;

  // plan 模式 (限制态): OR —— 任一侧在 plan, 子侧必须同在 plan (只读)。
  const planEnabled = a.planEnabled === true || b.planEnabled === true;

  // 规则: deny 赢 → ask 赢 → 双侧显式 allow 才保留 allow; 单侧 allow 缺另一侧同意, 丢弃
  // (回落到已取更严档的审批基线), 绝不凭沉默继承单边权利。
  const fa = foldRules(a.rules, "a"); const fb = foldRules(b.rules, "b");
  if (fa.bad || fb.bad) return lockDown([fa.bad, fb.bad].filter(Boolean), undefined);
  const notes = [];
  const rules = [];
  const patterns = new Set([...fa.map.keys(), ...fb.map.keys()]);
  for (const pattern of patterns) {
    const pa = fa.map.get(pattern); const pb = fb.map.get(pattern);
    if (pa === "deny" || pb === "deny") { rules.push({ pattern, action: "deny" }); continue; }
    if (pa === "ask" || pb === "ask") { rules.push({ pattern, action: "ask" }); continue; }
    if (pa === "allow" && pb === "allow") { rules.push({ pattern, action: "allow" }); continue; }
    if (pa === "allow" || pb === "allow") {
      notes.push(`pattern "${pattern}" 仅 ${pa === "allow" ? "a" : "b"} 侧显式 allow, 另一侧未同意 → 丢弃该 allow (写权需双亲同意)`);
    }
  }

  // 工作区根: 包含判定只走 isWithinRoot。互相不包容 = 无法合并 → 终止 (不取并集、不猜)。
  const ra = resolveRoot(a.workspaceRoot, "a"); const rb = resolveRoot(b.workspaceRoot, "b");
  if (ra.bad || rb.bad) return lockDown([ra.bad, rb.bad].filter(Boolean), undefined);
  let workspaceRoot;
  if (ra.none && rb.none) workspaceRoot = undefined;
  else if (ra.none) workspaceRoot = rb.root;
  else if (rb.none) workspaceRoot = ra.root;
  else if (isWithinRoot(rb.root, ra.root) && !isWithinRoot(ra.root, rb.root)) workspaceRoot = rb.root; // b 在 a 内 → 取更深的 b
  else if (isWithinRoot(ra.root, rb.root) && !isWithinRoot(rb.root, ra.root)) workspaceRoot = ra.root;
  else if (isWithinRoot(ra.root, rb.root) && isWithinRoot(rb.root, ra.root)) workspaceRoot = ra.root; // 同一目录 (大小写/分隔符已折叠)
  else return lockDown([`两侧工作区根互不包含, 无法交集: a=${ra.root} b=${rb.root}`], undefined);

  return { sandbox, approvalMode, networkAccess, rules, workspaceRoot, planEnabled, terminated: false, reasons: notes };
}

// 从活的权限引擎实例取当前生效档位 (委派边界用): 引擎的 config/rules 是单一真相源。
export function profileFromEngine(engine, { planEnabled } = {}) {
  if (!engine || typeof engine.check !== "function") return null;
  const cfg = engine.config || {};
  return {
    sandbox: cfg.sandbox,
    approvalMode: cfg.approvalMode,
    networkAccess: cfg.networkAccess === true,
    rules: Array.isArray(engine.rules) ? engine.rules.slice() : [],
    workspaceRoot: cfg.workspaceRoot,
    planEnabled: planEnabled ?? engine.planEnabled === true,
  };
}

// 把交集结论映射到 worker 进程**既有的**收紧杠杆: PPX_AGENT_READONLY=1
// (agent-worker.js 依此调 enableReadonlyMode, 是 ppx 今天唯一能在 spawn 前生效的子侧权限开关)。
// 交集说"子侧只读/锁死/在 plan", 这里就挂上杠杆; 交集无收紧时返回 {} —— 无委派路径零变化。
export function childSpawnEnv(profile, requestedReadOnly = false) {
  const readOnly = requestedReadOnly === true
    || !profile // 拿不到父档位 = 解析不了, 失败关闭
    || profile.terminated === true
    || profile.planEnabled === true
    || profile.sandbox === SandboxPolicy.READ_ONLY;
  return readOnly ? { PPX_AGENT_READONLY: "1" } : {};
}

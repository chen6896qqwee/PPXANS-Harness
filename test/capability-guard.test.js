// test/capability-guard.test.js — F1 不变量: 工具能力必须显式声明, 且兜底是失败关闭
//
// 为什么要有这个文件 (2026-10-05 F1 复盘):
//   ToolCatalog.getCapability 的旧兜底把**一切未声明 capability 的工具**报成
//   { riskLevel:"low", readOnly:true, sideEffect:"none" }。而权限引擎的只读裁定
//   (src/permissions/index.js 能力门: plan 模式 + 只读沙箱) 恰好只看 readOnly/destructive ——
//   于是实测 46/64 个未声明工具 (code_act / code_run / spawn_agent / git_commit /
//   memory_import / create_skill / enable_capability / http_request …) 在「只读巡检」和
//   plan 模式下静默直通: 任意代码执行 + 仓库写入披着只读标签。
//   这不是"改一次就好"的 bug, 是缺一条不变量: 每加一个 register 就重新打开一次洞。
//   所以本文件把三件事钉住:
//     ① 真目录里每个工具都带显式、形状合法的能力声明 (新增工具忘了声明 → 套件直接红)
//     ② 兜底本身也是失败关闭 (非只读), 并给出可行动的默认档
//     ③ plan 模式 / 只读档位 / 默认工作区模式在**真目录**上的决策真值表
//       (走真实 check(), 不在测试里重写一遍判定逻辑)
import test from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PPXAgent } from "../src/agent/index.js";
import { ToolCatalog } from "../src/tools/index.js";
import {
  createPermissionEngine,
  AskForApproval,
  SandboxPolicy,
} from "../src/permissions/index.js";

const RISK_LEVELS = new Set(["low", "medium", "high", "critical"]);

function tmpRoot(tag) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `ppx-cap-${tag}-`));
}

// ---- 真目录: 走完整装配链路 (toolsPlugin 的全部注册 + plugin/builtin.js 内联的 board 工具) ----
// 用临时 root: 不会读到开发者本地的 custom-tools/ 或 MCP 服务器, 结果可复现。
let agent = null;
function realCatalog() {
  if (!agent) agent = new PPXAgent({ root: tmpRoot("agent") });
  return agent.tools;
}
test.after(() => { if (agent) agent.shutdown(); });

// 合法的能力声明: riskLevel 在档位表内 + readOnly 是布尔 + sideEffect 是非空字符串
function capabilityProblem(cap) {
  if (!cap || typeof cap !== "object") return "缺 capability 声明";
  if (!RISK_LEVELS.has(cap.riskLevel)) return `riskLevel 非法: ${JSON.stringify(cap.riskLevel)}`;
  if (typeof cap.readOnly !== "boolean") return `readOnly 必须是显式布尔: ${JSON.stringify(cap.readOnly)}`;
  if (typeof cap.sideEffect !== "string" || !cap.sideEffect) return `sideEffect 必须是非空字符串: ${JSON.stringify(cap.sideEffect)}`;
  if ("destructive" in cap && typeof cap.destructive !== "boolean") return "destructive 需为布尔";
  if ("alwaysAsk" in cap && typeof cap.alwaysAsk !== "boolean") return "alwaysAsk 需为布尔";
  return null;
}

test("F1①: 真目录里每个内置工具都带显式且合法的能力声明 (register 漏声明即红)", () => {
  const catalog = realCatalog();
  const names = catalog.list();
  // 装配静默失败时别让这条不变量变成空集上的真命题
  assert.ok(names.length >= 60, `工具数异常 (装配是否失败?): ${names.length}`);
  const problems = [];
  for (const name of names) {
    const meta = catalog.metaOf(name);
    // 第三方 MCP 工具语义不可知, 是唯一允许走兜底的一类 (兜底本身由下一条测试钉住)
    if (meta.category === "mcp") continue;
    if (!meta.capability) { problems.push(`${name}: 未声明 capability`); continue; }
    const p = capabilityProblem(meta.capability);
    if (p) problems.push(`${name}: ${p}`);
  }
  assert.deepEqual(problems, [], `以下工具的能力声明缺失/非法:\n${problems.join("\n")}`);
});

test("F1②: 未声明能力的兜底是失败关闭 —— 绝不报成只读", () => {
  const catalog = new ToolCatalog();
  catalog.register({ name: "unknown_misc", description: "d", parameters: { type: "object", properties: {} }, execute: async () => "ok" });
  catalog.register({ name: "unknown_sys", category: "system", description: "d", execute: async () => "ok" });
  catalog.register({ name: "unknown_net", category: "net", description: "d", execute: async () => "ok" });

  for (const name of ["unknown_misc", "unknown_sys", "unknown_net"]) {
    const cap = catalog.getCapability(name);
    assert.equal(cap.readOnly, false, `${name}: 兜底不得声称只读 (旧实现报 readOnly:true → plan 模式跑任意代码)`);
    assert.notEqual(cap.riskLevel, "low", `${name}: 兜底不得按低风险处理`);
    assert.equal(cap.destructive || false, name === "unknown_sys", `${name}: destructive 兜底口径`);
  }
  // medium 是有意的: 兜底不该让默认模式下每个陌生工具都弹审批 (见 F1⑤), 只需剥夺只读豁免
  assert.equal(catalog.getCapability("unknown_misc").riskLevel, "medium");
  assert.equal(catalog.getCapability("unknown_misc").sideEffect, "unknown");
});

// ---- F1③ plan 模式真值表 (真目录 + 真 check()) ----
// 只读/建议类: plan 模式必须直通
const PLAN_ALLOW = [
  "read_file", "list_dir", "search_files", "memory_search", "get_time", "read_image",
  "repo_map", "git_status", "git_diff", "git_log", "read_document", "ocr_image",
  "web_search", "fetch_page", "memory_list_deleted", "persona_read", "scene_list",
  "list_schedules", "list_capabilities", "skill_search", "replay_session", "review_code",
  "usage_stats", "self_diagnose", "humanize", "write_article", "clarify", "vad_detect",
  "voice_transcribe", "board_query",
  // 2026-10-07 全能超级 Agent: 编排自省 + 技能库自省 (全是纯读, 不改任何状态)
  "legion_status", "team_list", "expert_list", "capability_matrix", "boundary_check",
  "skill_coverage", "skill_domains",
  // 2026-10-07 吸收 Octop: 专家库 / 人格 / 房间只读面 (纯读, 不改状态)
  "expert_pack_list", "expert_pack_show", "persona_list", "persona_preview",
  "team_room_status", "team_room_history",
];
// 执行/写入/持久状态变更/能力-审批变更/网络出口: plan 模式必须拦住 (deny 或 ask, 不得 allow)
const PLAN_BLOCK = [
  "code_act", "code_run", "apply_patch", "write_file", "append_file", "delete_file",
  "git_commit", "spawn_agent", "memory_import", "memory_add", "memory_clear_layer",
  "memory_export", "memory_forget", "http_request", "create_skill", "enable_capability",
  "disable_capability", "load_skill", "ingest_document", "scene_create", "goal_board",
  "add_schedule", "audit_verify", "selfheal_run", "notify", "repo_wiki", "refine",
  "refine_skill", "board_publish", "persona_build",
  // 2026-10-07: 改运行时并发配额 (影响全局调度) / 从网络写文件 —— 都不属于计划模式该做的事
  "legion_set_concurrency", "skill_import",
  // 2026-10-07 吸收 Octop: 安装专家包 / 团队房间的起停与派工 (起子进程 + 调 LLM)
  "expert_pack_install", "team_room_open", "team_room_say", "team_room_dispatch",
  "team_room_manage", "team_room_close",
];

// 各工具的最小合规入参 (路径都相对工作区, 避免混进"路径越界"这条与本表无关的分支)
const ARGS = {
  read_file: { path: "README.md" },
  list_dir: { path: "." },
  search_files: { query: "x" },
  memory_search: { query: "x" },
  read_image: { path: "a.png" },
  repo_map: {},
  code_act: { language: "node", code: "1" },
  code_run: { code: "1+1" },
  apply_patch: { content: "README.md\n<<<<<<< SEARCH\nq\n=======\nw\n>>>>>>> REPLACE\n" },
  write_file: { path: "a.txt", content: "hi" },
  append_file: { path: "a.txt", content: "hi" },
  delete_file: { path: "a.txt" },
  git_commit: { message: "m" },
  spawn_agent: { task: "t" },
  memory_import: { file: "a.json" },
  memory_add: { content: "c" },
  memory_clear_layer: { layer: 1 },
  memory_export: {},
  memory_forget: { id: "x" },
  http_request: { url: "https://example.com" },
  create_skill: { name: "s", description: "d", content: "c" },
  enable_capability: { name: "read_file" },
  disable_capability: { name: "read_file" },
  load_skill: { id: "x" },
  ingest_document: { path: "a.md" },
  scene_create: { name: "n", description: "d", canHelp: "c" },
  goal_board: { action: "list" },
  add_schedule: { name: "n", cron: "01:00" },
  audit_verify: {},
  selfheal_run: {},
  notify: { message: "m" },
  repo_wiki: {},
  refine: {},
  refine_skill: {},
  board_publish: { content: "c" },
  persona_build: {},
  boundary_check: { task: "帮我看看这份合同有没有坑" },
  legion_set_concurrency: { limit: 8 },
  skill_import: { repo: "anthropics/skills" },
  expert_pack_install: { src_dir: "/tmp/pack" },
  expert_pack_show: { id: "general-assistant" },
  persona_preview: { code: "INTJ" },
  team_room_open: { name: "r", members: ["ops-engineer", "data-analyst"] },
  team_room_say: { room_id: "r", text: "t" },
  team_room_dispatch: { room_id: "r", member: "a", task: "t" },
  team_room_history: { room_id: "r" },
  team_room_manage: { room_id: "r", action: "list_jobs" },
  team_room_close: { room_id: "r" },
};

// 只读豁免面 (readOnly:true 的内置工具全清单)。plan 模式与只读档位能直通的就是这一张表 ——
// 想让新工具进这张表, 等于承认它不改任何状态, 必须过评审。
// MCP 第三方工具不在此列 (语义不可知, 一律落失败关闭兜底, 见 F1②)。
const READ_ONLY_SURFACE = [
  "board_query", "clarify", "fetch_page", "get_time", "git_diff", "git_fetch", "git_log", "git_status",
  "humanize", "list_capabilities", "list_dir", "list_schedules", "memory_list_deleted",
  "memory_search", "ocr_image", "persona_read", "read_document", "read_file", "read_image",
  "replay_session", "repo_map", "review_code", "scene_list", "search_files", "self_diagnose",
  "skill_search", "usage_stats", "vad_detect", "voice_transcribe", "web_search", "write_article",
  // 2026-10-07 全能超级 Agent: 编排/班组/能力域/边界自省 (纯读)
  "legion_status", "team_list", "expert_list", "capability_matrix", "boundary_check",
  "skill_coverage", "skill_domains",
  // 2026-10-07 吸收 Octop: 专家库/人格/房间只读面 (纯读)
  "expert_pack_list", "expert_pack_show", "persona_list", "persona_preview",
  "team_room_status", "team_room_history",
];

function engine({ root, catalog, sandbox, plan }) {
  return createPermissionEngine({
    approvalMode: AskForApproval.ON_REQUEST,
    sandbox,
    workspaceRoot: root,
    networkAccess: true, // 网络轴单独测, 本表只验能力门的只读裁定
    getCapability: (n) => catalog.getCapability(n),
    capabilityGate: true,
    planEnabled: plan,
  });
}

for (const sandbox of [SandboxPolicy.READ_ONLY, SandboxPolicy.WORKSPACE_WRITE]) {
  test(`F1③ plan 模式 (${sandbox}): 只读直通, 执行/写入一律 deny|ask (旧兜底是 allow)`, async () => {
    const root = tmpRoot("plan");
    const catalog = realCatalog();
    const eng = engine({ root, catalog, sandbox, plan: true });
    for (const name of PLAN_ALLOW) {
      const r = await eng.check(name, ARGS[name] || {});
      assert.equal(r.decision, "allow", `plan/${sandbox}: ${name} 应直通, 实际 ${r.decision} (${r.reason})`);
    }
    for (const name of PLAN_BLOCK) {
      const r = await eng.check(name, ARGS[name] || {});
      assert.notEqual(r.decision, "allow",
        `plan/${sandbox}: ${name} 不得在计划模式下静默执行 (旧缺陷: 兜底 readOnly:true → allow)`);
    }
  });
}

// ---- F1④ 只读档位 (PERMISSION_PRESETS["read-only"] 的 sandbox) 真值表 ----
// 只读档位不是 plan 模式: 不拒绝, 但写/执行类必须问 (预设自己的文案就是"一律审批")。
test("F1④ 只读档位: 非只读能力一律升级审批, 只读工具照常放行", async () => {
  const root = tmpRoot("ro");
  const catalog = realCatalog();
  const eng = engine({ root, catalog, sandbox: SandboxPolicy.READ_ONLY, plan: false });
  for (const name of PLAN_ALLOW) {
    const r = await eng.check(name, ARGS[name] || {});
    assert.equal(r.decision, "allow", `只读档位: ${name} 应放行, 实际 ${r.decision} (${r.reason})`);
  }
  for (const name of PLAN_BLOCK) {
    const r = await eng.check(name, ARGS[name] || {});
    assert.notEqual(r.decision, "allow", `只读档位: ${name} 必须审批 (旧缺陷: 名单外的执行/写入工具静默放行)`);
  }
  // allow 规则仍能压过能力升级 (与旧 WRITE_EXEC 口径一致, 未放宽)
  eng.addRule("spawn_agent", "allow");
  assert.equal((await eng.check("spawn_agent", ARGS.spawn_agent)).decision, "allow");
});

// ---- F1⑤ 默认模式 (workspace-write + on-request) 不得因为本次修复变成处处弹窗 ----
// 这是"翻转兜底"最容易踩的反面: medium 只能用来剥夺只读豁免, 不能触发审批。
test("F1⑤ 默认 workspace-write: 只读类工具仍静默放行, 常规工作区写入也不新增审批", async () => {
  const root = tmpRoot("default");
  const catalog = realCatalog();
  const eng = engine({ root, catalog, sandbox: SandboxPolicy.WORKSPACE_WRITE, plan: false });
  const SILENT = [
    ...PLAN_ALLOW,
    // 声明为 medium 的常规工作区动作: 今天不审批, 修完仍不审批
    "write_file", "append_file", "apply_patch", "git_commit", "spawn_agent", "http_request",
    "create_skill", "enable_capability", "disable_capability", "load_skill", "ingest_document",
    "scene_create", "goal_board", "add_schedule", "memory_add", "memory_forget", "memory_export",
    "repo_wiki", "notify", "refine", "refine_skill", "board_publish", "persona_build",
    "memory_search", "usage_stats", "self_diagnose", "humanize", "write_article", "clarify",
    "scene_list", "list_schedules", "list_capabilities", "skill_search", "replay_session",
    "review_code", "read_document", "ocr_image", "web_search", "fetch_page", "vad_detect",
    "voice_transcribe", "git_status", "git_diff", "git_log", "persona_read", "memory_list_deleted",
  ];
  const escalated = [];
  for (const name of SILENT) {
    if (!catalog.has(name)) continue;
    const r = await eng.check(name, ARGS[name] || {});
    if (r.decision !== "allow") escalated.push(`${name}→${r.decision} (${r.reason})`);
  }
  assert.deepEqual(escalated, [], `默认模式下这些工具不该新增审批:\n${escalated.join("\n")}`);

  // 反向半边: 真正的高危工具必须 ask (不能为了"别打扰"把整片声明压成 medium)
  const MUST_ASK = ["run_command", "delete_file", "code_act", "memory_import", "memory_clear_layer", "audit_verify", "selfheal_run"];
  for (const name of MUST_ASK) {
    const r = await eng.check(name, ARGS[name] || {});
    assert.equal(r.decision, "ask", `默认模式: ${name} 需人工确认, 实际 ${r.decision} (${r.reason})`);
  }
});

// ---- F1⑥ 只读豁免是一张需要显式承认的清单 ----
// 谁想让自己的工具在 plan 模式直通, 必须同时改掉这个快照 (评审时看得见)。
test("F1⑥ 只读豁免面快照 (readOnly:true 的工具清单)", () => {
  const catalog = realCatalog();
  const readOnlyTools = catalog.list()
    .filter((n) => catalog.getCapability(n)?.readOnly === true)
    .sort();
  assert.deepEqual(readOnlyTools, [...READ_ONLY_SURFACE].sort(), "只读豁免面发生漂移 (新增/减少工具需显式评审)");
});

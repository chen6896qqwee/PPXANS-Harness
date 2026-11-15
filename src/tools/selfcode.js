// src/tools/selfcode.js — 自改代码工具族 (2026-10-27)
//
// 这是"皮皮虾能自己改自己的代码"的工具面。引擎在 src/selfcode/, 这里只做三件事:
// 参数收敛、权限分级、把引擎结论翻译成模型能直接照着做下一步的回执。
//
// 只有四个工具 (schema 每个都要按 token 付钱, 常驻上下文的东西必须逐个算账):
//   self_audit   只看不改: 结构健康度 (死代码/依赖环/巨石/静默 catch) + 评分 + 建议
//   self_edit    补丁式自改: 解析 → 边界 → 落盘 → 三关验证 → 绿留红滚 → 记账
//   self_verify  只验证不改: 语法 + 指定测试, 事后复核
//   self_rewind  按账本回滚某次自改
// 账本查询走 evolution_status (同属"变强有账可查", 不再占一份 schema);
// 待生效确认走 `npm run selfcode -- ack`。
//
// 权限设计 (刻意从严):
//   · self_edit / self_rewind 都是 riskLevel=high —— 自改源码必须人类在环,
//     headless 默认被权限层拒, 需要审批面放行或 config 显式 allow。
//   · self_edit 想真正落盘要过**双门**: 调用参数 mode="apply" + config agent.self_code.mode="apply"。
//     单点误用不会把代码改坏, 这是从 self_improve 沿用下来的同一条纪律。
import path from "node:path";
import { SelfCodeEngine } from "../selfcode/engine.js";
import { verifyChange, guardPath } from "../selfcode/verify.js";
import { impactOf } from "../selfcode/graph.js";
import { runAudit, formatAudit } from "../selfcode/audit.js";
import { patchTargetFiles } from "../edit/editblock.js";

const ERR = (name, msg) => `[工具错误] ${name}: ${msg}`;

// ---- 自动测试发现 (2026-10-30 强化, 2026-11-02 改走依赖图) ----
// 此前 self_edit 的 tests 参数"不给则只验语法" —— 模型忘传时 apply 就裸落盘。
// 现在按补丁目标文件映射相关测试, 让"改完即验证"不依赖模型自觉:
//   impactOf 内部: ① import 反向引用 ② 同名/同前缀约定 ③ 传递依赖上的测试。
//   一个都找不到时兜底 config agent.self_iteration.target_files 前 3 个 (全局适应度)。
function relatedTests(agent, srcFiles, cap = 6) {
  let picked = [];
  try {
    picked = impactOf(agent?.root || process.cwd(), srcFiles, { maxTests: cap }).relatedTests;
  } catch { /* 图构建失败时退回兜底 */ }
  if (picked.length) return picked.slice(0, cap);
  const fit = (agent?.config?.agent?.self_iteration?.target_files) || [];
  return fit.map(String).slice(0, Math.min(cap, 3));
}

function engineFor(agent, { allowTestEdit = false } = {}) {
  const root = agent?.root || process.cwd();
  const dataDir = agent?.dataDir || path.join(root, "data");
  const cfg = agent?.config?.agent?.self_code || {};
  return new SelfCodeEngine({
    root,
    dataDir,
    mode: cfg.mode === "apply" ? "apply" : "propose",
    allowTestEdit,
    syntaxTimeoutMs: Number(cfg.syntax_timeout_ms) || 5000,
    testTimeoutMs: Number(cfg.test_timeout_ms) || 120000,
  });
}

export function registerSelfCodeTools(catalog, { agent, getAgent } = {}) {
  // 装配顺序不确定: 优先用惰性 getter, 工具真正被调用时才取 agent (与 team-room 等模块同一写法)
  const A = () => (typeof getAgent === "function" ? getAgent() : agent);

  // ---- 0. self_audit: 只看不改的结构体检 ----
  // 为什么值得占一份常驻 schema: 自优化闭环此前只有"测试红→修"的被动入口,
  // 没人报错时模型不知道自己该优化什么。本工具把 graph/audit 的确定性结论
  // (死代码、依赖环、巨石、静默 catch + 评分趋势) 直接变成下一步行动建议。
  catalog.register({
    name: "self_audit",
    capability: { readOnly: true, riskLevel: "low", sideEffect: "none" },
    description: "自审代码结构 (只读): 死代码候选/依赖环/断链 import/巨石文件/静默 catch 热点 + 0-100 评分与优先建议。改前找目标、改后看趋势。",
    parameters: {
      type: "object",
      properties: {
        json: { type: "boolean", description: "true=返回完整 JSON (默认返回紧凑文本)" },
        max_findings: { type: "number", description: "最多返回多少条 findings, 默认 40" },
      },
      required: [],
    },
    category: "selfmod",
    power: "agent",
    idempotent: true,
    execute: async (args) => {
      const ag = A();
      if (!ag) return ERR("self_audit", "无 agent 上下文");
      const r = runAudit({
        root: ag.root || process.cwd(),
        thresholds: { maxFindings: Number(args.max_findings) || 40 },
      });
      return args.json ? JSON.stringify(r, null, 2) : formatAudit(r);
    },
  });

  // ---- 1. self_edit: 补丁式自改 ----
  catalog.register({
    name: "self_edit",
    capability: { readOnly: false, riskLevel: "high", sideEffect: "system" },
    description: "改自己的源码。SEARCH/REPLACE 补丁 → 落盘 → 语法+指定测试验证 → 绿保留/红整体回滚 → 记账。默认 propose 只出 diff; apply 需 config agent.self_code.mode=apply 双开; apply 未传 tests 时自动按补丁目标映射相关测试验证。改完需重启生效。",
    parameters: {
      type: "object",
      properties: {
        patch: { type: "string", description: "SEARCH/REPLACE 块 (首行文件名) 或 codex Begin Patch" },
        tests: { type: "array", items: { type: "string" }, description: "验证用测试文件 (相对 root); 不给则只验语法" },
        mode: { type: "string", enum: ["propose", "apply"], description: "propose=只出 diff(默认), apply=落盘并验证" },
        reason: { type: "string", description: "自改理由, 记进账本" },
      },
      required: ["patch"],
    },
    category: "selfmod",
    power: "user",
    idempotent: false,
    execute: async (args) => {
      const ag = A();
      if (!ag) return ERR("self_edit", "无 agent 上下文");
      const patch = String(args.patch || "");
      if (!patch.trim()) return ERR("self_edit", "需要 patch 文本");
      if (patch.length > 200000) return ERR("self_edit", `patch 过大 (${patch.length} 字符, 上限 200000)`);
      const cfg = ag.config?.agent?.self_code || {};
      const mode = args.mode === "apply" ? "apply" : "propose";
      if (mode === "apply" && cfg.mode !== "apply") {
        return ERR("self_edit", "apply 需 config agent.self_code.mode=\"apply\" 显式开启 (双门防误改), 当前为 propose");
      }
      // 2026-10-30: 测试文件保护不可由模型参数关闭 (旧 allow_test_edit 开关已移除)
      const eng = engineFor(ag);
      const t = Array.isArray(args.tests) ? args.tests.map(String).slice(0, 12) : [];
      // apply 且未显式给 tests → 自动映射相关测试 (改完即验证, 不裸落盘)
      let autoTests = [];
      let impact = null;
      if (mode === "apply" && !t.length) {
        const targets = patchTargetFiles(patch).filter((f) => /\.(js|mjs|cjs|json|md)$/i.test(f));
        if (targets.length) {
          try {
            impact = impactOf(ag.root || process.cwd(), targets, { maxTests: 6 });
            autoTests = impact.relatedTests || [];
          } catch { /* 图失败则走兜底 */ }
          if (!autoTests.length) autoTests = relatedTests(ag, targets, 6);
        }
        if (autoTests.length) t.push(...autoTests);
      }
      const r = await eng.run({ patch, tests: t, mode, reason: String(args.reason || "") });
      if (autoTests.length) {
        r.autoTests = { files: autoTests, note: "apply 未显式传 tests, 已按补丁目标自动映射相关测试参与验证" };
      }
      if (impact && (impact.directDependents.length || impact.relatedTests.length)) {
        r.impact = {
          directDependents: impact.directDependents.slice(0, 10),
          totalDependents: impact.totalDependents,
          relatedTests: impact.relatedTests,
        };
      }
      try { ag._eqPush?.("selfcode", { stage: r.stage, ok: !!r.ok, ledgerId: r.ledgerId || null, files: (r.files || []).map((f) => f.path) }); } catch {}
      return JSON.stringify(r, null, 2);
    },
  });

  // ---- 2. self_verify: 只验证不改 ----
  catalog.register({
    name: "self_verify",
    capability: { readOnly: true, riskLevel: "medium", sideEffect: "none" },
    description: "验证现有源码: 对 files 跑 node --check, 对 tests 跑 node --test 并解析 TAP。只读, 不改盘。",
    parameters: {
      type: "object",
      properties: {
        files: { type: "array", items: { type: "string" }, description: "源码文件 (相对 root), 语法检查" },
        tests: { type: "array", items: { type: "string" }, description: "测试文件 (相对 root)" },
        timeout_ms: { type: "number", description: "单测试超时, 默认 120000" },
      },
      required: [],
    },
    category: "selfmod",
    power: "agent",
    idempotent: true,
    execute: async (args) => {
      const ag = A();
      if (!ag) return ERR("self_verify", "无 agent 上下文");
      const root = ag.root || process.cwd();
      const files = Array.isArray(args.files) ? args.files.map(String).slice(0, 20) : [];
      const tests = Array.isArray(args.tests) ? args.tests.map(String).slice(0, 12) : [];
      if (!files.length && !tests.length) return ERR("self_verify", "需要 files 或 tests 至少一项");
      const changed = [];
      for (const f of files) {
        const g = guardPath(root, f, { allowTestEdit: true });
        if (!g.ok) return ERR("self_verify", g.error);
        changed.push(g.abs);
      }
      const r = await verifyChange({ root, changed, tests, testTimeoutMs: Number(args.timeout_ms) || 120000 });
      return JSON.stringify(r, null, 2);
    },
  });

  // ---- 3. self_rewind: 回滚某次自改 ----
  catalog.register({
    name: "self_rewind",
    capability: { readOnly: false, riskLevel: "high", sideEffect: "system" },
    description: "按账本 id 从备份恢复原文件 (不传 id=最近一次 kept)。回滚本身也记账。改坏了用它一键退回。",
    parameters: {
      type: "object",
      properties: { id: { type: "string", description: "账本 id (sc-xxxx); 省略=最近一次" } },
      required: [],
    },
    category: "selfmod",
    power: "user",
    idempotent: false,
    execute: async (args) => {
      const ag = A();
      if (!ag) return ERR("self_rewind", "无 agent 上下文");
      const eng = engineFor(ag);
      return JSON.stringify(eng.rewind({ id: args.id ? String(args.id) : null }), null, 2);
    },
  });

  return catalog;
}

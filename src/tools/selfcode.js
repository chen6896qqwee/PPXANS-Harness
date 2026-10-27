// src/tools/selfcode.js — 自改代码工具族 (2026-10-27)
//
// 这是"皮皮虾能自己改自己的代码"的工具面。引擎在 src/selfcode/, 这里只做三件事:
// 参数收敛、权限分级、把引擎结论翻译成模型能直接照着做下一步的回执。
//
// 只有三个工具 (schema 每个都要按 token 付钱, 常驻上下文的东西必须逐个算账):
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

const ERR = (name, msg) => `[工具错误] ${name}: ${msg}`;

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

  // ---- 1. self_edit: 补丁式自改 ----
  catalog.register({
    name: "self_edit",
    capability: { readOnly: false, riskLevel: "high", sideEffect: "system" },
    description: "改自己的源码。SEARCH/REPLACE 补丁 → 落盘 → 语法+指定测试验证 → 绿保留/红整体回滚 → 记账。默认 propose 只出 diff; apply 需 config agent.self_code.mode=apply 双开。改完需重启生效。",
    parameters: {
      type: "object",
      properties: {
        patch: { type: "string", description: "SEARCH/REPLACE 块 (首行文件名) 或 codex Begin Patch" },
        tests: { type: "array", items: { type: "string" }, description: "验证用测试文件 (相对 root); 不给则只验语法" },
        mode: { type: "string", enum: ["propose", "apply"], description: "propose=只出 diff(默认), apply=落盘并验证" },
        reason: { type: "string", description: "自改理由, 记进账本" },
        allow_test_edit: { type: "boolean", description: "允许改测试文件 (默认 false)" },
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
      const eng = engineFor(ag, { allowTestEdit: !!args.allow_test_edit });
      const t = Array.isArray(args.tests) ? args.tests.map(String).slice(0, 12) : [];
      const r = await eng.run({ patch, tests: t, mode, reason: String(args.reason || "") });
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

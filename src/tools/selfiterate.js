// src/tools/selfiterate.js - 自主迭代工具 (2026-10-25)
//
// 把 evolve/selfiterate.js 的「测试→诊断→补丁→验证→沉淀/回滚」闭环暴露为 agent
// 可自调用的工具: agent 检出失败测试后可自主发起对自己的修复。安全边界全部
// 沿用引擎层 (propose 默认 / root 内 .js / 不碰测试文件 / 预算上限 / 审计链)。
// 注意: riskLevel=high —— 走权限引擎时会按高风险处理 (默认策略下 headless 直接拒,
// 需审批面批准或用户显式 allow), 这是刻意的: 自改代码必须有人类在环。
import path from "node:path";
import { SelfIterationEngine } from "../evolve/selfiterate.js";

export function registerSelfIterateTools(catalog, { agent } = {}) {
  catalog.register({
    name: "self_improve",
    capability: { readOnly: false, riskLevel: "high", sideEffect: "system" },
    description: "自主迭代: 失败测试→LLM诊断→补丁→重跑验证→绿保留/红回滚。默认 propose 只出补丁; config agent.self_iteration.mode=apply 才落盘(双重确认)。",
    parameters: {
      type: "object",
      properties: {
        test_files: {
          type: "array",
          items: { type: "string" },
          description: "目标测试文件 (相对项目根, 如 test/foo.test.js), 必填",
        },
        mode: { type: "string", enum: ["propose", "apply"], description: "propose=只出补丁(默认); apply=落盘验证(还需 config 同开)" },
      },
      required: ["test_files"],
    },
    category: "evolve",
    power: "user",
    idempotent: false,
    execute: async (args) => {
      if (!agent) return "[工具错误] self_improve: 无 agent 上下文";
      const files = Array.isArray(args.test_files) ? args.test_files.map(String).slice(0, 8) : [];
      if (!files.length) return "[工具错误] self_improve: 需要非空 test_files";
      const cfg = { ...(agent.config?.agent?.self_iteration || {}) };
      // 双重门: 工具参数想 apply, 还需 config 也放开 apply (防单点误用)
      if (args.mode === "apply" && cfg.mode !== "apply") {
        return "[工具错误] self_improve: apply 模式需 config agent.self_iteration.mode=\"apply\" 显式开启 (双重确认), 当前为 propose";
      }
      if (args.mode) cfg.mode = args.mode;
      const engine = new SelfIterationEngine(agent, cfg);
      const summary = await engine.run({
        targetFiles: files.map((f) => path.resolve(agent.root, f)),
        onEvent: (t, p) => { try { agent._eqPush?.("selfiterate", { stage: t, ...p }); } catch {} },
      });
      return JSON.stringify(summary, null, 2);
    },
  });
  return catalog;
}

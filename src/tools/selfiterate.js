// src/tools/selfiterate.js - 自主迭代 + 进化状态工具 (2026-10-25)
//
// 把 evolve/selfiterate.js 的「测试→诊断→补丁→验证→沉淀/回滚」闭环暴露为 agent
// 可自调用的工具: agent 检出失败测试后可自主发起对自己的修复。安全边界全部
// 沿用引擎层 (propose 默认 / root 内 .js / 不碰测试文件 / 预算上限 / 审计链)。
// 注意: riskLevel=high —— 走权限引擎时会按高风险处理 (默认策略下 headless 直接拒,
// 需审批面批准或用户显式 allow), 这是刻意的: 自改代码必须有人类在环。
// evolution_status (2026-10-25 第二层): 只读的进化报告 —— journal 曲线 + 能力快照,
// "变强"有账可查。
import path from "node:path";
import { SelfIterationEngine } from "../evolve/selfiterate.js";
import { EvolutionLoop } from "../evolve/loop.js";

export function registerSelfIterateTools(catalog, { agent } = {}) {
  catalog.register({
    name: "self_improve",
    capability: { readOnly: false, riskLevel: "high", sideEffect: "system" },
    description: "自主迭代: 失败测试→诊断→补丁→验证→绿保留/红回滚。默认只出补丁; apply 需 config 双开。",
    parameters: {
      type: "object",
      properties: {
        test_files: {
          type: "array",
          items: { type: "string" },
          description: "目标测试文件(相对根), 必填",
        },
        mode: { type: "string", enum: ["propose", "apply"], description: "propose(默认)只出补丁; apply需config同开" },
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

// 进化状态报告 (只读): journal 曲线 + 当前能力快照 —— "变强"有账可查。
// 复用 agent._evolutionLoop (启动时 installEvolutionLoop 装配); 无则临时构造只读视图。
export function registerEvolutionStatusTool(catalog, { agent } = {}) {
  catalog.register({
    name: "evolution_status",
    capability: { readOnly: true, riskLevel: "low", sideEffect: "none" },
    description: "自主进化报告: 能力快照+弱点聚类+最近N轮进化记录。",
    parameters: {
      type: "object",
      properties: {
        cycles: { type: "number", description: "最近N轮(默认10)" },
      },
      required: [],
    },
    category: "evolve",
    power: "agent",
    idempotent: true,
    execute: async (args) => {
      if (!agent) return "[工具错误] evolution_status: 无 agent 上下文";
      const n = Math.min(Math.max(Number(args.cycles) || 10, 1), 100);
      const loop = agent._evolutionLoop || new EvolutionLoop(agent, {});
      const cap = loop.capabilitySnapshot();
      const weak = loop.weaknessClusters().slice(0, 5);
      const journal = loop.journalTail(n);
      const lines = [];
      lines.push("== 能力快照 ==");
      lines.push(`经验条数: ${cap.experiences ?? "?"} | 技能数: ${cap.skills ?? "?"} | 故障病历: ${cap.failureEpisodes ?? "?"} | playbook: ${cap.playbookBullets ?? "?"} 条`);
      if (weak.length) {
        lines.push("", "== 弱点聚类 (头部 5) ==");
        for (const w of weak) lines.push(`- ${w.tool} (${w.category || "未分类"}) × ${w.count}`);
      }
      lines.push("", `== 最近 ${journal.length} 轮进化 ==`);
      if (!journal.length) {
        lines.push("(暂无记录 —— 配置 agent.evolution_loop.enabled=true 每日自动进化, 或 npm run evolve:loop 手动一轮)");
      }
      for (const j of journal.slice(-n).reverse()) {
        const l = j.learn || {};
        const it = j.iterate || {};
        const itTxt = it.ran === false ? "迭代跳过" : `修复 ${it.fixed ?? 0} / 回滚 ${it.rolledBack ?? 0} / 提案 ${it.proposed ?? 0}`;
        lines.push(`- ${j.ts} (${j.durationMs ?? "?"}ms): 经验+${l.refined ?? 0} 技能+${l.skillsCreated ?? 0}${l.weaknessTargeted ? ` [针对弱点 ${l.weaknessTargeted.tool}×${l.weaknessTargeted.count}]` : ""} | ${itTxt}${j.error ? ` | ⚠ ${j.error}` : ""}`);
      }
      return lines.join("\n");
    },
  });
  return catalog;
}

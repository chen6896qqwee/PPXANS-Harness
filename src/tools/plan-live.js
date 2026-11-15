// src/tools/plan-live.js - update_plan 工具 (v5.0 P2.3)
// 回合内计划工件 (TodoWrite 语义): 模型每轮按需提交全量步骤列表, 状态
// pending / in_progress / done。计划注入 system 动态区 (跨轮可见, 前缀缓存安全),
// 并发 EQ plan_updated 事件供 UI 实时渲染计划卡。
import { TOOL_ERROR_PREFIX } from "./seam.js";

export function registerPlanLiveTools(catalog, { planLive } = {}) {
  catalog.register({
    name: "update_plan",
    capability: { readOnly: false, riskLevel: "low", sideEffect: "session" },
    description: "维护当前任务的分步计划 (每次提交全量步骤列表)。多步任务建议开工时列出步骤, 每完成一步更新状态 —— 计划对用户可见, 也是你跨轮的工作记忆。",
    parameters: {
      type: "object",
      properties: {
        steps: {
          type: "array",
          description: "全量步骤列表 (覆盖式提交); 空数组 = 清除计划",
          items: {
            type: "object",
            properties: {
              title: { type: "string", description: "步骤内容 (一句话)" },
              status: { type: "string", enum: ["pending", "in_progress", "done"], description: "步骤状态" },
            },
            required: ["title"],
          },
        },
      },
      required: ["steps"],
    },
    execute: async (args, ctx) => {
      if (!planLive || typeof planLive.set !== "function") {
        return `${TOOL_ERROR_PREFIX} update_plan: 计划存储未初始化`;
      }
      const sk = (ctx && ctx.agent && (ctx.agent._activeSessionKey || ctx.sessionKey)) || "default";
      const plan = planLive.set(sk, args.steps);
      // EQ 事件: UI/wallboard 实时渲染计划卡 (轻负载, 载荷只带步骤概要)
      try {
        const agent = ctx && ctx.agent;
        if (agent && typeof agent._eqPushRef === "function") {
          agent._eqPushRef("plan_updated", {
            sessionKey: sk,
            steps: plan ? plan.steps.map((s) => ({ title: s.title, status: s.status })) : [],
          }, { sessionKey: sk });
        }
      } catch { /* 事件失败不阻断计划更新 */ }
      if (!plan) return JSON.stringify({ ok: true, cleared: true });
      const done = plan.steps.filter((s) => s.status === "done").length;
      return JSON.stringify({ ok: true, total: plan.steps.length, done, steps: plan.steps });
    },
  });
}

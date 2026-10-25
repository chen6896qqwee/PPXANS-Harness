// src/mode/plan-exec.js - Plan & Execute 模式
// 先让 LLM 生成完整计划(步骤清单), 再逐步执行(每步走 react 工具循环), 最后汇总。
// 适合: 可分解的多步任务, 结构化、可预测、减少中间推理浪费。
import { buildMessages } from "./index.js";

// 解析 LLM 返回的步骤清单 (JSON 数组, 容忍 markdown 代码块包裹)
export function parseSteps(text) {
  const cleaned = String(text || "").replace(/```(?:json|JSON)?\s*/g, "").replace(/```/g, "").trim();
  const m = cleaned.match(/\[[\s\S]*\]/);
  if (!m) return [];
  try {
    const arr = JSON.parse(m[0]);
    return Array.isArray(arr) ? arr.map((x) => String(x).trim()).filter(Boolean) : [];
  } catch { return []; }
}

// 规划: LLM 生成步骤清单 (无 LLM 返回空)
async function planSteps(agent, userMsg) {
  if (!agent.llm) return [];
  const r = await agent.llm.chat([
    { role: "system", content: "你是任务规划器。把用户的任务分解成 2-6 个可独立执行的具体步骤, 每步一句话(含要做什么)。只输出 JSON 数组, 例如 [\"读取配置文件\", \"修改端口\", \"重启服务\"]。不要解释。" },
    { role: "user", content: String(userMsg).slice(0, 2000) },
  ]);
  return parseSteps(r.content);
}

export async function planExecExecutor(agent, userMsg, { sessionKey = "default", maxSteps = 6 } = {}) {
  if (!agent.llm) {
    return (await agent._localIntent(userMsg)) || "[皮皮虾] 未配置模型 provider (配置见 docs/QUICKSTART.md 第 3 节)。";
  }
  // 1. 规划
  const steps = (await planSteps(agent, userMsg)).slice(0, maxSteps);
  if (!steps.length) {
    // 规划失败: 退回 react 模式
    const messages = await buildMessages(agent, userMsg, sessionKey);
    return agent._llmWithFallback(messages);
  }
  // 2. 逐步执行 (每步走工具循环)
  const base = await buildMessages(agent, userMsg, sessionKey);
  const results = [];
  for (let i = 0; i < steps.length; i++) {
    const stepMsg = [...base, { role: "user", content: `[第 ${i + 1}/${steps.length} 步] ${steps[i]}` }];
    let r;
    try { r = await agent._llmWithFallback(stepMsg); }
    catch (e) { r = `(步骤失败: ${e.message})`; }
    results.push(`步骤${i + 1}: ${steps[i]}\n${r}`);
  }
  // 3. 汇总
  return results.join("\n\n");
}

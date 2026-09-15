// src/mode/graph.js - Graph / Workflow 模式
// 显式工作流编排: 按节点顺序执行, 每个节点走 react 工具循环, 结果 checkpoint 到会话日志。
// 适合: 企业级、可审计、可恢复的确定性流程。当前为顺序 DAG, 未来可扩展依赖/并行。
import { buildMessages } from "./index.js";

// 归一化 workflow 节点: 接受字符串数组或 { name, task } 对象数组
export function normalizeNodes(workflow) {
  if (!Array.isArray(workflow)) return [];
  return workflow.map((node) => {
    if (typeof node === "string") return { name: node, task: node };
    return { name: String(node.name || node.task || ""), task: String(node.task || node.name || "") };
  }).filter((n) => n.task);
}

export async function graphExecutor(agent, userMsg, { sessionKey = "default", workflow = null } = {}) {
  if (!agent.llm) {
    return (await agent._localIntent(userMsg)) || "[皮皮虾] 未配置模型 provider (配置见 docs/QUICKSTART.md 第 3 节)。";
  }
  // workflow 来源: opts 传入 > config.agent.workflow > 默认单节点
  const raw = workflow || (agent.config.agent && agent.config.agent.workflow) || [userMsg];
  const nodes = normalizeNodes(raw);
  if (!nodes.length) {
    const messages = await buildMessages(agent, userMsg, sessionKey);
    return agent._llmWithFallback(messages);
  }

  const base = await buildMessages(agent, userMsg, sessionKey);
  const results = [];
  for (const node of nodes) {
    let r;
    try {
      r = await agent._llmWithFallback([...base, { role: "user", content: `[节点: ${node.name}] ${node.task}` }]);
    } catch (e) {
      r = `(节点 ${node.name} 失败: ${e.message})`;
    }
    // checkpoint: 节点结果落会话日志, 崩溃后可恢复/审计
    try { agent.sessionStore.append(sessionKey, "tool/result", { content: `[workflow:${node.name}] ${r}` }); } catch {}
    results.push(`节点[${node.name}]:\n${r}`);
  }
  return results.join("\n\n");
}

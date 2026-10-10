// src/mode/legion.js - 多 Agent 军团模式
// 把 Legion (多进程军团 + DAG 编排) 接入 mode 系统, chat({ mode: "legion" }) 可用。
// 编排策略:
//   - 有 workflow (DAG 节点数组) 时走 runDag: 按依赖拓扑分层并行, 上游结果流入下游
//   - 无 workflow 时走 broadcast: 同一问题广播给全部 agent, 取第一个有效回复
// 军团配置: config.agent.legion = { size, workflow } 或 config.orchestrator
// 可注入: opts.legion (测试/复用已有军团实例, 免重复 spawn)
import path from "node:path";
import { Legion } from "../orchestrator/legion.js";
import { warn } from "../utils/logger.js";

export async function legionExecutor(agent, userMsg, { sessionKey = "default", legion = null, workflow = null, size = null } = {}) {
  const cfg = (agent.config && (agent.config.agent?.legion || agent.config.orchestrator)) || {};

  // 1. 拿或懒建军团 (缓存到 agent, 复用子进程, 不重复 spawn)
  let L = legion || agent._legion;
  if (!L) {
    L = new Legion();
    const n = size || cfg.size || 2;
    for (let i = 0; i < n; i++) {
      // 每个 agent 独立数据目录, 隔离记忆/会话, 互不干扰
      const dataDir = path.join(agent.dataDir, "legion", `agent-${i}`);
      L.spawnAgent(`agent-${i}`, { dataDir });
    }
    agent._legion = L;
  }

  // 2. 编排: workflow(DAG) 优先, 否则 broadcast
  const wf = workflow || cfg.workflow;
  if (Array.isArray(wf) && wf.length) {
    // v1.0.8: 校验节点结构 (需 {id, task}), 防字符串数组直接 TypeError
    const bad = wf.find((n) => !n || typeof n !== "object" || !n.id || !n.task);
    if (bad) return `[军团] workflow 节点需 {id, task} 对象, 非法节点: ${JSON.stringify(bad).slice(0, 80)}`;
    try {
      const { results } = await L.runDag({ nodes: wf });
      const lines = Object.entries(results).map(([id, r]) => `【${id}】\n${r}`);
      return lines.join("\n\n");
    } catch (e) {
      return `[军团] DAG 编排失败: ${e.message}`;
    }
  }

  try {
    const results = await L.broadcast("chat", userMsg);
    const ok = results.filter((r) => r.status === "fulfilled" && r.value && r.value.reply);
    if (ok.length) return ok[0].value.reply;
  } catch (e) {
    warn("[legion] broadcast 失败:", e.message);
  }
  return "[军团] 所有 agent 均未返回有效结果 (请确认已 spawnAgent 或配置 config.agent.legion.size)";
}

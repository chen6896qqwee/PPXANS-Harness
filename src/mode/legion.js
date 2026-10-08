// src/mode/legion.js - 多 Agent 军团模式
// 把 Legion (多进程军团 + DAG 编排) 接入 mode 系统, chat({ mode: "legion" }) 可用。
// 编排策略:
//   - 有 workflow (DAG 节点数组) 时走 runDag: 按依赖拓扑分层并行, 上游结果流入下游
//   - 无 workflow 时走 broadcast: 同一问题广播给全部 agent, 取第一个有效回复
//
// 配置 (2026-10-07 更新, 旧的 config.orchestrator 别名继续可用):
//   config.agent.legion = { default_size, max_concurrent_agents, max_concurrent_per_call, ... }
//   config.orchestrator = { size, workflow }   ← 兼容旧配置
//   合并方向: 新键优先, 旧键兜底 —— 因此两者都存在时不会互相遮蔽。
// 可注入: opts.legion (测试/复用已有军团实例, 免重复 spawn)
import path from "node:path";
import { Legion } from "../orchestrator/legion.js";
import { getGovernor, governorOptsFromConfig } from "../orchestrator/governor.js";
import { warn } from "../utils/logger.js";

export async function legionExecutor(agent, userMsg, { sessionKey = "default", legion = null, workflow = null, size = null } = {}) {
  // 旧别名 config.orchestrator 打底, 新键 config.agent.legion 覆盖 (两边同名键时新键胜出)
  const legacy = (agent.config && agent.config.orchestrator) || {};
  const modern = (agent.config && agent.config.agent && agent.config.agent.legion) || {};
  const cfg = { ...legacy, ...modern };
  // 军团一启动就把治理器参数同步为当前配置 (热改配置后不必重启进程)
  getGovernor().configure(governorOptsFromConfig(agent.config, agent.dataDir || null));

  // 1. 拿或懒建军团 (缓存到 agent, 复用子进程, 不重复 spawn)
  let L = legion || agent._legion;
  if (!L) {
    L = new Legion();
    const n = Math.max(1, Number(size || cfg.size || cfg.default_size || 2) || 2);
    // 受治理的批量 spawn: 走 Legion.spawnAgents (排队等槽位), 而不是无脑 for 循环 spawn n 个
    const specs = Array.from({ length: n }, (_, i) => ({
      name: `agent-${i}`,
      // 每个 agent 独立数据目录, 隔离记忆/会话, 互不干扰
      opts: { dataDir: path.join(agent.dataDir, "legion", `agent-${i}`) },
    }));
    if (typeof L.spawnAgents === "function") {
      await L.spawnAgents(specs).catch((e) => warn(`[legion] 军团启动失败: ${e.message}`));
    } else {
      for (const s of specs) L.spawnAgent(s.name, s.opts);
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
    // 真实 broadcast 返回形状: { agent, id, type:'reply', reply } 或 { agent, type:'error', error }
    // (曾误写成 { status:'fulfilled', value:{ reply } } —— 那是测试桩伪造的形状, 导致此处恒为空,
    //  军团 broadcast 模式在真实环境永远走兜底串)
    const ok = results.filter((r) => r && r.type === "reply" && r.reply);
    if (ok.length) return ok[0].reply;
  } catch (e) {
    warn("[legion] broadcast 失败:", e.message);
  }
  return "[军团] 所有 agent 均未返回有效结果 (请确认已 spawnAgent 或配置 config.agent.legion.default_size)";
}

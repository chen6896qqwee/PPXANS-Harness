// src/orchestrator/dag.js - DAG 任务编排 (军团从 broadcast/dispatch 升级为任务图)
// 纯函数零依赖: topoLevels 拓扑分层 + runDag 分层并行执行 + 依赖结果数据流
// graph.nodes = [{ id, task, dependsOn?: [id], agent?: name }]

// 拓扑分层 (Kahn 算法): 返回 [ [同层可并行的节点id], ... ], 检测环
// v1.0.8: 校验重复 id / 依赖不存在 (原实现静默丢弃不存在的依赖, 重复 id 误报成环)
export function topoLevels(nodes) {
  const ids = new Set();
  for (const n of nodes) {
    if (!n || !n.id) throw new Error("DAG 节点缺 id");
    if (ids.has(n.id)) throw new Error(`DAG 节点 id 重复: ${n.id}`);
    ids.add(n.id);
  }
  const indeg = new Map();
  const children = new Map();
  for (const n of nodes) {
    const deps = n.dependsOn || [];
    for (const d of deps) {
      if (!ids.has(d)) throw new Error(`DAG 节点 ${n.id} 依赖不存在的节点: ${d}`);
    }
    indeg.set(n.id, deps.length);
    for (const d of deps) {
      if (!children.has(d)) children.set(d, []);
      children.get(d).push(n.id);
    }
  }
  const levels = [];
  let frontier = nodes.filter((n) => indeg.get(n.id) === 0).map((n) => n.id);
  const seen = new Set();
  while (frontier.length) {
    levels.push(frontier);
    const next = [];
    for (const id of frontier) {
      seen.add(id);
      for (const c of children.get(id) || []) {
        indeg.set(c, indeg.get(c) - 1);
        if (indeg.get(c) === 0) next.push(c);
      }
    }
    frontier = next;
  }
  if (seen.size < nodes.length) {
    const cyclic = [...ids].filter((id) => !seen.has(id)).join(",");
    throw new Error("DAG 存在环, 无法编排: " + cyclic);
  }
  return levels;
}

// 执行 DAG: 每层节点并行, 上游结果作为 deps 传给下游 executor。
// executor(id, node, deps) => Promise<result>, deps = { 依赖id: 结果 }
// concurrency: 每层并发的上限 (默认 0 = 不设限, 兼容旧调用; Legion 会传入自己的 maxConcurrent)
export async function runDag(graph, executor, { concurrency = 0 } = {}) {
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  const levels = topoLevels(graph.nodes);
  const results = {};
  const order = [];
  const cap = concurrency > 0 ? concurrency : Infinity;
  for (const level of levels) {
    // 有界并发: 层内若超出 cap, 用轮询槽位的方式逐个交给并行执行, 避免一次性 Promise.all 打爆子进程
    let idx = 0;
    const runOne = async (id) => {
      const node = byId.get(id);
      const deps = {};
      for (const d of node.dependsOn || []) deps[d] = results[d];
      results[id] = await executor(id, node, deps);
      order.push(id);
    };
    await new Promise((resolveAll) => {
      let active = 0;
      let doneCount = 0;
      const tick = () => {
        while (active < cap && idx < level.length) {
          const id = level[idx++];
          active++;
          runOne(id).finally(() => { active--; doneCount++; tick(); });
        }
        if (doneCount >= level.length) resolveAll();
      };
      tick();
    });
  }
  return { results, order };
}

// src/mode/blackboard.js - Blackboard 黑板模式
// 共享黑板: 多个专家轮流读黑板 → 贡献 → 写黑板, 最后汇总。
// 适合: 需要共享上下文的协作、增量求解、无固定顺序的问题。
// 解耦: 专家间不直接通信, 只通过黑板读写。

// 黑板: 共享状态容器 (内存版, 单进程内共享)
export class Board {
  constructor() { this._data = new Map(); }
  set(key, value) { this._data.set(key, String(value)); return value; }
  get(key) { return this._data.get(key); }
  keys() { return [...this._data.keys()]; }
  snapshot() { return Object.fromEntries(this._data); }
  toString() { return JSON.stringify(this.snapshot(), null, 2); }
}

// 默认专家团队: 分析 → 执行 → 审查
const DEFAULT_EXPERTS = [
  { name: "分析师", system: "你是分析师。分析任务, 输出关键要点、约束和风险。" },
  { name: "执行者", system: "你是执行者。基于黑板上的分析结果, 给出具体可执行的方案步骤。" },
  { name: "审查者", system: "你是审查者。审查执行方案, 指出问题并给出最终建议。" },
];

export async function blackboardExecutor(agent, userMsg, { sessionKey = "default", experts = null } = {}) {
  if (!agent.llm) {
    return (await agent._localIntent(userMsg)) || "[皮皮虾] 未配置模型 provider (配置见 docs/QUICKSTART.md 第 3 节)。";
  }
  const board = new Board();
  board.set("task", String(userMsg));

  // v1.0.8: 空数组回退默认专家 (原 [] 时 last 为 undefined 静默返回空)
  const team = (Array.isArray(experts) && experts.length) ? experts : DEFAULT_EXPERTS;
  for (const ex of team) {
    let r;
    try {
      const resp = await agent.llm.chat([
        { role: "system", content: `${ex.system}\n\n[黑板当前状态]\n${board.toString()}` },
        { role: "user", content: "请基于黑板状态完成你的职责, 输出结果。" },
      ]);
      r = resp.content;
    } catch (e) {
      r = `(${ex.name} 失败: ${e.message})`;
    }
    board.set(ex.name, r);
  }

  // 汇总: 最后一个专家(审查者)的输出作为最终答案
  const last = team[team.length - 1];
  return board.get(last.name) || "(黑板无结果)";
}

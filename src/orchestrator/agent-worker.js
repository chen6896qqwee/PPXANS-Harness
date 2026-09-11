// src/orchestrator/agent-worker.js - 子 agent 进程 (独立 PPXAgent 实例)
// 通过 stdin 收消息, stdout 回结果. 每个 worker 完全隔离.
import { PPXAgent } from "../agent/index.js";

const root = process.cwd();
// 可选: 独立数据目录 (多进程军团隔离, 避免互踩同一个 data/)
// 可选: 全局共享目录 (跨 agent 共享经验库 = ANS 全局记忆)
const agent = new PPXAgent({
  root,
  dataDir: process.env.PPX_AGENT_DATA_DIR || undefined,
  globalDataDir: process.env.PPX_AGENT_GLOBAL_DATA_DIR || undefined,
});

// 只读审查者模式 (SDD, Superpowers): 禁用一切修改/执行类工具, 只能读/查
// 供 spawn_agent review 循环的审查者角色使用
if (process.env.PPX_AGENT_READONLY === "1") {
  agent.enableReadonlyMode();
}

// 从 stdin 读 JSON 行
process.stdin.setEncoding("utf8");
let buf = "";
let currentReqId = null; // 当前正在处理的 chat 请求 id (step 事件路由用)
// v1.0.8: promise 链串行处理 (防止 data 事件并发时 currentReqId/_perspective 互相覆盖)
let queue = Promise.resolve();
// step 事件转发: 把 agent 的推理轮次进度实时回给主进程 (turn/step 可观测性)
agent.setStepEvent((ev) => {
  if (currentReqId == null) return;
  process.stdout.write(JSON.stringify({ id: currentReqId, type: "step", ...ev }) + "\n");
});
process.stdin.on("data", (chunk) => {
  buf += chunk;
  let idx;
  while ((idx = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, idx).trim();
    buf = buf.slice(idx + 1);
    if (!line) continue;
    queue = queue.then(() => handleLine(line));
  }
});

async function handleLine(line) {
  try {
    const req = JSON.parse(line);
    if (req.type === "chat") {
      currentReqId = req.id;
      // 差异化上下文 (多 agent 协调): 委派方可注入子 agent 专属视角, 对抗同质失败
      const prevPerspective = agent._perspective;
      agent._perspective = req.perspective ? String(req.perspective).slice(0, 4000) : null;
      let reply;
      try {
        reply = await agent.chat(req.message);
      } finally {
        agent._perspective = prevPerspective;
      }
      currentReqId = null;
      process.stdout.write(JSON.stringify({ id: req.id, type: "reply", reply }) + "\n");
    } else if (req.type === "ping") {
      process.stdout.write(JSON.stringify({ id: req.id, type: "pong", name: agent.config.agent?.name || "ppx" }) + "\n");
    } else if (req.type === "shutdown") {
      agent.shutdown();
      process.stdout.write(JSON.stringify({ id: req.id, type: "bye" }) + "\n");
      process.exit(0);
    }
  } catch (e) {
    // v1.0.8: error 行必须带 req.id, 否则主进程 Legion.pending 匹配不到永不 settle (永久挂起)
    process.stdout.write(JSON.stringify({ id: currentReqId || null, type: "error", error: e.message }) + "\n");
    currentReqId = null;
  }
}
// src/agent-worker.js - 子 agent 进程 (原在 src/orchestrator/ 下, 2026-10-07 因依赖环移出: 它是进程入口不是编排库) (独立 PPXAgent 实例)
// 通过 stdin 收消息, stdout 回结果. 每个 worker 完全隔离.
import { PPXAgent } from "./agent/index.js";

// 子进程恒为 Worker (2026-11-04): 即使 config 开了 router_role, worker 也不得再分派 ——
//   否则 Router 派生出的子进程会各自变成 Router, 形成只分派不执行的进程树。
//   在任何 PPXAgent 构造之前写入, 早于 bootstrap 的角色判定。
process.env.PPX_AGENT_ROLE = "worker";

const root = process.cwd();
// 可选: 独立数据目录 (多进程军团隔离, 避免互踩同一个 data/)
// 可选: 全局共享目录 (跨 agent 共享经验库 = ANS 全局记忆)
// v3.2.4 (2026-10-09): 父进程经 PPX_AGENT_CONFIG_JSON 传入已解析配置 —— 沙箱/自定义
//   configFile 场景下 worker cwd 没有 config/ppx.json, 此前会退化成"无模型"子 agent。
let configOverride = null;
if (process.env.PPX_AGENT_CONFIG_JSON) {
  try { configOverride = JSON.parse(process.env.PPX_AGENT_CONFIG_JSON); } catch { configOverride = null; }
}
const agent = new PPXAgent({
  root,
  ...(configOverride ? { config: configOverride } : {}),
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
    // 2026-10-24: ping 走快路径 (不进串行队列) —— 健康探测不该排在长 chat 任务后面,
    //   否则 Legion 超时兜底会误杀"忙但活着"的 worker。chat/shutdown 仍严格串行。
    try {
      const probe = JSON.parse(line);
      if (probe?.type === "ping") {
        process.stdout.write(JSON.stringify({ id: probe.id, type: "pong", name: agent.config.agent?.name || "ppx" }) + "\n");
        continue;
      }
    } catch { /* 非 JSON 行交由 handleLine 走统一错误回包 */ }
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
      // 结构化汇报信封 (2026-11-01 v4.1 平台化): worker→router 不再只有纯文本 reply ——
      //   附带本请求的轮次/工具步数/工具名单/思考链摘要。旧消费方忽略该字段不受影响;
      //   主 agent (delegate.js) 可据此引用 worker 的执行证据, SDD 审查可量化。
      const lr = agent.lastRun || {};
      const envelope = {
        status: "ok",
        // Step 3: 回传父进程给的归属 ID, 父进程据此产 assignment_*/delivery_* 事件 (worker 不产)。
        ticketId: req.ticketId ? String(req.ticketId) : null,
        assignmentId: req.assignmentId ? String(req.assignmentId) : null,
        rounds: Number.isFinite(lr.rounds) ? lr.rounds : null,
        steps: Number.isFinite(lr.steps) ? lr.steps : null,
        tools: Array.isArray(lr.toolNames) ? lr.toolNames.slice(0, 32) : [],
        thinking: String(agent._lastReasoning || "").slice(0, 2000) || null,
        // v5.0 信封 v2 (2026-11-07): 可验证交付物 —— 实际跑过的命令与写盘产物。
        //   Router/工单账本据此核验"说了做"是否真做了 (claims.js 之外的硬证据)。
        commands: Array.isArray(lr.commands) ? lr.commands.slice(0, 16) : [],
        artifacts: Array.isArray(lr.artifacts) ? lr.artifacts.slice(0, 16) : [],
      };
      process.stdout.write(JSON.stringify({ id: req.id, type: "reply", reply, envelope }) + "\n");
    } else if (req.type === "ping") {
      process.stdout.write(JSON.stringify({ id: req.id, type: "pong", name: agent.config.agent?.name || "ppx" }) + "\n");
    } else if (req.type === "shutdown") {
      await agent.shutdown();
      process.stdout.write(JSON.stringify({ id: req.id, type: "bye" }) + "\n");
      process.exit(0);
    }
  } catch (e) {
    // v1.0.8: error 行必须带 req.id, 否则主进程 Legion.pending 匹配不到永不 settle (永久挂起)
    process.stdout.write(JSON.stringify({ id: currentReqId || null, type: "error", error: e.message }) + "\n");
    currentReqId = null;
  }
}
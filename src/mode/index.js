// src/mode/index.js - Agent 模式注册表 (编排策略可插拔)
// 把「怎么编排」从 chat() 里抽出来, 每种模式是一个 executor(agent, userMsg, opts) -> reply。
// 内置: react(工具循环) / single(纯对话) / plan-exec / router / blackboard / graph / legion。
// 默认 react; 用 config.agent.mode 或 chat({ mode }) 切换。

export class ModeRegistry {
  constructor() {
    this.modes = new Map(); // name -> executor
  }

  register(name, executor) {
    if (!name || typeof executor !== "function") throw new Error("模式注册失败: 需 name + executor 函数");
    this.modes.set(name, executor);
    return this;
  }

  has(name) { return this.modes.has(name); }
  get(name) { return this.modes.get(name); }
  list() { return [...this.modes.keys()]; }

  // 执行某模式: executor(agent, userMsg, opts) -> reply
  async run(name, agent, userMsg, opts = {}) {
    const exe = this.modes.get(name);
    if (!exe) throw new Error(`[模式] 未知模式: ${name} (可用: ${this.list().join(", ")})`);
    return exe(agent, userMsg, opts);
  }
}

// 组装 [system + 历史 + 当前] 消息 (含防重复), 供各 executor 复用
export async function buildMessages(agent, userMsg, sessionKey = "default") {
  const system = agent._context(userMsg);
  const history = await agent._loadHistory(sessionKey);
  const messages = [{ role: "system", content: system }, ...history];
  const hist = agent._getSession(sessionKey);
  const isRepeat = hist[hist.length - 1]?.role === "user" && hist[hist.length - 1].content === String(userMsg);
  if (!isRepeat) messages.push({ role: "user", content: agent._userContent(userMsg) });
  return messages;
}

// ---- 内置模式 ----

// ReAct: 推理-行动-观察循环 (带工具, 默认模式)
async function reactExecutor(agent, userMsg, { sessionKey = "default" } = {}) {
  if (!agent.llm) {
    return (await agent._localIntent(userMsg)) || "[皮皮虾] 未配置模型 provider，仅本地记忆 + 工具模式 (配置见 docs/QUICKSTART.md 第 3 节)。";
  }
  const messages = await buildMessages(agent, userMsg, sessionKey);
  return agent._llmWithFallback(messages);
}

// 单Agent: 纯 LLM 对话, 不挂工具 (省 token, 适合纯问答/闲聊)
async function singleExecutor(agent, userMsg, { sessionKey = "default" } = {}) {
  if (!agent.llm) return "[皮皮虾] 未配置模型 provider (配置见 docs/QUICKSTART.md 第 3 节)。";
  const messages = await buildMessages(agent, userMsg, sessionKey);
  const r = await agent.llm.chat(messages);
  return r.content;
}

// 注册内置模式
export function registerDefaultModes(registry) {
  registry.register("react", reactExecutor);
  registry.register("single", singleExecutor);
  return registry;
}

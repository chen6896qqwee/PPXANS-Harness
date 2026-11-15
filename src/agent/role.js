// src/agent/role.js - 进程角色分层 (Router / Worker / Main)
//
// 设计溯源 docs/SUPERAGENT-GAP.md §2.1 (Router/Worker 双层架构):
//   Router 只承接交互与分派, 不执行具体任务; Worker 在隔离进程里执行并向 Router 汇报。
// 皮皮虾此前只有 Worker 侧 (legion 子进程), Router 侧是"主会话既分派又干活"。
// 本模块把角色落成可配置的进程属性: config.agent.router_role.enabled=true 时主进程
// 收窄为调度角色 —— 工具面只留委派/检索/提问, 其余在执行入口硬拒 (不是只藏 schema)。
//
// 边界:
//   - 只收窄, 不放宽: 名单恒与核心委派工具取并集, 自定义 allow 无法移除 spawn_agent。
//   - 子进程恒为 worker (agent-worker.js 写环境标记), 防止 Router 配置被 worker 继承后
//     递归分派出"路由器生路由器"的进程树。

// Router 可用的工具: 委派 + 跨会话检索/续读 + 向人提问 + 元能力。
// 执行类 (run_command/write_file/apply_patch/code_act...) 一律不在此列。
export const ROUTER_TOOL_ALLOW = [
  "spawn_agent",        // 一次性委派 (并行 tasks / DAG / 专家组)
  "follow_thread",      // 长驻 worker 话题驻派
  "memory_search",      // 分派前取跨会话上下文
  "context_read",       // 被裁剪工具结果的续读
  "task_stack",         // 查看手头任务栈 (判断是否已有在途工作)
  "goal_board",         // 目标可见性
  "ask_user",           // 需要人决策时暂停回合
  "clarify",            // 轻量澄清
  "get_time",           // 时间基准
  "tool_schema",        // 元能力: 查看工具参数定义
  "list_capabilities",  // 元能力: 枚举可用能力
];

// 无论自定义名单怎么写都必须保留的委派入口 —— 否则 Router 失去唯一产出途径。
export const ROUTER_REQUIRED = ["spawn_agent"];

export function routerAllowList(custom = null) {
  const extra = Array.isArray(custom) ? custom.map(String).filter(Boolean) : [];
  return [...new Set([...ROUTER_TOOL_ALLOW, ...ROUTER_REQUIRED, ...extra])];
}

// 是否应在当前进程启用 Router 角色。
//   - config.agent.router_role.enabled === true 才启用 (默认关闭, 行为不变);
//   - PPX_AGENT_ROLE=worker 的子进程一律不启用 (防递归);
//   - 显式 PPX_AGENT_ROLE=router 可覆盖配置 (容器/脚本场景)。
export function shouldApplyRouterRole(config, env = process.env) {
  const marked = String(env?.PPX_AGENT_ROLE || "").toLowerCase();
  if (marked === "worker") return false;
  if (marked === "router") return true;
  return config?.agent?.router_role?.enabled === true;
}

// 应用角色: 记录角色 + 白名单, 并禁用名单外已注册工具 (省 schema token)。
// 强制拦截不依赖 disable —— 动态注册的 MCP 工具在启动后才出现, 由 _admitToolCall 统一兜底。
// 返回 { role, disabled, allow } 供启动日志与测试核对。
export function applyRouterRole(agent, { allow = null } = {}) {
  const list = routerAllowList(allow ?? agent?.config?.agent?.router_role?.allow);
  const allowed = new Set(list);
  agent.role = "router";
  agent._routerAllow = allowed;
  const disabled = [];
  if (agent.tools && typeof agent.tools.listDetailed === "function") {
    for (const t of agent.tools.listDetailed()) {
      if (!t || t.enabled === false) continue;
      if (allowed.has(t.name)) continue;
      try {
        if (agent.tools.disable(t.name)) disabled.push(t.name);
      } catch { /* 单个工具禁用失败不影响其余 */ }
    }
  }
  return { role: "router", disabled, allow: list };
}

// 角色提示: 静态文本 (无时间戳/无随请求变量), 前缀缓存契约不破。
export function routerRolePrompt({ allow = ROUTER_TOOL_ALLOW } = {}) {
  const names = [...new Set(allow)].sort().join(", ");
  return [
    "【角色: Router】你当前是调度层, 不直接执行任务。",
    "- 职责: 理解请求 → 拆解 → 分派 → 汇总结论。任务彼此独立时, 用 spawn_agent 的 tasks 数组一次并行派发; 有依赖时用 DAG 或分批。",
    `- 你手上的工具只有: ${names}。文件读写、命令执行、改代码由 worker 完成; 你调用这类工具会被直接拒绝 (不是参数问题)。`,
    "- 分派时把必要背景完整写进 task: worker 看不到你的对话历史, 只拿到你给的文字。同时写清期望产出与验收标准。",
    "- 汇总时给结论 + 证据来源 (哪个子任务/用了哪些工具/关键输出); 子任务失败要如实说明, 不得假装完成。",
    "- 不涉及工作区操作的简单问答 (常识/闲聊/基于已有上下文的解释) 可以直接回答, 不必分派。",
    "- 分派前若已有在途任务, 先看 task_stack, 避免同一件事重复开 worker。",
  ].join("\n");
}

// src/hooks/index.js — 钩子链 (吸收 claude-code 六事件)
// 纯 JS、事件驱动注册、超时熔断、单钩子异常不中断链。

// claude-code 钩子事件 (PreToolUse 可否决/改参, PostToolUse 可附加上下文)
export const HOOK_EVENTS = [
  "PreToolUse",
  "PostToolUse",
  "PreCompact",
  "PostCompact",
  "SessionStart",
  "SessionStop",
  "SubagentStop",
];

// 创建钩子注册表
export function createHookRegistry() {
  const _hooks = new Map(); // event -> [{ fn, priority, timeoutMs }]

  // 注册钩子, 返回解绑函数
  function on(event, fn, opts = {}) {
    if (!HOOK_EVENTS.includes(event)) {
      throw new Error("未知钩子事件: " + event);
    }
    if (typeof fn !== "function") {
      throw new Error("钩子 fn 必须是函数");
    }
    const entry = {
      fn,
      priority: opts.priority ?? 100,
      timeoutMs: opts.timeoutMs ?? 3000,
    };
    if (!_hooks.has(event)) _hooks.set(event, []);
    _hooks.get(event).push(entry);
    return function unbind() {
      const arr = _hooks.get(event);
      if (!arr) return;
      const i = arr.indexOf(entry);
      if (i >= 0) arr.splice(i, 1);
    };
  }

  // 触发事件: 按 priority 升序依次 await 执行
  async function emit(event, payload = {}) {
    const list = (_hooks.get(event) || []).slice().sort((a, b) => a.priority - b.priority);
    const results = [];
    let blocked = false;
    let blockReason = null;
    const additionalContext = [];

    for (const h of list) {
      let res = null;
      let err = null;
      let timedOut = false;
      try {
        // 2026-09-18 修复: 定时器句柄必须保存并在竞速结束后清理 —— 原实现每次 emit
        //   都留一个活定时器, 钩子正常完成后仍把事件循环挂住 timeoutMs (默认 3s)
        let timer;
        const timeout = new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error("hook timeout")), h.timeoutMs);
        });
        try {
          res = await Promise.race([Promise.resolve().then(() => h.fn(payload)), timeout]);
        } finally { clearTimeout(timer); }
      } catch (e) {
        err = e && e.message ? e.message : String(e);
        if (/timeout/i.test(err)) timedOut = true;
      }

      if (err) {
        results.push({ error: err, timedOut });
        continue;
      }
      results.push({ result: res });

      // PreToolUse: 可否决
      if (event === "PreToolUse" && res && res.decision === "block") {
        blocked = true;
        if (!blockReason) blockReason = res.reason || "被钩子否决";
      }
      // PostToolUse: 收集附加上下文
      if (event === "PostToolUse" && res && res.additionalContext != null) {
        additionalContext.push(res.additionalContext);
      }
    }

    return { blocked, reason: blockReason, results, additionalContext };
  }

  return { on, emit, events: HOOK_EVENTS.slice() };
}

// 生成人类可读的一行日志描述
export function describeHookEvent(event, payload = {}) {
  const tool = payload.tool || payload.toolName || payload.name || "?";
  switch (event) {
    case "PreToolUse":
      return `PreToolUse: 工具=${tool}`;
    case "PostToolUse":
      return `PostToolUse: 工具=${tool}`;
    case "PreCompact":
      return `PreCompact: 压缩前 (${payload.reason || "manual"})`;
    case "PostCompact":
      return `PostCompact: 压缩后`;
    case "SessionStart":
      return `SessionStart: 会话启动 (${payload.sessionId || "?"})`;
    case "SessionStop":
      return `SessionStop: 会话停止 (${payload.sessionId || "?"})`;
    case "SubagentStop":
      return `SubagentStop: 子代理=${payload.agent || payload.agentId || "?"}`;
    default:
      return `Hook(${event})`;
  }
}

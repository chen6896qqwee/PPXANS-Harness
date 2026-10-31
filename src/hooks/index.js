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
      // 安全钩子 (fail-closed): 故障/超时时按"拒绝"处理, 而非静默放行
      security: opts.security === true,
      failClosed: opts.failClosed === true,
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

  // 注册"安全钩子": 只挂 PreToolUse (唯一有否决语义的事件), 故障/超时 → fail-closed 拒绝。
  // 与普通 on() 的区别: 普通钩子崩了只是少一层校验 (不阻断); 安全钩子是防线本体, 崩了必须拒绝。
  function onSecurity(fn, opts = {}) {
    return on("PreToolUse", fn, { ...opts, security: true });
  }

  // 触发事件: 按 priority 升序依次 await 执行
  async function emit(event, payload = {}) {
    const list = (_hooks.get(event) || []).slice().sort((a, b) => a.priority - b.priority);
    const results = [];
    let blocked = false;
    let blockReason = null;
    const additionalContext = [];
    // 2026-10-31: PreToolUse 改参闭环 —— 钩子返回 { args: {...} } 即修改工具参数,
    //   后续钩子看到的是**改后**的参数 (链式语义); emit 返回值带出最终 args 供 agent 落地。
    //   此前 agent/index.js 消费 h.args 但 emit 从不返回 → "可改参"一直是死代码。
    let curArgs = payload.args;

    for (const h of list) {
      // PreToolUse 且参数被前序钩子改过时, 用改后参数构造本钩子的 payload (不改调用方的原对象)
      const hookPayload = (event === "PreToolUse" && curArgs !== undefined)
        ? { ...payload, args: curArgs }
        : payload;
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
          res = await Promise.race([Promise.resolve().then(() => h.fn(hookPayload)), timeout]);
        } finally { clearTimeout(timer); }
      } catch (e) {
        err = e && e.message ? e.message : String(e);
        if (/timeout/i.test(err)) timedOut = true;
      }

      if (err) {
        results.push({ error: err, timedOut });
        // 安全钩子 (fail-closed): 仅对**有否决语义的事件** (PreToolUse) 生效 —— 故障 = 无法判定 = 拒绝。
        // 其它事件 (SessionStart 等) 没有否决语义, 即便显式 failClosed 也不得制造假阻断。
        if (event === "PreToolUse" && (h.security === true || h.failClosed === true)) {
          blocked = true;
          if (!blockReason) {
            blockReason = timedOut
              ? `fail-closed: 安全钩子超时 (${err})`
              : `fail-closed: 安全钩子故障 (${err})`;
          }
        }
        continue;
      }
      results.push({ result: res });

      // PreToolUse: 可否决
      if (event === "PreToolUse" && res && res.decision === "block") {
        blocked = true;
        if (!blockReason) blockReason = res.reason || "被钩子否决";
      }
      // PreToolUse: 可改参 (仅接受非空对象; 与 decision=block 可同返回, block 时改参无意义)
      if (event === "PreToolUse" && res && res.args && typeof res.args === "object") {
        curArgs = res.args;
      }
      // PostToolUse: 收集附加上下文
      if (event === "PostToolUse" && res && res.additionalContext != null) {
        additionalContext.push(res.additionalContext);
      }
    }

    const out = { blocked, reason: blockReason, results, additionalContext };
    // 无改动时 curArgs === payload.args (同引用), agent 侧赋值是无害 no-op —— 返回形状恒稳定
    if (event === "PreToolUse" && payload.args !== undefined) out.args = curArgs;
    return out;
  }

  return { on, onSecurity, emit, events: HOOK_EVENTS.slice() };
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

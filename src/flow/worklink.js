// src/flow/worklink.js - 工单三段式链接器 (2026-11-05 调度闭环收口 ①)
//
// "统一接收外部请求"要求所有入站同源建单。webhook 型通道走 base.handleTrigger
// (内联 workBegin/workDone/workFail); 微信被动回包 / Web UI 对话 / TUI 直调
// agent.chat 的路径此前完全绕过工单账本 —— 调度闭环的"统一接收"只覆盖飞书。
// 本模块把三段式收敛成一个降级安全的小工厂:
//   · work 未装配 / 账本异常 → ticket=null, done/fail 空操作, 绝不阻断回复 (同款口径);
//   · dedupe 命中 → isDupe=true (调用方按 ticket.status 决定重放缓存结果还是停止重投,
//     语义与 base.handleTrigger 的 REPLAY/DUPLICATE 对齐);
//   · begin() 返回 assignment (供调用方挂 meta); 重复调用不重复建指派。
// work.submit/begin/complete/fail 契约见 src/workgraph/service.js。

export function createTicketLink(work, trigger, {
  sessionKey = null, worker = "router", route = "sync",
} = {}) {
  let ticket = null;
  let assignment = null;
  try {
    ticket = work && typeof work.submit === "function"
      ? work.submit(trigger, { sessionKey: sessionKey || "default" })
      : null;
  } catch { ticket = null; }

  if (ticket?.deduped) {
    return { ticket, assignment: null, isDupe: true, begin: () => null, done: () => {}, fail: () => {} };
  }

  const begin = () => {
    if (assignment || !ticket) return assignment;
    try {
      assignment = work && typeof work.begin === "function"
        ? work.begin(ticket.id, { worker, route, sessionKey })
        : null;
    } catch { assignment = null; }
    return assignment;
  };
  const done = (result, envelope = null) => {
    try {
      if (ticket) work.complete(ticket.id, envelope ? { result, envelope } : { result });
    } catch { /* 账本不阻断回复 */ }
  };
  const fail = (e) => { try { if (ticket) work.fail(ticket.id, e); } catch { /* 账本不阻断 */ } };
  return { ticket, assignment, isDupe: false, begin, done, fail };
}

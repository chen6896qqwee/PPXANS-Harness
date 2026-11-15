// webapp/src/boot-app.js - 应用启动编排: 首屏加载 + 定时器 + /events 总线 + 限流恢复
// 旧 app.js init() 的职责。轮询架构 v5.0 调整: 审批/提问兜底轮询 15s→25s, 生命周期
// 30s→45s (工单/轮次改由 /events 总线实时驱动); 对话流仍走每请求流, 不变。

import { onStatus, retryNow } from "./api/client.js";
import { initChat, pollApprovals, pollQuestions, loadLifecycle, loadHealth, chat } from "./stores/chat.js";
import { loadTasks } from "./stores/rail.js";
import { loadState, startBotPoll, loadBody } from "./stores/bot.js";
import { loadPlugins } from "./stores/admin.js";
import { loadTickets } from "./stores/panels.js";
import { startEventBus } from "./stores/events.js";
import { showToast } from "./stores/toast.js";
import { ui } from "./stores/ui.js";

let _started = false;

export function initChatRail() {
  if (_started) return;
  _started = true;

  initChat();
  loadState().catch(() => {});
  startBotPoll();
  loadPlugins();
  loadBody(); // 身体体征: 首屏静默拉一次, 只为左上角状态点

  // /events 总线: 工单事件 → 打开中的工单面板即时刷新
  startEventBus({
    onTicket() {
      if (ui.drawer && ui.drawerTab === "tickets") loadTickets();
    },
  });

  // 兜底轮询 (审批/提问 25s; 生命周期/健康 45s; 任务 40s) —— 隐藏页暂停
  setInterval(() => { if (!document.hidden) { pollApprovals(); pollQuestions(); } }, 25000);
  setInterval(() => { if (!document.hidden) { loadLifecycle(); loadHealth(); } }, 45000);
  setInterval(() => { if (!document.hidden) loadTasks(); }, 40000);

  // 回到前台立即补一轮 (补偿隐藏期间暂停的刷新)
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) return;
    loadState(true).catch(() => {});
    pollApprovals();
    pollQuestions();
    loadTasks();
    loadBody();
  });

  // 限流恢复: 补拉暂停期间没拉到的读数 (onStatus 由请求层广播)
  let wasThrottled = false;
  onStatus((st) => {
    if (st.throttled) { wasThrottled = true; return; }
    if (!wasThrottled) return;
    wasThrottled = false;
    loadState(true).catch(() => {});
    loadPlugins();
    loadBody();
    loadTickets();
    pollApprovals();
    pollQuestions();
    loadTasks();
  });

  chat._syncRetry = () => { retryNow(); showToast("正在重试…"); };
}

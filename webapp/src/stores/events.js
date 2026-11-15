// webapp/src/stores/events.js - /events 事件总线接入 (v5.0 新增的实时化)
// 服务端 EQ 总线经 GET /events SSE 桥外发; 旧前端从未消费过它, 实时性全押轮询。
// 这里按事件类型分发到各 store:
//   ticket_*  → 工单面板刷新 (工单账本实时化)
//   TURN_* / TOOL_* → 生命周期角标轻刷新 (限频)
//   其余事件忽略 (对话帧仍走 /message/stream —— 会话内实时流, 语义不同)

import { openEventBus } from "../api/sse.js";
import { chat, loadLifecycle, addPlanLiveCard } from "./chat.js";

let bus = null;
let lastTick = 0;

export function startEventBus(hooks = {}) {
  if (bus) return;
  bus = openEventBus({
    onEvent(j) {
      const type = String(j.type || "");
      if (type.startsWith("ticket")) {
        if (hooks.onTicket) hooks.onTicket(j);
        return;
      }
      if (type === "plan_updated") {
        // 回合内计划 (v5.0): update_plan 工具的实时计划卡
        const steps = (j.payload && j.payload.steps) || [];
        addPlanLiveCard(steps);
        return;
      }
      if (type.startsWith("TURN_") || type.startsWith("TOOL_")) {
        // 生命周期角标轻刷新: 10s 限频, 不跟事件风暴
        const now = Date.now();
        if (now - lastTick > 10000) {
          lastTick = now;
          loadLifecycle();
        }
        return;
      }
    },
    onState(st) {
      chat._busState = st;
    },
  });
}

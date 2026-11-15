// src/workgraph/index.js - 工单账本公开入口
export {
  createWorkStore,
  TICKET_STATUS,
  ASSIGNMENT_STATUS,
  isFinalStatus,
} from "./store.js";
export { createWorkService } from "./service.js";
export {
  ORIGIN,
  DEDUPE_STRATEGY,
  DELIVERY_ROUTE,
  DELIVERY_STATE,
  normalizeOrigin,
  normalizeRoute,
  isDeliveryState,
  isTerminalDeliveryState,
  isDedupeStrategy,
  buildDedupeKey,
  dedupeStrategyOf,
  foldDeliveryState,
} from "./state.js";
export {
  VERDICT,
  ACTION,
  DEFAULT_GRACE_MS,
  judgeTicket,
  isTicketCompleted,
} from "./judge.js";

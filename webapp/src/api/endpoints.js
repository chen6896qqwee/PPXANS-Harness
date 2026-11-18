// webapp/src/api/endpoints.js - 全部后端端点收敛 (旧 app.js/bot.js/settings-ui.js/stats.js 各写一份的地方)
// 注意: 会话操作的请求串/字段名是跨端契约 (test/session-search-pin 等按源码字面量锚定),
// 必须保持 `get("/sessions/search?q=`、`post("/sessions/pin", { key:`、`{ key: ... }` 这些写法。

import { get, post, put, del, request } from "./client.js";

/* ---- 会话 / 对话 ---- */
export const loadSessionsApi = () => get("/sessions");
export const searchSessionsApi = (q) => get("/sessions/search?q=" + encodeURIComponent(q));
export const sessionHistoryApi = (key) => get("/sessions/" + encodeURIComponent(key) + "/history");
// 字段名必须与后端一致: 后端读 data.key (曾因发 sessionKey 误删 default 会话)。
// 显式写 key: key / sessionId: sessionId (不用对象简写) —— 跨端契约测试按这些字面量锚定。
export const pinSessionApi = (key, pinned) => post("/sessions/pin", { key: key, pinned });
export const titleSessionApi = (key, title) => post("/sessions/title", { key: key, title });
export const archiveSessionApi = (key, archived) => post("/sessions/archive", { key: key, archived });
export const deleteSessionApi = (key) => post("/sessions/delete", { key: key });
export const rewindApi = (sessionId, turns) => post("/sessions/rewind", { sessionId: sessionId, turns: turns });
export const interruptApi = (sessionId) => post("/interrupt", { sessionId });

/* ---- 审批 / 提问 ---- */
export const approvalsPendingApi = () => get("/api/approvals/pending");
export const approvalDecideApi = (id, decision) => post("/api/approvals/" + encodeURIComponent(id), { decision });
export const approvalRulesApi = () => get("/api/approvals/rules");
export const approvalForgetApi = (key) => post("/api/approvals/rules/forget", { key });
export const questionsPendingApi = () => get("/api/questions/pending");
export const questionAnswerApi = (id, answers) => post("/api/questions/" + encodeURIComponent(id), { answers });
export const questionSkipApi = (id) => post("/api/questions/" + encodeURIComponent(id), { cancel: true });

/* ---- 命令 / 工单 / 任务 / 记忆 / 生命周期 ---- */
export const commandsApi = () => get("/api/commands");
export const tasksApi = () => get("/api/tasks");
export const ticketDetailApi = (id) => get("/api/tickets?id=" + encodeURIComponent(id));
export const ticketOpApi = (op, id) => post("/api/tickets", { op, id });
export const memoryApi = () => get("/api/memory");
export const lifecycleApi = () => get("/api/lifecycle");
export const healthSummaryApi = () => get("/api/health/summary");
export const runStateApi = () => get("/api/run.state");
export const healthApi = () => get("/health");
// 首启就绪: 模型是否可用 / 工作区是否可写 (后端判定, 不再靠 localStorage 标记)
export const readinessApi = () => get("/api/readiness", { quiet: true });

/* ---- 工作区 / 附件 / 语音 ---- */
export const workspaceTreeApi = (maxDepth, root) =>
  get("/api/workspace/tree?maxDepth=" + maxDepth + (root ? "&root=" + encodeURIComponent(root) : ""));
export const workspaceReadApi = (path) => get("/api/workspace/read?path=" + encodeURIComponent(path));
export const goalBoardApi = () => get("/api/goalboard");
export const reviewLatestApi = () => get("/api/review/latest");
export const verifyRecordsApi = () => get("/api/verify/records");
export const evolveStatusApi = () => get("/api/evolve/status");
export const uploadApi = (name, data) => post("/api/upload", { name, data });
export const voiceTranscribeApi = (payload) => post("/api/voice/transcribe", payload);

/* ---- 模型 / 设置 / 权限 ---- */
export const bootstrapApi = () => get("/api/bootstrap");
export const settingsApi = () => get("/api/settings");
export const settingsPutApi = (patch) => request("/api/settings", { method: "PUT", body: JSON.stringify({ patch }) });
export const personaPreviewApi = () => get("/api/persona.preview");
export const permissionsApi = () => get("/api/permissions");
export const permissionsPostApi = (payload) => post("/api/permissions", payload);
export const llmApi = () => get("/api/llm");
export const llmPostApi = (payload) => post("/api/llm", payload);
export const providersApi = () => get("/api/providers");
export const providersPresetsApi = () => get("/api/providers/presets");
export const providersUsageApi = () => get("/api/providers/usage");
export const providerAddApi = (provider) => post("/api/providers", { provider });
export const providerPatchApi = (id, patch) => put("/api/providers", { id, patch });
export const providerDeleteApi = (id) => del("/api/providers", { id });
export const providerTestApi = (id) => post("/api/providers/test", { id });
export const providerReorderApi = (order) => post("/api/providers/reorder", { order });
export const providerFetchModelsApi = (payload) => post("/api/providers/fetch-models", payload);
export const providerDiscoverLocalApi = (api_key) => post("/api/providers/discover-local", { api_key });
export const routingApi = () => get("/api/routing");
export const routingPutApi = (routing) => request("/api/routing", { method: "PUT", body: JSON.stringify({ routing }) });

/* ---- 本体 (bot) ---- */
export const botStateApi = (quiet) => get("/api/bot.state", { timeout: 10000, quiet: !!quiet });
export const botTracesApi = (day) =>
  get("/api/bot.traces?limit=400" + (day ? "&day=" + encodeURIComponent(day) : ""), { timeout: 15000 });
export const botManageApi = (action, payload) =>
  post("/api/bot.manage", Object.assign({ action }, payload || {}), { timeout: 25000 });
export const bodyStateApi = () => get("/api/body.state", { timeout: 8000 });

/* ---- 插件 / 技能 / MCP ---- */
export const pluginsApi = () => get("/api/plugins");
export const pluginGetApi = (id) => get("/api/plugins/" + encodeURIComponent(id));
export const pluginAddApi = (body) => post("/api/plugins", body);
export const pluginPatchApi = (id, body) => put("/api/plugins/" + encodeURIComponent(id), body);
export const pluginDeleteByIdApi = (id) => request("/api/plugins/" + encodeURIComponent(id), { method: "DELETE", timeout: 15000 });
export const skillsApi = () => get("/api/skills");
export const skillsDisableApi = (id, enabled) => post("/api/skills/disable", { id, enabled });
export const mcpServersApi = () => get("/api/mcp/servers");
export const mcpServersPostApi = (body) => post("/api/mcp/servers", body, { timeout: 120000 });
export const mcpServersDeleteApi = (name) => request("/api/mcp/servers?name=" + encodeURIComponent(name), { method: "DELETE", timeout: 120000 });
export const mcpReconnectApi = () => post("/api/mcp/reconnect", {}, { timeout: 120000 });

/* ---- 使用统计 ---- */
export const usageStatsApi = () => get("/api/usage/stats", { quiet: true });

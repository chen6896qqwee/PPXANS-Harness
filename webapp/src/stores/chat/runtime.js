// webapp/src/stores/chat/runtime.js - 命令 / 模型 / 权限 / 运行状态查询
// 2026-11-13 从 stores/chat.js 拆出: 这些调用只读服务端事实并回填 chat 状态,
//   与发送链路 (chat/send.js) 互不依赖; 启动与限流恢复在这里统一补拉。

import { showToast } from "../toast.js";
import { showView } from "../ui.js";
import {
  commandsApi, llmApi, llmPostApi,
  permissionsApi, permissionsPostApi, runStateApi, healthSummaryApi, lifecycleApi,
  memoryApi, healthApi,
} from "../../api/endpoints.js";
import { rail, loadSessions, loadTasks, loadSpaces } from "../rail.js";
import { chat, PERM_LEVELS, REASON_LABELS, addAgentCard } from "./state.js";
import { pollApprovals, pollQuestions } from "./approval.js";
import { switchSessionNow, newSession } from "./session.js";

/* ---------- 命令 / 模型 / 权限 / 状态 ---------- */
async function loadCommands() {
  try {
    const j = await commandsApi();
    chat.commands = (j && j.commands) || [];
  } catch {
    chat.commands = [];
  }
}

async function loadModels(loud) {
  try {
    const { providersApi } = await import("../../api/endpoints.js");
    const j = await providersApi();
    chat.providers = (j && j.providers) || [];
    chat.providersLoaded = true;
    if (loud) showToast("模型服务已刷新");
  } catch {
    // 读取失败 ≠ 没有模型: 保留上一次成功的列表
  }
}

export async function loadLlm() {
  try {
    const j = await llmApi();
    if (j && j.ok) chat.llm = j;
  } catch { /* 端点不可用: 保持 "—", 不冒充"未配置" */ }
}
export async function llmSwitch(providerId) {
  try {
    const r = await llmPostApi({ provider: providerId });
    chat.llm = r;
    chat.seatOpen = false;
    const c = r && r.current;
    showToast("已切换到 " + (c ? c.model + " (" + c.id + ")" : providerId));
  } catch (e) {
    showToast("切换失败: " + ((e && e.message) || ""), true);
  }
}
export async function llmReason(level) {
  try {
    const r = await llmPostApi({ reasoning: level });
    chat.llm = r;
    showToast("思考强度: " + (REASON_LABELS[level] || level) + (level === "auto" ? " (跟随模型默认)" : ""));
  } catch (e) {
    showToast("设置失败: " + ((e && e.message) || ""), true);
  }
}

export function curPermLevel() {
  return PERM_LEVELS.find((x) => x.sandbox === chat.sandbox) || PERM_LEVELS[1];
}
async function loadPermissions() {
  try {
    const p = await permissionsApi();
    if (p && p.ok !== false) {
      if (p.sandbox) chat.sandbox = p.sandbox;
      if (p.approvalMode) chat.perm = p.approvalMode;
      if (p.workspaceRoot !== undefined) chat.wsRoot = p.workspaceRoot;
      if (Array.isArray(p.workspaceAllow)) chat.wsAllow = p.workspaceAllow;
    }
  } catch { /* 保持默认显示 */ }
}
export async function applyPerm(id) {
  const lv = PERM_LEVELS.find((x) => x.id === id);
  if (!lv) return;
  chat.permOpen = false;
  if (chat.sandbox === lv.sandbox && chat.perm === lv.approvalMode) return;
  try {
    const j = await permissionsPostApi({ sandbox: lv.sandbox, approvalMode: lv.approvalMode });
    if (j && j.ok === false) { showToast(j.error || "权限未生效", true); loadPermissions(); return; }
    chat.sandbox = (j && j.sandbox) || lv.sandbox;
    chat.perm = (j && j.approvalMode) || lv.approvalMode;
    if (j && j.workspaceRoot !== undefined) chat.wsRoot = j.workspaceRoot;
    if (j && Array.isArray(j.workspaceAllow)) chat.wsAllow = j.workspaceAllow;
    showToast("权限已切换: " + lv.label);
  } catch (e) {
    showToast("权限切换失败: " + ((e && e.message) || "未知错误"), true);
    loadPermissions();
  }
}
export async function setApprovalMode(v) {
  chat.perm = v;
  try {
    const j = await permissionsPostApi({ approvalMode: v });
    if (j && j.ok === false) { showToast(j.error || "审批模式未生效", true); loadPermissions(); return; }
    showToast("审批模式已生效");
  } catch {
    showToast("已切换本地显示 (服务端模式未变)", false);
    loadPermissions();
  }
}
export async function setSandboxMode(v) {
  try {
    const j = await permissionsPostApi({ sandbox: v });
    if (j && j.ok === false) { showToast(j.error || "沙箱未生效", true); loadPermissions(); return; }
    chat.sandbox = v;
    showToast("沙箱已切换: " + v);
  } catch (e) {
    showToast("沙箱切换失败: " + ((e && e.message) || "未知错误"), true);
    loadPermissions();
  }
}

let _needsActionShown = "";
async function loadRunState() {
  try {
    const j = await runStateApi();
    if (!j) return;
    if (j.context_window) chat.ctxWindow = j.context_window;
    if (j.run && !chat.streaming) chat.run = j.run;
    if (j.usage) chat.lastTokens = j.usage.prompt != null ? j.usage : chat.lastTokens;
    // 2026-11-14 (BYO 体验轮): 坏 Key/欠费等需要用户处理的模型通道状态上浮到界面 ——
    //   此前只有默认关闭的看门狗可见。每个 key 只提示一次, 后端成功调用一次自清。
    const na = Array.isArray(j.llmNeedsAction) ? j.llmNeedsAction : [];
    if (na.length) {
      const key = na.map((x) => `${x.provider}/${x.model}/${x.reason}`).join("|");
      if (key !== _needsActionShown) {
        _needsActionShown = key;
        const x = na[0];
        showToast(`模型通道需要处理: ${x.provider}/${x.model} [${x.reason}] ${x.userHint || ""} — 到「设置 → 模型」可当场重试测试`, true);
      }
    } else if (_needsActionShown) {
      _needsActionShown = "";
    }
  } catch { /* 忽略 */ }
}
export async function loadHealth() {
  try {
    const j = await healthSummaryApi();
    chat.health = j && j.ok !== false ? j : null;
  } catch { chat.health = null; }
}
export async function loadLifecycle() {
  try {
    const j = await lifecycleApi();
    const st = (j && (j.stage || j.status)) || null;
    if (st) chat.life = st;
  } catch { /* 忽略 */ }
}

/* 记忆速览 (侧栏能力入口): 分组计数 + 高分事实, 不再裸倒 JSON */
export async function showMemoryDigest() {
  try {
    const j = await memoryApi();
    const facts = (j && j.facts) || [];
    const card = addAgentCard();
    card.streaming = false;
    if (!facts.length) {
      card.text = "## 记忆\nL1 事实库为空 —— 多聊几句会自动沉淀。";
      return;
    }
    const byType = {};
    facts.forEach((f) => { const t = f.type || "general"; byType[t] = (byType[t] || 0) + 1; });
    const lines = ["## 记忆 · L1 事实库 (" + facts.length + " 条)",
      Object.keys(byType).map((t) => "`" + t + "` × " + byType[t]).join(" · "), ""];
    facts.slice(0, 12).forEach((f) => {
      lines.push("- " + (f.score >= 15 ? "★ " : "") + String(f.content || "").slice(0, 60));
    });
    if (facts.length > 12) lines.push("\n… 共 " + facts.length + " 条, 其余用 `/memory` 管理。");
    card.text = lines.join("\n");
    showView("chat");
  } catch (e) {
    showToast((e && e.message) || "读取失败", true);
  }
}

/* ---------- 限流恢复: 节流窗口结束后补拉一轮 ---------- */
export function onThrottleRecovered(reloadDrawer) {
  loadSessions();
  loadTasks();
  loadModels();
  loadLlm();
  loadHealth();
  loadLifecycle();
  loadRunState();
  pollApprovals();
  pollQuestions();
  if (reloadDrawer) reloadDrawer();
}

/* ---------- 启动 ---------- */
export async function initChat() {
  loadSpaces();
  try {
    const j = await healthApi();
    if (j && j.version) chat.versionTag = "v" + String(j.version).split(".")[0];
  } catch { /* 忽略 */ }
  chat.toolsCount = (window.__PPX_BOOTSTRAP__ && window.__PPX_BOOTSTRAP__.toolsCount) || "";
  loadModels();
  loadPermissions();
  const saved = (() => { try { return localStorage.getItem("ppx_session"); } catch { return null; } })();
  await loadSessions();
  const found = rail.sessions.find((s) => s.key === saved);
  if (found) switchSessionNow(found.key, found.title || found.name);
  else newSession();
  loadCommands();
  loadLifecycle();
  loadHealth();
  loadTasks();
  loadLlm();
  loadRunState();
  pollApprovals();
  pollQuestions();
}

// src/ans/proactive.js - 自主任务生成 (ANS)
// 扫描 L1 事实(FactStore.list())里的待办/偏好信号 → 结构化提醒 payload
//
// 输出契约 (ticker 回调 / 通道消费方):
//   payload = { ts: number, items: Array<{content, importance, source, id}>, text: string }
//   - text: 可直接投递的一句话文本 (LLM 语义提炼或启发式拼接)
//   - items: 结构化条目, 供通道方自行排版/去重/分级
//   - 无待办信号或生成失败 → null (不打扰)
// 投递保证: 非 null 才回调; 回调异常被捕获, 不影响定时器
//
// v1.0.7 去重 + 完成跟踪 (P1):
//   - 提醒状态存 data/memory/proactive.json: { [factId]: { lastRemindedAt, done } }
//   - 同一待办在窗口内 (默认 24h) 不重复提醒; 标记完成的待办不再提醒
import fs from "node:fs";
import path from "node:path";
import { ensureDir } from "../utils/store.js";
import { info } from "../utils/logger.js";

// 待办/偏好信号词 (启发式)
const PENDING_RE = /待办|需要|记得|计划|还没|未完成|想|要|必须/;
// 重复提醒窗口 (默认 24h)
const DEFAULT_WINDOW_MS = 24 * 3600 * 1000;

// 带时效待办过期检测: 内容含明确过去时间 ("昨天/上周" 或已过的具体日期) → 不再提醒 (v1.0.7)
export function isExpired(content) {
  const s = String(content || "");
  if (/昨天|上周|上个月|上星期/.test(s)) return true;
  const m = s.match(/(\d{4})[-年](\d{1,2})[-月](\d{1,2})日?/);
  if (m) {
    const d = new Date(+m[1], +m[2] - 1, +m[3]).getTime();
    return !Number.isNaN(d) && d < Date.now();
  }
  return false;
}

function _stateFile(agent) {
  return path.join(agent.dataDir, "memory", "proactive.json");
}

// 读取提醒状态 (缺失/损坏 → {})
export function loadState(agent) {
  try {
    const f = _stateFile(agent);
    if (fs.existsSync(f)) {
      const s = JSON.parse(fs.readFileSync(f, "utf8"));
      return (s && typeof s === "object") ? s : {};
    }
  } catch {}
  return {};
}

export function saveState(agent, state) {
  try {
    const f = _stateFile(agent);
    ensureDir(path.dirname(f));
    fs.writeFileSync(f, JSON.stringify(state, null, 2), "utf8");
  } catch {}
}

// 结构化扫描: 从 L1 事实里筛出待办信号 (契约的数据源)
// windowMs: 重复提醒窗口; done 的待办永不再提醒
export function pendingTasks(agent, { limit = 5, windowMs = DEFAULT_WINDOW_MS } = {}) {
  if (!agent || !agent.facts) return [];
  const state = loadState(agent);
  const now = Date.now();
  return agent.facts.list()
    .filter((f) => f && PENDING_RE.test(String(f.content || "")))
    .filter((f) => !isExpired(f.content))                          // 已过期的不提醒
    .filter((f) => {
      const st = state[f.id];
      if (!st) return true;                                        // 从未提醒过
      if (st.done) return false;                                   // 已标记完成
      if (st.lastRemindedAt && (now - st.lastRemindedAt) < windowMs) return false; // 窗口内不重复
      return true;
    })
    .slice(0, limit)
    .map((f) => ({
      content: String(f.content || "").slice(0, 100),
      importance: f.importance ?? 0,
      source: f.source || "manual",
      id: f.id || null,
    }));
}

// 标记待办完成: 之后不再提醒
export function markTaskDone(agent, id) {
  if (!id) return false;
  const exists = agent && agent.facts && agent.facts.list().some((f) => f.id === id);
  if (!exists) return false;
  const state = loadState(agent);
  state[id] = { ...(state[id] || {}), done: true, doneAt: Date.now() };
  saveState(agent, state);
  return true;
}

// 生成主动提醒: 有 LLM 走语义提炼 (1-3 条简短提醒), 无 LLM 走启发式拼接
// 生成成功后记录 lastRemindedAt (去重); 失败/空不记录 (下次重试)
export async function suggestProactive(agent) {
  try {
    const items = pendingTasks(agent);
    if (!items.length) return null;
    const lines = items.map((t) => "- " + t.content);
    // 模型不可用 (未配置/未运行) 时走启发式拼接, 不发起 LLM 等待 (v1.0.7 快速降级)
    const llmReady = !agent.llm ? false : (agent._auxLlmReady ? await agent._auxLlmReady() : true);
    let text;
    if (!llmReady) {
      text = "【主动提醒】你之前提到过:\n" + lines.join("\n");
    } else {
      // 短超时: 主动提醒是后台任务, LLM 不可用时快速降级启发式, 不阻塞 ticker
      const r = await agent.llm.chat([
        { role: "system", content: "你是主动助手。基于用户历史提到的待办/偏好, 生成 1-3 条简短主动提醒 (每条 ≤30 字, 直接输出, 不要客套)。" },
        { role: "user", content: lines.join("\n") },
      ], { timeoutMs: 10000, retryMax: 0 });
      text = String(r?.content || "").trim();
      if (!text) return null;
    }
    // 记录已提醒时间戳 (窗口去重)
    const state = loadState(agent);
    for (const it of items) {
      if (!it.id) continue;
      state[it.id] = { ...(state[it.id] || {}), lastRemindedAt: Date.now() };
    }
    saveState(agent, state);
    return { ts: Date.now(), items, text };
  } catch (e) {
    info(`[proactive] 生成失败: ${e.message}`);
    return null;
  }
}

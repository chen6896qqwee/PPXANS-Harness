// src/llm/needs-action.js - LLM 通道"需要用户处理"持久标志 (2026-11-14, 评测 P1-2)
//
// 问题: auth/balance/not_found 类失败 (needsUserAction=true) 重试无意义, 但除了
//   data/logs/llm/last-error.json (会被任何一次失败覆写, 含测试桩的假错误) 之外
//   没有任何持久面 —— 2026-11-13 起 deepseek-flash 401 失效, 看门狗/巡检全部无感,
//   智能体静默停摆半天多。
//
// 落地: 专门一个标志文件 (不会被瞬时错误覆写), LLM client 在 needsUserAction 错误时
//   写入/累加, HTTP 成功时清除; 看门狗 collectSignals 读入心跳简报 → WARN/CRIT 级
//   自动广播。数据面 = <dataDir>/llm/needs-action.json, 与 diagDir() 同源解析。
//
// 写入方: src/llm/client.js (markNeedsAction / clearNeedsAction)
// 读取方: src/ans/watchdog.js (readNeedsAction) / ppx doctor 类巡检
import fs from "node:fs";
import path from "node:path";
import { noteCatch } from "../utils/catch-log.js";

function dataDir() {
  if (process.env.PPX_DATA_DIR) return process.env.PPX_DATA_DIR;
  if (process.env.PPX_TEST_TMP_ROOT) return path.join(process.env.PPX_TEST_TMP_ROOT, "data");
  return path.join(process.cwd(), "data");
}

function flagPath(dir = null) {
  return path.join(dir || dataDir(), "llm", "needs-action.json");
}

// 标记"需要用户处理": 同 provider+model+reason 累加 count, 否则新开一条。
// 信息只存分类结果与提示, 不存请求体 (那里有密钥面)。
export function markNeedsAction({ provider, model, reason, userHint, status }, dir = null) {
  try {
    const p = flagPath(dir);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    let cur = null;
    try { cur = JSON.parse(fs.readFileSync(p, "utf8")); } catch { cur = null; /* swallowed-ok(2026-11-14): 首次标记无旧文件/坏文件即重建, 契约同 safeJsonParse */ }
    if (!cur || typeof cur !== "object" || !Array.isArray(cur.entries)) cur = { updated: null, entries: [] };
    const now = new Date().toISOString();
    const key = `${provider || "?"}/${model || "?"}/${reason || "?"}`;
    const hit = cur.entries.find((e) => e.key === key);
    if (hit) {
      hit.count = (Number(hit.count) || 0) + 1;
      hit.lastAt = now;
      if (userHint) hit.userHint = String(userHint);
      if (status != null) hit.status = status;
    } else {
      cur.entries.push({ key, provider: provider || null, model: model || null, reason: reason || null, userHint: userHint || null, status: status ?? null, count: 1, firstAt: now, lastAt: now });
    }
    cur.updated = now;
    fs.writeFileSync(p, JSON.stringify(cur, null, 1), "utf8");
    return true;
  } catch (e) {
    noteCatch("src/llm/needs-action.js#markNeedsAction", e);
    return false;
  }
}

// HTTP 成功时清除 (恢复自愈不需要任何人确认 —— 下次失败会重新标记)
export function clearNeedsAction(dir = null) {
  try {
    fs.rmSync(flagPath(dir), { force: true });
    return true;
  } catch (e) {
    noteCatch("src/llm/needs-action.js#clearNeedsAction", e);
    return false;
  }
}

// 读取 (无标志/坏文件 → null)。看门狗心跳与巡检用。
export function readNeedsAction(dir = null) {
  try {
    const raw = fs.readFileSync(flagPath(dir), "utf8");
    const cur = JSON.parse(raw);
    if (!cur || !Array.isArray(cur.entries) || !cur.entries.length) return null;
    return cur;
  } catch {
    /* swallowed-ok(2026-11-14): 无标志/坏文件 → null 是读取契约 (看门狗/巡检防御式读取, 语义同 safeJsonParse) */
    return null;
  }
}

// src/security/escalation-flag.js - 权限提升持久标志 (2026-11-14, 评测 P1-1)
//
// 问题: 提权留痕已有三通道 (tracer 事件会轮转 / 审计哈希链 / notify), 但看门狗心跳
//   不采这个体征 —— "谁把沙箱放宽到 danger-full-access" 若非本人操作, 30 分钟一次的
//   心跳完全无感 (2026-11-03 生产轨迹 10 次 via:http 提权, 心跳 level 恒 ok)。
//
// 落地: 照 src/llm/needs-action.js 的持久标志模式 —— <dataDir>/security/escalation-flag.json,
//   recordEscalation 写入, 看门狗 collectSignals 读入, 24h 内的提权要求心跳 CRIT 首行广播。
//   与 needs-action 的差异: 提权是**已发生的事实**, 无"恢复即清除"语义 —— 靠 maxAgeMs
//   过期自然淡出, 不需要任何人工确认动作。
//
// 写入方: src/permissions/index.js (recordEscalation 第四通道)
// 读取方: src/ans/watchdog.js (collectSignals → renderWatchdogPrompt CRIT 段)
import fs from "node:fs";
import path from "node:path";
import { noteCatch } from "../utils/catch-log.js";

const DEFAULT_MAX_AGE_MS = 24 * 60 * 60 * 1000;

// 与 src/llm/needs-action.js 的 dataDir() 同源解析 (测试可用 dir 参数定向, 避开全局态)
function dataDir() {
  if (process.env.PPX_DATA_DIR) return process.env.PPX_DATA_DIR;
  if (process.env.PPX_TEST_TMP_ROOT) return path.join(process.env.PPX_TEST_TMP_ROOT, "data");
  return path.join(process.cwd(), "data");
}

function flagPath(dir = null) {
  return path.join(dir || dataDir(), "security", "escalation-flag.json");
}

// 记录一次提权: 同 via 累加 count 并刷新 lastChanges; 写失败不阻断提权本身 (可观测降级)。
export function markEscalation({ via, changes }, dir = null) {
  try {
    const p = flagPath(dir);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    let cur = null;
    try { cur = JSON.parse(fs.readFileSync(p, "utf8")); } catch { cur = null; /* 首次/坏文件即重建, 契约同 needs-action */ }
    if (!cur || typeof cur !== "object" || !Array.isArray(cur.entries)) cur = { updated: null, entries: [] };
    const now = new Date().toISOString();
    const key = String(via || "http");
    const list = Array.isArray(changes) ? changes.map(String) : [];
    const hit = cur.entries.find((e) => e.key === key);
    if (hit) {
      hit.count = (Number(hit.count) || 0) + 1;
      hit.lastAt = now;
      if (list.length) hit.lastChanges = list;
    } else {
      cur.entries.push({ key, via: key, count: 1, firstAt: now, lastAt: now, lastChanges: list });
    }
    cur.updated = now;
    fs.writeFileSync(p, JSON.stringify(cur, null, 1), "utf8");
    return true;
  } catch (e) {
    noteCatch("src/security/escalation-flag.js#markEscalation", e);
    return false;
  }
}

// 读取 maxAgeMs 内的提权标志; 全部过期/缺失/损坏 → null (看门狗按"无告警"处理, 不写盘)。
// 返回聚合视图 { count, via, changes, lastAt, firstAt } —— 看门狗只关心"最近有没有、什么量级"。
export function readRecentEscalation({ maxAgeMs = DEFAULT_MAX_AGE_MS } = {}, dir = null) {
  let raw = null;
  try {
    raw = JSON.parse(fs.readFileSync(flagPath(dir), "utf8"));
  } catch {
    return null; // 缺失/损坏 = 无标志 (文件由本模块写, 坏文件不值得告警)
  }
  if (!raw || !Array.isArray(raw.entries)) return null;
  const floor = Date.now() - Math.max(1000, Number(maxAgeMs) || DEFAULT_MAX_AGE_MS);
  const recent = raw.entries.filter((e) => Date.parse(e.lastAt || "") >= floor);
  if (!recent.length) return null;
  const last = recent.reduce((a, b) => (Date.parse(a.lastAt || "") >= Date.parse(b.lastAt || "") ? a : b));
  return {
    count: recent.reduce((n, e) => n + (Number(e.count) || 0), 0),
    via: last.via || last.key || "http",
    changes: Array.isArray(last.lastChanges) ? last.lastChanges : [],
    lastAt: last.lastAt || null,
    firstAt: recent.map((e) => e.firstAt).filter(Boolean).sort()[0] || null,
  };
}

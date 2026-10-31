// scripts/lib/bench-history.js — 探针结果的历史追加 (2026-10-30)
//
// 为什么需要:
//   两个探针原本只写 `data/bench/<kind>-YYYY-MM-DD.json`, 一天一个文件、当天覆盖。
//   于是面板只能读到"最近一次", 读不到"变好还是变差" —— 而趋势恰恰是体征里最有用的信息:
//   "记忆召回 93%" 单独看没有意义, "比上周的 60% 好了" 才有。
//
// 设计:
//   · 每跑一次追加一行到 `<kind>-history.jsonl` (追加写, 崩溃只丢最后一行);
//   · 保留最近 MAX_KEEP 条, 超出时整体重写一次 —— 文件只有几十行, 重写成本可忽略;
//   · 只存判分需要的字段 (rate / acceptance / ms), 不存逐条明细 (明细在当日 json 里)。
//
// 面板读同一份文件 (src/web/bot-api.js buildBodyState), 格式由本模块与那边共同约定:
//   每行一个 JSON: { ts, rate?, acceptance?, ms?, passed?, total? }
import fs from "node:fs";
import path from "node:path";

export const MAX_KEEP = 60;

export function historyPath(dir, kind) {
  return path.join(dir, `${kind}-history.jsonl`);
}

// 追加一次结果。失败静默 (探针本身不能因为写历史而挂)。
export function appendHistory(dir, kind, entry) {
  try {
    fs.mkdirSync(dir, { recursive: true });
    const file = historyPath(dir, kind);
    fs.appendFileSync(file, JSON.stringify({ ts: new Date().toISOString(), ...entry }) + "\n", "utf8");
    // 截断: 超过上限时保留最近 MAX_KEEP 条 (一次性重写, 原子换名)
    const lines = fs.readFileSync(file, "utf8").split("\n").filter(Boolean);
    if (lines.length > MAX_KEEP) {
      const kept = lines.slice(-MAX_KEEP).join("\n") + "\n";
      const tmp = file + ".tmp";
      fs.writeFileSync(tmp, kept, "utf8");
      fs.renameSync(tmp, file);
    }
    return true;
  } catch { return false; }
}

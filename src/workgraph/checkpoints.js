// src/workgraph/checkpoints.js - 工具级检查点账本 (Step 7, 断点续执行)
//
// 每次只读/幂等工具执行完成后，把 (tool, args 摘要) → 结果 追加到
//   `<checkpointDir>/<assignmentId>.jsonl`。默认关闭 (work_graph.resume_checkpoint)，
//   关闭时不建目录、不写盘 (I1)。这是**执行事实缓存**，不是账本真相: 丢失只影响续跑效率。
//
// 2026-11-12 自 store.js 拆出: 工单账本是 append-only 真相日志, 检查点是可丢弃的
//   "省点重复调用"缓存 —— 两者的生命周期和失效条件不同, 放在一个文件里容易让人以为
//   检查点也要参与折叠/压缩。
import fs from "node:fs";
import path from "node:path";
import { clip } from "../utils/text.js";

const MAX_ENTRIES = 500;
const RESULT_CHARS = 4000;

// isKnownAssignment: 只有真实存在的指派才写检查点, 防止外部 id 在磁盘上长出孤儿文件。
export function createCheckpointStore({
  dir,
  enabled = false,
  now = Date.now,
  isKnownAssignment = () => true,
} = {}) {
  let dirReady = false;
  let counts = null; // assignmentId -> 已写条数 (懒加载, 防每次 stat)

  // assignment id 由 workgraph 生成, 这里仍做字符白名单 —— 检查点路径不允许被外部输入穿越。
  function _file(assignmentId) {
    const safe = String(assignmentId || "").replace(/[^A-Za-z0-9_-]/g, "");
    return safe ? path.join(dir, `${safe}.jsonl`) : null;
  }

  function record(assignmentId, entry = {}) {
    if (!enabled) return false;
    const file = _file(assignmentId);
    if (!file || !isKnownAssignment(assignmentId)) return false;
    const tool = clip(entry.tool, 100);
    const key = clip(entry.key, 80);
    if (!tool || !key) return false;
    const book = counts || (counts = new Map());
    let n = book.get(String(assignmentId));
    if (n == null) {
      n = 0;
      if (fs.existsSync(file)) {
        for (const line of fs.readFileSync(file, "utf8").split("\n")) if (line.trim()) n += 1;
      }
      book.set(String(assignmentId), n);
    }
    if (n >= MAX_ENTRIES) return false;
    if (!dirReady) { fs.mkdirSync(dir, { recursive: true }); dirReady = true; }
    const raw = entry.result == null ? "" : String(entry.result);
    const rec = {
      v: 1,
      at: now(),
      callId: entry.callId == null ? null : clip(entry.callId, 100),
      tool,
      key,
      ok: entry.ok !== false,
      chars: raw.length,
      result: clip(raw, RESULT_CHARS),
    };
    fs.appendFileSync(file, JSON.stringify(rec) + "\n", "utf8");
    book.set(String(assignmentId), n + 1);
    return true;
  }

  function list(assignmentId) {
    const file = _file(assignmentId);
    if (!file || !fs.existsSync(file)) return [];
    const out = [];
    for (const line of fs.readFileSync(file, "utf8").split("\n")) {
      if (out.length >= MAX_ENTRIES) break;
      if (!line.trim()) continue;
      try {
        const rec = JSON.parse(line);
        if (rec && typeof rec === "object" && rec.tool && rec.key) out.push(rec);
      } catch { /* 坏行不影响其余检查点 */ }
    }
    return out;
  }

  function drop(assignmentId) {
    const file = _file(assignmentId);
    if (counts) counts.delete(String(assignmentId));
    if (!file) return false;
    try { fs.unlinkSync(file); return true; } catch { return false; }
  }

  return { record, list, drop };
}

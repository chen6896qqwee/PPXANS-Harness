// src/utils/wal.js - 追加式变更日志 (Write-Ahead Log) 轻量实现
// 用途: 记忆数据的高频增量落盘。每次变更 append 一行事件到 <file>.wal (单行 JSON, 原子追加),
//       达到阈值或显式 flush 时全量 compact 到主文件 + 清空 WAL。
// 崩溃安全: 主文件 = 最后一次 flush 快照, WAL = 快照后的增量; 启动时重放 WAL 恢复。
// 重放幂等: 事件按 id upsert/remove, 重复应用无害 (flush 后崩溃最多重放已落盘变更)。
import fs from "node:fs";
import path from "node:path";
import { ensureDir } from "./store.js";

export function walFileOf(file) {
  return file + ".wal";
}

// 追加一条事件 (JSON 行)。appendFileSync 单行追加在正常写入下原子; 失败抛错由调用方降级 (内存态仍正确, 下次 flush 补齐)。
export function appendWal(walFile, evt) {
  ensureDir(path.dirname(walFile));
  fs.appendFileSync(walFile, JSON.stringify(evt) + "\n", "utf8");
}

// 读 WAL: 逐行解析; 尾部半行 (崩溃中断写入) 静默丢弃; 返回事件数组
export function readWal(walFile) {
  if (!fs.existsSync(walFile)) return [];
  let raw;
  try { raw = fs.readFileSync(walFile, "utf8"); } catch { return []; }
  if (!raw) return [];
  const events = [];
  for (const line of raw.split("\n")) {
    const t = line.trim();
    if (!t) continue;
    try { events.push(JSON.parse(t)); } catch { break; } // 半行丢弃, 后面的已不可信
  }
  return events;
}

// 清空 WAL (compact 成功后调用; 与 append 同一锁内执行, 防丢事件)
export function truncateWal(walFile) {
  try { fs.rmSync(walFile, { force: true }); } catch {}
}

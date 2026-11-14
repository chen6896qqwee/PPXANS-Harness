// src/utils/wal.js - 追加式变更日志 (Write-Ahead Log) 轻量实现
// 用途: 记忆数据的高频增量落盘。每次变更 append 一行事件到 <file>.wal (单行 JSON, 原子追加),
//       达到阈值或显式 flush 时全量 compact 到主文件 + 清空 WAL。
// 崩溃安全: 主文件 = 最后一次 flush 快照, WAL = 快照后的增量; 启动时重放 WAL 恢复。
// 重放幂等: 事件按 id upsert/remove, 重复应用无害 (flush 后崩溃最多重放已落盘变更)。
// 上限 (v2026-10-05 F7): 追加日志不是无限增长的日志, compact 由两把闸共同触发 ——
//   事件条数 (walThreshold) 与字节水位 (walSizeBytes >= FactStore 的 walMaxBytes)。
//   compact 顺序恒为"先写全量快照, 再清 WAL"(见 fact-store._flushLocked), 所以任何时刻
//   (含清空的瞬间) 快照∪WAL 都覆盖此前全部已提交变更 = 不丢耐久性, 且重放结果与裁剪前等价。
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

// 当前 WAL 字节数 (不存在 = 0)。
// 为什么按**字节**再加一道水位 (v2026-10-05, F7): 事件条数阈值 (walThreshold) 数的是"条",
// 一条事件却可以任意大 —— {op:"replace"} 把整个库序列化进同一行 (importAll(mode:"replace")
// 实测一条 40 万字节), 于是"没到阈值"的 40 次整体替换能让追加日志涨到 13.8MB
// (同场景主快照只有 2 字节, 2500 次 add 的正常峰值只有 18KB)。
// 条数阈值管写放大频率, 字节水位管绝对上限, 两者互补、缺一不可。
// 只做 stat 不读内容: 调用点在持锁临界区内, 每次追加后一次 stat 成本可忽略。
export function walSizeBytes(walFile) {
  try { return fs.statSync(walFile).size; } catch { return 0; }
}

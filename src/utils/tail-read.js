// src/utils/tail-read.js - 只读文件末尾 N 字节 (utf8 字符串)
//
// 单源说明 (2026-11-03 重复消除): 此前「openSync + fstatSync + 尾窗 readSync」的尾巴读取
// 在 session._tailMaxSeq / protocol._tailSeq / memory-ticker._readTail / memory-ticker-archive
// 尾窗 / audit-chain.readLastLine 五处各写一份, 阈值与半截行处理已开始互相漂移。
// 本原语只做「安全取尾」一件事: 文件不存在/空 → 返回 "", 读失败 noteCatch 后返回 "";
// 末行截断与否由调用方按自身语义处理 (seq 回退 / shift 半行 / 取最后一行)。
import fs from "node:fs";
import { noteCatch } from "./catch-log.js";

export function readFileTail(file, maxBytes) {
  if (!fs.existsSync(file)) return "";
  let fd;
  try {
    fd = fs.openSync(file, "r");
    const size = fs.fstatSync(fd).size;
    if (!size) return "";
    const len = Math.min(size, maxBytes);
    const buf = Buffer.alloc(len);
    const got = fs.readSync(fd, buf, 0, len, size - len);
    return buf.subarray(0, got).toString("utf8");
  } catch (e) {
    noteCatch("src/utils/tail-read.js#readFileTail", e);
    return "";
  } finally {
    if (fd != null) { try { fs.closeSync(fd); } catch (e) { noteCatch(e); /* ignore */ } }
  }
}

// 尾窗回退找最大 seq (NDJSON 事件日志的跨进程续号读数): 末行可能是别的进程刚写了一半,
// 从最后一行往前找到第一条「能解析且 seq 为有限数」的为止。此前 session._tailMaxSeq 与
// protocol._tailSeq 各持一份同语义循环 (一处用 noteCatch 一处静默) —— 收口到这里。
export function readTailSeq(file, maxBytes = 8192) {
  const text = readFileTail(file, maxBytes);
  if (!text) return 0;
  const lines = text.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const s = lines[i].trim();
    if (!s) continue;
    try {
      const e = JSON.parse(s);
      if (Number.isFinite(e?.seq)) return e.seq;
    } catch { /* 半截行/首行残段, 继续往前找 */ }
  }
  return 0;
}

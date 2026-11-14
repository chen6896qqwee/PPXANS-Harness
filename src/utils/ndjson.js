// src/utils/ndjson.js - 尾随 NDJSON (换行分隔 JSON) 流工具 (唯一实现, 2026-09-18 重构收敛)
// 背景: orchestrator/legion.js 读子进程 stdout 与 orchestrator/agent-worker.js 读 stdin,
// 各写一份逐字相同的「累积缓冲 → 按 \n 切行 → 跳过空行」循环; 写侧同样散落 6 处
// `stream.write(JSON.stringify(obj) + "\n")`。缓冲边界是最易出错的点, 收敛为单一实现。

// 创建行读取器: 把 data 分片喂进去, 每切出完整一行就回调 onLine(已 trim 的行内容)。
// 残行留在内部缓冲等下一片。返回的函数直接挂到 stream 的 "data" 事件上。
export function createLineReader(onLine) {
  let buf = "";
  return (chunk) => {
    buf += chunk;
    let idx;
    while ((idx = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, idx).trim();
      buf = buf.slice(idx + 1);
      if (!line) continue;
      onLine(line);
    }
  };
}

// 把对象序列化成一行 NDJSON 并写入流 (进程间消息收发的统一写法)
export function writeLine(stream, obj) {
  stream.write(JSON.stringify(obj) + "\n");
}

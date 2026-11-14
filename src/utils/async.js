// src/utils/async.js - 异步小工具 (唯一实现, 2026-09-18 重构收敛)
// 背景: withTimeout 原先在 orchestrator/supervisor.js 与 tools/delegate.js 各写一份,
// 逐字相同 (含定时器清理注释)。收敛后 orchestrator 仍 re-export 同名函数, 对外接口不变。

// 带超时等待 (防子 agent 卡死)。
// 定时器必须清理, 否则 promise 快速 resolve 后残留的 setTimeout 仍会挂住事件循环
// (最长到超时时间), 阻止进程正常退出。
export function withTimeout(p, ms, label) {
  let timer;
  const timeout = new Promise((_, rej) => {
    timer = setTimeout(() => rej(new Error(`${label}超时 (${ms / 1000}s)`)), ms);
  });
  return Promise.race([p, timeout]).finally(() => clearTimeout(timer));
}

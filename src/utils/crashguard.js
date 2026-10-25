// src/utils/crashguard.js - 全局异常兜底 (2026-09-17 体检新增, P1)
//
// 问题: 全项目此前只处理 SIGINT/SIGTERM, 没有 uncaughtException / unhandledRejection 兜底。
//   Node >= 15 的默认行为是未处理的 Promise 拒绝直接终止进程 —— 对一个"双击即用"的
//   桌面产品, 表现为窗口里的服务突然消失、用户只看到"未连接", 且没有任何线索。
//
// 策略 (可配置):
//   默认: 记录完整堆栈 + 回调通知 (供总线广播/落盘), 然后**继续运行**。
//     理由: 桌面场景下"带伤继续"远好于"静默消失"; 绝大多数异常来自单个请求/工具,
//     进程级状态并未损坏。
//   PPX_EXIT_ON_UNCAUGHT=1: 恢复"记录后退出"的传统行为 (适合作为 systemd/pm2 托管进程,
//     由外部守护拉起)。退出码 1。
//
// 结构: 上报逻辑抽成独立工厂 createCrashReporter, 与 process 事件解耦 —— 便于单测,
//   也避免测试进程里手动 emit 事件被 node:test 判为用例失败。
const DEDUPE_WINDOW_MS = 5000;
let installed = false; // 模块级单例标记: 兜底只需装一次

function signature(err) {
  return String(err?.stack || err?.message || err || "unknown").split("\n").slice(0, 3).join("|");
}

/**
 * 创建一个"带去重折叠"的异常上报器。
 * @param {object} opts
 * @param {string}   [opts.tag="ppx"]  日志前缀
 * @param {function} [opts.onError]    (err, kind) => void, 额外回调 (广播/落盘)
 * @param {object}   [opts.logger]     日志器 (需有 warn/error), 默认 console
 * @param {number}   [opts.dedupeMs]   同类错误折叠窗口
 * @returns {(kind: string, err: unknown) => void} report
 */
export function createCrashReporter({ tag = "ppx", onError = null, logger = null, dedupeMs = DEDUPE_WINDOW_MS } = {}) {
  const log = logger || { error: (...a) => console.error(...a), warn: (...a) => console.warn(...a) };
  let lastSig = "";
  let lastAt = 0;
  let dupes = 0;

  return function report(kind, err) {
    const now = Date.now();
    const sig = signature(err);
    if (sig === lastSig && now - lastAt < dedupeMs) {
      dupes++;
      if (dupes % 20 === 0) log.warn(`[${tag}] ${kind} 重复出现 ${dupes} 次 (同类错误已折叠)`);
      return;
    }
    lastSig = sig;
    lastAt = now;
    dupes = 0;
    const detail = err?.stack || err?.message || String(err);
    log.error(`[${tag}] 捕获 ${kind} (进程保持运行): ${detail}`);
    try { onError && onError(err, kind); } catch { /* 兜底本身不得再抛 */ }
  };
}

/**
 * 安装全局异常兜底 (幂等: 重复调用只安装一次)。
 * @param {object} opts 见 createCrashReporter; 另支持 exitOnUncaught 覆盖环境变量
 * @returns {function} 卸载函数
 */
export function installCrashGuard(opts = {}) {
  if (installed) return () => {};
  installed = true;

  const log = opts.logger || { error: (...a) => console.error(...a), warn: (...a) => console.warn(...a) };
  const report = createCrashReporter(opts);
  const exitOn = opts.exitOnUncaught != null
    ? !!opts.exitOnUncaught
    : String(process.env.PPX_EXIT_ON_UNCAUGHT || "") === "1";

  const onUncaught = (err) => {
    report("uncaughtException", err);
    if (exitOn) {
      log.error("[ppx] PPX_EXIT_ON_UNCAUGHT=1 → 退出 (退出码 1), 请交由外部守护拉起");
      process.exit(1);
    }
  };
  // 未处理的 Promise 拒绝在 Node >= 15 会终止进程; 桌面形态下改为记录后继续
  const onRejection = (reason) => report("unhandledRejection", reason);

  process.on("uncaughtException", onUncaught);
  process.on("unhandledRejection", onRejection);

  return () => {
    process.off("uncaughtException", onUncaught);
    process.off("unhandledRejection", onRejection);
    installed = false;
  };
}

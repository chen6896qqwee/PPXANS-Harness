#!/usr/bin/env node
// scripts/external-watchdog.mjs - 任务级外部看门狗 CLI (2026-11-05 Step 8)
//
// 用法:
//   node scripts/external-watchdog.mjs                         # 单次巡检 (默认 http://127.0.0.1:8899)
//   node scripts/external-watchdog.mjs --watch --interval 60   # 常驻, 每 60s 一次
//   node scripts/external-watchdog.mjs --act cancel --max-actions 1
//   node scripts/external-watchdog.mjs --json                  # 机器可读
//
// 认证: --token <t> 或 PPX_AUTH_TOKEN; 都没有时尝试 /api/bootstrap (仅回环请求下发 token)。
// 退出码: 0 = 健康, 1 = 发现停滞/漂移, 2 = 配置/请求/认证错误。
// 默认只报告; --act cancel 才发取消请求, 且受 --max-actions 上限约束 (不重跑、不批量清理)。
import { createExternalWatchdog, EXTERNAL_WATCHDOG_DEFAULTS } from "../src/ans/external-watchdog.js";

const USAGE = `用法: node scripts/external-watchdog.mjs [选项]

  --url <url>            服务地址 (默认 $PPX_BASE_URL 或 http://127.0.0.1:8899)
  --token <token>        Bearer token (默认 $PPX_AUTH_TOKEN; 缺省时读 /api/bootstrap)
  --watch                常驻轮询 (Ctrl+C 退出)
  --interval <秒>        轮询间隔 (默认 60, 最小 5)
  --act cancel           显式人工接管: 取消停滞/漂移工单 (默认只报告)
  --max-actions <n>      单次最多取消条数 (默认 ${EXTERNAL_WATCHDOG_DEFAULTS.maxActions})
  --stall-minutes <n>    停滞阈值 (默认 ${EXTERNAL_WATCHDOG_DEFAULTS.stallMinutes})
  --drift-repeat <n>     同工具连续次数阈值 (默认 ${EXTERNAL_WATCHDOG_DEFAULTS.driftRepeat})
  --drift-rounds <n>     空转轮次阈值 (默认 ${EXTERNAL_WATCHDOG_DEFAULTS.driftRounds})
  --timeout-ms <n>       单请求超时 (默认 ${EXTERNAL_WATCHDOG_DEFAULTS.timeoutMs})
  --json                 输出 JSON
  --quiet                只输出异常/接管结果
  --help                 显示本帮助`;

function parseArgs(argv) {
  const out = {
    url: null, token: null, watch: false, interval: 60, act: null,
    maxActions: EXTERNAL_WATCHDOG_DEFAULTS.maxActions,
    stallMinutes: EXTERNAL_WATCHDOG_DEFAULTS.stallMinutes,
    driftRepeat: EXTERNAL_WATCHDOG_DEFAULTS.driftRepeat,
    driftRounds: EXTERNAL_WATCHDOG_DEFAULTS.driftRounds,
    timeoutMs: EXTERNAL_WATCHDOG_DEFAULTS.timeoutMs,
    json: false, quiet: false, help: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    const val = () => {
      const v = argv[i + 1];
      if (v == null || v.startsWith("--")) throw new Error(`${a} 缺少取值`);
      i += 1;
      return v;
    };
    const num = () => {
      const n = Number(val());
      if (!Number.isFinite(n)) throw new Error(`${a} 需要数字`);
      return n;
    };
    switch (a) {
      case "--url": out.url = val(); break;
      case "--token": out.token = val(); break;
      case "--watch": out.watch = true; break;
      case "--interval": out.interval = num(); break;
      case "--act": out.act = val(); break;
      case "--max-actions": out.maxActions = num(); break;
      case "--stall-minutes": out.stallMinutes = num(); break;
      case "--drift-repeat": out.driftRepeat = num(); break;
      case "--drift-rounds": out.driftRounds = num(); break;
      case "--timeout-ms": out.timeoutMs = num(); break;
      case "--json": out.json = true; break;
      case "--quiet": out.quiet = true; break;
      case "--help": case "-h": out.help = true; break;
      default: throw new Error(`未知参数: ${a}`);
    }
  }
  return out;
}

function renderHuman(r) {
  const lines = [];
  const head = `${r.level === "ok" ? "OK" : r.level.toUpperCase()} 在跑 ${r.counts.working} / 等待 ${r.counts.waiting}`;
  lines.push(`[external-watchdog] ${new Date(r.ts || Date.now()).toISOString()} ${head}`);
  for (const t of r.stalled) {
    lines.push(`  停滞≥${r.thresholds.stallMinutes}min: ${t.id} (闲置 ${t.idleMin}min${t.text ? `: ${t.text}` : ""})`);
  }
  for (const d of r.drifting) {
    lines.push(`  漂移: ${d.id} (${d.worker || "worker"}: ${d.kind}/${d.detail})`);
  }
  for (const a of r.actions) {
    lines.push(`  接管: 取消 ${a.id} (${a.kind}) → ${a.ok ? "ok" : `失败: ${a.error || `HTTP ${a.status}`}`}`);
  }
  return lines.join("\n");
}

async function runOnce(wd, opts) {
  const report = await wd.pollOnce({
    act: opts.act === "cancel",
    maxActions: opts.maxActions,
    stallMinutes: opts.stallMinutes,
    driftRepeat: opts.driftRepeat,
    driftRounds: opts.driftRounds,
  });
  if (!report.ok) {
    console.error(`[external-watchdog] 巡检失败 (HTTP ${report.status || "?"}): ${report.error}`);
    return 2;
  }
  if (opts.json) {
    console.log(JSON.stringify(report, null, 2));
  } else if (!opts.quiet || report.level !== "ok" || report.actions.length) {
    console.log(renderHuman(report));
  }
  if (report.actions.some((a) => !a.ok)) return 2;
  return report.level === "ok" ? 0 : 1;
}

async function main() {
  let opts;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (e) {
    console.error(`[external-watchdog] ${e.message}\n\n${USAGE}`);
    return 2;
  }
  if (opts.help) { console.log(USAGE); return 0; }
  if (opts.act && opts.act !== "cancel") {
    console.error(`[external-watchdog] 不支持的 --act: ${opts.act} (目前仅支持 cancel)`);
    return 2;
  }
  const baseUrl = opts.url || process.env.PPX_BASE_URL || "http://127.0.0.1:8899";
  const token = opts.token || process.env.PPX_AUTH_TOKEN || null;
  let wd;
  try {
    wd = createExternalWatchdog({ baseUrl, token, timeoutMs: opts.timeoutMs });
  } catch (e) {
    console.error(`[external-watchdog] ${e.message}`);
    return 2;
  }
  if (!opts.watch) return runOnce(wd, opts);

  const everyMs = Math.max(5, Math.trunc(Number(opts.interval) || 60)) * 1000;
  let stopped = false;
  const stop = () => { stopped = true; };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  console.log(`[external-watchdog] 常驻巡检 ${baseUrl} 每 ${everyMs / 1000}s (act=${opts.act || "off"})`);
  while (!stopped) {
    try {
      const code = await runOnce(wd, opts);
      if (code === 2) console.error("[external-watchdog] 本轮失败, 下一轮重试");
    } catch (e) {
      console.error(`[external-watchdog] 巡检异常: ${e?.message || e}`);
    }
    if (stopped) break;
    // 常驻模式的等待定时器不能 unref: 否则没有其它句柄时进程会在等待中直接退出。
    await new Promise((resolve) => setTimeout(resolve, everyMs));
  }
  return 0;
}

process.exitCode = await main();

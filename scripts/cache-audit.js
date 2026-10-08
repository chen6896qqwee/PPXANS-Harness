#!/usr/bin/env node
// scripts/cache-audit.js - Provider 前缀缓存完整性审计 (离线, 零依赖, 零真实 LLM 调用)
//
// 这个仓库把 system prompt 重排成"静态块在前, 随 userMsg 的检索段在后", 目的是吃到 provider
// 侧的 prompt caching。但 provider 只匹配**最长公共前缀**: 静态区里混进一个时间戳 / 每会话 id /
// 随机值 / 绝对临时路径 / 向上漂移的记忆检索文本, 缓存收益就对之后每一个请求悄悄失效 ——
// 而 CI 里原本没有任何信号能发现它。
//
// 本脚本构建真实 agent + 捕获桩客户端 (scripts/bench.js 的 stubLLM 同族模式), 驱动一次脚本化
// 多轮会话 (3 轮, 含一次真实工具往返), 拿到 ≥3 个真实出户请求载荷, 按 provider 视角序列化为
// "tools 数组 → system 消息 → 会话消息", 逐相邻请求算字符级最长公共前缀 (LCP) 并给出首个分歧
// 点与归因 (哪个区/哪个区块/第几条消息; 预期=历史尾部追加或检索段, 回归=静态前缀内分叉),
// 再断言四条命名不变量:
//   (a) static_prefix_stability  静态前缀逐字节稳定
//   (b) volatile_isolation       静态边界之前无易变值 (模式扫描 + 会话内 diff + 双实例 diff)
//   (c) tool_array_canonicality  tools 数组序列化跨请求/跨实例恒定 (并观测是否名称规范序)
//   (d) append_only_history      历史只追加不改写
//
// 网络硬隔离: agent.llm / agent.allProviders 被整体替换为捕获桩 (仓库 config 里若配了真实
// provider 也一并换掉), agent.evolve.enabled=false, agent.auxLLM=null; dataDir 恒为系统临时目录
// 下的 mkdtemp, 清理走 scripts/lib/tmp-agent.js 的安全护栏 cleanupTmp (不在安全区则抛错绝不删)。
//
// 用法:
//   node scripts/cache-audit.js                人读输出 (请求对 LCP + 检查清单 + 经济学)
//   node scripts/cache-audit.js --check        同上, 显式闸门语义 (CI 用)
//   node scripts/cache-audit.js --json         stdout 只输出一份 JSON 文档
//   node scripts/cache-audit.js --verbose      额外打印每个分歧点两侧字符上下文
//   node scripts/cache-audit.js --verbose=40   分歧上下文窗口宽度 (默认每侧 80)
//   node scripts/cache-audit.js --fixture=NAME 刻意注入回归 (只 monkey-patch 实例, 绝不动 src/)
//                                              NAME: volatile-clock | static-drift
// 退出码: 0 = 全部通过; 1 = 存在回归 (FAIL) 或审计跑不起来; 2 = 用法错误。
// 不带参数时也按闸门退出 —— 这个脚本的用途就是门, --check 只是把意图写明白。

import {
  PROJECT_ROOT,
  runFullAudit,
  describeOffset,
  FIXTURES,
} from "./lib/cache-audit-core.js";

const AWS_TIERS = [512, 1024, 4096]; // Bedrock 可缓存 checkpoint 档位 (5 分钟 / 1 小时 TTL)

// ---------------- 参数解析 ----------------
function parseArgs(argv) {
  const o = { check: false, json: false, verbose: false, window: 80, fixture: null, help: false };
  for (const a of argv) {
    if (a === "--check" || a === "-c") o.check = true;
    else if (a === "--json" || a === "-j") o.json = true;
    else if (a === "--verbose" || a === "-v") o.verbose = true;
    else if (/^--verbose=\d+$/.test(a)) {
      o.verbose = true;
      const n = Number(a.split("=")[1]);
      o.window = Math.max(8, Math.min(2000, n));
    } else if (/^--fixture=[\w-]+$/.test(a)) o.fixture = a.slice("--fixture=".length);
    else if (a === "--fixture") o.fixture = "__missing__";
    else if (a === "--help" || a === "-h") o.help = true;
    else { o.error = o.error || "未知参数: " + a; }
  }
  if (o.fixture !== null && !Object.prototype.hasOwnProperty.call(FIXTURES, o.fixture)) {
    o.error = o.error || "--fixture 取值必须是 " + Object.keys(FIXTURES).join(" | ") + " (收到: " + o.fixture + ")";
  }
  return o;
}

const args = parseArgs(process.argv.slice(2));
if (args.help) {
  console.log("用法: node scripts/cache-audit.js [--check] [--json] [--verbose[=N]] [--fixture="
    + Object.keys(FIXTURES).join("|") + "]\n"
    + "退出码: 0 全通过 / 1 存在回归 / 2 用法错误。离线运行, 不产生任何真实 LLM 调用。");
  process.exitCode = 0;
} else if (args.error) {
  console.error("✗ " + args.error);
  process.exitCode = 2;
} else {
  await main(args);
}

// ---------------- 主流程 ----------------
async function main(args) {
  let result;
  try {
    result = await runFullAudit({
      fixture: args.fixture ? FIXTURES[args.fixture] : null,
      projectRoot: PROJECT_ROOT,
      keepCaptures: args.verbose,
    });
  } catch (e) {
    console.error("✗ 审计无法完成 (会话捕获失败): " + (e && e.stack ? e.stack : e));
    process.exitCode = 1;
    return;
  }

  const { checks, metrics } = result;
  const failed = checks.filter((c) => !c.pass && !c.warn);
  const warned = checks.filter((c) => c.warn);
  const ok = failed.length === 0;

  if (args.json) {
    // stdout 只放一份 JSON 文档 (captureSession 已把日志降到 error, info 不再串流)
    console.log(JSON.stringify({
      ok,
      exitCode: ok ? 0 : 1,
      fixture: args.fixture || null,
      offline: true,
      projectRoot: PROJECT_ROOT,
      captures: metrics.captures,
      run2Captures: result.run2Captures,
      checks: checks.map((c) => ({
        id: c.id,
        name: c.name,
        result: c.warn ? "WARN" : c.pass ? "PASS" : "FAIL",
        pass: Boolean(c.pass),
        detail: c.detail,
        ...(c.order ? { toolOrder: c.order, toolOrderCanonicalByName: c.canonicalByName } : {}),
        ...(c.mismatches && c.mismatches.length ? { mismatches: c.mismatches } : {}),
        ...(c.subs ? { subs: c.subs } : {}),
        ...(c.scopeNote ? { scopeNote: c.scopeNote } : {}),
      })),
      metrics,
      verdict: metrics.verdict,
    }));
    process.exitCode = ok ? 0 : 1;
    return;
  }

  console.log("=== Provider 前缀缓存完整性审计 (离线 · 捕获桩 · 零真实调用) ===");
  console.log("  工作根: " + PROJECT_ROOT);
  console.log("  会话: 主实例 " + metrics.captures + " 个出户请求载荷; 第二独立实例 "
    + result.run2Captures + " 个 (跨实例 diff)");
  if (args.fixture) console.log("  夹具: " + args.fixture + " (刻意注入的回归演示, 仅 monkey-patch 实例)");

  console.log("\n--- 相邻请求对: 最长公共前缀与首个分歧点 ---");
  if (!metrics.pairs.length) console.log("  (无可比较的请求对 —— 捕获不足, 检查 (a) 会失败)");
  for (const p of metrics.pairs) {
    console.log("  req" + p.from + "→req" + p.to + (p.turnBoundary ? " [跨轮]" : " [轮内]")
      + "  LCP=" + p.lcpChars + " 字符/≈" + p.lcpTokens + " tok"
      + "  此后重计费=" + p.tailChars + " 字符/≈" + p.tailTokens + " tok"
      + "  分歧=" + p.region + " @" + p.offset + " " + (p.expected ? "[预期]" : "[回归]"));
    console.log("      " + p.reason);
  }

  console.log("\n--- 检查清单 (每条一行机器可读) ---");
  for (const c of checks) {
    console.log("CHECK " + c.id + " " + (c.warn ? "WARN" : c.pass ? "PASS" : "FAIL") + " " + c.detail);
  }

  console.log("\n--- 前缀经济学: 可缓存稳定前缀 vs 每请求重计费 ---");
  const row = (label, chars, tok) => console.log("  " + label.padEnd(28)
    + String(chars).padStart(8) + " 字符   ≈" + String(tok).padStart(6) + " tok");
  row("tools 数组", metrics.toolsChars, metrics.toolsTokens);
  row("system 静态区", metrics.staticChars, metrics.staticTokens);
  row("稳定前缀 (跨轮最小 LCP)", metrics.stablePrefixChars, metrics.stablePrefixTokens);
  row("每请求重计费尾部 (均值)", metrics.rebilledTailCharsAvg, metrics.rebilledTailTokensAvg);
  console.log("  参照: cached 输入通常便宜约一个数量级 (如 Manus 0.3 vs 3 USD/MTok); AWS Bedrock 可缓存"
    + " checkpoint 档位 " + AWS_TIERS.join("/") + " tok, TTL 5 分钟 / 1 小时");
  console.log("  判定: " + metrics.verdict);

  if (args.verbose) printDivergenceContexts(result, args.window);

  console.log("\n--- 结论 ---");
  console.log("  " + (ok
    ? "✓ " + (checks.length - warned.length) + " 项检查全部通过"
      + (warned.length ? " (" + warned.map((w) => w.id).join(", ") + " 为观测项 WARN, 不计失败)" : "")
    : "✗ " + failed.length + " 项回归: " + failed.map((c) => c.id).join(", ")));
  process.exitCode = ok ? 0 : 1;
}

// --verbose: 打印每个分歧点两侧字符上下文, 让"缓存前缀在第几个字节断掉"能直接看到字面差异。
function printDivergenceContexts(result, W) {
  const caps = result.capturesDetail;
  if (!caps || !caps.length) return;
  console.log("\n--- 分歧点上下文 (--verbose, 每侧 " + W + " 字符) ---");
  for (const p of result.metrics.pairs) {
    const prev = caps[p.from], next = caps[p.to];
    if (!prev || !next) continue;
    const off = p.lcpChars;
    const a = prev.serialized.text;
    const b = next.serialized.text;
    const from = Math.max(0, off - W);
    const desc = describeOffset(prev.serialized, off, prev.boundary);
    console.log("  req" + p.from + "→req" + p.to + ": 首个分歧字节 @" + off + " → " + desc.label
      + (prev.boundary.ok ? " (req" + p.from + " 静态边界=" + prev.boundary.staticEnd + ") " : " ")
      + (p.expected ? "[预期]" : "[回归]") + " " + p.reason);
    console.log("    共享前缀尾: " + JSON.stringify(a.slice(from, off)));
    console.log("    A 分歧处: " + JSON.stringify(a.slice(off, off + W)) + (a.length > off + W ? " …" : " (A 止于此)"));
    console.log("    B 分歧处: " + JSON.stringify(b.slice(off, off + W)) + (b.length > off + W ? " …" : " (B 止于此)"));
  }
}

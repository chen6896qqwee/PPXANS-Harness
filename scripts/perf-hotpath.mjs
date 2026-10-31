#!/usr/bin/env node
// scripts/perf-hotpath.mjs - 热路径微基准 (零依赖 / 不联网 / 不碰真实 dataDir)
//
// 目的: 给「单轮对话内核开销」做可重复的测量, 用于优化前后对比 (docs/bench/*.json + docs/ARCHITECTURE-CURRENT.md)。
//
// 测什么 (每项 N 次采样取均值/中位数, N 默认 20):
//   1. import src/agent/index.js 一次性加载耗时 (含整条依赖图, 与 construct 分开报告)
//   2. new PPXAgent() 构造耗时
//   3. agent.chat() 单轮内核开销 (stub LLM: chat/apiChat 直接返回固定文本, 无网络)
//   4. skills.list() 单次耗时 + readdir/stat 调用次数
//   5. sessionStore.append() ×2 + flush() 耗时
//   6. memory.recordTurn() 单次耗时
//   7. 上述场景各自的文件 I/O 次数 (按 fs op 分类, 用 fs 计数器包裹统计)
//
// 隔离与安全:
//   - root = 仓库根 (技能/插件/配置按生产语义装配), dataDir/globalDataDir = fs.mkdtempSync 临时目录。
//   - 临时根只允许落在 os.tmpdir(); 收尾经 scripts/lib/tmp-agent.js 的 cleanupTmp 安全护栏删除
//     (路径不在安全区 → 抛错绝不删), 且先 await agent.shutdown() 释放句柄。
//   - LLM 全部换成 stub (agent.llm / agent.allProviders / agent.auxLLM), 不发任何网络请求。
//
// 用法:
//   node scripts/perf-hotpath.mjs              人读表格
//   node scripts/perf-hotpath.mjs --json       只输出一份 JSON (便于存档/前后对比)
//   node scripts/perf-hotpath.mjs --repeat=3   整套重复 3 轮, 每项取"最好那轮"的均值 (默认 1)
//
// 退出码恒 0: 这是测量工具, 不是闸门 (任何情况都不因阈值失败)。测量异常会写进输出并尽量继续。
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SCRIPT_DIR, "..");
const SCRIPT_VERSION = "hotpath-v1";

// ---------------- 参数 ----------------
const ARGV = process.argv.slice(2);
const hasFlag = (n) => ARGV.some((a) => a === `--${n}`);
const optNum = (n, dflt) => {
  const hit = ARGV.find((a) => a.startsWith(`--${n}=`));
  if (!hit) return dflt;
  const v = Number(hit.slice(n.length + 3));
  return Number.isFinite(v) ? v : dflt;
};
const JSON_OUT = hasFlag("json");
const VERBOSE = hasFlag("verbose") || process.env.PPX_PERF_VERBOSE === "1";
const REPEAT = Math.max(1, Math.min(10, Math.floor(optNum("repeat", 1))));
// 采样数: 任务要求 N>=20; 允许 --rounds 微调但下限 10 (再低就没有统计意义)
const N = Math.max(10, Math.floor(optNum("rounds", 20)));

// ---------------- 计时 / 统计 ----------------
const nowMs = () => Number(process.hrtime.bigint()) / 1e6;
const r3 = (x) => Math.round(x * 1000) / 1000;

function stats(samples) {
  const s = (Array.isArray(samples) ? samples : []).filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
  const n = s.length;
  if (!n) return { n: 0, mean: null, median: null, min: null, p95: null, max: null };
  const mean = s.reduce((a, b) => a + b, 0) / n;
  const median = n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2;
  const p95 = s[Math.min(n - 1, Math.ceil(0.95 * n) - 1)];
  return {
    n,
    mean: r3(mean), median: r3(median), min: r3(s[0]), p95: r3(p95), max: r3(s[n - 1]),
    samples: s.map(r3),
  };
}

// ---------------- fs 调用计数器 ----------------
// 关键前提: 热路径模块全部用 `import fs from "node:fs"` (默认导入 = 同一个 CJS 导出对象),
// 所以在该对象上包一层即可统计到真实调用。只统计热路径用到的文件操作, 不含网络/进程。
const FS_SYNC_OPS = [
  "accessSync", "appendFileSync", "chmodSync", "closeSync", "copyFileSync", "cpSync", "existsSync",
  "fstatSync", "ftruncateSync", "lstatSync", "mkdirSync", "openSync", "readdirSync", "readFileSync",
  "readSync", "realpathSync", "renameSync", "rmSync", "rmdirSync", "statSync", "truncateSync",
  "unlinkSync", "utimesSync", "writeFileSync", "writeSync", "opendirSync",
];
const FS_CB_OPS = [
  "access", "appendFile", "chmod", "close", "copyFile", "cp", "exists", "fstat", "lstat", "mkdir",
  "open", "opendir", "readdir", "read", "readFile", "realpath", "rename", "rm", "stat", "truncate",
  "unlink", "utimes", "write", "writeFile",
];
const FS_PROMISE_OPS = [
  "access", "appendFile", "chmod", "copyFile", "cp", "lstat", "mkdir", "open", "opendir", "readdir",
  "readFile", "realpath", "rename", "rm", "stat", "truncate", "unlink", "writeFile",
];
const COUNTER = { on: false, counts: Object.create(null) };
function installFsCounter() {
  const wrap = (obj, names, prefix) => {
    for (const name of names) {
      const orig = obj[name];
      if (typeof orig !== "function") continue;
      const key = prefix + name;
      obj[name] = function (...args) {
        if (COUNTER.on) COUNTER.counts[key] = (COUNTER.counts[key] || 0) + 1;
        return orig.apply(obj, args);
      };
    }
  };
  wrap(fs, FS_SYNC_OPS, "");
  wrap(fs, FS_CB_OPS, "");
  if (fs.promises) wrap(fs.promises, FS_PROMISE_OPS, "promises.");
}
function opsReset() { COUNTER.counts = Object.create(null); }
function opsStart() { opsReset(); COUNTER.on = true; }
function opsStop() {
  COUNTER.on = false;
  const out = Object.create(null);
  for (const k of Object.keys(COUNTER.counts).sort()) if (COUNTER.counts[k] > 0) out[k] = COUNTER.counts[k];
  return out;
}
function opsAdd(acc, one) {
  for (const [k, v] of Object.entries(one || {})) acc[k] = (acc[k] || 0) + v;
  return acc;
}
function opsScale(obj, divisor) {
  const out = Object.create(null);
  for (const k of Object.keys(obj).sort()) out[k] = r3(obj[k] / divisor);
  return out;
}

// ---------------- 内核日志抑制 ----------------
// agent 构造/运行会经 src/utils/logger.js 打 console.log/warn (如未配云端 key 的引导提示)。
// 这些行会污染 --json 的 stdout, 所以全程捕获、最后按模式处理 (JSON 模式转 stderr 尾部)。
const CAPTURED = [];
let _origConsole = null;
function muteConsole() {
  if (_origConsole) return;
  _origConsole = { log: console.log, info: console.info, warn: console.warn, error: console.error };
  const cap = (level) => (...a) => {
    if (CAPTURED.length < 200) CAPTURED.push(`[${level}] ${a.map((x) => (typeof x === "string" ? x : safeStr(x))).join(" ")}`);
  };
  console.log = cap("log");
  console.info = cap("info");
  console.warn = cap("warn");
  console.error = cap("error");
}
function unmuteConsole() {
  if (!_origConsole) return;
  console.log = _origConsole.log;
  console.info = _origConsole.info;
  console.warn = _origConsole.warn;
  console.error = _origConsole.error;
  _origConsole = null;
}
function safeStr(v) {
  try { return typeof v === "string" ? v : JSON.stringify(v); } catch { return String(v); }
}

// ---------------- stub LLM (零网络) ----------------
function makeStubLLM(reply = "[stub] 收到。") {
  const stub = {
    providerId: "perf-stub",
    backend: "stub",              // 非 "http" → 视觉/多模态路径原样返回字符串, 不发请求
    model: "ppx-perf-stub",
    vision: false,
    supportsNativeToolCalls: true,
    supportsStream: false,
    calls: 0,                     // 自证: 本轮所有模型调用都落在 stub 上
    health: async () => true,
    chat: async () => { stub.calls += 1; return { content: reply }; },
    streamChat: async (_m, { onDelta } = {}) => { stub.calls += 1; onDelta?.(reply); return reply; },
    apiChat: async () => { stub.calls += 1; return { message: { role: "assistant", content: reply, tool_calls: null } }; },
  };
  return stub;
}

// 把 agent 的模型面全部钉到 stub 上 (llm + 回退链 allProviders + 辅助 llm),
// 否则 config/ppx.json 里 enabled 的真实 provider 会被 _llmWithFallback 选中 → 联网。
function pinStub(agent, reply) {
  const stub = makeStubLLM(reply);
  agent.llm = stub;
  agent.allProviders = [stub];
  agent.auxLLM = null;
  return stub;
}

// ---------------- 临时数据目录 (安全护栏) ----------------
function mkTmpRoot(prefix = "ppx-perf-hotpath-") {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

// ---------------- 单项测量 ----------------
async function measureConstruct({ PPXAgent, runDir, n }) {
  const samples = [];
  for (let i = 0; i < n; i++) {
    const dataDir = path.join(runDir, "construct", `c${i}`, "data");
    fs.mkdirSync(dataDir, { recursive: true });
    const t0 = nowMs();
    const agent = new PPXAgent({ root: REPO_ROOT, dataDir, globalDataDir: dataDir });
    samples.push(nowMs() - t0);
    try { await agent.shutdown(); } catch { /* 清理失败不影响测量 */ }
  }
  return samples;
}

async function measureChat({ agent, n }) {
  const sk = "perf-chat";
  // 预热 1 轮: 首次会走 SessionStart 钩子/画像刷新等一次性路径, 不计入稳态
  await agent.chat("基准预热轮: 请一句话回复", { sessionKey: sk });
  const samples = [];
  const opsPerRound = Object.create(null);
  let failures = 0;
  let lastReply = "";
  for (let i = 0; i < n; i++) {
    opsStart();
    const t0 = nowMs();
    let reply = "";
    try {
      reply = await agent.chat(`基准第 ${i + 1} 轮: 请一句话回复`, { sessionKey: sk });
    } catch (e) {
      failures += 1;
      CHAT_FAILURES.push(String(e && e.message ? e.message : e));
    }
    const dt = nowMs() - t0;
    const one = opsStop();
    opsAdd(opsPerRound, one);
    samples.push(dt);
    lastReply = reply;
  }
  return { samples, ops: opsScale(opsPerRound, n), failures, lastReply };
}

async function measureSkillsList({ agent, n }) {
  const loader = agent.skills;
  if (!loader || typeof loader.list !== "function") return { samples: [], ops: {}, errors: ["agent.skills 未装配"] };
  // 预热 5 次: 首次 _sigOf 各文件 stat 会填 _cache, 但 _scan 每次仍全量 → 稳态即首轮
  for (let i = 0; i < 5; i++) loader.list();
  const samples = [];
  const opsPerCall = Object.create(null);
  let lastCount = 0;
  for (let i = 0; i < n; i++) {
    opsStart();
    const t0 = nowMs();
    let list = [];
    try { list = loader.list(); } catch (e) { CHAT_FAILURES.push(`skills.list: ${e.message}`); }
    samples.push(nowMs() - t0);
    opsAdd(opsPerCall, opsStop());
    lastCount = Array.isArray(list) ? list.length : 0;
  }
  return { samples, ops: opsScale(opsPerCall, n), skillCount: lastCount, errors: [] };
}

async function measureAppendFlush({ agent, n, key }) {
  const store = agent.sessionStore;
  if (!store || typeof store.append !== "function") return { samples: [], ops: {}, errors: ["sessionStore 未装配"] };
  const samples = [];
  const opsPerTrio = Object.create(null);
  for (let i = 0; i < n; i++) {
    opsStart();
    const t0 = nowMs();
    try {
      store.append(key, "user/message", { content: `append 基准 ${i}`, role: "user" }, undefined, { skipFlush: true });
      store.append(key, "assistant/message", { content: "[stub] 收到。", role: "assistant" }, undefined, { skipFlush: true });
      store.flush(key);
    } catch (e) { CHAT_FAILURES.push(`append/flush: ${e.message}`); }
    samples.push(nowMs() - t0);
    opsAdd(opsPerTrio, opsStop());
  }
  return { samples, ops: opsScale(opsPerTrio, n), errors: [] };
}

async function measureRecordTurn({ agent, n }) {
  const mem = agent.memory;
  if (!mem || typeof mem.recordTurn !== "function") return { samples: [], ops: {}, errors: ["memory.recordTurn 未装配"] };
  const samples = [];
  const opsPerCall = Object.create(null);
  for (let i = 0; i < n; i++) {
    opsStart();
    const t0 = nowMs();
    try {
      await mem.recordTurn(`recordTurn 基准问题 ${i}`, `[stub] 收到。(${i})`, { drafts: [], evidence: [], sessionKey: "perf-memory" });
    } catch (e) { CHAT_FAILURES.push(`recordTurn: ${e.message}`); }
    samples.push(nowMs() - t0);
    opsAdd(opsPerCall, opsStop());
  }
  return { samples, ops: opsScale(opsPerCall, n), errors: [] };
}

// ---------------- 一轮完整测量 ----------------
const CHAT_FAILURES = [];

async function runOnce({ PPXAgent, runDir, repIndex }) {
  const dir = path.join(runDir, `r${repIndex}`);
  fs.mkdirSync(dir, { recursive: true });
  const result = { repeat: repIndex + 1 };

  // 1) 构造
  result.construct = { samples: await measureConstruct({ PPXAgent, runDir: dir, n: N }) };

  // 构造"主"agent 用于 chat/skills/append/recordTurn (与构造基准同样的 tmp dataDir)
  const dataDir = path.join(dir, "main", "data");
  fs.mkdirSync(dataDir, { recursive: true });
  const tConstruct = nowMs();
  const agent = new PPXAgent({ root: REPO_ROOT, dataDir, globalDataDir: dataDir });
  result.construct_main_ms = r3(nowMs() - tConstruct);
  const stub = pinStub(agent, "[stub] 收到。");

  try {
    // 2) chat 单轮
    const chat = await measureChat({ agent, n: N });
    result.chat = { samples: chat.samples, ops: chat.ops, failures: chat.failures, last_reply: chat.lastReply };

    // 3) skills.list
    result.skills = await measureSkillsList({ agent, n: N });

    // 4) session append ×2 + flush
    result.append_flush = await measureAppendFlush({ agent, n: N, key: `perf-append-r${repIndex}` });

    // 5) memory.recordTurn
    result.record_turn = await measureRecordTurn({ agent, n: N });

    result.stub_calls = stub.calls; // 自证全部模型调用落在 stub (零网络)
  } finally {
    try { await agent.shutdown(); } catch { /* 清理失败不阻断 */ }
  }
  return result;
}

// 多轮重复: 每项指标取"均值最低那一轮" (任务要求: 重复 N 轮取最好值)
const METRIC_KEYS = ["construct", "chat", "skills", "append_flush", "record_turn"];
function pickBest(perRepeat) {
  const merged = {};
  for (const key of METRIC_KEYS) {
    let best = null;
    let bestMean = Infinity;
    for (const one of perRepeat) {
      const bucket = one[key];
      if (!bucket || !bucket.samples || !bucket.samples.length) continue;
      const st = stats(bucket.samples);
      if (st.mean !== null && st.mean < bestMean) { bestMean = st.mean; best = { bucket, st, repeat: one.repeat }; }
    }
    if (!best) { merged[key] = { stats: stats([]), ops: {}, source: null }; continue; }
    merged[key] = {
      stats: best.st,
      ops: best.bucket.ops || {},
      source: { repeat: best.repeat },
      extra: {
        ...(key === "skills" ? { skill_count: best.bucket.skillCount ?? null } : {}),
        ...(key === "chat" ? { failures: best.bucket.failures ?? 0 } : {}),
      },
    };
  }
  return merged;
}

// ---------------- 展示 ----------------
function dw(s) {
  let w = 0;
  for (const ch of String(s)) {
    const c = ch.codePointAt(0);
    const wide = (c >= 0x1100 && c <= 0x115f) || (c >= 0x2e80 && c <= 0xa4cf) ||
      (c >= 0xac00 && c <= 0xd7a3) || (c >= 0xf900 && c <= 0xfaff) ||
      (c >= 0xfe30 && c <= 0xfe4f) || (c >= 0xff00 && c <= 0xff60) || (c >= 0xffe0 && c <= 0xffe6);
    w += wide ? 2 : 1;
  }
  return w;
}
const padR = (s, w) => String(s) + " ".repeat(Math.max(0, w - dw(String(s))));
const padL = (s, w) => " ".repeat(Math.max(0, w - dw(String(s)))) + String(s);

const METRIC_ROWS = [
  { key: "construct", label: "agent 构造 (new PPXAgent, 临时 dataDir)" },
  { key: "chat", label: "agent.chat 单轮 (stub LLM, 含落盘/记忆)" },
  { key: "skills", label: "skills.list() 单次" },
  { key: "append_flush", label: "sessionStore.append×2 + flush()" },
  { key: "record_turn", label: "memory.recordTurn() 单次" },
];

const SCENARIO_LABELS = {
  chat: "chat 单轮 (均值/轮)",
  skills: "skills.list 单次 (均值)",
  append_flush: "append×2+flush (均值/次)",
  record_turn: "recordTurn 单次 (均值)",
};

function humanText(payload) {
  const lines = [];
  const m = payload.meta;
  lines.push("PPXANS-Harness 热路径微基准 " + SCRIPT_VERSION);
  lines.push(`  node ${m.node} | ${m.platform}/${m.arch} | cpu ${m.cpu_model} ×${m.cpu_count} | ${m.generated_at}`);
  lines.push(`  采样 N=${payload.params.rounds} × repeat=${payload.params.repeat} | root=${m.repo} | dataDir=mkdtemp`);
  lines.push("");
  const cols = [["指标", 42], ["样本", 6], ["平均(ms)", 10], ["中位(ms)", 10], ["最小(ms)", 10], ["p95(ms)", 10], ["最大(ms)", 10]];
  lines.push(cols.map(([t, w]) => padR(t, w)).join(""));
  lines.push("-".repeat(cols.reduce((a, [, w]) => a + w, 0)));
  for (const row of METRIC_ROWS) {
    const st = payload.metrics[row.key].stats;
    const cell = (v) => (v === null || v === undefined ? "—" : String(v));
    lines.push(
      padR(row.label, 42) + padL(cell(st.n), 6) + padL(cell(st.mean), 10) + padL(cell(st.median), 10) +
      padL(cell(st.min), 10) + padL(cell(st.p95), 10) + padL(cell(st.max), 10)
    );
  }
  if (payload.import_agent_index_ms !== null && payload.import_agent_index_ms !== undefined) {
    lines.push("");
    lines.push(`import src/agent/index.js (一次性, 含依赖图): ${payload.import_agent_index_ms} ms`);
  }
  lines.push("");
  lines.push("文件 I/O 次数 (按 fs op 分类)");
  lines.push("-".repeat(96));
  for (const key of ["chat", "skills", "append_flush", "record_turn"]) {
    const ops = payload.metrics[key].ops || {};
    const txt = Object.keys(ops).length
      ? Object.entries(ops).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}×${v}`).join("  ")
      : "(无)";
    lines.push(padR(SCENARIO_LABELS[key], 30) + txt);
  }
  const extra = [];
  if (payload.metrics.skills.extra && payload.metrics.skills.extra.skill_count !== undefined) {
    extra.push(`技能数: ${payload.metrics.skills.extra.skill_count}`);
  }
  extra.push(`stub 模型调用: ${payload.stub_calls} 次 (零网络自证)`);
  if (payload.errors && payload.errors.length) extra.push(`异常: ${payload.errors.length} 条 (见 JSON)`);
  lines.push("");
  lines.push(extra.join(" | "));
  lines.push("");
  lines.push("退出码恒 0 (测量工具, 不是闸门)。--json 输出可直接存档对比。");
  return lines.join("\n");
}

// ---------------- main ----------------
async function main() {
  const generatedAt = new Date();
  const pkg = (() => {
    try { return JSON.parse(fs.readFileSync(path.join(REPO_ROOT, "package.json"), "utf8")); } catch { return {}; }
  })();
  const meta = {
    tool: "scripts/perf-hotpath.mjs",
    version: SCRIPT_VERSION,
    package: pkg.name || "ppxans-harness",
    package_version: pkg.version || null,
    generated_at: generatedAt.toISOString(),
    generated_at_local: generatedAt.toLocaleString("zh-CN", { hour12: false }),
    node: process.version,
    v8: process.versions.v8,
    platform: process.platform,
    arch: process.arch,
    cpu_model: (os.cpus()[0] || {}).model || "unknown",
    cpu_count: os.cpus().length,
    total_mem_gb: r3(os.totalmem() / 1024 ** 3),
    repo: REPO_ROOT,
    isolation: "dataDir/globalDataDir = fs.mkdtempSync(os.tmpdir()); root = 仓库根; 收尾经 cleanupTmp 安全护栏删除",
    stub_llm: "agent.llm / allProviders / auxLLM 全部替换为本地 stub (chat/apiChat 固定文本), 零网络",
    measure_note: "每项 N 次采样; repeat>1 时每项取均值最低那一轮; 单位 ms",
  };

  installFsCounter();
  const tmpRoot = mkTmpRoot();
  let PPXAgent = null;
  let importMs = null;
  const perRepeat = [];

  muteConsole();
  try {
    // 1) import 耗时 (一次性, 含整条依赖图)
    const tImport = nowMs();
    const mod = await import(pathToFileURL(path.join(REPO_ROOT, "src", "agent", "index.js")).href);
    importMs = r3(nowMs() - tImport);
    PPXAgent = mod.PPXAgent;
    if (typeof PPXAgent !== "function") throw new Error("src/agent/index.js 未导出 PPXAgent");

    // 2) N 轮整套测量
    for (let rep = 0; rep < REPEAT; rep++) perRepeat.push(await runOnce({ PPXAgent, runDir: tmpRoot, repIndex: rep }));
  } finally {
    unmuteConsole();
    // 安全清理: 先 shutdown 所有可能残留的 agent 句柄 (runOnce 内已 await), 再删临时根
    //   根不在 os.tmpdir() 内时 cleanupTmp 会抛错 (绝不误删), 这里吞掉异常并报告
    let cleanupOk = true;
    let cleanupErr = null;
    try {
      const lib = await import(pathToFileURL(path.join(REPO_ROOT, "scripts", "lib", "tmp-agent.js")).href);
      lib.cleanupTmp(tmpRoot, { quiet: true });
    } catch (e) {
      cleanupOk = false;
      cleanupErr = String(e && e.message ? e.message : e);
    }

    const merged = pickBest(perRepeat);
    const payload = {
      meta,
      params: { rounds: N, repeat: REPEAT },
      import_agent_index_ms: importMs,
      metrics: Object.fromEntries(METRIC_KEYS.map((k) => [k, {
        stats: merged[k].stats,
        ops: merged[k].ops,
        extra: merged[k].extra || {},
        best_repeat: merged[k].source ? merged[k].source.repeat : null,
      }])),
      stub_calls: perRepeat.reduce((a, r) => a + (r.stub_calls || 0), 0),
      errors: CHAT_FAILURES.slice(0, 20),
      isolation: { tmp_root_removed: cleanupOk, cleanup_error: cleanupErr },
      repeat_runs: perRepeat.map((r) => ({
        repeat: r.repeat,
        construct_main_ms: r.construct_main_ms,
        stub_calls: r.stub_calls,
        chat_failures: r.chat ? r.chat.failures : null,
        construct: stats(r.construct.samples),
        chat: stats(r.chat.samples),
        skills: stats(r.skills.samples),
        append_flush: stats(r.append_flush.samples),
        record_turn: stats(r.record_turn.samples),
      })),
      suppressed_log_lines: CAPTURED.length,
    };

    if (JSON_OUT) {
      if (CAPTURED.length) {
        process.stderr.write(`[perf-hotpath] 已抑制 ${CAPTURED.length} 行内核日志 (尾部 20 行):\n${CAPTURED.slice(-20).join("\n")}\n`);
      }
      await emit(JSON.stringify(payload, null, 2));
    } else {
      if (VERBOSE && CAPTURED.length) {
        process.stderr.write(`[perf-hotpath] 内核日志 ${CAPTURED.length} 行:\n${CAPTURED.join("\n")}\n`);
      }
      await emit(humanText(payload));
    }
  }
}

function emit(text) {
  return new Promise((resolve) => {
    const s = text.endsWith("\n") ? text : text + "\n";
    process.stdout.write(s, () => resolve());
  });
}

// 退出码恒 0: 测量工具不是闸门。测量过程抛错也输出一条可解析结果, 绝不因失败阻断流水线。
main().catch(async (e) => {
  unmuteConsole();
  const msg = String(e && e.stack ? e.stack : e);
  if (JSON_OUT) {
    await emit(JSON.stringify({
      meta: { tool: "scripts/perf-hotpath.mjs", version: SCRIPT_VERSION, generated_at: new Date().toISOString(), node: process.version },
      fatal_error: msg,
      note: "测量失败; 退出码仍为 0 (测量工具不是闸门)",
    }, null, 2));
  } else {
    process.stderr.write(`[perf-hotpath] 测量失败: ${msg}\n`);
  }
  process.exit(0);
}).then(() => process.exit(0));

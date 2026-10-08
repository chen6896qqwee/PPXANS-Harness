// test/tool-evidence-context.test.js - 工具证据进上下文 + 压缩保真 + 免模型确定性重置
// 病根 (2026-10-06 审计): context.js 三处"只认 user/assistant" = 结构性失忆:
//   _pushTurn 不落工具证据 -> _maybeCompact 的 tail 只认对话 -> deriveCompacted 也只认对话。
//   结果: 压缩后/重启后 agent 只记得说过什么, 不记得做过什么。
// 本文件每条测试对应一个闸门, 全程离线零 API: 桩 llm / 内存假游标 / 最多两个子进程都没有。
import test from "node:test";
import assert from "node:assert";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import { PPXAgent } from "../src/agent/index.js";
import { SessionStore, EVENTS } from "../src/memory/session.js";
import { runWithTrace } from "../src/core/trace.js";
import { estimateTokens } from "../src/utils/text.js";

function tmpRoot(n) { return fs.mkdtempSync(path.join(os.tmpdir(), `ppx-${n}-`)); }

// 一条大结果 (200KB) 用于验证"单条工具结果可达几百 KB"时窗口不炸
const HUGE = "HUGE-RESULT-MARKER src/utils/text.js\n" + "x".repeat(200 * 1024) + "\n结论: 共 42 处命中";
const EVIDENCE_MARK = "【工具证据】";

test("证据落盘: _pushTurn 把 tool/call + tool/result 写进会话日志且时序正确", () => {
  const root = tmpRoot("evpush");
  try {
    const a = new PPXAgent({ root });
    a._pushTurn("k", "帮我修 src/utils/text.js", "我先看一眼", [
      { tool: "read_file", callId: "c1", args: { path: "src/utils/text.js" }, ok: true, durationMs: 12, result: HUGE },
    ]);
    const evs = a.sessionStore.replay("k");
    const calls = evs.filter((e) => e.type === EVENTS.TOOL_CALL);
    const results = evs.filter((e) => e.type === EVENTS.TOOL_RESULT);
    assert.equal(calls.length, 1, "1 条 tool/call 事件");
    assert.equal(results.length, 1, "1 条 tool/result 事件");
    // 真实时序: user < call < result < assistant (先动手, 后说话)
    const seqOf = (t) => evs.find((e) => e.type === t).seq;
    assert.ok(seqOf(EVENTS.USER) < seqOf(EVENTS.TOOL_CALL), "user 在调用之前");
    assert.ok(seqOf(EVENTS.TOOL_CALL) < seqOf(EVENTS.TOOL_RESULT), "调用在回执之前");
    assert.ok(seqOf(EVENTS.TOOL_RESULT) < seqOf(EVENTS.ASSISTANT), "回执在最终回复之前");
    // 大结果在落盘时就被折叠, 日志不会被单条几百 KB 撑爆
    assert.ok(results[0].data.digest.length < 400, "结果摘要落盘即折叠");
    assert.ok(!results[0].data.digest.includes("undefined"), "摘要可读");
    a.shutdown();
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("证据落盘: 无证据时 _pushTurn 仍只写 2 条事件 (既有语义不变)", () => {
  const root = tmpRoot("evpush0");
  try {
    const a = new PPXAgent({ root });
    a._pushTurn("k", "问", "答");
    assert.equal(a.sessionStore.count("k"), 2, "2 条事件 (回归既有断言)");
    a.shutdown();
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("证据进投影: 工具证据在模型可见窗口里且 seq 单调", () => {
  const root = tmpRoot("evproj");
  try {
    const a = new PPXAgent({ root });
    a._pushTurn("k", "第一轮", "回一", [
      { tool: "write_file", callId: "a1", args: { path: "docs/note.md", content: "abc" }, ok: true, durationMs: 7, result: "wrote 3 bytes" },
    ]);
    a._pushTurn("k", "第二轮", "回二", [
      { tool: "run_command", callId: "a2", args: { command: "node --check docs/note.md" }, ok: false, result: "[error] 语法错误 line 1" },
    ]);
    const hist = a._getSession("k");
    const evLines = hist.filter((m) => String(m.content).startsWith("【工具证据】"));
    assert.equal(evLines.length, 2, "两条证据各合成一行进入窗口");
    assert.ok(evLines[0].content.includes("write_file") && evLines[0].content.includes("成功"), "成功回执可见");
    assert.ok(evLines[1].content.includes("run_command") && evLines[1].content.includes("失败"), "失败回执同样可见 (失忆最爱丢的就是失败)");
    assert.ok(evLines[0].content.includes("docs/note.md"), "入参里的路径是证据本体");
    // 证据与对话穿插, 整体次序仍是日志次序
    const units = a._contextUnits("k").items;
    const body = units.filter((u) => u.kind !== "summary").map((u) => u.seq);
    assert.deepEqual(body, [...body].sort((x, y) => x - y), "投影单元 seq 单调");
    a.shutdown();
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("证据预算: 大结果不撑爆窗口, 溢出折叠可见 (不静默丢弃)", () => {
  const root = tmpRoot("evbudget");
  try {
    const a = new PPXAgent({ root });
    for (let i = 0; i < 12; i++) {
      a._pushTurn("k", `第${i}轮 见 docs/plan${i}.md`, `回${i}`, [
        { tool: "read_file", callId: `c${i}`, args: { path: `docs/plan${i}.md` }, ok: true, durationMs: i, result: HUGE },
      ]);
    }
    const cap = a._renderUnits(a._contextUnits("k")).cap;
    const projected = a._projectMessages("k");
    const evText = projected.filter((m) => String(m.content).startsWith("【工具证据】")).map((m) => m.content).join("\n");
    assert.ok(estimateTokens(evText) <= cap + 60, `证据总预算 ${estimateTokens(evText)} <= ${cap} (+占位行)`);
    assert.ok(evText.includes("已按预算折叠"), "被折叠的证据有可见占位而不是静默消失");
    assert.ok(evText.includes("docs/plan11.md"), "最近的证据一定在");
    // 12 轮 x 200KB 结果: 证据在窗口里的实际占用必须远小于原文 (测量而非声称)
    const raw = 12 * HUGE.length;
    assert.ok(evText.length < raw / 200, `窗口证据 ${evText.length} 字符 << 原文 ${raw} 字符`);
    a.shutdown();
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("深历史承压: 40 轮 x 200KB 工具输出, 窗口 token 总量仍在既有预算内", () => {
  const root = tmpRoot("evdeep");
  try {
    const a = new PPXAgent({ root });
    for (let i = 0; i < 40; i++) {
      a._pushTurn("k", `第${i}轮 处理 docs/f${i}.md`, `回${i}`, [
        { tool: "read_file", callId: `d${i}`, args: { path: `docs/f${i}.md` }, ok: true, durationMs: i, result: HUGE },
      ]);
    }
    const rendered = a._renderUnits(a._contextUnits("k"));
    assert.ok(rendered.kept >= 1 && rendered.folded > 0, "投影层: 有留下也有折叠");
    const projEv = a._projectMessages("k").filter((m) => String(m.content).startsWith("【工具证据】"));
    assert.ok(projEv.some((m) => String(m.content).includes("按预算折叠")),
      "投影层恒定给出「折叠了多少条」的可见告知 (原文仍在日志)");
    const window = a._getSession("k"); // 真给模型的窗口 = 投影 + 信息量裁剪 + 硬兜底
    const items = Number(a.config.memory?.max_history_items) || 40;
    assert.ok(window.length <= items, `窗口条数 ${window.length} <= max_history_items ${items}`);
    const winTokens = window.reduce((s, m) => s + estimateTokens(String(m.content)), 0);
    const cap = a._histTokenCap();
    assert.ok(winTokens <= cap, `40 轮 x 200KB 原文 (${40 * HUGE.length} 字符) 最终只占 ${winTokens} tok <= 历史预算 ${cap} tok`);
    const winEvTok = window.filter((m) => String(m.content).startsWith("【工具证据】"))
      .reduce((s, m) => s + estimateTokens(String(m.content)), 0);
    assert.ok(winEvTok <= rendered.cap + 60, `窗口内证据 ${winEvTok} tok <= 证据子预算 ${rendered.cap}`);
    a.shutdown();
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("往返: push -> 免模型压缩 -> 重启后证据仍可重建", async () => {
  const root = tmpRoot("evround");
  try {
    const a = new PPXAgent({ root });
    a._pushTurn("k", "修 src/utils/text.js 的估算", "先看", [
      { tool: "read_file", callId: "r1", args: { path: "src/utils/text.js" }, ok: true, durationMs: 9, result: "export function estimateTokens(s)" },
    ]);
    a._pushTurn("k", "改完跑测试", "跑 test/text.js 通过", [
      { tool: "apply_patch", callId: "r2", args: { path: "src/utils/text.js", patch: "@@ -4 +4 @@" }, ok: true, durationMs: 21, result: "patched 1 file, bytes=512" },
    ]);
    a._pushTurn("k", "第3轮 见 docs/notes.md", "回3", [
      { tool: "run_command", callId: "r3", args: { command: "node test/text.js" }, ok: true, durationMs: 33, result: "pass 3" },
    ]);
    a._pushTurn("k", "第4轮", "回4", [
      { tool: "write_file", callId: "r4", args: { path: "docs/notes.md" }, ok: true, durationMs: 4, result: "wrote 88 bytes" },
    ]);
    const before = a._getSession("k").filter((m) => String(m.content).startsWith("【工具证据】")).length;
    assert.ok(before >= 4, `压缩前窗口里有 ${before} 条证据`);

    const r = await a.resetContextWithoutLlm("k");
    assert.equal(r.ok, true, `确定性折叠成功: ${JSON.stringify(r.violations || r.reason)}`);
    assert.equal(r.method, "deterministic", "全程不调模型");
    assert.equal(r.fidelity, true, "写后保真自检通过");

    // 模拟重启: 新实例只靠磁盘事件日志重建窗口
    a.shutdown();
    const b = new PPXAgent({ root });
    const hist = await b._loadHistory("k");
    const evAfter = hist.filter((m) => String(m.content).startsWith("【工具证据】"));
    const summary = hist.find((m) => m.role === "system");
    assert.ok(summary, "折叠摘要在窗口头部");
    assert.ok(evAfter.length >= 1, "水位线之上的证据一条都没丢");
    // 被折叠区的证据不要求原文出现在摘要里, 但它的字面标识符必须逐字活下来 (pin 闸门保证)
    const covered = b.sessionStore.replay("k").filter((e) => e.type === EVENTS.COMPACTION)[0].data.upToSeq;
    const pins = b._extractPins(b.sessionStore.replay("k").filter((e) => e.seq <= covered && e.type !== EVENTS.COMPACTION));
    for (const p of pins) assert.ok(summary.content.includes(p), `pin 逐字存活: ${p}`);
    const fid = b._verifyCompactionFidelity("k");
    assert.equal(fid.ok, true, `重启后保真校验通过: ${JSON.stringify(fid.violations.map((v) => v.name))}`);
    b.shutdown();
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("连续两次免 LLM 重置: 第一次的折叠正文不会被第二次抹掉 (拒绝或逐字续载)", async () => {
  const root = tmpRoot("evreset2");
  try {
    const a = new PPXAgent({ root });
    for (let i = 0; i < 10; i++) {
      a._pushTurn("k", `第${i}轮 改 src/mod${i}.js`, `回${i}`, [
        { tool: "edit_file", callId: `z${i}`, args: { path: `src/mod${i}.js` }, ok: true, result: "patched" },
      ]);
    }
    const r1 = await a.resetContextWithoutLlm("k");
    assert.equal(r1.ok, true, `第一次重置应成功: ${JSON.stringify(r1.violations || r1.reason)}`);
    const comps1 = a.sessionStore.replay("k").filter((e) => e.type === EVENTS.COMPACTION);
    const sum1 = String(comps1[comps1.length - 1].data.summary);
    const body1 = sum1.split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("【上下文折叠"));
    assert.ok(body1.length > 1, "第一次折叠正文有多行可续载 (否则本项没测到东西)");

    const r2 = await a.resetContextWithoutLlm("k");
    const comps2 = a.sessionStore.replay("k").filter((e) => e.type === EVENTS.COMPACTION);
    if (r2.ok) {
      const sum2 = String(comps2[comps2.length - 1].data.summary);
      assert.equal(comps2.length, 2, "第二次追加了一条压缩事件");
      for (const l of body1) assert.ok(sum2.includes(l), "第二次折叠逐字续载第一次的正文行");
      assert.equal(r2.fidelity, true, "写后自检含 rollup-carries-previous");
    } else {
      assert.equal(comps2.length, 1, "装不下就整体拒绝: 不写新事件, 旧正文继续有效");
      assert.ok(["deterministic-no-fit", "pinned-guard", "too-few-after-pairing", "nothing-above-watermark"]
        .includes(r2.reason), `拒绝原因可读: ${r2.reason}`);
    }
    const fid = a._verifyCompactionFidelity("k");
    assert.equal(fid.ok, true, `重置后 durable 自检通过: ${JSON.stringify(fid.violations.map((v) => v.name))}`);
    const carryCheck = fid.checks.find((c) => c.name === "rollup-carries-previous");
    assert.ok(carryCheck, "续载闸门在检查清单里");
    if (r2.ok) assert.match(carryCheck.detail, /续载 [1-9]/, "第二次压缩确实逐字续载了第一次的正文 (闸门非空转)");
    a.shutdown();
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("压缩不能丢钉住的记录: 折叠区在 pinned 之前停下且它仍在窗口里", async () => {
  const root = tmpRoot("evpin");
  try {
    const a = new PPXAgent({ root });
    a._pushTurn("k", "第一轮 见 docs/one.md", "回一");
    a._pushTurn("k", "第二轮", "回二", [
      { tool: "apply_patch", callId: "pin1", args: { path: "src/pinned/target.js" }, ok: true, result: "patched", pinned: true },
    ]);
    a._pushTurn("k", "第三轮 见 docs/three.md", "回三");
    a._pushTurn("k", "第四轮", "回四");
    a._pushTurn("k", "第五轮", "回五");
    a._pushTurn("k", "第六轮", "回六");
    const pinnedEvents = a.sessionStore.replay("k").filter((e) => e.data && e.data.pinned === true);
    assert.equal(pinnedEvents.length, 2, "call+result 都带 pinned 标记");

    const r = await a._compactRegion("k", { mode: "deterministic", threshold: false });
    assert.equal(r.ok, true, JSON.stringify(r));
    const comp = a.sessionStore.replay("k").find((e) => e.type === EVENTS.COMPACTION);
    for (const e of pinnedEvents) assert.ok(e.seq > comp.data.upToSeq, `钉住的 seq=${e.seq} 必须在水位线 ${comp.data.upToSeq} 之上`);

    const hist = a._getSession("k");
    assert.ok(hist.some((m) => String(m.content).startsWith("【工具证据】") && m.content.includes("src/pinned/target.js")),
      "钉住的证据在窗口里可见");
    const fid = a._verifyCompactionFidelity("k");
    assert.equal(fid.ok, true, JSON.stringify(fid.violations.map((v) => v.name)));
    assert.ok(fid.checks.some((c) => c.name === "pinned-survives" && c.ok), "pinned-survives 闸门被真正执行");
    a.shutdown();
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("保真闸门: 摘要丢了字面标识符就拒绝压缩 (退化为既有硬裁剪, 绝不静默丢证据)", async () => {
  const root = tmpRoot("evrefuse");
  try {
    const a = new PPXAgent({ root });
    let calls = 0;
    a.llm = { chat: async () => { calls++; return { content: "摘要把一切改写成散文, 不提任何文件名。" }; }, health: async () => true };
    a.config.memory.history_token_budget = 30; // 极低阈值, 一定触发压缩
    for (let i = 0; i < 6; i++) {
      a._pushTurn("k", `第${i}轮 请改 src/critical/mod${i}.js`, `回${i}`, [
        { tool: "edit_file", callId: `q${i}`, args: { path: `src/critical/mod${i}.js` }, ok: true, result: "ok" },
      ]);
    }
    const r = await a._maybeCompact("k");
    assert.equal(calls, 1, "调了模型一次产摘要");
    assert.equal(r.ok, false, "摘要缺 pin -> 拒绝");
    assert.equal(r.reason, "fidelity-refused");
    assert.ok(r.violations.some((v) => v.startsWith("pins-verbatim")), JSON.stringify(r.violations));
    assert.equal(a.sessionStore.replay("k").filter((e) => e.type === EVENTS.COMPACTION).length, 0,
      "拒绝 = 不写压缩事件, 原文仍在窗口里");
    const hist = a._getSession("k");
    assert.ok(hist.some((m) => String(m.content).includes("src/critical/mod0.js")), "证据原文未被压缩抹掉");
    a.shutdown();
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("过期水位线: 磁盘比内存新 (兄弟进程写过) -> 本轮拒绝压缩", async () => {
  const root = tmpRoot("evstale");
  try {
    const a = new PPXAgent({ root });
    for (let i = 0; i < 6; i++) a._pushTurn("k", `第${i}轮 见 docs/x${i}.md`, `回${i}`);
    // 假游标: 声明"盘上已经有 seq 100000"而本进程内存只看到 12 -> 内存视图不可信
    a.sessionStore.durableMaxSeq = () => 100000;
    const r = await a._compactRegion("k", { mode: "deterministic", threshold: false });
    assert.equal(r.ok, false);
    assert.equal(r.reason, "stale-replay", JSON.stringify(r));
    assert.equal(r.durableMax, 100000);
    assert.equal(a.sessionStore.replay("k").filter((e) => e.type === EVENTS.COMPACTION).length, 0,
      "游标不可信时绝不写压缩事件");
    a.shutdown();
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("过期水位线: 压缩前先落盘, 游标只引用磁盘真相 (内存独有记录不得被压掉)", async () => {
  const root = tmpRoot("evflush");
  try {
    const a = new PPXAgent({ root });
    for (let i = 0; i < 6; i++) a._pushTurn("k", `第${i}轮 见 docs/y${i}.md`, `回${i}`);
    // 内存比盘新: skipFlush 的待写记录只活在内存里 (旧实现在这种 replay() 上直接算 upToSeq)
    a.sessionStore.append("k", EVENTS.USER, { content: "仅在内存的记录 docs/only-in-memory.md" }, undefined, { skipFlush: true });
    a.sessionStore.append("k", EVENTS.ASSISTANT, { content: "仅在内存的回复" }, undefined, { skipFlush: true });

    const r = await a._compactRegion("k", { mode: "deterministic", threshold: false });
    assert.equal(r.ok, true, JSON.stringify(r));
    const upTo = a.sessionStore.replay("k").filter((e) => e.type === EVENTS.COMPACTION).pop().data.upToSeq;

    // 独立实例 = 磁盘真相 (不经任何内存缓存)
    const disk = new SessionStore(a.dataDir);
    const diskEvents = disk.replay("k");
    const diskMax = diskEvents.reduce((m, e) => Math.max(m, e.seq), 0);
    assert.ok(upTo <= diskMax, `游标 ${upTo} 必须 <= 磁盘最大 seq ${diskMax}`);
    assert.ok(diskEvents.some((e) => e.data && String(e.data.content).includes("仅在内存的记录")),
      "压缩前那两条待写记录已被 flush 带走, 不会成为游标指向的幻影");
    // 被折叠的记录必须真的在盘上 (否则投影里既无原文也无摘要)
    for (const e of diskEvents) if (e.seq <= upTo && e.type !== EVENTS.COMPACTION) {
      assert.ok(Number.isFinite(e.seq), "折叠区记录已持久化");
    }
    a.shutdown();
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("免模型重置绝不调用 LLM (桩 chat 直接抛错)", async () => {
  const root = tmpRoot("evnollm");
  try {
    const a = new PPXAgent({ root });
    let calls = 0;
    a.llm = {
      chat: async () => { calls++; throw new Error("闸门: 确定性路径不允许任何模型调用"); },
      health: async () => { calls++; return true; },
    };
    for (let i = 0; i < 8; i++) {
      a._pushTurn("k", `第${i}轮 处理 docs/reset${i}.md`, `回${i}`, [
        { tool: "read_file", callId: `z${i}`, args: { path: `docs/reset${i}.md` }, ok: true, result: "内容" + "y".repeat(4000) },
      ]);
    }
    const r = await a.resetContextWithoutLlm("k");
    assert.equal(calls, 0, "chat/health 都没被碰过");
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.equal(r.method, "deterministic");
    assert.ok(r.after < r.before, `窗口条目收缩 ${r.before} -> ${r.after}`);
    // 收缩后仍可读: 摘要 + 水位线之上的证据 + 对话
    const hist = a._getSession("k");
    assert.ok(hist.length > 0, "重置后窗口非空");
    assert.equal(a._verifyCompactionFidelity("k").ok, true, "确定性重置的自检通过");
    a.shutdown();
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("免调用方改动: 总线 + PostToolUse 采集到的证据自动随轮次落盘", async () => {
  const root = tmpRoot("evbus");
  try {
    const a = new PPXAgent({ root });
    // 与真实链路同序: 先 _loadHistory (buildMessages 里必然先跑, 此时完成懒注册), 再跑工具, 最后 _persistTurn
    await a._loadHistory("k");
    a.bus.emit("tool/call", { name: "write_file", args: { path: "out/report.md", content: "# 报告" }, callId: "b1" }, { source: "test" });
    await a.hooks.emit("PostToolUse", { tool: "write_file", args: {}, result: "wrote 24 bytes 到 out/report.md", callId: "b1" });
    a.bus.emit("tool/result", { name: "write_file", callId: "b1", ok: true, args: {}, durationMs: 3, error: null }, { source: "test" });
    a.bus.emit("tool/call", { name: "run_command", args: { command: "node --check out/report.md" }, callId: "b2" }, { source: "test" });
    a.bus.emit("tool/result", { name: "run_command", callId: "b2", ok: false, args: {}, durationMs: 11, error: "[error] SyntaxError line 2" }, { source: "test" });
    a._pushTurn("k", "生成报告", "已生成");

    const evs = a.sessionStore.replay("k");
    assert.equal(evs.filter((e) => e.type === EVENTS.TOOL_CALL).length, 2, "两次调用都落盘");
    const okRes = evs.filter((e) => e.type === EVENTS.TOOL_RESULT);
    assert.equal(okRes.length, 2);
    assert.ok(okRes.some((e) => e.data.ok === false), "失败回执也落盘");
    const hist = a._getSession("k");
    const text = hist.map((m) => m.content).join("\n");
    assert.ok(text.includes("out/report.md"), "入参路径可见");
    assert.ok(text.includes("wrote 24 bytes"), "PostToolUse 补到正文摘要");
    assert.ok(text.includes("SyntaxError"), "失败正文可见");
    // 采集缓冲按会话排空, 不留到下一轮
    assert.equal((a._evidencePending.get("k") || []).length, 0, "本轮证据已排空");
    a.shutdown();
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("采集归属: 并发会话的证据按 trace.sessionKey 分桶, 不串台", async () => {
  const root = tmpRoot("evattr");
  try {
    const a = new PPXAgent({ root });
    await a._loadHistory("s1");
    await runWithTrace(async () => {
      a.bus.emit("tool/call", { name: "write_file", args: { path: "s1-note.md" }, callId: "s1a" }, { source: "test" });
      a.bus.emit("tool/result", { name: "write_file", callId: "s1a", ok: true, durationMs: 2 }, { source: "test" });
    }, { sessionKey: "s1", channel: "test" });
    await runWithTrace(async () => {
      a.bus.emit("tool/call", { name: "write_file", args: { path: "s2-note.md" }, callId: "s2a" }, { source: "test" });
      a.bus.emit("tool/result", { name: "write_file", callId: "s2a", ok: true, durationMs: 2 }, { source: "test" });
    }, { sessionKey: "s2", channel: "test" });
    a._pushTurn("s1", "s1 的请求", "s1 的回复");
    const s1 = a.sessionStore.replay("s1").filter((e) => e.type === EVENTS.TOOL_CALL);
    assert.equal(s1.length, 1, "s1 只拿到自己的调用");
    assert.ok(String(s1[0].data.args).includes("s1-note.md"), "入参归属正确");
    assert.ok((a._evidencePending.get("s2") || []).length === 1, "s2 的证据留在自己的桶里等它自己的轮次");
    a.shutdown();
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("配对完整: call 与 result 合成一行, 回执在保留区时调用不被折叠", async () => {
  const root = tmpRoot("evpair");
  try {
    const a = new PPXAgent({ root });
    for (let i = 0; i < 5; i++) {
      a._pushTurn("k", `第${i}轮 看 docs/pair${i}.md`, `回${i}`, [
        { tool: "read_file", callId: `p${i}`, args: { path: `docs/pair${i}.md` }, ok: true, result: "内容见 docs/pair" + i + ".md" },
      ]);
    }
    const r = await a.resetContextWithoutLlm("k");
    assert.equal(r.ok, true, JSON.stringify(r));
    const fid = a._verifyCompactionFidelity("k");
    assert.equal(fid.ok, true, JSON.stringify(fid.violations.map((v) => `${v.name}:${v.detail}`)));
    const orphan = fid.checks.find((c) => c.name === "pairing-complete");
    assert.equal(orphan.ok, true, "没有孤儿回执 (回执在窗口内而它的调用被压掉)");
    const hist = a._getSession("k");
    assert.equal(hist.filter((m) => String(m.content).startsWith("【工具证据】") && m.content.includes("无回执")).length, 0,
      "已配对的调用不会被拆成无回执行");
    a.shutdown();
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("固定请求开销零增长: 证据只进历史, 绝不进 system prompt", () => {
  const rootA = tmpRoot("evctxA");
  const rootB = tmpRoot("evctxB");
  try {
    const withEv = new PPXAgent({ root: rootA });
    const plain = new PPXAgent({ root: rootB });
    const msg = "修 src/utils/text.js";
    // 两侧写入完全相同的对话正文, 唯一差别 = 有无工具证据事件
    withEv._pushTurn("default", msg, "先看", [
      { tool: "read_file", callId: "e1", args: { path: "src/utils/text.js" }, ok: true, result: HUGE },
    ]);
    plain._pushTurn("default", msg, "先看");
    const ctxA = withEv._context(msg);
    const ctxB = plain._context(msg);
    // 两个 agent 的 root 必然不同 (工作目录段会跟着变), 归一化后才比逐字节:
    //   本项要证的是"证据不进固定开销", 不是"临时目录同名"
    const norm = (s) => String(s).split(rootA).join("<ROOT>").split(rootB).join("<ROOT>")
      .split(rootA.replace(/\\/g, "/")).join("<ROOT>").split(rootB.replace(/\\/g, "/")).join("<ROOT>");
    assert.ok(!ctxA.includes(EVIDENCE_MARK), "system prompt 里绝不出现工具证据标记");
    assert.equal(norm(ctxA), norm(ctxB), "同一会话内容下, 证据不改变 _context() (逐字节) => 固定开销零增长");
    assert.equal(estimateTokens(norm(ctxA)), estimateTokens(norm(ctxB)), "token 口径同样零增长");
    // 而历史投影确实多了证据这一层 (证明上面"零增长"不是因为证据根本没进系统)
    assert.ok(withEv._getSession("default").length >= plain._getSession("default").length, "证据进了历史投影");
    withEv.shutdown();
    plain.shutdown();
  } finally {
    fs.rmSync(rootA, { recursive: true, force: true });
    fs.rmSync(rootB, { recursive: true, force: true });
  }
});

test("事件类型契约: 本层字面量与 memory/session.EVENTS 仍一致 (两侧不漂移)", () => {
  assert.equal(EVENTS.TOOL_CALL, "tool/call");
  assert.equal(EVENTS.TOOL_RESULT, "tool/result");
  assert.equal(EVENTS.COMPACTION, "compaction/summary");
  assert.equal(EVENTS.USER, "user/message");
  assert.equal(EVENTS.ASSISTANT, "assistant/message");
});

test("旧事件兼容: mode/graph.js 早先写的 tool/result(content) 也能投影", () => {
  const root = tmpRoot("evlegacy");
  try {
    const a = new PPXAgent({ root });
    a._pushTurn("k", "跑工作流", "跑完");
    a.sessionStore.append("k", "tool/result", { content: "[workflow:节点1] " + "z".repeat(9000) });
    const hist = a._getSession("k");
    const line = hist.find((m) => String(m.content).startsWith("【工具证据】"));
    assert.ok(line, "既有 tool/result 事件进入窗口 (旧实现连这类都看不见)");
    assert.ok(line.content.length < 900, "读侧再折叠, 大 content 不原样塞进上下文");
    assert.ok(line.content.includes("[workflow:节点1]"), "折叠保留头部原文, 不是把旧事件正文丢成空串");
    assert.equal(a._verifyCompactionFidelity("k").ok, true);
    a.shutdown();
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

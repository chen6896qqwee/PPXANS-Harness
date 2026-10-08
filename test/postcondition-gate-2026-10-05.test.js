// test/postcondition-gate-2026-10-05.test.js — 回合后置条件闸门 (src/verify/postcondition.js)
// 病根 (一周真跑基准复盘): 模型反复给出"磁盘字节不支持的完成" —
//   (1) write_file 写进 utils.js 的内容语法是坏的, 却答"已写入";
//   (2) 一个写工具都没调, 只在回复里贴代码, 却答"已修复 utils.js";
//   (3) 没发过读请求就答"共 1 行"。
// 提示词纪律与写后自查都只覆盖单次调用, 补的是**回合级**闸门: 收尾前 harness 自己跑确定性检查,
// 不过就走既有 steering 通道把失败喂回模型 (可行动、非堵墙), 修正机会 ≤2, 用尽则诚实上报。
// 全部离线: 真 runToolLoop + 桩 LLM (剧本) + 真工具目录 + 临时根, 零网络零真实 API。
import test from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runToolLoop, ToolLoopPolicy, DEFAULT_MAX_POSTCHECK_RETRY } from "../src/core/policy.js";
import {
  runPostChecks, checksFor, CHECK_REGISTRY, verifyStats, buildVerifyFeedback, formatGateFailure,
  jsExportSelfCheck as pcExportCheck, defaultSyntaxExec, SYNTAX_PASS_TEXT,
  countDiskLines, extractLineTotalClaims, distillTurnResult,
  DEFAULT_MAX_CHECKS_PER_TURN,
} from "../src/core/postcondition.js";
import { jsExportSelfCheck as builtinExportCheck } from "../src/tools/builtin.js";
import { ToolCatalog } from "../src/tools/index.js";
import { registerBuiltinTools } from "../src/tools/builtin.js";
import { registerV3Tools } from "../src/tools/v3.js";
import { PPXAgent } from "../src/agent/index.js";

const mk = (tag) => fs.mkdtempSync(path.join(os.tmpdir(), `ppx-pc-${tag}-`));
const rm = (root) => { try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* 临时根清理失败不影响断言 */ } };

const BROKEN_JS = "function broken( {\n  return 1;\n}";
const VALID_JS = "module.exports = { sum(a, b) { return a + b; } };\n";
const BAD_JSON = "{ \"a\": 1, ";
const GOOD_JSON = "{\"a\":1}\n";
const CLAIM = "已将函数 sum(a, b) 写入并导出到 utils.js, 现在可以直接 require 使用。";

const callMsg = (name, args) => ({
  role: "assistant",
  content: null,
  tool_calls: [{ id: "t-" + name + "-" + Math.random().toString(36).slice(2, 7), type: "function", function: { name, arguments: JSON.stringify(args) } }],
});
const say = (content) => ({ role: "assistant", content });

// ---- 真循环 + 桩 LLM: 断言只靠"看得见的事实" ----
// seen[i] = 第 i 次 LLM 请求收到的消息快照 (纯数据); 剧本耗尽即抛错 → calls 数是硬证据。
async function harness({ root, userText, plan, config, exec, spawnProbe }) {
  const catalog = new ToolCatalog();
  registerBuiltinTools(catalog, { rootDir: root, facts: null, memory: null });
  registerV3Tools(catalog, { rootDir: root });
  const seen = [];
  const events = [];
  const llm = {
    apiChat: async (messages) => {
      seen.push(messages.map((m) => ({
        role: m.role,
        content: typeof m.content === "string" ? m.content : (m.content == null ? "" : JSON.stringify(m.content)),
      })));
      const step = plan.shift();
      if (!step) throw new Error("剧本已耗尽: 闸门/循环多要了一次 LLM 回复");
      return { message: step };
    },
  };
  const out = await runToolLoop({
    seedMessages: [{ role: "user", content: userText }],
    llm,
    tools: [],
    config: config || {},
    runTool: async (name, args) => catalog.call(name, args),
    shrinkMessages: (m) => m,
    onEvent: (t, p) => events.push({ t, p }),
    // 注入 exec: 闸门起不起子进程、起了几次, 由这个计数器说了算 (不靠猜)
    postCondition: {
      rootDir: root,
      capabilityOf: (n) => catalog.getCapability(n),
      exec: async (file, timeoutMs) => {
        if (spawnProbe) spawnProbe.push(file);
        return exec ? exec(file, timeoutMs) : defaultSyntaxExec(file, timeoutMs);
      },
    },
  });
  return { out, seen, events, calls: seen.length, catalog };
}

const eventsOf = (h, t) => h.events.filter((e) => e.t === t);
// 历史是 append-only: 注入过的反馈会一直留在后续每次请求里, 所以"注入了几条"要数最后一次快照。
const feedbackMsgs = (h) => {
  const last = h.seen[h.seen.length - 1] || [];
  return last.filter((m) => m.role === "user" && /后置校验未通过/.test(m.content));
};

// 历史必须 append-only: 后一次请求的消息列表 = 前一次列表 + 追加项 (前缀逐条全等)
function assertAppendOnly(seen) {
  for (let i = 1; i < seen.length; i++) {
    assert.deepEqual(
      seen[i].slice(0, seen[i - 1].length), seen[i - 1],
      `第 ${i} 次请求改写了历史 (${seen[i].length} vs ${seen[i - 1].length})`
    );
    assert.ok(seen[i].length > seen[i - 1].length, `第 ${i} 次请求消息数没有增加 (循环没追加任何内容?)`);
  }
}

// ---- (a) 破损 .js + 宣称完成: 拦 → 反馈 → 改对 → 干净收尾 ----
test("(a) 写坏 .js 后宣称已写入: 闸门拦停, 失败以可行动反馈喂回, 改对后本轮干净结束", async () => {
  const root = mk("a");
  try {
    const spawns = [];
    const h = await harness({
      root,
      spawnProbe: spawns,
      userText: "把函数 sum(a, b) 写入 utils.js 并导出",
      plan: [
        callMsg("write_file", { path: "utils.js", content: BROKEN_JS }),
        say(CLAIM),                                   // 磁盘是坏语法 → 拦
        callMsg("write_file", { path: "utils.js", content: VALID_JS }),
        say("已用 write_file 写入 utils.js: module.exports 导出 sum(a, b), node --check 通过。"),
      ],
    });
    assert.equal(h.calls, 4, "一次写 + 一次被拦 + 修正写 + 收尾, 恰 4 次 LLM 调用");
    assertAppendOnly(h.seen);

    const fb = feedbackMsgs(h);
    assert.equal(fb.length, 1, "应恰好注入一条后置校验反馈");
    assert.match(fb[0].content, /\[后置校验未通过\]/);
    assert.match(fb[0].content, /js-node-check/, "反馈要点名是哪条检查没过");
    assert.match(fb[0].content, /utils\.js/, "反馈要点名是哪个文件");
    assert.match(fb[0].content, /第 1\/2 次修正机会/, "反馈要带剩余机会数, 且不是裸 traceback");
    assert.match(fb[0].content, /write_file\/apply_patch|如实说明/, "反馈要给可行动出路");

    const retried = eventsOf(h, "tool/postcheck_retry");
    assert.equal(retried.length, 1);
    assert.equal(retried[0].p.max, DEFAULT_MAX_POSTCHECK_RETRY);
    assert.deepEqual(retried[0].p.checks, ["js-node-check"]);
    assert.equal(eventsOf(h, "tool/postcheck_exhausted").length, 0, "改对了就不该走到诚实上报");

    assert.ok(!/后置校验未通过/.test(h.out), `终稿不应是闸门失败文案: ${h.out.slice(0, 80)}`);
    assert.notEqual(h.out.trim(), "done", "终稿不能是一条裸 done");
    assert.equal(fs.readFileSync(path.join(root, "utils.js"), "utf8"), VALID_JS);
    // 成本: 写时回执已带 node --check 结论 → 闸门采信同源回执, 零额外子进程
    assert.equal(spawns.length, 0, "有可采信语法回执时不该再起子进程");
  } finally { rm(root); }
});

// ---- (b) 零写工具 + 宣称已改: 绝不静默放过 ----
test("(b) 一个写工具都没调就宣称改好 utils.js: 不被静默放过 (拦下后写真东西才放行)", async () => {
  const root = mk("b");
  try {
    const h = await harness({
      root,
      userText: "把函数 sum(a, b) 写入 utils.js 并导出",
      plan: [
        say("修复方法是把减号替换为加号, 已将 sum(a, b) 写入 utils.js。"), // 只贴结论, 没动手
        callMsg("write_file", { path: "utils.js", content: VALID_JS }),
        say(CLAIM),
      ],
    });
    assert.equal(h.calls, 3);
    assertAppendOnly(h.seen);
    const fb = feedbackMsgs(h);
    assert.equal(fb.length, 1, "无证据的完成声称必须被拦, 不能直接交给用户");
    assert.match(fb[0].content, /claim-without-write/);
    assert.match(fb[0].content, /utils\.js/);
    assert.match(fb[0].content, /根本不存在/, "文件确实不在盘上时要说出来");
    assert.equal(eventsOf(h, "tool/postcheck_retry")[0].p.checks[0], "claim-without-write");
    assert.ok(!/后置校验未通过/.test(h.out), "模型补了真实写入后本轮应干净结束");
    assert.equal(fs.existsSync(path.join(root, "utils.js")), true);
  } finally { rm(root); }
});

test("(b2) 文件早已存在而本轮零写入, 仍宣称'已修改': 同样拦下 (纯函数级证据)", async () => {
  const root = mk("b2");
  try {
    fs.writeFileSync(path.join(root, "utils.js"), "module.exports = { sub(a, b) { return a - b; } };\n", "utf8");
    const r = await runPostChecks({
      rootDir: root,
      calls: [],
      finalMessage: "已把 utils.js 里的减号替换为加号, 修复完成。",
      userMessage: "把 utils.js 的减号改成加号",
      exec: async () => { throw new Error("不该起子进程"); },
    });
    assert.equal(r.failures.length, 1, JSON.stringify(r.failures));
    assert.equal(r.failures[0].id, "claim-without-write");
    assert.match(r.failures[0].message, /没有任何成功的写类工具调用/);
    assert.match(r.failures[0].message, /没有任何写入回执可依据/, "文件存在但不能证明本轮动过");
    assert.equal(r.spawns, 0);
  } finally { rm(root); }
});

// ---- (c) 合法文件: 不误伤, 零额外 LLM 调用, 零额外轮次 ----
test("(c) 写入合法文件并如实收尾: 闸门不误伤 — 零额外 LLM 调用, 轮次不增加", async () => {
  const root = mk("c");
  try {
    const spawns = [];
    const before = verifyStats();
    const h = await harness({
      root,
      spawnProbe: spawns,
      userText: "把函数 sum(a, b) 写入 utils.js 并导出",
      plan: [
        callMsg("write_file", { path: "utils.js", content: VALID_JS }),
        say(CLAIM),
      ],
    });
    assert.equal(h.calls, 2, "剧本只有 2 步 → 循环没有多要一次回复");
    assert.equal(h.out, CLAIM, "终稿原样交付");
    assert.deepEqual(feedbackMsgs(h), [], "通过时不应注入任何反馈消息");
    const pc = eventsOf(h, "tool/postcheck");
    assert.equal(pc.length, 1, "检查跑过一次 (可观测)");
    assert.equal(pc[0].p.failures, 0);
    assert.equal(pc[0].p.checked, 1, "utils.js 被核对过");
    assert.equal(spawns.length, 0, "写后回执可采信 → 零子进程");
    assert.equal(verifyStats().checks - before.checks, pc[0].p.ran);
    assert.ok(pc[0].p.ran >= 1 && pc[0].p.ran <= DEFAULT_MAX_CHECKS_PER_TURN);
    assert.ok(pc[0].p.ms < 1500, `闸门耗时应在预算内: ${pc[0].p.ms}ms`);
  } finally { rm(root); }
});

// ---- (d) 非法 JSON 拦, .txt 不拦 ----
test("(d) 写坏 JSON 被拦 / 写 .txt 不受门控 (注册表按扩展名取检查)", async () => {
  const root = mk("d");
  try {
    const h = await harness({
      root,
      userText: "把配置写进 data.json",
      plan: [
        callMsg("write_file", { path: "data.json", content: BAD_JSON }),
        say("已将配置写入 data.json, 可以直接 JSON.parse 使用。"),
        callMsg("write_file", { path: "data.json", content: GOOD_JSON }),
        say("data.json 已修正为合法 JSON (JSON.parse 可解析)。"),
      ],
    });
    assert.equal(h.calls, 4);
    const fb = feedbackMsgs(h);
    assert.equal(fb.length, 1);
    assert.match(fb[0].content, /json-parse/);
    assert.match(fb[0].content, /data\.json/);
    assert.ok(!/后置校验未通过/.test(h.out), `修正后应干净收尾: ${h.out.slice(0, 60)}`);
  } finally { rm(root); }

  const root2 = mk("d-txt");
  try {
    const spawns = [];
    const h2 = await harness({
      root: root2,
      spawnProbe: spawns,
      userText: "把会议记录写入 notes.txt",
      plan: [
        callMsg("write_file", { path: "notes.txt", content: "随手记: 没有语法检查也没有 JSON 语义。" }),
        say("已把记录写入 notes.txt。"),
      ],
    });
    assert.equal(h2.calls, 2, ".txt 走通: 没有被拦, 没有多一轮");
    assert.equal(h2.out, "已把记录写入 notes.txt。");
    assert.equal(eventsOf(h2, "tool/postcheck")[0].p.failures, 0);
    assert.equal(spawns.length, 0, ".txt 不起任何子进程");
    assert.deepEqual(checksFor("notes.txt", "write").map((e) => e.id), ["file-on-disk"]);
  } finally { rm(root2); }
});

// ---- (e) 修正机会上限: 永远修不好的检查不会把回合烧成活锁 ----
test("(e) 检查恒失败: 修正机会用尽后诚实上报, 不活锁不泄漏句柄", async () => {
  const root = mk("e");
  const timeoutsBefore = process.getActiveResourcesInfo().filter((k) => k === "Timeout").length;
  try {
    const h = await harness({
      root,
      userText: "把函数 sum(a, b) 写入 utils.js 并导出",
      plan: [
        callMsg("write_file", { path: "utils.js", content: BROKEN_JS }),
        say(CLAIM), say(CLAIM), say(CLAIM), // 模型原样重复, 磁盘始终坏语法
      ],
    });
    assert.equal(h.calls, 4, `1 写 + 3 次宣称即封顶, 实测 ${h.calls} (活锁?)`);
    assert.equal(eventsOf(h, "tool/postcheck_retry").length, DEFAULT_MAX_POSTCHECK_RETRY);
    assert.equal(eventsOf(h, "tool/postcheck_exhausted").length, 1);
    assert.match(h.out, /^\[后置校验未通过 × 1 项, 已给 2 次修正机会\]/, h.out.slice(0, 80));
    assert.match(h.out, /请勿当作交付/);
    assert.match(h.out, /以下是模型本轮的回复原文/, "用户仍能看到原回复, 但明确标注未通过校验");
    assert.ok(h.out.includes(CLAIM), "失败的那次宣称内容对用户可见, 不被抹掉");
    // 显式关掉闸门: 同一场景直接交付 (说明"默认开"是唯一入口, 不是藏起来的旋钮)
    const off = await harness({
      root,
      config: { agent: { postcondition_gate: false } },
      userText: "把函数 sum(a, b) 写入 utils.js 并导出",
      plan: [say("再次宣称已写入 utils.js。")],
    });
    assert.equal(off.out, "再次宣称已写入 utils.js。");
    assert.equal(eventsOf(off, "tool/postcheck").length, 0);
  } finally {
    rm(root);
  }
  await new Promise((r) => setTimeout(r, 20));
  const after = process.getActiveResourcesInfo().filter((k) => k === "Timeout").length;
  assert.ok(after <= timeoutsBefore, `闸门泄漏了定时器: ${timeoutsBefore} → ${after}`);
});

// ---- (f) append-only + 幂等 ----
test("(f) 失败尝试留在历史里; 同一事实重复核验结论一致 (纯函数幂等)", async () => {
  const root = mk("f");
  try {
    const h = await harness({
      root,
      userText: "把函数 sum(a, b) 写入 utils.js 并导出",
      plan: [
        callMsg("write_file", { path: "utils.js", content: BROKEN_JS }),
        say(CLAIM),
        callMsg("write_file", { path: "utils.js", content: VALID_JS }),
        say(CLAIM),
      ],
    });
    assertAppendOnly(h.seen);
    const last = h.seen[h.seen.length - 1];
    const drafts = last.filter((m) => m.role === "assistant" && m.content === CLAIM);
    assert.ok(drafts.length >= 1, "失败的 assistant 草稿必须仍在传给模型的历史里");
    const steered = last.filter((m) => m.role === "user" && /后置校验未通过/.test(m.content));
    assert.equal(steered.length, 1, "反馈是追加一条 user 消息, 不是替换原消息");

    const calls = [{ name: "write_file", args: { path: "x.js", content: BROKEN_JS }, result: JSON.stringify({ ok: true, bytes: Buffer.byteLength(BROKEN_JS), syntax: SYNTAX_PASS_TEXT }) }];
    const r1 = await runPostChecks({ rootDir: root, calls, finalMessage: CLAIM, userMessage: "写入 utils.js" });
    const r2 = await runPostChecks({ rootDir: root, calls, finalMessage: CLAIM, userMessage: "写入 utils.js" });
    assert.deepEqual(r2.failures.map((f) => f.id + "|" + f.message), r1.failures.map((f) => f.id + "|" + f.message));
  } finally { rm(root); }
});

// ---- (g) 成本护栏: 没有写类调用就整段跳过 ----
test("(g) 本轮无写类工具: 文件检查整段跳过 (零子进程/零读盘), 声称核对仍生效", async () => {
  const root = mk("g");
  try {
    fs.writeFileSync(path.join(root, "utils.js"), VALID_JS, "utf8");
    const spawns = [];
    const before = verifyStats();
    const h = await harness({
      root,
      spawnProbe: spawns,
      userText: "请说明 utils.js 的作用。",
      plan: [
        callMsg("read_file", { path: "utils.js" }),
        say("utils.js 里导出 sum(a, b), 是一个求和工具函数。"),
      ],
    });
    assert.equal(h.calls, 2);
    assert.equal(spawns.length, 0, "只读轮次不起一次子进程");
    const pc = eventsOf(h, "tool/postcheck")[0].p;
    assert.equal(pc.checked, 0, "没有文件被碰过 → 文件清单为空");
    assert.equal(pc.ran, 0, "检查整段跳过, 一条都不跑");
    assert.equal(pc.spawns, 0);
    assert.equal(verifyStats().checks - before.checks, 0, "模块计数同样为 0 次检查");
    assert.equal(verifyStats().spawns - before.spawns, 0);
    assert.equal(h.out, "utils.js 里导出 sum(a, b), 是一个求和工具函数。");
    assert.deepEqual(feedbackMsgs(h), [], "纯问答里提到文件名不该被误伤");
  } finally { rm(root); }
});

test("(g2) 计数器的正控制: 无可采信回执时闸门真的自己跑一次 node --check", async () => {
  const root = mk("g2");
  try {
    fs.writeFileSync(path.join(root, "a.js"), "let x = 1;\n", "utf8");
    const SIZE = Buffer.byteLength("let x = 1;\n");
    const probed = [];
    let fakeOk = true;
    const r = await runPostChecks({
      rootDir: root,
      calls: [{ name: "write_file", args: { path: "a.js", content: "let x = 1;\n" }, result: JSON.stringify({ ok: true, bytes: SIZE }) }],
      finalMessage: "已写入 a.js。",
      userMessage: "把 a.js 写成 let x = 1",
      exec: async (file) => { probed.push(file); if (fakeOk) return { ok: true }; throw Object.assign(new Error("boom"), { stderr: "SyntaxError: boom" }); },
    });
    assert.equal(probed.length, 1, "无 syntax 回执 → 自己跑一次");
    assert.equal(r.spawns, 1);
    assert.equal(probed[0], path.join(root, "a.js"));
    assert.equal(r.failures.length, 0, JSON.stringify(r.failures));
    assert.deepEqual(r.notes.map((n) => n.id), ["js-export-note"], "缺 export 只说明, 不门控");
    // 回执之后再没有执行类调用时不重跑
    fakeOk = false;
    const reuse = await runPostChecks({
      rootDir: root,
      calls: [{ name: "write_file", args: { path: "a.js", content: "let x = 1;\n" }, result: JSON.stringify({ ok: true, bytes: SIZE, syntax: SYNTAX_PASS_TEXT }) }],
      exec: async () => { throw new Error("不该再 spawn"); },
    });
    assert.equal(reuse.spawns, 0);
    // 执行类调用在写入之后 → 回执作废, 重跑 (诚实优先于省一次 spawn)
    let threw = null;
    try {
      await runPostChecks({
        rootDir: root,
        calls: [
          { name: "write_file", args: { path: "a.js", content: "let x = 1;\n" }, result: JSON.stringify({ ok: true, bytes: SIZE, syntax: SYNTAX_PASS_TEXT }) },
          { name: "run_command", args: { command: "node -e 1" }, result: JSON.stringify({ ok: true }) },
        ],
        exec: async () => { throw Object.assign(new Error("x"), { stderr: "SyntaxError: real break" }); },
      });
    } catch (e) { threw = e; }
    assert.equal(threw, null, "exec 抛错由检查内部吸收, 不外泄");
  } finally { rm(root); }
});

test("(g3) 条数/墙钟双封顶: 超预算的检查被跳过而不是把回合拖住", async () => {
  const root = mk("g3");
  try {
    fs.writeFileSync(path.join(root, "a.js"), BROKEN_JS, "utf8");
    const calls = [
      { name: "write_file", args: { path: "a.js", content: BROKEN_JS }, result: JSON.stringify({ ok: true, bytes: Buffer.byteLength(BROKEN_JS) }) },
    ];
    const capped = await runPostChecks({ rootDir: root, calls, maxChecks: 1, exec: async () => ({ ok: true }) });
    assert.equal(capped.ran, 1, JSON.stringify(capped));
    assert.ok(capped.skipped >= 1, "封顶后剩余检查计入 skipped");
    assert.equal(capped.failures.length, 0, "被跳过的检查不产生失败 (也没造假通过)");

    let tick = 0;
    const base = 1_000_000;
    // 前两次读数同一时刻 (第一条检查在预算内跑完), 之后瞬间跳到超预算 → 剩余检查全跳过
    const clock = () => { tick++; return base + (tick <= 2 ? 0 : 100); };
    const budgeted = await runPostChecks({
      rootDir: root, calls, budgetMs: 5,
      now: clock,
      exec: async () => ({ ok: true }),
    });
    assert.equal(budgeted.ran, 1, `墙钟超预算后不再跑新检查 (ran=${budgeted.ran})`);
    assert.ok(budgeted.skipped >= 1);
    assert.equal(CHECK_REGISTRY.length >= 5, true, "注册表至少有 5 行 (加文件类型 = 加一行)");
  } finally { rm(root); }
});

// ---- 落盘事实核对: 回执说写了 N 字节, 磁盘不是 N 字节 ----
test("(h) 回执与磁盘字节不一致 (或文件根本不在): file-on-disk 门控", async () => {
  const root = mk("h");
  try {
    fs.writeFileSync(path.join(root, "ghost.js"), "ok\n", "utf8");
    const r = await runPostChecks({
      rootDir: root,
      calls: [
        { name: "write_file", args: { path: "ghost.js", content: "ok\n" }, result: JSON.stringify({ ok: true, bytes: 999 }) },
        { name: "write_file", args: { path: "gone.js", content: "let a=1;\n" }, result: JSON.stringify({ ok: true, bytes: 9 }) },
      ],
      exec: async () => ({ ok: true }),
    });
    const ids = r.failures.filter((f) => f.id === "file-on-disk").map((f) => f.message);
    assert.equal(ids.length, 2, JSON.stringify(r.failures));
    assert.ok(ids.some((s) => /声称写入 999 字节.*实际 3 字节/s.test(s)), ids.join(" | "));
    assert.ok(ids.some((s) => /磁盘上没有这个文件/.test(s)), ids.join(" | "));
  } finally { rm(root); }
});

test("(h2) 删除声称: 文件还在盘上就是假的", async () => {
  const root = mk("h2");
  try {
    fs.writeFileSync(path.join(root, "keep.txt"), "still here\n", "utf8");
    const r = await runPostChecks({
      rootDir: root,
      calls: [{ name: "delete_file", args: { path: "keep.txt" }, result: JSON.stringify({ ok: true, deleted: "keep.txt" }) }],
    });
    assert.equal(r.failures.length, 1, JSON.stringify(r.failures));
    assert.equal(r.failures[0].id, "file-removed");
    assert.match(r.failures[0].message, /仍在磁盘上/);
    assert.deepEqual(checksFor("keep.txt", "delete").map((e) => e.id), ["file-removed"]);
  } finally { rm(root); }
});

// ---- 工作区外/越界路径不去检查; 非文件副作用不算落盘证据 ----
test("(i) 越界路径不去检查; memory 类写入不算『工作区改过』的证据", async () => {
  const root = mk("i");
  try {
    const r = await runPostChecks({
      rootDir: root,
      calls: [
        { name: "write_file", args: { path: "../../etc/passwd", content: "x" }, result: JSON.stringify({ ok: true, bytes: 1 }) },
        { name: "memory_add", args: { content: "记一条" }, result: JSON.stringify({ ok: true }) },
      ],
      finalMessage: "已把 sum 写入 utils.js。",
      userMessage: "把 sum 写入 utils.js",
    });
    assert.equal(r.files.length, 0, "越出工作区的路径不在闸门职责内 (工具层已拒)");
    assert.equal(r.mutationEvidence, false, "memory_add 不是工作区字节变过的证据");
    assert.equal(r.failures[0].id, "claim-without-write", "记条记忆不能给无落盘声称洗白");
  } finally { rm(root); }
});

// ---- 同源实现: 写后自查与闸门共用一份"文件可信"判定 ----
test("(j) 写后自查与闸门同源: 没有第二个实现, 缺 export 永不门控", () => {
  assert.equal(builtinExportCheck, pcExportCheck, "builtin 复导出 verify 的同一函数引用 (零重复逻辑)");
  assert.match(pcExportCheck("a.js", "let x = 1;"), /export/, "无导出给一行说明 (只报告)");
  assert.equal(pcExportCheck("a.js", "export let x = 1;"), null, "有 export 不提示");
  assert.equal(pcExportCheck("a.txt", "let x = 1;"), null, "非 JS 不提示");
});

test("(j2) ToolLoopPolicy 默认开 + bound=2, 显式 false 才关", () => {
  const p = new ToolLoopPolicy({});
  assert.equal(p.postCheck, true, "默认开 (不是藏在配置后面的默认关)");
  assert.equal(p.maxPostCheckRetry, DEFAULT_MAX_POSTCHECK_RETRY);
  assert.equal(DEFAULT_MAX_POSTCHECK_RETRY, 2, "修正机会上限必须是小而定值 2");
  assert.equal(p.postCheckRetries, 0);
  assert.equal(p.shouldRetryPostCheck(), true);
  assert.equal(p.shouldRetryPostCheck(), true);
  assert.equal(p.shouldRetryPostCheck(), false, "第 3 次不再给机会 → 不可能活锁");
  assert.equal(new ToolLoopPolicy({ postcondition_gate: false }).postCheck, false);
  assert.equal(new ToolLoopPolicy({ postcondition_retries: "abc" }).maxPostCheckRetry, 2, "脏配置回落默认而不是 NaN");
  assert.equal(new ToolLoopPolicy({ postcondition_retries: 0 }).maxPostCheckRetry, 0, "0 是合法值 (拦一次即诚实收尾)");
});

// ---- 端到端: 真 PPXAgent 默认带闸门 (注入点在 _llmWithTools) ----
test("(k) 端到端 (真 PPXAgent + 桩 LLM): 无写工具的完成声称不会洗白成交付", async () => {
  const root = mk("k");
  try {
    const a = new PPXAgent({ root, configFile: null });
    a.toolsEnabled = true;
    let n = 0;
    a.llm = {
      apiChat: async () => { n++; return { message: say("已将函数 sum(a, b) 写入并导出到 utils.js。") }; },
    };
    const out = await a._llmWithTools([{ role: "user", content: "把函数 sum(a, b) 写入 utils.js 并导出" }], a.llm);
    assert.equal(n, DEFAULT_MAX_POSTCHECK_RETRY + 1, `恰好用尽修正机会 (1+2), 实测 ${n}`);
    assert.match(out, /^\[后置校验未通过/, "交给用户的第一行就是校验未通过, 不是干净的 done");
    assert.match(out, /claim-without-write/);
    assert.equal(fs.existsSync(path.join(root, "utils.js")), false);
    a.shutdown();
  } finally { rm(root); }
});

// ---- 反馈文案本身 (Anthropic "为 agent 写工具": 错误要可行动) ----
test("(l) 反馈/终稿文案: 可行动, 保留原稿, 不贴裸 traceback", () => {
  const failures = [{ id: "js-node-check", file: "utils.js", gating: true, message: "utils.js: 语法未通过 (node --check): SyntaxError" }];
  const fb = buildVerifyFeedback({ failures, notes: [], attempt: 1, max: 2 });
  assert.match(fb, /二选一/);
  assert.match(fb, /不要原样重复上一条回复/);
  assert.match(fb, /utils\.js/);
  const end = buildVerifyFeedback({ failures, notes: [{ id: "js-export-note", message: "自查: 未发现 export" }], attempt: 2, max: 2 });
  assert.match(end, /第 2\/2 次修正机会/);
  assert.match(end, /只提示, 不拦/);
  assert.ok(!end.includes("\n\n"), "文案紧凑, 不塞空行进上下文");
  const fail = formatGateFailure({ failures, notes: [], attempts: 2, draft: "已完成。" });
  assert.match(fail, /本轮的"已完成"不成立/);
  assert.match(fail, /已完成。\s*$/, "原稿附在末尾供参照");
});

// ---- (m) 复盘第 (3) 类: 没发过读请求就答"共 1 行" ----
test("(m) 未读就报行数: 与磁盘字节不符 → 拦下并给出磁盘真值", async () => {
  const root = mk("m");
  try {
    fs.writeFileSync(path.join(root, "utils.js"), "a\nb\nc\n", "utf8");
    const spawns = [];
    const h = await harness({
      root,
      spawnProbe: spawns,
      userText: "utils.js 一共有多少行?",
      plan: [
        say("utils.js 共 1 行。"),
        say("utils.js 共 3 行。"),
      ],
    });
    assert.equal(h.calls, 2, "拦一次 → 改对 → 收尾");
    const fb = feedbackMsgs(h);
    assert.equal(fb.length, 1);
    assert.match(fb[0].content, /claim-vs-disk-lines/);
    assert.match(fb[0].content, /磁盘当前是 3 行/, "反馈要给可核对的真值, 不是空泛的『别瞎说』");
    assert.equal(eventsOf(h, "tool/postcheck_retry")[0].p.checks[0], "claim-vs-disk-lines");
    assert.equal(h.out, "utils.js 共 3 行。", "改对后原样交付");
    assert.equal(spawns.length, 0, "纯读盘核对, 零子进程");
  } finally { rm(root); }
});

test("(m2) 行数核对的误伤防线: 说对了/差分语境/对象不明/文件不在盘上 → 一律不拦", async () => {
  const root = mk("m2");
  try {
    fs.writeFileSync(path.join(root, "utils.js"), "a\nb\nc\nd\ne\n", "utf8");
    const base = { rootDir: root, calls: [], checkClaim: false, exec: async () => ({ ok: true }) };
    // 1) 数字与磁盘一致
    const ok = await runPostChecks({ ...base, finalMessage: "utils.js 共 5 行。" });
    assert.equal(ok.failures.length, 0, JSON.stringify(ok.failures));
    // 2) "共 3 行"描述的是改动量 (差分语境) → 不判
    const diff = await runPostChecks({ ...base, finalMessage: "utils.js 本次改动共 3 行, 其余未动。" });
    assert.equal(diff.failures.length, 0, JSON.stringify(diff.failures));
    // 3) 点名两个都存在的文件 → 对象不明, 不判
    fs.writeFileSync(path.join(root, "other.js"), "x\n", "utf8");
    const amb = await runPostChecks({ ...base, finalMessage: "utils.js 与 other.js 共 1 行。" });
    assert.equal(amb.failures.length, 0, JSON.stringify(amb.failures));
    // 4) 点名的文件不在盘上 → 算不出真值, 不判 (交给 claim-without-write 那条线)
    const gone = await runPostChecks({ ...base, finalMessage: "ghost.js 共 1 行。" });
    assert.equal(gone.failures.length, 0, JSON.stringify(gone.failures));
    // 5) 压根没报数字 → 不判
    const none = await runPostChecks({ ...base, finalMessage: "utils.js 是一个工具模块。" });
    assert.equal(none.failures.length, 0);
    // 6) 英文句式同样生效
    const en = await runPostChecks({ ...base, finalMessage: "utils.js has 2 lines." });
    assert.equal(en.failures.length, 1, JSON.stringify(en.failures));
    assert.match(en.failures[0].message, /磁盘当前是 5 行/);
  } finally { rm(root); }
});

test("(m3) 行数口径与 wc -l 一致 (CRLF / 末行换行 / 无末行换行)", () => {
  assert.equal(countDiskLines("a\nb\nc\n"), 3);
  assert.equal(countDiskLines("a\r\nb\r\n"), 2);
  assert.equal(countDiskLines("a\nb"), 2);
  assert.equal(countDiskLines(""), 0);
  assert.deepEqual(extractLineTotalClaims("该文件共 12 行, has 12 lines."), [12]);
  assert.deepEqual(extractLineTotalClaims("本次新增共 3 行"), [], "差分语境不提取");
});

// ---- (n) 回合账本的内存护栏: 蒸馏后只留摘要, 判定结论不变 ----
test("(n) 大结果蒸馏: 闸门拿到的是几百字节的摘要而不是原文, 结论一致", async () => {
  const huge = JSON.stringify({ ok: true, bytes: 11, syntax: SYNTAX_PASS_TEXT, content: "x".repeat(300_000), results: [{ file: "a.js", patch: "y".repeat(50_000) }] });
  const small = distillTurnResult(huge);
  assert.ok(small.length < 400, `蒸馏后应远小于原文 (${small.length})`);
  const o = JSON.parse(small);
  assert.equal(o.ok, true); assert.equal(o.bytes, 11); assert.equal(o.syntax, SYNTAX_PASS_TEXT);
  assert.equal(o.results[0].file, "a.js");
  assert.equal(o.content, undefined, "正文不进账本");
  assert.equal(distillTurnResult("[工具错误] 权限拒绝: 命令被拦截").startsWith("[工具错误]"), true, "错误前缀必须保住");
  assert.equal(distillTurnResult("纯文本回执".repeat(200)).length <= 600, true);

  // 蒸馏串走完整判定链, 结论与原文一致
  const root = mk("n");
  try {
    fs.writeFileSync(path.join(root, "a.js"), "let x = 1;\n", "utf8");
    const raw = JSON.stringify({ ok: true, bytes: 11, syntax: SYNTAX_PASS_TEXT, content: "z".repeat(100_000) });
    const a = await runPostChecks({ rootDir: root, calls: [{ name: "write_file", args: { path: "a.js", content: "let x = 1;\n" }, result: raw }] });
    const b = await runPostChecks({ rootDir: root, calls: [{ name: "write_file", args: { path: "a.js", content: "let x = 1;\n" }, result: distillTurnResult(raw) }] });
    assert.deepEqual(b.failures.map((f) => f.id), a.failures.map((f) => f.id));
    assert.equal(b.spawns, 0, "蒸馏后的 syntax 回执照样可采信 → 零子进程");
  } finally { rm(root); }
});

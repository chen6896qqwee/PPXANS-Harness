// test/goal-board-2026-10-05.test.js — goal_board 从"每次调用都抛错"到真正可用
// 钉住的不变量 (2026-10-05 复核出的四处缺口, 逐条对应):
//   ① id: 旧 addGoal 硬性 `if (!id) throw`, 而唯一调用点 src/tools/v3.js 从不传 id →
//      真实调用 100% 失败 (看板从未被写进去)。现在 id 由 src/evidence 用 shortId("g_") 生成。
//   ② 优先级: 工具面小写 p0/p1/p2, 旧 PRIORITY_RANK 键大写, 未知值被静默降成 "P2"
//      —— "p0" 排到队尾而毫无异常信号。现在归一**只发生在** normalizePriority/normalizeStatus:
//      缺省 → 默认档; 给了但不认识 → 抛错 (拒绝, 不降档)。
//   ③ 持久化: 走 src/utils/store.js (锁内读-改-写 + 磁盘∪内存并集 + 损坏现场留档),
//      缺 id 的历史行按**内容哈希**确定性补号 (与 memory/l2.js F8 同一条不变量:
//      并集按 id 取, 随机补号会把一条目标裂成两条, 再覆盖写 = 又一次静默丢数据)。
//   ④ 注入: promptBlock() 空看板返回 "" (固定开销 0 token), 有看板时条数/长度双闸,
//      块内零时间戳 —— 同一份数据每回合同一串字节 (前缀缓存纪律)。
import test from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  createGoalBoard, mergeGoals, normalizePriority, normalizeStatus, deriveGoalId,
  GOAL_PRIORITIES, GOAL_PROMPT_MAX, GOAL_PROMPT_TITLE_MAX, GOAL_MAX_GOALS,
} from "../src/evidence/index.js";
import { PPXAgent } from "../src/agent/index.js";
import { ToolCatalog } from "../src/tools/catalog.js";
import { registerV3Tools } from "../src/tools/v3.js";
import { setLevel } from "../src/utils/logger.js";

setLevel("error"); // 测试输出降噪 (与 prefix-cache-static-region 同一手法)

const tmp = (tag) => fs.mkdtempSync(path.join(os.tmpdir(), `ppx-goal-${tag}-`));
const goalsFile = (dir) => path.join(dir, "evidence", "goals.json");
const rowsOf = (dir) => JSON.parse(fs.readFileSync(goalsFile(dir), "utf8"));
const writeGoals = (dir, rows) => {
  fs.mkdirSync(path.dirname(goalsFile(dir)), { recursive: true });
  fs.writeFileSync(goalsFile(dir), JSON.stringify(rows, null, 2), "utf8");
};
// 与 scripts/ctx-profile.js 同一口径的粗估 (中文 1 字 ≈ 1 tok, 其余 4 字符 ≈ 1 tok)
const estTok = (s) => {
  const t = String(s || "");
  const cjk = (t.match(/[一-鿿]/g) || []).length;
  return Math.round(cjk + (t.length - cjk) / 4);
};

// ===========================================================================
// ① id 生成: 旧缺陷的直接复现与修复
// ===========================================================================
test("① addGoal 不传 id 也能写入 (旧实现每次必抛 \"addGoal 需要 id\")", () => {
  const dir = tmp("id");
  try {
    const b = createGoalBoard({ dataDir: dir });
    const g = b.addGoal({ title: "修复登录", priority: "p0" }); // 与 tools/v3.js 旧调用同形状
    assert.ok(g && g.id, "返回的目标自带 id");
    assert.match(g.id, /^g_/, "id 前缀与 shortId 家族一致");
    assert.equal(b.count(), 1);
    assert.equal(rowsOf(dir).length, 1, "已落盘");
    // 同一条记录在两个实例手里是同一 id (持久化而非各写各的)
    assert.equal(createGoalBoard({ dataDir: dir }).list()[0].id, g.id);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("① 显式 id 是幂等 upsert (不产生第二条同 id 目标, created 保留)", () => {
  const b = createGoalBoard();
  const a1 = b.addGoal({ id: "step-1", title: "定位", priority: "p1" });
  const a2 = b.addGoal({ id: "step-1", title: "定位(改标题)", priority: "p0" });
  assert.equal(b.count(), 1, "同 id 只有一条");
  assert.equal(a2.priority, "P0");
  assert.equal(a2.created, a1.created, "upsert 不刷 created");
});

test("① 同标题不重复成两条 (计划台账里同一句话出现两次只会让模型再决策一遍)", () => {
  const b = createGoalBoard();
  const g1 = b.addGoal({ title: "写文档" });
  const g2 = b.addGoal({ title: "  写文档 " }); // 空白/大小写差异也算同一条
  assert.equal(g2.id, g1.id, "命中既有目标");
  assert.equal(b.count(), 1);
});

// ===========================================================================
// ② 优先级/状态归一: 唯一边界 + 未知值拒绝 (而非静默降档)
// ===========================================================================
test("② 大小写都接受, 且 p0 不再被静默降成 P2 (旧实现把 \"p0\" 排到队尾)", () => {
  assert.equal(normalizePriority("p0"), "P0");
  assert.equal(normalizePriority(" P1 "), "P1");
  assert.equal(normalizePriority("P2"), "P2");
  assert.equal(normalizePriority(undefined), "P2", "缺省 → 默认档");
  const b = createGoalBoard();
  b.addGoal({ title: "低", priority: "p2" });
  b.addGoal({ title: "急", priority: "p0" });
  b.addGoal({ title: "中", priority: "P1" });
  assert.deepEqual(b.list().map((g) => g.priority), ["P0", "P1", "P2"], "排序按真实优先级");
  assert.equal(b.list()[0].title, "急", "p0 排在最前 (旧实现在这里给 P2)");
});

test("② 未知优先级/状态: 抛错, 不降档 (缺省才是默认档, 给了就要认)", () => {
  assert.throws(() => normalizePriority("urgent"), /未知优先级/);
  assert.throws(() => normalizeStatus("finished"), /未知状态/);
  const b = createGoalBoard();
  assert.throws(() => b.addGoal({ title: "x", priority: "highest" }), /未知优先级/);
  assert.throws(() => b.addGoal({ title: "x", status: "wip" }), /未知状态/);
  assert.equal(b.count(), 0, "被拒的 add 不留半成品");
  assert.equal(b.file(), null, "纯内存看板没有文件");
  const dir = tmp("reject");
  try {
    const p = createGoalBoard({ dataDir: dir });
    p.addGoal({ title: "落我", priority: "p1" });
    assert.throws(() => p.addGoal({ title: "坏值", priority: "???" }), /未知优先级/);
    assert.deepEqual(rowsOf(dir).map((r) => r.title), ["落我"], "非法值不写盘 (前一次状态完好)");
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("② 状态未知在 update 也一致拒绝; updateGoal 支持改优先级/标题", () => {
  const b = createGoalBoard();
  const g = b.addGoal({ title: "任务A", priority: "p2" });
  assert.throws(() => b.updateStatus(g.id, "nonsense"), /未知状态/);
  assert.equal(b.get(g.id).priority, "P2", "抛错的目标没被改动");
  assert.equal(b.updateGoal(g.id, { priority: "p0", status: "in_progress" }).priority, "P0");
  assert.equal(b.updateStatus(g.id, "done").status, "done");
  assert.equal(b.updateGoal("不存在的 id", { status: "done" }), null, "未知 id 返回 null");
});

test("② 排序是全序且与插入顺序无关 (优先级 → 状态 → 标题字节序 → id)", () => {
  // 同标题的两条只能来自盘上手写/旧数据 (addGoal 会按标题并成一条), 所以这里直接喂盘上形态:
  // 它们的先后必须落到 id 字节序, 否则同一份数据在不同进程渲染出不同字节 → 前缀缓存分叉。
  const rows = [
    { id: "a", title: "甲", priority: "P1", status: "in_progress" },
    { id: "z", title: "乙", priority: "P1", status: "pending" },
    { id: "m", title: "丙", priority: "P1", status: "blocked" },
    { id: "k", title: "收尾", priority: "P0", status: "pending" },
    { id: "j", title: "收尾", priority: "P0", status: "pending" },
  ];
  const loadOf = (list) => {
    const dir = tmp("order");
    writeGoals(dir, list);
    return { dir, board: createGoalBoard({ dataDir: dir }) };
  };
  const x = loadOf(rows);
  const y = loadOf([...rows].reverse());
  try {
    const ids = x.board.list().map((g) => g.id);
    assert.deepEqual(ids, ["j", "k", "a", "z", "m"], "P0 在前; 同优先级按 在办>待办>受阻; 同标题按 id 字节序");
    assert.deepEqual(y.board.list().map((g) => g.id), ids, "插入顺序不影响渲染次序");
    assert.equal(x.board.promptBlock(), y.board.promptBlock(), "注入块字节级一致");
    assert.ok(x.board.promptBlock().indexOf("甲") < x.board.promptBlock().indexOf("丙"), "在办排在受阻之前");
  } finally {
    fs.rmSync(x.dir, { recursive: true, force: true });
    fs.rmSync(y.dir, { recursive: true, force: true });
  }
});

// ===========================================================================
// ③ 持久化 + 缺 id 行的确定性补号 (F8 同一不变量)
// ===========================================================================
test("③ 落盘/重载: 进程换了目标不丢, 稳态构造零写盘", () => {
  const dir = tmp("persist");
  try {
    const b = createGoalBoard({ dataDir: dir });
    b.addGoal({ title: "步骤一", priority: "p0" });
    b.addGoal({ title: "步骤二", priority: "p1", status: "in_progress" });
    const before = fs.readFileSync(goalsFile(dir), "utf8");
    const again = createGoalBoard({ dataDir: dir });
    assert.deepEqual(again.list().map((g) => g.title), ["步骤一", "步骤二"], "重启后计划还在");
    assert.equal(fs.readFileSync(goalsFile(dir), "utf8"), before, "常态 (全部有 id) 构造期一个字节都不写");
    assert.ok(rowsOf(dir).every((r) => r.id && r.priority && r.status), "落盘形态规范");
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("③ 内存看板 (无 dataDir) 保持旧行为: 不落盘、可读写", () => {
  const b = createGoalBoard();
  const g = b.addGoal({ title: "只在内存" });
  assert.equal(b.get(g.id).title, "只在内存");
  assert.equal(b.file(), null, "无 dataDir → 无文件 (向后兼容旧调用)");
});

test("③ 缺 id 的历史行: 确定性补号 (内容哈希) 并一次性落盘, 两侧各补一次不裂成两条", () => {
  const dir = tmp("backfill");
  try {
    writeGoals(dir, [
      { title: "老目标", priority: "P0", status: "pending" },          // 缺 id
      { id: "g_keep", title: "有 id 的老目标", priority: "P1", status: "done" },
    ]);
    const b = createGoalBoard({ dataDir: dir });
    assert.equal(b.count(), 2, "一条不少");
    assert.ok(rowsOf(dir).every((r) => r.id), "盘上不再有缺 id 的行");
    const fixed = b.list().find((g) => g.title === "老目标");
    assert.equal(fixed.id, deriveGoalId({ title: "老目标", priority: "P0", status: "pending" }));
    assert.match(fixed.id, /^g_h[0-9a-z]{7}$/, "补号是 g_h + 内容哈希 (不是随机号)");
    // 另一个进程面对同一条缺 id 行 → 补出同一个号 → 并集认出是同一条, 不裂
    const rows = [{ title: "老目标", priority: "P0", status: "pending" }];
    assert.equal(mergeGoals(rows, []).length, 1);
    assert.equal(mergeGoals(rows, rows).length, 1, "两侧各补一次号仍是条");
    assert.deepEqual(mergeGoals(rows, []).find((g) => g.title === "老目标").id, fixed.id);
    // 内容不同 → 不同号 (不是常量)
    assert.notEqual(mergeGoals([{ title: "别的", priority: "P2", status: "pending" }], [])[0].id, fixed.id);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("③ 并集不丢别的进程新增的目标 (陈旧内存写盘 = 丢更新, 与 F8 同一类)", () => {
  const dir = tmp("union");
  try {
    const stale = createGoalBoard({ dataDir: dir });      // 内存: 空
    const other = createGoalBoard({ dataDir: dir });
    other.addGoal({ title: "别人加的一步", priority: "p1" });
    stale.addGoal({ title: "我加的一步", priority: "p0" });  // 基于过期内存写入, 仍不带丢对方
    const titles = createGoalBoard({ dataDir: dir }).list().map((g) => g.title).sort();
    assert.deepEqual(titles, ["别人加的一步", "我加的一步"], "两边的目标并集都在");
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("③ 损坏文件: 原地留档 .corrupt-<ts> 后才写新状态 (不把坏现场静默覆盖成空)", () => {
  const dir = tmp("corrupt");
  try {
    writeGoals(dir, [{ id: "g_x", title: "完好的一半" }]);
    const raw = fs.readFileSync(goalsFile(dir), "utf8");
    fs.writeFileSync(goalsFile(dir), raw.slice(0, Math.floor(raw.length / 2)), "utf8"); // 截断成半截 JSON
    const b = createGoalBoard({ dataDir: dir });
    assert.equal(b.count(), 0, "半截文件读不出内容 (但现场保留)");
    assert.ok(fs.existsSync(goalsFile(dir)), "损坏文件仍在原位");
    b.addGoal({ title: "新目标" });
    const archives = fs.readdirSync(path.dirname(goalsFile(dir))).filter((f) => f.includes(".corrupt-"));
    assert.equal(archives.length, 1, "覆盖前先留档一份");
    assert.ok(fs.readFileSync(goalsFile(dir), "utf8").includes("新目标"));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("③ 看板满了显式报错, 不静默淘汰任何一条目标", () => {
  const b = createGoalBoard({ maxGoals: 3 });
  b.addGoal({ title: "1" }); b.addGoal({ title: "2" }); b.addGoal({ title: "3" });
  assert.throws(() => b.addGoal({ title: "4" }), /目标看板已满/);
  assert.equal(b.count(), 3, "一条都没被挤掉");
  assert.equal(GOAL_MAX_GOALS, 50, "默认容量是显式常量");
});

// ===========================================================================
// ④ 注入块: 空板 0 token / 有界 / 零时间戳 / 字节可重入
// ===========================================================================
test("④ 空看板 → promptBlock 返回空串 (固定开销恰 0 token)", () => {
  assert.equal(createGoalBoard().promptBlock(), "");
  const dir = tmp("empty-prompt");
  try {
    assert.equal(createGoalBoard({ dataDir: dir }).promptBlock(), "");
    assert.equal(fs.existsSync(path.join(dir, "evidence", "goals.json")), false,
      "空看板从不落盘 (构造即写 = 每轮磁盘活动)");
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("④ 注入块有界 (条数 + 单条长度), 且同一份数据两次渲染逐字节相同", () => {
  const b = createGoalBoard();
  for (let i = 0; i < GOAL_PROMPT_MAX + 5; i++) {
    b.addGoal({ title: "这是一个故意写得很长的目标标题用于验证截断".repeat(3) + i, priority: `p${i % 3}` });
  }
  const block = b.promptBlock();
  const lines = block.split("\n");
  assert.equal(lines.length - 2, GOAL_PROMPT_MAX, `只列 ${GOAL_PROMPT_MAX} 条, 其余交给 goal_board list`);
  assert.match(lines[lines.length - 1], /另有 5 条未列出/);
  for (const l of lines.slice(1, 1 + GOAL_PROMPT_MAX)) {
    const title = l.replace(/^- \w+ \w+ /, "").replace(/ #\S+$/, "");
    assert.ok(title.length <= GOAL_PROMPT_TITLE_MAX + 1, `单条标题被截到 ${GOAL_PROMPT_TITLE_MAX} 字: ${title.length}`);
  }
  assert.equal(block, b.promptBlock(), "重复调用字节相同");
  assert.ok(!/\d{4}-\d{2}-\d{2}/.test(block), "块内零日期形态 (不重蹈 logicalDay 每日作废缓存)");
  assert.ok(estTok(block) < 700, `最坏情况成本有界 (实测 ${estTok(block)} tok)`);
});

test("④ 接线: 目标进 system prompt 的**动态尾部**, 静态区一个字节都不动", () => {
  const dir = tmp("inject");
  try {
    fs.mkdirSync(path.join(dir, "config"), { recursive: true });
    fs.writeFileSync(path.join(dir, "config", "ppx.json"), JSON.stringify({ providers: [] }), "utf8");
    const a = new PPXAgent({ root: process.cwd(), configFile: null, dataDir: dir, globalDataDir: dir });
    try {
      assert.ok(a.goalBoard.file(), "agent 装配的看板是持久化看板 (拿到 dataDir)");
      const empty = a._context("随便问个问题");
      assert.ok(!empty.includes("【目标看板】"), "空看板不注入");
      const staticEmpty = empty.split("\n# 今日对话")[0];
      a.goalBoard.addGoal({ title: "第一步: 读文件", priority: "p0" });
      const full = a._context("随便问个问题");
      assert.ok(full.includes("第一步: 读文件"), "目标出现在 system prompt");
      assert.equal(full.split("\n# 今日对话")[0], staticEmpty, "静态前缀逐字节不变 (缓存前缀不被作废)");
      assert.ok(full.indexOf("【目标看板】") > full.indexOf("# 今日对话"), "注入块在动态尾部 (检索段之后)");
      const delta = estTok(full) - estTok(empty);
      assert.ok(delta > 0 && delta < 250, `单条目标的代价可预算 (实测 ${delta} tok)`);
      a.goalBoard.updateStatus(a.goalBoard.list()[0].id, "done");
      const doneAgain = a._context("随便问个问题");
      assert.ok(doneAgain.includes("done 第一步"), "状态变更下一轮即反映 (同一进程内也重算)");
    } finally { a.shutdown(); fs.rmSync(dir, { recursive: true, force: true }); }
  } finally { /* dir 已在上方清理 */ }
});

test("④ 跨进程可见: 另一个实例写的目标会被对表读到 (mtimeNs+size 闸门)", () => {
  const dir = tmp("resync");
  try {
    fs.mkdirSync(path.join(dir, "config"), { recursive: true });
    fs.writeFileSync(path.join(dir, "config", "ppx.json"), JSON.stringify({ providers: [] }), "utf8");
    const a = new PPXAgent({ root: process.cwd(), configFile: null, dataDir: dir, globalDataDir: dir });
    try {
      const other = createGoalBoard({ dataDir: dir });
      other.addGoal({ title: "另一进程的一步" });
      assert.ok(a._context("问一个问题").includes("另一进程的一步"), "只读对表把别人的目标并进来");
    } finally { a.shutdown(); fs.rmSync(dir, { recursive: true, force: true }); }
  } finally { /* dir 已在上方清理 */ }
});

// ===========================================================================
// ⑤ 工具面 (goal_board): 走真实 catalog 收口, 不再抛错
// ===========================================================================
test("⑤ 工具 add/update/list 全程可用, 非法优先级返回可行动错误而非崩溃", async () => {
  const dir = tmp("tool");
  try {
    const board = createGoalBoard({ dataDir: dir });
    const catalog = new ToolCatalog();
    registerV3Tools(catalog, { rootDir: process.cwd(), agent: { goalBoard: board } });
    const add = JSON.parse(await catalog.call("goal_board", { action: "add", title: "定位失败分支", priority: "p1" }));
    assert.equal(add.ok, true, "旧实现在这里是 throw → [工具错误]");
    assert.match(add.goal.id, /^g_/);
    assert.equal(add.goal.priority, "P1", "小写入参归一成规范档位");
    const dup = JSON.parse(await catalog.call("goal_board", { action: "add", title: "定位失败分支" }));
    assert.equal(dup.already_present, true, "同标题被认出来并告诉模型");
    const upd = JSON.parse(await catalog.call("goal_board", { action: "update", id: add.goal.id, status: "in_progress" }));
    assert.equal(upd.ok, true);
    assert.equal(upd.goal.status, "in_progress");
    const badPr = JSON.parse(await catalog.call("goal_board", { action: "add", title: "坏值", priority: "P3" }));
    assert.equal(badPr.ok, false, "未知优先级显式失败 (不静默降档)");
    assert.match(badPr.error, /未知优先级/);
    assert.equal(board.get(add.goal.id).priority, "P1", "失败的调用没改动既有目标");
    const lost = JSON.parse(await catalog.call("goal_board", { action: "update", id: "g_不存在", status: "done" }));
    assert.equal(lost.ok, false, "未知 id 也是明确的失败");
    const list = JSON.parse(await catalog.call("goal_board", { action: "list" }));
    assert.equal(list.count, 1);
    assert.ok(list.text.includes("# 目标看板"), "渲染文本仍供 Web UI / 模型回看");
    assert.equal(list.goals[0].status, "in_progress");
    assert.ok(!("load_issues" in list), "一切规范时不带 issues");
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("⑤ 工具 schema 不再用 enum 卡死大小写 (store 那道边界才是判定处)", () => {
  const catalog = new ToolCatalog();
  registerV3Tools(catalog, { rootDir: process.cwd(), agent: { goalBoard: createGoalBoard() } });
  const params = catalog.tools.get("goal_board").parameters.properties;
  assert.ok(!params.priority.enum, "优先级不设 enum (大小写均可, 未知值由 normalizePriority 拒绝)");
  assert.deepEqual(params.status.enum, [...GOAL_STATUSES_EXPECTED], "状态仍给候选值 (模型少猜)");
});

test("⑤ 盘上的非规范行被修好但明说 (load_issues 带回调用方, 不静默)", async () => {
  const dir = tmp("issues");
  try {
    writeGoals(dir, [{ id: "g_bad", title: "手写坏值", priority: "critical", status: "wip" }]);
    const board = createGoalBoard({ dataDir: dir });
    assert.equal(board.count(), 1, "坏行不丢");
    assert.equal(board.list()[0].priority, "P2", "载入时归一到默认档");
    assert.equal(board.loadIssues().length, 2, "优先级+状态各记一条");
    const catalog = new ToolCatalog();
    registerV3Tools(catalog, { rootDir: process.cwd(), agent: { goalBoard: board } });
    const list = JSON.parse(await catalog.call("goal_board", { action: "list" }));
    assert.ok(Array.isArray(list.load_issues) && list.load_issues.length === 2, "list 把 issues 吐回去");
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

// 工具 schema 里状态候选值的期望 (单独写死: 改动 GOAL_STATUSES 时这条会红, 逼一次确认)
const GOAL_STATUSES_EXPECTED = ["pending", "in_progress", "blocked", "done"];

test("⑤ 目标集合是显式常量 (p0/p1/p2 三档 + 四状态), 归一表与之同源", () => {
  assert.deepEqual([...GOAL_PRIORITIES], ["P0", "P1", "P2"]);
  assert.equal(normalizePriority("p0"), GOAL_PRIORITIES[0]);
});

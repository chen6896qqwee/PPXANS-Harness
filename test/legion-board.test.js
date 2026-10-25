// test/legion-board.test.js - 军团共享记忆板守卫 (2026-10-02)
import test from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { LegionBoard } from "../src/memory/index.js";

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "ppx-board-"));
}

test("记忆板: 发布 → 其他实例实时可见 (跨进程共享语义)", () => {
  const dir = tmpDir();
  const a = new LegionBoard(dir); // 模拟主 agent
  const b = new LegionBoard(dir); // 模拟 worker (同一全局目录)
  a.publish({ from: "主 agent", topic: "数据分析", content: "数据源在 /data/sales.csv", tags: ["数据"] });
  // 关键: b 是独立实例 (独立进程的等价物), 不重载也能读到 a 刚写的
  const rs = b.query({ q: "sales.csv" });
  assert.equal(rs.length, 1);
  assert.equal(rs[0].from, "主 agent");
  assert.equal(rs[0].content, "数据源在 /data/sales.csv");
});

test("记忆板: topic/from/关键词过滤 + 新的在前", () => {
  const dir = tmpDir();
  const board = new LegionBoard(dir);
  board.publish({ from: "a1", topic: "审查", content: "发现空指针风险" });
  board.publish({ from: "a2", topic: "实施", content: "补丁已应用" });
  board.publish({ from: "a1", topic: "审查", content: "测试覆盖不足" });
  assert.equal(board.query({ topic: "审查" }).length, 2);
  assert.equal(board.query({ from: "a2" })[0].content, "补丁已应用");
  assert.equal(board.query({ q: "空指针" }).length, 1);
  // 排序: 最新在前
  const all = board.query({});
  assert.ok(all[0].ts >= all[all.length - 1].ts);
});

test("记忆板: 并发发布不丢条目 (文件锁串行化)", async () => {
  const dir = tmpDir();
  const boards = Array.from({ length: 4 }, () => new LegionBoard(dir)); // 4 个"进程"
  await Promise.all(
    boards.flatMap((b, i) =>
      Array.from({ length: 10 }, (_, j) =>
        Promise.resolve().then(() => b.publish({ from: `agent${i}`, content: `条目 ${i}-${j}` }))
      )
    )
  );
  const stats = new LegionBoard(dir).stats();
  assert.equal(stats.count, 40, "40 次并发发布应全部落盘");
  assert.equal(stats.agents.length, 4);
});

test("记忆板: 容量裁剪 (FIFO) + 空内容拒绝", () => {
  const dir = tmpDir();
  const board = new LegionBoard(dir, { maxEntries: 5, ttlDays: 0 });
  for (let i = 0; i < 10; i++) board.publish({ from: "x", content: `条目 ${i}` });
  const rs = board.query({ limit: 50 });
  assert.equal(rs.length, 5);
  assert.ok(rs.every((r) => Number(r.content.split(" ")[1]) >= 5), "应裁掉最旧的 5 条");
  assert.throws(() => board.publish({ from: "x", content: "  " }), /content 不能为空/);
});

// --- share_board 接线守卫 (spawn_agent 自动发板 + 仲裁读板) ---
import { publishToBoard, arbitrateWithBoard } from "../src/tools/delegate.js";

test("publishToBoard: 正常发布可见 / null 板不炸 / 板异常吞掉", () => {
  const dir = tmpDir();
  const board = new LegionBoard(dir);
  publishToBoard(board, { from: "侦察兵", topic: "侦察", task: "找入口", reply: "入口在 src/server.js" });
  assert.ok(board.query({ q: "src/server.js" }).length === 1, "结论应上板");
  // null 板: 不炸
  assert.doesNotThrow(() => publishToBoard(null, { from: "x", topic: "t", task: "a", reply: "b" }));
  // 板异常 (reply 非法转空): 吞掉不炸
  assert.doesNotThrow(() => publishToBoard(board, { from: "x", topic: "t", task: "a", reply: undefined }));
});

test("arbitrateWithBoard: 仲裁提示注入记忆板上下文; 板空/无板退化为纯仲裁", async () => {
  const dir = tmpDir();
  const board = new LegionBoard(dir);
  board.publish({ from: "侦察兵", topic: "侦察", content: "[完成] 任务: 找入口 → 结论: 入口在 src/server.js" });
  let captured = "";
  const fakeAgent = { llm: { chat: async (msgs) => { captured = msgs[msgs.length - 1].content; return { content: "仲裁结论" }; } } };
  const out = await arbitrateWithBoard(fakeAgent, ["任务A"], ["结果A"], [], "", { board, shareBoard: true, boardTopic: "侦察" });
  assert.equal(out, "仲裁结论");
  assert.ok(captured.includes("【军团记忆板 (本角色近期发布)】"), "仲裁提示应含记忆板段");
  assert.ok(captured.includes("入口在 src/server.js"), "仲裁提示应含板上条目");
  // 板空: 不注入
  let captured2 = "";
  const emptyAgent = { llm: { chat: async (msgs) => { captured2 = msgs[msgs.length - 1].content; return { content: "ok" }; } } };
  await arbitrateWithBoard(emptyAgent, ["任务A"], ["结果A"], [], "", { board, shareBoard: true, boardTopic: "无此频道" });
  assert.ok(!captured2.includes("军团记忆板"), "空板不注入");
  // 无板: 纯仲裁照常
  const plain = await arbitrateWithBoard(fakeAgent, ["任务A"], ["结果A"], [], "", { board: null, shareBoard: true, boardTopic: "x" });
  assert.ok(plain, "无板退化仲裁不炸");
});

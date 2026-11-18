// test/channels-pure-2026-11-16.test.js — 通道簇纯函数 (output / receipts / workspace / telegram 分段)
// 全部无网络: IM 降噪、投递回执事件、工作区树/读写/@引用/搜索、Telegram 4096 分段。
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { shapeForChannel } from "../src/channels/output.js";
import { receiptId, createDeliveryReceipts, DEFAULT_SYNC_DEADLINE_MS } from "../src/channels/receipts.js";
import { buildTree, readWorkspaceFile, writeWorkspaceFile, buildFileRefBlock, searchWorkspace } from "../src/channels/workspace.js";
import { splitTelegramMessage } from "../src/channels/telegram.js";

function tmp(tag = "ch") {
  return fs.mkdtempSync(path.join(os.tmpdir(), `ppx-${tag}-`));
}
function put(root, rel, content) {
  const p = path.join(root, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content);
}

// ---- output.js: IM 降噪 ----

test("output: 非IM信道逐字保真", () => {
  const text = "### 标题\n**粗体**\n```js\ncode\n```";
  assert.equal(shapeForChannel("github", text, {}), text);
});

test("output: IM信道剥离markdown修饰但保留内容", () => {
  const text = "### 计划\n**第一步** `run` x  \n\n\n\n```js\nconst a = 1;\n```\n*尾注*";
  const out = shapeForChannel("feishu", text, {});
  assert.ok(out.includes("【计划】"));
  assert.ok(out.includes("第一步"));
  assert.ok(out.includes("run"));
  assert.ok(out.includes("const a = 1;"));
  assert.ok(out.includes("尾注"));
  assert.ok(!out.includes("**"), "不应残留 **");
  assert.ok(!out.includes("```"), "不应残留围栏行");
  assert.ok(!out.includes("### "), "标题应转【】");
  assert.ok(!/\n{3,}/.test(out), "空行应折叠");
});

test("output: im_flatten=false 关闭降噪; 截断诚实标注", () => {
  const text = "**keep**";
  assert.equal(shapeForChannel("feishu", text, { im_flatten: false }), text);
  const long = shapeForChannel("feishu", "x".repeat(30), { im_max_chars: 10 });
  assert.ok(long.startsWith("x".repeat(10)));
  assert.match(long, /已截断: 全文共 30 字符/);
  assert.equal(shapeForChannel("feishu", "x".repeat(5), { im_max_chars: 10 }).length, 5);
});

// ---- receipts.js: 投递回执 ----

test("receipts: receiptId 身份格式; 无身份不产事件", () => {
  assert.equal(receiptId("a1", 2, "delivered"), "a1:2:delivered");
  const receipts = createDeliveryReceipts({ emit: () => {} });
  assert.equal(receipts.accepted({}), null);
  assert.equal(receipts.delivered({}), null);
});

test("receipts: 工单身份回执字段与 emit 副通道", () => {
  const events = [];
  const receipts = createDeliveryReceipts({ emit: (type, body, meta) => events.push({ type, body, meta }), now: () => 1700000000000 });
  const ctx = { ticketId: "t1", assignmentId: "as1", attempt: 2, channel: "feishu", sessionKey: "s1" };
  const body = receipts.accepted(ctx, { acceptedAt: "x" });
  assert.equal(body.ticketId, "t1");
  assert.equal(body.assignmentId, "as1");
  assert.equal(body.attempt, 2);
  assert.equal(body.receiptId, "as1:2:accepted");
  assert.equal(body.origin, "ingress");
  assert.equal(body.acceptedAt, "x");
  assert.equal(events[0].type, "delivery_accepted");
  assert.equal(events[0].meta.assignmentId, "as1");
  assert.equal(events[0].meta.sessionKey, "s1");
  const d = receipts.delivered(ctx, { providerMessageId: "pm_1" });
  assert.equal(d.providerMessageId, "pm_1");
  const f = receipts.failed(ctx, { error: { kind: "timeout", message: "t", retryable: true }, willRetry: true });
  assert.equal(f.error.kind, "timeout");
  assert.equal(f.willRetry, true);
  const f2 = receipts.failed(ctx, { error: "boom" });
  assert.equal(f2.error.kind, "send_error");
  assert.equal(f2.error.retryable, false);
  const dl = receipts.deadLetter(ctx, { reason: "delivery_timeout", finalError: { kind: "timeout", message: "t" } });
  assert.equal(dl.reason, "delivery_timeout");
});

test("receipts: ANS notify 用 deliveryId 身份; emit 抛错被吞", () => {
  let boom = false;
  const receipts = createDeliveryReceipts({ emit: () => { boom = true; throw new Error("sink down"); } });
  const ctx = { deliveryId: "d1", attempt: 0, channel: "feishu" };
  const body = receipts.accepted(ctx);
  assert.equal(body.deliveryId, "d1");
  assert.equal(body.ticketId, undefined);
  assert.equal(body.receiptId, "d1:0:accepted");
  assert.equal(boom, true);
});

test("receipts: sendSync 成功/失败/超时/缺 send", async () => {
  const events = [];
  const receipts = createDeliveryReceipts({ emit: (type, body) => events.push({ type, body }) });
  const ok = await receipts.sendSync({
    send: async () => ({ message_id: "pm9" }),
    ticketId: "t1", assignmentId: "as1", channel: "feishu", to: "c1", text: "hi",
    meta: { thread: "th", replyTo: "r1" },
  });
  assert.equal(ok.message_id, "pm9");
  const types = events.map((e) => e.type);
  assert.ok(types.includes("delivery_accepted"));
  assert.ok(types.includes("delivery_delivered"));
  const deliveredBody = events.find((e) => e.type === "delivery_delivered").body;
  assert.equal(deliveredBody.providerMessageId, "pm9");
  events.length = 0;
  const failSink = receipts; // 同一实现, 失败路径
  const failEvents = [];
  const receipts2 = createDeliveryReceipts({ emit: (type, body) => failEvents.push({ type, body }) });
  await assert.rejects(receipts2.sendSync({
    send: async () => { throw new Error("send down"); },
    ticketId: "t2", assignmentId: "as2",
  }), /send down/);
  assert.ok(failEvents.some((e) => e.type === "delivery_failed"));
  const dead = failEvents.find((e) => e.type === "delivery_dead_letter");
  assert.equal(dead.body.reason, "delivery_timeout");
  const failOnly = failEvents.find((e) => e.type === "delivery_failed").body;
  assert.equal(failOnly.error.kind, "send_error");
  assert.equal(failOnly.error.retryable, false);
  const receipts3 = createDeliveryReceipts({ emit: () => {} });
  await assert.rejects(receipts3.sendSync({
    send: () => new Promise(() => {}),
    ticketId: "t3", assignmentId: "as3", deadlineMs: 25,
  }), /投递超时 \(25ms\)/);
  assert.equal(DEFAULT_SYNC_DEADLINE_MS, 30000);
  await assert.rejects(receipts3.sendSync({}), /send 必填/);
});

// ---- workspace.js: 树/读写/@引用/搜索 ----

test("workspace: buildTree 跳过重目录/隐藏项, 尊重深度与子树", () => {
  const root = tmp("ws-tree");
  try {
    put(root, "a.txt", "A");
    put(root, "dir/sub/b.txt", "B");
    put(root, "node_modules/x.js", "X");
    put(root, "data/x.json", "{}");
    put(root, ".git/config", "g");
    put(root, ".hidden", "h");
    const full = buildTree(root, { maxDepth: 4 });
    const collect = (node, acc = []) => {
      acc.push(node.path || "/");
      for (const c of node.children || []) collect(c, acc);
      return acc;
    };
    const names = collect(full.tree);
    assert.ok(names.includes("a.txt"));
    assert.ok(names.includes("dir/sub/b.txt"));
    assert.ok(!names.some((p) => p.includes("node_modules")));
    assert.ok(!names.some((p) => p.includes(".hidden")));
    const shallow = buildTree(root, { maxDepth: 1 });
    const dirNode = shallow.tree.children.find((c) => c.name === "dir");
    assert.deepEqual(dirNode.children, [], "深度截断处不展开子节点");
    const sub = buildTree(root, { root: "dir" });
    assert.equal(sub.tree.name, "dir");
    assert.ok(sub.tree.children.some((c) => c.name === "sub"));
    assert.equal(full.truncated, false);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("workspace: 读写越界/缺失/超限", () => {
  const root = tmp("ws-io");
  try {
    writeWorkspaceFile(root, "dir/nested/a.txt", "hello");
    const read = readWorkspaceFile(root, "dir/nested/a.txt");
    assert.equal(read.content, "hello");
    assert.equal(read.size, 5);
    assert.equal(read.truncated, false);
    assert.throws(() => readWorkspaceFile(root, "missing.txt"), /文件不存在/);
    assert.throws(() => readWorkspaceFile(root, "dir"), /文件不存在/);
    fs.writeFileSync(path.join(root, "big.bin"), Buffer.alloc(300 * 1024, 1));
    const big = readWorkspaceFile(root, "big.bin");
    assert.equal(big.truncated, true);
    assert.equal(big.content.length, 256 * 1024);
    assert.throws(() => writeWorkspaceFile(root, "", "x"), /缺少 path/);
    assert.throws(() => writeWorkspaceFile(root, "../evil.txt", "x"), /路径越界/);
    assert.throws(() => readWorkspaceFile(root, "../../etc/hosts"), /路径越界/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("workspace: symlink 指向工作区外必须被拦", () => {
  const root = tmp("ws-link");
  const outside = tmp("ws-outside");
  try {
    fs.writeFileSync(path.join(outside, "secret.txt"), "s");
    let ok = true;
    try { fs.symlinkSync(outside, path.join(root, "link"), "junction"); } catch { ok = false; }
    if (ok) assert.throws(() => readWorkspaceFile(root, "link/secret.txt"), /路径越界/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  }
});

test("workspace: buildFileRefBlock 数量/二进制/总量上限", () => {
  const root = tmp("ws-ref");
  try {
    assert.equal(buildFileRefBlock(root, []), "");
    put(root, "a.txt", "内容A\n");
    const one = buildFileRefBlock(root, ["a.txt"]);
    assert.match(one, /\[引用文件\]/);
    assert.match(one, /--- @a\.txt ---/);
    assert.match(one, /内容A/);
    for (let i = 0; i < 9; i++) put(root, `f${i}.txt`, "x");
    assert.throws(() => buildFileRefBlock(root, Array.from({ length: 9 }, (_, i) => `f${i}.txt`)), /最多引用/);
    assert.throws(() => buildFileRefBlock(root, ["missing.txt"]), /引用文件不可读/);
    fs.writeFileSync(path.join(root, "bin.txt"), Buffer.from([0x41, 0x00, 0x42]));
    assert.throws(() => buildFileRefBlock(root, ["bin.txt"]), /二进制/);
    for (let i = 0; i < 5; i++) put(root, `big${i}.txt`, "y".repeat(12 * 1024));
    const block = buildFileRefBlock(root, ["big0.txt", "big1.txt", "big2.txt", "big3.txt", "big4.txt"]);
    assert.ok(block.includes("已省略"), "超总量部分应诚实标注");
    assert.ok(!block.includes("--- @big4.txt ---\n" + "y".repeat(100)), "被省略的文件不进正文");
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("workspace: searchWorkspace 文件名优先/内容命中带行号/跳过隐藏", () => {
  const root = tmp("ws-search");
  try {
    put(root, "plan.md", "# 计划\nhello world");
    put(root, "hello.txt", "hello 文件名命中");
    put(root, "dir/nested/other.txt", "say hello world twice");
    put(root, "hello-hidden/ignore.txt", "hello");
    put(root, ".hidden.txt", "hello");
    put(root, "dist/app.js", "hello");
    const r = searchWorkspace(root, "hello", { limit: 10 });
    assert.ok(r.results.some((x) => x.path === "hello.txt" && x.match === "name"));
    const planHit = r.results.find((x) => x.path === "plan.md");
    assert.equal(planHit.match, "content");
    assert.equal(planHit.line, 2);
    const content = r.results.find((x) => x.path === "dir/nested/other.txt");
    assert.equal(content.match, "content");
    assert.equal(content.line, 1, "单行文件命中行号是 1");
    assert.ok(!r.results.some((x) => x.path.includes(".hidden")));
    assert.ok(!r.results.some((x) => x.path.includes("dist/")));
    assert.equal(searchWorkspace(root, "  ").results.length, 0);
    const limited = searchWorkspace(root, "hello", { limit: 1 });
    assert.equal(limited.results.length, 1);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

// ---- telegram.js: 4096 分段 ----

test("telegram: splitTelegramMessage 短文/硬切/换行优先", () => {
  assert.deepEqual(splitTelegramMessage("hi"), ["hi"]);
  const hard = splitTelegramMessage("x".repeat(4500));
  assert.equal(hard.length, 2);
  assert.equal(hard[0].length, 4000);
  assert.equal(hard[0] + hard[1], "x".repeat(4500));
  const body = "a".repeat(3000) + "\n" + "b".repeat(3000);
  const withBreak = splitTelegramMessage(body);
  assert.equal(withBreak.length, 2);
  assert.equal(withBreak[0].length, 3000, "优先在换行处断");
  const small = splitTelegramMessage("y".repeat(30), 20);
  assert.equal(small[0].length, 20);
  assert.ok(small.every((c) => c.length <= 20));
});

// test/session-daily-shard.test.js - default 会话按天分片 (第九轮 review P2)
// 覆盖: 跨天 append 后 deriveMessages 顺序 / deriveCompacted 跨天 /
//       重新 new SessionStore 能从多分片恢复 / 旧 default.jsonl 兼容 /
//       delete/list 处理分片 / flush 只追加当天 / fork 跨天边界
import test from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { SessionStore, EVENTS } from "../src/memory/session.js";

function tmp() { return fs.mkdtempSync(path.join(os.tmpdir(), "ppx-shard-")); }
// 固定某天的本地自然日时间戳 (YYYY, M, D, 小时可走样避开当天)
function dayTs(y, m, d) {
  // 用本地时区构造该日中午, 避免跨日起点边界歧义
  return new Date(y, m - 1, d, 12, 0, 0, 0).getTime();
}
function shard(d, name) { return path.join(d, "sessions", name); }
function files(d) {
  return fs.readdirSync(path.join(d, "sessions")).filter((f) => f.endsWith(".jsonl")).sort();
}

test("P2: default 跨天 append 自动分片, deriveMessages 顺序正确", () => {
  const d = tmp();
  const s = new SessionStore(d);
  const t1 = dayTs(2026, 8, 15);
  const t2 = dayTs(2026, 8, 16);
  const t3 = dayTs(2026, 8, 17);
  s.append("default", EVENTS.USER, { content: "第1天" }, t1);
  s.append("default", EVENTS.ASSISTANT, { content: "回复1" }, t1);
  s.append("default", EVENTS.USER, { content: "第2天" }, t2);
  s.append("default", EVENTS.USER, { content: "第3天" }, t3);
  // 分片命名: default-YYYY-MM-DD.jsonl, 只出现落盘过的天
  assert.deepEqual(files(d), ["default-2026-08-15.jsonl", "default-2026-08-16.jsonl", "default-2026-08-17.jsonl"]);
  // 跨天 order 正确 (seq 升序即时间序)
  assert.deepEqual(s.deriveMessages("default").map((m) => m.content),
    ["第1天", "回复1", "第2天", "第3天"]);
  fs.rmSync(d, { recursive: true, force: true });
});

test("P2: seq 跨天连续递增 (不每天重头数)", () => {
  const d = tmp();
  const s = new SessionStore(d);
  const seqs = [];
  seqs.push(s.append("default", EVENTS.USER, { content: "a" }, dayTs(2026, 8, 15)).seq);
  seqs.push(s.append("default", EVENTS.USER, { content: "b" }, dayTs(2026, 8, 16)).seq);
  seqs.push(s.append("default", EVENTS.USER, { content: "c" }, dayTs(2026, 8, 17)).seq);
  assert.deepEqual(seqs, [1, 2, 3]);
  assert.equal(s.replay("default").length, 3, "default 事件跨片共存一条流水线");
  fs.rmSync(d, { recursive: true, force: true });
});

test("P2: 重新 new SessionStore 从多分片恢复 (seq 连续 + nextSeq 对齐)", () => {
  const d = tmp();
  const s1 = new SessionStore(d);
  s1.append("default", EVENTS.USER, { content: "d1" }, dayTs(2026, 8, 15));
  s1.append("default", EVENTS.USER, { content: "d2" }, dayTs(2026, 8, 16));
  s1.append("default", EVENTS.USER, { content: "d3" }, dayTs(2026, 8, 17));
  // 重启
  const s2 = new SessionStore(d);
  assert.deepEqual(s2.replay("default").map((e) => e.seq), [1, 2, 3], "seq 跨片连续");
  // 继续 append 不重复 seq
  s2.append("default", EVENTS.USER, { content: "d4" }, dayTs(2026, 8, 17));
  assert.equal(s2.replay("default").length, 4);
  assert.equal(s2.replay("default").map((e) => e.seq).join(","), "1,2,3,4");
  const s3 = new SessionStore(d); // 再重启
  assert.deepEqual(s3.deriveMessages("default").map((m) => m.content), ["d1", "d2", "d3", "d4"]);
  fs.rmSync(d, { recursive: true, force: true });
});

test("P2: deriveCompacted 跨天仍正确 (compaction 替换 <= upToSeq 区间)", () => {
  const d = tmp();
  const s = new SessionStore(d);
  s.append("default", EVENTS.USER, { content: "m1" }, dayTs(2026, 8, 15));
  s.append("default", EVENTS.ASSISTANT, { content: "r1" }, dayTs(2026, 8, 15));
  s.append("default", EVENTS.USER, { content: "m2" }, dayTs(2026, 8, 16));
  // compaction 覆盖 seq<=2
  s.append("default", EVENTS.COMPACTION, { summary: "早期摘要", upToSeq: 2 }, dayTs(2026, 8, 16));
  s.append("default", EVENTS.USER, { content: "m3" }, dayTs(2026, 8, 17));
  const msgs = s.deriveCompacted("default");
  assert.equal(msgs[0].role, "system");
  assert.equal(msgs[0].content, "早期摘要");
  assert.ok(!msgs.some((m) => m.content === "m1" || m.content === "r1"), "被压缩区间被摘要替换");
  // 未压缩后续跨天消息顺序保留
  assert.deepEqual(msgs.slice(1).map((m) => m.content), ["m2", "m3"]);
  fs.rmSync(d, { recursive: true, force: true });
});

test("P2: 旧 default.jsonl 兼容 (读取纳入合并, 不丢历史)", () => {
  const d = tmp();
  // 先造旧单文件 + 一个日分片共存
  fs.mkdirSync(path.join(d, "sessions"), { recursive: true });
  // 旧单文件: seq1,2
  fs.writeFileSync(shard(d, "default.jsonl"),
    JSON.stringify({ seq: 1, ts: dayTs(2026, 8, 14), type: EVENTS.USER, data: { content: "旧一" } }) + "\n" +
    JSON.stringify({ seq: 2, ts: dayTs(2026, 8, 14), type: EVENTS.USER, data: { content: "旧二" } }) + "\n", "utf8");
  // 新日分片: seq3
  fs.writeFileSync(shard(d, "default-2026-08-15.jsonl"),
    JSON.stringify({ seq: 3, ts: dayTs(2026, 8, 15), type: EVENTS.USER, data: { content: "新三" } }) + "\n", "utf8");
  const s = new SessionStore(d);
  assert.deepEqual(s.deriveMessages("default").map((m) => m.content), ["旧一", "旧二", "新三"], "旧文件+分片合并不丢");
  assert.equal(s.replay("default").map((e) => e.seq).join(","), "1,2,3");
  // 继续 append, seq 接着 3
  s.append("default", EVENTS.USER, { content: "新四" }, dayTs(2026, 8, 16));
  assert.deepEqual(s.deriveMessages("default").map((m) => m.content), ["旧一", "旧二", "新三", "新四"]);
  const s2 = new SessionStore(d); // 重启仍完整
  assert.deepEqual(s2.deriveMessages("default").map((m) => m.content), ["旧一", "旧二", "新三", "新四"]);
  fs.rmSync(d, { recursive: true, force: true });
});

test("P2: flush 只追加当天 (非当前天文件不重复改写)", () => {
  const d = tmp();
  const s = new SessionStore(d);
  const t1 = dayTs(2026, 8, 15);
  const t2 = dayTs(2026, 8, 16);
  // 第一天写 3 条, 第二天写 2 条
  s.append("default", EVENTS.USER, { content: "a" }, t1);
  s.append("default", EVENTS.USER, { content: "b" }, t1);
  s.append("default", EVENTS.USER, { content: "c" }, t2);
  s.append("default", EVENTS.USER, { content: "d" }, t2);
  // 再对旧 flustered seq 之后追加同天, 确保旧文件行数不变
  const c15 = fs.readFileSync(shard(d, "default-2026-08-15.jsonl"), "utf8").split("\n").filter(Boolean).length;
  const c16 = fs.readFileSync(shard(d, "default-2026-08-16.jsonl"), "utf8").split("\n").filter(Boolean).length;
  assert.equal(c15, 2, "08-15 首次写入 2 条");
  assert.equal(c16, 2, "08-16 首次写入 2 条");
  // 模拟跨实例: 重启后继续写 08-16, 只应追加, 08-15 不再改
  const s2 = new SessionStore(d);
  s2.append("default", EVENTS.USER, { content: "e" }, t2);
  const c15b = fs.readFileSync(shard(d, "default-2026-08-15.jsonl"), "utf8").split("\n").filter(Boolean).length;
  const c16b = fs.readFileSync(shard(d, "default-2026-08-16.jsonl"), "utf8").split("\n").filter(Boolean).length;
  assert.equal(c15b, 2, "08-15 不再改写");
  assert.equal(c16b, 3, "08-16 追加上升到 3 条 (无重复)");
  fs.rmSync(d, { recursive: true, force: true });
});

test("P2: delete 处理所有分片 (default 旧文件 + 各日)", () => {
  const d = tmp();
  const s = new SessionStore(d);
  s.append("default", EVENTS.USER, { content: "x" }, dayTs(2026, 8, 15));
  s.append("default", EVENTS.USER, { content: "y" }, dayTs(2026, 8, 16));
  fs.writeFileSync(shard(d, "default.jsonl"), JSON.stringify({ seq: 99, ts: dayTs(2026, 8, 14), type: EVENTS.USER, data: { content: "旧" } }) + "\n", "utf8");
  assert.ok(s.has("default"));
  s.delete("default");
  assert.ok(!s.has("default"));
  assert.equal(files(d).filter((f) => f.startsWith("default")).length, 0, "所有 default 分片被删");
  fs.rmSync(d, { recursive: true, force: true });
});

test("P2: list 把 default 多分片合并为一个会话", () => {
  const d = tmp();
  const s = new SessionStore(d);
  s.append("default", EVENTS.USER, { content: "主会话跨天消息" }, dayTs(2026, 8, 15));
  s.append("default", EVENTS.USER, { content: "第二天" }, dayTs(2026, 8, 16));
  s.append("other", EVENTS.USER, { content: "别的会话" }, dayTs(2026, 8, 17));
  const list = s.list();
  const def = list.find((x) => x.key === "default");
  assert.ok(def, "list 含 default");
  assert.equal(def.count, 2, "default 计数跨片合并");
  const other = list.find((x) => x.key === "other");
  assert.equal(other.count, 1);
  fs.rmSync(d, { recursive: true, force: true });
});

test("P2: fork 跨天边界保留 (源为 default 分片时)", () => {
  const d = tmp();
  const s = new SessionStore(d);
  s.append("default", EVENTS.USER, { content: "a" }, dayTs(2026, 8, 15));
  s.append("default", EVENTS.ASSISTANT, { content: "r1" }, dayTs(2026, 8, 15));
  s.append("default", EVENTS.USER, { content: "b" }, dayTs(2026, 8, 16));
  s.append("default", EVENTS.ASSISTANT, { content: "r2" }, dayTs(2026, 8, 17));
  // fork 到 seq<=2 (第1轮)
  const kept = s.fork("default", 2, "branch");
  assert.equal(kept.length, 2);
  assert.deepEqual(s.deriveMessages("branch").map((m) => m.content), ["a", "r1"]);
  // 源 default 不受影响, 且分片文件仍在
  assert.equal(s.deriveMessages("default").length, 4);
  const s2 = new SessionStore(d); // 重启后 source 仍完整
  assert.deepEqual(s2.deriveMessages("default").map((m) => m.content), ["a", "r1", "b", "r2"]);
  assert.deepEqual(s2.deriveMessages("branch").map((m) => m.content), ["a", "r1"]);
  fs.rmSync(d, { recursive: true, force: true });
});

test("P2: set(重建) default 后磁盘无旧分片残留, 重启一致", () => {
  const d = tmp();
  const s1 = new SessionStore(d);
  s1.append("default", EVENTS.USER, { content: "老1" }, dayTs(2026, 8, 15));
  s1.append("default", EVENTS.USER, { content: "老2" }, dayTs(2026, 8, 16));
  // set 重建仅含新消息
  s1.set("default", [{ role: "user", content: "新1" }, { role: "assistant", content: "新2" }]);
  assert.deepEqual(s1.deriveMessages("default").map((m) => m.content), ["新1", "新2"]);
  const s2 = new SessionStore(d); // 重启不得残留旧分片
  assert.deepEqual(s2.deriveMessages("default").map((m) => m.content), ["新1", "新2"], "set 后重启无旧文件残留");
  fs.rmSync(d, { recursive: true, force: true });
});

test("P2: 非 default 会话仍单文件, 不受分片影响 (改动面收敛)", () => {
  const d = tmp();
  const s = new SessionStore(d);
  s.append("misc", EVENTS.USER, { content: "hi" }, dayTs(2026, 8, 15));
  s.append("misc", EVENTS.USER, { content: "again" }, dayTs(2026, 8, 16));
  assert.ok(fs.existsSync(shard(d, "misc.jsonl")), "单文件 misc.jsonl");
  assert.equal(fs.readdirSync(path.join(d, "sessions")).filter((f) => f.startsWith("misc")).length, 1);
  assert.deepEqual(s.replay("misc").map((e) => e.seq), [1, 2], "非 default seq 连续");
  fs.rmSync(d, { recursive: true, force: true });
});
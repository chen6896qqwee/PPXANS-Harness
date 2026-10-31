// test/fact-reload-signature-2026-10-30.test.js
// L2 改动的守卫: ① 锁内 _reload 按磁盘签名跳过重读 ② 去重走 O(1) 归一化键索引。
//
// 为什么这两条必须守: 它们都在"跨进程共享一份 facts.json"的路径上。
//   ① 跳过的判据一旦错, 就是"用过期内存覆盖别人刚写的记忆" —— 这类 bug 本仓库真发生过
//      (见 utils/store.js 关于 async 回调让锁静默失效的长注释)。
//   ② 索引一旦与 status/scope 口径不一致, 就会"该去重的没去重"或"不该命中的命中了"。
import { test } from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { FactStore } from "../src/memory/fact-store.js";

const tmp = (n) => fs.mkdtempSync(path.join(os.tmpdir(), `ppx-${n}-`));
const mk = (dir) => new FactStore(dir, {});
const factsFile = (dir) => path.join(dir, "memory", "facts.json"); // dataDir/memory/facts.json

test("签名跳过: 同进程两个实例, A 写后 B 必须读到 (不许用过期内存储覆盖)", () => {
  const dir = tmp("sig-two");
  try {
    const a = mk(dir);
    const b = mk(dir);          // 各自持有一份内存态
    a.add("事实来自实例 A", { source: "conversation" });
    b.add("事实来自实例 B", { source: "conversation" });
    const texts = mk(dir).list().map((f) => f.content);
    assert.ok(texts.some((t) => t.includes("实例 A")), "A 的写入不能被 B 覆盖");
    assert.ok(texts.some((t) => t.includes("实例 B")), "B 的写入要在");
    assert.equal(texts.length, 2, `两条都要在, 实际 ${texts.length}`);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("签名跳过: 外部直接改文件后, 下一次写必须看到 (mtimeNs 变化)", () => {
  const dir = tmp("sig-external");
  try {
    const a = mk(dir);
    a.add("第一条", { source: "conversation" });
    const file = factsFile(dir);
    // 模拟"另一个进程/人工"改盘: 追加一条同长度不同的内容
    const raw = JSON.parse(fs.readFileSync(file, "utf8"));
    raw.push({ ...raw[0], id: "ext-1", content: "外部写入的第二条", created: new Date().toISOString(), lastAccess: new Date().toISOString() });
    fs.writeFileSync(file, JSON.stringify(raw, null, 2), "utf8");
    a.add("第三条", { source: "conversation" });
    const texts = mk(dir).list().map((f) => f.content);
    assert.ok(texts.some((t) => t.includes("外部写入")), "外部写入不得被内存态覆盖");
    assert.equal(texts.length, 3, `应有三条, 实际 ${texts.length}`);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("签名跳过: 文件被删后写回, 不残留旧内存", () => {
  const dir = tmp("sig-deleted");
  try {
    const a = mk(dir);
    a.add("会被删掉的记忆", { source: "conversation" });
    fs.rmSync(factsFile(dir), { force: true });
    a.add("删除后新增", { source: "conversation" });
    const texts = mk(dir).list().map((f) => f.content);
    assert.ok(texts.some((t) => t.includes("删除后新增")));
    assert.equal(texts.some((t) => t.includes("会被删掉")), false,
      "磁盘文件被删后, 内存里的旧条目不应被当作仍然有效");
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("去重索引: 同内容重复写入只命中加分, 不新增条目", () => {
  const dir = tmp("dedupe-idx");
  try {
    const s = mk(dir);
    s.add("我习惯用 Node 22 跑测试", { source: "conversation" });
    s.add("  我习惯用 Node 22 跑测试。 ", { source: "conversation" }); // 空白/句末标点差异
    const live = s.list();
    assert.equal(live.length, 1, `归一化相同应只留一条, 实际 ${live.length}`);
    assert.ok(live[0].hits >= 1, "命中应加分");
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("去重索引: 不同 scope 不互相命中 (与线性查找同口径)", () => {
  const dir = tmp("dedupe-scope");
  try {
    const s = mk(dir);
    s.add("同一个内容", { source: "conversation", scope: "sA" });
    s.add("同一个内容", { source: "conversation", scope: "sB" });
    s.add("同一个内容", { source: "conversation" });          // 全局
    const all = s.list();
    assert.equal(all.length, 3, `三个作用域各一条, 实际 ${all.length}`);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("去重索引: 软删后同内容可以重新写入 (墓碑不参与去重)", () => {
  const dir = tmp("dedupe-tombstone");
  try {
    const s = mk(dir);
    const f = s.add("可以被忘掉的一条", { source: "conversation" });
    s.forget(f.id, { reason: "测试" });
    const again = s.add("可以被忘掉的一条", { source: "conversation" });
    assert.ok(again && again.id !== f.id, "软删后应允许重新写入一条新记录");
    assert.equal(s.list().length, 1, "活跃集里只有新写的那条");
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("去重索引: restore 之后同内容重新回到去重范围", () => {
  const dir = tmp("dedupe-restore");
  try {
    const s = mk(dir);
    const f = s.add("会被恢复的一条", { source: "conversation" });
    s.forget(f.id, { reason: "测试" });
    s.restore(f.id);
    s.add("会被恢复的一条", { source: "conversation" });
    assert.equal(s.list().length, 1, "恢复后应命中已有条目而不是新增");
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

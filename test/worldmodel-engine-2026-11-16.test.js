// test/worldmodel-engine-2026-11-16.test.js — 文件域世界模型与本地 HTTP 壳
// 目标: 把"不可逆动作先在模拟里走一遍"的语义钉住 —— 路径逃逸、父目录缺失、非空目录删除、
// 命令超出模拟域都必须是可观察的后果, 不能静默成功。
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { FilesystemWorldModel } from "../src/worldmodel/index.js";
import { createWorldModelServer } from "../src/worldmodel/server.js";

function tmp(tag = "wm") {
  return fs.mkdtempSync(path.join(os.tmpdir(), `ppx-${tag}-`));
}
function write(root, rel, content) {
  const p = path.join(root, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content);
}
function clean(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

test("wm-engine: seed 有界扫描, 跳过 node_modules/.git/data, 大文件只扫描不建模", () => {
  const root = tmp("wm-seed");
  try {
    write(root, "keep.txt", "hello");
    write(root, "dir/a.txt", "A");
    write(root, "dir/sub/b.txt", "B");
    write(root, "node_modules/x.js", "x");
    write(root, "data/secret.txt", "s");
    write(root, ".git/config", "g");
    write(root, "big.txt", "x".repeat(2000));
    const wm = new FilesystemWorldModel({ root, maxContentBytes: 1024 });
    const r = wm.seedFromDisk({ maxFiles: 100 });
    assert.equal(r.ok, true);
    assert.ok(wm.stateCount() >= 5);
    const paths = wm.listState({ limit: 50 }).map((x) => x.path);
    assert.ok(paths.some((p) => p.endsWith("keep.txt")));
    assert.ok(paths.some((p) => p.endsWith(path.join("dir", "sub", "b.txt"))));
    assert.ok(!paths.some((p) => p.includes("node_modules")));
    assert.ok(!paths.some((p) => p.includes(`${path.sep}data${path.sep}`)));
    assert.ok(!paths.some((p) => p.endsWith("big.txt")));
    const missing = new FilesystemWorldModel({ root: path.join(root, "nope") });
    assert.equal(missing.seedFromDisk().ok, false);
  } finally { clean(root); }
});

test("wm-engine: write 创建/覆盖/父目录/内容上限", () => {
  const root = tmp("wm-write");
  try {
    const wm = new FilesystemWorldModel({ root, maxContentBytes: 1024 });
    const create = wm.step({ type: "write", path: "a.txt", content: "hi" });
    assert.equal(create.ok, true);
    assert.equal(create.op, "create");
    assert.equal(create.sizeAfter, 2);
    const read = wm.step({ type: "read", path: "a.txt" });
    assert.equal(read.kind, "file");
    assert.equal(read.content, "hi");
    const over = wm.step({ type: "write", path: "a.txt", content: "hello" });
    assert.equal(over.op, "overwrite");
    assert.equal(over.sizeBefore, 2);
    assert.equal(over.sizeAfter, 5);
    assert.equal(wm.step({ type: "write", path: "no/b.txt", content: "x" }).ok, false);
    assert.match(wm.step({ type: "write", path: "no/b.txt", content: "x" }).reason, /父目录/);
    const tooBig = wm.step({ type: "write", path: "big.txt", content: "x".repeat(1025) });
    assert.equal(tooBig.ok, false);
    assert.match(tooBig.reason, /超限/);
    assert.equal(wm.step({ type: "nope", path: "a" }).simulated, false);
  } finally { clean(root); }
});

test("wm-engine: append 只接已存在文件, 合并后仍受内容上限", () => {
  const root = tmp("wm-append");
  try {
    const wm = new FilesystemWorldModel({ root, maxContentBytes: 1024 });
    wm.step({ type: "write", path: "a.txt", content: "12345" });
    const ok = wm.step({ type: "append", path: "a.txt", content: "!" });
    assert.equal(ok.ok, true);
    assert.equal(ok.sizeBefore, 5);
    assert.equal(ok.sizeAfter, 6);
    assert.equal(wm.step({ type: "append", path: "missing.txt", content: "x" }).ok, false);
    assert.match(wm.step({ type: "append", path: "missing.txt", content: "x" }).reason, /append 不隐式创建/);
    wm.step({ type: "mkdir", path: "d" });
    assert.equal(wm.step({ type: "append", path: "d", content: "x" }).ok, false);
    wm.step({ type: "write", path: "long.txt", content: "x".repeat(1020) });
    const over = wm.step({ type: "append", path: "long.txt", content: "x".repeat(10) });
    assert.equal(over.ok, false);
    assert.match(over.reason, /追加后超限/);
  } finally { clean(root); }
});

test("wm-engine: mkdir/read 不变量", () => {
  const root = tmp("wm-mkdir");
  try {
    const wm = new FilesystemWorldModel({ root });
    assert.equal(wm.step({ type: "mkdir", path: "d" }).ok, true);
    assert.match(wm.step({ type: "mkdir", path: "d" }).reason, /目录已存在/);
    wm.step({ type: "write", path: "f.txt", content: "x" });
    assert.match(wm.step({ type: "mkdir", path: "f.txt" }).reason, /同名文件/);
    assert.match(wm.step({ type: "mkdir", path: "no/d" }).reason, /父目录/);
    const dirRead = wm.step({ type: "read", path: "d" });
    assert.equal(dirRead.kind, "dir");
    assert.equal(wm.step({ type: "read", path: "missing" }).ok, false);
  } finally { clean(root); }
});

test("wm-engine: delete 非空目录必须 recursive, recursive 后子项一起走", () => {
  const root = tmp("wm-del");
  try {
    const wm = new FilesystemWorldModel({ root });
    wm.step({ type: "mkdir", path: "d" });
    wm.step({ type: "write", path: "d/a.txt", content: "A" });
    wm.step({ type: "write", path: "d/b.txt", content: "B" });
    const blocked = wm.step({ type: "delete", path: "d" });
    assert.equal(blocked.ok, false);
    assert.match(blocked.reason, /recursive/);
    const ok = wm.step({ type: "delete", path: "d", recursive: true });
    assert.equal(ok.ok, true);
    assert.equal(wm.step({ type: "read", path: "d/a.txt" }).ok, false);
    assert.equal(wm.step({ type: "delete", path: "missing" }).ok, false);
    wm.step({ type: "mkdir", path: "empty" });
    assert.equal(wm.step({ type: "delete", path: "empty" }).ok, true);
  } finally { clean(root); }
});

test("wm-engine: move 文件/目录/目标冲突/父目录/逃逸", () => {
  const root = tmp("wm-move");
  try {
    const wm = new FilesystemWorldModel({ root });
    wm.step({ type: "write", path: "m1", content: "M" });
    const moved = wm.step({ type: "move", path: "m1", to: "m2" });
    assert.equal(moved.ok, true);
    assert.equal(moved.moved, 1);
    assert.equal(wm.step({ type: "read", path: "m1" }).ok, false);
    assert.equal(wm.step({ type: "read", path: "m2" }).content, "M");
    wm.step({ type: "mkdir", path: "d" });
    wm.step({ type: "write", path: "d/a", content: "A" });
    const dirMove = wm.step({ type: "move", path: "d", to: "d2" });
    assert.equal(dirMove.ok, true);
    assert.ok(dirMove.moved >= 2);
    assert.equal(wm.step({ type: "read", path: "d2/a" }).content, "A");
    assert.match(wm.step({ type: "move", path: "m2", to: "d2/a" }).reason, /目标已存在/);
    assert.match(wm.step({ type: "move", path: "m2", to: "no/x" }).reason, /父目录/);
    assert.match(wm.step({ type: "move", path: "missing", to: "x" }).reason, /源不存在/);
    assert.match(wm.step({ type: "move", path: "m2", to: "../outside" }).reason, /逃逸/);
  } finally { clean(root); }
});

test("wm-engine: 路径逃逸与纯虚拟世界相对路径都被拒", () => {
  const root = tmp("wm-escape");
  try {
    const wm = new FilesystemWorldModel({ root });
    assert.match(wm.step({ type: "write", path: "../evil", content: "x" }).reason, /逃逸/);
    assert.match(wm.step({ type: "write", path: path.join(os.tmpdir(), "evil.txt"), content: "x" }).reason, /逃逸/);
    const pure = new FilesystemWorldModel({ root: null });
    assert.match(pure.step({ type: "write", path: "a", content: "x" }).reason, /相对路径/);
  } finally { clean(root); }
});

test("wm-engine: exec 预演成功/被拒绝/超出模拟域", () => {
  const root = tmp("wm-exec");
  try {
    const wm = new FilesystemWorldModel({ root });
    wm.step({ type: "mkdir", path: "build" });
    wm.step({ type: "write", path: "build/a.txt", content: "A" });
    const rm = wm.step({ type: "exec", command: "rm -rf build" });
    assert.equal(rm.ok, true);
    assert.equal(rm.simulated, true);
    assert.equal(rm.effectCount, 1);
    assert.equal(wm.step({ type: "read", path: "build/a.txt" }).ok, false);
    wm.step({ type: "mkdir", path: "keep" });
    wm.step({ type: "write", path: "keep/a", content: "A" });
    const blocked = wm.step({ type: "exec", command: "rm keep" });
    assert.equal(blocked.ok, true);
    assert.ok(blocked.blocked.length >= 1);
    assert.equal(wm.step({ type: "read", path: "keep/a" }).ok, true);
    const mk = wm.step({ type: "exec", command: "mkdir out && touch out/a" });
    assert.equal(mk.effectCount, 2);
    assert.equal(wm.step({ type: "read", path: "out/a" }).ok, true);
    assert.equal(wm.step({ type: "exec", command: "git status" }).simulated, false);
    assert.equal(wm.step({ type: "exec", command: "rm *" }).simulated, false);
    assert.match(wm.step({ type: "exec" }).reason, /缺 command/);
  } finally { clean(root); }
});

test("wm-engine: snapshot/restore/reset 与快照上限", () => {
  const root = tmp("wm-snap");
  try {
    const wm = new FilesystemWorldModel({ root, maxSnapshots: 2 });
    wm.step({ type: "write", path: "a.txt", content: "1" });
    const s1 = wm.snapshot("one");
    assert.equal(wm.snapshotList().length, 1);
    wm.step({ type: "write", path: "b.txt", content: "2" });
    const restored = wm.restore(s1.id);
    assert.equal(restored.ok, true);
    assert.equal(wm.step({ type: "read", path: "b.txt" }).ok, false);
    assert.equal(wm.restore("missing").ok, false);
    wm.snapshot("two");
    wm.snapshot("three");
    const list = wm.snapshotList();
    assert.equal(list.length, 2);
    assert.ok(!list.some((s) => s.label === "one"), "最老快照应被淘汰");
    wm.reset();
    assert.equal(wm.stateCount(), 0);
  } finally { clean(root); }
});

test("wm-engine: journal 落盘与 replay", () => {
  const root = tmp("wm-journal");
  try {
    const journal = path.join(root, "journal.jsonl");
    const wm = new FilesystemWorldModel({ root, journalFile: journal });
    wm.step({ type: "write", path: "a.txt", content: "1" });
    wm.snapshot("s");
    assert.ok(fs.existsSync(journal));
    const ops = fs.readFileSync(journal, "utf8").trim().split("\n").map((l) => JSON.parse(l).op);
    assert.ok(ops.includes("step"));
    assert.ok(ops.includes("snapshot"));
    const replay = wm.replay([{ type: "write", path: "b.txt", content: "2" }, { type: "read", path: "b.txt" }]);
    assert.equal(replay.length, 2);
    assert.equal(replay[1].content, "2");
  } finally { clean(root); }
});

test("wm-engine: diffAgainstDisk 报告虚拟/现实差异", () => {
  const root = tmp("wm-diff");
  try {
    write(root, "keep.txt", "hello");
    write(root, "dir/a.txt", "A");
    const wm = new FilesystemWorldModel({ root });
    wm.seedFromDisk({ maxFiles: 20 });
    wm.step({ type: "write", path: "virtual.txt", content: "V" });
    write(root, "extra.txt", "E");
    write(root, "keep.txt", "longer");
    const d = wm.diffAgainstDisk();
    assert.equal(d.ok, true);
    assert.ok(d.onlyVirtual.some((p) => p.endsWith("virtual.txt")));
    assert.ok(d.onlyReal.some((p) => p.endsWith("extra.txt")));
    assert.ok(d.changed.some((p) => p.endsWith("keep.txt")));
    assert.equal(new FilesystemWorldModel({ root: null }).diffAgainstDisk().ok, false);
  } finally { clean(root); }
});

test("wm-server: health/simulate/各类 op/错误路径", async () => {
  const root = tmp("wm-srv");
  let srv;
  const mutated = [];
  try {
    write(root, "a.txt", "A");
    srv = createWorldModelServer({ root, port: 0, seedOnStart: true, onMutate: (t) => mutated.push(t) });
    const url = await srv.start();
    assert.match(url, /^http:\/\/127\.0\.0\.1:\d+$/);
    const health = await (await fetch(url + "/health")).json();
    assert.equal(health.ok, true);
    assert.equal(health.service, "ppx-worldmodel");
    assert.ok(health.stateCount >= 1);
    const rootHealth = await (await fetch(url + "/")).json();
    assert.equal(rootHealth.ok, true);
    const badGet = await fetch(url + "/nope");
    assert.equal(badGet.status, 405);
    const sim = await (await fetch(url, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ op: "simulate", steps: [{ type: "write", path: "x.txt", content: "X" }] }),
    })).json();
    assert.equal(sim.ok, true);
    assert.equal(sim.results.length, 1);
    const action = await (await fetch(url, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ op: "simulate", action: "rm -rf build" }),
    })).json();
    assert.equal(action.ok, false);
    assert.equal(action.simulated, false);
    const snap = await (await fetch(url, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ op: "snapshot", label: "s1" }),
    })).json();
    assert.equal(snap.ok, true);
    assert.ok(snap.id);
    const state = await (await fetch(url, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ op: "state" }),
    })).json();
    assert.equal(state.ok, true);
    assert.ok(Array.isArray(state.entries));
    const diff = await (await fetch(url, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ op: "diff" }),
    })).json();
    assert.equal(diff.ok, true);
    const restoreBad = await (await fetch(url, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ op: "restore", id: "missing" }),
    })).json();
    assert.equal(restoreBad.ok, false);
    const unknown = await (await fetch(url, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ op: "nope" }),
    })).json();
    assert.equal(unknown.ok, false);
    assert.match(unknown.error, /未知 op/);
    const badJson = await fetch(url, {
      method: "POST", headers: { "content-type": "application/json" }, body: "{bad",
    });
    assert.equal(badJson.status, 400);
    assert.ok(mutated.includes("snapshot"));
    assert.ok(mutated.includes("restore"));
  } finally {
    if (srv) await srv.stop();
    clean(root);
  }
});

test("wm-server: seedOnStart=false 保持空状态, stop 可重复调用", async () => {
  const root = tmp("wm-srv2");
  let srv;
  try {
    write(root, "a.txt", "A");
    srv = createWorldModelServer({ root, port: 0, seedOnStart: false });
    const url = await srv.start();
    const health = await (await fetch(url + "/health")).json();
    assert.equal(health.stateCount, 0);
    await srv.stop();
    await srv.stop();
  } finally { clean(root); }
});

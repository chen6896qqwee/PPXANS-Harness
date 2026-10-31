// test/absorb.hermes.test.js - notify/interrupt/citation absorption (Hermes v0.20)
// 2026-10-30 修复: 此前 Scheduler("data") 直接读真实 data/scheduler/jobs.json ——
//   构造函数会把其中每日任务 (eviction-daily/evolution-loop) 的定时器重新排上,
//   几小时外的 setTimeout 把事件循环挂住, 单跑/无 --test-force-exit 全家桶时永不退出;
//   且测试会写真实数据目录。改用一次性临时目录 + 显式 shutdown, 完全隔离。
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ToolCatalog, registerAdvancedTools } from "../src/tools/index.js";
import { Scheduler } from "../src/tools/advanced.js";

function makeSched() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ppx-absorb-"));
  const sched = new Scheduler(dir);
  return { dir, sched };
}

test("notify tool delivers message to registered sink", async () => {
  const cat = new ToolCatalog();
  const { dir, sched } = makeSched();
  registerAdvancedTools(cat, { dataDir: dir, scheduler: sched, onMemoryNote: () => {} });
  assert.ok(cat.has("notify"), "notify tool registered");
  let got = null;
  const agent = { notify: (m) => { got = m; } };
  const r = await cat.call("notify", { message: "hi" }, { agent });
  assert.equal(r, "notified");
  assert.equal(got, "hi");
  sched.shutdown();
  fs.rmSync(dir, { recursive: true, force: true });
});

test("notify tool tolerates missing sink", async () => {
  const cat = new ToolCatalog();
  const { dir, sched } = makeSched();
  registerAdvancedTools(cat, { dataDir: dir, scheduler: sched, onMemoryNote: () => {} });
  const r = await cat.call("notify", { message: "x" }, {});
  assert.equal(r, "no notify sink registered");
  sched.shutdown();
  fs.rmSync(dir, { recursive: true, force: true });
});

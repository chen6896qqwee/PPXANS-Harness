// test/absorb.hermes.test.js - notify/interrupt/citation absorption (Hermes v0.20)
import { test } from "node:test";
import assert from "node:assert/strict";
import { ToolCatalog, registerAdvancedTools } from "../src/tools/index.js";
import { Scheduler } from "../src/tools/advanced.js";

test("notify tool delivers message to registered sink", async () => {
  const cat = new ToolCatalog();
  const sched = new Scheduler("data");
  registerAdvancedTools(cat, { dataDir: "data", scheduler: sched, onMemoryNote: () => {} });
  assert.ok(cat.has("notify"), "notify tool registered");
  let got = null;
  const agent = { notify: (m) => { got = m; } };
  const r = await cat.call("notify", { message: "hi" }, { agent });
  assert.equal(r, "notified");
  assert.equal(got, "hi");
});

test("notify tool tolerates missing sink", async () => {
  const cat = new ToolCatalog();
  const sched = new Scheduler("data");
  registerAdvancedTools(cat, { dataDir: "data", scheduler: sched, onMemoryNote: () => {} });
  const r = await cat.call("notify", { message: "x" }, {});
  assert.equal(r, "no notify sink registered");
});

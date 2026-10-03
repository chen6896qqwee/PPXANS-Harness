// test/taskbench.test.js - 任务级评测基准守卫 (2026-10-02)
import test from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { TASKS, summarize } from "../bench/tasks.js";

const mk = () => fs.mkdtempSync(path.join(os.tmpdir(), "ppx-tb-"));
const byId = (id) => { const t = TASKS.find((x) => x.id === id); assert.ok(t, `任务 ${id} 应存在`); return t; };
const judge = (id, reply, setupFiles = true) => {
  const t = byId(id);
  const d = mk();
  if (setupFiles) t.setup?.(d);
  const v = t.verify({ reply, tokens: 0, ms: 0 }, { sandbox: d });
  fs.rmSync(d, { recursive: true, force: true });
  return v;
};

test("任务集: 20 任务 / 5 分类 / id 唯一 / verify 可判分", () => {
  assert.ok(TASKS.length >= 20, `应有 20+ 任务, 实际 ${TASKS.length}`);
  const ids = TASKS.map((t) => t.id);
  assert.equal(new Set(ids).size, ids.length, "id 必须唯一");
  for (const t of TASKS) {
    assert.ok(t.task && t.category, `${t.id} 缺 prompt/分类`);
    assert.equal(typeof t.verify, "function", `${t.id} 缺 verify`);
  }
  assert.ok(new Set(TASKS.map((t) => t.category)).size >= 5, "应覆盖 5+ 分类");
});

test("判分: 正确回复通过 / 错误回复不通过 (检索类)", () => {
  assert.equal(judge("version-report", "版本号是 7.7.7").pass, true);
  assert.equal(judge("version-report", "版本号是 1.0.0").pass, false);
  assert.equal(judge("sum-numbers", "加总 = 50").pass, true);
  assert.equal(judge("sum-numbers", "加总 = 51").pass, false);
  assert.equal(judge("find-symbol", "定义在 pricing.js 里").pass, true);
  assert.equal(judge("find-symbol", "在 unrelated.js 和 pricing.js").pass, false, "指认多个应不通过");
});

test("判分: 文件/代码类按沙箱产物判, 不看嘴皮子", () => {
  // create-file: 回复说做了但没做 → false; 做了 → true
  assert.equal(judge("create-file", "我已创建 todo.txt", false).pass, false, "光说不做应判负");
  const d = mk(); byId("create-file").setup?.(d);
  fs.writeFileSync(path.join(d, "notes/todo.txt"), "买牛奶");
  const v = byId("create-file").verify({ reply: "done" }, { sandbox: d });
  fs.rmSync(d, { recursive: true, force: true });
  assert.equal(v.pass, true);
  // fix-logic: 文件没修 → node 求值 5 !== -1
  assert.equal(judge("fix-logic", "修好了 (其实没动)").pass, false, "没真修应判负");
  // delete-file: 没删 → false
  assert.equal(judge("delete-file", "已删除").pass, false, "没真删应判负");
  // conditional: flag=off 的任务形态下, enabled.txt 不存在判负 → 沙箱里 flag 由 setup 决定, 这里验证正向
  assert.equal(judge("json-edit", "已改 5000").pass, false, "没真改应判负");
});

test("汇总: passRate/分类聚合/失败明细", () => {
  const s = summarize([
    { id: "a", category: "检索", pass: true, tokens: 100, ms: 1000 },
    { id: "b", category: "检索", pass: false, tokens: 200, ms: 2000, detail: "x" },
    { id: "c", category: "代码", pass: true, tokens: 300, ms: 3000 },
  ]);
  assert.equal(s.total, 3);
  assert.equal(s.pass, 2);
  assert.equal(s.passRate, 0.667);
  assert.equal(s.byCategory["检索"].pass, 1);
  assert.equal(s.byCategory["代码"].tokens, 300);
  assert.deepEqual(s.failures.map((f) => f.id), ["b"]);
});

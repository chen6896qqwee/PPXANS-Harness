// test/selfcode-graph-2026-11-16.test.js — 自改代码的依赖图 (纯静态, 零执行)
// 临时仓库覆盖: import/export/dynamic/require 四种边, 入口发现, 断链, 环,
// unreachable/reserved/unwired 三分类, impactOf 反向闭包与同名测试兜底, summarizeGraph 汇总。
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildGraph, findCycles, impactOf, summarizeGraph } from "../src/selfcode/graph.js";

function put(root, rel, content) {
  const p = path.join(root, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content, "utf8");
}
const norm = (p) => String(p).replace(/\\/g, "/");
const has = (arr, tail) => arr.some((p) => norm(p).endsWith(tail));

// 夹具里的 import 规格符用 JSON.stringify 拼出来: 既保证写入临时仓库的内容是合法 JS,
// 也避免 depcheck 把测试源码里的示例字符串误判成"测试自己 import 了缺失文件"。
const spec = (s) => JSON.stringify(s);
const testSpec = (n) => JSON.stringify("../" + n + ".js");

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ppx-graph-"));
  put(root, "package.json", JSON.stringify({
    name: "fixture", main: "src/main.js",
    bin: { f: "bin/cli.js" },
    exports: { ".": "./src/exp.js" },
    scripts: { start: "node scripts/run.js" },
  }));
  put(root, "src/main.js", [
    `import { b } from ${spec("./b.js")};`,
    `import ${spec("./cycle-a.js")};`,
    `import ${spec("./forms.js")};`,
    `import ${spec("./dir")};`,
    `import ${spec("./foo.mjs")};`,
    `import ${spec("./worker.js")};`,
    "export const main = 1;",
  ].join("\n"));
  put(root, "src/b.js", `import ${spec("./main.js")};\nexport const b = 1;`);
  put(root, "src/cycle-a.js", `import ${spec("./cycle-b.js")};`);
  put(root, "src/cycle-b.js", `import ${spec("./cycle-a.js")};`);
  put(root, "src/forms.js", [
    `export { b } from ${spec("./b.js")};`,
    `import ${spec("./c.js")};`,
    `const d = await import(${spec("./d.js")});`,
    `const e = require(${spec("./e.js")});`,
  ].join("\n"));
  put(root, "src/c.js", "export const c = 1;");
  put(root, "src/d.js", "export const d = 1;");
  put(root, "src/e.js", "export const e = 1;");
  put(root, "src/dir/index.js", "export const idx = 1;");
  put(root, "src/foo.mjs", "export const foo = 1;");
  put(root, "src/worker.js", `export const url = new URL(${spec("./worker-child.js")}, import.meta.url);`);
  put(root, "src/worker-child.js", "export const child = 1;");
  put(root, "src/missing.js", `import ${spec("./does-not-exist.js")};`);
  put(root, "src/reserved.js", "export const reserved = 1;");
  put(root, "src/unwired.js", "export const unwired = 1;");
  put(root, "src/silent.js", "// pad\n".repeat(80) + "try { maybe(); } catch {}\n");
  put(root, "src/cli.js", "console.log('cli');");
  put(root, "src/exp.js", "export const exp = 1;");
  put(root, "bin/cli.js", `import ${testSpec("src/b")};`);
  put(root, "scripts/run.js", "console.log(1);");
  put(root, "electron/main.js", `import ${testSpec("src/main")};`);
  put(root, "test/b.test.js", `import ${testSpec("src/b")};`);
  put(root, "test/reserved.test.js", `import ${testSpec("src/reserved")};`);
  put(root, "node_modules/skip.js", "export const x = 1;");
  put(root, "data/skip.js", "export const x = 1;");
  put(root, ".git/skip.js", "export const x = 1;");
  return root;
}

test("graph: buildGraph 解析四种 import、入口、断链与跳过目录", () => {
  const root = fixture();
  try {
    const g = buildGraph({ root, dirs: ["src", "bin", "scripts", "electron"] });
    assert.ok(has(g.files, "src/main.js"));
    assert.ok(!has(g.files, "node_modules"));
    assert.ok(!has(g.files, "data/skip.js"));
    assert.ok(!has(g.files, ".git/skip.js"));
    const main = g.files.find((f) => norm(f).endsWith("src/main.js"));
    const deps = (g.graph.get(main) || []).map(norm);
    assert.ok(deps.some((d) => d.endsWith("src/b.js")));
    assert.ok(deps.some((d) => d.endsWith("src/forms.js")));
    assert.ok(deps.some((d) => d.endsWith("src/dir/index.js")), "目录 import 应解析到 index.js");
    assert.ok(deps.some((d) => d.endsWith("src/foo.mjs")), ".mjs 后缀应解析");
    assert.ok(deps.some((d) => d.endsWith("src/worker.js")));
    const worker = g.files.find((f) => norm(f).endsWith("src/worker.js"));
    assert.ok((g.graph.get(worker) || []).map(norm).some((d) => d.endsWith("worker-child.js")), "new URL 的字符串路径也应入图");
    const forms = g.files.find((f) => norm(f).endsWith("src/forms.js"));
    const fdeps = (g.graph.get(forms) || []).map(norm);
    for (const n of ["c.js", "d.js", "e.js", "b.js"]) assert.ok(fdeps.some((d) => d.endsWith("src/" + n)), n);
    assert.ok(has(g.entries, "src/main.js"));
    assert.ok(has(g.entries, "bin/cli.js"));
    assert.ok(has(g.entries, "scripts/run.js"));
    assert.ok(has(g.entries, "electron/main.js"));
    assert.ok(has(g.entries, "src/exp.js"));
    assert.ok(g.unresolved.some((u) => norm(u.file).endsWith("src/missing.js")), "断链应报告");
    assert.ok(g.cycles.length >= 2, "main↔b 与 cycle-a↔cycle-b 两个环");
    assert.ok(has(g.unreachable, "src/unwired.js"));
    assert.ok(has(g.reserved, "src/reserved.js"), "仅测试引用的不可达模块保留为 reserved");
    assert.ok(has(g.unwired, "src/unwired.js"), "无引用也无测试才是 unwired");
    const reservedAbs = g.files.find((f) => norm(f).endsWith("src/reserved.js"));
    assert.ok((g.testRefs.get(reservedAbs) || []).some((t) => norm(t).endsWith("reserved.test.js")));
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("graph: findCycles 去重且能发现多节点环", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ppx-graph-cycle-"));
  try {
    const a = path.join(root, "a.js"), b = path.join(root, "b.js"), c = path.join(root, "c.js");
    const cycles = findCycles([a, b, c], new Map([[a, [b]], [b, [c]], [c, [a]], [b, [c]]]));
    assert.equal(cycles.length, 1);
    assert.equal(cycles[0].length, 4);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("graph: impactOf 反向闭包 + 同名测试兜底", () => {
  const root = fixture();
  try {
    const r = impactOf(root, ["src/b.js"], { maxDependents: 30, maxTests: 8 });
    assert.deepEqual(r.changed, ["src/b.js"]);
    assert.ok(r.directDependents.includes("src/main.js"));
    assert.ok(r.directDependents.includes("bin/cli.js"));
    assert.ok(r.relatedTests.some((t) => norm(t) === "test/b.test.js"), "同名测试应被兜底纳入");
    assert.ok(r.totalDependents >= 2);
    assert.ok(r.totalTests >= 1);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("graph: summarizeGraph 汇总规模/三分类/环/静默 catch", () => {
  const root = fixture();
  try {
    const g = buildGraph({ root, dirs: ["src", "bin", "scripts", "electron"] });
    const s = summarizeGraph(g, { top: 5 });
    assert.ok(s.modules >= 15);
    assert.ok(s.edges >= 10);
    assert.ok(s.entries >= 5);
    assert.ok(s.reachable >= 8);
    assert.ok(s.unwired.includes("src/unwired.js"));
    assert.ok(s.reserved.includes("src/reserved.js"));
    assert.ok(s.cycles.length >= 2);
    assert.ok(s.unresolved.some((u) => norm(u.file).endsWith("src/missing.js")));
    assert.ok(s.largest.length <= 5);
    assert.ok(s.totalLines > 0);
    assert.ok(s.catchTotals.empty >= 1, "空 catch 应计入");
    assert.ok(s.silentCatchHotspots.some((x) => x.file === "src/silent.js"), ">80 行且有空 catch 应进热点");
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

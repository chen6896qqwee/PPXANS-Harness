// test/sandbox-heap-cap.test.js — code_run 堆上限 (maxHeapMb) 接线回归 (2026-10-05)
// 背景: runInSandbox 的 maxHeapMb 曾是"没有调用方传"的假旋钮 —— 强制其实可行
// (worker_threads 原生 resourceLimits.maxOldGenerationSizeMb, 零依赖), 缺的是接线。
// 本次: code_run 工具暴露 max_heap_mb → runInSandbox → worker, 并给 harness/测试留
// 显式关档 (maxHeapMb<=0 = 不传 resourceLimits)。默认 128MB 与历史行为逐字一致。
// 断言两头: 开上限时贪内存片段被真实终止 (ERR_WORKER_OUT_OF_MEMORY 走 worker error
// 分支, 非 vm 超时); 关上限时同一片段正常跑完。全程 <5s, OOM 只杀 worker 不伤测试进程。
import test from "node:test";
import assert from "node:assert";
import { runInSandbox, registerSandboxTools } from "../src/tools/sandbox.js";
import { ToolCatalog } from "../src/tools/index.js";

// 贪内存 ~50MB+ (纯 JS 老生代对象, 计数堆外 typed-array buffer 不可靠):
// 16MB 上限下毫秒级 OOM; 无上限/默认 128MB 下 ~0.5s 跑完。
const GREEDY = `var keep = [];
for (var i = 0; i < 400000; i++) { keep.push({ i: i, s: "ppxppxppx" + i, a: [i, i + 1, i + 2] }); }
keep.length`;

test("heap cap 开启: 超限片段被 worker 强制终止 (OOM 错误形态, 不是超时)", async () => {
  const r = await runInSandbox(GREEDY, { timeoutMs: 8000, maxHeapMb: 16 });
  assert.equal(r.ok, false, `堆超限必须判负, 实际: ${JSON.stringify(r).slice(0, 200)}`);
  assert.doesNotMatch(r.error, /执行超时/, "应由堆上限裁决, 不该退化靠时间兜底");
  assert.match(r.error, /memory limit|out of memory|worker 异常/i, `应为 worker OOM 终止: ${r.error}`);
  assert.ok(r.durationMs < 5000, `终止应很快 (边分配边触顶), 实测 ${r.durationMs}ms`);
});

test("heap cap 关闭 (maxHeapMb<=0): 同一片段正常跑完 —— 开/关对比证明上限真实生效", async () => {
  const r = await runInSandbox(GREEDY, { timeoutMs: 8000, maxHeapMb: 0 });
  assert.equal(r.ok, true, `关上限不应被杀: ${JSON.stringify(r).slice(0, 200)}`);
  assert.equal(r.result, 400000);
});

test("默认行为零漂移: 不传 maxHeapMb = 128MB, 50MB 片段照旧通过", async () => {
  const r = await runInSandbox(GREEDY, { timeoutMs: 8000 });
  assert.equal(r.ok, true, `默认 128MB 应容纳 ~50MB, 与历史行为一致: ${JSON.stringify(r).slice(0, 200)}`);
});

test("code_run 工具接线: max_heap_mb 透传强制; 非法/零值回落默认不关档", async () => {
  const catalog = new ToolCatalog();
  registerSandboxTools(catalog, { rootDir: process.cwd() });
  // 收紧到下限 16MB: 贪内存片段应被 OOM 终止, 错误经 [工具错误] 前缀回灌工具循环
  const capped = String(await catalog.call("code_run", { code: GREEDY, max_heap_mb: 16, timeout_ms: 8000 }, {}));
  assert.ok(capped.startsWith("[工具错误]"), `应报工具错误: ${capped.slice(0, 160)}`);
  assert.match(capped, /memory limit|out of memory|worker 异常/i, capped.slice(0, 200));
  // 不传 = 默认 128MB: 同一片段通过 (行为与接线前一致)
  const ok = String(await catalog.call("code_run", { code: GREEDY, timeout_ms: 8000 }, {}));
  assert.match(ok, /"result":400000/, ok.slice(0, 160));
  // 0/负数不构成模型侧的"关档"入口: 回落默认
  const zero = String(await catalog.call("code_run", { code: "var k=[]; for (var i=0;i<400000;i++){k.push({i:i,s:\"ppx\"+i,a:[i]})} k.length", max_heap_mb: 0, timeout_ms: 8000 }, {}));
  assert.match(zero, /"result":400000/, `0 应回落默认 128MB 而非关档: ${zero.slice(0, 160)}`);
});

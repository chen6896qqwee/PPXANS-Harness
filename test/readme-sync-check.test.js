// test/readme-sync-check.test.js - README 机读锚点与散文口径同步守卫
import test from "node:test";
import assert from "node:assert/strict";
import {
  applyFix,
  countVerifyChecks,
  syncProse,
} from "../scripts/readme-sync-check.js";

const MEASURED = {
  tools: 127,
  skills: 71,
  core_schema: 38,
  ctx_tokens: 7149,
  mcp_tools: 129,
  test_files: 256,
  offline_total: 28,
  offline_legacy_total: 20,
  verify_checks: 17,
};

const STALE_MD = `# Demo
**111 个内置工具 · 能力边界护栏** · 全量测试 1964 项 (1960 通过 / 4 跳过)
<!-- readme-sync: {"tools":111,"core_schema":31,"mcp_tools":128,"tests":1964,"test_files":255,"pass":1960,"skipped":4,"offline_total":20,"offline_legacy_total":20,"verify_checks":18} -->
**111 内置工具**（运行时实测，含 MCP 动态注册）：
- **105 内置**：文件/命令
- **默认按需曝光**：只下发约 31 个主干工具 schema
**痛觉**：\`npm run taskbench:offline\` —— 20 个确定性判分任务（冻结旧 20 + 后续 8 题）
**离线任务基准口径**：冻结旧 **20** 题，全量 **20** 题（后续 0 题）。
- 2026-11-16 本轮离线实测：旧 20 题 20/20；全 28 题 28/28。
\`POST /mcp\` 暴露 128 工具
tools/call\` — 128 工具全量暴露
npm run verify # 一键本地快检 (18 项)
工具系统 (105 个注册工具; MCP 另暴露 22 个 ppx.* 方法)
测试 (255 文件)
`;

test("fix 同步机读锚点和漂移散文, 不把离线结果改成静态推测值", () => {
  const { next, merged } = applyFix(STALE_MD, MEASURED, null);
  assert.equal(merged.tools, 127);
  assert.equal(merged.core_schema, 38);
  assert.equal(merged.mcp_tools, 129);
  assert.equal(merged.offline_total, 28);
  assert.equal(merged.offline_legacy_total, 20);
  assert.equal(merged.verify_checks, 17);
  assert.equal(merged.tests, 1964, "无 counts 时必须保留原测试锚点");
  assert.match(next, /\*\*127 个内置工具 · 能力边界护栏\*\*/);
  assert.match(next, /\*\*127 内置工具\*\*/);
  assert.match(next, /- \*\*127 内置\*\*/);
  assert.match(next, /只下发 38 个主干工具 schema/);
  assert.match(next, /—— 28 个确定性判分任务（冻结旧 20 \+ 后续 8 题）/);
  assert.match(next, /冻结旧 \*\*20\*\* 题，全量 \*\*28\*\* 题（后续 8 题）/);
  assert.match(next, /`POST \/mcp` 暴露 129 工具/);
  assert.match(next, /tools\/call` — 129 工具全量暴露/);
  assert.match(next, /一键本地快检 \(17 项\)/);
  assert.match(next, /工具系统 \(127 个注册工具; MCP 另暴露 22 个 ppx\.\* 方法\)/);
  assert.match(next, /测试 \(256 文件\)/);
  assert.match(next, /全量测试 1964 项 \(1960 通过 \/ 4 跳过\)/, "普通 fix 不得手改测试总数");
  assert.match(next, /旧 20 题 20\/20；全 28 题 28\/28/, "实测通过数不由静态同步器重算");
  assert.equal(syncProse(next, MEASURED, null), next, "修复后散文应达到幂等");
});

test("只有显式提供全量测试统计时才更新 tests/pass/skipped", () => {
  const counts = { tests: 2000, pass: 1995, skipped: 5 };
  const { next, merged } = applyFix(STALE_MD, MEASURED, counts);
  assert.equal(merged.tests, 2000);
  assert.equal(merged.pass, 1995);
  assert.equal(merged.skipped, 5);
  assert.match(next, /全量测试 2000 项 \(1995 通过 \/ 5 跳过\)/);
});

test("verify 项数静态读取声明, 不运行 verify 或离线基准", () => {
  assert.equal(countVerifyChecks(), 17);
});

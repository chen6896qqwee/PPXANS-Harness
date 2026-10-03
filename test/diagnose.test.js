// test/diagnose.test.js - Agent 自诊断守卫 (2026-10-03, 按症状下药表自动化)
import test from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { diagnoseAgent } from "../src/services/diagnose.js";
import { AuditLog } from "../src/audit/audit-chain.js";

function tmpData() { return fs.mkdtempSync(path.join(os.tmpdir(), "ppx-dx-")); }

function seedAudit(dataDir, rows) {
  const audit = new AuditLog(dataDir);
  for (const r of rows) audit.append(r);
  return audit;
}

test("空数据: 全部 ok 不误报", () => {
  const d = tmpData();
  const { findings, report } = diagnoseAgent({ dataDir: d });
  assert.equal(findings.length, 1);
  assert.equal(findings[0].severity, "ok", "无数据应报 ok 不误报");
  assert.ok(report.includes("自诊断报告"));
});

test("症状: 高失败率工具 / 参数拦截 / 权限拦截 / 成本高 各自触发", () => {
  const d = tmpData();
  const audit = new AuditLog(d);
  // my_tool: 8 次调用 6 次失败 (75% > 30%) → high
  for (let i = 0; i < 8; i++) audit.append({ tool: "my_tool", args: {}, ok: i < 2, error: i < 2 ? null : `boom ${i}` });
  // bad_args: 4 次参数错误 → info
  for (let i = 0; i < 4; i++) audit.append({ tool: "bad_args", args: {}, ok: false, error: "[工具错误] bad_args: 参数错误 — 缺少必填" });
  // blocked: 3 次策略拦截 → medium
  for (let i = 0; i < 3; i++) audit.append({ tool: "blocked", args: {}, ok: false, error: "策略拦截: 未授权" });
  // usage: 成本高 (5 次 × 20000 tok)
  fs.writeFileSync(path.join(d, "usage-stats.json"), JSON.stringify({ calls: 5, tokens: 100000, byModel: {} }));

  const { findings, report } = diagnoseAgent({ dataDir: d });
  const join = findings.map((f) => f.symptom + f.action).join(" | ");
  assert.ok(join.includes("my_tool 失败率 75%"), "应报高失败率工具");
  assert.ok(join.includes("参数校验器拦截了 4 次"), "应报参数拦截计数");
  assert.ok(join.includes("权限/策略拦截 3 次"), "应报权限拦截");
  assert.ok(join.includes("单次调用平均 20000 tok"), "应报成本症状");
  assert.ok(join.includes("model_routing.aux"), "成本症状应指向分层路由");
  assert.ok(report.includes("[HIGH]"), "高失败率应为 high 级");
});

test("症状: 基线失败与失败案例库", () => {
  const d = tmpData();
  fs.writeFileSync(path.join(d, "bench-baseline-dummy"), "x"); // 占位避免误读
  // 基线: 放在 cwd 相对路径 bench/baseline.json → diagnose 读 dataDir/baseline.json 或 bench/baseline.json
  const baseline = { results: [{ id: "a", pass: true }, { id: "b", pass: false }, { id: "c", pass: false }] };
  fs.mkdirSync(path.join(d, "bench"), { recursive: true });
  fs.writeFileSync(path.join(d, "bench", "baseline.json"), JSON.stringify(baseline));
  // 失败案例库 ≥ 3 条
  fs.mkdirSync(path.join(d, "memory", "failures"), { recursive: true });
  const episodes = Array.from({ length: 4 }, (_, i) => ({ tool: `taskbench:t${i}`, error: "x", ts: Date.now() }));
  fs.writeFileSync(path.join(d, "memory", "failures", "episodes.json"), JSON.stringify(episodes));
  const { findings } = diagnoseAgent({ dataDir: d, rootDir: d });
  const join = findings.map((f) => f.symptom + f.action).join(" | ");
  assert.ok(join.includes("2 项未通过"), "应报基线失败数");
  assert.ok(join.includes("失败案例库 4 条"), "应报案例库规模");
  assert.ok(join.includes("归因分类"), "应给出归因分类动作");
});

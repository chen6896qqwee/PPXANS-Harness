// test/taskbench-offline-legacy.test.js - 旧 20 / 全 28 离线口径与机读报告守卫
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { LEGACY_TASK_IDS, TASKS } from "../bench/tasks.js";
import {
  buildOfflineReport,
  offlineExitCode,
  serializeOfflineReport,
  summarizeLegacy,
  writeOfflineReport,
} from "../scripts/taskbench-offline.js";

const EXPECTED_LEGACY_IDS = [
  "version-report", "count-files", "find-symbol", "sum-numbers", "read-secret",
  "create-file", "append-file", "json-edit", "delete-file", "json-create",
  "fix-syntax", "fix-logic", "write-function", "rename-symbol",
  "memory-roundtrip", "board-roundtrip", "analyze-and-report", "conditional-write",
  "src-listing", "extract-field",
];

function rows(ids, pass = true) {
  return ids.map((id) => ({ id, category: "test", pass, detail: "", ms: 0 }));
}

test("旧 20 个任务 ID 显式冻结, 全集仍是 28 且身份不漂移", () => {
  assert.equal(Object.isFrozen(LEGACY_TASK_IDS), true);
  assert.deepEqual([...LEGACY_TASK_IDS], EXPECTED_LEGACY_IDS);
  assert.equal(LEGACY_TASK_IDS.length, 20);
  assert.equal(TASKS.length, 28);
  assert.deepEqual(TASKS.slice(0, 20).map((t) => t.id), EXPECTED_LEGACY_IDS);
  assert.equal(new Set(TASKS.map((t) => t.id)).size, TASKS.length);
});

test("全量报告保留 28 总口径, legacy 单独汇总旧 20", () => {
  const results = rows(TASKS.map((t) => t.id));
  const report = buildOfflineReport(results, 123, "2026-11-16T00:00:00.000Z");
  assert.equal(report.total, 28);
  assert.equal(report.passed, 28);
  assert.equal(report.rate, 1);
  assert.deepEqual(report.legacy, { total: 20, passed: 20, rate: 1, complete: true });
  assert.equal(report.ts, "2026-11-16T00:00:00.000Z");
});

test("--only 旧题子集不能冒充完整 legacy; 新题子集 legacy 为零", () => {
  assert.deepEqual(summarizeLegacy(rows(["version-report"])), {
    total: 1, passed: 1, rate: 1, complete: false,
  });
  assert.deepEqual(summarizeLegacy(rows(["version-report", "count-files"], false)), {
    total: 2, passed: 0, rate: 0, complete: false,
  });
  assert.deepEqual(summarizeLegacy(rows(["ms-fg-exec"])), {
    total: 0, passed: 0, rate: 0, complete: false,
  });
});

test("strict 看所有选中任务: 新 8 题失败即使旧 20 全过也退 1", () => {
  const results = rows(TASKS.map((t) => t.id));
  results[results.length - 1].pass = false;
  const report = buildOfflineReport(results, 1);
  assert.equal(report.total, 28);
  assert.equal(report.passed, 27);
  assert.equal(report.legacy.complete, true);
  assert.equal(report.legacy.passed, 20);
  assert.equal(offlineExitCode(results, true), 1);
  assert.equal(offlineExitCode(results, false), 0);
  assert.equal(offlineExitCode(rows(["ms-fg-exec"], false), true), 1);
});

test("--out 写盘内容与 --json 序列化使用同一份机读报告", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ppx-offline-report-"));
  try {
    const report = buildOfflineReport(rows(["version-report"]), 7, "2026-11-16T00:00:00.000Z");
    const serialized = serializeOfflineReport(report);
    const target = writeOfflineReport(path.join(dir, "nested", "report.json"), serialized);
    assert.equal(fs.readFileSync(target, "utf8"), serialized + "\n");
    assert.deepEqual(JSON.parse(fs.readFileSync(target, "utf8")), JSON.parse(serialized));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

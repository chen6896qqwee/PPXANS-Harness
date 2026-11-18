// test/bench-raw-requests.test.js — 原始请求延迟记录及 nightly 机读协议 (纯离线 stub LLM)
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const NODE = process.execPath;
const MARKER = "PPX_BENCH_RAW_JSON";
const SMALL_ENV = {
  ...process.env,
  NO_COLOR: "1",
  PPX_BENCH_CONCURRENCY: "2",
  PPX_BENCH_ROUNDS: "2",
  PPX_BENCH_ISO_SESSIONS: "2",
  PPX_BENCH_ISO_ROUNDS: "1",
};

function runNode(args, options = {}) {
  return spawnSync(NODE, args, {
    cwd: ROOT,
    encoding: "utf8",
    timeout: 120_000,
    maxBuffer: 16 * 1024 * 1024,
    ...options,
  });
}

function markerPayload(stdout) {
  const lines = stdout.split(/\r?\n/).filter((line) => line.startsWith(`${MARKER} `));
  assert.equal(lines.length, 1, "stdout 应恰好有一行原始请求机读标记");
  return JSON.parse(lines[0].slice(MARKER.length).trim());
}

function reportFrom(outDir) {
  const file = fs.readdirSync(outDir).find((name) => /^nightly-.*\.json$/.test(name));
  assert.ok(file, "nightly 应写出 JSON 报告");
  return JSON.parse(fs.readFileSync(path.join(outDir, file), "utf8"));
}

function validRequest(overrides = {}) {
  return {
    phase: "concurrent",
    worker: 0,
    round: 0,
    sessionKey: "default",
    ok: true,
    ms: 3,
    ...overrides,
  };
}

function validPayload(overrides = {}) {
  const rawRequests = overrides.raw_requests || [validRequest()];
  return { raw_schema: 1, count: rawRequests.length, raw_requests: rawRequests, ...overrides };
}

// 在系统临时目录复制 nightly 驱动，其他基准用离线夹具，专测 bench marker 协议。
function runNightlyFixture(t, { markers, exitCode = 0 }) {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "ppx-nightly-raw-"));
  t.after(() => fs.rmSync(fixture, { recursive: true, force: true }));
  fs.mkdirSync(path.join(fixture, "scripts"));
  fs.writeFileSync(path.join(fixture, "package.json"), JSON.stringify({ type: "module" }));
  fs.copyFileSync(path.join(ROOT, "scripts/nightly-bench.js"), path.join(fixture, "scripts/nightly-bench.js"));
  fs.writeFileSync(path.join(fixture, "scripts/eval.js"), "console.log('7 过 / 0 挂');\n");
  fs.writeFileSync(path.join(fixture, "scripts/selfheal-bench.js"), "console.log('7 / 7');\n");
  fs.writeFileSync(path.join(fixture, "scripts/audit-verify.js"), "console.log('链完整性: 完整\\nHMAC: 启用');\n");
  const markerLines = markers.map((line) => `console.log(${JSON.stringify(line)});`).join("\n");
  fs.writeFileSync(path.join(fixture, "scripts/bench.js"), `
console.log('调用 1 | 失败 0 | p50 3ms | p95 3ms | p99 3ms');
console.log('1 轮成功 1 | 3.0ms/轮');
${markerLines}
process.exitCode = ${exitCode};
`);

  const run = runNode(["scripts/nightly-bench.js", "--out", "out"], { cwd: fixture });
  const report = reportFrom(path.join(fixture, "out"));
  return { run, report, bench: report.results.find((result) => result.key === "bench") };
}

test("bench 小 rounds 离线运行记录四阶段每次请求且不含正文", () => {
  const run = runNode(["scripts/bench.js"], { env: SMALL_ENV });
  assert.equal(run.status, 0, run.stderr || run.stdout);
  const payload = markerPayload(run.stdout);
  assert.equal(payload.raw_schema, 1);
  assert.equal(payload.count, 8);
  assert.equal(payload.raw_requests.length, 8);
  assert.equal(Object.keys(payload).includes("count"), true);

  const counts = {};
  for (const request of payload.raw_requests) {
    counts[request.phase] = (counts[request.phase] || 0) + 1;
    assert.equal(request.ok, true);
    assert.ok(Number.isFinite(request.ms) && request.ms >= 0);
    assert.ok(Number.isInteger(request.round) && request.round >= 0);
    assert.equal(typeof request.sessionKey, "string");
    assert.ok(request.sessionKey.length > 0);
    const expectedKeys = request.phase === "long_session" || request.phase === "serial"
      ? ["ms", "ok", "phase", "round", "sessionKey"]
      : ["ms", "ok", "phase", "round", "sessionKey", "worker"];
    assert.deepEqual(Object.keys(request).sort(), expectedKeys, "原始记录只能含定位、状态和延迟字段");
  }
  assert.deepEqual(counts, { concurrent: 2, long_session: 2, isolated_concurrent: 2, serial: 2 });
  for (const request of payload.raw_requests) {
    if (request.phase === "isolated_concurrent") assert.equal(request.sessionKey, `iso-${request.worker}`);
    else if (request.phase === "serial") assert.equal(request.sessionKey, "seq-one");
    else assert.equal(request.sessionKey, "default");
  }
  assert.match(run.stdout, /p50 \d+ms \| p95 \d+ms \| p99 \d+ms/);
  assert.match(run.stdout, /=== bench 完成/);
});

test("nightly 小 rounds 离线集成保留现有字段并附加 raw_schema/count/raw_requests", () => {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "ppx-nightly-integration-"));
  try {
    const run = runNode(["scripts/nightly-bench.js", "--out", path.relative(ROOT, outDir)], { env: SMALL_ENV });
    assert.equal(run.status, 0, run.stderr || run.stdout);
    const report = reportFrom(outDir);
    assert.equal(report.all_ok, true);
    const bench = report.results.find((result) => result.key === "bench");
    assert.equal(bench.ok, true);
    assert.equal(bench.exit, 0);
    assert.equal(bench.raw_schema, 1);
    assert.equal(bench.count, 8);
    assert.equal(bench.raw_requests.length, 8);
    assert.equal(typeof bench.duration_ms, "number");
    assert.deepEqual(Object.keys(bench.metrics).sort(), ["p50_ms", "p95_ms", "p99_ms", "per_round_ms"].sort());
    assert.ok(bench.tail.length > 0 && bench.tail.length <= 12);
    assert.equal(bench.tail.some((line) => line.startsWith(MARKER)), false, "tail 不得泄漏机读行");
  } finally {
    fs.rmSync(outDir, { recursive: true, force: true });
  }
});

test("nightly 保留失败请求原始记录，同时因子进程非零而失败", (t) => {
  const failed = validRequest({ ok: false, ms: 9 });
  const payload = validPayload({ raw_requests: [failed] });
  const { run, report, bench } = runNightlyFixture(t, {
    markers: [`${MARKER} ${JSON.stringify(payload)}`],
    exitCode: 1,
  });
  assert.equal(run.status, 1);
  assert.equal(report.all_ok, false);
  assert.equal(bench.ok, false);
  assert.equal(bench.exit, 1);
  assert.equal(bench.raw_schema, 1);
  assert.equal(bench.count, 1);
  assert.deepEqual(bench.raw_requests, [failed]);
  assert.equal(bench.tail.some((line) => line.startsWith(MARKER)), false);
});

test("nightly 对缺失、损坏、重复及字段不全的 raw marker 一律失败", async (t) => {
  const incomplete = validRequest();
  delete incomplete.ms;
  const cases = [
    ["缺失 marker", []],
    ["损坏 JSON", [`${MARKER} {not-json}`]],
    ["重复 marker", [
      `${MARKER} ${JSON.stringify(validPayload())}`,
      `${MARKER} ${JSON.stringify(validPayload())}`,
    ]],
    ["字段不全", [`${MARKER} ${JSON.stringify(validPayload({ raw_requests: [incomplete] }))}`]],
    ["count 不一致", [`${MARKER} ${JSON.stringify(validPayload({ count: 2 }))}`]],
  ];

  for (const [name, markers] of cases) {
    await t.test(name, (t) => {
      const { run, report, bench } = runNightlyFixture(t, { markers });
      assert.equal(run.status, 1);
      assert.equal(report.all_ok, false);
      assert.equal(bench.ok, false);
      assert.equal(bench.exit, 0, "raw 协议错误本身必须让 nightly 失败");
      assert.equal("raw_requests" in bench, false);
      assert.equal(bench.tail.some((line) => line.startsWith(MARKER)), false);
    });
  }
});

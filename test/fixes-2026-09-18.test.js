// test/fixes-2026-09-18.test.js — 全面体检修复的回归测试
// 覆盖: PostToolUse additionalContext 集成 / SSRF IPv6 / apply_patch 路径防护 /
//       Scheduler 重启恢复 / readBody UTF-8 多字节 / trace type 覆盖 / FactStore 归档去重
import test from "node:test";
import assert from "node:assert";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { PPXAgent } from "../src/agent/index.js";
import { Scheduler, isPrivateIP } from "../src/tools/advanced.js";
import { ToolCatalog } from "../src/tools/index.js";
import { registerV3Tools } from "../src/tools/v3.js";
import { readBody } from "../src/utils/http.js";
import { EventTracer } from "../src/core/trace.js";
import { FactStore } from "../src/memory/fact-store.js";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
function tmpRoot(n) { return fs.mkdtempSync(path.join(os.tmpdir(), `ppx-fix-${n}-`)); }

// ---- 1. PostToolUse additionalContext 集成 (原为 const result 重新赋值 TypeError) ----
test("PostToolUse 钩子 additionalContext 追加到工具结果", async () => {
  const a = new PPXAgent({ root: tmpRoot("hookctx") });
  const un = a.hooks.on("PostToolUse", () => ({ additionalContext: "[ctx-extra]" }));
  const r = await a._runTool("get_time", {});
  un();
  assert.ok(r.includes("[ctx-extra]"), "additionalContext 应追加到结果尾部");
  a.shutdown();
});

test("PreToolUse 钩子改参生效 (regression: 同一赋值链路)", async () => {
  const a = new PPXAgent({ root: tmpRoot("hookargs") });
  const un = a.hooks.on("PreToolUse", () => ({})); // 不改参不否决, 主链应正常
  const r = await a._runTool("get_time", {});
  un();
  assert.ok(!r.startsWith("[工具错误]"), "正常工具不应报错");
  a.shutdown();
});

// ---- 2. SSRF: IPv6 字面量判定 ----
test("isPrivateIP: IPv6 回环/链路本地/唯一本地/映射地址全部判定为内网", () => {
  assert.equal(isPrivateIP("::1"), true);
  assert.equal(isPrivateIP("[::1]"), true);
  assert.equal(isPrivateIP("::"), true);
  assert.equal(isPrivateIP("fe80::1"), true);
  assert.equal(isPrivateIP("fc00::1"), true);
  assert.equal(isPrivateIP("fd12:3456::ab"), true);
  assert.equal(isPrivateIP("::ffff:127.0.0.1"), true);
  assert.equal(isPrivateIP("::ffff:10.0.0.5"), true);
  assert.equal(isPrivateIP("169.254.169.254"), true);
  assert.equal(isPrivateIP("192.168.1.1"), true);
  // 公网地址不误伤
  assert.equal(isPrivateIP("8.8.8.8"), false);
  assert.equal(isPrivateIP("2001:4860:4860::8888"), false);
});

test("http_request 拒绝 IPv6 回环目标", async () => {
  const a = new PPXAgent({ root: tmpRoot("ssrf6") });
  const raw = await a.tools.call("http_request", { url: "http://[::1]:1/" });
  assert.ok(/SSRF/.test(raw), `应拒绝 IPv6 回环: ${raw}`);
  a.shutdown();
});

// ---- 3. apply_patch 路径防护 (原绕过 safePath 可写工作区外) ----
test("apply_patch 拒绝工作区外的绝对路径", async () => {
  const root = tmpRoot("patch");
  const catalog = new ToolCatalog();
  registerV3Tools(catalog, { rootDir: root });
  const outside = path.join(root, "..", "escaped-by-patch.txt");
  // editblock 格式: 路径行紧跟 <<<<<<< SEARCH 之后
  const content = `<<<<<<< SEARCH\n${outside}\nold\n=======\nx\n>>>>>>> REPLACE`;
  const r = JSON.parse(await catalog.call("apply_patch", { content }));
  assert.ok(r.error, "应返回错误");
  assert.ok(!fs.existsSync(outside), "工作区外文件不应被创建");
});

test("apply_patch 拒绝 .. 穿越路径", async () => {
  const root = tmpRoot("patch");
  const catalog = new ToolCatalog();
  registerV3Tools(catalog, { rootDir: root });
  const content = `<<<<<<< SEARCH\n../escaped.txt\n=======\nx\n>>>>>>> REPLACE`;
  const r = JSON.parse(await catalog.call("apply_patch", { content }));
  assert.ok(r.error, "应返回错误");
  assert.ok(!fs.existsSync(path.join(root, "..", "escaped.txt")), "穿越目标不应被创建");
});

test("apply_patch 正常工作区内编辑不受影响", async () => {
  const root = tmpRoot("patch");
  fs.writeFileSync(path.join(root, "a.txt"), "hello\n", "utf8");
  const catalog = new ToolCatalog();
  registerV3Tools(catalog, { rootDir: root });
  const content = `<<<<<<< SEARCH\na.txt\nhello\n=======\nworld\n>>>>>>> REPLACE`;
  const r = JSON.parse(await catalog.call("apply_patch", { content }));
  assert.equal(r.ok, true);
  assert.equal(fs.readFileSync(path.join(root, "a.txt"), "utf8"), "world\n");
});

// ---- 4. Scheduler 重启恢复 ----
test("Scheduler 重启后重排每日任务, 陈旧 once 任务被丢弃", async () => {
  const root = tmpRoot("sched");
  const file = path.join(root, "scheduler", "jobs.json");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  // 预置: 一个每日任务 + 一个陈旧 once 任务 + 一个 disabled 任务
  fs.writeFileSync(file, JSON.stringify([
    { id: "j_daily", name: "每日报告", cron: "23:59", type: "daily", enabled: true, createdAt: "2026-01-01T00:00:00Z" },
    { id: "j_stale", name: "陈旧一次性", cron: "after:60", type: "once", enabled: true, createdAt: "2026-01-01T00:00:00Z" },
    { id: "j_off", name: "已停用", cron: "08:00", type: "daily", enabled: false, createdAt: "2026-01-01T00:00:00Z" },
  ]), "utf8");
  let fired = null;
  const s = new Scheduler(root, { onFire: (job) => { fired = job.name; } });
  try {
    // 每日任务已重排 (有活定时器)
    assert.ok(s.timers.has("j_daily"), "每日任务应有定时器");
    assert.ok(!s.timers.has("j_stale"), "陈旧 once 任务不应重排");
    assert.ok(!s.timers.has("j_off"), "停用任务不应重排");
    // 陈旧 once 已从 jobs 清除
    assert.ok(!s.jobs.some((j) => j.id === "j_stale"));
    // 恢复任务触发时走 onFire 兜底
    const job = s.jobs.find((j) => j.id === "j_daily");
    await s._fire(job);
    assert.equal(fired, "每日报告", "无 action 的恢复任务应走 onFire 兜底");
  } finally {
    s.shutdown();
  }
});

test("Scheduler 正常 add 的闭包 action 不受影响", async () => {
  const root = tmpRoot("sched2");
  const s = new Scheduler(root);
  let hit = false;
  const job = s.add({ name: "t", cron: "after:1", action: () => { hit = true; } });
  await new Promise((r) => setTimeout(r, 1200));
  assert.ok(hit, "闭包 action 应正常触发");
  assert.ok(!s.jobs.some((j) => j.id === job.id), "once 触发后应移除");
  s.shutdown();
});

// ---- 5. readBody: 多字节 UTF-8 跨块不损坏 ----
test("readBody 分块边界落在中文中间时仍完整解码", async () => {
  const full = Buffer.from("皮皮虾记忆提取:中文请求体完整性校验", "utf8");
  // 按字节切成 3 块, 强制让切点落在多字节字符中间
  const chunks = [full.subarray(0, 7), full.subarray(7, 21), full.subarray(21)];
  const req = (async function* () { for (const c of chunks) yield c; })();
  const body = await readBody(req, { maxBytes: 0 });
  assert.equal(body, "皮皮虾记忆提取:中文请求体完整性校验");
});

test("readBody 超限返回 null (字节计)", async () => {
  const req = (async function* () { yield Buffer.from("abc中文def"); })();
  const body = await readBody(req, { maxBytes: 5 });
  assert.equal(body, null);
});

// ---- 6. EventTracer: payload.type 不覆盖埋点事件类型 ----
test("tracer.event 的 type 不被 payload 同名键覆盖", () => {
  const dir = tmpRoot("trace");
  const t = new EventTracer(dir);
  t.event("tool/step", { type: "evil", n: 1 });
  // EventTracer 写到 <dataDir>/logs/traces/events-<day>.jsonl
  const traceDir = path.join(dir, "logs", "traces");
  const file = fs.readdirSync(traceDir).map((f) => path.join(traceDir, f)).find((p) => /^events-.*\.jsonl$/.test(path.basename(p)));
  assert.ok(file, "事件文件应落盘");
  const entry = JSON.parse(fs.readFileSync(file, "utf8").trim().split("\n").pop());
  assert.equal(entry.type, "tool/step");
  assert.equal(entry.n, 1);
});

// ---- 7. FactStore: 精确去重不命中 archived 版本链 ----
test("归档旧版本不再拦截新记忆写入", () => {
  const dir = tmpRoot("facts");
  const store = new FactStore(dir);
  const f1 = store.add("用户喜欢深色主题", { source: "test" });
  store.update(f1.id, "用户喜欢浅色主题", { source: "test" });
  // 此时 "用户喜欢深色主题" 只存在于 archived 副本 (update 原地改内容 + 入链归档)
  // 再次写入相同内容: 修复前会命中 archived 副本并直接返回它; 修复后应新建活跃记忆
  const f3 = store.add("用户喜欢深色主题", { source: "test" });
  assert.equal(f3.status, "active", "返回的应是新活跃记忆, 而非 archived 副本");
  assert.ok(store.list().some((f) => f.id === f3.id), "活跃列表应包含新记忆");
});

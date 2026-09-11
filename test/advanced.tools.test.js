// test/advanced.tools.test.js - 进阶工具测试
import test from "node:test";
import assert from "node:assert";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { PPXAgent } from "../src/agent/index.js";
import { Scheduler } from "../src/tools/index.js";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const NET = process.env.PPX_NET_TEST === "1";
function tmpRoot(n){ return fs.mkdtempSync(path.join(os.tmpdir(), `ppx-${n}-`)); }

test("agent 注册了进阶工具", () => {
  const a = new PPXAgent({ root: tmpRoot("adv") });
  assert.ok(a.tools.has("web_search"), "web_search 已注册");
  assert.ok(a.tools.has("http_request"), "http_request 已注册");
  assert.ok(a.tools.has("add_schedule"), "add_schedule 已注册");
  assert.ok(a.tools.has("list_schedules"), "list_schedules 已注册");
  a.shutdown();
});

test("Scheduler once 定时执行", async () => {
  const s = new Scheduler(tmpRoot("adv-sched"));
  let fired = false;
  s.add({ name: "test", cron: "after:1", type: "once", action: () => { fired = true; } });
  await new Promise((r) => setTimeout(r, 1500));
  assert.ok(fired, "1秒后应触发");
  assert.equal(s.list().length, 0, "once 任务执行后应移除");
});

test("Scheduler 每日时间解析", () => {
  const s = new Scheduler(tmpRoot("adv-sched"));
  const job = s.add({ name: "daily-test", cron: "23:59", type: "daily", action: () => {} });
  assert.ok(job.id);
  assert.equal(s.list().length, 1);
  s.remove(job.id);
});

test("http_request GET 打通", { skip: !NET, timeout: 20000 }, async () => {
  const a = new PPXAgent({ root: tmpRoot("adv") });
  const r = await a.tools.call("http_request", { url: "https://api.github.com/zen", method: "GET" });
  const parsed = JSON.parse(r);
  assert.ok(parsed.status === 200 || parsed.ok === true || parsed.error, `status=${parsed.status}`);
  a.shutdown();
});

test("web_search 返回结果", { skip: !NET, timeout: 20000 }, async () => {
  const a = new PPXAgent({ root: tmpRoot("adv") });
  const r = await a.tools.call("web_search", { query: "openclaw agent" });
  assert.ok(typeof r === "string");
  if (!r.startsWith("{")) assert.ok(r.includes("1."), "应返回编号结果");
  a.shutdown();
});

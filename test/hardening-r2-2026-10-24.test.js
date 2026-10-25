// test/hardening-r2-2026-10-24.test.js - 2026-10-24 第二轮加固回归测试
// 覆盖: streamChat 计账 / 回退重放防双执行 / 文件撤销栈 undo_file / catalog 重名告警 /
//       微信防重放 / repomap import 边 / review 真实 move 检测
import test from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { PPXAgent } from "../src/agent/index.js";
import { ToolCatalog } from "../src/tools/catalog.js";
import { registerBuiltinTools } from "../src/tools/builtin.js";
import { WechatWebhookChannel } from "../src/channels/wechat.js";
import { scanRepo, computePageRank, clearRepoMapCache } from "../src/repomap/index.js";
import { detectMovesFromDiff, relocateIssues } from "../src/review/index.js";
import { Snapshot } from "../src/edit/snapshot.js";

function tmpDir(tag) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `ppx-r2-${tag}-`));
}

// ================= 1. streamChat 计账 =================
test("usage: streamChat 纳入计账 (此前流式轮次对预算闸门失明)", async () => {
  const root = tmpDir("usage");
  const agent = new PPXAgent({ root, configFile: null });
  const stub = {
    model: "stub-model",
    chat: async () => ({ content: "x", usage: { total_tokens: 10 } }),
    streamChat: async (_m, { onDelta } = {}) => { onDelta?.("hello"); return "hello world"; },
    apiChat: async () => ({ message: { role: "assistant", content: "x" } }),
  };
  agent.allProviders = [stub];
  agent.llm = stub;
  const before = { ...agent.usageStats };
  agent._installUsageTracking();
  await stub.streamChat([{ role: "user", content: "hi there" }], {});
  assert.ok(agent.usageStats.calls > before.calls, "流式调用计入 calls");
  assert.ok(agent.usageStats.tokens > before.tokens, "流式轮次按估算计入 tokens (预算闸门可见)");
  agent.shutdown();
  fs.rmSync(root, { recursive: true, force: true });
});

// ================= 2. 回退重放防双执行 =================
test("replay-memo: 降级重试中非幂等工具不重复执行, 正常轮内不受影响", async () => {
  const root = tmpDir("memo");
  const agent = new PPXAgent({ root, configFile: null });
  let calls = 0;
  agent.tools = {
    call: async () => { calls++; return `result-${calls}`; },
    getCapability: () => ({ readOnly: false, riskLevel: "medium", destructive: false, sideEffect: "workspace" }),
  };
  agent._toolIdempotent = () => false; // 视为非幂等
  agent._turnAttempt = 0;
  agent._turnExecCache = new Map();

  // 正常轮 (attempt=0): 同参数两次调用 = 模型刻意重复, 都真实执行
  await agent._runTool("write_file", { path: "a.txt", content: "x" });
  await agent._runTool("write_file", { path: "a.txt", content: "x" });
  assert.equal(calls, 2, "正常轮不拦截刻意重复");

  // 降级后 (attempt>0): 相同 调用走回放缓存, 不再执行
  agent._turnAttempt = 1;
  const r = await agent._runTool("write_file", { path: "a.txt", content: "x" });
  assert.equal(calls, 2, "回放轮未重复执行");
  assert.ok(r.includes("回放缓存"), "回执带回放缓存标注");
  assert.ok(r.includes("result-2"), "返回先前真实结果");

  // 参数不同 = 新调用, 正常执行
  const r2 = await agent._runTool("write_file", { path: "a.txt", content: "y" });
  assert.equal(calls, 3);
  assert.ok(r2.startsWith("result-3"));
  agent.shutdown();
  fs.rmSync(root, { recursive: true, force: true });
});

// ================= 3. 文件撤销栈 undo_file =================
function makeToolAgent(root) {
  const catalog = new ToolCatalog();
  const factsStub = { add: () => {}, count: () => 0, list: () => [], search: () => [] };
  const memoryStub = { recordTurn: async () => {} };
  registerBuiltinTools(catalog, { rootDir: root, facts: factsStub, memory: memoryStub });
  return catalog;
}

test("undo_file: write 覆盖可撤销, delete 可恢复, append 可回退", async () => {
  const root = tmpDir("undo");
  const catalog = makeToolAgent(root);
  const file = path.join(root, "doc.txt");
  fs.writeFileSync(file, "v1\n", "utf8");

  // 覆盖 → undo → 恢复 v1
  await catalog.call("write_file", { path: "doc.txt", content: "v2\n" }, {});
  assert.equal(fs.readFileSync(file, "utf8"), "v2\n");
  const u1 = JSON.parse(await catalog.call("undo_file", { path: "doc.txt" }, {}));
  assert.equal(u1.ok, true);
  assert.equal(fs.readFileSync(file, "utf8"), "v1\n", "覆盖被撤销");

  // 追加 → undo → 回到 v1
  await catalog.call("append_file", { path: "doc.txt", content: "extra" }, {});
  await catalog.call("undo_file", { path: "doc.txt" }, {});
  assert.equal(fs.readFileSync(file, "utf8"), "v1\n", "追加被撤销");

  // 删除 → undo → 文件复活
  await catalog.call("delete_file", { path: "doc.txt" }, {});
  assert.ok(!fs.existsSync(file));
  const u3 = JSON.parse(await catalog.call("undo_file", {}, {}));
  assert.equal(u3.ok, true);
  assert.equal(fs.readFileSync(file, "utf8"), "v1\n", "删除被撤销");

  // 栈空
  const u4 = JSON.parse(await catalog.call("undo_file", {}, {}));
  assert.ok(u4.error, "无记录时报错而非装成功");
  fs.rmSync(root, { recursive: true, force: true });
});

test("snapshot.rollback: 失败不再静默 (收集 failures)", () => {
  const root = tmpDir("snap");
  const file = path.join(root, "f.txt");
  const snap = Snapshot.begin([file]); // 不存在的文件 → existed=false
  fs.mkdirSync(file); // 让"删除新建文件"注定失败 (路径变成目录)
  const r = Snapshot.rollback(snap);
  assert.equal(r.ok, false);
  assert.ok(r.failures.length >= 1, "失败被收集而非吞掉");
  fs.rmSync(root, { recursive: true, force: true });
});

// ================= 4. catalog 重名注册告警 =================
test("catalog: 重名注册出声告警 (last-wins 语义保留)", () => {
  const c = new ToolCatalog();
  const def = { name: "t", description: "d", execute: async () => "a" };
  c.register(def);
  const warnings = [];
  const origWarn = console.warn;
  console.warn = (...a) => warnings.push(a.join(" "));
  try {
    c.register({ ...def, execute: async () => "b" });
  } finally { console.warn = origWarn; }
  assert.equal(c.tools.size, 1, "仍是单一条目 (last-wins)");
  assert.ok(warnings.some((w) => w.includes("工具重名覆盖")), "覆盖必须留痕");
});

// ================= 5. 微信防重放 =================
test("wechat: 同一 MsgId 重发不重复驱动对话", async () => {
  const ch = new WechatWebhookChannel({ chat: async () => "回复" }, {});
  const xml = `<xml><ToUserName><![CDATA[to]]></ToUserName><FromUserName><![CDATA[from]]></FromUserName><CreateTime>1700000000</CreateTime><MsgType><![CDATA[text]]></MsgType><Content><![CDATA[你好]]></Content><MsgId>123456</MsgId></xml>`;
  const r1 = await ch._replyFromXml(xml);
  assert.ok(r1.xml.includes("回复"), "首次正常回复");
  const r2 = await ch._replyFromXml(xml);
  assert.equal(r2, "", "重发回空体 (不重复驱动)");
  // 不同 MsgId 正常处理
  const r3 = await ch._replyFromXml(xml.replace("123456", "654321"));
  assert.ok(r3.xml.includes("回复"));
});

// ================= 6. repomap import 边 =================
test("repomap: 相对 import 解析为跨文件边 + 文件节点进图", () => {
  const root = tmpDir("map");
  fs.writeFileSync(path.join(root, "a.js"), "export function helper(x) { return x + 1; }\n");
  // 注意: import 语句用拼接构造 —— depcheck 静态扫描会把测试源码里的字面 import 当真实依赖
  const IMPORT_STMT = "import { helper } from " + "'./" + "a" + ".js';";
  fs.writeFileSync(path.join(root, "b.js"), IMPORT_STMT + "\nexport function main() { return helper(1); }\n");
  const scan = scanRepo(root, { maxFiles: 10 });
  assert.ok(scan.importEdges.some(([f, t, w]) => f === "b.js" && t === "a.js" && w === 2), "b.js → a.js import 边 (权重 2)");
  const rank = computePageRank(scan);
  assert.ok(rank.has("@a.js"), "文件节点参与 PageRank");
  // 裸包名/外部依赖不进图
  fs.writeFileSync(path.join(root, "c.js"), "import fs from 'node:fs';\nimport x from 'some-package';\nexport const y = 1;\n");
  clearRepoMapCache();
  const scan2 = scanRepo(root, { maxFiles: 10 });
  assert.ok(!scan2.importEdges.some(([, t]) => t.includes("node:fs") || t.includes("some-package")), "外部依赖不解析为仓内边");
  fs.rmSync(root, { recursive: true, force: true });
});

// ================= 7. review 真实 move 检测 =================
test("review: 代码从 a.js 移到 b.js, 同标题 issue 只留 to 端", () => {
  const diff = [
    "diff --git a/a.js b/a.js",
    "--- a/a.js",
    "+++ b/a.js",
    "@@ -1,2 +1,0 @@",
    "-function total(items) { return items.reduce((s, x) => s + x.price, 0); }",
    "diff --git a/b.js b/b.js",
    "--- a/b.js",
    "+++ b/b.js",
    "@@ -0,0 +1,2 @@",
    "+function total(items) { return items.reduce((s, x) => s + x.price, 0); }",
  ].join("\n");
  const moves = detectMovesFromDiff(diff);
  assert.equal(moves.length, 1, "识别出一对换位");
  assert.equal(moves[0].from, "a.js");
  assert.equal(moves[0].to, "b.js");
  const issues = [
    { title: "空 catch", file: "a.js", severity: "medium" },
    { title: "空 catch", file: "b.js", severity: "medium" },
    { title: "别的", file: "a.js", severity: "low" },
  ];
  const kept = relocateIssues(issues, moves);
  assert.deepEqual(kept.map((i) => `${i.title}@${i.file}`), ["空 catch@b.js", "别的@a.js"], "空 catch 只留 to 端 (b.js), from 端 (a.js) 副本去重");
});

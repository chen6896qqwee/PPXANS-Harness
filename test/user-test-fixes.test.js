// test/user-test-fixes.test.js - 用户实测发现问题的回归测试 (v1.0.8)
//
// 每个 test 对应 USER-TEST-REPORT.md 里的一条实测发现, 用于锁死修复不被回退:
//   P1-1 记忆污染: 用户提问被当长期事实入库 (fact-store.addMemory 的长度前置条件架空过滤器)
//   P1-2 自愈目录归属: Healer 硬编码 root/data, PPX_DATA_DIR 自定义时与真实数据目录分叉
//   P2-1 本地意图回复泄漏: `[工具] {"ok":true,...}` 直接回给用户
//   P2-2 静默降级: provider 回退对用户不可见
//   P2-3 占位符模型: YOUR_LOCAL_MODEL_NAME 被选成主模型
import test from "node:test";
import assert from "node:assert";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import { PPXAgent } from "../src/agent/index.js";
import { FactStore } from "../src/memory/fact-store.js";
import { Healer } from "../src/selfheal/healer.js";
import { isUsableProvider, resolveLLM } from "../src/llm/router.js";
import { isPlaceholder, hasPlaceholderField } from "../src/config/placeholder.js";

function tmpRoot(tag) { return fs.mkdtempSync(path.join(os.tmpdir(), `ppx-${tag}-`)); }

// ==================== P1-1 记忆污染 ====================

test("P1-1: 长疑问句/指令句不再入库 (原 length<=8 前置条件导致逃逸)", () => {
  const dir = tmpRoot("p11");
  const fsdb = new FactStore(dir, {});
  // 这几条都是实测中真实污染过记忆库的用户提问 (长度 9~20, 旧实现全部放行)
  const polluted = [
    "现在几点了兄弟",
    "今天几号了现在",
    "帮我看看这个文件里写了什么内容",
    "你知道我上次说的那个方案吗",
    "这个项目的测试怎么跑呢",
    "为什么启动的时候会报这个错误啊",
    "文件放在哪里的来着",
    "列出服务器目录",
  ];
  for (const q of polluted) {
    assert.equal(fsdb.addMemory(q), null, `疑问/指令不应入库: ${q}`);
  }
  // 陈述性事实必须保留 —— 修复不能把好数据一起误杀
  const kept = [
    "兄弟喜欢做A股量化交易",
    "我习惯用 Node 22 跑测试",
    "项目部署在阿里云的服务器上",
    "他说过要把架构文档整理一遍",
  ];
  for (const s of kept) {
    const f = fsdb.addMemory(s);
    assert.ok(f, `陈述性事实应入库: ${s}`);
    assert.equal(f.content, s);
  }
});

test("P1-1: 问号/疑问助词收尾一律判为提问", () => {
  const dir = tmpRoot("p11b");
  const fsdb = new FactStore(dir, {});
  assert.equal(fsdb.addMemory("这个方案你觉得可行? "), null, "半角问号收尾");
  assert.equal(fsdb.addMemory("这个方案你觉得可行？"), null, "全角问号收尾");
  assert.equal(fsdb.addMemory("今天天气不错吗"), null, "吗字收尾");
});

// ==================== P1-2 自愈目录归属 ====================

test("P1-2: Healer 可用显式 dataDir (PPX_DATA_DIR 自定义场景)", () => {
  const root = tmpRoot("p12-root");
  const custom = path.join(tmpRoot("p12-elsewhere"), "real-data");
  const h = new Healer(root, custom);
  assert.equal(h.dataDir, custom, "dataDir 应取显式传入值");
  assert.equal(h.integrity, path.join(custom, "integrity.json"), "integrity.json 应落在显式 dataDir 下");
  h.runStartupChecks();
  assert.ok(fs.existsSync(path.join(custom, "memory")), "体检应在显式 dataDir 下建 memory/");
  // 关键回归点: 不能在 root/data 里偷偷建目录 (旧行为)
  assert.equal(fs.existsSync(path.join(root, "data")), false, "不应再往 root/data 里写");
});

test("P1-2: Healer 单参构造仍默认 root/data (15 处旧调用点向后兼容)", () => {
  const root = tmpRoot("p12-compat");
  const h = new Healer(root);
  assert.equal(h.dataDir, path.join(root, "data"));
});

test("P1-2: 插件装配下 healer 与 facts 指向同一数据目录", () => {
  const root = tmpRoot("p12-wire");
  const dataDir = path.join(tmpRoot("p12-wire-data"), "custom");
  const a = new PPXAgent({ root, configFile: null, dataDir });
  const healer = a.ctx.consume("healer");
  assert.ok(healer, "healer 已装配");
  assert.equal(path.resolve(healer.dataDir), path.resolve(dataDir), "healer.dataDir 应等于 agent 的真实 dataDir");
  assert.equal(fs.existsSync(path.join(root, "data")), false, "root/data 不应被自愈创建");
  a.shutdown();
});

// ==================== P2-1 本地意图回复泄漏 ====================

test("P2-1: 本地意图回复不带 [工具] 标记, 且不泄漏原始 JSON", async () => {
  const a = new PPXAgent({ root: tmpRoot("p21"), configFile: null });
  const t = await a._localIntent("现在几点");
  assert.ok(t && !t.includes("[工具]"), `不应含内部标记: ${t}`);
  assert.ok(/现在是/.test(t), `应为人话: ${t}`);
  assert.ok(!t.includes('"ok"'), "不应泄漏原始 JSON");

  // memory_add 返回 {"ok":true,"id":...} —— 旧实现原样喷给用户
  const r = await a._localIntent("记住: 兄弟偏好简洁的中文回复");
  assert.ok(!r.includes("[工具]") && !r.includes('"ok"'), `不应泄漏 JSON: ${r}`);
  assert.ok(/记下了/.test(r), `应为人话: ${r}`);
  a.shutdown();
});

test("P2-1: 工具失败时不泄漏错误前缀, 给可读提示", async () => {
  const a = new PPXAgent({ root: tmpRoot("p21b"), configFile: null });
  a.tools.call = async () => "[工具错误] 未知工具: read_file";
  const r = await a._localIntent("读文件 /no/such/file.txt");
  assert.ok(!r.includes("[工具错误]"), `不应泄漏错误前缀: ${r}`);
  assert.ok(/没办成/.test(r), `应给人话: ${r}`);
  a.shutdown();
});

// ==================== P2-3 占位符模型 ====================

test("P2-3: YOUR_LOCAL_MODEL_NAME 被识别为占位符", () => {
  assert.equal(isPlaceholder("YOUR_LOCAL_MODEL_NAME"), true, "模板里 lmstudio 的 model 值");
  assert.equal(isPlaceholder("YOUR_API_KEY"), true);
  assert.equal(isPlaceholder("REPLACE_WITH_YOUR_ENDPOINT"), true);
  assert.equal(isPlaceholder("qwen-turbo"), false, "真实模型名不受影响");
  assert.equal(isPlaceholder("glm-5v-turbo"), false);
  assert.equal(isPlaceholder(""), false);
});

test("P2-3: 占位符 model 的本地 provider 不再被判为可用/选为主模型", () => {
  const tplLmStudio = { id: "lmstudio", base_url: "http://127.0.0.1:1234/v1", api_key: "lm-studio", model: "YOUR_LOCAL_MODEL_NAME" };
  assert.equal(isUsableProvider(tplLmStudio), false, "模板占位 model → 不可用");
  const real = { ...tplLmStudio, model: "qwen2.5-7b-instruct" };
  assert.equal(isUsableProvider(real), true, "填了真模型名 → 可用 (本地零配置兜底不变)");

  const cfg = { providers: [tplLmStudio] };
  assert.equal(resolveLLM(cfg), null, "只有占位配置时不应选出主模型 (旧行为: 选中 lmstudio → 每轮必败再回退)");
});

test("P2-3: provider 占位字段可被定位 (供启动告警精确提示)", () => {
  const p = { id: "volcengine", base_url: "https://ark.cn-beijing.volces.com/api/v3", model: "REPLACE_WITH_YOUR_ENDPOINT" };
  assert.equal(hasPlaceholderField(p), true);
  assert.equal(hasPlaceholderField({ id: "x", base_url: "https://api.deepseek.com/v1", model: "deepseek-chat" }), false);
});

// ==================== P2-2 静默降级 ====================

function fakeLLM({ name, fail = false }) {
  return {
    model: name, backend: "http", vision: false, supportsNativeToolCalls: true,
    apiChat: async () => {
      if (fail) throw new Error(`${name} boom`);
      return { message: { role: "assistant", content: `${name} ok`, tool_calls: null } };
    },
    health: async () => true,
  };
}

test("P2-2: 发生回退时记录降级事实并广播 (返回值保持原文, 不污染调用方)", async () => {
  const a = new PPXAgent({ root: tmpRoot("p22"), configFile: null });
  a.allProviders = [fakeLLM({ name: "deepseek", fail: true }), fakeLLM({ name: "zhipu" })];
  const seen = [];
  a.bus.on("llm/fallback", (ev) => seen.push(ev));
  const r = await a._llmWithFallback([{ role: "user", content: "hi" }]);
  assert.equal(r, "zhipu ok", "回退返回值仍是模型原文 (透明回退语义不变)");
  assert.ok(a._lastFallback, "应记录降级事实");
  assert.equal(a._lastFallback.from, "deepseek");
  assert.equal(a._lastFallback.to, "zhipu");
  assert.equal(seen.length, 1, "应广播 llm/fallback 事件 (可观测)");
  a.shutdown();
});

test("P2-2: chat 回复末尾附可见降级提示, 但写入记忆的是模型原文", async () => {
  const a = new PPXAgent({ root: tmpRoot("p22b"), configFile: null });
  a.allProviders = [fakeLLM({ name: "deepseek", fail: true }), fakeLLM({ name: "zhipu" })];
  // 捕获写入记忆/会话历史的内容, 断言提示不会污染下一轮上下文
  const recorded = [];
  const origRecord = a.memory.recordTurn.bind(a.memory);
  a.memory.recordTurn = async (u, r) => { recorded.push(r); return origRecord(u, r); };
  // 桩掉模式执行器, 让它在调用期间制造一次真实降级
  const modes = a.ctx.consume("modes");
  const origRun = modes.run.bind(modes);
  modes.run = async () => {
    await a._llmWithFallback([{ role: "user", content: "hi" }]);
    return "这是备用模型给出的回答。";
  };
  const reply = await a.chat("你好, 帮我分析一下");
  modes.run = origRun;
  assert.ok(reply.includes("这是备用模型给出的回答。"), "原始回答保留");
  assert.ok(/已自动切换到 zhipu/.test(reply), `应有可见降级提示: ${reply}`);
  assert.ok(/⚠/.test(reply), "提示应可被用户一眼看到");
  assert.equal(recorded.length, 1, "记忆写入一次");
  assert.ok(!/⚠/.test(recorded[0]), `写入记忆的必须是模型原文, 不能带提示: ${recorded[0]}`);
  a.shutdown();
});

test("P2-2: 未降级时不附加任何提示 (避免噪音)", async () => {
  const a = new PPXAgent({ root: tmpRoot("p22c"), configFile: null });
  a.allProviders = [fakeLLM({ name: "zhipu" })];
  const modes = a.ctx.consume("modes");
  modes.run = async () => "正常回答。";
  const reply = await a.chat("随便聊聊");
  assert.equal(reply, "正常回答。", "无降级则回复原样");
  a.shutdown();
});

test("P2-2: 降级原因做人类化收敛, 不把原始 JSON 报错体喷给用户", () => {
  const a = new PPXAgent({ root: tmpRoot("p22d"), configFile: null });
  const raw401 = 'LLM HTTP 401: {"error":{"message":"Authentication Fails, Your api key: ****abcd is invalid","type":"authentication_error"}}';
  const t = a._fallbackNotice({ from: "deepseek-chat", to: "glm-5v-turbo", reason: raw401, chain: ["deepseek-chat"] });
  assert.ok(!t.includes("{"), `不应含 JSON: ${t}`);
  assert.ok(!/Authentication Fails/.test(t), `不应含原始英文报错: ${t}`);
  assert.ok(/鉴权失败/.test(t), `应归类为鉴权失败: ${t}`);
  assert.ok(/已自动切换到 glm-5v-turbo/.test(t), "应说明切换目标");
  // 常见故障归类
  assert.ok(/限流|额度/.test(a._shortReason("HTTP 429 Too Many Requests")));
  assert.ok(/超时/.test(a._shortReason("request timeout after 180000ms")));
  assert.ok(/连接失败/.test(a._shortReason("fetch failed: ECONNREFUSED 127.0.0.1:1234")));
  a.shutdown();
});

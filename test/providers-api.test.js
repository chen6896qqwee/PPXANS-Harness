// test/providers-api.test.js - 提供方 CRUD + HTTP API 端到端测试
// 覆盖: validate / sanitize / add / update / remove / reorder / 持久化 / 备份 / 鉴权 / 测试连接
import test from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import {
  listProviders, addProvider, updateProvider, removeProvider, reorderProviders,
  validateProvider, sanitizeProvider, readConfig,
} from "../src/config/providers.js";
import { startServer } from "../src/server.js";

function stubLLM(id = "stub") {
  return {
    providerId: id,
    backend: "stub",
    model: "stub",
    vision: false,
    supportsStream: false,
    supportsNativeToolCalls: false,
    chat: async () => ({ content: "[stub]" }),
    apiChat: async () => ({ message: { role: "assistant", content: "[stub]", tool_calls: null } }),
    streamChat: async () => "[stub]",
    health: async () => true,
  };
}

// 临时根 + 临时 config/ppx.json
function makeTmpRoot(initial = { providers: [] }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ppx-prov-"));
  fs.mkdirSync(path.join(dir, "config"), { recursive: true });
  fs.writeFileSync(path.join(dir, "config", "ppx.json"), JSON.stringify(initial, null, 2), "utf8");
  return dir;
}

// ---- 单元测试 ----

test("providers: validate 合法 http", () => {
  const err = validateProvider({ id: "openai", base_url: "https://api.openai.com/v1", model: "gpt-4o-mini" });
  assert.equal(err, null);
});

test("providers: dsml 类型校验 (v1.1.1 新增键)", () => {
  // 合法 boolean
  const ok = validateProvider({ id: "ds4", base_url: "https://x/v1", model: "deepseek-ds4", dsml: true });
  assert.equal(ok, null, "dsml:true 合法");
  const ok2 = validateProvider({ id: "ds4", base_url: "https://x/v1", model: "m", dsml: false });
  assert.equal(ok2, null, "dsml:false 合法");
  // 非法类型
  const bad = validateProvider({ id: "ds4", base_url: "https://x/v1", model: "m", dsml: "yes" });
  assert.ok(bad && /dsml/.test(bad), "dsml 非布尔应报错: " + bad);
});

test("providers: validate 合法 openclaw (缺 mjs 应报错)", () => {
  const err = validateProvider({ id: "openclaw", backend: "openclaw" });
  assert.ok(err && /mjs/.test(err), "openclaw 缺 mjs 应报错");
});

test("providers: validate 合法 deepseek (缺 dsh_root 应报错)", () => {
  const err = validateProvider({ id: "dsh", backend: "deepseek" });
  assert.ok(err && /dsh_root/.test(err), "deepseek 缺 dsh_root 应报错");
});

test("providers: validate 缺 id", () => {
  assert.ok(validateProvider({ base_url: "https://x.com" }));
  assert.ok(validateProvider({ id: "" }));
});

test("providers: validate id 命名规则", () => {
  // 数字开头应被 id 规则拒 (需带 base_url 才能定位是 id 报错而非 base_url 报错)
  assert.ok(/id/.test(validateProvider({ id: "1abc", base_url: "https://x" })));
  // 含空格
  assert.ok(/id/.test(validateProvider({ id: "ab cd", base_url: "https://x" })));
  // 超长
  assert.ok(/id/.test(validateProvider({ id: "a".repeat(31), base_url: "https://x" })));
  // 合法
  assert.equal(validateProvider({ id: "abc-123_OK", base_url: "https://x" }), null);
});

test("providers: validate http 后端缺 base_url", () => {
  const err = validateProvider({ id: "no-url", api_key_env: "X" });
  assert.ok(err && /base_url/.test(err));
});

test("providers: validate timeout_ms 边界", () => {
  assert.ok(validateProvider({ id: "x", base_url: "https://x", timeout_ms: 100 }));
  assert.equal(validateProvider({ id: "x", base_url: "https://x", timeout_ms: 5000 }), null);
});

test("providers: validate 拦截 REPLACE_WITH_ 占位符", () => {
  // model 占位符 (如 volcengine 模板残留)
  const m = validateProvider({ id: "volcengine", base_url: "https://ark.cn-beijing.volces.com/api/v3", model: "REPLACE_WITH_YOUR_ENDPOINT", api_key_env: "VOLCENGINE_API_KEY" });
  assert.ok(m && /占位符/.test(m), `model 占位符被拦: ${m}`);
  // base_url / api_key 占位符
  assert.ok(/占位符/.test(validateProvider({ id: "x", base_url: "https://REPLACE_WITH_HOST/v1" })));
  assert.ok(/占位符/.test(validateProvider({ id: "x", base_url: "https://x", api_key: "YOUR_API_KEY_HERE" })));
  // 真实值不误拦
  assert.equal(validateProvider({ id: "x", base_url: "https://x", model: "deepseek-chat" }), null);
});

test("providers: sanitize 不回传 api_key 明文", () => {
  const raw = { id: "k", api_key: "sk-secret", api_key_env: "OPENAI_API_KEY", base_url: "https://x" };
  const out = sanitizeProvider(raw);
  assert.equal(out.api_key, undefined, "不应回传 api_key 明文");
  assert.equal(out.api_key_set, true);
  assert.equal(out.api_key_env, "OPENAI_API_KEY");
});

test("providers: 增改删 + 持久化", () => {
  const root = makeTmpRoot();
  try {
    // 初始空
    assert.deepEqual(listProviders(root), []);
    // 新增
    const p1 = addProvider(root, { id: "deepseek", base_url: "https://api.deepseek.com/v1", api_key_env: "DEEPSEEK_API_KEY", model: "deepseek-chat" });
    assert.equal(p1.id, "deepseek");
    assert.equal(p1.api_key_set, false);
    // 落盘验证
    const onDisk = JSON.parse(fs.readFileSync(path.join(root, "config", "ppx.json"), "utf8"));
    assert.equal(onDisk.providers.length, 1);
    assert.equal(onDisk.providers[0].id, "deepseek");
    // 重新读 → 拿到的是 sanitize 视图
    const again = listProviders(root);
    assert.equal(again.length, 1);
    assert.equal(again[0].id, "deepseek");
    // 更新
    const upd = updateProvider(root, "deepseek", { model: "deepseek-coder", api_key: "sk-new" });
    assert.equal(upd.model, "deepseek-coder");
    assert.equal(upd.api_key_set, true);
    // 磁盘上 api_key 应保留 (sanitize 后存原始结构)
    const after = JSON.parse(fs.readFileSync(path.join(root, "config", "ppx.json"), "utf8"));
    assert.equal(after.providers[0].model, "deepseek-coder");
    assert.equal(after.providers[0].api_key, "sk-new");
    // 但 listProviders 不回传 api_key 明文
    assert.equal(listProviders(root)[0].api_key, undefined);
    // 删除
    removeProvider(root, "deepseek");
    assert.deepEqual(listProviders(root), []);
    // 磁盘空
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(root, "config", "ppx.json"), "utf8")).providers, []);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("providers: id 冲突报错", () => {
  const root = makeTmpRoot({ providers: [{ id: "a", base_url: "https://x" }] });
  try {
    assert.throws(() => addProvider(root, { id: "a", base_url: "https://y" }), /冲突/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("providers: 重排", () => {
  const root = makeTmpRoot({ providers: [{ id: "a" }, { id: "b" }, { id: "c" }] });
  try {
    const after = reorderProviders(root, ["c", "a", "b"]);
    assert.deepEqual(after.map((p) => p.id), ["c", "a", "b"]);
    // 重排后顺序持久化
    const onDisk = JSON.parse(fs.readFileSync(path.join(root, "config", "ppx.json"), "utf8"));
    assert.deepEqual(onDisk.providers.map((p) => p.id), ["c", "a", "b"]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("providers: 写盘产生 .bak 备份", () => {
  const root = makeTmpRoot({ providers: [{ id: "a", base_url: "https://x" }] });
  try {
    updateProvider(root, "a", { model: "new-model" });
    const files = fs.readdirSync(path.join(root, "config"));
    const baks = files.filter((f) => f.startsWith("ppx.json.bak-"));
    assert.ok(baks.length >= 1, "应至少有一个 .bak 备份");
    // 备份内容是写之前的旧版
    const bak = JSON.parse(fs.readFileSync(path.join(root, "config", baks[0]), "utf8"));
    assert.equal(bak.providers[0].model, undefined, "备份应为旧版");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("providers: updateProvider 清空 api_key (传空串)", () => {
  const root = makeTmpRoot({ providers: [{ id: "x", api_key: "old-key", base_url: "https://x" }] });
  try {
    updateProvider(root, "x", { api_key: "" });
    const { providers } = readConfig(root);
    assert.equal(providers[0].api_key, undefined, "空串应视为清空");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// ---- HTTP 集成测试 ----

async function bootWithTmpRoot(initial = { providers: [] }) {
  const root = makeTmpRoot(initial);
  // stub id 与初始 config 的第一个 provider.id 对齐 (兼容 /test 按 id 查找)
  const firstId = initial.providers?.[0]?.id || "stub";
  const svc = await startServer({ root, port: 0, host: "127.0.0.1", llm: stubLLM(firstId) });
  const port = svc.server.address().port;
  const headers = svc.http.authToken ? { "Content-Type": "application/json", "Authorization": `Bearer ${svc.http.authToken}` } : { "Content-Type": "application/json" };
  return { ...svc, port, headers, root };
}

test("HTTP: GET /api/providers 空列表 + default_id", async () => {
  const ctx = await bootWithTmpRoot();
  try {
    const r = await fetch(`http://127.0.0.1:${ctx.port}/api/providers`, { headers: ctx.headers });
    assert.equal(r.status, 200);
    const j = await r.json();
    assert.deepEqual(j.providers, []);
    assert.equal(j.default_id, null);
  } finally {
    ctx.agent.shutdown();
    await new Promise((res) => ctx.server.close(res));
    fs.rmSync(ctx.root, { recursive: true, force: true });
  }
});

test("HTTP: POST /api/providers 新增 + 热重载", async () => {
  const ctx = await bootWithTmpRoot();
  try {
    // 用 localhost (走 _isUsableProvider 的本地分支), 让 reloadProviders 能真实造一个 LLM 客户端
    const r = await fetch(`http://127.0.0.1:${ctx.port}/api/providers`, {
      method: "POST",
      headers: ctx.headers,
      body: JSON.stringify({ provider: { id: "lm-local", base_url: "http://127.0.0.1:1/v1", api_key: "lm-studio", model: "stub-model" } }),
    });
    assert.equal(r.status, 200);
    const j = await r.json();
    assert.ok(j.ok);
    assert.equal(j.provider.id, "lm-local");
    // 磁盘已写
    const onDisk = JSON.parse(fs.readFileSync(path.join(ctx.root, "config", "ppx.json"), "utf8"));
    assert.equal(onDisk.providers[0].id, "lm-local");
    // agent 已热重载 (本地 base_url 会被识别为可用, 至少 1 个客户端)
    assert.ok(ctx.agent.allProviders && ctx.agent.allProviders.length >= 1);
  } finally {
    ctx.agent.shutdown();
    await new Promise((res) => ctx.server.close(res));
    fs.rmSync(ctx.root, { recursive: true, force: true });
  }
});

test("HTTP: POST /api/providers 非法 id 应 400", async () => {
  const ctx = await bootWithTmpRoot();
  try {
    const r = await fetch(`http://127.0.0.1:${ctx.port}/api/providers`, {
      method: "POST",
      headers: ctx.headers,
      body: JSON.stringify({ provider: { id: "123-bad", base_url: "https://x" } }),
    });
    assert.equal(r.status, 400);
    const j = await r.json();
    assert.ok(j.error);
  } finally {
    ctx.agent.shutdown();
    await new Promise((res) => ctx.server.close(res));
    fs.rmSync(ctx.root, { recursive: true, force: true });
  }
});

test("HTTP: PUT /api/providers 更新模型", async () => {
  const ctx = await bootWithTmpRoot({ providers: [{ id: "x", base_url: "https://x", model: "old" }] });
  try {
    const r = await fetch(`http://127.0.0.1:${ctx.port}/api/providers`, {
      method: "PUT",
      headers: ctx.headers,
      body: JSON.stringify({ id: "x", patch: { model: "new-model" } }),
    });
    assert.equal(r.status, 200);
    const j = await r.json();
    assert.equal(j.provider.model, "new-model");
    const onDisk = JSON.parse(fs.readFileSync(path.join(ctx.root, "config", "ppx.json"), "utf8"));
    assert.equal(onDisk.providers[0].model, "new-model");
  } finally {
    ctx.agent.shutdown();
    await new Promise((res) => ctx.server.close(res));
    fs.rmSync(ctx.root, { recursive: true, force: true });
  }
});

test("HTTP: DELETE /api/providers", async () => {
  const ctx = await bootWithTmpRoot({ providers: [{ id: "x", base_url: "https://x" }, { id: "y", base_url: "https://y" }] });
  try {
    const r = await fetch(`http://127.0.0.1:${ctx.port}/api/providers`, {
      method: "DELETE",
      headers: ctx.headers,
      body: JSON.stringify({ id: "x" }),
    });
    assert.equal(r.status, 200);
    const list = await (await fetch(`http://127.0.0.1:${ctx.port}/api/providers`, { headers: ctx.headers })).json();
    assert.equal(list.providers.length, 1);
    assert.equal(list.providers[0].id, "y");
  } finally {
    ctx.agent.shutdown();
    await new Promise((res) => ctx.server.close(res));
    fs.rmSync(ctx.root, { recursive: true, force: true });
  }
});

test("HTTP: POST /api/providers/test 健康探测 (走 agent 客户端)", async () => {
  // 关键: /test 路由应优先复用 agent 已有的 LLM 客户端 (含测试注入的 stub),
  // 而不是从磁盘重新构造一个会被真打网络的客户端
  const ctx = await bootWithTmpRoot({ providers: [{ id: "lm", base_url: "http://127.0.0.1:1/v1", api_key: "lm-studio", model: "m" }] });
  try {
    const r = await fetch(`http://127.0.0.1:${ctx.port}/api/providers/test`, {
      method: "POST",
      headers: ctx.headers,
      body: JSON.stringify({ id: "lm" }),
    });
    assert.equal(r.status, 200);
    const j = await r.json();
    assert.equal(j.healthy, true, "stub LLM 的 health() 应返回 true");
    assert.ok(j.detail);
  } finally {
    ctx.agent.shutdown();
    await new Promise((res) => ctx.server.close(res));
    fs.rmSync(ctx.root, { recursive: true, force: true });
  }
});

test("HTTP: 未授权 401", async () => {
  const ctx = await bootWithTmpRoot();
  try {
    const r = await fetch(`http://127.0.0.1:${ctx.port}/api/providers`);
    assert.equal(r.status, 401);
  } finally {
    ctx.agent.shutdown();
    await new Promise((res) => ctx.server.close(res));
    fs.rmSync(ctx.root, { recursive: true, force: true });
  }
});

test("HTTP: POST /api/providers/reorder", async () => {
  const ctx = await bootWithTmpRoot({ providers: [{ id: "a" }, { id: "b" }, { id: "c" }] });
  try {
    const r = await fetch(`http://127.0.0.1:${ctx.port}/api/providers/reorder`, {
      method: "POST",
      headers: ctx.headers,
      body: JSON.stringify({ order: ["c", "a", "b"] }),
    });
    assert.equal(r.status, 200);
    const list = await (await fetch(`http://127.0.0.1:${ctx.port}/api/providers`, { headers: ctx.headers })).json();
    assert.deepEqual(list.providers.map((p) => p.id), ["c", "a", "b"]);
    assert.equal(list.default_id, "c");
  } finally {
    ctx.agent.shutdown();
    await new Promise((res) => ctx.server.close(res));
    fs.rmSync(ctx.root, { recursive: true, force: true });
  }
});
// test/settings-api.test.js - /api/settings 通用设置 API (读/写/校验/热重载)
import test from "node:test";
import assert from "node:assert";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import { startServer } from "../src/server.js";
import { getSettings, updateSettings } from "../src/config/settings.js";
import { PPXAgent } from "../src/agent/index.js";

function tmpRoot(n) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `ppx-set-${n}-`));
  fs.mkdirSync(path.join(root, "config"), { recursive: true });
  return root;
}

async function stop(s) {
  s.server?.closeAllConnections?.();
  await new Promise((r) => setTimeout(r, 50));
  if (s.server && s.server.listening) await new Promise((r) => s.server.close(r));
}

// ---- 纯函数层 ----
test("getSettings: 缺 config 返回默认结构 (不抛)", () => {
  const root = tmpRoot("default");
  const s = getSettings(root);
  assert.equal(s.user.name, "兄弟", "默认用户名");
  assert.equal(s.http.port, 8899, "默认端口");
  assert.equal(s.http.auth_token_set, false, "无 token 不暴露明文");
  assert.ok(Array.isArray(s.agent.values) && s.agent.values.length >= 3, "默认核心价值");
  fs.rmSync(root, { recursive: true, force: true });
});

test("updateSettings: 更新用户名/端口/安全, 校验生效", () => {
  const root = tmpRoot("update");
  fs.writeFileSync(path.join(root, "config", "ppx.json"), JSON.stringify({}));
  const s = updateSettings(root, {
    user: { name: "老板" },
    http: { port: 9999 },
    security: { allow_all: true, command_timeout_ms: 5000 },
  });
  assert.equal(s.user.name, "老板");
  assert.equal(s.http.port, 9999);
  assert.equal(s.security.allow_all, true);
  assert.equal(s.security.command_timeout_ms, 5000);
  // 落盘验证
  const onDisk = JSON.parse(fs.readFileSync(path.join(root, "config", "ppx.json"), "utf8"));
  assert.equal(onDisk.user.name, "老板");
  assert.equal(onDisk.channels.http.port, 9999);
  assert.equal(onDisk.security.allow_all, true);
  fs.rmSync(root, { recursive: true, force: true });
});

test("updateSettings: 非法端口被拒绝", () => {
  const root = tmpRoot("badport");
  fs.writeFileSync(path.join(root, "config", "ppx.json"), JSON.stringify({}));
  assert.throws(() => updateSettings(root, { http: { port: 99999 } }), /端口/);
  assert.throws(() => updateSettings(root, { http: { port: -1 } }), /端口/);
  fs.rmSync(root, { recursive: true, force: true });
});

test("updateSettings: 非法 values 被拒绝 (非数组/含非字符串)", () => {
  const root = tmpRoot("badval");
  fs.writeFileSync(path.join(root, "config", "ppx.json"), JSON.stringify({}));
  assert.throws(() => updateSettings(root, { agent: { values: "not-array" } }), /数组/);
  assert.throws(() => updateSettings(root, { agent: { values: [123] } }), /数组/);
  fs.rmSync(root, { recursive: true, force: true });
});

test("updateSettings: auth_token 更新后回传只暴露 set 标志", () => {
  const root = tmpRoot("token");
  fs.writeFileSync(path.join(root, "config", "ppx.json"), JSON.stringify({}));
  const s = updateSettings(root, { http: { auth_token: "secret-123" } });
  assert.equal(s.http.auth_token_set, true, "有 token");
  assert.ok(!JSON.stringify(s).includes("secret-123"), "不回传明文");
  fs.rmSync(root, { recursive: true, force: true });
});

// ---- HTTP 层 ----
async function serve(root, llm = null) {
  const s = await startServer({ root, port: 0, llm });
  const port = s.http.server.address().port;
  return { ...s, port, token: s.http.authToken || "" };
}

async function request(port, p, { method = "GET", body = null, token = "" } = {}) {
  const r = await fetch(`http://127.0.0.1:${port}${p}`, {
    method,
    headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  return r.json();
}

test("/api/settings GET 返回设置", async () => {
  const root = tmpRoot("httpget");
  const s = await serve(root);
  const j = await request(s.port, "/api/settings", { token: s.token });
  assert.ok(j.settings, "返回 settings");
  assert.ok(j.settings.user.name, "含用户名");
  s.agent.shutdown();
  await stop(s);
  fs.rmSync(root, { recursive: true, force: true });
});

test("/api/settings PUT 更新 + 热重载生效", async () => {
  const root = tmpRoot("httpput");
  const s = await serve(root);
  const j = await request(s.port, "/api/settings", {
    method: "PUT", token: s.token,
    body: { patch: { user: { name: "新老板" }, security: { allow_all: true } } },
  });
  assert.equal(j.ok, true, "更新成功");
  assert.equal(j.settings.user.name, "新老板");
  assert.equal(s.agent.userName, "新老板", "agent 内存热重载");
  // 重新 GET 确认持久化
  const g = await request(s.port, "/api/settings", { token: s.token });
  assert.equal(g.settings.user.name, "新老板");
  s.agent.shutdown();
  await stop(s);
  fs.rmSync(root, { recursive: true, force: true });
});

test("/api/settings PUT 非法端口返回 400", async () => {
  const root = tmpRoot("httpbad");
  const s = await serve(root);
  const r = await fetch(`http://127.0.0.1:${s.port}/api/settings`, {
    method: "PUT",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${s.token}` },
    body: JSON.stringify({ patch: { http: { port: 0 } } }),
  });
  assert.equal(r.status, 400, "非法端口 400");
  s.agent.shutdown();
  await stop(s);
  fs.rmSync(root, { recursive: true, force: true });
});

test("/api/settings 无鉴权 token 返回 401", async () => {
  const root = tmpRoot("httpauth");
  // 强制启用鉴权
  fs.writeFileSync(path.join(root, "config", "ppx.json"), JSON.stringify({ channels: { http: { auth_token: "abc" } } }));
  const s = await serve(root);
  const r = await fetch(`http://127.0.0.1:${s.port}/api/settings`);
  assert.equal(r.status, 401, "无 token 401");
  s.agent.shutdown();
  await stop(s);
  fs.rmSync(root, { recursive: true, force: true });
});

test("updateSettings: mcp.servers 白名单校验 + headers 脱敏", () => {
  const root = tmpRoot("mcp");
  fs.writeFileSync(path.join(root, "config", "ppx.json"), JSON.stringify({}));
  const s = updateSettings(root, {
    mcp: {
      auto_connect: true,
      servers: [
        { command: "npx", args: ["-y", "some-mcp"], env: { TOKEN: "secret" }, prefix: "mcp_" },
        { url: "https://mcp.example.com", headers: { Authorization: "Bearer xxx" }, timeout: 10000 },
      ],
    },
  });
  assert.equal(s.mcp.auto_connect, true);
  assert.equal(s.mcp.servers.length, 2, "两个服务器都保存");
  assert.equal(s.mcp.servers[0].command, "npx", "command 保留");
  assert.equal(s.mcp.servers[0].env_set, true, "env 只回 set 标志");
  assert.ok(!JSON.stringify(s.mcp).includes("secret"), "env 明文不回传");
  assert.equal(s.mcp.servers[1].url, "https://mcp.example.com", "http 服务器 url 保留");
  assert.equal(s.mcp.servers[1].headers_set, true, "headers 只回 set 标志");
  // 落盘验证 (env/headers 明文在磁盘, 白名单字段)
  const onDisk = JSON.parse(fs.readFileSync(path.join(root, "config", "ppx.json"), "utf8"));
  assert.equal(onDisk.mcp.servers[0].env.TOKEN, "secret", "磁盘保留 env");
  assert.ok(!onDisk.mcp.servers[0].evil, "无白名单外字段");
  fs.rmSync(root, { recursive: true, force: true });
});

test("updateSettings: mcp 服务器缺 command/url 被拒绝", () => {
  const root = tmpRoot("mcpbad");
  fs.writeFileSync(path.join(root, "config", "ppx.json"), JSON.stringify({}));
  assert.throws(() => updateSettings(root, { mcp: { servers: [{ name: "no-cmd" }] } }), /command.*url|url.*command/);
  fs.rmSync(root, { recursive: true, force: true });
});

test("updateSettings: tools.disabled 校验 + 可读写", () => {
  const root = tmpRoot("tools");
  fs.writeFileSync(path.join(root, "config", "ppx.json"), JSON.stringify({}));
  const s = updateSettings(root, { tools: { disabled: ["run_command", "code_act"] } });
  assert.deepEqual(s.tools.disabled, ["run_command", "code_act"]);
  // 非法值被拒
  assert.throws(() => updateSettings(root, { tools: { disabled: "run_command" } }), /数组/);
  assert.throws(() => updateSettings(root, { tools: { disabled: [123] } }), /数组/);
  fs.rmSync(root, { recursive: true, force: true });
});

test("agent: tools.disabled 启动时生效 + reloadSettings 热应用", async () => {
  const root = tmpRoot("toolapply");
  fs.writeFileSync(path.join(root, "config", "ppx.json"), JSON.stringify({
    providers: [],
    tools: { disabled: ["run_command"] },
  }));
  const a = new PPXAgent({ root });
  assert.equal(a.tools.has("run_command"), true, "工具已注册");
  const st = a.tools.listDetailed().find((t) => t.name === "run_command");
  assert.equal(st.enabled, false, "run_command 启动时已被禁用");
  assert.ok(!a.tools.toOpenAI().some((t) => t.function.name === "run_command"), "不在 LLM schema 中");
  // 临时启用后 reloadSettings 应重新禁用 (从 config 读)
  a.tools.enable("run_command");
  assert.equal(a.tools.listDetailed().find((t) => t.name === "run_command").enabled, true, "临时启用");
  a.reloadSettings();
  assert.equal(a.tools.listDetailed().find((t) => t.name === "run_command").enabled, false, "reloadSettings 后重新禁用");
  a.shutdown();
  fs.rmSync(root, { recursive: true, force: true });
});

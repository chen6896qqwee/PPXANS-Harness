// test/config-yaml-env-2026-11-17.test.js — config 加载链 (YAML 子集解析 + 环境变量覆盖 + 校验)
// parseYaml 是零依赖手写子集: 嵌套对象/数组项/标量/注释。这里用临时 root 钉住行为,
// 环境变量 PPX_AUTH_TOKEN / PPX_PORT 覆盖与还原也一并测试。
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadConfig, validateConfig } from "../src/config/index.js";

function tmpRoot(tag = "cfg") {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), `ppx-${tag}-`));
  fs.mkdirSync(path.join(d, "config"), { recursive: true });
  return d;
}

test("config: YAML 子集解析 (嵌套/数组项/标量/注释)", () => {
  const root = tmpRoot("yaml");
  try {
    fs.writeFileSync(path.join(root, "config", "ppx.yaml"), [
      "# 顶层注释",
      "agent:",
      "  name: 测试虾",
      "  localIntent: false",
      "  proactive:",
      "    enabled: true",
      "    interval_minutes: 30",
      "channels:",
      "  http:",
      "    port: 9001",
      "providers:",
      "  - id: deepseek",
      "    model: deepseek-chat",
      "  - id: local",
      "    model: qwen2.5",
      "",
    ].join("\n"), "utf8");
    const cfg = loadConfig(root);
    assert.equal(cfg.agent.name, "测试虾");
    assert.equal(cfg.agent.localIntent, false);
    assert.equal(cfg.agent.proactive.enabled, true);
    assert.equal(cfg.agent.proactive.interval_minutes, 30);
    assert.equal(cfg.channels.http.port, 9001);
    assert.ok(Array.isArray(cfg.providers));
    assert.equal(cfg.providers.length, 2);
    assert.equal(cfg.providers[0].id, "deepseek");
    assert.equal(cfg.providers[1].model, "qwen2.5");
    assert.equal(cfg.ans_lane.enabled, false, "未配置时 ANS 车道保持默认关闭");
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("config: PPX_AUTH_TOKEN / PPX_PORT 环境变量覆盖", () => {
  const root = tmpRoot("env");
  try {
    fs.writeFileSync(path.join(root, "config", "ppx.json"), JSON.stringify({
      providers: [],
      channels: { http: { port: 8899, auth_token: "cfg-token" } },
    }));
    const prevTok = process.env.PPX_AUTH_TOKEN;
    const prevPort = process.env.PPX_PORT;
    process.env.PPX_AUTH_TOKEN = "env-token";
    process.env.PPX_PORT = "9002";
    try {
      const cfg = loadConfig(root);
      assert.equal(cfg.channels.http.auth_token, "env-token");
      assert.equal(cfg.channels.http.port, 9002);
    } finally {
      if (prevTok === undefined) delete process.env.PPX_AUTH_TOKEN; else process.env.PPX_AUTH_TOKEN = prevTok;
      if (prevPort === undefined) delete process.env.PPX_PORT; else process.env.PPX_PORT = prevPort;
    }
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("config: validateConfig 收集占位符/缺 id/缺 command/类型错误", () => {
  const cfg = loadConfig(tmpRoot("warn"));
  cfg.providers = [
    { id: "p1", model: "REPLACE_WITH_YOUR_ENDPOINT" },
    { model: "m2" },
    null,
  ];
  cfg.mcp = { servers: [{ name: "no-transport" }] };
  cfg.tools = "not-an-object";
  const warnings = validateConfig(cfg);
  const joined = warnings.join("\n");
  assert.match(joined, /占位符/);
  assert.match(joined, /缺少 id/);
  assert.match(joined, /不是对象/);
  assert.match(joined, /缺 command\(stdio\) 或 url\(http\)/);
  assert.match(joined, /类型应为 object/);
});

test("config: JSON 配置覆盖默认值 (deepMerge 不丢未提及字段)", () => {
  const root = tmpRoot("json");
  try {
    fs.writeFileSync(path.join(root, "config", "ppx.json"), JSON.stringify({
      providers: [{ id: "p", model: "m", base_url: "https://api.example.com" }],
      channels: { http: { port: 9100 } },
    }));
    const cfg = loadConfig(root);
    assert.equal(cfg.channels.http.port, 9100);
    assert.equal(cfg.channels.http.enabled, true, "未提及字段保留默认");
    assert.equal(cfg.channels.http.cors_origin, "same-origin");
    assert.equal(cfg.providers[0].id, "p");
    assert.ok(Array.isArray(cfg.ans_lane.targets));
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

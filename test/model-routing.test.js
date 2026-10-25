// test/model-routing.test.js - 可选分层路由守卫 (2026-10-02)
// 设计原则: model_routing.aux 是可选项 — 用户不填, 辅助调用跟随主模型, 零配置零门槛
import test from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PPXAgent } from "../src/agent/index.js";

function makeConfig(aux, { broken = false } = {}) {
  const providers = [
    { id: "main-prov", base_url: "https://api.main.test/v1", api_key: "sk-main-test-123", model: "main-model" },
    { id: "cheap-prov", base_url: "https://api.cheap.test/v1", api_key: "sk-cheap-test-123", model: "cheap-model" },
  ];
  if (broken) providers[1].api_key = "YOUR_API_KEY"; // 占位符 → 不可用
  return {
    providers,
    ...(aux ? { model_routing: { aux } } : {}),
  };
}

function makeAgent(cfg) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ppx-route-"));
  const cfgPath = path.join(root, "ppx.json");
  fs.writeFileSync(cfgPath, JSON.stringify(cfg));
  return new PPXAgent({ root, configFile: cfgPath, dataDir: path.join(root, "data"), globalDataDir: path.join(root, "global") });
}

test("配了 aux: 辅助调用走指定厂商", () => {
  const agent = makeAgent(makeConfig("cheap-prov"));
  assert.ok(agent.auxLLM, "应解析出 auxLLM");
  assert.equal(agent.auxLLM.providerId, "cheap-prov");
  assert.equal(agent.auxLLM.model, "cheap-model");
  // 主模型不受影响
  assert.equal(agent.llm.providerId, "main-prov");
  // 依赖注入闭包: 辅助服务确实拿到 aux
  assert.equal(agent.memorySvc._llm?.() ?? null, agent.auxLLM, "memorySvc 应走 aux");
  agent.shutdown();
});

test("不配 aux: 辅助调用回落主模型 (零配置零门槛)", () => {
  const agent = makeAgent(makeConfig(null));
  assert.equal(agent.auxLLM, null, "未配置时 auxLLM 为 null");
  assert.equal(agent.memorySvc._llm?.(), agent.llm, "辅助服务应回落主模型");
  agent.shutdown();
});

test("aux id 配错: 回落主模型不炸", () => {
  const agent = makeAgent(makeConfig("no-such-provider"));
  assert.equal(agent.auxLLM, null);
  assert.equal(agent.memorySvc._llm?.(), agent.llm);
  agent.shutdown();
});

test("aux 厂商 key 是占位符 (不可用): 回落主模型", () => {
  const agent = makeAgent(makeConfig("cheap-prov", { broken: true }));
  assert.equal(agent.auxLLM, null, "不可用厂商不应成为 auxLLM");
  agent.shutdown();
});

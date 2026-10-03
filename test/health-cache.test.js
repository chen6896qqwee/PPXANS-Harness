// test/health-cache.test.js - provider 健康探测 TTL 缓存回归守卫 (2026-10-03m)
// 锁三件事:
//   1. TTL 内复用探测结果 (高频对话不再每轮全量探活, 省一段串行探活延迟)
//   2. TTL 过期后重新探测 (provider 状态变化能被看到)
//   3. 不健康 provider 跳过语义不变 (缓存不得改变回退正确性)
import { test } from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PPXAgent } from "../src/agent/index.js";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "ppx-hcache-"));

function makeAgent(root, healthCacheMs = 50) {
  fs.mkdirSync(path.join(root, "config"), { recursive: true });
  fs.writeFileSync(path.join(root, "config", "ppx.json"), JSON.stringify({
    providers: [],
    agent: { localIntent: false, proactive: { enabled: false }, health_cache_ms: healthCacheMs },
    channels: { http: { mcp: { enabled: false } } },
  }));
  return new PPXAgent({ root, dataDir: path.join(root, "data") });
}

function fakeLLM2(name, { fail = false, failHealth = false } = {}) {
  const c = {
    name, model: name, backend: "http", vision: false,
    supportsNativeToolCalls: true,
    healthCalls: 0,
    apiChat: async () => {
      if (fail) throw new Error(name + " boom");
      return { message: { role: "assistant", content: name + " ok" } };
    },
  };
  c.health = async function () { c.healthCalls += 1; return !failHealth; };
  return c;
}

const MSG = [{ role: "user", content: "hi" }];

test("health 缓存: TTL 内复用探测结果, 高频对话不重复探活", async () => {
  const root = tmp();
  const a = makeAgent(root);
  const c1 = fakeLLM2("p1"), c2 = fakeLLM2("p2");
  a.allProviders = [c1, c2];
  try {
    await a._llmWithFallback(MSG);
    await a._llmWithFallback(MSG);
    await a._llmWithFallback(MSG);
    assert.equal(c1.healthCalls, 1, `TTL 内只探活一次, 实际 ${c1.healthCalls} 次`);
    assert.equal(c2.healthCalls, 1);
    assert.equal(await a._llmWithFallback(MSG), "p1 ok");
  } finally {
    a.shutdown();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("health 缓存: TTL 过期后重新探测", async () => {
  const root = tmp();
  const a = makeAgent(root, 40); // 40ms TTL
  const c1 = fakeLLM2("p1");
  a.allProviders = [c1, fakeLLM2("p2")];
  try {
    await a._llmWithFallback(MSG);
    await new Promise((r) => setTimeout(r, 60));
    await a._llmWithFallback(MSG);
    assert.ok(c1.healthCalls >= 2, `TTL 过期应重新探活, 实际 ${c1.healthCalls} 次`);
  } finally {
    a.shutdown();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("health 缓存: 不健康 provider 跳过语义不变, 回退正确性不受缓存影响", async () => {
  const root = tmp();
  const a = makeAgent(root);
  const bad = fakeLLM2("bad", { failHealth: true });
  const good = fakeLLM2("good");
  a.allProviders = [bad, good];
  try {
    assert.equal(await a._llmWithFallback(MSG), "good ok", "不健康的被跳过");
    assert.equal(bad.healthCalls, 1);
    assert.equal(bad.apiChatCalls || 0, 0);
    // 第二轮走缓存: bad 依旧不被调用
    assert.equal(await a._llmWithFallback(MSG), "good ok");
    assert.equal(bad.healthCalls, 1, "缓存期内不重复探活");
  } finally {
    a.shutdown();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("health 缓存: health_cache_ms=0 关闭缓存 (行为退回逐轮探活)", async () => {
  const root = tmp();
  const a = makeAgent(root, 0);
  const c1 = fakeLLM2("p1");
  a.allProviders = [c1, fakeLLM2("p2")];
  try {
    await a._llmWithFallback(MSG);
    await a._llmWithFallback(MSG);
    assert.equal(c1.healthCalls, 2, "关闭缓存时每轮都探活");
  } finally {
    a.shutdown();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

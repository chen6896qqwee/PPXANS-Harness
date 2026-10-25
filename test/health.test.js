import test from "node:test";
import assert from "node:assert";
import { LLMClient } from "../src/llm/client.js";

// 网络 gate: 无 PPX_NET_TEST=1 时跳过真实探测 (与项目其他网络测试一致, 防无外网环境等超时)
const NET = process.env.PPX_NET_TEST === "1";

test("LLMClient.health: http 后端无 key 返回 false", async () => {
  const c = new LLMClient({ id: "http", base_url: "https://api.openai.com/v1", api_key_env: "OPENAI_API_KEY" });
  const h = await c.health();
  assert.equal(h, false, "无 API key 不可用");
});

test("LLMClient.health: http 后端有 key 时探测 /models", { skip: !NET, timeout: 20000 }, async () => {
  const c = new LLMClient({ id: "http", base_url: "https://api.openai.com/v1", api_key: "sk-test" });
  const h = await c.health();
  assert.equal(typeof h, "boolean");
});

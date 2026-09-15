import test from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { LLMClient, nodeVersionOk } from "../src/llm/client.js";

// 网络 gate: 无 PPX_NET_TEST=1 时跳过真实探测 (与项目其他网络测试一致, 防无外网环境等超时)
const NET = process.env.PPX_NET_TEST === "1";

test("nodeVersionOk: 支持/不支持版本矩阵", () => {
  assert.equal(nodeVersionOk("22.22.2"), false);
  assert.equal(nodeVersionOk("22.22.3"), true);
  assert.equal(nodeVersionOk("23.0.0"), false);
  assert.equal(nodeVersionOk("24.14.0"), false);
  assert.equal(nodeVersionOk("24.15.0"), true);
  assert.equal(nodeVersionOk("25.8.9"), false);
  assert.equal(nodeVersionOk("25.9.0"), true);
  assert.equal(nodeVersionOk("26.4.0"), true);
});

test("LLMClient.health: openclaw 后端按 Node 版本 + mjs 存在判断", async () => {
  // mjs 缺失 → 不可用 (即使 Node 版本满足)
  const c1 = new LLMClient({ id: "openclaw", backend: "openclaw", mjs: "" });
  assert.equal(await c1.health(), false);
  // mjs 存在 → 与纯函数 nodeVersionOk 一致
  const tmp = path.join(os.tmpdir(), `ppx_test_${Date.now()}.mjs`);
  fs.writeFileSync(tmp, "");
  const c2 = new LLMClient({ id: "openclaw", backend: "openclaw", mjs: tmp });
  assert.equal(await c2.health(), nodeVersionOk(process.versions.node));
  fs.rmSync(tmp, { force: true });
});

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

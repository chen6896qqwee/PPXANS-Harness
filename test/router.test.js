import test from "node:test";
import assert from "node:assert";
import { isUsableProvider, resolveLLM, resolveAllLLMs, orderByHealth, resolvePreference } from "../src/llm/router.js";

const base = { id: "openai", base_url: "https://api.x.com/v1", api_key: "sk-real-123" };
const local = { id: "lmstudio", base_url: "http://127.0.0.1:1234/v1", api_key: "lm-studio", model: "local-q8" };
const baseCfg = { id: "dash", base_url: "https://dashscope.aliyuncs.com/compatible-mode/v1", api_key: "sk-real", model: "qwen-turbo" };
const placeholder = { id: "volc", base_url: "https://ark.cn-beijing.volces.com/api/v3", api_key: "sk-real", model: "REPLACE_WITH_YOUR_ENDPOINT" };
const envkey = { id: "deepseek", base_url: "https://api.deepseek.com/v1", api_key_env: "DEEPSEEK_API_KEY", model: "deepseek-chat" };

test("router: 占位死配置判不可用", () => {
  assert.equal(isUsableProvider(placeholder), false, "REPLACE_WITH 占位被过滤");
  assert.equal(isUsableProvider(base), true, "真 key 可用");
  assert.equal(isUsableProvider(local), true, "本地零配置可用");
});

test("router: 默认 local 优先(本地测试用本地模型)", () => {
  const cfg = { agent: { model_preference: "local" }, providers: [base, local] };
  assert.equal(resolvePreference(cfg), "local");
  const llm = resolveLLM(cfg);
  assert.ok(llm, "能选出 LLM");
  assert.equal(llm.providerId, "lmstudio", "默认本地优先, 即使云端真key在后面配置");
});

test("router: model_preference=cloud 时云端优先", () => {
  const cfg = { agent: { model_preference: "cloud" }, providers: [local, base] };
  assert.equal(resolvePreference(cfg), "cloud");
  const llm = resolveLLM(cfg);
  assert.ok(llm, "能选出 LLM");
  assert.equal(llm.providerId, "openai", "显式 cloud 时云端优先");
});

test("router: 只有本地时回落本地(零配置默认可跑)", () => {
  const cfg = { providers: [local] };
  const llm = resolveLLM(cfg);
  assert.ok(llm, "本地兜底选出");
  assert.equal(llm.providerId, "lmstudio");
  assert.equal(llm.model, "local-q8");
});

test("router: 占位死配置从候选剔除, 不会误选", () => {
  const cfg = { providers: [placeholder, local] };
  const all = resolveAllLLMs(cfg);
  assert.ok(all.every((c) => c.providerId !== "volc"), "占位 provider 不进候选");
  assert.equal(all.length, 1);
  assert.equal(all[0].providerId, "lmstudio");
});

test("router: PPX_PROVIDER 强制选择", () => {
  const cfg = { providers: [base, local] };
  const old = process.env.PPX_PROVIDER;
  process.env.PPX_PROVIDER = "lmstudio";
  const llm = resolveLLM(cfg);
  assert.equal(llm.providerId, "lmstudio", "强制指定优先");
  process.env.PPX_PROVIDER = old;
});

test("router: orderByHealth 把健康排前, 不健康保底排后", async () => {
  const healthy = { ...base, health: async () => true };
  const sick = { ...local, health: async () => false };
  const out = await orderByHealth([sick, healthy]);
  assert.equal(out[0], healthy, "健康的排前");
  assert.equal(out[1], sick, "不健康的排后(不丢弃)");
});

// 2026-10-01 模型厂商预设回归守卫
// 覆盖: 预设完备性 (字段/无重复 id) / buildProvider 生成合法 provider / applyProviderToConfig 幂等合并且首位插入
import test from "node:test";
import assert from "node:assert/strict";
import { listPresets, getPreset, buildProvider, applyProviderToConfig } from "../src/llm/presets.js";

test("预设库完备性: 字段齐全, id 唯一, local 免 Key", () => {
  const all = listPresets();
  assert.ok(all.length >= 12, "至少覆盖 12 家厂商");
  const ids = new Set(all.map((p) => p.id));
  assert.equal(ids.size, all.length, "id 不得重复");
  for (const p of all) {
    assert.ok(p.id && p.label && p.base_url.startsWith("http"), `${p.id} 基础字段`);
    if (p.cloud) {
      assert.ok(p.api_key_env, `${p.id} 云端厂商必须声明 api_key_env`);
      assert.ok(p.key_url, `${p.id} 云端厂商必须给 Key 获取地址`);
    }
    assert.ok(Number(p.context_window) > 0);
  }
  // 关键厂商在场
  for (const id of ["deepseek", "openai", "anthropic", "gemini", "zhipu", "dashscope", "openrouter", "lmstudio", "ollama"]) {
    assert.ok(getPreset(id), `缺少预设: ${id}`);
  }
});

test("buildProvider: 生成与 config.providers 一致的合法对象", () => {
  const p = buildProvider("deepseek", { apiKey: "sk-test", model: "deepseek-chat" });
  assert.equal(p.id, "deepseek");
  assert.equal(p.backend, "http");
  assert.equal(p.base_url, "https://api.deepseek.com/v1");
  assert.equal(p.api_key, "sk-test");
  assert.equal(p.api_key_env, "DEEPSEEK_API_KEY");
  assert.equal(p.model, "deepseek-chat");
  // 未选模型时回落到预设默认; 本地厂商可无 Key
  assert.equal(buildProvider("deepseek", {}).model, "deepseek-chat");
  const local = buildProvider("lmstudio", {});
  assert.ok(!local.api_key_env);
  assert.equal(buildProvider("no-such", {}), null);
});

test("applyProviderToConfig: 幂等覆盖 + 新厂商插到首位 (首位=默认)", () => {
  const raw = { providers: [{ id: "lmstudio", base_url: "http://127.0.0.1:1234/v1" }] };
  const p1 = buildProvider("deepseek", { apiKey: "sk-a" });
  const out1 = applyProviderToConfig(raw, p1);
  assert.equal(out1.providers[0].id, "deepseek");
  assert.equal(out1.providers[1].id, "lmstudio");
  // 同 id 再合并不产生重复
  const out2 = applyProviderToConfig(out1, buildProvider("deepseek", { apiKey: "sk-b" }));
  assert.equal(out2.providers.filter((p) => p.id === "deepseek").length, 1);
  assert.equal(out2.providers[0].api_key, "sk-b");
});

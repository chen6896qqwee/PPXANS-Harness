// test/oobox.test.js - 开箱即用验证 (2026-10-03): 本地向量记忆 + TTS
import test from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { localEmbed, tokenize } from "../src/llm/local-embedder.js";
import { embedderFromConfig } from "../src/llm/embedder.js";
import { FactStore } from "../src/memory/fact-store.js";
import { buildTTSCommand, escapePS } from "../src/tools/voice.js";

test("本地向量: 同文本余弦=1, 相似文本 > 无关文本, 维度恒定", () => {
  const a = localEmbed("用户喜欢喝咖啡, 每天早上一杯");
  const b = localEmbed("用户喜欢喝咖啡, 早晨来一杯");
  const c = localEmbed("服务器部署在杭州机房");
  const cos = (x, y) => x.reduce((s, v, i) => s + v * y[i], 0);
  const dim = a.length;
  assert.equal(dim, 256, "维度恒定 256");
  assert.ok(cos(a, a) > 0.999, "自相似=1");
  assert.ok(cos(a, b) > cos(a, c), "相似文本余弦应高于无关文本");
  // 确定性
  assert.deepEqual(localEmbed("同一句话"), localEmbed("同一句话"));
});

test("分词: CJK 单字+双字与拉丁词元混合", () => {
  const t = tokenize("使用 MCP 协议");
  assert.ok(t.includes("使") && t.includes("使用"), "应含单字与双字");
  assert.ok(t.includes("mcp"), "拉丁词元应小写");
});

test("开箱即用: 零配置 embedderFromConfig 回落本地, FactStore 混合检索可用", async () => {
  // 无 embedding 配置 → 本地向量 (而非 null)
  const emb = embedderFromConfig({});
  assert.equal(typeof emb, "function", "零配置应返回本地 embedder");
  const v = await emb("测试");
  assert.equal(v.length, 256);

  // FactStore 开箱混合检索: 写入事实后, 本地向量 dense 检索能召回
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ppx-oob-"));
  const store = new FactStore(dir, {});
  store.setEmbedder(emb);
  store.add("用户偏好使用深色主题写代码");
  store.add("服务器部署在杭州, 每周三例行维护");
  store.add("项目的主语言是 JavaScript");
  const hits = store.query("深色 主题");
  assert.ok(hits.length >= 1, "应召回");
  assert.ok(hits[0].content.includes("深色主题"), `首位应是深色主题事实, 实际: ${hits[0].content}`);
});

test("TTS 命令构建: Windows SAPI 转义 / macOS say / Linux espeak / 语速夹取", () => {
  // PowerShell 单引号转义防注入
  assert.equal(escapePS("it's ok"), "it''s ok");
  const win = buildTTSCommand("hello's world", { rate: 99, voice: "Huihui" }, "win32");
  assert.equal(win.cmd, "powershell");
  assert.ok(win.args.join(" ").includes("Rate = 10"), "语速应夹取到 ±10");
  assert.ok(win.args.join(" ").includes("hello''s"), "文本应 PS 转义");
  assert.ok(!win.args.join(" ").includes("it's world'"), "不应有未转义引号");
  const mac = buildTTSCommand("hi", { voice: "Ting-Ting" }, "darwin");
  assert.equal(mac.cmd, "say");
  assert.deepEqual(mac.args, ["-v", "Ting-Ting", "hi"]);
  const linux = buildTTSCommand("hi", { rate: -5 }, "linux");
  assert.equal(linux.cmd, "espeak");
  assert.equal(linux.args[1], "80", "语速 wpm 应夹取到 [80,300] (175-100→下限80)");
});

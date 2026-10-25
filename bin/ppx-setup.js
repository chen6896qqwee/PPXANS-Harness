#!/usr/bin/env node
// bin/ppx-setup.js - 模型 API 配置向导 (2026-10-01, 主流开箱体验对齐)
// 目标: 用户只需 选厂商 → 输入 API Key → 自动探活 → 写入 config/ppx.json, 全程无需懂 base_url。
//
// 用法:
//   npm run setup                                  # 交互式向导
//   node bin/ppx-setup.js --list                   # 列出全部内置厂商预设
//   node bin/ppx-setup.js --provider deepseek --key sk-xxx [--model deepseek-chat]   # 非交互 (CI 友好)
//
// MCP 统一接口说明: 配置完成后, Claude Desktop / Cursor / 任何 MCP 客户端可直接连
//   http://127.0.0.1:8899/mcp 使用全部能力 (见 docs/MODEL-SETUP.md)。
import readline from "node:readline";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { listPresets, getPreset, buildProvider, applyProviderToConfig } from "../src/llm/presets.js";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const CONFIG_FILE = path.join(ROOT, "config", "ppx.json");
const args = process.argv.slice(2);

function readConfig() {
  try { return JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8")); } catch { return {}; }
}
function writeConfig(raw) {
  fs.mkdirSync(path.dirname(CONFIG_FILE), { recursive: true });
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(raw, null, 2) + "\n", "utf8");
}
async function probe(provider) {
  try {
    const { LLMClient } = await import("../src/llm/client.js");
    const c = new LLMClient(provider);
    const ok = await c.health();
    return { ok, detail: ok ? "连通" : "服务响应异常" };
  } catch (e) {
    return { ok: false, detail: e.message };
  }
}
async function finish(provider, preset) {
  writeConfig(applyProviderToConfig(readConfig(), provider));
  console.log(`\n✓ 已写入 ${path.relative(ROOT, CONFIG_FILE)} (provider: ${provider.id}, model: ${provider.model || "(默认)"})`);
  if (preset && preset.api_key_env && !provider.api_key) {
    console.log(`  提示: 未填 Key, 运行时会从环境变量 ${preset.api_key_env} 读取`);
  }
  console.log(`
下一步:
  1. 启动:      npm start            (内核 + Web UI, http://127.0.0.1:8899)
  2. MCP 接入:  Claude Desktop / Cursor 等 MCP 客户端连 http://127.0.0.1:8899/mcp
  3. 验证:      node scripts/eval.js --llm   (端到端真实链路)
详见 docs/MODEL-SETUP.md`);
}

// ---- 非交互模式 ----
if (args.includes("--list")) {
  for (const p of listPresets()) {
    console.log(`${p.cloud ? "☁ " : "电脑 "}${p.id.padEnd(12)} ${p.label.padEnd(26)} ${p.models.slice(0, 2).join(", ") || p.model_hint || ""}`);
  }
  process.exit(0);
}
// --aux <providerId>: 可选分层路由 — 记忆提取/摘要/压缩等辅助调用走便宜模型 (不设置则全走主模型)
const ai = args.indexOf("--aux");
if (ai >= 0) {
  const auxId = args[ai + 1];
  if (!auxId) { console.error("✗ 用法: --aux <providerId> (用 --list 查看, 或 --aux off 取消)"); process.exit(1); }
  const cfg = readConfig();
  if (auxId === "off") delete cfg.model_routing;
  else {
    cfg.model_routing = cfg.model_routing || {};
    cfg.model_routing.aux = auxId;
  }
  writeConfig(cfg);
  console.log(auxId === "off"
    ? "✓ 已取消分层路由 (辅助调用跟随主模型)"
    : `✓ 辅助任务 (记忆提取/摘要/压缩) 将走 ${auxId}, 主对话不变。未匹配到可用厂商时自动回落主模型`);
  process.exit(0);
}
const pi = args.indexOf("--provider");
if (pi >= 0) {
  const preset = getPreset(args[pi + 1]);
  if (!preset) { console.error("✗ 未知 provider id, 用 --list 查看"); process.exit(1); }
  const key = args.includes("--key") ? args[args.indexOf("--key") + 1] : "";
  const model = args.includes("--model") ? args[args.indexOf("--model") + 1] : "";
  const provider = buildProvider(preset.id, { apiKey: key, model });
  const { ok, detail } = await probe(provider);
  console.log(`${ok ? "✓" : "△"} 探活: ${detail}`);
  await finish(provider, preset);
  process.exit(ok ? 0 : 0); // 探活失败也不阻断写配置 (Key 可能晚点生效)
}

// ---- 交互式向导 ----
const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const ask = (q) => new Promise((r) => rl.question(q, r));

(async () => {
  console.log("\n══════ 皮皮虾 · 模型 API 配置向导 ══════");
  console.log("选择模型厂商 (输入编号或 id), 本地推理选 11/12 无需 Key:\n");
  const presets = listPresets();
  presets.forEach((p, i) => {
    console.log(`  [${String(i + 1).padStart(2)}] ${p.id.padEnd(12)} ${p.label.padEnd(26)} ${p.cloud ? "需 Key" : "本地免 Key"}`);
  });
  const pick = (await ask("\n编号/id: ")).trim();
  const preset = /^\d+$/.test(pick) ? presets[Number(pick) - 1] : getPreset(pick);
  if (!preset) { console.log("✗ 无效选择"); process.exit(1); }

  console.log(`\n→ ${preset.label}`);
  if (preset.key_url) console.log(`  API Key 获取: ${preset.key_url}`);
  let apiKey = "";
  if (preset.api_key_env) {
    apiKey = (await ask(`  输入 API Key (回车=使用环境变量 ${preset.api_key_env}): `)).trim();
  }
  let model = "";
  if (preset.models.length) {
    model = (await ask(`  模型 [${preset.models.join(" / ")}] (回车=默认): `)).trim();
  } else if (preset.model_hint) {
    model = (await ask(`  模型 (${preset.model_hint}): `)).trim();
  }

  const provider = buildProvider(preset.id, { apiKey, model });
  console.log("\n探活中...");
  const { ok, detail } = await probe(provider);
  console.log(`  ${ok ? "✓ 连通成功" : "△ 探活未通过: " + detail + " (仍会写入配置, 常见原因: Key 未生效/模型名不对/本地服务未启动)"}`);
  await finish(provider, preset);
  rl.close();
})().catch((e) => { console.error("✗ 向导异常:", e.message); process.exit(1); });

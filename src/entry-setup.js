#!/usr/bin/env node
// src/entry-setup.js - `ppx setup` 子命令实现 (2026-10-01 模型配置向导; 2026-11-08 并入单一 CLI)
// 目标: 用户只需 选厂商 → 输入 API Key → 自动探活 → 写入 config/ppx.json, 全程无需懂 base_url。
//
// 用法:
//   npm run setup                                  # 交互式向导
//   ppx setup --list                   # 列出全部内置厂商预设
//   ppx setup --provider deepseek --key sk-xxx [--model deepseek-chat]   # 非交互 (CI 友好)
//
// MCP 统一接口说明: 配置完成后, Claude Desktop / Cursor / 任何 MCP 客户端可直接连
//   http://127.0.0.1:8899/mcp 使用全部能力 (见 docs/MODEL-SETUP.md)。
import readline from "node:readline";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { listPresets, getPreset, buildProvider, applyProviderToConfig, formatPresetModels } from "../src/llm/presets.js";
import { discoverLocalServers } from "./llm/local-discover.js";
import { configFilePath, readPpxConfig, writeConfigAtomic } from "../src/utils/config-file.js";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const CONFIG_FILE = configFilePath(ROOT);
const args = process.argv.slice(2);

// 配置位置与运行时同源: 源码目录写 config/ppx.json, npm 安装写 <数据目录>/config.json
function readConfig() {
  return readPpxConfig(ROOT, {});
}
function writeConfig(raw) {
  writeConfigAtomic(ROOT, raw);
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
  console.log(`\n✓ 已写入 ${CONFIG_FILE} (provider: ${provider.id}, model: ${provider.model || "(默认)"})`);
  if (preset && preset.api_key_env && !provider.api_key) {
    console.log(`  提示: 未填 Key, 运行时会从环境变量 ${preset.api_key_env} 读取`);
  }
  console.log(`
下一步:
  1. 启动:      npm start            (桌面客户端窗口; Windows 也可双击 启动皮皮虾.bat)
  2. MCP 接入:  Claude Desktop / Cursor 等 MCP 客户端连 http://127.0.0.1:8899/mcp (桌面端运行时)
  3. 验证:      node scripts/eval.js --llm   (端到端真实链路)
详见 docs/MODEL-SETUP.md`);
}

// ---- 非交互模式 ----
if (args.includes("--list")) {
  for (const p of listPresets()) {
    const models = formatPresetModels(p, ", ").split(", ").filter(Boolean).slice(0, 2).join(", ");
    console.log(`${p.cloud ? "☁ " : "电脑 "}${p.id.padEnd(12)} ${p.label.padEnd(26)} ${models || p.model_hint || ""}`);
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

// 2026-11-14 (BYO 体验轮): 本机模型自动发现 —— 与 Web「一键接入本机模型」同一实现
//   (src/llm/local-discover.js discoverLocalServers, 6 端口回环扫描), CLI 不再只有
//   手动 lmstudio/ollama 预设。发现 → 选模型 → buildProvider 同款载荷 → probe → finish。
async function localDiscoverFlow(ask) {
  console.log("\n扫描本机模型服务 (LM Studio 1234 / Ollama 11434 / vLLM 8000 / llama.cpp 8080 / Jan 1337 / textgen 5000) ...");
  let servers = [];
  try {
    ({ servers } = await discoverLocalServers());
  } catch (e) {
    console.log(`✗ 扫描失败: ${e.message}`);
    return null;
  }
  const usable = servers.filter((s) => s.models && s.models.length);
  if (!usable.length) {
    console.log("✗ 未发现本机模型服务 (或服务无可用模型)。启动 LM Studio / Ollama 后重试, 或返回上面列表手选厂商。");
    return null;
  }
  usable.forEach((s, i) => {
    console.log(`  [${i + 1}] ${s.name} @127.0.0.1:${s.port} — ${s.models.length} 个模型${s.needs_key ? " (需 Key)" : ""}`);
    s.models.slice(0, 8).forEach((m, j) => {
      const kctx = Math.round((Number(m.context_window) || 0) / 1024);
      console.log(`      ${i + 1}.${j + 1}) ${m.label || m.id} (${kctx ? kctx + "K ctx" : "ctx 未知"}${(m.inputs || []).includes("image") ? " · 视觉" : ""}${m.loaded ? " · 已加载" : ""})`);
    });
  });
  const pick = (await ask("\n编号 (如 1 或 1.2; 回车返回厂商列表): ")).trim();
  const m = pick.match(/^(\d+)(?:\.(\d+))?$/);
  if (!m) return null;
  const server = usable[Number(m[1]) - 1];
  if (!server) { console.log("✗ 无效选择"); return null; }
  const row = m[2] ? server.models[Number(m[2]) - 1] : (server.models.find((x) => x.loaded) || server.models[0]);
  const model = String(row?.id || "").trim();
  if (!model) { console.log("✗ 无效选择"); return null; }
  let apiKey = "";
  if (server.needs_key) apiKey = (await ask("  该服务需要 Key, 输入 (回车跳过): ")).trim();
  const provider = {
    id: `local-${server.kind}`, backend: "http", base_url: server.base_url,
    protocol: "openai-completions", display_name: `${server.name} · ${model}`,
    model, models: [{ id: model, label: row?.label || model, ...(row?.context_window ? { context_window: row.context_window } : {}), ...(row?.max_output ? { max_output: row.max_output } : {}), inputs: row?.inputs || ["text"] }],
    enabled: true, api_key: apiKey || "local-no-key",
  };
  console.log("\n探活中...");
  const { ok, detail } = await probe(provider);
  console.log(`  ${ok ? "✓ 连通成功" : "△ 探活未通过: " + detail + " (仍会写入配置)"}`);
  await finish(provider, null);
  return true;
}

(async () => {
  console.log("\n══════ 皮皮虾 · 模型 API 配置向导 ══════");
  console.log("选择模型厂商 (输入编号或 id), 本地推理选 11/12 无需 Key; 输 0 自动发现本机模型:\n");
  const presets = listPresets();
  presets.forEach((p, i) => {
    console.log(`  [${String(i + 1).padStart(2)}] ${p.id.padEnd(12)} ${p.label.padEnd(26)} ${p.cloud ? "需 Key" : "本地免 Key"}`);
  });
  console.log("  [ 0] 本机自动发现   LM Studio / Ollama / vLLM… (扫描回环端口, 免 Key)");
  let preset = null;
  for (;;) {
    const pick = (await ask("\n编号/id: ")).trim();
    if (pick === "0" || pick === "local" || pick === "本机") {
      const done = await localDiscoverFlow(ask);
      if (done) { rl.close(); return; }
      continue; // 未发现/取消 → 回到厂商列表
    }
    preset = /^\d+$/.test(pick) ? presets[Number(pick) - 1] : getPreset(pick);
    if (preset) break;
    console.log("✗ 无效选择");
  }

  console.log(`\n→ ${preset.label}`);
  if (preset.key_url) console.log(`  API Key 获取: ${preset.key_url}`);
  let apiKey = "";
  if (preset.api_key_env) {
    apiKey = (await ask(`  输入 API Key (回车=使用环境变量 ${preset.api_key_env}): `)).trim();
  }
  let model = "";
  if (preset.models.length) {
    // 2026-11-14 (BYO 体验轮): v4.2 结构化 models 直接 join 会打出 [object Object],
    //   展示口径收敛到 presets.formatPresetModels (label 优先)
    const shown = formatPresetModels(preset);
    model = (await ask(`  模型 [${shown || preset.model_hint || ""}] (回车=默认): `)).trim();
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

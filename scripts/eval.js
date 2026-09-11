#!/usr/bin/env node
// scripts/eval.js - 统一 E2E 评测入口 (每次发版前跑一遍)
// 分层评测:
//   (1) 本地能力层 (必跑, 零依赖): 问候识别 / 时间工具 / 记忆闭环 / 生命周期 / 价值注入 / 文件工具
//   (2) LLM 端到端层 (--llm): LLM 直连 5 case + 记忆闭环 (复用 e2e-response-smoke 思路)
//       provider 选择优先级:
//         a. --provider <id>          从 config/ppx.json 取指定 provider
//         b. PPX_E2E_BASE_URL+KEY+MODEL 环境变量 (CI 注入, 跑真实回归)
//         c. 自动探活 LM Studio (本地零 key 兜底)
// 退出码: 任何失败 → 1 (可接 CI / npm script)
//
// 用法:
//   node scripts/eval.js                 # 本地能力评测 (无 LLM 也能跑)
//   node scripts/eval.js --llm           # 本地能力 + LLM 端到端 (自动选 provider)
//   node scripts/eval.js --provider deepseek --llm   # 用 config 里指定 provider
//   node scripts/eval.js --llm --quick   # 只跑本地能力, 不探活 LLM
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig } from "../src/config/index.js";
import { makeTmpRoot, makeAgentOnRoot, cleanupTmp } from "./lib/tmp-agent.js";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const wantLLM = args.includes("--llm");
const wantQuick = args.includes("--quick");
const providerId = args.includes("--provider") ? args[args.indexOf("--provider") + 1] : null;

let pass = 0, fail = 0;
const results = [];

function check(name, ok, detail = "") {
  if (ok) pass++; else fail++;
  results.push({ name, ok, detail });
  console.log(`  ${ok ? "✓" : "✗"} ${name}${detail ? "  — " + detail : ""}`);
}

function tmpRoot() {
  return makeTmpRoot("eval");
}

// ---- (1) 本地能力层 ----
async function localCapabilities() {
  console.log("── (1) 本地能力层 (零依赖) ──");
  const root = tmpRoot();
  // 统一数据隔离: makeAgentOnRoot 显式落 dataDir/globalDataDir 到临时根内 (覆盖 PPX_DATA_DIR), 清理走 cleanupTmp 安全护栏
  const agent = makeAgentOnRoot(root);

  // 问候识别 (本地意图, 不调 LLM)
  const greet = await agent.chat("你好");
  check("问候识别", typeof greet === "string" && greet.length > 0 && !greet.includes("LLM 调用失败"), greet.slice(0, 20));

  // 时间工具
  const now = new Date().getFullYear();
  const time = await agent.chat("现在几点");
  check("时间工具", String(time).includes(String(now)), time.slice(0, 30));

  // 价值注入 (ANS)
  const ctx = agent._context("测试");
  check("核心价值注入", ctx.includes("核心价值") && ctx.includes("保护用户隐私"));

  // 生命周期推进
  for (let i = 0; i < 3; i++) await agent.chat("好的");
  check("生命周期推进", agent.lifecycle.chats >= 3 && agent.lifecycle.stage === "growing", `chats=${agent.lifecycle.chats} stage=${agent.lifecycle.stage}`);

  // 记忆闭环: 写入 → 检索 (去重: 归一化后应只存 1 条)
  await agent.chat("记住：测试用待办事项 E2E-2026 下周完成");
  const q = await agent.chat("你记得测试用待办吗");
  check("记忆写入检索", q.includes("E2E-2026"), q.slice(0, 40));
  const dupCount = agent.facts.query("E2E-2026").length;
  check("记忆去重", dupCount <= 1, `命中 ${dupCount} 条 (归一化去重防冗余)`);

  // 文件工具 (读临时根下的文件)
  fs.writeFileSync(path.join(root, "demo.txt"), "ppx-agent E2E demo file");
  const read = await agent.chat("读文件 demo.txt");
  check("文件工具", String(read).includes("ppx-agent"), String(read).slice(0, 40));

  cleanupTmp({ root, agent });
  return { pass, fail };
}

// ---- (2) LLM 端到端层 ----
// provider 解析优先级: --provider 指定 > PPX_E2E_* 环境变量 > LM Studio 本地兜底
function resolveE2EProvider() {
  // a. --provider <id>: 从 config/ppx.json 取
  if (providerId) {
    try {
      const cfg = loadConfig(ROOT);
      const prov = (cfg.providers || []).find((p) => p && p.id === providerId);
      if (prov) return { source: "config:" + providerId, config: { ...prov } };
      console.log(`  ✗ --provider ${providerId} 不在 config/ppx.json providers 里`);
    } catch { /* 配置读取失败, 继续下一种 */ }
  }
  // b. PPX_E2E_* 环境变量 (CI 注入)
  if (process.env.PPX_E2E_BASE_URL) {
    return {
      source: "env PPX_E2E_*",
      config: {
        id: "e2e",
        base_url: process.env.PPX_E2E_BASE_URL,
        api_key: process.env.PPX_E2E_API_KEY || "lm-studio",
        model: process.env.PPX_E2E_MODEL || "default",
        vision: true,
        timeout_ms: 120000,
      },
    };
  }
  // c. LM Studio 本地兜底
  const MODEL = process.env.PPX_E2E_MODEL || "qwen3.5-9b-the-defiant-fable-uncnr-heretic-neo-max-mtp";
  return { source: "lmstudio 兜底", config: { id: "lmstudio", base_url: "http://127.0.0.1:1234/v1", api_key: "lm-studio", model: MODEL, vision: true, timeout_ms: 120000 } };
}

async function llmE2E() {
  console.log("\n── (2) LLM 端到端层 ──");
  const { LLMClient } = await import("../src/llm/client.js");
  const { source, config } = resolveE2EProvider();
  const client = new LLMClient(config);
  let healthy = false;
  try { healthy = await client.health(); } catch {}
  if (!healthy) {
    check("LLM 探活", false, `${source} 不可达 (${config.base_url}) — 跳过 LLM 端到端`);
    return;
  }
  console.log(`  → ${source} (${config.model}) 可达, 跑真实链路`);

  const CASES = [
    { name: "基础问答", prompt: "1+1 等于几？只回答数字。", expect: ["2"] },
    { name: "中文理解", prompt: "用一句话解释什么是「事件溯源」。", expect: ["事件", "日志", "历史"], any: true },
    { name: "工具-时间", prompt: "现在几点了？用 get_time 工具查。", expect: [String(new Date().getFullYear())], useTools: true },
    { name: "工具-读文件", prompt: "读 package.json 第一行, 告诉我这个项目叫什么。", expect: ["ppx-agent"], useTools: true },
  ];
  const tools = [
    { type: "function", function: { name: "get_time", description: "获取当前日期和时间", parameters: { type: "object", properties: {}, required: [] } } },
    { type: "function", function: { name: "read_file", description: "读取文件内容", parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] } } },
  ];
  async function runTool(name, args) {
    if (name === "get_time") return "当前时间 " + new Date().toLocaleString("zh-CN", { timeZone: "Asia/Shanghai" });
    if (name === "read_file") { try { return fs.readFileSync(path.join(ROOT, args.path), "utf8").slice(0, 300); } catch (e) { return "[失败]" + e.message; } }
    return "[未知工具]" + name;
  }

  for (const c of CASES) {
    const messages = [{ role: "user", content: c.prompt }];
    const t0 = Date.now();
    let content = "";
    try {
      if (c.useTools) {
        for (let r = 0; r < 4; r++) {
          const resp = await client.apiChat(messages, { tools });
          const tc = resp.message.tool_calls;
          if (!tc || !tc.length) { content = resp.message.content || ""; break; }
          messages.push({ role: "assistant", content: resp.message.content, tool_calls: tc });
          for (const call of tc) {
            const args = JSON.parse(call.function.arguments || "{}");
            messages.push({ role: "tool", tool_call_id: call.id, content: await runTool(call.function.name, args) });
          }
        }
      } else {
        content = (await client.chat(messages)).content || "";
      }
      const ok = c.any ? c.expect.some((k) => content.includes(k)) : c.expect.every((k) => content.includes(k));
      check(`LLM-${c.name}`, ok, `(${((Date.now() - t0) / 1000).toFixed(1)}s) ${content.replace(/\s+/g, " ").slice(0, 60)}`);
    } catch (e) {
      check(`LLM-${c.name}`, false, "异常: " + e.message);
    }
  }
}

(async () => {
  console.log("皮皮虾 E2E 评测 | " + new Date().toISOString().replace("T", " ").slice(0, 19) + "\n");
  await localCapabilities();
  if (wantLLM && !wantQuick) await llmE2E();
  else if (wantLLM && wantQuick) console.log("\n── (2) LLM 端到端层 ──\n  (--quick 跳过 LLM 端到端)");
  console.log(`\n=== 结果: ${pass} 过 / ${fail} 挂 ===`);
  process.exit(fail > 0 ? 1 : 0);
})().catch((e) => { console.error("✗ 评测异常:", e.message); process.exit(1); });

// scripts/benchmark.js - 真实 E2E 质量基线 (量化完成率/延迟/Token)
// 用配置的模型跑固定任务集, 输出逐项结果 + 汇总。
// 用法: node scripts/benchmark.js
//   - 后端从 config/ppx.json 的第一个可用 http provider 读取
//   - 可选 PPX_BENCH_IMAGE=/path/to.png 启用多模态读图用例
import fs from "node:fs";
import { loadConfig } from "../src/config/index.js";
import { LLMClient } from "../src/llm/client.js";

const root = process.cwd();
const config = loadConfig(root);
const img = process.env.PPX_BENCH_IMAGE || "";

// 选第一个可用 http provider (有 key 或本地端点)
function pickProvider(config) {
  const provs = config.providers || [];
  const p = provs.find((p) => {
    const key = p.api_key || process.env[p.api_key_env];
    const isLocal = /127\.0\.0\.1|localhost|lm-studio|ollama/i.test(p.base_url || "");
    return p.backend !== "openclaw" && p.backend !== "deepseek" && !!(key || isLocal);
  });
  if (!p) return null;
  return new LLMClient(p);
}

const tools = [
  { type: "function", function: { name: "get_time", description: "获取当前日期时间", parameters: { type: "object", properties: {}, required: [] } } },
  { type: "function", function: { name: "read_file", description: "读取工作目录下文件内容", parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] } } },
];

async function runTool(name, args) {
  if (name === "get_time") return "当前时间 " + new Date().toLocaleString("zh-CN", { timeZone: "Asia/Shanghai" });
  if (name === "read_file") { try { return fs.readFileSync(args.path, "utf8").slice(0, 400); } catch (e) { return "[失败]" + e.message; } }
  return "[未知]" + name;
}

// 任务集: { name, prompt, expect(关键词), useTools?, image? }
const CASES = [
  { name: "基础问答", prompt: "1+1 等于几？只回答数字。", expect: ["2"] },
  { name: "工具-时间", prompt: "现在几点了？用 get_time 工具查。", expect: ["2026"], useTools: true },
  { name: "工具-读文件", prompt: "读 README.md 第一行, 告诉我这个项目叫什么。", expect: ["皮皮虾"], useTools: true },
  { name: "多轮工具链", prompt: "先读 README.md 第一行告诉我项目名, 再用 get_time 查一下现在几点。", expect: ["皮皮虾", "2026"], useTools: true },
  ...(img && fs.existsSync(img)
    ? [{ name: "多模态-读图", prompt: "看这张图, 它是什么软件？", image: img, expect: ["LM Studio", "模型", "Studio"] }]
    : []),
];

async function runCase(client, c) {
  const messages = [];
  if (c.image) {
    const dataUrl = "data:image/png;base64," + fs.readFileSync(c.image).toString("base64");
    messages.push({ role: "user", content: [{ type: "text", text: c.prompt }, { type: "image_url", image_url: { url: dataUrl } }] });
  } else {
    messages.push({ role: "user", content: c.prompt });
  }
  const t0 = Date.now();
  let content = "", totalTokens = 0;
  if (c.useTools) {
    for (let r = 0; r < 4; r++) {
      const resp = await client.apiChat(messages, { tools });
      totalTokens += (resp.usage?.total_tokens || 0);
      const tc = resp.message.tool_calls;
      if (!tc || !tc.length) { content = resp.message.content || ""; break; }
      messages.push({ role: "assistant", content: resp.message.content, tool_calls: tc });
      for (const call of tc) {
        const args = JSON.parse(call.function.arguments || "{}");
        const result = await runTool(call.function.name, args);
        messages.push({ role: "tool", tool_call_id: call.id, content: result });
      }
    }
  } else {
    const resp = await client.chat(messages);
    content = resp.content || "";
    totalTokens = resp.usage?.total_tokens || 0;
  }
  const ms = Date.now() - t0;
  const pass = c.expect.some((k) => content.includes(k));
  return { name: c.name, pass, ms, tokens: totalTokens, snippet: content.replace(/\s+/g, " ").slice(0, 90) };
}

(async () => {
  const client = pickProvider(config);
  if (!client) {
    console.error("✗ 未找到可用 provider。请在 config/ppx.json 配置或设置 API key 环境变量。");
    process.exit(1);
  }
  console.log(`→ E2E 质量基线 | 后端: ${client.model}\n`);
  let pass = 0;
  const results = [];
  for (const c of CASES) {
    try {
      const r = await runCase(client, c);
      results.push(r);
      if (r.pass) pass++;
      console.log(`${r.pass ? "✓" : "✗"} ${r.name} (${(r.ms / 1000).toFixed(1)}s, ${r.tokens}t): ${r.snippet}`);
    } catch (e) {
      results.push({ name: c.name, pass: false, ms: 0, tokens: 0, snippet: "异常: " + e.message });
      console.log(`✗ ${c.name}: 异常 ${e.message}`);
    }
  }
  const totalMs = results.reduce((a, r) => a + r.ms, 0);
  const totalTok = results.reduce((a, r) => a + r.tokens, 0);
  console.log(`\n=== 汇总 ===`);
  console.log(`完成率: ${pass}/${CASES.length} (${(pass / CASES.length * 100).toFixed(0)}%)`);
  console.log(`总耗时: ${(totalMs / 1000).toFixed(1)}s | 平均 ${(totalMs / results.length / 1000).toFixed(1)}s/任务`);
  console.log(`总 Token: ${totalTok} | 平均 ${Math.round(totalTok / results.length)}/任务`);
})().catch((e) => { console.error("✗ 失败:", e.message); process.exit(1); });

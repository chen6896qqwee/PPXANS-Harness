// scripts/e2e-response-smoke.js - 响应质量端到端实测 (补 EVALUATION-v0.10.2 的 P1 空缺)
// 用 LM Studio 本地 qwen3.5-9b (中文强) 跑真实链路, 量化: 完成率 / 延迟 / Token
// 覆盖三层: (1) LLM 直连问答质量 (2) 工具调用 (3) Agent 记忆闭环 (写入→重启→检索)
// 用法: node scripts/e2e-response-smoke.js
import fs from "node:fs";
import { LLMClient } from "../src/llm/client.js";
import { makeTmpRoot, makeAgentOnRoot, cleanupTmp } from "./lib/tmp-agent.js";

// 当前时间动态关键词 (避免写死)
const now = new Date();
const HH = String(now.getHours()).padStart(2, "0");
const YYYY = String(now.getFullYear());

const MODEL = process.env.PPX_E2E_MODEL || "qwen3.5-9b-the-defiant-fable-uncnr-heretic-neo-max-mtp";
const config = { id: "lmstudio", base_url: "http://127.0.0.1:1234/v1", api_key: "lm-studio", model: MODEL, vision: true, timeout_ms: 120000 };

const tools = [
  { type: "function", function: { name: "get_time", description: "获取当前日期和时间", parameters: { type: "object", properties: {}, required: [] } } },
  { type: "function", function: { name: "read_file", description: "读取工作目录下文件内容", parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] } } },
];

async function runTool(name, args) {
  if (name === "get_time") return "当前时间 " + new Date().toLocaleString("zh-CN", { timeZone: "Asia/Shanghai" });
  if (name === "read_file") { try { return fs.readFileSync(args.path, "utf8").slice(0, 300); } catch (e) { return "[失败]" + e.message; } }
  return "[未知工具]" + name;
}

const CASES = [
  { name: "基础问答", prompt: "1+1 等于几？只回答数字。", expect: ["2"] },
  { name: "中文理解", prompt: "用一句话解释什么是「事件溯源」。", expect: ["事件", "日志", "历史"], any: true },
  { name: "工具-时间", prompt: "现在几点了？用 get_time 工具查。", expect: [YYYY], useTools: true },
  { name: "工具-读文件", prompt: "读 README.md 第一行, 告诉我这个项目叫什么。", expect: ["皮皮虾"], useTools: true },
  { name: "多轮工具链", prompt: "先读 README.md 第一行告诉我项目名, 再用 get_time 查现在几点。", expect: ["皮皮虾", YYYY], useTools: true },
];

async function runCase(client, c) {
  const messages = [{ role: "user", content: c.prompt }];
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
  const pass = c.any ? c.expect.some((k) => content.includes(k)) : c.expect.every((k) => content.includes(k));
  return { name: c.name, pass, ms, tokens: totalTokens, snippet: content.replace(/\s+/g, " ").slice(0, 90) };
}

async function llmDirect(client) {
  console.log(`── (1) LLM 直连响应质量 | 模型: ${MODEL} ──`);
  let pass = 0; const results = [];
  for (const c of CASES) {
    try {
      const r = await runCase(client, c);
      results.push(r); if (r.pass) pass++;
      console.log(`  ${r.pass ? "✓" : "✗"} ${r.name} (${(r.ms / 1000).toFixed(1)}s, ${r.tokens}t): ${r.snippet}`);
    } catch (e) {
      results.push({ name: c.name, pass: false, ms: 0, tokens: 0, snippet: "异常: " + e.message });
      console.log(`  ✗ ${c.name}: 异常 ${e.message}`);
    }
  }
  const ms = results.reduce((a, r) => a + r.ms, 0);
  const tok = results.reduce((a, r) => a + r.tokens, 0);
  console.log(`  完成率 ${pass}/${CASES.length} | 总 ${(ms / 1000).toFixed(1)}s 平均 ${(ms / results.length / 1000).toFixed(1)}s/任务 | Token ${tok}`);
  return { pass, total: CASES.length, ms, tok };
}

async function agentLoop() {
  console.log(`\n── (2) Agent 层记忆闭环 (写入→重启→检索) ──`);
  // 统一数据隔离: 临时根 (含 providers/user 配置) + 显式 dataDir + 安全清理
  const root = makeTmpRoot("e2e", {
    providers: [config],
    user: { name: "兄弟" },
  });
  const mk = () => makeAgentOnRoot(root);

  // 启动 1: 对话 + 记忆写入
  const a1 = mk();
  let t0 = Date.now();
  const reply1 = await a1.chat("记住: 我老婆生日是 8 月 20 号。");
  const ms1 = Date.now() - t0;

  // 验证记忆落盘
  const facts1 = a1.facts.query("生日");
  const saved = facts1.some((f) => f.content.includes("8") && f.content.includes("20"));

  // 重启: 用同一 root 重新 new 一个 agent, 验证记忆持久化
  a1.shutdown();
  const a2 = mk();
  t0 = Date.now();
  const reply2 = await a2.chat("我老婆生日是哪天？");
  const ms2 = Date.now() - t0;
  const recalled = a2.facts.query("生日").some((f) => f.content.includes("8") && f.content.includes("20"));

  console.log(`  写入: "${reply1.replace(/\s+/g, " ").slice(0, 50)}" (${(ms1 / 1000).toFixed(1)}s)`);
  console.log(`  落盘: ${saved ? "✓ facts.json 含生日记忆" : "✗ 未落盘"}`);
  console.log(`  重启检索: "${reply2.replace(/\s+/g, " ").slice(0, 50)}" (${(ms2 / 1000).toFixed(1)}s)`);
  console.log(`  持久化: ${recalled ? "✓ 重启后记忆仍在" : "✗ 记忆丢失"}`);

  cleanupTmp({ root, agent: a2 });
  return { saved, recalled, ms: ms1 + ms2 };
}

(async () => {
  const client = new LLMClient(config);
  // 先探活
  const healthy = await client.health();
  if (!healthy) { console.error("✗ LM Studio 不可达 (http://127.0.0.1:1234/v1), 请先启动 LM Studio"); process.exit(1); }
  console.log(`→ 响应质量端到端实测 | 后端: LM Studio ${MODEL} | 时间 ${YYYY}-${now.toISOString().slice(5, 10)} ${HH}:xx\n`);

  const r1 = await llmDirect(client);
  const r2 = await agentLoop();

  console.log(`\n=== 汇总 ===`);
  console.log(`(1) LLM 直连: ${r1.pass}/${r1.total} 完成 (${(r1.pass / r1.total * 100).toFixed(0)}%) | ${(r1.ms / 1000).toFixed(1)}s | ${r1.tok} tokens`);
  console.log(`(2) 记忆闭环: 落盘 ${r2.saved ? "✓" : "✗"} | 持久化 ${r2.recalled ? "✓" : "✗"} | ${(r2.ms / 1000).toFixed(1)}s`);
  process.exit(0);
})().catch((e) => { console.error("✗ 失败:", e.message); process.exit(1); });

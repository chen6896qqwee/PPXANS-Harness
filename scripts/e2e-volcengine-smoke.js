// scripts/e2e-volcengine-smoke.js - 火山方舟云端 deepseek-v4-flash 端到端实测
// 验证: (1) 纯对话响应质量 (2) 工具调用支持 (3) Agent 记忆闭环
// key: 临时明文, 跑完即删, 不落 config/ppx.json
// 用法: node scripts/e2e-volcengine-smoke.js
import fs from "node:fs";
import { LLMClient } from "../src/llm/client.js";
import { makeTmpRoot, makeAgentOnRoot, cleanupTmp } from "./lib/tmp-agent.js";

const KEY = process.env.VOLC_KEY; // 测试用临时 key
const BASE = "https://ark.cn-beijing.volces.com/api/coding/v3";
const MODEL = "deepseek-v4-flash-ga-260731";

const provider = { id: "volc-coding", base_url: BASE, api_key: KEY, model: MODEL, timeout_ms: 60000 };

const now = new Date();
const YYYY = String(now.getFullYear());

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
  { name: "中文理解", prompt: "用一句话解释什么是「事件溯源」。", expect: ["事件", "历史"], any: true },
  { name: "推理-数学", prompt: "一个水池有两根管, A 管 6 小时能注满, B 管 3 小时能放空, 同时打开多久注满？", expect: ["6"] },
  { name: "工具-时间", prompt: "现在几点了？用 get_time 工具查。", expect: [YYYY], useTools: true },
  { name: "工具-读文件", prompt: "读 README.md 第一行, 告诉我项目名。", expect: ["皮皮虾"], useTools: true },
  { name: "多轮工具链", prompt: "先读 README.md 第一行告诉我项目名, 再用 get_time 查现在几点。", expect: ["皮皮虾", YYYY], useTools: true },
];

async function runCase(client, c) {
  const messages = [{ role: "user", content: c.prompt }];
  const t0 = Date.now();
  let content = "", totalTokens = 0;
  let toolCalled = false;
  try {
    if (c.useTools) {
      for (let r = 0; r < 4; r++) {
        const resp = await client.apiChat(messages, { tools });
        totalTokens += (resp.usage?.total_tokens || 0);
        const tc = resp.message.tool_calls;
        if (!tc || !tc.length) { content = resp.message.content || ""; break; }
        toolCalled = true;
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
  } catch (e) {
    return { name: c.name, pass: false, ms: Date.now() - t0, tokens: 0, toolCalled, snippet: "异常: " + e.message };
  }
  const ms = Date.now() - t0;
  const pass = c.any ? c.expect.some((k) => content.includes(k)) : c.expect.every((k) => content.includes(k));
  return { name: c.name, pass, ms, tokens: totalTokens, toolCalled, snippet: content.replace(/\s+/g, " ").slice(0, 90) };
}

async function llmDirect(client) {
  console.log(`── (1) LLM 直连 | 模型: ${MODEL} | 端点: coding/v3 ──`);
  let pass = 0; const results = [];
  for (const c of CASES) {
    const r = await runCase(client, c);
    results.push(r); if (r.pass) pass++;
    const tcMark = c.useTools ? (r.toolCalled ? " [tool]" : " [no-tool]") : "";
    console.log(`  ${r.pass ? "✓" : "✗"} ${r.name}${tcMark} (${(r.ms / 1000).toFixed(1)}s, ${r.tokens}t): ${r.snippet}`);
  }
  const ms = results.reduce((a, r) => a + r.ms, 0);
  const tok = results.reduce((a, r) => a + r.tokens, 0);
  console.log(`  完成率 ${pass}/${CASES.length} | 总 ${(ms / 1000).toFixed(1)}s 平均 ${(ms / results.length / 1000).toFixed(1)}s/任务 | Token ${tok}`);
  return { pass, total: CASES.length, ms, tok, results };
}

async function agentLoop() {
  console.log(`\n── (2) Agent 层记忆闭环 (coding/v3 是否支持 agent 全链路) ──`);
  const root = makeTmpRoot("volc", { providers: [provider], user: { name: "兄弟" } });

  let writeMs = 0, queryMs = 0, writeOk = false, queryOk = false, writeErr = "", queryErr = "";
  try {
    const a1 = makeAgentOnRoot(root);
    let t0 = Date.now();
    try {
      const reply1 = await a1.chat("记住: 我老婆生日是 8 月 20 号。");
      writeMs = Date.now() - t0;
      writeOk = a1.facts.query("生日").some((f) => f.content.includes("8") && f.content.includes("20"));
      console.log(`  写入: "${reply1.replace(/\s+/g, " ").slice(0, 50)}" (${(writeMs / 1000).toFixed(1)}s)`);
    } catch (e) { writeErr = e.message; console.log(`  写入异常: ${e.message}`); }
    a1.shutdown();

    const a2 = makeAgentOnRoot(root);
    t0 = Date.now();
    try {
      const reply2 = await a2.chat("我老婆生日是哪天？");
      queryMs = Date.now() - t0;
      queryOk = reply2.includes("8 月 20") || reply2.includes("8月20");
      console.log(`  重启检索: "${reply2.replace(/\s+/g, " ").slice(0, 50)}" (${(queryMs / 1000).toFixed(1)}s)`);
    } catch (e) { queryErr = e.message; console.log(`  重启检索异常: ${e.message.slice(0, 100)}`); }
    a2.shutdown();
  } finally {
    cleanupTmp(root);
  }
  return { writeOk, writeMs, queryOk, queryMs, writeErr, queryErr };
}

(async () => {
  const client = new LLMClient(provider);
  const healthy = await client.health();
  if (!healthy) { console.error("✗ 火山方舟端点不可达, 请检查 key/网络"); process.exit(1); }
  console.log(`→ 火山方舟云端端到端实测 | 模型: ${MODEL} | 端点: ${BASE}\n`);

  const r1 = await llmDirect(client);
  const r2 = await agentLoop();

  console.log(`\n=== 汇总 ===`);
  console.log(`(1) LLM 直连: ${r1.pass}/${r1.total} (${(r1.pass / r1.total * 100).toFixed(0)}%) | ${(r1.ms / 1000).toFixed(1)}s | ${r1.tok} tokens`);
  console.log(`(2) Agent 闭环: 写入 ${r2.writeOk ? "✓" : "✗"} (${(r2.writeMs / 1000).toFixed(1)}s) | 重启检索 ${r2.queryOk ? "✓" : "✗"} (${(r2.queryMs / 1000).toFixed(1)}s)`);
  if (r2.writeErr) console.log(`    写入错误: ${r2.writeErr}`);
  if (r2.queryErr) console.log(`    查询错误: ${r2.queryErr.slice(0, 150)}`);
  process.exit(0);
})().catch((e) => { console.error("✗ 失败:", e.message); process.exit(1); });

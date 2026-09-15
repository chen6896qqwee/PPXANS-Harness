// scripts/toolcall-smoke.js - 原生 tool_calls 全链路测试 (http 后端, 默认 LM Studio 本地模型)
// 验证: 模型发 tool_calls → 皮皮虾执行 → 结果回填 → 模型给最终答案
// 用法: node scripts/toolcall-smoke.js   (默认 LM Studio 本地 gemma)
import { LLMClient } from "../src/llm/client.js";

const config = {
  id: "lmstudio",
  base_url: "http://127.0.0.1:1234/v1",
  api_key: "lm-studio",
  model: "gemma-4-e2b-uncensored-hauhaucs-aggressive-q8_k_p",
  timeout_ms: 120000,
};

const tools = [
  { type: "function", function: { name: "get_time", description: "获取当前日期和时间", parameters: { type: "object", properties: {}, required: [] } } },
  { type: "function", function: { name: "read_file", description: "读取工作目录下文件的文本内容", parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] } } },
];

async function runTool(name, args) {
  if (name === "get_time") return "当前时间: " + new Date().toLocaleString("zh-CN", { timeZone: "Asia/Shanghai" });
  if (name === "read_file") {
    try {
      const fs = await import("node:fs");
      return fs.readFileSync(args.path, "utf8").slice(0, 500);
    } catch (e) { return "[读取失败] " + e.message; }
  }
  return "[未知工具] " + name;
}

(async () => {
  const c = new LLMClient(config);
  console.log(`→ 后端: ${config.id} (${config.model}) — 原生 tool_calls 全链路\n`);
  const messages = [{ role: "user", content: "现在几点？另外读一下 README.md 第一行, 告诉我这个项目叫什么。" }];

  let toolRounds = 0;
  for (let round = 0; round < 6; round++) {
    const r = await c.apiChat(messages, { tools });
    const tc = r.message.tool_calls;
    if (!tc || !tc.length) {
      console.log(`✓ 最终答案 (${round} 轮工具): ${r.message.content}`);
      break;
    }
    // 有 tool_calls: 执行并回填
    messages.push({ role: "assistant", content: r.message.content, tool_calls: tc });
    for (const call of tc) {
      const args = JSON.parse(call.function.arguments || "{}");
      const result = await runTool(call.function.name, args);
      console.log(`  ⟳ 第${round + 1}轮 tool_call: ${call.function.name}(${JSON.stringify(args)}) → ${result.slice(0, 80)}`);
      messages.push({ role: "tool", tool_call_id: call.id, content: result });
    }
    toolRounds = round + 1;
  }
})().catch((e) => { console.error(`✗ 失败: ${e.message}`); process.exit(1); });

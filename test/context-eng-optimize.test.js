import test from "node:test";
import assert from "node:assert";
import { PPXAgent } from "../src/agent/index.js";
import { LLMClient } from "../src/llm/client.js";

// v0.6.6 优化测试: _trimHistory 信息量感知裁剪 + _proxyChat 动态 token 预算
// 直接调真实路径, 不注入 mock 绕过 (上一轮复审核实的约定)

function fakeAgent() {
  // 只构造一个不落盘的轻量实例, 直接测 _trimHistory
  const a = new PPXAgent({ root: "__nonexistent__", configFile: null });
  return a;
}

test("v0.6.6: _trimHistory 信息量感知 - 超过条数上限时保留高信息量轮次", () => {
  const a = fakeAgent();
  // 构造 50 条寒暄 + 3 条实质 = 53 条, 超默认 max_history_items(40)
  const hist = [];
  for (let i = 0; i < 50; i++) hist.push({ role: "user", content: "你好" });
  hist.push({ role: "user", content: "请帮我分析一下项目架构并给出优化建议" });
  hist.push({ role: "assistant", content: "分析完成: /src/agent/index.js 有 4169 行, 建议拆分模块, 失败重试逻辑已优化" });
  hist.push({ role: "user", content: "好的" });
  const out = a._trimHistory(hist);
  // 53 条超 max_history_items(40), 裁剪后应<=40
  assert.ok(out.length <= 40, `裁剪后 ${out.length} 条, 应<=40`);
  // 高信息量轮次必须保留(含路径/数字/结论)
  const joined = out.map((m) => String(m.content || "")).join("|");
  assert.ok(joined.includes("分析完成"), "含结论的轮次应保留");
  assert.ok(joined.includes("4169"), "含路径/数字的轮次应保留");
});

test("v0.6.6: _trimHistory 寒暄可被淘汰, 但关键信息保留", () => {
  const a = fakeAgent();
  const hist = [
    { role: "user", content: "你好" },
    { role: "user", content: "帮我配置数据库连接, 端口 5432, 搞砸了会报错" },
    { role: "assistant", content: "已配置成功完成" },
    { role: "user", content: "谢谢" },
  ];
  const out = a._trimHistory(hist);
  const joined = out.map((m) => String(m.content || "")).join("|");
  assert.ok(joined.includes("5432"), "关键配置信息保留");
});

test("v0.8.0: _trimHistory token 预算 - 信息量感知裁剪, 低信息量长轮次让位", () => {
  const a = fakeAgent();
  a.config.memory.history_token_budget = 40; // 强制小预算触发裁剪
  const hist = [
    { role: "user", content: "好的好的知道了明白了".repeat(20) },  // 长低信息量 (~200字)
    { role: "assistant", content: "收到收到".repeat(20) },          // 长低信息量
    { role: "user", content: "帮我配置数据库端口 5432" },            // 高信息量 (+3)
    { role: "assistant", content: "配置成功完成" },
  ];
  const out = a._trimHistory(hist);
  const joined = out.map((m) => String(m.content || "")).join("|");
  assert.ok(joined.includes("5432"), "高信息量轮次在 token 预算下保留");
  assert.ok(out.length < hist.length, "低信息量长轮次被裁剪");
});

test("v0.6.6: _proxyChat 动态预算 - persona 保留且历史按信息量筛选", async () => {
  const client = new LLMClient({ id: "openclaw" });
  // 构造超长 persona + 大量历史
  const messages = [
    { role: "system", content: "你是皮皮虾, 一个会自我修复的超级Agent。".repeat(200) }, // ~4400字
    ...Array.from({ length: 20 }, (_, i) => ({ role: "user", content: `你好第${i}次` })),
    { role: "user", content: "请分析 src/agent/index.js 的架构" },
  ];
  // 直接触发 _proxyChat 但拦截引擎调用, 只看组装的上下文
  let captured = "";
  const orig = client._openclawChatAsync.bind(client);
  client._openclawChatAsync = async (msgs) => { captured = msgs[0].content; return { content: "完成", usage: null }; };
  const tools = [];
  const toolRunner = null;
  await client._proxyChat(messages, { tools, toolRunner, engine: "openclaw" });
  assert.ok(captured.includes("角色设定"), "persona 保留");
  assert.ok(captured.includes("皮皮虾"), "persona 内容在");
  assert.ok(captured.includes("分析 src/agent/index.js"), "最新高信息量任务保留");
  // persona 不应被全量塞入 (应被预算截断)
  assert.ok(captured.includes("...["), "persona 被预算截断(含截断标记)而非全量拷贝");
  void orig;
});

// test/dsml.test.js - DSML (DeepSeek V4 Flash 工具调用格式) 解析/构造
import test from "node:test";
import assert from "node:assert";
import { parseDsml, buildDsmlPrompt } from "../src/llm/dsml.js";
import { parseToolCalls, proxyToolLoop } from "../src/llm/fence.js";

const P = "\uFF5C"; // ｜

test("parseDsml: 单工具 + 字符串/数字参数", () => {
  const dsml = `<${P}DSML${P}tool_calls>
<${P}DSML${P}invoke name="get_weather">
<${P}DSML${P}parameter name="city" string="true">北京</${P}DSML${P}parameter>
<${P}DSML${P}parameter name="days" string="false">3</${P}DSML${P}parameter>
</${P}DSML${P}invoke>
</${P}DSML${P}tool_calls>`;
  const { calls, clean } = parseDsml(dsml);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].name, "get_weather");
  assert.equal(calls[0].args.city, "北京", "string=true 应保留字符串");
  assert.equal(calls[0].args.days, 3, "string=false 应解析为数字");
  assert.ok(!clean.includes("DSML"), "clean 应剥离 DSML");
});

test("parseDsml: 多工具调用", () => {
  const dsml = `<${P}DSML${P}tool_calls>
<${P}DSML${P}invoke name="a"><${P}DSML${P}parameter name="x" string="false">1</${P}DSML${P}parameter></${P}DSML${P}invoke>
<${P}DSML${P}invoke name="b"></${P}DSML${P}invoke>
</${P}DSML${P}tool_calls>`;
  const { calls } = parseDsml(dsml);
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[0], { name: "a", args: { x: 1 } });
  assert.deepEqual(calls[1], { name: "b", args: {} });
});

test("parseDsml: thinking 模式", () => {
  const dsml = `<think>用户要查天气, 需要调 get_weather</think>
<${P}DSML${P}tool_calls><${P}DSML${P}invoke name="get_weather"></${P}DSML${P}invoke></${P}DSML${P}tool_calls>`;
  const { calls, thinking } = parseDsml(dsml);
  assert.equal(calls.length, 1);
  assert.ok(thinking.includes("查天气"), "应提取 think 内容");
});

test("buildDsmlPrompt: 含 DSML 标记与工具清单", () => {
  const p = buildDsmlPrompt([{ function: { name: "get_time", description: "获取时间" } }]);
  assert.ok(p.includes("DSML"), "含 DSML 说明");
  assert.ok(p.includes("get_time"), "含工具清单");
});

test("parseToolCalls: 围栏优先, DSML 兜底", () => {
  // 围栏命中 → 用围栏
  const f = parseToolCalls("⟪tool:read_file│{\"path\":\"a.txt\"}⟫");
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].function.name, "read_file");
  // 无围栏 → DSML 兜底
  const d = parseToolCalls(`<${P}DSML${P}tool_calls><${P}DSML${P}invoke name="get_time"></${P}DSML${P}invoke></${P}DSML${P}tool_calls>`);
  assert.equal(d.calls.length, 1);
  assert.equal(d.calls[0].function.name, "get_time");
});

test("proxyToolLoop: 引擎输出 DSML 也能走工具循环", async () => {
  const replies = [
    `<${P}DSML${P}tool_calls><${P}DSML${P}invoke name="get_time"></${P}DSML${P}invoke></${P}DSML${P}tool_calls>`,
    "现在是 14:35",
  ];
  let i = 0;
  const engineReply = async () => replies[i++];
  const toolRunner = async (name) => { assert.equal(name, "get_time"); return "2026-08-16 14:35"; };
  const final = await proxyToolLoop(engineReply, toolRunner);
  assert.equal(final, "现在是 14:35");
});

// src/llm/fence.js - 工具围栏协议 (自研文本工具调用解析)
// 背景: 部分模型(本地/DSML 文本模型)不输出原生 tool_calls, 而是以纯文本表达工具意图:
//   模型被要求以围栏格式输出工具意图 ⟪tool:name|{"参数":值}⟫
//   PPX 解析围栏 -> 恢复为 tool_calls -> 执行自己的工具
// 与 DSML (src/llm/dsml.js) 互补, 均为自研解析器, 零外部依赖。
// 纯函数, 无 I/O, 便于单测。

import { parseDsml } from "./dsml.js";

// 围栏正则: ⟪tool:名字|{json}⟫  (参数用 JSON; 名字限标识符)
const FENCE_RE = /⟪tool:([A-Za-z_][\w]*)│([\s\S]*?)⟫/g;

// 解析引擎文本: 提取 tool_calls, 同时剥离围栏保留纯文本回复
export function parseToolFence(text) {
  const calls = [];
  let clean = String(text);
  let m;
  FENCE_RE.lastIndex = 0;
  while ((m = FENCE_RE.exec(text)) !== null) {
    const name = m[1];
    const argsRaw = m[2].trim();
    let args = {};
    try { args = JSON.parse(argsRaw || "{}"); } catch { /* 非JSON则空对象 */ }
    calls.push({
      id: "ppx_" + calls.length + "_" + Math.random().toString(36).slice(2, 8),
      type: "function",
      function: { name, arguments: argsRaw || "{}" },
      _args: args,
    });
  }
  if (calls.length) clean = text.replace(FENCE_RE, "").replace(/\n{3,}/g, "\n\n").trim();
  return { calls, clean };
}

// 统一工具调用解析: 先试自定义围栏 ⟪tool⟫, 再试 DSML (DeepSeek V4 Flash 官方格式)。
// 让围栏代理能同时驱动"围栏模型"与"DSML 文本模型"(如本地 DeepSeek V4 Flash)。
export function parseToolCalls(text) {
  const fence = parseToolFence(text);
  if (fence.calls.length) return fence;
  const dsml = parseDsml(text);
  const calls = dsml.calls.map((c, i) => ({
    id: "dsml_" + i + "_" + Math.random().toString(36).slice(2, 6),
    type: "function",
    function: { name: c.name, arguments: JSON.stringify(c.args || {}) },
    _args: c.args || {},
  }));
  return { calls, clean: dsml.clean, thinking: dsml.thinking };
}

// (v2.5.0) buildFencePrompt / proxyToolLoop 已移除: 二者专为 openclaw/dsh 外部引擎底座服务,
// 独立化改造后不再需要。http 文本模型提示注入统一走 dsml.js 的 buildDsmlPrompt。
// 本模块只保留解析逻辑 (parseToolFence / parseToolCalls), 供 client.js 恢复文本工具调用。

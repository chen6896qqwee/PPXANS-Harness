// src/llm/adapters/completions.js - OpenAI Chat Completions 适配器 (直通)
//
// 历史唯一底座: 内部 wire 即该协议形态, 构建/解析基本是恒等映射, 只做 usage 归一与
// 流式 tool_call 分片累积。响应/请求形态的差异点见 docs/PROVENANCE.md#leizai。
import { noteCatch } from "../../utils/catch-log.js";
import { normUsage } from "./wire.js";

export const openaiCompletions = {
  id: "openai-completions",
  endpoint() { return "/chat/completions"; },
  headers(apiKey) {
    return { "Content-Type": "application/json", "Authorization": `Bearer ${apiKey}` };
  },
  buildBody({ model, messages, tools, temperature, maxTokens, stream, includeUsage, extraBody }) {
    const body = { model, messages, temperature, max_tokens: maxTokens };
    if (tools?.length) body.tools = tools;
    if (stream) {
      body.stream = true;
      if (includeUsage !== false) body.stream_options = { include_usage: true };
    }
    return { ...body, ...(extraBody || {}) }; // extraBody = client._thinkParams() (厂商思考参数)
  },
  parseResponse(data) {
    const message = data?.choices?.[0]?.message;
    if (!message) return null;
    return {
      message: {
        role: message.role || "assistant",
        content: message.content ?? null,
        tool_calls: message.tool_calls || null,
        reasoning_content: message.reasoning_content || null,
      },
      usage: normUsage(data?.usage),
    };
  },
  createStreamAcc() {
    let content = "";
    let reasoning = "";
    let streamedAny = false;
    let usage = null;
    const tcAcc = new Map(); // index -> {id, name, args}
    return {
      feed(j, cb = {}) {
        if (j.usage) usage = normUsage(j.usage);
        const d = j.choices?.[0]?.delta || {};
        if (typeof d.content === "string" && d.content) {
          content += d.content;
          streamedAny = true;
          if (cb.onDelta) { try { cb.onDelta(d.content, { kind: "text" }); } catch (e) { noteCatch(e); /* 消费方异常不阻断流 */ } }
        }
        const rd = (typeof d.reasoning_content === "string" && d.reasoning_content)
          || (typeof d.reasoning === "string" && d.reasoning) || "";
        if (rd) {
          reasoning += rd;
          if (cb.onReasoning) { try { cb.onReasoning(rd, { kind: "reasoning" }); } catch (e) { noteCatch(e); } }
        }
        if (Array.isArray(d.tool_calls)) {
          for (const tc of d.tool_calls) {
            const i = Number(tc.index ?? 0);
            const acc = tcAcc.get(i) || { id: "", name: "", args: "" };
            if (tc.id) acc.id = tc.id;
            if (tc.function?.name) {
              // name 通常单帧到位; 分片厂商按前缀累积 → 取更长前缀
              acc.name = !acc.name ? tc.function.name
                : (tc.function.name.length > acc.name.length && tc.function.name.startsWith(acc.name) ? tc.function.name : acc.name);
            }
            if (typeof tc.function?.arguments === "string") acc.args += tc.function.arguments;
            tcAcc.set(i, acc);
          }
        }
      },
      result() {
        const toolCalls = tcAcc.size
          ? [...tcAcc.entries()].sort((a, b) => a[0] - b[0]).map(([k, a], i) => ({
            id: a.id || `call_stream_${i}`,
            type: "function",
            function: { name: a.name, arguments: a.args || "{}" },
          }))
          : null;
        return {
          message: { role: "assistant", content: content || null, tool_calls: toolCalls },
          usage, streamed: streamedAny, reasoning: reasoning || null,
        };
      },
    };
  },
  modelsUrl(baseUrl) { return `${baseUrl}/models`; },
  parseModels(data) {
    return (Array.isArray(data?.data) ? data.data : [])
      .map((m) => ({ id: m?.id || "", label: "" }))
      .filter((m) => m.id);
  },
};

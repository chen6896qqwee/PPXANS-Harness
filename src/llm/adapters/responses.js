// src/llm/adapters/responses.js - OpenAI Responses 适配器 (/responses)
//
// 差异点: system 走 instructions、工具是扁平 function (非嵌套)、内容块 output_text/input_text,
// 以及事件式 SSE (response.output_text.delta / response.function_call_arguments.delta ...)。
import { noteCatch } from "../../utils/catch-log.js";
import { normUsage } from "./wire.js";
import { openaiCompletions } from "./completions.js";

// 内部 wire 消息 -> Responses input 数组 (system 走 instructions, 由 toResponsesInput 返回)
function toResponsesInput(messages) {
  const input = [];
  let instructions = "";
  for (const m of messages) {
    if (!m || typeof m !== "object") continue;
    const role = m.role;
    if (role === "system" || role === "developer") {
      instructions += (instructions ? "\n\n" : "") + (typeof m.content === "string" ? m.content : "");
      continue;
    }
    if (role === "tool") {
      // 工具结果: {type:"function_call_output", call_id, output}
      const out = typeof m.content === "string" ? m.content
        : JSON.stringify(m.content ?? "");
      input.push({ type: "function_call_output", call_id: m.tool_call_id || "", output: out });
      continue;
    }
    if (role === "assistant" && Array.isArray(m.tool_calls) && m.tool_calls.length) {
      if (typeof m.content === "string" && m.content) {
        input.push({ role: "assistant", content: [{ type: "output_text", text: m.content }] });
      }
      for (const tc of m.tool_calls) {
        input.push({
          type: "function_call",
          call_id: tc.id || "",
          name: tc.function?.name || "",
          arguments: tc.function?.arguments || "{}",
        });
      }
      continue;
    }
    // 普通 user / assistant 文本 (含多模态 content 数组)
    if (Array.isArray(m.content)) {
      const parts = [];
      for (const c of m.content) {
        if (!c) continue;
        if (c.type === "text" && c.text) parts.push({ type: role === "assistant" ? "output_text" : "input_text", text: c.text });
        else if (c.type === "image_url" && c.image_url?.url) parts.push({ type: "input_image", image_url: c.image_url.url, detail: "auto" });
      }
      if (parts.length) input.push({ role, content: parts });
    } else if (typeof m.content === "string" && m.content) {
      input.push({
        role,
        content: [{ type: role === "assistant" ? "output_text" : "input_text", text: m.content }],
      });
    }
  }
  return { instructions: instructions || null, input };
}

// OpenAI tools 定义 (嵌套 function) -> Responses 扁平 function 工具
function toolsToResponses(tools) {
  return (tools || []).map((t) => {
    if (t?.type === "function" && t.function) {
      return {
        type: "function",
        name: t.function.name,
        description: t.function.description || "",
        parameters: t.function.parameters || { type: "object", properties: {} },
      };
    }
    return t; // 非函数工具原样透传 (内置 web_search 等本协议不主推, 保守放行)
  });
}

export const openaiResponses = {
  id: "openai-responses",
  endpoint() { return "/responses"; },
  headers(apiKey) {
    return { "Content-Type": "application/json", "Authorization": `Bearer ${apiKey}` };
  },
  buildBody({ model, messages, tools, temperature, maxTokens, stream, reasoning, extraBody }) {
    const { instructions, input } = toResponsesInput(messages);
    const body = {
      model,
      input,
      store: false, // 无状态直连: 不落 OpenAI 侧会话存储
      max_output_tokens: Math.max(16, Math.floor(maxTokens || 4096)),
    };
    if (instructions) body.instructions = instructions;
    if (tools?.length) { body.tools = toolsToResponses(tools); body.tool_choice = "auto"; }
    if (Number.isFinite(temperature)) body.temperature = temperature;
    // 思考强度: off/auto 不发 (宁可不发, 不发错); max 钳制到 high 防未支持档位 400
    if (["low", "medium", "high", "max"].includes(reasoning)) {
      body.reasoning = { effort: reasoning === "max" ? "high" : reasoning };
    }
    if (stream) body.stream = true;
    return { ...body, ...(extraBody || {}) }; // 与 completions/anthropic 一致: reasoning_params 逃生口全协议生效
  },
  parseResponse(data) {
    const output = Array.isArray(data?.output) ? data.output : [];
    let text = "";
    const toolCalls = [];
    for (const item of output) {
      if (item?.type === "message" && Array.isArray(item.content)) {
        for (const c of item.content) {
          if (c?.type === "output_text" && c.text) text += c.text;
        }
      } else if (item?.type === "function_call") {
        toolCalls.push({
          id: item.call_id || item.id || `call_${toolCalls.length}`,
          type: "function",
          function: { name: item.name || "", arguments: item.arguments || "{}" },
        });
      }
    }
    // 聚合字段兜底 (output[] 缺 message 内容时, 如某些网关只回 output_text)
    if (!text && typeof data?.output_text === "string") text = data.output_text;
    if (!text && !toolCalls.length) return null;
    return {
      message: {
        role: "assistant",
        content: text || null,
        tool_calls: toolCalls.length ? toolCalls : null,
      },
      usage: normUsage(data?.usage),
    };
  },
  createStreamAcc() {
    let content = "";
    let reasoning = "";
    let streamedAny = false;
    let usage = null;
    let failed = null;
    const calls = new Map(); // item_id -> {call_id, name, args}
    const order = []; // item_id 出现顺序
    return {
      feed(j, cb = {}) {
        const type = j?.type || "";
        if (type === "response.output_text.delta" && j.delta) {
          content += j.delta;
          streamedAny = true;
          if (cb.onDelta) { try { cb.onDelta(j.delta, { kind: "text" }); } catch (e) { noteCatch(e); } }
        } else if ((type === "response.reasoning_summary_text.delta" || type === "response.reasoning_text.delta") && j.delta) {
          reasoning += j.delta;
          if (cb.onReasoning) { try { cb.onReasoning(j.delta, { kind: "reasoning" }); } catch (e) { noteCatch(e); } }
        } else if (type === "response.output_item.added" && j.item?.type === "function_call") {
          const key = j.item.id || j.item.call_id || `c${calls.size}`;
          if (!calls.has(key)) { calls.set(key, { call_id: j.item.call_id || j.item.id || key, name: j.item.name || "", args: "" }); order.push(key); }
          else { const c = calls.get(key); if (j.item.name) c.name = j.item.name; if (j.item.call_id) c.call_id = j.item.call_id; }
        } else if (type === "response.function_call_arguments.delta" && j.delta) {
          const key = j.item_id || "";
          const c = calls.get(key);
          if (c) c.args += j.delta;
        } else if (type === "response.function_call_arguments.done" && j.item_id) {
          const c = calls.get(j.item_id);
          if (c && typeof j.arguments === "string") c.args = j.arguments;
        } else if (type === "response.completed" || type === "response.incomplete") {
          if (j.response?.usage) usage = normUsage(j.response.usage);
        } else if (type === "response.failed" || type === "error") {
          failed = j.response?.error || j.error || { message: "Responses 流失败" };
        }
      },
      result() {
        if (failed) {
          const e = new Error(`LLM Responses 流失败: ${failed.message || JSON.stringify(failed).slice(0, 200)}`);
          e.status = failed.code === "rate_limit_exceeded" ? 429 : undefined;
          throw e;
        }
        const toolCalls = order.length
          ? order.map((key, i) => {
            const c = calls.get(key);
            return {
              id: c.call_id || key || `call_stream_${i}`,
              type: "function",
              function: { name: c.name, arguments: c.args || "{}" },
            };
          })
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
    return openaiCompletions.parseModels(data);
  },
};

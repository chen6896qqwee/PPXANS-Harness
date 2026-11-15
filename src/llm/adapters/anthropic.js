// src/llm/adapters/anthropic.js - Anthropic Messages 适配器 (原生 /v1/messages)
//
// 差异点: system 与 messages 分离、content blocks、tool_use/tool_result 块、x-api-key 鉴权、
// extended thinking 预算档位 (budget_tokens 必须 < max_tokens)。
import { noteCatch } from "../../utils/catch-log.js";
import { normUsage, parseImageSource, safeJsonParse } from "./wire.js";

// 内部 wire 消息 -> Anthropic {system, messages[]} (content blocks + tool_use/tool_result)
export function toAnthropicMessages(messages) {
  let system = "";
  const merged = []; // {role, blocks[]}
  const push = (role, blocks) => {
    const last = merged[merged.length - 1];
    if (last && last.role === role) last.blocks.push(...blocks); // 连续同角色合并 (Anthropic 要求交替)
    else merged.push({ role, blocks });
  };
  for (const m of messages) {
    if (!m || typeof m !== "object") continue;
    if (m.role === "system") {
      system += (system ? "\n\n" : "") + (typeof m.content === "string" ? m.content : "");
      continue;
    }
    if (m.role === "tool") {
      // 工具结果 -> user 消息里的 tool_result 块
      const parts = [];
      if (typeof m.content === "string") parts.push({ type: "text", text: m.content });
      else if (Array.isArray(m.content)) {
        for (const c of m.content) {
          if (c?.type === "text" && c.text) parts.push({ type: "text", text: c.text });
          else if (c?.type === "image_url") {
            const src = parseImageSource(c.image_url?.url);
            if (src?.kind === "base64") parts.push({ type: "image", source: { type: "base64", media_type: src.media_type, data: src.data } });
            else if (src?.kind === "url") parts.push({ type: "image", source: { type: "url", url: src.url } });
          }
        }
      }
      push("user", [{ type: "tool_result", tool_use_id: m.tool_call_id || "", content: parts.length === 1 && parts[0].type === "text" ? parts[0].text : parts }]);
      continue;
    }
    const blocks = [];
    if (typeof m.content === "string" && m.content) blocks.push({ type: "text", text: m.content });
    else if (Array.isArray(m.content)) {
      for (const c of m.content) {
        if (c?.type === "text" && c.text) blocks.push({ type: "text", text: c.text });
        else if (c?.type === "image_url") {
          const src = parseImageSource(c.image_url?.url);
          if (src?.kind === "base64") blocks.push({ type: "image", source: { type: "base64", media_type: src.media_type, data: src.data } });
          else if (src?.kind === "url") blocks.push({ type: "image", source: { type: "url", url: src.url } });
        }
      }
    }
    if (Array.isArray(m.tool_calls)) {
      for (const tc of m.tool_calls) {
        blocks.push({
          type: "tool_use",
          id: tc.id || `toolu_${blocks.length}`,
          name: tc.function?.name || "",
          input: safeJsonParse(tc.function?.arguments || "{}", {}),
        });
      }
    }
    if (blocks.length) push(m.role === "assistant" ? "assistant" : "user", blocks);
  }
  // Anthropic 要求首条为 user; 极端场景 (裁剪后 assistant 开头) 垫一条最小 user 消息
  if (merged.length && merged[0].role === "assistant") {
    merged.unshift({ role: "user", blocks: [{ type: "text", text: "(继续)" }] });
  }
  return { system: system || null, messages: merged.map((x) => ({ role: x.role, content: x.blocks })) };
}

// thinking 预算档位 (budget_tokens 必须 < max_tokens)
const ANTHROPIC_THINKING_BUDGET = { low: 2048, medium: 8192, high: 16384, max: 32768 };

export const anthropicMessages = {
  id: "anthropic-messages",
  endpoint() { return "/messages"; },
  headers(apiKey) {
    return {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    };
  },
  buildBody({ model, messages, tools, temperature, maxTokens, stream, reasoning, extraBody }) {
    // eslint 2026-11-01 抓到的真 bug: 此前 body 用了未转换的原始 wire messages (转换结果被弃用),
    // anthropic 线上请求会带着 OpenAI 形态的 messages 出户 —— 必须用转换后的 blocks 形态。
    const converted = toAnthropicMessages(messages);
    const max = Math.max(1, Math.floor(maxTokens || 4096));
    const body = { model, messages: converted.messages, max_tokens: max };
    if (converted.system) body.system = converted.system;
    if (tools?.length) {
      body.tools = tools.map((t) => (t?.type === "function" && t.function) ? {
        name: t.function.name,
        description: t.function.description || "",
        input_schema: t.function.parameters || { type: "object", properties: {} },
      } : t).filter((t) => t && t.name);
      body.tool_choice = { type: "auto" };
    }
    // 思考: off/auto 不发; 显式档位开 extended thinking (预算 < max_tokens; 开思考时不发 temperature —
    // Anthropic 规定 thinking 下 temperature 必须 1, 缺省即 1)
    const budget = ANTHROPIC_THINKING_BUDGET[reasoning];
    if (budget && budget < max) {
      body.thinking = { type: "enabled", budget_tokens: budget };
    } else if (Number.isFinite(temperature)) {
      body.temperature = Math.max(0, Math.min(1, temperature)); // Anthropic 温度域 0-1
    }
    if (stream) body.stream = true;
    return { ...body, ...(extraBody || {}) };
  },
  parseResponse(data) {
    const content = Array.isArray(data?.content) ? data.content : [];
    let text = "";
    let reasoningContent = "";
    const toolCalls = [];
    for (const b of content) {
      if (b?.type === "text" && b.text) text += b.text;
      else if (b?.type === "thinking" && b.thinking) reasoningContent += b.thinking;
      else if (b?.type === "tool_use") {
        toolCalls.push({
          id: b.id || `call_${toolCalls.length}`,
          type: "function",
          function: { name: b.name || "", arguments: JSON.stringify(b.input ?? {}) },
        });
      }
    }
    // reasoning-only 响应 (thinking 吃满输出预算) 不可判 null: client 层有 "[思考]" 降级兜底,
    //   这里丢掉会让 anthropic 协议直接抛"空内容"触发无谓的 provider 回退 (completions 不会)。
    if (!text && !toolCalls.length && !reasoningContent) return null;
    return {
      message: {
        role: "assistant",
        content: text || null,
        tool_calls: toolCalls.length ? toolCalls : null,
        reasoning_content: reasoningContent || null,
      },
      usage: normUsage(data?.usage),
    };
  },
  createStreamAcc() {
    let content = "";
    let reasoning = "";
    let streamedAny = false;
    let failed = null;
    // usage 分开记 (message_start 给 input / message_delta 给 output; 合并渲染防 0 覆盖)
    let inTok = null;
    let outTok = null;
    const blocks = new Map(); // index -> {type, id, name, args}
    return {
      feed(j, cb = {}) {
        const type = j?.type || "";
        if (type === "message_start" && j.message?.usage) {
          inTok = Number(j.message.usage.input_tokens) || inTok;
        } else if (type === "content_block_start") {
          const i = Number(j.index ?? 0);
          const b = j.content_block || {};
          blocks.set(i, { type: b.type, id: b.id || "", name: b.name || "", args: "" });
        } else if (type === "content_block_delta") {
          const i = Number(j.index ?? 0);
          const d = j.delta || {};
          if (d.type === "text_delta" && d.text) {
            content += d.text;
            streamedAny = true;
            if (cb.onDelta) { try { cb.onDelta(d.text, { kind: "text" }); } catch (e) { noteCatch(e); } }
          } else if (d.type === "thinking_delta" && d.thinking) {
            reasoning += d.thinking;
            if (cb.onReasoning) { try { cb.onReasoning(d.thinking, { kind: "reasoning" }); } catch (e) { noteCatch(e); } }
          } else if (d.type === "input_json_delta" && d.partial_json) {
            const b = blocks.get(i);
            if (b) b.args += d.partial_json;
          }
        } else if (type === "message_delta") {
          if (j.usage?.output_tokens != null) outTok = Number(j.usage.output_tokens) || outTok;
        } else if (type === "message_stop") {
          // 流结束
        } else if (type === "error") {
          failed = j.error || { message: "Anthropic 流失败" };
        }
      },
      result() {
        if (failed) {
          const e = new Error(`LLM Anthropic 流失败: ${failed.message || JSON.stringify(failed).slice(0, 200)}`);
          e.status = failed.type === "rate_limit_error" ? 429 : (failed.type === "authentication_error" ? 401 : undefined);
          throw e;
        }
        const toolCalls = [];
        for (const [, b] of [...blocks.entries()].sort((a, c) => a[0] - c[0])) {
          if (b.type === "tool_use") {
            toolCalls.push({
              id: b.id || `call_stream_${toolCalls.length}`,
              type: "function",
              function: { name: b.name, arguments: b.args || "{}" },
            });
          }
        }
        const usage = (inTok != null || outTok != null)
          ? normUsage({ prompt_tokens: inTok ?? 0, completion_tokens: outTok ?? 0 })
          : null;
        return {
          message: { role: "assistant", content: content || null, tool_calls: toolCalls.length ? toolCalls : null },
          usage,
          streamed: streamedAny,
          reasoning: reasoning || null,
        };
      },
    };
  },
  modelsUrl(baseUrl) { return `${baseUrl}/models`; },
  parseModels(data) {
    return (Array.isArray(data?.data) ? data.data : [])
      .map((m) => ({ id: m?.id || "", label: m?.display_name || "" }))
      .filter((m) => m.id);
  },
};

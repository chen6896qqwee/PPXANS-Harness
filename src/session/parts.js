// src/session/parts.js - 结构化消息部件 (opencode 风格)
// 每个部件: { id, type, ...字段, ts }; id 用 crypto.randomUUID()
//  - part.*        部件工厂
//  - parts.*       含工厂 + fromResponseItems + estimateTokens
import { randomUUID } from "node:crypto";

function _base(type, extra) {
  return { id: randomUUID(), type, ts: Date.now(), ...extra };
}

// 部件工厂
export const part = {
  text(text) {
    return _base("text", { text });
  },
  file({ path: p, content }) {
    return _base("file", { path: p, content });
  },
  image({ url }) {
    return _base("image", { url });
  },
  agent({ name, color }) {
    return _base("agent", { name, color });
  },
  reasoning(text) {
    return _base("reasoning", { text });
  },
  tool({ call, output }) {
    return _base("tool", { call, output });
  },
};

// 把 ResponseItem 数组映射为部件数组 (对齐 codex ResponseItem 形态)
export function fromResponseItems(items = []) {
  const out = [];
  for (const it of items) {
    if (!it || !it.type) continue;
    switch (it.type) {
      case "message":
        out.push(part.text(it.content ?? ""));
        break;
      case "reasoning":
        out.push(part.reasoning(it.text ?? ""));
        break;
      case "function_call":
        out.push(part.tool({ call: { name: it.name, arguments: it.arguments }, output: null }));
        break;
      case "function_call_output":
        out.push(part.tool({ call: null, output: it.output }));
        break;
      default:
        // 未知类型: 兜底为文本部件, 不丢信息
        out.push(part.text(JSON.stringify(it)));
    }
  }
  return out;
}

// 粗估 token 数: 中文每字约 1.6 字符/token, 其它非空白字符约 3.5 字符/token, 分段累加后向上取整
export function estimateTokens(text) {
  if (!text) return 0;
  const s = String(text);
  let cn = 0, other = 0;
  for (const ch of s) {
    if (/[㐀-䶿一-鿿]/.test(ch)) cn++;          // CJK 基本区 + 扩展A
    else if (!/\s/.test(ch)) other++;
  }
  return Math.ceil(cn / 1.6 + other / 3.5);
}

// 对外命名空间: 含全部工厂 + 转换/估算能力
export const parts = {
  ...part,
  fromResponseItems,
  estimateTokens,
};

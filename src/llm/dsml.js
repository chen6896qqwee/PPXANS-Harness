// src/llm/dsml.js - DSML (DeepSeek Markup Language) 工具调用解析/构造
// 吸收自 DeepSeek V4 Flash 官方工具调用格式 (encoding/encoding_dsv4):
//   工具块: <｜DSML｜tool_calls> ... </｜DSML｜tool_calls>
//   单调用: <｜DSML｜invoke name="工具名"> ... </｜DSML｜invoke>
//   参数:   <｜DSML｜parameter name="名" string="true|false">值</｜DSML｜parameter>
//   (string="true" 为字符串, string="false" 为 JSON 字面量)
//   思考:   <think>推理过程</think>  (DeepSeek V4 双模式)
// 用途: 让皮皮虾能驱动"原生 DSML 文本模型"(如本地 DeepSeek V4 Flash via vLLM/ds4),
//   与自定义围栏 ⟪tool⟫ 互补 —— DSML 是官方训练格式, 模型更容易稳定输出。

const PIPE = "\uFF5C"; // ｜ 全角竖线

// 解析 DSML 工具调用: 提取 calls + thinking + 剥离后的 clean 文本
export function parseDsml(text) {
  const s = String(text || "");
  const calls = [];

  // 思考内容 <think>...</think>
  let thinking = "";
  const thinkM = s.match(/<think>([\s\S]*?)<\/think>/);
  if (thinkM) thinking = thinkM[1].trim();

  // 单个 invoke 块: <｜DSML｜invoke name="X"> ... </｜DSML｜invoke>
  const invokeRe = new RegExp(`<${PIPE}DSML${PIPE}invoke name="([^"]+)"[^>]*>([\\s\\S]*?)</${PIPE}DSML${PIPE}invoke>`, "g");
  let m;
  while ((m = invokeRe.exec(s)) !== null) {
    const name = m[1];
    const body = m[2];
    const args = {};
    // parameter: <｜DSML｜parameter name="X" string="bool">值</｜DSML｜parameter>
    const paramRe = new RegExp(`<${PIPE}DSML${PIPE}parameter name="([^"]+)" string="(true|false)">([\\s\\S]*?)</${PIPE}DSML${PIPE}parameter>`, "g");
    let pm;
    while ((pm = paramRe.exec(body)) !== null) {
      const pname = pm[1];
      const isString = pm[2] === "true";
      const raw = pm[3].trim();
      if (isString) args[pname] = raw;
      else { try { args[pname] = JSON.parse(raw); } catch { args[pname] = raw; } }
    }
    calls.push({ name, args });
  }

  // clean: 去掉 think + tool_calls 块
  const clean = s
    .replace(/<think>[\s\S]*?<\/think>/g, "")
    .replace(new RegExp(`<${PIPE}DSML${PIPE}tool_calls>[\\s\\S]*?</${PIPE}DSML${PIPE}tool_calls>`, "g"), "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  return { calls, thinking, clean };
}

// 构造 DSML 工具调用说明 (注入给原生文本模型)
// v1.0.9: 工具描述转义协议字符 (防恶意描述伪造 DSML 块); 参数值含字面 </｜DSML｜parameter> 会被截断属文本协议固有局限
// v1.1.1: 每条工具描述截断到 MAX_TOOL_DESC_CHARS, 小窗口下防工具描述体量膨胀 (不裁剪工具名)
export const MAX_TOOL_DESC_CHARS = 240;
export function buildDsmlPrompt(tools) {
  const lines = (tools || []).map((t) => {
    const fn = t.function || t;
    const rawDesc = String(fn.description || "(无描述)").replace(/[＜＞｜<>\|]/g, "");
    const desc = rawDesc.length > MAX_TOOL_DESC_CHARS ? rawDesc.slice(0, MAX_TOOL_DESC_CHARS) + "…" : rawDesc;
    return `- ${fn.name}: ${desc}`;
  }).join("\n");
  return [
    "[工具协议] 需要调用工具时, 用 DSML 格式输出 (不要假装执行):",
    `工具块: <${PIPE}DSML${PIPE}tool_calls> ... </${PIPE}DSML${PIPE}tool_calls>`,
    `单调用: <${PIPE}DSML${PIPE}invoke name="工具名"> ... </${PIPE}DSML${PIPE}invoke>`,
    `字符串参数: <${PIPE}DSML${PIPE}parameter name="名" string="true">值</${PIPE}DSML${PIPE}parameter>`,
    `其他参数(数字/JSON): <${PIPE}DSML${PIPE}parameter name="名" string="false">值</${PIPE}DSML${PIPE}parameter>`,
    "工具结果会以 <tool_result> 形式回填, 收到后继续推理, 直到输出最终回复。",
    "可用工具:",
    lines || "(无)",
  ].join("\n");
}

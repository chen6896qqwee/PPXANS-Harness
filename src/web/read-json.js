// src/web/read-json.js - Web API 请求体 JSON 读取单源
//
// 2026-11-03 重复消除: mcp-api / plugin-api / skills-api 此前各持一份逐字相同的 readJson
// (读体 → 400 非法 JSON → null)。三个 API 域共用同一 channel 协议 (_readBody/_json),
// 错误响应的形状也必须一致 —— 收口一份, 改错误文案/状态码时不会再漏 API 域。
export async function readJson(channel, req, res) {
  const raw = await channel._readBody(req, res);
  if (raw === null) return null;
  try { return JSON.parse(raw || "{}"); } catch {
    channel._json(res, 400, { ok: false, error: "非法 JSON" });
    return null;
  }
}

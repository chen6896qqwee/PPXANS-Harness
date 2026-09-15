// web/src/lib/mcp.ts - 皮皮虾 MCP 客户端 (零依赖, 浏览器 JSON-RPC over Streamable HTTP)
// 所有管理操作走标准 MCP 协议 (POST /mcp), 不再依赖 REST /api/*。
// 协议: 2026-07-28 (现代 era, 每请求 _meta 携带版本/身份/能力)
import { getApiBase, getAuthToken } from "./api";

const PROTOCOL_VERSION = "2026-07-28";
let nextId = 1;

export class McpError extends Error {
  code: number;
  data?: unknown;
  constructor(code: number, message: string, data?: unknown) {
    super(message);
    this.code = code;
    this.data = data;
  }
}

// 单次 JSON-RPC 请求
export async function mcpCall<T = any>(method: string, params: Record<string, unknown> = {}): Promise<T> {
  const base = getApiBase();
  const tok = getAuthToken();
  const id = nextId++;
  const body = {
    jsonrpc: "2.0",
    id,
    method,
    params: {
      ...params,
      _meta: {
        "io.modelcontextprotocol/protocolVersion": PROTOCOL_VERSION,
        "io.modelcontextprotocol/clientInfo": { name: "ppx-web", version: "2.6.0" },
        "io.modelcontextprotocol/clientCapabilities": {},
      },
    },
  };
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "Accept": "application/json, text/event-stream",
    "MCP-Protocol-Version": PROTOCOL_VERSION,
  };
  if (tok) headers["Authorization"] = `Bearer ${tok}`;
  let r: Response;
  try {
    r = await fetch(base + "/mcp", { method: "POST", headers, body: JSON.stringify(body) });
  } catch (e) {
    throw new Error(`无法连接后端 (${base}/mcp): 请确认服务已启动。(${(e as Error).message})`);
  }
  const j = await r.json().catch(() => null);
  if (j?.error) {
    if (r.status === 401) {
      throw new Error("鉴权失败 (401): 后端已更换 token, 请在浏览器控制台执行 localStorage.setItem('ppx_auth_token', '<新token>') (token 见后端启动日志)。");
    }
    throw new McpError(j.error.code, j.error.message, j.error.data);
  }
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return (j?.result ?? null) as T;
}

// ---- 工具调用快捷封装 (admin 虚拟工具返回 {content:[{type:"text",text}]}) ----
export function toolResultText<T = any>(result: any): T {
  if (result == null) return null as T;
  if (Array.isArray(result.content)) {
    const text = result.content
      .filter((c: any) => c?.type === "text" && typeof c.text === "string")
      .map((c: any) => c.text)
      .join("\n");
    if (text) {
      try { return JSON.parse(text) as T; } catch { return text as unknown as T; }
    }
  }
  return result as T;
}

export async function mcpTool<T = any>(name: string, args: Record<string, unknown> = {}): Promise<T> {
  const r = await mcpCall<any>("tools/call", { name, arguments: args });
  return toolResultText<T>(r);
}

// ---- 资源读取 ----
export async function mcpResource(uri: string): Promise<any> {
  const r = await mcpCall<any>("resources/read", { uri });
  const contents = r?.contents || [];
  const text = contents
    .filter((c: any) => c?.type === "text" || typeof c.text === "string")
    .map((c: any) => c.text)
    .join("\n");
  if (!text) return null;
  try { return JSON.parse(text); } catch { return text; }
}

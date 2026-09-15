// web/src/lib/api.ts - 皮皮虾 API 客户端
// 数据函数 (providers/settings) v2.6.0 起全部走标准 MCP 协议 (POST /mcp), 不再依赖 REST /api/*。
// 函数签名保持不变 (settings 各页面零改动)。/health 健康检查仍走 REST (该端点保留)。
// 鉴权: 优先用 localStorage 里的 token (用户从控制台日志复制粘贴);

const DEFAULT_BASE = "http://127.0.0.1:8899";

export function getApiBase(): string {
  if (typeof window !== "undefined") {
    const w = window as unknown as { __PPX_API_BASE__?: string };
    if (w.__PPX_API_BASE__) return w.__PPX_API_BASE__;
  }
  return DEFAULT_BASE;
}

export function getAuthToken(): string {
  if (typeof window === "undefined") return "";
  return localStorage.getItem("ppx_auth_token") || "";
}

export function setAuthToken(t: string) {
  if (typeof window === "undefined") return;
  if (t) localStorage.setItem("ppx_auth_token", t);
  else localStorage.removeItem("ppx_auth_token");
}

// ---- 健康检查 (REST, /health 端点保留) ----
export async function pingHealth(): Promise<{ status: string; agent: string }> {
  const base = getApiBase();
  const tok = getAuthToken();
  const headers: Record<string, string> = {};
  if (tok) headers["Authorization"] = `Bearer ${tok}`;
  const r = await fetch(base + "/health", { headers });
  return r.json();
}

// ---- MCP JSON-RPC 内联调用 (避免与 lib/mcp.ts 循环依赖) ----
const PROTOCOL_VERSION = "2026-07-28";
let _nextId = 1;
async function mcpCall<T = any>(method: string, params: Record<string, unknown> = {}): Promise<T> {
  const base = getApiBase();
  const tok = getAuthToken();
  const body = {
    jsonrpc: "2.0",
    id: _nextId++,
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
    throw new Error(j.error.message || `MCP 错误 ${j.error.code}`);
  }
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return (j?.result ?? null) as T;
}

// 工具调用: 提取 {content:[{type:text}]} 里的 JSON 文本
function toolResult<T = any>(result: any): T {
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
async function mcpTool<T = any>(name: string, args: Record<string, unknown> = {}): Promise<T> {
  return toolResult<T>(await mcpCall<any>("tools/call", { name, arguments: args }));
}

// ---- 提供方类型 ----
export type Provider = {
  id: string;
  backend?: string;
  base_url?: string;
  model?: string;
  vision?: boolean;
  timeout_ms?: number;
  api_key?: string;
  api_key_env?: string;
  api_key_set?: boolean;
  mjs?: string;
  session_key?: string;
  dsh_root?: string;
};

export type ProvidersResponse = {
  providers: Provider[];
  default_id: string | null;
};

export async function listProviders(): Promise<ProvidersResponse> {
  return mcpTool<ProvidersResponse>("ppx.providers.list");
}

export async function addProvider(provider: Partial<Provider>): Promise<{ ok: boolean; provider: Provider }> {
  return mcpTool("ppx.providers.add", { provider });
}

export async function updateProvider(id: string, patch: Partial<Provider>): Promise<{ ok: boolean; provider: Provider }> {
  return mcpTool("ppx.providers.update", { id, patch });
}

export async function deleteProvider(id: string): Promise<{ ok: boolean; provider: Provider }> {
  return mcpTool("ppx.providers.delete", { id });
}

export async function testProvider(id: string): Promise<{ ok: boolean; healthy: boolean; detail: string; source: string }> {
  return mcpTool("ppx.providers.test", { id });
}

export async function reorderProviders(order: string[]): Promise<{ ok: boolean; providers: Provider[] }> {
  return mcpTool("ppx.providers.reorder", { order });
}

// ---- 通用设置 ----
export type McpServerConfig = {
  name?: string;
  command?: string;
  args?: string[];
  env_set?: boolean;
  prefix?: string;
  url?: string;
  headers_set?: boolean;
  timeout?: number;
};

export type AppSettings = {
  user: { name: string };
  http: { port: number; auth_token_set: boolean };
  security: { allow_all: boolean; command_timeout_ms: number; code_act: boolean };
  agent: {
    name: string;
    mode: string;
    citation_rule: string;
    system_extra: string;
    values: string[];
  };
  mcp: { auto_connect: boolean; servers: McpServerConfig[] };
  tools: { disabled: string[] };
};

export type SettingsPatch = {
  user?: Partial<AppSettings["user"]>;
  http?: Partial<Omit<AppSettings["http"], "auth_token_set">> & { auth_token?: string };
  security?: Partial<AppSettings["security"]>;
  agent?: Partial<AppSettings["agent"]>;
  mcp?: Partial<AppSettings["mcp"]>;
  tools?: Partial<AppSettings["tools"]>;
};

export async function getSettings(): Promise<{ settings: AppSettings }> {
  return mcpTool("ppx.settings.get");
}

export async function saveSettings(patch: SettingsPatch): Promise<{ ok: boolean; settings: AppSettings }> {
  return mcpTool("ppx.settings.update", { patch });
}

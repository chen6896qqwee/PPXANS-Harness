// web/src/lib/api.ts - 皮皮虾 HTTP API 客户端
// 所有请求经 /api/*; 默认端口 8899 (可在 .env 改 PPX_API_BASE)
// 鉴权: 优先用 localStorage 里的 token (用户从控制台日志复制粘贴);
//       未设置则不发送 Authorization 头 (后端默认 auth_token="" 时无需鉴权)

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

async function request<T>(path: string, opts: RequestInit = {}): Promise<T> {
  const base = getApiBase();
  const headers: Record<string, string> = { "Content-Type": "application/json", ...(opts.headers as Record<string, string>) };
  const tok = getAuthToken();
  if (tok) headers["Authorization"] = `Bearer ${tok}`;
  let r: Response;
  try {
    r = await fetch(base + path, { ...opts, headers });
  } catch (e) {
    // v1.0.9: 网络异常给可读提示 (原抛裸 TypeError)
    throw new Error(`无法连接后端 (${base}): 请确认服务已启动。(${(e as Error).message})`);
  }
  const text = await r.text();
  let data: unknown = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  if (!r.ok) {
    // v1.0.9: 401 明确提示重新设置 token (后端每次重启生成新随机 token, localStorage 旧 token 会失效)
    if (r.status === 401) {
      throw new Error("鉴权失败 (401): 后端已更换 token, 请在浏览器控制台执行 localStorage.setItem('ppx_auth_token', '<新token>') (token 见后端启动日志)。");
    }
    const msg = (data && typeof data === "object" && "error" in data) ? String((data as { error: unknown }).error) : `HTTP ${r.status}`;
    throw new Error(msg);
  }
  return data as T;
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
  return request<ProvidersResponse>("/api/providers");
}

export async function addProvider(provider: Partial<Provider>): Promise<{ ok: boolean; provider: Provider }> {
  return request("/api/providers", { method: "POST", body: JSON.stringify({ provider }) });
}

export async function updateProvider(id: string, patch: Partial<Provider>): Promise<{ ok: boolean; provider: Provider }> {
  return request("/api/providers", { method: "PUT", body: JSON.stringify({ id, patch }) });
}

export async function deleteProvider(id: string): Promise<{ ok: boolean; provider: Provider }> {
  return request("/api/providers", { method: "DELETE", body: JSON.stringify({ id }) });
}

export async function testProvider(id: string): Promise<{ ok: boolean; healthy: boolean; detail: string; source: string }> {
  return request("/api/providers/test", { method: "POST", body: JSON.stringify({ id }) });
}

export async function reorderProviders(order: string[]): Promise<{ ok: boolean; providers: Provider[] }> {
  return request("/api/providers/reorder", { method: "POST", body: JSON.stringify({ order }) });
}

// ---- 健康检查 ----
export async function pingHealth(): Promise<{ status: string; agent: string }> {
  return request("/health");
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
  return request("/api/settings");
}

export async function saveSettings(patch: SettingsPatch): Promise<{ ok: boolean; settings: AppSettings }> {
  return request("/api/settings", { method: "PUT", body: JSON.stringify({ patch }) });
}
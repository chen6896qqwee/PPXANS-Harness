// src/web/mcp-api.js - MCP 服务器管理 Web 接口 (2026-11-03)
//
// 为什么不复用 PUT /api/settings：通用设置的安全视图会把 headers/env 抹成 "已设置" 标志。
// 管理页若照抄 GET 结果再 PUT 回去，密钥会被标志覆盖、trusted 也会丢。这里改成
// "按服务器增量改"：没提交的字段保持磁盘原值，显式 null 才清除。
//
// 端点:
//   GET    /api/mcp/servers          列表 (敏感值只回 set 标志) + 上次连接状态
//   POST   /api/mcp/servers          新增或更新 (body: { server, index? })
//   DELETE /api/mcp/servers?name=    删除 (也支持 ?index=)
//   POST   /api/mcp/reconnect        按最新配置断开重连 (不重启进程)
import { readConfigRaw, updateSettings } from "../config/settings.js";
import { serverLabel } from "../mcp/index.js";
import { readJson } from "./read-json.js";

const FIELDS = ["command", "args", "env", "prefix", "url", "headers", "timeout", "name", "trusted"];
const MAX_SERVERS = 50;

function str(v, max = 500) {
  return String(v == null ? "" : v).trim().slice(0, max);
}

function normMap(raw, what) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error(`${what} 必须是对象`);
  const out = {};
  for (const [k, v] of Object.entries(raw)) {
    if (typeof v !== "string") throw new Error(`${what}.${k} 必须是字符串`);
    if (!k.trim()) continue;
    out[str(k, 80)] = String(v);
  }
  if (Object.keys(out).length > 32) throw new Error(`${what} 最多 32 项`);
  return out;
}

function validate(s) {
  if (!s || typeof s !== "object" || Array.isArray(s)) throw new Error("server 必须是对象");
  if (s.command != null && typeof s.command !== "string") throw new Error("command 必须是字符串");
  if (s.url != null && typeof s.url !== "string") throw new Error("url 必须是字符串");
  if (!str(s.command) && !str(s.url)) throw new Error("MCP 服务器至少需要 command(stdio) 或 url(http)");
  if (str(s.url) && !/^https?:\/\//i.test(str(s.url))) throw new Error("url 必须以 http(s):// 开头");
  if (s.args != null) {
    if (!Array.isArray(s.args) || s.args.some((a) => typeof a !== "string")) throw new Error("args 必须是字符串数组");
    if (s.args.length > 32) throw new Error("args 最多 32 项");
  }
  if (s.timeout != null) {
    const t = Number(s.timeout);
    if (!Number.isFinite(t) || t <= 0 || t > 600000) throw new Error("timeout 需在 1-600000ms 之间");
  }
  if (s.trusted != null && typeof s.trusted !== "boolean") throw new Error("trusted 必须是布尔值");
  if (s.prefix != null && typeof s.prefix !== "string") throw new Error("prefix 必须是字符串");
  if (s.prefix != null && str(s.prefix).length > 64) throw new Error("prefix 最多 64 字符");
  if (s.name != null && typeof s.name !== "string") throw new Error("name 必须是字符串");
}

// 已有配置 + 本次提交 → 新配置。未提交字段保持原值 (尤其 headers/env 的密钥);
//   显式 null = 清除该字段 (让管理页能删掉旧密钥)。
function mergeServer(existing, patch) {
  const out = {};
  if (existing) for (const k of FIELDS) if (existing[k] !== undefined) out[k] = existing[k];
  for (const k of FIELDS) {
    if (patch[k] === undefined) continue;
    if (patch[k] === null) delete out[k];
    else out[k] = patch[k];
  }
  out.command = str(out.command);
  if (!out.command) delete out.command;
  out.url = str(out.url);
  if (!out.url) delete out.url;
  if (out.args != null) out.args = out.args.map((a) => String(a));
  if (out.timeout != null) out.timeout = Math.floor(Number(out.timeout));
  if (out.headers != null) out.headers = normMap(out.headers, "headers");
  if (out.env != null) out.env = normMap(out.env, "env");
  if (out.prefix != null) out.prefix = String(out.prefix).slice(0, 64);
  out.name = str(out.name, 64) || serverLabel(out);
  if (out.trusted != null) out.trusted = out.trusted === true;
  validate(out);
  return out;
}

// 安全视图: 命令/URL/开关可回显, 密钥只回"已设置"
function publicServer(s, status, toolCount) {
  const out = {
    name: str(s.name, 64) || serverLabel(s),
    transport: s.url ? "http" : "stdio",
    command: s.command || "",
    url: s.url || "",
    args: Array.isArray(s.args) ? s.args : [],
    prefix: s.prefix == null ? null : s.prefix,
    timeout: s.timeout == null ? null : Number(s.timeout),
    trusted: s.trusted === true,
    headers_set: !!(s.headers && Object.keys(s.headers).length),
    env_set: !!(s.env && Object.keys(s.env).length),
    status: status
      ? { connected: status.ok === true, tools: Number(status.tools) || 0, error: status.error || null }
      : { connected: false, tools: 0, error: null },
    tools: toolCount,
  };
  return out;
}

function configuredServers(channel) {
  const raw = readConfigRaw(channel.agent.root);
  const list = Array.isArray(raw.mcp?.servers) ? raw.mcp.servers : [];
  return list.filter((s) => s && typeof s === "object");
}

function mcpToolNames(channel, s) {
  const label = serverLabel(s);
  const ns = s.prefix != null ? s.prefix : `${label}__`;
  try {
    return (channel.agent.tools.listDetailed() || [])
      .filter((t) => t.category === "mcp" && t.name.startsWith(ns))
      .map((t) => t.name);
  } catch { return []; }
}

function listServers(channel) {
  const servers = configuredServers(channel);
  const statuses = Array.isArray(channel.agent._mcpStatus) ? channel.agent._mcpStatus : [];
  return servers.map((s) => {
    const label = serverLabel(s);
    const st = statuses.find((x) => x && x.name === label) || null;
    return publicServer(s, st, mcpToolNames(channel, s).length);
  });
}

function summary(channel) {
  const servers = listServers(channel);
  return {
    ok: true,
    servers,
    total: servers.length,
    connected: servers.filter((s) => s.status.connected).length,
    tools: servers.reduce((n, s) => n + s.tools, 0),
  };
}

function saveServers(channel, next) {
  if (next.length > MAX_SERVERS) throw new Error(`MCP 服务器最多 ${MAX_SERVERS} 个`);
  updateSettings(channel.agent.root, { mcp: { servers: next } });
}

function fail(channel, res, e) {
  channel._json(res, Number(e?.status) || 400, { ok: false, error: String(e?.message || e) });
}

function qsValue(req, key) {
  try {
    const u = new URL(req.url, "http://localhost");
    return u.searchParams.get(key);
  } catch { return null; }
}

async function reconnect(channel) {
  if (typeof channel.agent.reloadMcp !== "function") {
    const err = new Error("当前运行时不支持 MCP 热重连");
    err.status = 409;
    throw err;
  }
  const r = await channel.agent.reloadMcp();
  return { ok: true, count: r.count, servers: r.servers, status: r.status || [], ...summary(channel) };
}

export async function handleMcpApi(channel, req, res, reqPath) {
  const get = req.method === "GET";

  if (reqPath === "/api/mcp/servers") {
    if (get) {
      try { channel._json(res, 200, summary(channel), { "Cache-Control": "no-store" }); }
      catch (e) { fail(channel, res, e); }
      return true;
    }

    if (req.method === "POST") {
      const body = await readJson(channel, req, res);
      if (body === null) return true;
      try {
        const patch = body && body.server && typeof body.server === "object" ? body.server : body;
        const servers = configuredServers(channel);
        const wantName = str(patch.name, 64);
        const idx = Number.isInteger(body.index) && body.index >= 0 && body.index < servers.length ? body.index : -1;
        let at = idx;
        if (at < 0 && wantName) {
          at = servers.findIndex((s) => (str(s.name, 64) || serverLabel(s)).toLowerCase() === wantName.toLowerCase());
        }
        const existing = at >= 0 ? servers[at] : null;
        const next = mergeServer(existing, patch);
        const list = servers.slice();
        if (at >= 0) list[at] = next;
        else list.push(next);
        saveServers(channel, list);
        const re = await reconnect(channel);
        channel._json(res, existing ? 200 : 201, { ...re, message: existing ? `已更新 MCP 服务器: ${next.name}` : `已添加 MCP 服务器: ${next.name}` });
      } catch (e) { fail(channel, res, e); /* swallowed-ok(2026-11-03): 错误已由 fail 回给客户端 */ }
      return true;
    }

    if (req.method === "DELETE") {
      try {
        const servers = configuredServers(channel);
        const name = str(qsValue(req, "name"), 64);
        const idxRaw = qsValue(req, "index");
        const idx = idxRaw != null ? Number(idxRaw) : -1;
        let at = Number.isInteger(idx) && idx >= 0 && idx < servers.length ? idx : -1;
        if (at < 0 && name) {
          at = servers.findIndex((s) => (str(s.name, 64) || serverLabel(s)).toLowerCase() === name.toLowerCase());
        }
        if (at < 0) { const err = new Error("MCP 服务器不存在"); err.status = 404; throw err; }
        const [removed] = servers.splice(at, 1);
        saveServers(channel, servers);
        const re = await reconnect(channel);
        channel._json(res, 200, { ...re, removed: str(removed.name, 64) || serverLabel(removed), message: "已删除 MCP 服务器并重连" });
      } catch (e) { fail(channel, res, e); /* swallowed-ok(2026-11-03): 错误已由 fail 回给客户端 */ }
      return true;
    }
    return false;
  }

  if (req.method === "POST" && reqPath === "/api/mcp/reconnect") {
    try {
      const re = await reconnect(channel);
      channel._json(res, 200, { ...re, message: `已重连 ${re.connected}/${re.total} 个 MCP 服务器` });
    } catch (e) { fail(channel, res, e); }
    return true;
  }

  return false;
}

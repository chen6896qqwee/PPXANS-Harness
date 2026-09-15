// src/config/settings.js - 通用设置读写 (HTTP API 后端)
// 覆盖 config/ppx.json 顶层字段: user / channels.http / security / agent 预设 (values/system_extra/citation_rule/mode)
// 设计 (与 providers.js 对齐):
//   - 唯一事实源 = config/ppx.json
//   - 写盘: 备份原文件 → 原子写 (.tmp + rename) → 防配置丢失
//   - 读取: 深度合并默认值 (loadConfig), 保证前端总能拿到完整结构
//   - 热重载: 写盘后由调用方调 agent.reload() 重建内存
import fs from "node:fs";
import path from "node:path";
import { loadConfig, DEFAULT_CONFIG } from "./index.js";
import { withFileLock } from "../utils/store.js";
import { warn } from "../utils/logger.js";

function getConfigPath(root) {
  return path.join(root, "config", "ppx.json");
}

// 读取当前 config (磁盘原文), 缺文件返回空
export function readConfigRaw(root) {
  const p = getConfigPath(root);
  if (!fs.existsSync(p)) return {};
  try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch (e) { warn("config/ppx.json 读取失败:", e.message); return {}; }
}

// 写盘: 先备份 (保留最近 3 个), 再原子写 (tmp + rename)
function writeConfigAtomic(root, cfg) {
  const p = getConfigPath(root);
  if (fs.existsSync(p)) {
    const bak = p + ".bak-" + new Date().toISOString().replace(/[:.]/g, "-");
    try { fs.copyFileSync(p, bak); } catch (e) { warn("备份失败:", e.message); }
    try {
      const dir = path.dirname(p);
      const base = path.basename(p);
      const baks = fs.readdirSync(dir)
        .filter((f) => f.startsWith(base + ".bak-"))
        .map((f) => ({ f, t: fs.statSync(path.join(dir, f)).mtimeMs }));
      baks.sort((a, b) => b.t - a.t);
      for (const old of baks.slice(3)) {
        try { fs.unlinkSync(path.join(dir, old.f)); } catch {}
      }
    } catch {}
  }
  const tmp = p + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(cfg, null, 2), "utf8");
  fs.renameSync(tmp, p);
}

// 通用设置字段白名单 (GET 返回 + PUT 可改的顶层键)
// 每个键对应 config 里的一个可编辑分区, 值里的字段再细分
export const SETTINGS_FIELDS = {
  user: ["name"],
  http: ["port", "auth_token"],
  security: ["allow_all", "command_timeout_ms", "code_act"],
  agent: ["name", "mode", "citation_rule", "system_extra", "values"],
  mcp: ["servers", "auto_connect"],
  tools: ["disabled"],
};

// MCP 服务器字段白名单 (防注入任意字段)
export const MCP_SERVER_KEYS = ["command", "args", "env", "prefix", "url", "headers", "timeout", "name"];

// 安全视图: 抹掉敏感明文 (auth_token / api_key / mcp headers), 只暴露 set 标志
function sanitizeSettings(cfg) {
  const out = {
    user: { name: cfg.user?.name || "兄弟" },
    http: {
      port: cfg.channels?.http?.port ?? 8899,
      auth_token_set: !!(cfg.channels?.http?.auth_token),
    },
    security: {
      allow_all: !!cfg.security?.allow_all,
      command_timeout_ms: cfg.security?.command_timeout_ms ?? 30000,
      code_act: !!cfg.security?.code_act,
    },
    agent: {
      name: cfg.agent?.name || "皮皮虾",
      mode: cfg.agent?.mode || "react",
      citation_rule: cfg.agent?.citation_rule ?? "",
      system_extra: cfg.agent?.system_extra ?? "",
      values: Array.isArray(cfg.agent?.values) ? cfg.agent.values : (DEFAULT_CONFIG.agent?.values || []),
    },
    mcp: {
      auto_connect: !!cfg.mcp?.auto_connect,
      servers: Array.isArray(cfg.mcp?.servers) ? cfg.mcp.servers.map((s) => sanitizeMcpServer(s)) : [],
    },
    tools: {
      disabled: Array.isArray(cfg.tools?.disabled) ? cfg.tools.disabled : [],
    },
  };
  return out;
}

// MCP 服务器安全视图: 只暴露白名单字段, headers 抹掉明文只回 set 标志
function sanitizeMcpServer(s) {
  if (!s || typeof s !== "object") return {};
  const out = {};
  for (const k of MCP_SERVER_KEYS) {
    if (k === "headers") {
      if (s.headers && typeof s.headers === "object") out.headers_set = true;
      continue;
    }
    if (k === "env") {
      if (s.env && typeof s.env === "object") out.env_set = Object.keys(s.env).length > 0;
      continue;
    }
    if (s[k] !== undefined) out[k] = s[k];
  }
  if (!out.name) out.name = s.command || s.url || "";
  return out;
}

// GET /api/settings: 返回可编辑设置的安全视图
export function getSettings(root) {
  // 用 loadConfig 深合并默认值, 保证缺字段也有结构; 但 write 需基于磁盘原文避免覆盖默认
  const merged = loadConfig(root);
  return sanitizeSettings(merged);
}

// PUT /api/settings: 只更新白名单字段, 返回更新后的安全视图
// patch = { user?, http?, security?, agent?, mcp?, tools? }
// v1.0.8: patch 顶层/分区字段都按 SETTINGS_FIELDS 白名单过滤 (防注入任意字段); 写盘在文件锁内读-改-写 (防并发丢更新)
export function updateSettings(root, patch) {
  if (!patch || typeof patch !== "object") throw new Error("patch 必须是对象");
  const p = getConfigPath(root);
  return withFileLock(p, () => {
    const cfg = readConfigRaw(root); // 锁内重读: 拿最新磁盘状态再改
    // 只取白名单字段 (SETTINGS_FIELDS 定义每个分区可改的键)
    const pick = (obj, keys) => {
      const out = {};
      for (const k of keys) if (obj && typeof obj === "object" && obj[k] !== undefined) out[k] = obj[k];
      return out;
    };
    cfg.user = { ...(cfg.user || {}), ...pick(patch.user, SETTINGS_FIELDS.user) };
    cfg.channels = cfg.channels || {};
    cfg.channels.http = { ...(cfg.channels.http || {}), ...pick(patch.http, SETTINGS_FIELDS.http) };
    cfg.security = { ...(cfg.security || {}), ...pick(patch.security, SETTINGS_FIELDS.security) };
    cfg.agent = { ...(cfg.agent || {}), ...pick(patch.agent, SETTINGS_FIELDS.agent) };
    cfg.mcp = { ...(cfg.mcp || {}), ...pick(patch.mcp, SETTINGS_FIELDS.mcp) };
    cfg.tools = { ...(cfg.tools || {}), ...pick(patch.tools, SETTINGS_FIELDS.tools) };

    // 校验
    const port = cfg.channels.http.port;
    if (port != null && (!Number.isInteger(port) || port < 1 || port > 65535)) throw new Error("HTTP 端口必须是 1-65535 的整数");
    const timeout = cfg.security.command_timeout_ms;
    if (timeout != null && (!Number.isFinite(timeout) || timeout < 1000)) throw new Error("命令超时至少 1000ms");
    if (cfg.agent.values != null && !Array.isArray(cfg.agent.values)) throw new Error("核心价值必须是字符串数组");
    if (cfg.agent.values && cfg.agent.values.some((v) => typeof v !== "string")) throw new Error("核心价值必须是字符串数组");
    if (cfg.agent.mode != null && !/^[a-z-]{2,30}$/.test(String(cfg.agent.mode))) throw new Error("编排模式只含小写字母/横线");
    // mcp.servers: 必须是对象数组, 每项至少 command 或 url, 只保留白名单字段
    if (cfg.mcp.servers != null && !Array.isArray(cfg.mcp.servers)) throw new Error("MCP servers 必须是数组");
    if (Array.isArray(cfg.mcp.servers)) {
      const clean = [];
      for (const s of cfg.mcp.servers) {
        if (!s || typeof s !== "object") continue;
        if (!s.command && !s.url) throw new Error("MCP 服务器至少需要 command(stdio) 或 url(http)");
        const norm = {};
        for (const k of MCP_SERVER_KEYS) if (s[k] !== undefined) norm[k] = s[k];
        clean.push(norm);
      }
      cfg.mcp.servers = clean;
    }
    // tools.disabled: 必须是字符串数组
    if (cfg.tools.disabled != null) {
      if (!Array.isArray(cfg.tools.disabled)) throw new Error("tools.disabled 必须是字符串数组");
      if (cfg.tools.disabled.some((t) => typeof t !== "string")) throw new Error("tools.disabled 必须是字符串数组");
    }

    writeConfigAtomic(root, cfg);
    return sanitizeSettings(cfg);
  });
}

// 应用 tools.disabled: 返回需要禁用的工具名列表 (供启动时/热重载时禁用)
export function disabledTools(root) {
  const { tools } = getSettings(root);
  return Array.isArray(tools?.disabled) ? tools.disabled : [];
}

// 可编辑字段元数据 (供前端渲染表单, 免前端硬编码结构)
export function settingsSchema() {
  return SETTINGS_FIELDS;
}

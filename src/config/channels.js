// src/config/channels.js - 通道配置 CRUD (借鉴 providers.js 模式)
// 唯一事实源 = config/ppx.json 的 channels 对象; 原子写盘 + 备份
// 用途: `ppx channels` CLI / HTTP API 让用户自己连通道, 不改源码
import fs from "node:fs";
import path from "node:path";
import { withFileLock } from "../utils/store.js";
import { warn } from "../utils/logger.js";

// 每通道字段 schema: { type, label, def, secret }
// secret=true 的字段写盘存明文 (本地配置), 但 list/sanitize 时只暴露 "已设置" 标志
export const CHANNEL_SCHEMAS = {
  http: {
    enabled: { type: "boolean", label: "启用", def: true },
    host: { type: "string", label: "监听地址", def: "127.0.0.1" },
    port: { type: "number", label: "端口", def: 8899 },
    auth_token: { type: "string", label: "鉴权 token (可选, 留空自动生成)", secret: true },
  },
  feishu: {
    enabled: { type: "boolean", label: "启用", def: false },
    appId: { type: "string", label: "App ID", prompt: "飞书开放平台应用的 App ID" },
    appSecret: { type: "string", label: "App Secret", secret: true, prompt: "飞书开放平台应用的 App Secret" },
    verifyToken: { type: "string", label: "Verification Token", secret: true, prompt: "事件订阅的 Verification Token" },
    webhookPath: { type: "string", label: "Webhook 路径", def: "/feishu/webhook" },
  },
  wechat: {
    enabled: { type: "boolean", label: "启用", def: false },
    path: { type: "string", label: "Webhook 路径", def: "/wechat/webhook" },
    token: { type: "string", label: "回调 Token", secret: true, prompt: "企业微信回调 Token" },
    encodingAESKey: { type: "string", label: "EncodingAESKey", secret: true, prompt: "企业微信回调 EncodingAESKey" },
    corpId: { type: "string", label: "企业 ID (corp_id)", prompt: "企业微信企业 ID, 用于主动推送" },
    corpSecret: { type: "string", label: "企业密钥 (corp_secret)", secret: true, prompt: "企业微信应用 Secret, 用于主动推送" },
    agentId: { type: "string", label: "应用 AgentID", prompt: "企业微信自建应用 AgentID, 用于主动推送" },
  },
  log: {
    enabled: { type: "boolean", label: "启用", def: false },
    target: { type: "string", label: "输出目标", def: "console" },
  },
};

export const CHANNEL_NAMES = Object.keys(CHANNEL_SCHEMAS);

function getConfigPath(root) {
  return path.join(root, "config", "ppx.json");
}

// 读取 config, 返回 { channels, raw }
export function readChannels(root) {
  const p = getConfigPath(root);
  if (!fs.existsSync(p)) return { channels: {}, raw: { channels: {} } };
  try {
    const raw = JSON.parse(fs.readFileSync(p, "utf8"));
    return { channels: raw.channels || {}, raw };
  } catch (e) {
    warn("config/ppx.json 读取失败:", e.message);
    return { channels: {}, raw: { channels: {} } };
  }
}

// 写盘: 先备份, 再原子写 (tmp + rename), 防中途崩溃损坏
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

// 校验 patch: 剔除未知字段 + 类型检查; 返回 { clean, errors[] }
export function validateChannel(name, patch) {
  const schema = CHANNEL_SCHEMAS[name];
  if (!schema) return { clean: {}, errors: [`未知通道类型: ${name}`] };
  const clean = {};
  const errors = [];
  for (const [key, val] of Object.entries(patch || {})) {
    if (!(key in schema)) { errors.push(`未知字段 ${name}.${key} (可用: ${Object.keys(schema).join(", ")})`); continue; }
    const { type } = schema[key];
    if (type === "number") {
      if (val === "" || val == null) { clean[key] = val; continue; }
      const n = Number(val);
      if (!Number.isFinite(n)) { errors.push(`${name}.${key} 应为数字`); continue; }
      clean[key] = n;
    } else if (type === "boolean") {
      // v1.0.8: 识别字符串 "false"/"0" (原 !!val 会把 "false" 当 true)
      if (val === true || val === "true" || val === 1 || val === "1") clean[key] = true;
      else if (val === false || val === "false" || val === 0 || val === "0") clean[key] = false;
      else { errors.push(`${name}.${key} 应为布尔`); continue; }
    } else {
      clean[key] = String(val);
    }
  }
  return { clean, errors };
}

// 脱敏视图: secret 字段只暴露 "已设置" 标志 (供 list 展示)
export function sanitizeChannel(name, cfg) {
  const schema = CHANNEL_SCHEMAS[name] || {};
  const out = {};
  for (const key of Object.keys(schema)) {
    if (cfg[key] === undefined || cfg[key] === null || cfg[key] === "") continue;
    if (schema[key].secret) out[`${key}_set`] = true;
    else out[key] = cfg[key];
  }
  return out;
}

// 列出全部通道状态 (含默认值 + 脱敏)
export function listChannels(root) {
  const { channels } = readChannels(root);
  return CHANNEL_NAMES.map((name) => {
    const schema = CHANNEL_SCHEMAS[name];
    const cfg = { ...(channels[name] || {}) };
    // 补默认值, 让 list 显示完整配置 (用户未写的字段显示默认)
    for (const [key, f] of Object.entries(schema)) {
      if (cfg[key] === undefined && f.def !== undefined) cfg[key] = f.def;
    }
    return {
      name,
      enabled: cfg.enabled ?? schema.enabled.def,
      fields: sanitizeChannel(name, cfg),
    };
  });
}

// 更新通道配置 (patch 覆盖; 空字符串清空字段)
// v1.0.8: 写盘在文件锁内读-改-写 (防并发丢更新)
export function updateChannel(root, name, patch) {
  return withFileLock(getConfigPath(root), () => {
    const { channels, raw } = readChannels(root);
    const { clean, errors } = validateChannel(name, patch);
    if (errors.length) throw new Error(errors.join("; "));
    const merged = { ...(channels[name] || {}), ...clean };
    // 空字符串视为清空
    for (const k of Object.keys(clean)) if (clean[k] === "") delete merged[k];
    channels[name] = merged;
    raw.channels = channels;
    writeConfigAtomic(root, raw);
    return sanitizeChannel(name, merged);
  });
}

// 启用/禁用
export function setChannelEnabled(root, name, enabled) {
  return updateChannel(root, name, { enabled: !!enabled });
}

// 移除配置 (重置回默认, 即从 channels.<name> 删除)
export function removeChannel(root, name) {
  return withFileLock(getConfigPath(root), () => {
    const { channels, raw } = readChannels(root);
    const existed = name in channels;
    delete channels[name];
    raw.channels = channels;
    writeConfigAtomic(root, raw);
    return existed;
  });
}

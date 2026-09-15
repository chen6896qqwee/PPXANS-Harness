// src/config/providers.js - LLM 提供方 CRUD (HTTP API 后端)
// 设计:
//   - 唯一事实源 = config/ppx.json 的 providers 数组
//   - 写盘: 备份原文件 → 原子写 (.tmp + rename) → 防配置丢失
//   - 返回前端时: 抹掉 api_key 明文, 只暴露 api_key_env 与 api_key_set 标志
//   - 校验: id 命名规则 / 字段必填 / id 冲突检测
//   - 热重载: 调用方写盘后, 调 agent.reloadProviders() 重建内存中的 LLM 客户端列表
import fs from "node:fs";
import path from "node:path";
import { withFileLock } from "../utils/store.js";
import { info, warn, error } from "../utils/logger.js";

// 提供方字段白名单 (写入磁盘时的过滤)
const PROVIDER_KEYS = [
  "id", "backend", "base_url", "api_key", "api_key_env",
  "model", "models", "vision", "timeout_ms",
  "mjs", "session_key", "dsh_root", "dsml",
];

function getProvidersPath(root) {
  return path.join(root, "config", "ppx.json");
}

// 读取整个 config, 返回 { providers, raw }
export function readConfig(root) {
  const p = getProvidersPath(root);
  if (!fs.existsSync(p)) return { providers: [], raw: { providers: [] } };
  try {
    const raw = JSON.parse(fs.readFileSync(p, "utf8"));
    const providers = Array.isArray(raw.providers) ? raw.providers : [];
    return { providers, raw };
  } catch (e) {
    warn("config/ppx.json 读取失败:", e.message);
    return { providers: [], raw: { providers: [] } };
  }
}

// 写盘: 先备份, 再原子写 (tmp + rename), 防中途崩溃损坏
function writeConfigAtomic(root, cfg) {
  const p = getProvidersPath(root);
  // 备份 (最多保留最近 3 个 .bak, 多则删)
  if (fs.existsSync(p)) {
    const bak = p + ".bak-" + new Date().toISOString().replace(/[:.]/g, "-");
    try { fs.copyFileSync(p, bak); } catch (e) { warn("备份失败:", e.message); }
    // 清理老备份 (保留最近 3 个)
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
  // 原子写
  const tmp = p + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(cfg, null, 2), "utf8");
  fs.renameSync(tmp, p);
}

// 校验一个提供方对象是否合法; 返回 null 或错误信息
export function validateProvider(p) {
  if (!p || typeof p !== "object") return "提供方必须是对象";
  if (!p.id || typeof p.id !== "string") return "缺少 id";
  if (!/^[a-zA-Z][a-zA-Z0-9_-]{0,29}$/.test(p.id)) return "id 必须以字母开头, 仅含字母/数字/横线/下划线, 2-30字符";
  // 必须至少有一类后端配置
  const isEngineBackend = p.backend === "openclaw" || p.backend === "deepseek";
  const hasEnginePath = !!p.mjs || !!p.dsh_root;
  const hasHttpField = !!p.base_url || !!p.api_key || !!p.api_key_env;
  if (isEngineBackend) {
    if (p.backend === "openclaw" && !hasEnginePath) return "openclaw 后端需 mjs 字段 (openclaw.mjs 路径)";
    if (p.backend === "deepseek" && !hasEnginePath) return "deepseek 后端需 dsh_root 字段";
  } else {
    if (!hasHttpField) return "http 后端至少需要 base_url 或 api_key 或 api_key_env 之一";
    if (!p.base_url) return "http 后端需 base_url";
  }
  if (p.vision != null && typeof p.vision !== "boolean") return "vision 必须是布尔";
  if (p.dsml != null && typeof p.dsml !== "boolean") return "dsml 必须是布尔";
  if (p.timeout_ms != null && (!Number.isFinite(p.timeout_ms) || p.timeout_ms < 1000)) return "timeout_ms 至少 1000ms";
  // 占位符校验: 模板残留 (如 REPLACE_WITH_YOUR_ENDPOINT) 视为未配置, 避免配了 key 却静默失败
  for (const field of ["model", "base_url", "api_key"]) {
    const v = p[field];
    if (typeof v === "string" && /REPLACE_WITH_|your_?endpoint|your[_-]?api[_-]?key/i.test(v)) {
      return `${field} 仍是占位符 (${v.slice(0, 40)}), 请替换为真实值`;
    }
  }
  return null;
}

// 抹掉 key 明文, 暴露给前端的安全视图
export function sanitizeProvider(p) {
  const out = {};
  for (const k of PROVIDER_KEYS) {
    if (k === "api_key") continue; // 永远不回传
    if (p[k] !== undefined) out[k] = p[k];
  }
  out.api_key_set = !!p.api_key;
  out.api_key_env = p.api_key_env || "";
  return out;
}

export function listProviders(root) {
  const { providers } = readConfig(root);
  return providers.map((p) => sanitizeProvider(p));
}

export function getProvider(root, id) {
  const { providers } = readConfig(root);
  const p = providers.find((x) => x.id === id);
  return p ? sanitizeProvider(p) : null;
}

// 新增
// v1.0.8: 写盘在文件锁内读-改-写 (防并发 API 请求丢更新)
export function addProvider(root, raw) {
  return withFileLock(getProvidersPath(root), () => {
    const { providers, raw: cfg } = readConfig(root);
    const err = validateProvider(raw);
    if (err) throw new Error(err);
    if (providers.find((p) => p.id === raw.id)) throw new Error(`id 冲突: ${raw.id}`);
    // 仅保留白名单字段
    const norm = {};
    for (const k of PROVIDER_KEYS) if (raw[k] !== undefined) norm[k] = raw[k];
    if (!norm.id) norm.id = raw.id;
    providers.push(norm);
    cfg.providers = providers;
    writeConfigAtomic(root, cfg);
    return sanitizeProvider(norm);
  });
}

// 更新 (id 不可改, 其他字段覆盖)
export function updateProvider(root, id, patch) {
  return withFileLock(getProvidersPath(root), () => {
    const { providers, raw: cfg } = readConfig(root);
    const idx = providers.findIndex((p) => p.id === id);
    if (idx < 0) throw new Error(`提供方不存在: ${id}`);
    const merged = { ...providers[idx], ...patch, id };
    // 抹掉 patch 里的 api_key 设了空字符串, 视为清空
    if (patch.api_key === "") delete merged.api_key;
    const err = validateProvider(merged);
    if (err) throw new Error(err);
    // 仅保留白名单
    const clean = {};
    for (const k of PROVIDER_KEYS) if (merged[k] !== undefined) clean[k] = merged[k];
    providers[idx] = clean;
    cfg.providers = providers;
    writeConfigAtomic(root, cfg);
    return sanitizeProvider(clean);
  });
}

// 删除
export function removeProvider(root, id) {
  return withFileLock(getProvidersPath(root), () => {
    const { providers, raw: cfg } = readConfig(root);
    const idx = providers.findIndex((p) => p.id === id);
    if (idx < 0) throw new Error(`提供方不存在: ${id}`);
    const [removed] = providers.splice(idx, 1);
    cfg.providers = providers;
    writeConfigAtomic(root, cfg);
    return sanitizeProvider(removed);
  });
}

// 重排 (默认 = 数组第 0 个)
export function reorderProviders(root, order) {
  return withFileLock(getProvidersPath(root), () => {
    const { providers, raw: cfg } = readConfig(root);
    if (!Array.isArray(order) || order.length !== providers.length) {
      throw new Error("order 必须是包含全部 id 的数组");
    }
    const byId = new Map(providers.map((p) => [p.id, p]));
    const next = [];
    for (const id of order) {
      const p = byId.get(id);
      if (!p) throw new Error(`未知 id: ${id}`);
      next.push(p);
      byId.delete(id);
    }
    if (byId.size) throw new Error("order 缺少部分 id");
    cfg.providers = next;
    writeConfigAtomic(root, cfg);
    return next.map((p) => sanitizeProvider(p));
  });
}
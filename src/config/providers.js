// src/config/providers.js - LLM 提供方 CRUD (HTTP API 后端)
// 设计:
//   - 唯一事实源 = config/ppx.json 的 providers 数组
//   - 写盘: 备份原文件 → 原子写 (.tmp + rename) → 防配置丢失
//   - 返回前端时: 抹掉 api_key 明文, 只暴露 api_key_env 与 api_key_set 标志
//   - 校验: id 命名规则 / 字段必填 / id 冲突检测
//   - 热重载: 调用方写盘后, 调 agent.reloadProviders() 重建内存中的 LLM 客户端列表
import { withFileLock } from "../utils/store.js";
import { configFilePath, readPpxConfig, writeConfigAtomic } from "../utils/config-file.js";
import { isPlaceholder } from "./placeholder.js";

// 提供方字段白名单 (写入磁盘时的过滤)
const PROVIDER_KEYS = [
  "id", "backend", "base_url", "api_key", "api_key_env",
  // 2026-10-31: 密钥命令通道 —— 不把 key 明文落盘的第三条路: 配一条命令, 启动时取其
  //   stdout 作为 key (PowerShell DPAPI / pass / 凭据管理器均可)。命令本身不是机密, 可明文。
  "api_key_cmd",
  "model", "models", "vision", "timeout_ms", "retry_max",
  "dsml",
  // 2026-10-24 (R16): 补两个此前被白名单静默丢弃的字段 ——
  //   context_window: UI 表单一直有输入框且卡片展示, 但写盘被过滤 (填了等于没填);
  //   enabled:        provider 启用/禁用 (禁用保留配置与 key, 仅退出路由候选)。
  "context_window", "enabled",
  // 2026-11-01 (v4.2 雷仔对齐): 协议适配层 + 结构化模型目录 ——
  //   protocol:     线上协议 (openai-completions 缺省 / openai-responses / anthropic-messages),
  //                 适配实现在 src/llm/protocol.js, LLMClient 按 provider.protocol 分发;
  //   display_name: UI 展示名 (卡片/模型座椅), 不参与路由匹配;
  //   models:       结构化模型目录 [{id,label,context_window,max_output,inputs}] (见 normalizeModels)。
  "protocol", "display_name",
];

// 支持的线上协议 (与 src/llm/protocol.js 的适配器一一对应)
export const PROTOCOLS = ["openai-completions", "openai-responses", "anthropic-messages"];
export const DEFAULT_PROTOCOL = "openai-completions";
// 输入类型: text 恒有; image 需模型/提供商声明 (视觉)
const INPUT_TYPES = ["text", "image"];

// 2026-11-01 (v4.2): models 归一化 —— 新旧三种形态统一收敛为结构化目录。
//   兼容输入: "gpt-4o" (旧字符串) | {id, image:true} (半结构化) | [{id,label,...}] (v4.2 结构化)
//   输出: [{id, label, context_window, max_output, inputs:["text"|"image",...]}]
//   规则: 提供商级 vision=true 时全目录补 image 输入 (legacy 语义保留, 但不反向覆盖显式声明)。
export function normalizeModels(models, { vision = false, context_window = null } = {}) {
  const out = [];
  const list = Array.isArray(models) ? models : (models ? [models] : []);
  for (const raw of list) {
    if (!raw) continue;
    const m = typeof raw === "string" ? { id: raw } : (typeof raw === "object" ? { ...raw } : null);
    if (!m || !m.id || typeof m.id !== "string") continue;
    const inputs = Array.isArray(m.inputs)
      ? INPUT_TYPES.filter((t) => m.inputs.includes(t))
      : ["text"];
    // 旧字段桥接: m.image / m.vision 布尔 → image 输入
    if ((m.image === true || m.vision === true) && !inputs.includes("image")) inputs.push("image");
    if (vision === true && !inputs.includes("image")) inputs.push("image");
    inputs.sort(); // 稳定序: ["image","text"]
    out.push({
      id: m.id,
      label: typeof m.label === "string" ? m.label : "",
      // 数字合法性: 非法/缺失落 null (消费方逐级回退 provider 级 → 内置默认)
      context_window: Number.isFinite(m.context_window) && m.context_window >= 1024
        ? Math.floor(m.context_window)
        : (Number.isFinite(context_window) && context_window >= 1024 ? Math.floor(context_window) : null),
      max_output: Number.isFinite(m.max_output) && m.max_output >= 16 ? Math.floor(m.max_output) : null,
      inputs,
    });
  }
  // 去重 (按 id, 后者胜)
  const seen = new Map();
  for (const m of out) seen.set(m.id, m);
  return [...seen.values()];
}

// provider 级归一化: protocol 缺省 / models 结构化 / model 串补进目录 (供 client 解析元数据)
export function normalizeProvider(p) {
  if (!p || typeof p !== "object") return p;
  const out = { ...p };
  if (!out.protocol) out.protocol = DEFAULT_PROTOCOL;
  // v4.1 对象形态 {chat, context_window} 桥接 (2026-11-01 修复): LLMClient 曾明确支持
  //   models?.chat / models?.context_window, 初版归一化只认数组 → 该形态被静默丢弃
  //   (models.chat 选择的模型丢失回落 gpt-4o-mini, 窗口回落 8192), 且写盘会把删除固化。
  //   此处 chat → 目录项, 其余模型名键容忍为 text-only 条目, context_window 上提 provider 级。
  if (out.models && !Array.isArray(out.models) && typeof out.models === "object") {
    const legacy = out.models;
    const arr = [];
    if (legacy.chat) {
      arr.push(typeof legacy.chat === "string" ? { id: legacy.chat } : { ...legacy.chat });
      if (out.model == null) out.model = typeof legacy.chat === "string" ? legacy.chat : legacy.chat.id;
    }
    for (const [k, v] of Object.entries(legacy)) {
      if (k === "chat" || k === "context_window") continue;
      if (typeof v === "string") arr.push({ id: v });
    }
    if (legacy.context_window != null && out.context_window == null) out.context_window = legacy.context_window;
    out.models = arr;
  }
  const vision = out.vision === true;
  const models = normalizeModels(out.models, { vision, context_window: out.context_window ?? null });
  // 旧格式只有 model 单值没有目录: 补一条目录项, 让 per-model 元数据解析有落点
  if (out.model && !models.some((m) => m.id === out.model)) {
    models.unshift(...normalizeModels([{ id: out.model, context_window: out.context_window ?? null }], { vision }));
  }
  if (models.length) out.models = models;
  else delete out.models;
  return out;
}

const getProvidersPath = configFilePath;

// 读取整个 config, 返回 { providers, raw }
// 2026-11-01 (v4.2): 读取时逐条归一化 (protocol 缺省 / models 结构化) —— 消费方
//   (LLMClient / UI) 拿到的永远是规范形态; 旧格式 config/ppx.json 无需迁移即兼容。
export function readConfig(root) {
  const raw = readPpxConfig(root, null);
  if (raw === null) return { providers: [], raw: { providers: [] } };
  const providers = Array.isArray(raw.providers) ? raw.providers.map(normalizeProvider) : [];
  return { providers, raw };
}

// 校验一个提供方对象是否合法; 返回 null 或错误信息
export function validateProvider(p) {
  if (!p || typeof p !== "object") return "提供方必须是对象";
  if (!p.id || typeof p.id !== "string") return "缺少 id";
  if (!/^[a-zA-Z][a-zA-Z0-9_-]{0,29}$/.test(p.id)) return "id 必须以字母开头, 仅含字母/数字/横线/下划线, 2-30字符";
  // 自研底座: 仅支持 http 后端 (OpenAI 兼容 API 直连); 显式非 http 后端一律拒绝
  if (p.backend && p.backend !== "http") {
    return `后端 ${p.backend} 已不受支持 (v2.5.0 起仅保留自研 http 底座, 外部引擎底座已移除)`;
  }
  if (!p.base_url) return "http 后端需 base_url";
  // 2026-11-01 (v4.2): 协议白名单 (未知协议宁可拒收也不静默回落, 防发错线格式)
  if (p.protocol != null && !PROTOCOLS.includes(p.protocol)) {
    return `protocol 必须是 ${PROTOCOLS.join(" / ")} 之一, 收到: ${p.protocol}`;
  }
  if (p.display_name != null && (typeof p.display_name !== "string" || p.display_name.length > 60)) {
    return "display_name 需为不超过 60 字符的字符串";
  }
  if (p.models != null) {
    if (!Array.isArray(p.models)) return "models 必须是数组 (字符串或 {id,...} 对象)";
    if (p.models.length > 64) return "models 目录最多 64 条 (做减法, 防目录膨胀)";
    for (const m of p.models) {
      if (typeof m === "string") continue;
      if (!m || typeof m !== "object" || !m.id) return "models 条目需为字符串或含 id 的对象";
      if (typeof m.id !== "string" || m.id.length > 200) return "models 条目 id 需为 1-200 字符字符串";
      if (m.context_window != null && (!Number.isFinite(m.context_window) || m.context_window < 1024)) {
        return `模型 ${m.id} 的 context_window 至少 1024`;
      }
      if (m.max_output != null && (!Number.isFinite(m.max_output) || m.max_output < 16)) {
        return `模型 ${m.id} 的 max_output 至少 16`;
      }
      if (m.inputs != null && (!Array.isArray(m.inputs) || m.inputs.some((t) => !INPUT_TYPES.includes(t)))) {
        return `模型 ${m.id} 的 inputs 只能含 text/image`;
      }
    }
  }
  if (p.vision != null && typeof p.vision !== "boolean") return "vision 必须是布尔";
  if (p.dsml != null && typeof p.dsml !== "boolean") return "dsml 必须是布尔";
  if (p.timeout_ms != null && (!Number.isFinite(p.timeout_ms) || p.timeout_ms < 1000)) return "timeout_ms 至少 1000ms";
  if (p.retry_max != null && (!Number.isInteger(p.retry_max) || p.retry_max < 0 || p.retry_max > 10)) return "retry_max 需为 0-10 的整数";
  if (p.enabled != null && typeof p.enabled !== "boolean") return "enabled 必须是布尔";
  if (p.context_window != null && (!Number.isFinite(p.context_window) || p.context_window < 1024)) return "context_window 至少 1024";
  // 占位符校验: 模板残留 (如 REPLACE_WITH_YOUR_ENDPOINT / YOUR_LOCAL_MODEL_NAME) 视为未配置,
  // 避免配了 key 却静默失败。v1.0.8 (P2-3): 判定收敛到 config/placeholder.js 唯一真相源。
  for (const field of ["model", "base_url", "api_key"]) {
    const v = p[field];
    if (isPlaceholder(v)) {
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

// 新增
// v1.0.8: 写盘在文件锁内读-改-写 (防并发 API 请求丢更新)
export function addProvider(root, raw) {
  return withFileLock(getProvidersPath(root), () => {
    const { providers, raw: cfg } = readConfig(root);
    const err = validateProvider(raw);
    if (err) throw new Error(err);
    if (providers.find((p) => p.id === raw.id)) throw new Error(`id 冲突: ${raw.id}`);
    // 仅保留白名单字段 + 归一化 (v4.2: protocol 缺省 / models 结构化落盘)
    const norm = normalizeProvider({});
    for (const k of PROVIDER_KEYS) if (raw[k] !== undefined) norm[k] = raw[k];
    if (!norm.id) norm.id = raw.id;
    providers.push(normalizeProvider(norm));
    cfg.providers = providers;
    writeConfigAtomic(root, cfg);
    // 返回落盘后的归一化副本 (norm 本体未过 normalizeProvider, models 可能仍是原始输入形态)
    return sanitizeProvider(providers[providers.length - 1]);
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
    // 仅保留白名单 + 归一化 (v4.2)
    const clean = normalizeProvider({});
    for (const k of PROVIDER_KEYS) if (merged[k] !== undefined) clean[k] = merged[k];
    providers[idx] = normalizeProvider(clean);
    cfg.providers = providers;
    writeConfigAtomic(root, cfg);
    return sanitizeProvider(providers[idx]); // 返回落盘后的归一化副本 (同 addProvider)
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
// 2026-10-24 (R16): 分层路由读写 —— model_routing.aux (辅助任务走便宜模型) +
// agent.model_preference (local/cloud 优先序)。此前的尴尬: 引擎与 self_diagnose
// 都支持并建议用户配置它, 但全仓没有任何 API/UI 能写这两个键, 功能不可触达。
export function readRouting(root) {
  const { raw } = readConfig(root);
  return {
    aux: raw.model_routing?.aux ?? null,
    preference: raw.agent?.model_preference ?? "local",
  };
}

export function writeRouting(root, { aux, preference } = {}) {
  return withFileLock(getProvidersPath(root), () => {
    const { providers, raw: cfg } = readConfig(root);
    if (aux !== undefined) {
      if (aux === null || aux === "") {
        delete cfg.model_routing;
      } else {
        if (!providers.some((p) => p.id === aux)) throw new Error(`提供方不存在: ${aux}`);
        cfg.model_routing = { ...(cfg.model_routing || {}), aux };
      }
    }
    if (preference !== undefined) {
      if (!["local", "cloud"].includes(preference)) throw new Error(`preference 只能是 local/cloud, 收到: ${preference}`);
      cfg.agent = { ...(cfg.agent || {}), model_preference: preference };
    }
    writeConfigAtomic(root, cfg);
    return readRouting(root);
  });
}

// src/config/settings.js - 通用设置读写 (HTTP API 后端)
// 覆盖 config/ppx.json 顶层字段: user / channels.http / security / agent 预设 (values/system_extra/citation_rule/mode)
// 设计 (与 providers.js 对齐):
//   - 唯一事实源 = config/ppx.json
//   - 写盘: 备份原文件 → 原子写 (.tmp + rename) → 防配置丢失
//   - 读取: 深度合并默认值 (loadConfig), 保证前端总能拿到完整结构
//   - 热重载: 写盘后由调用方调 agent.reload() 重建内存
import { loadConfig, DEFAULT_CONFIG } from "./index.js";
import { withFileLock } from "../utils/store.js";
import { configFilePath, readPpxConfig, writeConfigAtomic } from "../utils/config-file.js";

const getConfigPath = configFilePath;

// 读取当前 config (磁盘原文), 缺文件返回空
export function readConfigRaw(root) {
  return readPpxConfig(root, {});
}

// 通用设置字段白名单 (GET 返回 + PUT 可改的顶层键)
// 每个键对应 config 里的一个可编辑分区, 值里的字段再细分
// 2026-10-31: security.allow_all 移出 HTTP 可写白名单 —— 拿到 bearer token 就能
//   整体放开命令白名单是权限模型里最软的一块板子; 现在只能编辑 config/ppx.json 后重启生效。
export const SETTINGS_FIELDS = {
  user: ["name"],
  http: ["port", "auth_token"],
  security: ["command_timeout_ms", "code_act", "deny"],
  // intent_funnel (v4.2): 分层漏斗意图识别开关 (false = 关闭 L2 提示注入, 只留 L1 规则直答)
  // max_tool_rounds (2026-11-03): 工具循环轮次上限, 设置 UI 可调 (1-64)
  // reply_style (2026-11-18): 回复风格注入 (个性化面板, 静态段)
  agent: ["name", "mode", "citation_rule", "system_extra", "values", "intent_funnel", "max_tool_rounds", "reply_style"],
  mcp: ["servers", "auto_connect"],
  tools: ["disabled"],
  skills: ["disabled"],
  llm: ["provider", "reasoning"],
  // 语音识别 (2026-10-11): config.voice.asr 云端 ASR (OpenAI 兼容 /audio/transcriptions)
  // 2026-11-14: 补本地 whisper 兜底字段 (backend=local 时生效, bin/flavor/model_path/timeout_ms)
  asr: ["backend", "base_url", "api_key", "model", "bin", "flavor", "model_path", "timeout_ms", "language"],
};

// 思考强度合法值 (与前端滑杆档位一致)
export const REASONING_LEVELS = ["auto", "off", "low", "medium", "high", "max"];

// MCP 服务器字段白名单 (防注入任意字段)
// 2026-11-03: 补 trusted —— MCP 管理页要能勾"信任此服务器 (免审批)", 此前白名单缺这个键,
//   经 PUT /api/settings 保存一次就把已有 trusted 静默丢掉, 外部工具全部退回强制审批。
const MCP_SERVER_KEYS = ["command", "args", "env", "prefix", "url", "headers", "timeout", "name", "trusted"];

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
      deny: Array.isArray(cfg.security?.deny) ? cfg.security.deny : [],
    },
    agent: {
      name: cfg.agent?.name || "皮皮虾",
      mode: cfg.agent?.mode || "react",
      citation_rule: cfg.agent?.citation_rule ?? "",
      system_extra: cfg.agent?.system_extra ?? "",
      reply_style: cfg.agent?.reply_style ?? "",
      values: Array.isArray(cfg.agent?.values) ? cfg.agent.values : (DEFAULT_CONFIG.agent?.values || []),
      max_tool_rounds: Number(cfg.agent?.max_tool_rounds) || (DEFAULT_CONFIG.agent?.max_tool_rounds ?? 24),
    },
    mcp: {
      auto_connect: !!cfg.mcp?.auto_connect,
      servers: Array.isArray(cfg.mcp?.servers) ? cfg.mcp.servers.map((s) => sanitizeMcpServer(s)) : [],
    },
    tools: {
      disabled: Array.isArray(cfg.tools?.disabled) ? cfg.tools.disabled : [],
    },
    skills: {
      disabled: Array.isArray(cfg.skills?.disabled) ? cfg.skills.disabled : [],
    },
    llm: {
      provider: cfg.llm?.provider || "",
      reasoning: REASONING_LEVELS.includes(cfg.llm?.reasoning) ? cfg.llm.reasoning : "auto",
    },
    voice: {
      // ASR 安全视图: api_key 不回传明文, 只暴露 set 标志 (2026-10-11)
      asr: {
        backend: cfg.voice?.asr?.backend || "cloud",
        base_url: cfg.voice?.asr?.base_url || "",
        api_key_set: !!(cfg.voice?.asr?.api_key),
        model: cfg.voice?.asr?.model || "whisper-1",
      },
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
    cfg.skills = { ...(cfg.skills || {}), ...pick(patch.skills, SETTINGS_FIELDS.skills) };
    cfg.llm = { ...(cfg.llm || {}), ...pick(patch.llm, SETTINGS_FIELDS.llm) };
    // 语音识别 (2026-10-11): config.voice.asr — api_key 为空时不覆盖 (保留已存密钥)
    if (patch.asr && typeof patch.asr === "object") {
      cfg.voice = cfg.voice || {};
      cfg.voice.asr = { ...(cfg.voice.asr || {}), ...pick(patch.asr, SETTINGS_FIELDS.asr) };
    }

    // 校验
    // 2026-10-31: allow_all 不在白名单内被 pick() 静默丢弃 —— 显式报错让调用方知道去哪改
    if (patch.security && typeof patch.security === "object" && "allow_all" in patch.security) {
      throw new Error("security.allow_all 不能通过 HTTP API 修改 — 请编辑 config/ppx.json 后重启");
    }
    const port = cfg.channels.http.port;
    if (port != null && (!Number.isInteger(port) || port < 1 || port > 65535)) throw new Error("HTTP 端口必须是 1-65535 的整数");
    const timeout = cfg.security.command_timeout_ms;
    if (timeout != null && (!Number.isFinite(timeout) || timeout < 1000)) throw new Error("命令超时至少 1000ms");
    if (cfg.security.deny != null && !Array.isArray(cfg.security.deny)) throw new Error("额外拒绝规则必须是字符串数组");
    if (cfg.security.deny && cfg.security.deny.some((d) => typeof d !== "string")) throw new Error("额外拒绝规则必须是字符串数组");
    if (cfg.agent.values != null && !Array.isArray(cfg.agent.values)) throw new Error("核心价值必须是字符串数组");
    if (cfg.agent.values && cfg.agent.values.some((v) => typeof v !== "string")) throw new Error("核心价值必须是字符串数组");
    if (cfg.agent.mode != null && !/^[a-z-]{2,30}$/.test(String(cfg.agent.mode))) throw new Error("编排模式只含小写字母/横线");
    if (cfg.agent.max_tool_rounds != null) {
      const rounds = cfg.agent.max_tool_rounds;
      if (!Number.isInteger(rounds) || rounds < 1 || rounds > 64) throw new Error("工具轮次上限必须是 1-64 的整数");
    }
    if (cfg.agent.reply_style != null) {
      if (typeof cfg.agent.reply_style !== "string") throw new Error("回复风格必须是字符串");
      if (cfg.agent.reply_style.length > 2000) throw new Error("回复风格不能超过 2000 字");
    }
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
    // skills.disabled: 必须是字符串数组 (技能管理页停用的 id)
    if (cfg.skills.disabled != null) {
      if (!Array.isArray(cfg.skills.disabled)) throw new Error("skills.disabled 必须是字符串数组");
      if (cfg.skills.disabled.some((t) => typeof t !== "string")) throw new Error("skills.disabled 必须是字符串数组");
      cfg.skills.disabled = [...new Set(cfg.skills.disabled.map((t) => t.trim()).filter(Boolean))];
    }
    // llm.provider / llm.reasoning: 白名单校验 (空 provider = 自动选择)
    if (cfg.llm.provider != null && String(cfg.llm.provider) !== "") {
      if (!/^[a-zA-Z][a-zA-Z0-9_-]{0,29}$/.test(String(cfg.llm.provider))) throw new Error("llm.provider 必须是合法 provider id");
    }
    if (cfg.llm.reasoning != null && !REASONING_LEVELS.includes(cfg.llm.reasoning)) {
      throw new Error(`llm.reasoning 必须是 ${REASONING_LEVELS.join(" / ")}`);
    }
    // voice.asr 校验 (2026-10-11): base_url 必须是 http(s) URL; 空对象 = 清除配置
    if (cfg.voice?.asr) {
      const a = cfg.voice.asr;
      if (a.base_url != null && a.base_url !== "" && !/^https?:\/\//i.test(String(a.base_url))) {
        throw new Error("voice.asr.base_url 必须是 http(s) 开头的 URL");
      }
      if (a.api_key === "") delete a.api_key; // 空密钥 = 未设置 (不覆盖已存值)
      // base_url 与 api_key 都为空 → 视为清除整个 asr 配置
      // 2026-11-14: backend=local (本地 whisper) 时不按云字段判空 —— bin/model_path 是它的存在依据
      const isLocalAsr = String(a.backend || "").toLowerCase() === "local";
      if (!a.base_url && !a.api_key && !a.model && !isLocalAsr && !a.bin) delete cfg.voice.asr;
      if (cfg.voice && Object.keys(cfg.voice).length === 0) delete cfg.voice;
    }

    writeConfigAtomic(root, cfg);
    return sanitizeSettings(cfg);
  });
}

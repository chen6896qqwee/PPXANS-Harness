// src/channels/http-api-settings.js - 提供方/路由/设置/模型目录/语音/工作区 API (从 http.js 拆出, mixin 挂回 prototype)
import fs from "node:fs";
import path from "node:path";

import { readBody } from "../utils/http.js";
import {
  listProviders, addProvider, updateProvider, removeProvider, reorderProviders, readConfig,
  readRouting, writeRouting,
} from "../config/providers.js";
import { listRemoteModels, isProtocol, DEFAULT_PROTOCOL } from "../llm/protocol.js";
import { discoverLocalServers, enrichModelsFromServer } from "../llm/local-discover.js";
import { classifyHttp } from "../llm/retry.js";
import { readNeedsAction } from "../llm/needs-action.js";
import { testProviderClient } from "../web/provider-ops.js";
import { isUsableProvider } from "../llm/router.js";
import { resolveVoice, resolveLocalAsr, voiceStatus, transcribeAudio } from "../tools/voice.js";
import { getSettings, updateSettings, REASONING_LEVELS } from "../config/settings.js";
import { ensureDir } from "../utils/store.js";
import { buildTree, readWorkspaceFile } from "./workspace.js";

// 提供商视觉能力: provider 级 vision 布尔 > 当前模型目录里的 inputs (v4.2 结构化目录)。
// 只写目录不写 provider.vision 时, 前端模型选择器原本会误标"不支持图片"。
function providerVision(p) {
  if (p.vision === true) return true;
  const list = Array.isArray(p.models) ? p.models : [];
  const cur = list.find((m) => m && m.id === p.model);
  return !!(cur && Array.isArray(cur.inputs) && cur.inputs.includes("image"));
}

// 2026-11-14 (双轨收敛轮, G-F): 写配置前确保 config 目录存在 —— 与 MCP admin 的
//   ensureConfigDir 同款自愈。空 root / 首次启动时 config 目录缺失, withFileLock 的
//   openSync(wx) ENOENT 会被误判为"锁冲突"并超时 3.5s (此前自愈只在 MCP 侧, REST 首启即坑)。
//   模块级函数而非 mixin 方法: 既有测试以最小化 ctx 直调 _apiSettings/_apiProviders。
function ensureConfigDir(root) {
  try { ensureDir(path.join(root, "config")); } catch { /* 目录已存在/不可建: 交由后续写路径报错 */ }
}

export const apiSettingsHttpMethods = {
// ---- 提供方 CRUD ----
async _apiProviders(req, res) {
  if (!this._requireAuth(req, res)) return true;
  const method = req.method;
  if (method === "GET") {
    const providers = listProviders(this.agent.root);
    const defaultId = providers[0] ? providers[0].id : null;
    this._json(res, 200, { providers, default_id: defaultId });
    return true;
  }
  if (!["POST", "PUT", "DELETE"].includes(method)) return false;
  // 2026-11-14 (双轨收敛轮, G-D): readonly 审查模式的 REST 旁路关闭 —— MCP admin 写操作
  //   早有 readonly 检查, REST 一直没有 (不对称)。审查者子进程 (PPX_AGENT_READONLY) 不服务
  //   HTTP 通道, 主 agent 永不 readonly, 对正常 UI 零影响。
  if (this.agent?.readonly === true) {
    this._json(res, 403, { ok: false, error: "只读模式 (审查者) 不允许修改模型配置" });
    return true;
  }
  const body = await this._readBody(req, res);
  if (body === null) return true;
  try {
    ensureConfigDir(this.agent.root);
    const data = JSON.parse(body || "{}");
    if (method === "POST") {
      const created = addProvider(this.agent.root, data.provider || data);
      this.agent.reloadProviders(); // 热重载 (新增默认时让 agent 立即可用)
      this._json(res, 200, { ok: true, provider: created });
      return true;
    }
    if (!data.id) throw new Error("缺少 id");
    if (method === "PUT") {
      const updated = updateProvider(this.agent.root, data.id, data.patch || {});
      this.agent.reloadProviders();
      this._json(res, 200, { ok: true, provider: updated });
      return true;
    }
    const removed = removeProvider(this.agent.root, data.id);
    this.agent.reloadProviders();
    this._json(res, 200, { ok: true, provider: removed });
    return true;
  } catch (e) {
    // 不存在/缺参 → 404, 其余校验失败 → 400 (保持原语义)
    this._fail(res, e, /不存在|缺少/.test(e.message) ? 404 : 400);
    return true;
  }
},

// ---- 2026-10-24 (R16): 分层路由 API ----
// GET  → { providers: [{id, model, usable}], routing: { aux, preference } }
// PUT  → { aux: id|null, preference: "local"|"cloud" } 写盘 + 热重载 (config + providers + auxLLM)
async _apiRouting(req, res) {
  if (!this._requireAuth(req, res)) return true;
  const root = this.agent.root;
  if (req.method === "GET") {
    const provs = readConfig(root).providers.map((p) => ({
      id: p.id, model: p.model, usable: (() => { try { return isUsableProvider(p); } catch { return false; } })(),
    }));
    this._json(res, 200, { providers: provs, routing: readRouting(root) });
    return true;
  }
  if (req.method !== "PUT") return false;
  const body = await this._readBody(req, res);
  if (body === null) return true;
  try {
    const data = JSON.parse(body || "{}");
    const routing = writeRouting(root, { aux: data.aux, preference: data.preference });
    // 热重载: 重建 provider 客户端 (model_preference 影响排序) + 刷新 aux 指针
    this.agent.reloadProviders();
    this.agent._refreshAuxRouting?.();
    this._json(res, 200, { ok: true, routing });
  } catch (e) {
    this._fail(res, e, /不存在|只能是/.test(e.message) ? 400 : 500);
  }
  return true;
},

// ---- 2026-10-24 (R16): per-provider 用量 (内存账本 usageStats.byModel 按模型归属聚合) ----
_apiProviderUsage(req, res) {
  if (!this._requireAuth(req, res)) return true;
  const u = this.agent.usageStats || {};
  const byModel = u.byModel || {};
  const un = (u.unpriced && typeof u.unpriced === "object") ? u.unpriced : {};
  const usage = readConfig(this.agent.root).providers.map((p) => {
    const m = byModel[p.model] || {};
    return {
      id: p.id, model: p.model, calls: m.calls || 0, tokens: m.tokens || 0, cost: m.cost || 0,
      // 该模型曾有调用但没有价格数据 → cost 为 0 不代表免费
      unpriced: !!un[p.model],
    };
  });
  this._json(res, 200, {
    usage,
    total: { calls: u.calls || 0, tokens: u.tokens || 0, cost: u.cost || 0, unpriced: Object.keys(un) },
  });
  return true;
},

// 2026-10-30: 最近一次生成运行态 + 用量快照 + 累计用量 (Web 底部状态条常驻数据源)
//   run  = agent.lastRun { rounds, steps, tokps, at } (本轮生成统计, 见 agent._llmWithTools)
//   usage = _usageSnapshot() { prompt, completion, total, cacheHit, cacheHitPct } (最近一次 LLM 调用)
//   context_window = 当前模型上下文窗口 (前端算"上下文占用 %"用, 不依赖 /api/llm 先加载)
//   totals = 累计用量 { calls, tokens, cacheHitPct } (跑进程被 kill 前已落盘, 重启可恢复)
_apiRunState(req, res) {
  if (!this._requireAuth(req, res)) return true;
  const run = this.agent?.lastRun || null;
  const usage = this._usageSnapshot();
  const context_window = Number(this.agent?.llm?.context_window) || 0;
  const us = this.agent?.usageStats || {};
  const pt = us.promptTokens || 0;
  const ch = us.cacheHitTokens || 0;
  const cacheHitPct = pt > 0 ? Math.round((ch / pt) * 100) : null;
  // 2026-11-12: 未定价模型名单 —— 底部状态条/统计页要能提示"金额不是完整成本"
  const un = (us.unpriced && typeof us.unpriced === "object") ? us.unpriced : {};
  const unpriced = Object.keys(un);
  const totals = {
    calls: us.calls || 0, tokens: us.tokens || 0, cost: us.cost || 0, cacheHitPct,
    unpriced, unpricedCalls: unpriced.reduce((n, m) => n + (Number(un[m]?.calls) || 0), 0),
  };
  // 2026-11-14 (BYO 体验轮): LLM 通道待处理项 (auth/balance/404) 上浮到状态条 ——
  //   此前坏 Key 只有默认关闭的看门狗可见。写读同一位置 (needs-action.js 的 diagDir 口径),
  //   HTTP 成功一次自动清除; 摘要不含任何密钥材料。
  const llmNeedsAction = (() => {
    const na = readNeedsAction();
    return na ? na.entries.map((x) => ({
      provider: x.provider, model: x.model, reason: x.reason,
      userHint: x.userHint || null, count: x.count, firstAt: x.firstAt,
    })) : [];
  })();
  this._json(res, 200, { run, usage, context_window, totals, llmNeedsAction });
  return true;
},

// 提供方健康探测: 内核收敛到 src/web/provider-ops.js (2026-11-14 双轨收敛轮) ——
//   与 MCP ppx.providers.test 同一实现 (兜底顺序 allProviders → agent.llm → 磁盘构造)。
async _apiProviderTest(req, res) {
  if (!this._requireAuth(req, res)) return true;
  const body = await this._readBody(req, res);
  if (body === null) return true;
  try {
    const data = JSON.parse(body || "{}");
    if (!data.id) throw new Error("缺少 id");
    const out = await testProviderClient(this.agent, String(data.id));
    this._json(res, 200, out);
  } catch (e) {
    this._fail(res, e);
  }
  return true;
},

// ---- v4.2 (2026-11-01): 模型目录拉取 ("获取可用模型"按钮后端) ----
// body: { id } (取已存 provider 的 base_url/protocol/key) 或 { base_url, protocol, api_key?, api_key_env? }
// 成功 → { ok:true, models:[{id,label}] }; 失败 → HTTP 200 + { ok:false, classified:{reason,...} }
//   (三态分类走 200 回传而非 4xx: 前端要的是"为什么失败、该干什么"的结构化结论, 不是状态码猜谜)
async _apiProviderFetchModels(req, res) {
  if (!this._requireAuth(req, res)) return true;
  const body = await this._readBody(req, res);
  if (body === null) return true;
  try {
    const data = JSON.parse(body || "{}");
    let baseUrl = String(data.base_url || "").trim();
    let protocol = isProtocol(data.protocol) ? data.protocol : DEFAULT_PROTOCOL;
    let apiKey = String(data.api_key || "");
    // 按 id 取已存 provider: key 优先已存明文 (不回传前端, 只在后端用), 其次 env
    if (data.id) {
      const { providers } = readConfig(this.agent.root);
      const p = providers.find((x) => x.id === data.id);
      if (!p) throw new Error("提供方不存在");
      baseUrl = baseUrl || p.base_url;
      if (isProtocol(p.protocol)) protocol = p.protocol;
      if (!apiKey) apiKey = p.api_key || process.env[p.api_key_env] || "";
    } else if (!apiKey && data.api_key_env) {
      apiKey = process.env[data.api_key_env] || "";
    }
    if (!baseUrl) throw new Error("缺少 base_url (或已存 provider 的 id)");
    const listed = await listRemoteModels({ baseUrl, protocol, apiKey, timeoutMs: 8000 });
    // 本地服务补元数据 (上下文窗口/最大输出/视觉): 编辑器据此自动填表,
    // 不再让用户手填 —— max_output 填小会让推理模型的正文被截成空回复。
    const models = await enrichModelsFromServer({ baseUrl, apiKey, models: listed.models });
    this._json(res, 200, { ok: true, protocol, models });
  } catch (e) {
    const classified = classifyHttp(e);
    this._json(res, 200, {
      ok: false,
      error: String(e.message || e).slice(0, 300),
      classified,
    });
  }
  return true;
},

// ---- 2026-11-02: 本机模型一键发现 ----
// body: { api_key?, ports? } → { ok, servers:[{kind,name,base_url,status,models[]}], scanned, needs_key }
//   status:"ok"   = 端点可用, models 已带窗口/能力
//   status:"auth" = 服务在跑但要 API Key (如 LM Studio 新版默认要求 token)
// 只扫环回固定端口表 (见 src/llm/local-discover.js), 不做任意主机探测。
async _apiProviderDiscoverLocal(req, res) {
  if (!this._requireAuth(req, res)) return true;
  const body = await this._readBody(req, res);
  if (body === null) return true;
  try {
    const data = JSON.parse(body || "{}");
    const out = await discoverLocalServers({
      apiKey: String(data.api_key || ""),
      ports: Array.isArray(data.ports) ? data.ports : null,
      timeoutMs: 1500,
    });
    this._json(res, 200, { ok: true, ...out });
  } catch (e) {
    this._fail(res, e);
  }
  return true;
},

async _apiProviderReorder(req, res) {
  if (!this._requireAuth(req, res)) return true;
  const body = await this._readBody(req, res);
  if (body === null) return true;
  try {
    const data = JSON.parse(body || "{}");
    const providers = reorderProviders(this.agent.root, data.order || []);
    this.agent.reloadProviders();
    this._json(res, 200, { ok: true, providers });
  } catch (e) {
    this._fail(res, e);
  }
  return true;
},

// ---- 通用设置 ----
async _apiSettings(req, res) {
  if (!this._requireAuth(req, res)) return true;
  if (req.method === "GET") {
    this._json(res, 200, { settings: getSettings(this.agent.root) });
    return true;
  }
  if (req.method !== "PUT") return false;
  // readonly 对称 (2026-11-14, 同 _apiProviders): 审查者不得经 REST 改设置
  if (this.agent?.readonly === true) {
    this._json(res, 403, { ok: false, error: "只读模式 (审查者) 不允许修改设置" });
    return true;
  }
  const body = await this._readBody(req, res);
  if (body === null) return true;
  try {
    ensureConfigDir(this.agent.root);
    const data = JSON.parse(body || "{}");
    const settings = updateSettings(this.agent.root, data.patch || {});
    this.agent.reloadSettings(); // 热重载: 用户名/安全/agent 预设立即生效
    // 设置变更影响权限/模型/安全面, 入审计链 (只记改动的键名, 不记值 —— 值可能含密钥)
    try {
      this.agent.audit?.appendEvent?.({
        event: "settings_updated",
        fields: { keys: Object.keys(data.patch || {}).slice(0, 20).join(","), ok: true },
      });
    } catch { /* 审计降级不阻断设置 */ }
    this._json(res, 200, { ok: true, settings });
  } catch (e) {
    this._fail(res, e);
  }
  return true;
},

// ---- LLM 运行时切换 (模型 / 思考强度) ----
// 状态视图: 当前实际生效的 provider+model、显式选择、候选列表 (含可用性)、语音能力
// 当前 provider 的上下文窗口 (表单可配, 兜底 8192) — 供前端算上下文占用百分比
_llmCtx(provs, providerId) {
  const p = provs.find((x) => x && x.id === providerId);
  return Number(p && p.context_window) || 0;
},

_llmState() {
  const cfg = this.agent.config || {};
  const cur = this.agent.llm || null;
  const provs = Array.isArray(cfg.providers) ? cfg.providers : [];
  return {
    provider: cfg.llm?.provider || "",
    reasoning: cfg.llm?.reasoning || "auto",
    reasoning_levels: REASONING_LEVELS,
    current: cur ? { id: cur.providerId, model: cur.model, vision: !!cur.vision, context_window: this._llmCtx(provs, cur.providerId) } : null,
    providers: provs.map((p) => ({
      id: p.id,
      model: p.model || "",
      vision: providerVision(p),
      context_window: Number(p.context_window) || 0,
      usable: isUsableProvider(p),
      current: !!(cur && cur.providerId === p.id),
    })),
    voice: voiceStatus(cfg),
  };
},

async _apiLlm(req, res) {
  if (req.method === "GET") {
    this._json(res, 200, { ok: true, ...this._llmState() });
    return true;
  }
  if (req.method !== "POST") { this._json(res, 405, { error: "方法不允许 (GET / POST)" }); return true; }
  const body = await this._readBody(req, res);
  if (body === null) return true;
  try {
    const p = JSON.parse(body || "{}");
    const patch = {};
    if (p.provider !== undefined) patch.provider = String(p.provider || "");
    if (p.reasoning !== undefined) patch.reasoning = String(p.reasoning || "auto");
    if (!Object.keys(patch).length) {
      this._json(res, 400, { error: "缺少可更新字段 (provider / reasoning)" });
      return true;
    }
    updateSettings(this.agent.root, { llm: patch });
    this.agent.reloadProviders(); // 重建 LLM 客户端 (新 provider/思考强度立即生效)
    this._json(res, 200, { ok: true, ...this._llmState() });
  } catch (e) { this._fail(res, e, 400); }
  return true;
},

// ---- 语音输入 (Web UI 麦克风): 录音 → ASR 转写 ----
// 请求体 JSON { name, data(base64), language? }; 体积上限放宽到 20MB (音频比图片大)
// 2026-11-14: 统一走 transcribeAudio (云优先, 本地 whisper 兜底) —— 与 voice_transcribe 工具同一实现
async _apiVoiceTranscribe(req, res) {
  const raw = await readBody(req, { maxBytes: 20 * 1024 * 1024 });
  if (raw === null) { this._json(res, 413, { error: "音频过大 (上限 20MB)" }); return true; }
  const cfg = this.agent.config || {};
  let tmpPath = "";
  try {
    const p = JSON.parse(raw || "{}");
    const name = String(p.name || "audio.wav").replace(/[^\w.-]+/g, "_").slice(-60) || "audio.wav";
    const ext = (path.extname(name) || ".wav").toLowerCase();
    if (![".wav", ".mp3", ".m4a", ".mp4", ".webm", ".ogg", ".opus", ".flac"].includes(ext)) {
      this._json(res, 400, { error: "不支持的音频格式 (wav/mp3/m4a/webm/ogg/flac)" });
      return true;
    }
    const buf = Buffer.from(String(p.data || "").replace(/^data:[^,]*,/, ""), "base64");
    if (!buf.length) { this._json(res, 400, { error: "音频为空" }); return true; }

    if (!resolveVoice(cfg, "asr") && !resolveLocalAsr(cfg)) {
      this._json(res, 400, {
        error: "ASR 未配置: 需在 config/ppx.json 的 voice.asr 设 base_url + api_key (OpenAI 兼容 /audio/transcriptions), 或 backend=local + bin (外部 whisper 二进制)",
      });
      return true;
    }
    const dir = path.join(this.agent.root, "uploads");
    ensureDir(dir);
    tmpPath = path.join(dir, `asr-${Date.now()}-${name}`);
    fs.writeFileSync(tmpPath, buf);
    const r = await transcribeAudio(cfg, tmpPath, p.language || "");
    this._json(res, 200, { ok: true, text: String(r.text || "").trim(), engine: r.engine });
  } catch (e) {
    this._fail(res, e, 502); /* swallowed-ok(2026-11-03): 错误已回 502 给客户端 */
  } finally {
    if (tmpPath) { try { fs.unlinkSync(tmpPath); } catch { /* 临时音频清理失败不阻断 */ } }
  }
  return true;
},

// ---- 工作区 ----
_apiWorkspaceTree(res, req) {
  try {
    const u = new URL(req.url, "http://127.0.0.1");
    const wsRoot = path.resolve(this.agent.root);
    const { tree, truncated, maxDepth, baseDir } = buildTree(wsRoot, {
      root: u.searchParams.get("root") || "",
      maxDepth: u.searchParams.get("maxDepth") || 3,
    });
    this._json(res, 200, {
      ok: true, root: wsRoot, dir: baseDir, maxDepth, truncated,
      tree: tree || { name: "", path: "", type: "dir", children: [] },
    });
  } catch (e) {
    this._fail(res, e);
  }
  return true;
},

_apiWorkspaceRead(res, req) {
  try {
    const u = new URL(req.url, "http://127.0.0.1");
    const out = readWorkspaceFile(path.resolve(this.agent.root), u.searchParams.get("path") || "");
    this._json(res, 200, { ok: true, ...out });
  } catch (e) {
    this._fail(res, e);
  }
  return true;
}
};

import { noteCatch } from "../utils/catch-log.js";
// src/llm/local-discover.js - 本机模型服务自动发现 (2026-11-02)
//
// 动机: 接一个本地模型原来要手填 base_url、模型名、上下文窗口、最大输出四样 ——
//   其中模型名拼错、max_output 填小 (如 120) 不会报错, 只会在对话里变成空回复。
//   这里把"本机有谁在跑、跑的是什么模型、窗口多大"直接从服务端读出来, 前端只负责点选。
//
// 边界:
//   · 只探测 127.0.0.1 的固定端口表 (可传 ports 覆盖, 仍是环回), 不接受任意主机 ——
//     否则就成了内网端口扫描器 (与 fetch-models 的 SSRF 守卫同一顾虑)。
//   · 先不带 Key 探一次, 只在 401/403 时才用用户给的 Key 重试 —— 避免把密钥发给
//     本机无关服务 (IM 网关、代理面板等同样监听在 127.0.0.1)。
//   · 只读 /models 与厂商原生元数据, 不加载/切换/下载任何模型。
const LOOPBACK = "127.0.0.1";

// 常见本地推理服务的默认端口 (加新服务只改这张表)
const LOCAL_CANDIDATES = [
  { port: 1234, kind: "lmstudio", name: "LM Studio" },
  { port: 11434, kind: "ollama", name: "Ollama" },
  { port: 8000, kind: "vllm", name: "vLLM" },
  { port: 8080, kind: "llamacpp", name: "llama.cpp / LocalAI" },
  { port: 1337, kind: "jan", name: "Jan" },
  { port: 5000, kind: "textgen", name: "text-generation-webui" },
];

const EMBED_RE = /embed|bge-|e5-|nomic-embed/i;

function baseOf(port) { return `http://${LOOPBACK}:${port}/v1`; }

function candidateList(ports) {
  if (!Array.isArray(ports) || !ports.length) return LOCAL_CANDIDATES;
  const want = new Set(ports.map(Number).filter((p) => Number.isInteger(p) && p >= 1024 && p <= 65535));
  const known = LOCAL_CANDIDATES.filter((c) => want.has(c.port));
  for (const p of want) if (!known.some((c) => c.port === p)) known.push({ port: p, kind: "custom", name: `本地服务 :${p}` });
  return known.slice(0, 10); // 上限 10 个, 防一次请求打太多端口
}

async function getJson(url, apiKey, timeoutMs) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const headers = apiKey ? { Authorization: `Bearer ${apiKey}` } : {};
    const r = await fetch(url, { headers, signal: ctrl.signal });
    const text = await r.text().catch(() => "");
    let data = null;
    try { data = JSON.parse(text); } catch (e) { noteCatch(e); /* 非 JSON (HTML 错误页等) 按无数据处理 */ }
    return { status: r.status, ok: r.ok, data };
  } catch {
    return { status: 0, ok: false, data: null }; // 连接拒绝/超时 = 该端口没服务 /* swallowed-ok(2026-11-03): 探测语义 */
  } finally {
    clearTimeout(t);
  }
}

// 上下文窗口 → 单次输出上限的建议值。本地小模型常见 max_output 填成几百,
// 推理型模型会把这些 token 全花在思考上, 正文为空 —— 这里给一个不会把自己饿死的默认。
export function suggestMaxOutput(contextWindow) {
  const ctx = Number(contextWindow) || 0;
  if (!ctx) return 4096;
  if (ctx >= 16384) return 8192;
  if (ctx >= 8192) return 4096;
  if (ctx >= 4096) return 2048;
  return Math.max(256, Math.floor(ctx / 4));
}

// LM Studio 原生元数据 → 统一模型条目 (纯函数, 便于测试映射规则)
export function mapLmStudioModels(list) {
  const out = {};
  for (const m of Array.isArray(list) ? list : []) {
    if (!m || !m.id) continue;
    const ctx = Number(m.loaded_context_length) || Number(m.max_context_length) || null;
    const vision = m.type === "vlm" || (Array.isArray(m.capabilities) && m.capabilities.includes("vision"));
    out[m.id] = {
      context_window: ctx,
      max_output: suggestMaxOutput(ctx),
      inputs: vision ? ["text", "image"] : ["text"],
      loaded: m.state === "loaded",
      embedding: m.type === "embeddings",
    };
  }
  return out;
}

// LM Studio 原生元数据 (/api/v0/models): 窗口、加载态、模型类型、能力。
// 这是唯一能拿到"实际加载窗口"的来源 —— loaded_context_length 通常小于训练窗口。
async function lmStudioMeta(port, apiKey, timeoutMs) {
  const res = await getJson(`http://${LOOPBACK}:${port}/api/v0/models`, apiKey, timeoutMs);
  return mapLmStudioModels(res.ok ? res.data?.data : []);
}

// Ollama: /api/ps 给出已加载模型 (无需 Key), 只用来标"已加载", 窗口沿用兜底
async function ollamaMeta(port, timeoutMs) {
  const res = await getJson(`http://${LOOPBACK}:${port}/api/ps`, "", timeoutMs);
  const list = res.ok && Array.isArray(res.data?.models) ? res.data.models : [];
  const out = {};
  for (const m of list) {
    const id = m?.name || m?.model;
    if (id) out[id] = { loaded: true };
  }
  return out;
}

async function probeCandidate(cand, apiKey, timeoutMs) {
  const base = baseOf(cand.port);
  let res = await getJson(`${base}/models`, "", timeoutMs);
  let needsKey = false;
  if ((res.status === 401 || res.status === 403) && apiKey) {
    res = await getJson(`${base}/models`, apiKey, timeoutMs);
    needsKey = true;
  }
  if (res.status === 401 || res.status === 403) {
    return { port: cand.port, kind: cand.kind, name: cand.name, base_url: base, status: "auth", models: [] };
  }
  if (!res.ok || !res.data) return null; // 不是模型服务 / 没在跑
  const ids = (Array.isArray(res.data.data) ? res.data.data : [])
    .map((m) => (typeof m === "string" ? m : m && m.id)).filter(Boolean);
  if (!ids.length) return null;

  let meta = {};
  if (cand.kind === "lmstudio") meta = await lmStudioMeta(cand.port, apiKey, timeoutMs);
  else if (cand.kind === "ollama") meta = await ollamaMeta(cand.port, timeoutMs);

  const models = [];
  for (const id of ids) {
    const m = meta[id] || {};
    if (m.embedding || EMBED_RE.test(id)) continue; // 嵌入模型不能当对话模型
    models.push({
      id,
      label: id,
      context_window: m.context_window || null,
      max_output: m.max_output || null,
      inputs: m.inputs || ["text"],
      loaded: m.loaded === true,
    });
  }
  return {
    port: cand.port, kind: cand.kind, name: cand.name, base_url: base, status: "ok",
    needs_key: needsKey, models, meta_source: cand.kind === "lmstudio" && Object.keys(meta).length ? "lmstudio-native" : "models",
  };
}

// 扫描本机固定端口表; servers 只含真正在提供模型的端点, auth 表示"在跑但要 Key"。
export async function discoverLocalServers({ apiKey = "", ports = null, timeoutMs = 1500 } = {}) {
  const cands = candidateList(ports);
  const out = await Promise.all(cands.map((c) => probeCandidate(c, apiKey, timeoutMs)));
  const servers = out.filter(Boolean);
  return {
    servers,
    scanned: cands.map((c) => c.port),
    needs_key: servers.some((s) => s.status === "auth"),
  };
}

// fetch-models 的元数据补全: 远端目录只有 id, 本地服务还能多给窗口/能力。
// 只对环回地址尝试原生接口, 远端站点点到为止 (不额外探测未知端点)。
export async function enrichModelsFromServer({ baseUrl, apiKey = "", models = [], timeoutMs = 1200 } = {}) {
  let u;
  try { u = new URL(String(baseUrl || "")); } catch { return models; /* swallowed-ok(2026-11-03): URL 非法 → 不探测 */ }
  const host = u.hostname.toLowerCase();
  if (!(host === "127.0.0.1" || host === "localhost" || host === "::1")) return models;
  const port = Number(u.port) || (u.protocol === "https:" ? 443 : 80);
  const cand = LOCAL_CANDIDATES.find((c) => c.port === port);
  const kind = cand ? cand.kind : "custom";
  let meta = {};
  if (kind === "lmstudio") meta = await lmStudioMeta(port, apiKey, timeoutMs);
  else if (kind === "ollama") meta = await ollamaMeta(port, timeoutMs);
  if (!Object.keys(meta).length) return models;
  return models.map((m) => {
    const x = meta[m.id];
    if (!x) return m;
    return {
      ...m,
      context_window: m.context_window || x.context_window || null,
      max_output: m.max_output || x.max_output || null,
      inputs: m.inputs || x.inputs || ["text"],
      loaded: x.loaded === true,
    };
  });
}

// src/llm/router.js - 模型路由 (provider 选择中枢, 唯一真相源)
// 目标: "本地默认优先, 云端可自由接入"
//   - 占位死配置过滤: model 含 REPLACE_WITH_YOUR_ENDPOINT 等占位符的 provider 视为不可用(省得误选+报噪音警告)
//   - 本地优先(默认): 本地测试直接用本地模型 (lmstudio/ollama, 127.0.0.1 即零配置可用), 配真实云端 key 也先走本地
//   - 云端优先(可选): 设 agent.model_preference=cloud → 配真 key 的云端排前 (深度/智谱/千问/火山/OpenAI), 本地兜底
//   - 健康排序: 启动时异步探测各 provider /models, 能连的排前, 连不上自动降级
// 用法 (与旧 builtin.resolveLLM 同签名, 向后兼容):
//   const llm = resolveLLM(config);            // 同步选择主 LLM
//   const all = resolveAllLLMs(config);        // 全量可用 provider
//   const ok  = isUsableProvider(prov);         // 是否可用(过滤占位符)
//   const candid = await orderByHealth(all);    // 异步健康排序(可选, 给启动探测用)
import { LLMClient } from "./client.js";

// 占位符识别: 用户没填的 model/endpoint/key 标记 (OpenAI-cli 模板常留 REPLACE_WITH_YOUR_*)
const PLACEHOLDER_RE = /REPLACE_WITH_YOUR_|YOUR_ENDPOINT|YOUR_API_KEY|sk-xxx|<your_/i;
// 本地推理服务地址特征
const LOCAL_HOST_RE = /127\.0\.0\.1|localhost|lm-studio|ollama/i;

function hasRealKey(p) {
  // 显式 api_key 且非占位 -> 真 key
  if (p.api_key && !PLACEHOLDER_RE.test(String(p.api_key))) return true;
  // env 引用且 env 里设了非空值 -> 真 key
  if (p.api_key_env && process.env[p.api_key_env]) {
    const v = String(process.env[p.api_key_env]);
    return !!v && !PLACEHOLDER_RE.test(v);
  }
  return false;
}

function isLocal(p) {
  return LOCAL_HOST_RE.test(String(p.base_url || ""));
}

function isOpenclaw(p) {
  return p.backend === "openclaw" || p.id === "openclaw";
}
function isDeepseek(p) {
  return p.backend === "deepseek" || p.backend === "dsh" || p.id === "dsh";
}

// 占位符过滤 + 可用判定 (与旧 isUsableProvider 同语义, 增加占位符排除)
export function isUsableProvider(prov) {
  if (!prov) return false;
  // 占位 model 的死配置直接判不可用 (volcengine 的 REPLACE_WITH_YOUR_ENDPOINT 等)
  if (PLACEHOLDER_RE.test(String(prov.model || ""))) return false;
  if (hasRealKey(prov)) return true;          // 云端真 key
  if (isLocal(prov)) return true;              // 本地推理零配置可用
  if (isOpenclaw(prov) || isDeepseek(prov)) return true; // 外部引擎底座
  return false;
}

// 排序: 按 agent.model_preference 决定本地/云端谁优先 (默认 local)
//   - local:  本地优先(lmstudio/ollama) > 外部引擎 > 云端真key   [本地测试默认]
//   - cloud:  云端真key优先 > 外部引擎 > 本地兜底              [正式发布可配]
// 健康状态排序由 orderByHealth 异步完成; 这里是"无探测时代理"的基础排序
function orderProviders(provs, preference) {
  const cloud = provs.filter((p) => hasRealKey(p) && !isLocal(p));
  const engine = provs.filter((p) => isOpenclaw(p) || isDeepseek(p));
  const local = provs.filter((p) => isLocal(p)); // 本地服务都收 (lmstudio 常带字面 api_key, 仍零配置)
  return preference === "cloud" ? [...cloud, ...engine, ...local] : [...local, ...engine, ...cloud];
}

export function resolvePreference(config) {
  return (config?.agent?.model_preference === "cloud") ? "cloud" : "local";
}

export function resolveAllLLMs(config) {
  const provs = (config && config.providers) || [];
  const pref = resolvePreference(config);
  return orderProviders(provs.filter(isUsableProvider), pref).map((p) => new LLMClient(p));
}

export function resolveLLM(config) {
  const provs = (config && config.providers) || [];
  // 强制指定: PPX_PROVIDER=<id> (测试/用户显式选择)
  const forced = process.env.PPX_PROVIDER;
  if (forced) {
    const t = provs.find((x) => x.id === forced || x.id === String(forced).toLowerCase());
    if (t && isUsableProvider(t)) return new LLMClient(t);
  }
  const pref = resolvePreference(config);
  const ordered = orderProviders(provs.filter(isUsableProvider), pref);
  return ordered.length ? new LLMClient(ordered[0]) : null;
}

// 异步健康排序: 启动时探测各候选 /models, 能连的排前 (只读, 不改配置)
// returns: [{ client, health }] 按健康排序; 全部失败则保持原顺序 (兜底不报死)
export async function orderByHealth(clients, { probeMs = 4000 } = {}) {
  if (!clients || !clients.length) return [];
  const states = await Promise.all(clients.map(async (c) => {
    try { return { client: c, ok: typeof c.health === "function" ? await c.health() : true }; }
    catch { return { client: c, ok: false }; }
  }));
  const healthy = states.filter((s) => s.ok).map((s) => s.client);
  const unwell = states.filter((s) => !s.ok).map((s) => s.client);
  // 健康的保持原云/本地顺序, 不健康排最后 (不丢弃, 让运行时 fallback 继续尝试)
  return [...healthy, ...unwell];
}
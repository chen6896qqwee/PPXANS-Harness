// src/web/readiness.js - 首启就绪判定 (GET /api/readiness)
//
// 为什么要有这个接口 (2026-11-08):
//   以前「用户配没配好模型」这件事只存在浏览器 localStorage 的一个布尔标记里
//   (ppx_onboarded_v1)。换机器、清缓存、改配置都不会让它自愈 —— 要么反复弹引导,
//   要么永远不弹。就绪状态必须由后端算: 它知道配置文件里到底有没有可用的 key。
//
// 判定口径 (故意宽松, 宁可放行也不误报"没配"):
//   可用 provider = enabled !== false 且满足任一条
//     · api_key_set    配置文件里有明文/加密后的 key
//     · api_key_env    声明的环境变量此刻真的有值
//     · base_url 指向本机 (LM Studio / Ollama / vLLM 通常不需要 key)
//   只做静态判定, 不发起网络请求 —— 那是「探活」按钮的事, 首屏不该等网络。
import fs from "node:fs";
import path from "node:path";
import { listProviders } from "../config/providers.js";

function isLocalUrl(url) {
  return /(^|\/\/)(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])(:|\/|$)/i.test(String(url || ""));
}

function usableProvider(p) {
  if (!p || p.enabled === false) return false;
  if (p.api_key_set) return true;
  if (p.api_key_env && process.env[p.api_key_env]) return true;
  return isLocalUrl(p.base_url);
}

function buildReadiness(channel) {
  const agent = (channel && channel.agent) || {};
  const root = String(agent.root || process.cwd());

  let providers = [];
  try {
    providers = listProviders(root) || [];
  } catch {
    providers = [];
  }

  const picked = providers.find(usableProvider) || null;
  const model = {
    ready: !!picked,
    provider: picked ? picked.id || null : null,
    model: picked ? picked.model || null : null,
    total: providers.length,
    // 给界面的下一步提示: 没有 provider / 有 provider 但都没 key, 说法不一样
    reason: picked ? "" : (providers.length ? "有配置但缺可用的 API Key" : "还没有任何模型配置"),
  };

  let writable = false;
  try {
    fs.accessSync(root, fs.constants.W_OK);
    writable = true;
  } catch {
    writable = false;
  }

  const workspace = {
    ready: writable,
    root,
    name: path.basename(root) || root,
  };

  return {
    ok: true,
    ts: new Date().toISOString(),
    // 能开始干活的最低条件: 模型可用。工作区不可写单独报, 不挡住首屏。
    ready: model.ready,
    model,
    workspace,
  };
}

export function handleReadiness(channel, req, res, reqPath) {
  if (req.method !== "GET" || reqPath !== "/api/readiness") return false;
  try {
    channel._json(res, 200, buildReadiness(channel), { "Cache-Control": "no-store" });
  } catch (e) {
    channel._json(res, 500, { ok: false, error: String((e && e.message) || e) });
  }
  return true;
}

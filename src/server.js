#!/usr/bin/env node
// src/server.js - 皮皮虾 HTTP 服务入口
// 提供: /health, /message (HTTP通道), /feishu/webhook, /wechat/webhook
// 通道统一走 ChannelManager 注册表: connect + webhook 挂载由各通道 mount() 完成
import { ensureUTF8Console } from "./utils/winutf8.js";
import { PPXAgent } from "./agent/index.js";
import { ChannelManager } from "./channels/index.js";

ensureUTF8Console();
export async function startServer({ root = process.cwd(), port = 8899, host = "127.0.0.1", config = {}, llm = null } = {}) {
    const agent = new PPXAgent({ root });
  if (llm) {
    // 测试注入 stub LLM, 避免依赖真实网络; 同步把 allProviders 替换为同源 stub,
    // 让 /api/providers/test 等"按 id 取客户端"的路径也能命中 stub
    agent.llm = llm;
    if (Array.isArray(agent.allProviders)) agent.allProviders = [llm];
  }

  // 统一走注册表: HTTP 通道始终启动 (port/host 参数覆盖配置), 其余按 config.channels
  // 基础配置来自 agent.config (config/ppx.json 加载的), 调用方传入的 config.channels 只做覆盖
  const baseChannels = agent.config.channels || {};
  const channelsCfg = { ...baseChannels, ...((config.channels) || {}) };
  channelsCfg.http = { ...(channelsCfg.http || {}), enabled: true, port, host }; // port/host 参数最高优先级
  const manager = new ChannelManager(agent, channelsCfg);
  await manager.start();

  // 主动提醒 → 广播到所有已启用通道 (agent.proactive.enabled 才接; 默认关不打扰)
  if (agent.config.agent?.proactive?.enabled) {
    agent.startProactiveTicker((payload) => manager.broadcast(payload.text));
  }

  const server = manager.httpServer;
  return {
    agent,
    server,
    http: manager.get("http"),
    feishu: manager.get("feishu"),
    wechat: manager.get("wechat"),
    manager,
  };
}

// CLI 启动公共逻辑: 供 bin/ppx-serve 与 src/server.js 直接运行共用
export async function runServer({ root = process.cwd(), port = Number(process.env.PPX_PORT || 8899) } = {}) {
  const { agent, server, manager } = await startServer({ root, port });
  console.log(`皮皮虾 服务已启动: http://127.0.0.1:${port}`);
  console.log(`  /health   健康检查`);
  console.log(`  /message  HTTP 对话通道 (POST {message})`);
  console.log(`  通道: ${manager.list().filter((c) => c.enabled).map((c) => c.name).join(", ") || "(无)"}`);
  console.log(`  工具: ${agent.tools.list().join(", ")}`);
  console.log("  Ctrl+C 退出");
  process.on("SIGINT", () => { agent.shutdown(); process.exit(0); });
  return { agent, server, manager };
}

// 直接运行 (node src/server.js, scripts/start-web.js)
const _entry = (process.argv[1] || "").replace(/\\/g, "/");
if (_entry.endsWith("src/server.js")) {
  await runServer({ root: process.cwd() });
}

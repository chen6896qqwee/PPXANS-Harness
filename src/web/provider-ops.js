// src/web/provider-ops.js - 提供方探测的单一实现 (2026-11-14, REST/MCP admin 双轨收敛轮)
//
// REST POST /api/providers/test 与 MCP ppx.providers.test 的共享内核:
//   兜底顺序 allProviders → agent.llm → 磁盘配置临时构造, 探活走 client.health()
//   (与 ppx setup 探活同一函数, 路径/鉴权头由协议适配器按 protocol 生成)。
// 此前两处各写一份, detail 文案漂移 (REST "复用 agent 客户端…" vs MCP "API 端点可达")。
// 口径: 不回显任何密钥材料; 信封由调用方各自包装 (REST 200 JSON / MCP JSON-RPC)。
import { readConfig } from "../config/providers.js";

export async function testProviderClient(agent, id) {
  let client = (agent.allProviders || []).find((c) => c.providerId === id);
  let fromCache = !!client;
  if (!client && agent.llm && agent.llm.providerId === id) {
    client = agent.llm;
    fromCache = true;
  }
  if (!client) {
    const { providers } = readConfig(agent.root);
    const p = providers.find((x) => x.id === id);
    if (!p) throw new Error("提供方不存在");
    // LLM 客户端按需加载 (避免把网络栈带进未使用该端点的进程)
    const { LLMClient } = await import("../llm/client.js");
    client = new LLMClient(p);
  }
  const healthy = await client.health();
  const detail = healthy
    ? (fromCache ? "复用 agent 客户端, 探测通过" : "API 端点可达")
    : "探测失败, 请检查 key/base_url";
  return { ok: true, healthy, detail, source: fromCache ? "agent-cache" : "disk-config" };
}

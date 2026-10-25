// test/pii-reply-mask.test.js — PII 回复掩码守卫 (2026-10-09, 生产分层采样评测发现)
// 场景: 用户在对话中给出 PII, memory 类工具/store 后回复原文回显 —— 合规敏感部署需掩码。
// 策略: security.pii_reply_mask (默认 false 不破坏开发工作流; 对外服务显式开启)。
import { test } from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { PPXAgent } from "../src/agent/index.js";

function makeAgent(extraConfig, root) {
  fs.mkdirSync(path.join(root, "config"), { recursive: true });
  fs.writeFileSync(path.join(root, "config", "ppx.json"), JSON.stringify({
    providers: [],
    agent: { localIntent: false, proactive: { enabled: false }, ...(extraConfig.agent || {}) },
    security: { ...(extraConfig.security || {}) },
  }), "utf8");
  const agent = new PPXAgent({
    root,
    configFile: path.join(root, "config", "ppx.json"),
    dataDir: path.join(root, ".ppx"),
    globalDataDir: path.join(root, ".ppx-global"),
  });
  // 桩 LLM: 回复里带 PII 原文 (形状对齐 runToolLoop 消费口径: resp.message 直读)
  agent.llm = {
    model: "stub-pii",
    backend: "http",
    vision: false,
    supportsNativeToolCalls: true,
    health: async () => true,
    chat: async () => ({ content: "已记录: 邮箱 zhangsan@example.com", usage: { total_tokens: 1 } }),
    apiChat: async () => ({
      message: { role: "assistant", content: "已记录: 邮箱 zhangsan@example.com", tool_calls: null },
      usage: { total_tokens: 10 },
    }),
  };
  agent.allProviders = [agent.llm];
  return agent;
}

test("pii_reply_mask=false (默认) → 回复保持原文 (开发工作流不破坏)", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ppx-pii-off-"));
  const agent = makeAgent({}, root);
  const reply = await agent.chat("记住我的邮箱 zhangsan@example.com");
  assert.match(reply, /zhangsan@example\.com/, "默认不掩码");
});

test("pii_reply_mask=true → 回复中 PII 被脱敏", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ppx-pii-on-"));
  const agent = makeAgent({ security: { pii_reply_mask: true } }, root);
  const reply = await agent.chat("记住我的邮箱 zhangsan@example.com");
  assert.doesNotMatch(reply, /zhangsan@example\.com/, "原文不得出现在回复");
  assert.match(reply, /\[REDACTED\]/, "应显示脱敏占位");
});

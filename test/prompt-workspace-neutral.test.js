// test/prompt-workspace-neutral.test.js — 缓存中立工作目录模式
// 默认 absolute 模式保留绝对路径（旧行为/旧测试不变）；
// 设置 PPX_PROMPT_WORKSPACE_MODE=neutral 或 config.agent.workspace_prompt_mode="neutral"
// 时，system prompt 不写入机器绝对路径，换取跨机器/跨工作目录 provider 前缀缓存可共享。
import test from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PPXAgent } from "../src/agent/index.js";

const mk = (tag) => fs.mkdtempSync(path.join(os.tmpdir(), `ppx-prompt-neutral-${tag}-`));
const agentAt = (root, configFile = null) => new PPXAgent({ root, configFile, dataDir: path.join(root, ".ppx") });

test("neutral env 模式: 不写绝对 root, 保留纪律句与稳定占位", () => {
  const root = mk("env");
  process.env.PPX_PROMPT_WORKSPACE_MODE = "neutral";
  const agent = agentAt(root);
  try {
    const p = agent._workspacePrompt();
    assert.ok(p.includes("【工作目录】"), "应注入工作目录段");
    assert.ok(!p.includes(path.resolve(root)), "neutral 模式不应包含绝对 root");
    assert.ok(p.includes("当前工作目录"), "应包含稳定占位说明");
    assert.match(p, /read_file \/ search_files \/ list_dir/, "仍应给出定位文件的手段");
    assert.ok(p.includes("不要向用户反问路径"), "仍应禁止反问路径");
    assert.match(p, /改文件前先 read_file/, "仍应先读后改");
  } finally {
    delete process.env.PPX_PROMPT_WORKSPACE_MODE;
    agent.shutdown();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("neutral config 模式: 通过 config 文件同样生效", () => {
  const root = mk("cfg");
  const cfgDir = mk("cfgdir");
  const cfgPath = path.join(cfgDir, "ppx.json");
  fs.writeFileSync(cfgPath, JSON.stringify({ agent: { workspace_prompt_mode: "neutral" } }));
  const agent = agentAt(root, cfgPath);
  try {
    const p = agent._workspacePrompt();
    assert.ok(!p.includes(path.resolve(root)), "config neutral 不应包含绝对 root");
    assert.ok(p.includes("当前工作目录"), "应包含稳定占位说明");
  } finally {
    agent.shutdown();
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(cfgDir, { recursive: true, force: true });
  }
});

test("默认 absolute 模式不受影响", () => {
  const root = mk("default");
  const agent = agentAt(root);
  try {
    assert.ok(agent._workspacePrompt().includes(path.resolve(root)), "默认模式应保留绝对 root");
    assert.equal(agent.config.agent.workspace_prompt_mode, "absolute", "默认配置应为 absolute");
  } finally {
    agent.shutdown();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
// test/context-overflow.test.js - 上下文溢出防护 (第九轮 review P1)
// 覆盖: _isOverflowError 判定 / _histTokenCap 窗口感知预算 /
//       _trimHistory+_ensureContextFit 硬裁剪兜底 / _shrinkMessagesForOverflow 消息完整性 /
//       _llmWithTools 溢出降档自动重试
import { test } from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PPXAgent, _isOverflowError } from "../src/agent/index.js";

function mkAgent() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ppx-ctxof-"));
  fs.mkdirSync(path.join(dir, "config"), { recursive: true });
  fs.writeFileSync(path.join(dir, "config", "ppx.json"), JSON.stringify({ providers: [], security: { allow_all: true } }));
  const a = new PPXAgent({ root: dir, dataDir: path.join(dir, "data"), globalDataDir: path.join(dir, "data") });
  return { a, dir };
}
const cleanup = (d) => { try { fs.rmSync(d, { recursive: true, force: true }); } catch {} };

test("溢出判定: 识别常见溢出措辞, 不误判普通 400 / AbortError", () => {
  assert.ok(_isOverflowError(new Error("messages: This model's maximum context length is 4096 tokens")), "max context length");
  assert.ok(_isOverflowError(new Error("Context size exceeded")), "Context size exceeded");
  assert.ok(_isOverflowError(new Error("OpenAI: This request exceeds the maximum token limit")), "token limit");
  assert.ok(_isOverflowError({ status: 413, message: "content too large" }), "413 请求体过大");
  // 不应误判
  assert.ok(!_isOverflowError(new Error("server returned 500")), "500 非溢出");
  assert.ok(!_isOverflowError(new Error("400 bad request syntax")), "普通 400 非溢出");
  const abort = new Error("aborted"); abort.name = "AbortError";
  assert.ok(!_isOverflowError(abort), "AbortError (用户取消/超时) 非溢出, 沿用不重试约定");
  assert.ok(!_isOverflowError(null), "空错误");
});

test("窗口感知预算: 按 provider context_window 收紧历史预算", () => {
  const { a, dir } = mkAgent(); try {
    a.llm = { context_window: 4096 };
    assert.equal(a._histTokenCap(), Math.floor(4096 * 0.6));
    a.llm = { context_window: 8192 };
    assert.equal(a._histTokenCap(), Math.floor(8192 * 0.6));
    a.llm = { context_window: 0 }; // 异常为 0 → 回退默认 8192
    assert.equal(a._histTokenCap(), Math.floor(8192 * 0.6));
    // config 覆盖作用窗口时生效
    a.config.memory.context_window_ratio = 0.5;
    assert.equal(a._histTokenCap(), Math.floor(8192 * 0.5));
  } finally { cleanup(dir); }
});

test("硬裁剪兜底: 即使预算配置极大也压回窗口安全比例 (不依赖 LLM)", () => {
  const { a, dir } = mkAgent(); try {
    a.llm = { context_window: 2000 };
    // 塞 20 条长历史
    const hist = Array.from({ length: 20 }, (_, i) => ({ role: "user", content: "第" + i + "条." + "x".repeat(300) }));
    const out = a._ensureContextFit(hist);
    const maxItems = Number(a.config.memory.max_history_items) || 40;
    assert.ok(out.length <= maxItems, "条数兜底");
    const total = out.reduce((s, m) => s + Math.ceil(String(m.content).length / 1.6), 0);
    assert.ok(total <= a._histTokenCap(), `历史总 token 应在窗口比例内, 实际 ${total} vs ${a._histTokenCap()}`);
    assert.equal(out[out.length - 1], hist[hist.length - 1], "必保最近一条");
  } finally { cleanup(dir); }
});

test("溢出降档: 保留 system + 最后 user 起完整单元(含 in-flight 工具配对), 只剪中间历史", () => {
  const { a, dir } = mkAgent(); try {
    const messages = [
      { role: "system", content: "sys 角色" },
      ...Array.from({ length: 6 }, (_, i) => ({ role: "user", content: "旧历史" + i })),
      { role: "user", content: "当前问题" },
    ];
    const out = a._shrinkMessagesForOverflow(messages, 400);
    assert.equal(out[0].role, "system");
    assert.equal(out[out.length - 1].content, "当前问题", "必保最后 user");
    // 历史被裁剪到预算内
    const total = out.reduce((s, m) => s + Math.ceil(String(m.content).length / 1.6), 0);
    assert.ok(total <= 400, "重建后应落在预算内");
  } finally { cleanup(dir); }
});

test("溢出降档-工具配对完整: 不剪成孤立 tool 消息", () => {
  const { a, dir } = mkAgent(); try {
    const messages = [
      { role: "system", content: "sys" },
      { role: "user", content: "启动" },
      { role: "assistant", content: null, tool_calls: [{ id: "t1" }] },
      { role: "tool", tool_call_id: "t1", content: "结果" },
    ];
    const out = a._shrinkMessagesForOverflow(messages, 200);
    // 最后 user("启动") 起(含)的 assistant tool_calls + tool 必须完整保留
    assert.ok(out.some((m) => m.role === "tool"), "tool 配对不丢失");
    const lastTool = out[out.length - 1];
    assert.equal(lastTool.role, "tool", "末尾保持 in-flight 工具消息");
  } finally { cleanup(dir); }
});

test("集成: _llmWithTools 首次溢出 → 降档重试成功返回", async () => {
  const { a, dir } = mkAgent(); try {
    let calls = 0;
    const stub = {
      context_window: 2000,
      apiChat: async () => {
        calls++;
        if (calls === 1) {
          const e = new Error("This model's maximum context length is 2000 tokens");
          e.status = 400;
          throw e;
        }
        return { message: { role: "assistant", content: "降档后成功", tool_calls: null } };
      },
    };
    a.llm = stub;
    const r = await a._llmWithTools([{ role: "user", content: "问题" }], stub);
    assert.equal(r, "降档后成功");
    assert.equal(calls, 2, "溢出后应重试一次");
  } finally { cleanup(dir); }
});

test("集成: 非溢出错误不吞 (透传给 provider 回退/调用方)", async () => {
  const { a, dir } = mkAgent(); try {
    const stub = { context_window: 2000, apiChat: async () => { const e = new Error("boom"); e.status = 500; throw e; } };
    a.llm = stub;
    await assert.rejects(async () => a._llmWithTools([{ role: "user", content: "x" }], stub), /boom/);
  } finally { cleanup(dir); }
});
// test/tool-exposure-2026-10-30.test.js
// 工具曝光分层 (agent.tool_exposure) 回归: 默认不改变任何行为, 收窄后模型仍有明确的路拿回 schema。
// 这套守卫存在的理由: 工具 schema 是全仓最贵的固定开销 (实测 97 个 ≈ 12.6k tok/请求),
//   而真实轨迹里只有 ~30 个工具被用到。机制 (catalog.setExposure) 早就写好却零调用方,
//   接线时最容易出的错是"只藏不给路"—— 模型看得到名字却永远调不对参数, 比全量下发更糟。
import { test } from "node:test";
import assert from "node:assert";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import { PPXAgent } from "../src/agent/index.js";
import { CORE_TOOL_EXPOSURE, META_TOOLS_ALWAYS } from "../src/tools/index.js";

function makeAgent(exposure) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ppx-expo-"));
  const a = new PPXAgent({ root, configFile: null });
  if (exposure !== undefined) {
    a.config.agent.tool_exposure = exposure;
    a._applyToolExposure();
  }
  return a;
}

function cleanup(a) {
  try { a.shutdown?.(); } catch { /* 关闭失败不影响断言 */ }
  try { fs.rmSync(a.root, { recursive: true, force: true }); } catch { /* 临时目录清理失败忽略 */ }
}

test("默认 all: 全部工具下发 schema, system 里没有【按需工具】段 (行为不变)", () => {
  const a = makeAgent();
  try {
    const exposed = a.tools.toOpenAI();
    assert.ok(exposed.length > 60, `默认应下发全部工具, 实际 ${exposed.length}`);
    assert.deepEqual(a.tools.hiddenFromLLM(), [], "默认不应有隐藏工具");
    assert.equal(a._toolsPrompt(), "", "默认模式按需段必须是空串 (零 token)");
    assert.equal(a._context("你好").includes("【按需工具】"), false);
  } finally { cleanup(a); }
});

test("core: 只下发核心名单, 其余进【按需工具】名单 (升序) 且 system 可读", () => {
  const a = makeAgent("core");
  try {
    const exposed = a.tools.toOpenAI().map((t) => t.function.name);
    const hidden = a.tools.hiddenFromLLM();
    assert.ok(exposed.length <= CORE_TOOL_EXPOSURE.length, `下发数 ${exposed.length} 不应超过名单 ${CORE_TOOL_EXPOSURE.length}`);
    assert.ok(hidden.length > 30, `长尾工具应被降级, 实际 ${hidden.length}`);
    for (const n of exposed) assert.ok(CORE_TOOL_EXPOSURE.includes(n), `${n} 不在核心名单里却下发了`);
    // 名单内但当前未注册的工具 (如被裁剪的模块) 不该凭空出现
    assert.deepEqual(hidden, [...hidden].sort(), "名单必须恒升序 (前缀缓存契约)");
    const sys = a._context("你好");
    assert.ok(sys.includes("【按需工具】"), "system 必须告诉模型还有哪些工具");
    for (const n of hidden.slice(0, 5)) assert.ok(sys.includes(n), `隐藏工具 ${n} 的名字应出现在名单里`);
    assert.ok(sys.includes("tool_schema"), "必须指出取 schema 的方法");
  } finally { cleanup(a); }
});

test("core: tool_schema 能把被隐藏工具的完整 schema 取回来 (这不是死路)", async () => {
  const a = makeAgent("core");
  try {
    const hiddenName = a.tools.hiddenFromLLM()[0];
    assert.ok(hiddenName, "应有被隐藏的工具");
    const out = await a.tools.call("tool_schema", { name: hiddenName }, { agent: a });
    assert.ok(out.includes(`# ${hiddenName}`), "应返回该工具的标题");
    assert.ok(out.includes("参数定义"), "应返回参数定义");
    assert.ok(out.includes("\"properties\"") || out.includes("{}"), "应含 JSON Schema 主体");
  } finally { cleanup(a); }
});

test("tool_schema: 未知工具给可行动提示, 多名字一次取 (全量模式下同样可用)", async () => {
  const a = makeAgent();
  try {
    const out = await a.tools.call("tool_schema", { name: "read_file, no_such_tool_xyz" }, { agent: a });
    assert.ok(out.includes("# read_file"));
    assert.ok(out.includes("[未知工具]"), "未知工具必须明说, 不能静默返回空");
    assert.ok(/list_capabilities/.test(out), "应指路到 list_capabilities");
  } finally { cleanup(a); }
});

test("自定义名单: 自动并入元工具, 否则模型连怎么取 schema 都不知道", () => {
  const a = makeAgent(["read_file", "write_file"]);
  try {
    const exposed = a.tools.toOpenAI().map((t) => t.function.name);
    assert.ok(exposed.includes("read_file"));
    assert.ok(exposed.includes("write_file"));
    for (const meta of META_TOOLS_ALWAYS) {
      assert.ok(exposed.includes(meta), `自定义名单必须保留元工具 ${meta}`);
    }
  } finally { cleanup(a); }
});

test("非法配置回落 all (不因写错配置把工具全藏起来)", () => {
  const a = makeAgent("corree"); // 拼错
  try {
    assert.deepEqual(a.tools.hiddenFromLLM(), [], "未知取值必须按 all 处理");
  } finally { cleanup(a); }
});

test("收窄后固定开销显著下降 (按 token 计, 不是按工具数)", () => {
  const all = makeAgent();
  const core = makeAgent("core");
  try {
    const count = (a) => JSON.stringify(a.tools.toOpenAI()).length;
    const allLen = count(all);
    const coreLen = count(core);
    assert.ok(coreLen < allLen * 0.45, `core 的 schema 体积应降到 45% 以下, 实际 ${coreLen}/${allLen}`);
  } finally { cleanup(all); cleanup(core); }
});

test("system 段幂等: 同一 agent 连调两次 _context 逐字节一致 (前缀缓存契约)", () => {
  const a = makeAgent("core");
  try {
    assert.equal(a._context("同一个问题"), a._context("同一个问题"));
  } finally { cleanup(a); }
});

// test/verify.test.js - 技能入库验证闸门 (src/skills/verify.js)
// 验证: 1) 好技能通过 (结构完整 + 内容引用高频工具 + 轨迹背书足够)
//       2) 缺段落被拦  3) 没引用高频工具被拦  4) 轨迹不足被拦  5) 内容太短被拦
//       6) refineSkill 集成: 幻觉技能(rejected)不进 skills/ 目录
import test from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { verifySkill, requiredSections, groundedInTools } from "../src/skills/verify.js";
import { PPXAgent } from "../src/agent/index.js";

const GOOD = "## 流程\n1. 调用 read_file 读文件\n2. 检查路径\n## 反合理化\n偷懒=拒绝\n## 验证\n输出文件内容";
const GOOD_NO_VERIFY = "## 流程\n1. 调用 read_file 读文件\n## 反合理化\nx";

test("verify: 好技能全过 (结构 + 接地 + 轨迹)", () => {
  const r = verifySkill({
    name: "read_file",
    content: GOOD,
    hotTools: ["read_file"],
    okTraces: [{ tool: "read_file" }, { tool: "read_file" }, { tool: "get_time" }],
    minFreq: 2,
  });
  assert.equal(r.ok, true);
  assert.equal(r.matchedTool, "read_file");
  assert.equal(r.traceCount, 2);
});

test("verify: 缺 ## 验证 段落被拦", () => {
  const r = verifySkill({ name: "rf", content: GOOD_NO_VERIFY, hotTools: ["read_file"], okTraces: [{tool:"read_file"},{tool:"read_file"}], minFreq: 2 });
  assert.equal(r.ok, false);
  assert.match(r.reason, /验证/);
});

test("verify: 内容未引用高频工具被拦 (幻觉)", () => {
  const r = verifySkill({ name: "x", content: GOOD.replace("read_file","没提到的工具"), hotTools: ["read_file"], okTraces: [{tool:"read_file"},{tool:"read_file"}], minFreq: 2 });
  assert.equal(r.ok, false);
  assert.match(r.reason, /未引用/);
});

test("verify: 高频工具成功轨迹不足被拦", () => {
  const r = verifySkill({ name: "read_file", content: GOOD, hotTools: ["read_file"], okTraces: [{ tool: "get_time" }], minFreq: 2 });
  assert.equal(r.ok, false);
  assert.match(r.reason, /成功轨迹不足/);
});

test("verify: 内容太短 (只段落标题无实质) 被拦", () => {
  const r = verifySkill({ name: "rf", content: "## 流程\nx\n## 验证\ny", hotTools: ["read_file"], okTraces: [{tool:"read_file"},{tool:"read_file"}], minFreq: 2 });
  assert.equal(r.ok, false);
  assert.match(r.reason, /太短/);
});

test("refineSkill 集成: 幻觉技能被验证闸门拦截, 不进 skills/", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ppx-vg-" ));
  const a = new PPXAgent({ root, configFile: null });
  a.llm = { chat: async () => ({ content: JSON.stringify({ name:"halluc-sk", description:"d", content:"## 流程\n1. 第一步做操作A\n2. 第二步检查结果B是否正常\n3. 第三步输出最终C\n## 反合理化\n偷懒就拒绝\n## 验证\n完成时提供证据D" }) }) };
  // 内容不引用高频工具 read_file → 应被拦
  a.traces.read = () => [{ ok: true, tool: "read_file", result: "ok" }, { ok: true, tool: "read_file", result: "ok" }];
  const r = await a.refineSkill({ limit: 10, minFreq: 2 });
  assert.equal(r.created, 0);
  assert.equal(r.rejected, true);
  assert.match(r.reason, /未引用/);
  // skills/ 目录不存在即未落盘
  assert.equal(fs.existsSync(path.join(root, "skills")), false, "拦截后不应创建技能目录");
  a.shutdown(); fs.rmSync(root, { recursive: true, force: true });
});
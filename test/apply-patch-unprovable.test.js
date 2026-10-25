// test/apply-patch-unprovable.test.js — 无目标补丁从"死路审批"改为"可自纠的用法错误" (2026-10-05)
// 背景: "块无路径 + 无 args.path" 是模型最高频的 SR 写法 (真跑基准 fix-* 系列实测)。旧口径
// 把它和"补丁确实越界"压成同一个 ask → headless 进程给一句通用审批文案, 模型既无从改写也
// 换不了路子, 于是幻觉"已修复"收场。现拆三态: allow / escapes / unprovable ——
//   escapes   照旧升级审批 (一分不放宽);
//   unprovable 决策仍是 ask/deny (fail closed 不变), 但文案点名三种合法写法 + 复述收到的
//   前两行内容, headless 拒绝消息原样带给模型 (permissions modelHint → agent headless deny)。
import test from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { MISSING_TARGET_HELP, patchTargetPreview } from "../src/edit/editblock.js";
import { ToolCatalog } from "../src/tools/index.js";
import { registerV3Tools } from "../src/tools/v3.js";
import { createPermissionEngine, AskForApproval, SandboxPolicy } from "../src/permissions/index.js";
import { PPXAgent } from "../src/agent/index.js";
import { TOOL_ERROR_PREFIX } from "../src/tools/index.js";

const mk = (tag) => fs.mkdtempSync(path.join(os.tmpdir(), `ppx-upt-${tag}-`));
const eng = (root, extra = {}) => createPermissionEngine({
  approvalMode: AskForApproval.ON_REQUEST,
  sandbox: SandboxPolicy.WORKSPACE_WRITE,
  workspaceRoot: root,
  ...extra,
});
const cat = (root) => { const c = new ToolCatalog(); registerV3Tools(c, { rootDir: root }); return c; };

// 无路径 SR 块 (模型最高频写法): 块里没文件名, args 里也没 path
const SR_NOPATH = "<<<<<<< SEARCH\n  return a - b;\n=======\n  return a + b;\n>>>>>>> REPLACE";

// 三种约定的"点名"判据: path 参数 / SEARCH 上一行 / *** Update File: 表头
const namesAllThree = (t) =>
  /path/.test(t) && /<<<<<<< SEARCH|SEARCH/.test(t) && /上一行/.test(t) && /\*\*\* Update File:/.test(t);

// ---- (1) 权限三态: unprovable 仍是 ask, 但文案可行动 ----
test("unprovable 补丁: 决策仍 ask (fail closed 不变), reason+modelHint 点名三种写法并复述收到的内容", async () => {
  const root = mk("tri");
  try {
    const e = eng(root);
    const d = await e.check("apply_patch", { content: SR_NOPATH });
    assert.equal(d.decision, "ask", "落点不可证明永远不许 allow");
    assert.ok(namesAllThree(d.reason), `reason 应点名三种合法写法: ${d.reason}`);
    assert.match(d.reason, /return a - b;/, "reason 应含实际收到的 content 摘录");
    assert.ok(d.modelHint && namesAllThree(d.modelHint), "headless 用的 modelHint 同样可行动");
    // 空 args 同样是 unprovable (不是 escapes), 文案指向补目标而非找审批
    const d2 = await e.check("apply_patch", {});
    assert.equal(d2.decision, "ask");
    assert.ok(namesAllThree(d2.reason), d2.reason);
    assert.match(d2.reason, /未收到任何 content/, "空内容也要说清收到了什么");
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

// ---- (2) escapes 不放宽: 越界补丁仍是原审批口径, 不给"补目标"文案 ----
test("越界补丁 (块路径 /.. / 盘外绝对路径) → ask 且不挂 modelHint, 审批语义与今天一致", async () => {
  const root = mk("esc");
  try {
    const e = eng(root);
    for (const bad of ["../evil.js", process.platform === "win32" ? "D:\\elsewhere\\x.js" : "/etc/passwd"]) {
      const d = await e.check("apply_patch", {
        content: `${bad}\n<<<<<<< SEARCH\nx\n=======\ny\n>>>>>>> REPLACE`,
      });
      assert.equal(d.decision, "ask", `越界落点 ${bad} 必须仍升级审批`);
      assert.ok(!d.modelHint, "escapes 是权限问题不是用法错误, 不该塞补目标文案");
      assert.match(d.reason, /工作区/, d.reason);
    }
    // 混合: 一块根内 + 一块无路径 → 整份不可证明, unprovable 文案 (ask 不变)
    const mixed = await e.check("apply_patch", {
      content: "a.js\n" + SR_NOPATH.replace("  return a - b;", "x").replace("  return a + b;", "y"),
    });
    assert.equal(mixed.decision, "allow", "单块带根内路径仍可证明");
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

// ---- (3) 文档三种写法仍可免审批直通 (回归钉: 本次改动不许把它们拖回 ask) ----
test("三种在-workspace 写法仍直通: args.path / SEARCH 上一行 / codex 表头", async () => {
  const root = mk("three");
  try {
    const e = eng(root);
    const forms = {
      argsPath: { path: "calc.js", content: SR_NOPATH },
      lineAbove: { content: "calc.js\n" + SR_NOPATH },
      codexHeader: { content: "*** Begin Patch\n*** Update File: calc.js\n@@\n-  return a - b;\n+  return a + b;\n*** End Patch" },
    };
    for (const [label, args] of Object.entries(forms)) {
      const d = await e.check("apply_patch", args);
      assert.equal(d.decision, "allow", `${label} 形式应免审批, 实际 ${d.decision}: ${d.reason}`);
    }
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

// ---- (4) 交互式应答者拿到的 askReason 同样可行动 ----
test("有应答者时, 递到人面前的理由也点名三种写法 (人可据此直接放行/指导)", async () => {
  const root = mk("onask");
  const seen = [];
  try {
    const e = eng(root, { onAsk: async (tool, args, reason) => { seen.push(reason); return "deny"; } });
    const d = await e.check("apply_patch", { content: SR_NOPATH });
    assert.equal(d.decision, "deny", "应答者拒绝 → deny (fail closed 不变)");
    assert.equal(seen.length, 1);
    assert.ok(namesAllThree(seen[0]), `应答者文案应可行动: ${seen[0]}`);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

// ---- (5) headless 端到端: 模型收到的拒绝可自纠, 且文件系统一根毫毛没动 ----
test("headless agent 端到端: 无目标补丁 → 拒绝消息点名三种写法, 文件未被触碰", async () => {
  const root = mk("e2e");
  const agent = new PPXAgent({ root, dataDir: path.join(root, ".ppx"), globalDataDir: path.join(root, ".ppx-global") });
  try {
    const before = "export function calc(a, b) {\n  return a - b;\n}\n";
    fs.writeFileSync(path.join(root, "calc.js"), before, "utf8");
    assert.equal(agent.hasApprovalSurface(), false, "本用例就是 headless 场景");
    const out = String(await agent._runTool("apply_patch", { content: SR_NOPATH }));
    assert.ok(out.startsWith(TOOL_ERROR_PREFIX), `应被拒绝: ${out.slice(0, 160)}`);
    assert.match(out, /没有审批入口/, "保留 headless 语境说明");
    assert.ok(namesAllThree(out), `拒绝消息必须教会模型怎么补目标: ${out.slice(0, 400)}`);
    assert.match(out, /return a - b;/, "拒绝消息应复述实际收到的内容");
    assert.equal(fs.readFileSync(path.join(root, "calc.js"), "utf8"), before, "补丁绝不能触碰文件系统");
  } finally { agent.shutdown(); fs.rmSync(root, { recursive: true, force: true }); }
});

// ---- (6) 工具自身校验与权限层同源 (有 args 但块缺目标时的直接调用) ----
test("工具直调: 缺目标错误列出三种写法 + 收到内容摘录, 且不写盘", async () => {
  const root = mk("tool");
  try {
    fs.writeFileSync(path.join(root, "calc.js"), "  return a - b;\n", "utf8");
    const out = JSON.parse(await cat(root).call("apply_patch", { content: SR_NOPATH }));
    assert.ok(out.error, JSON.stringify(out));
    assert.ok(namesAllThree(out.error), `工具错误应与权限层同源: ${out.error}`);
    assert.match(out.error, /<<<<<<< SEARCH/, "错误应含实际收到的前两行");
    assert.equal(fs.readFileSync(path.join(root, "calc.js"), "utf8"), "  return a - b;\n");
    // 共享常量本身: 短 (进轨迹不膨胀) + 判据函数真能盯住三种写法
    assert.ok(MISSING_TARGET_HELP.length < 300, "文案别膨胀");
    assert.equal(patchTargetPreview(""), "(未收到任何 content 文本)");
    assert.equal(patchTargetPreview("l1\nl2\nl3"), "l1 / l2");
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

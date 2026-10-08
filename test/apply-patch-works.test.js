// test/apply-patch-works.test.js — apply_patch "按文档写法就能用"回归 (2026-10-05)
// 背景: 旧 parseEditBlocks 无条件把 <<<<<<< SEARCH 后首行当路径, 而工具描述教的恰恰是
// 无路径的普通 SEARCH/REPLACE 形式 → search 恒空、apply_patch 实际不可用, 权限层也证明
// 不了落点而升级 ask (headless 即拒)。真跑基准 json-edit / rename-symbol 因此而死。
// 本文件钉死修复后的端到端行为: 文档形式 + args.path 真能改文件, 权限与之同源。
import test from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ToolCatalog } from "../src/tools/index.js";
import { registerV3Tools } from "../src/tools/v3.js";
import { createPermissionEngine, AskForApproval, SandboxPolicy } from "../src/permissions/index.js";
import { PPXAgent } from "../src/agent/index.js";

const mk = (tag) => fs.mkdtempSync(path.join(os.tmpdir(), `ppx-ap-${tag}-`));
const cat = (root) => {
  const c = new ToolCatalog();
  registerV3Tools(c, { rootDir: root });
  return c;
};
const eng = (root) => createPermissionEngine({
  approvalMode: AskForApproval.ON_REQUEST,
  sandbox: SandboxPolicy.WORKSPACE_WRITE,
  workspaceRoot: root,
});

// 工具描述教的形式: 无路径普通 SR 块
const SR = (search, replace) =>
  `<<<<<<< SEARCH\n${search}\n=======\n${replace}\n>>>>>>> REPLACE`;

test("a) 无路径普通形式 + args.path: 真实改对文件", async () => {
  const root = mk("argspath");
  try {
    fs.writeFileSync(path.join(root, "svc.js"), "export async function fetchData() {\n  return 1;\n}\n", "utf8");
    const r = JSON.parse(await cat(root).call("apply_patch", {
      path: "svc.js",
      content: SR("export async function fetchData()", "export async function loadData()"),
    }));
    assert.equal(r.ok, true, JSON.stringify(r));
    const out = fs.readFileSync(path.join(root, "svc.js"), "utf8");
    assert.match(out, /loadData/);
    assert.doesNotMatch(out, /fetchData/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("b) aider 形式: 文件名写在 <<<<<<< SEARCH 上一行, 无需 args.path", async () => {
  const root = mk("aider");
  try {
    fs.writeFileSync(path.join(root, "calc.js"), "const tax = 0.1;\n", "utf8");
    const r = JSON.parse(await cat(root).call("apply_patch", {
      content: "calc.js\n" + SR("const tax = 0.1;", "const tax = 0.2;"),
    }));
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.match(fs.readFileSync(path.join(root, "calc.js"), "utf8"), /0\.2/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("c) 同文件多块顺序应用", async () => {
  const root = mk("multi");
  try {
    fs.writeFileSync(path.join(root, "m.js"), "let a = 1;\nlet b = 2;\n", "utf8");
    const r = JSON.parse(await cat(root).call("apply_patch", {
      path: "m.js",
      content: SR("let a = 1;", "let a = 10;") + "\n" + SR("let b = 2;", "let b = 20;"),
    }));
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.equal(r.blocks, 2);
    assert.match(fs.readFileSync(path.join(root, "m.js"), "utf8"), /let a = 10;\nlet b = 20;/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("d) SEARCH 写错: not-found + 最佳匹配窗口回灌提示不回退", async () => {
  const root = mk("wrong");
  try {
    fs.writeFileSync(path.join(root, "w.js"),
      "line1\nfunction calcTotal(n){\n  return n * 1.1;\n}\nline5\n", "utf8");
    const r = JSON.parse(await cat(root).call("apply_patch", {
      path: "w.js",
      content: SR("function calcTotall(n){\n  return n * 1.1;\n}", "function nope(){}"),
    }));
    assert.equal(r.ok, false);
    assert.equal(r.rolled_back, true, "失败应整体回滚");
    assert.match(fs.readFileSync(path.join(root, "w.js"), "utf8"), /calcTotal\(n\)/, "文件未被改动");
    const fb = r.results[0].feedback;
    assert.ok(/not-found/.test(fb), `反馈应含 not-found: ${fb}`);
    assert.ok(/最接近的位置在第 2 行附近/.test(fb), "反馈应含最佳匹配窗口行号");
    assert.ok(fb.includes("2 | function calcTotal(n){"), "反馈应摘录 ±5 行真实原文供 LLM 修正");
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("e) 权限与工具同源: args.path 兜底 allow / 块路径越界 ask / 双缺 ask", async () => {
  const root = mk("perm");
  try {
    const e = eng(root);
    // 块无路径 + args.path 在根内 → allow (与 execute 的兜底一致)
    const d1 = await e.check("apply_patch", { path: "src/a.js", content: SR("x", "y") });
    assert.equal(d1.decision, "allow", `args.path 兜底应免审批: ${d1.reason}`);
    // 块自带路径越界 → ask
    const d2 = await e.check("apply_patch", { content: "D:/evil.js\n" + SR("x", "y") });
    assert.equal(d2.decision, "ask", "块路径越界必须升级审批");
    // aider 相对穿越路径 → ask
    const d3 = await e.check("apply_patch", { content: "../evil.js\n" + SR("x", "y") });
    assert.equal(d3.decision, "ask", "相对穿越块路径必须问");
    // 块无路径且无 args.path → 落点不可证明, ask (fail closed 不弱化)
    const d4 = await e.check("apply_patch", { content: SR("x", "y") });
    assert.equal(d4.decision, "ask", "双缺路径必须 ask, 不许猜");
    // 混合: 一块有根内路径 + 一块无路径 + args.path → 全部落点可证明 → allow
    const d5 = await e.check("apply_patch", {
      path: "b.js",
      content: "a.js\n" + SR("x", "y") + "\n" + SR("p", "q"),
    });
    assert.equal(d5.decision, "allow", d5.reason);
    // 混合但某块路径越界 → 按最危险定级
    const d6 = await e.check("apply_patch", {
      path: "b.js",
      content: SR("x", "y") + "\n/etc/passwd\n" + SR("p", "q"),
    });
    assert.equal(d6.decision, "ask", "多块混合落点按最危险的那块定级");
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("f) headless agent._runTool: 文档形式 (无块路径 + args.path) 真的改根内文件", async () => {
  const root = mk("e2e");
  const agent = new PPXAgent({ root, dataDir: path.join(root, ".ppx") });
  try {
    fs.writeFileSync(path.join(root, "app.js"), "export default function start() {\n  boot();\n}\n", "utf8");
    assert.equal(agent.hasApprovalSurface(), false, "本用例就是 headless 场景");
    const out = String(await agent._runTool("apply_patch", {
      path: "app.js",
      content: SR("export default function start() {", "export default function main() {"),
    }));
    assert.ok(!out.startsWith("[工具错误]"), `不应被权限拦下, 实际: ${out.slice(0, 160)}`);
    assert.ok(/"ok":true/.test(out), `补丁应成功, 实际: ${out.slice(0, 160)}`);
    assert.match(fs.readFileSync(path.join(root, "app.js"), "utf8"), /function main\(\)/);
  } finally {
    agent.shutdown();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("无路径块缺 args.path: 工具给可行动错误而非静默空改", async () => {
  const root = mk("noargpath");
  try {
    fs.writeFileSync(path.join(root, "k.js"), "old\n", "utf8");
    const r = JSON.parse(await cat(root).call("apply_patch", { content: SR("old", "new") }));
    assert.ok(r.error && /path/.test(r.error), JSON.stringify(r));
    assert.equal(fs.readFileSync(path.join(root, "k.js"), "utf8"), "old\n", "不应发生任何写入");
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

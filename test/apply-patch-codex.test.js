// test/apply-patch-codex.test.js — 第三种补丁写法 (codex *** Begin Patch) 的落点证明与应用 (2026-10-05)
// 背景: 工具描述只教 SEARCH/REPLACE 两种写法, 模型实测还会吐 codex 风格统一 diff:
//   *** Begin Patch / *** Update File: 路径 / @@ / -旧行 +新行 / *** End Patch
// 旧行为: parseEditBlocks 解出 0 块 → 权限层证明不了落点 → 升级 ask → headless 即拒
// (真跑 rename-symbol 的归因就是 "权限/策略拦截 (涉及工具: apply_patch)"), 而工具那侧只会说
// "未找到任何 SEARCH/REPLACE 块", 模型拿到也无从改写。
// 修法按证据收敛到最小: (i) 表头路径进落点清单 (只可能让清单更长, 不会把越界证明成合规);
// (ii) @@ 段还原成等价 SEARCH/REPLACE 块后走既有应用/回滚逻辑 (SR 主路径零改动);
// (iii) 认不出来的段/整份解析失败 → 点名受支持格式的可行动错误。
// 不弱化失败关闭: 落点证明不了 (无路径 SR 块、越界 codex 表头、两种格式都不是) 一律 ask;
// run_command / delete_file / rm 的审批口径原样不变 (本文件末尾钉住)。
import test from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseEditBlocks, parseCodexPatch, PATCH_FORMAT_HELP } from "../src/edit/editblock.js";
import { ToolCatalog } from "../src/tools/index.js";
import { registerV3Tools } from "../src/tools/v3.js";
import { createPermissionEngine, AskForApproval, SandboxPolicy } from "../src/permissions/index.js";
import { PPXAgent } from "../src/agent/index.js";

const mk = (tag) => fs.mkdtempSync(path.join(os.tmpdir(), `ppx-cx-${tag}-`));
const cat = (root) => { const c = new ToolCatalog(); registerV3Tools(c, { rootDir: root }); return c; };
const eng = (root) => createPermissionEngine({
  approvalMode: AskForApproval.ON_REQUEST,
  sandbox: SandboxPolicy.WORKSPACE_WRITE,
  workspaceRoot: root,
});

const RENAME_FIXTURE = "export async function fetchData() { return 1; }\nexport async function main() { const r = await fetchData(); return r; }\n";

// 模型实际会写的样子: 单 hunk + 一行上下文
const CX_ONE = [
  "*** Begin Patch",
  "*** Update File: rename-me.js",
  "@@",
  "-export async function fetchData() { return 1; }",
  "+export async function loadData() { return 1; }",
  " export async function main() { const r = await fetchData(); return r; }",
  "*** End Patch",
].join("\n");

// 两个 hunk 覆盖两处引用 —— 这才是能让 rename-symbol 过分的补丁
const CX_TWO_HUNKS = [
  "*** Begin Patch",
  "*** Update File: rename-me.js",
  "@@",
  "-export async function fetchData() { return 1; }",
  "+export async function loadData() { return 1; }",
  "@@",
  "-export async function main() { const r = await fetchData(); return r; }",
  "+export async function main() { const r = await loadData(); return r; }",
  "*** End Patch",
].join("\n");

const CX_ADD = ["*** Begin Patch", "*** Add File: lib/new.js", "+export const hi = 1;", "*** End Patch"].join("\n");
const CX_DELETE = ["*** Begin Patch", "*** Delete File: rename-me.js", "*** End Patch"].join("\n");
const CX_MOVE = ["*** Begin Patch", "*** Update File: a.js", "*** Move to: b.js", "@@", "+x", "*** End Patch"].join("\n");
const CX_OUTSIDE = ["*** Begin Patch", "*** Update File: ../evil.js", "@@", "+x", "*** End Patch"].join("\n");
const CX_ABS_OUTSIDE = process.platform === "win32"
  ? ["*** Begin Patch", "*** Update File: D:\\elsewhere\\x.js", "@@", "+x", "*** End Patch"].join("\n")
  : ["*** Begin Patch", "*** Update File: /etc/passwd", "@@", "+x", "*** End Patch"].join("\n");

// ---- (i) 解析: 只在 SR 解不出块时才看 codex, SR 路径不受影响 ----
test("parseCodexPatch: Update/Add 段的落点与等价块抽取", () => {
  const one = parseCodexPatch(CX_ONE);
  assert.equal(one.detected, true);
  assert.deepEqual(one.paths, ["rename-me.js"]);
  assert.equal(one.blocks.length, 1, "单 hunk 应出一个块");
  assert.equal(one.blocks[0].search, "export async function fetchData() { return 1; }\nexport async function main() { const r = await fetchData(); return r; }");
  assert.equal(one.blocks[0].replace, "export async function loadData() { return 1; }\nexport async function main() { const r = await fetchData(); return r; }");

  const two = parseCodexPatch(CX_TWO_HUNKS);
  assert.equal(two.blocks.length, 2, "两个 @@ hunk 必须出两个块 (hunk 不连续, 合并必然 not-found)");
  assert.equal(two.blocks[1].search, "export async function main() { const r = await fetchData(); return r; }");

  const add = parseCodexPatch(CX_ADD);
  assert.equal(add.blocks.length, 1);
  assert.equal(add.blocks[0].search, "", "Add File = 空 SEARCH, 交给工具既有的新建文件分支");
  assert.equal(add.blocks[0].replace, "export const hi = 1;");

  assert.deepEqual(parseCodexPatch(CX_DELETE).unsupported.map((u) => u.kind), ["Delete File"]);
  assert.deepEqual(parseCodexPatch(CX_MOVE).unsupported.map((u) => u.kind), ["Move"], "Move to 使整段不可应用, 不能猜");
  assert.equal(parseCodexPatch(CX_MOVE).blocks.length, 0, "含 Move 的段不产出块");
});

test("parseCodexPatch: SEARCH/REPLACE 写法完全不被它接管 (无串台)", () => {
  const sr = "calc.js\n<<<<<<< SEARCH\nconst tax = 0.1;\n=======\nconst tax = 0.2;\n>>>>>>> REPLACE";
  assert.equal(parseEditBlocks(sr).length, 1, "SR 解析器照旧");
  const cx = parseCodexPatch(sr);
  assert.equal(cx.detected, false, "非 codex 补丁不该被判定为 codex");
  assert.deepEqual(cx.blocks, []);
  assert.deepEqual(cx.paths, []);
  // 围栏包裹的 codex 补丁仍可读
  const fenced = "```diff\n" + CX_ONE + "\n```";
  assert.equal(parseCodexPatch(fenced).blocks.length, 1);
});

// ---- (iii) 权限: 表头路径可证明工作区; 证明不了照旧 ask ----
test("权限: 工作区内 codex 补丁免审批, 越界/不可解析仍然 ask (失败关闭未弱化)", async () => {
  const root = mk("perm");
  try {
    const e = eng(root);
    for (const [label, content, want] of [
      ["工作区内 Update", CX_ONE, "allow"],
      ["工作区内 Add", CX_ADD, "allow"],
      ["Delete File (工作区内)", CX_DELETE, "allow"],
      ["相对越界 ../evil.js", CX_OUTSIDE, "ask"],
      ["绝对越界 (盘外/根外)", CX_ABS_OUTSIDE, "ask"],
      ["既非 SR 也非 codex (无落点)", "把 fetchData 改成 loadData 好吗", "ask"],
    ]) {
      const d = await e.check("apply_patch", { content });
      assert.equal(d.decision, want, `${label} 应判 ${want}, 实际 ${d.decision}: ${d.reason}`);
    }
    // 混合: codex 表头越界 + SR 块在根内 → 按最危险定级
    const mixed = await e.check("apply_patch", {
      path: "ok.js",
      content: CX_OUTSIDE + "\na.js\n<<<<<<< SEARCH\nx\n=======\ny\n>>>>>>> REPLACE",
    });
    assert.equal(mixed.decision, "ask", "codex 越界表头必须把整份补丁拖进审批");
    // args.path 是越界的, 即使 codex 表头合规 —— workspace-write 直接 deny (原有口径不变)
    const badArg = await e.check("apply_patch", { path: "../evil.js", content: CX_ONE });
    assert.equal(badArg.decision, "deny", "args.path 越界由沙箱判 deny");
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

// ---- (ii) 应用: 等价块走既有逻辑 ----
test("apply_patch: codex 补丁真的改对文件 (rename-symbol 场景)", async () => {
  // 单 hunk: 只改它覆盖的那一处, 上下文行必须原样保留
  const r1root = mk("one");
  try {
    fs.writeFileSync(path.join(r1root, "rename-me.js"), RENAME_FIXTURE, "utf8");
    const r = JSON.parse(await cat(r1root).call("apply_patch", { content: CX_ONE }));
    assert.equal(r.ok, true, JSON.stringify(r));
    const out = fs.readFileSync(path.join(r1root, "rename-me.js"), "utf8");
    assert.match(out, /loadData\(\) \{ return 1; \}/, "首行按 hunk 改名");
    assert.match(out, /await fetchData\(\)/, "上下文行不该被动 (hunk 只覆盖一处)");
  } finally { fs.rmSync(r1root, { recursive: true, force: true }); }

  // 双 hunk: 覆盖两处引用 —— 这才是能让 rename-symbol 过分的补丁
  const r2root = mk("two");
  try {
    fs.writeFileSync(path.join(r2root, "rename-me.js"), RENAME_FIXTURE, "utf8");
    const r2 = JSON.parse(await cat(r2root).call("apply_patch", { content: CX_TWO_HUNKS }));
    assert.equal(r2.ok, true, JSON.stringify(r2));
    assert.equal(r2.blocks, 2, "两个 hunk = 两个块");
    const out2 = fs.readFileSync(path.join(r2root, "rename-me.js"), "utf8");
    assert.doesNotMatch(out2, /fetchData/, "两处引用都改完");
    assert.match(out2, /await loadData\(\)/);
    const { TASKS } = await import("../bench/tasks.js");
    const verdict = TASKS.find((t) => t.id === "rename-symbol").verify({ reply: "改完了" }, { sandbox: r2root });
    assert.equal(verdict.pass, true, `这份补丁应让基准任务真的过: ${verdict.detail}`);
  } finally { fs.rmSync(r2root, { recursive: true, force: true }); }
});

test("apply_patch: codex Add File 新建文件; hunk 内容对不上则整体回滚不半改", async () => {
  const root = mk("add");
  try {
    const r = JSON.parse(await cat(root).call("apply_patch", { content: CX_ADD }));
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.equal(fs.readFileSync(path.join(root, "lib/new.js"), "utf8"), "export const hi = 1;");

    fs.writeFileSync(path.join(root, "svc.js"), "export const a = 1;\nexport const b = 2;\n", "utf8");
    const bad = [
      "*** Begin Patch",
      "*** Update File: svc.js",
      "@@",
      "-export const a = 1;",
      "+export const A = 1;",
      "@@",
      "-export const nope = 9;", // 不存在的一行
      "+export const b = 20;",
      "*** End Patch",
    ].join("\n");
    const r2 = JSON.parse(await cat(root).call("apply_patch", { content: bad }));
    assert.equal(r2.ok, false, "命中不了的 hunk 应整体失败");
    assert.equal(r2.rolled_back, true, "任一块失败必须回滚 (原子性)");
    assert.equal(fs.readFileSync(path.join(root, "svc.js"), "utf8"), "export const a = 1;\nexport const b = 2;\n", "文件不得被半改");
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

// ---- (iii) 可行动的失败提示 ----
test("apply_patch: 认不出的补丁给点名格式的错误, 而不是\"未找到任何 SEARCH/REPLACE 块\"", async () => {
  const root = mk("err");
  try {
    fs.writeFileSync(path.join(root, "rename-me.js"), RENAME_FIXTURE, "utf8");
    const c = cat(root);

    const junk = JSON.parse(await c.call("apply_patch", { content: "帮我改一下 fetchData" }));
    assert.ok(junk.error && /SEARCH\/REPLACE/.test(junk.error + junk.help), JSON.stringify(junk));
    assert.match(junk.help, /\*\*\* Begin Patch/, "help 应点名 codex 写法");
    assert.match(junk.help, /delete_file/, "help 应说明删除该用什么");

    const del = JSON.parse(await c.call("apply_patch", { content: CX_DELETE }));
    assert.equal(del.ok, false);
    assert.match(del.error, /Delete File/, JSON.stringify(del));
    assert.ok(fs.existsSync(path.join(root, "rename-me.js")), "Delete File 段绝不落到删除");

    const mv = JSON.parse(await c.call("apply_patch", { content: CX_MOVE }));
    assert.equal(mv.ok, false, "Move 段不猜");
    assert.match(mv.error, /Move/, JSON.stringify(mv));

    // 老的裸 SR 错误口径没被改坏: 无路径块仍要求 path
    const noPath = JSON.parse(await c.call("apply_patch", { content: "<<<<<<< SEARCH\nold\n=======\nnew\n>>>>>>> REPLACE" }));
    assert.ok(noPath.error && /path/.test(noPath.error), JSON.stringify(noPath));
    assert.ok(PATCH_FORMAT_HELP.length < 500, "提示文案别膨胀 (不进 schema, 但会进轨迹)");
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

// ---- headless 端到端: 不再被审批拦下 ----
test("headless agent: codex 风格补丁在沙箱里直接生效 (真跑 rename-symbol 的失败形态)", async () => {
  const root = mk("e2e");
  const agent = new PPXAgent({ root, dataDir: path.join(root, ".ppx"), globalDataDir: path.join(root, ".ppx-global") });
  const calls = [];
  try {
    fs.writeFileSync(path.join(root, "rename-me.js"), RENAME_FIXTURE, "utf8");
    assert.equal(agent.hasApprovalSurface(), false, "本用例就是 headless 场景");
    agent.setToolEvent((ev) => { if (ev.type === "done") calls.push(ev); });
    const out = String(await agent._runTool("apply_patch", { content: CX_TWO_HUNKS }));
    assert.ok(!out.startsWith("[工具错误]"), `不该被权限拦下: ${out.slice(0, 200)}`);
    assert.match(out, /"ok":true/, out.slice(0, 200));
    assert.equal(calls[0].ok, true, "轨迹应记成功, 归因不再出现\"权限/策略拦截 × apply_patch\"");
    const txt = fs.readFileSync(path.join(root, "rename-me.js"), "utf8");
    assert.doesNotMatch(txt, /fetchData/);
    assert.match(txt, /loadData/);
  } finally { agent.shutdown(); fs.rmSync(root, { recursive: true, force: true }); }
});

// ---- 审批口径不变的部分 ----
test("审批口径未变: run_command / delete_file / rm 仍然一律 ask", async () => {
  const root = mk("approval");
  try {
    const e = eng(root);
    for (const [name, args] of [
      ["run_command", { command: "dir" }],
      ["delete_file", { path: "a.txt" }],
      ["rm", { path: "a.txt" }],
    ]) {
      const d = await e.check(name, args);
      assert.equal(d.decision, "ask", `${name} 必须仍然审批: ${d.reason}`);
    }
    // 越界删除不会被 codex 改动放宽
    const esc = await e.check("delete_file", { path: "../a.txt" });
    assert.equal(esc.decision, "deny", "越界路径在 workspace-write 下仍是 deny");
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

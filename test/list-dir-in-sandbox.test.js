// test/list-dir-in-sandbox.test.js — list_dir 在基准沙箱里必须可用 (2026-10-05)
// 背景: 真跑 6 任务复测里 extract-field 失败, 归因给出 "执行报错 × 1 (涉及工具: list_dir)"。
// 离线复现 (按 scripts/taskbench.js runOne 的方式构造 agent, 沙箱里只放 users.json) 查出两条
// 真实成因, 都与"空结果"无关:
//   A. args 形态: 无必填参数的工具被以 undefined/null 调用时, execute 里 args.path 直接
//      TypeError → [工具错误] → 轨迹记 ok=false → 归因"执行报错"。
//   B. Windows 绝对路径: safePath 早先对所有 `X:` 开头的串一刀切拒绝 (那是给 POSIX 宿主兜
//      住"创建出名为 C:\Windows 的相对文件"的), 结果在 Windows 宿主上连"工作区内的绝对路径"
//      都被判越界 → [工具错误] list_dir: 路径越界拒绝 → 同样记成"执行报错"。
//      (顺带: 大小写不同的同一目录写法也会被前缀比较误判越界。)
// 反证 (避免修一个不存在的 bug): 工具返回 JSON {error:…} 形态的"业务失败"体 (文件当目录、
// 目录不存在) 并不会被归因读成执行报错 —— scripts/taskbench.js 只把 ev.ok === false 记为错误,
// 而 ok = !result.startsWith("[工具错误]")。本文件末尾把这条口径也钉住。
import test from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PPXAgent } from "../src/agent/index.js";
import { ToolCatalog } from "../src/tools/index.js";
import { registerBuiltinTools, safePath } from "../src/tools/builtin.js";
import { triageFailure, CAUSE } from "../src/services/triage.js";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const IS_WIN = process.platform === "win32";
const USERS = JSON.stringify([{ email: "a@bench.dev" }, { email: "b@other.com" }, { email: "c@bench.dev" }]);

// 与 scripts/taskbench.js runOne 同构的沙箱 + agent
function makeSandbox(tag = "listdir") {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `ppx-${tag}-`));
  fs.writeFileSync(path.join(root, "users.json"), USERS, "utf8");
  const opts = { root, dataDir: path.join(root, ".ppx"), globalDataDir: path.join(root, ".ppx-global") };
  const configFile = path.join(REPO, "config", "ppx.json");
  if (fs.existsSync(configFile)) opts.configFile = configFile; // 基准跑法会复用仓库 Key 配置
  const agent = new PPXAgent(opts);
  return { root, agent };
}

const isErrorShaped = (s) => String(s).startsWith("[工具错误]");

test("list_dir: 运行时的全部调用形态都不报执行错 (含无参/空调用/工作区内绝对路径)", async () => {
  const { root, agent } = makeSandbox();
  try {
    const shapes = [
      ["无参调用 (undefined)", undefined],
      ["null 参数", null],
      ["空对象 {}", {}],
      ['{path:"."}', { path: "." }],
      ["工作区内绝对路径 (反斜杠)", { path: root }],
      ["工作区内绝对路径 (正斜杠)", { path: root.replace(/\\/g, "/") }],
      ["绝对路径 + 结尾分隔符", { path: root + path.sep }],
    ];
    if (IS_WIN) shapes.push(["盘符小写的同一目录", { path: root.charAt(0).toLowerCase() + root.slice(1) }]);
    for (const [label, args] of shapes) {
      const out = String(await agent._runTool("list_dir", args));
      assert.ok(!isErrorShaped(out), `${label} 不应是执行错误: ${out.slice(0, 160)}`);
      assert.match(out, /users\.json/, `${label} 应列出沙箱内文件: ${out.slice(0, 160)}`);
    }
  } finally { agent.shutdown(); fs.rmSync(root, { recursive: true, force: true }); }
});

test("list_dir: 轨迹事件 ok=true (归因不会再记成\"执行报错 × list_dir\")", async () => {
  const { root, agent } = makeSandbox();
  const events = [];
  try {
    agent.setToolEvent((ev) => { if (ev.type === "done") events.push(ev); });
    await agent._runTool("list_dir", { path: root });
    assert.equal(events.length, 1);
    assert.equal(events[0].ok, true, `ok 必须为 true: ${events[0].result}`);
    assert.ok(!String(events[0].result).includes("越界拒绝"));
  } finally { agent.shutdown(); fs.rmSync(root, { recursive: true, force: true }); }
});

test("list_dir: 越界仍然拒绝, 且不泄漏目录内容", async () => {
  const { root, agent } = makeSandbox();
  try {
    const outside = path.resolve(root, "..");
    for (const p of ["..", "../..", outside, path.join(outside, "x")]) {
      const out = String(await agent._runTool("list_dir", { path: p }));
      // 两道防线任一道命中都算拒 (权限引擎的 workspace-write 先拦, 或 safePath 的越界拒绝)
      assert.ok(/越界/.test(out), `${p} 应被判越界: ${out.slice(0, 160)}`);
      assert.ok(!out.includes("[D]") && !out.includes("[F]"), `${p} 不应列出外部目录内容: ${out.slice(0, 160)}`);
    }
    // 单个文件当目录: 给可判读的业务错误 (指向 read_file), 而不是崩溃
    const asFile = String(await agent._runTool("list_dir", { path: path.join(root, "users.json") }));
    assert.match(asFile, /目标是文件不是目录/, asFile);
    assert.match(asFile, /read_file/, "错误应给出可用的下一步");
  } finally { agent.shutdown(); fs.rmSync(root, { recursive: true, force: true }); }
});

test("list_dir: 空目录返回可读标记而非空串 (空结果与失败无从区分)", async () => {
  const { root, agent } = makeSandbox();
  try {
    fs.mkdirSync(path.join(root, "empty-dir"));
    const out = String(await agent._runTool("list_dir", { path: "empty-dir" }));
    assert.ok(out.length > 0, "空目录也应有可读结果, 实际: " + JSON.stringify(out));
    assert.match(out, /空目录/);
  } finally { agent.shutdown(); fs.rmSync(root, { recursive: true, force: true }); }
});

test("catalog.call 层归一 args: 无必填参数的工具被以 undefined 调用不再 TypeError", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ppx-listdir-cat-"));
  fs.writeFileSync(path.join(root, "users.json"), USERS, "utf8");
  const catalog = new ToolCatalog();
  registerBuiltinTools(catalog, { rootDir: root, facts: null, memory: null });
  try {
    const out = String(await catalog.call("list_dir", undefined, {}));
    assert.ok(!isErrorShaped(out), `应为正常列表: ${out.slice(0, 160)}`);
    assert.match(out, /users\.json/);
    // 有必填参数的工具仍按"参数错误"判读 (归一不能把缺参变成静默成功)
    const missing = String(await catalog.call("read_file", undefined, {}));
    assert.ok(isErrorShaped(missing) && /参数错误/.test(missing), missing);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("safePath: 工作区内绝对路径放行 / 越界与符号链接逃逸照旧拒绝", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ppx-listdir-safe-"));
  try {
    fs.mkdirSync(path.join(root, "sub"));
    // 工作区内: 相对/绝对/不同拼写都可用
    assert.equal(safePath(root, "sub"), path.resolve(root, "sub"));
    assert.equal(safePath(root, path.resolve(root, "sub")), path.resolve(root, "sub"));
    if (IS_WIN) {
      assert.equal(
        safePath(root, path.resolve(root, "sub")).toLowerCase(),
        path.resolve(root, "sub").toLowerCase(),
        "Windows 大小写不同拼写的同一目录不应判越界",
      );
    }
    // 越界: 相对穿越 + 绝对路径 (本机平台的 root 之外)
    assert.throws(() => safePath(root, ".."), /路径越界拒绝/);
    assert.throws(() => safePath(root, path.resolve(root, "..", "evil.txt")), /路径越界拒绝/);
    // 名字前缀撞上来的兄弟目录 (/tmp/ppx-abc 与 /tmp/ppx-abcdef) 不算工作区内
    const sibling = path.dirname(root) + path.sep + path.basename(root) + "-sibling";
    assert.throws(() => safePath(root, sibling), /路径越界拒绝/);
    // 盘符串: Windows 上按解析结果判定 (盘外的照样拒), POSIX 上入口即拒 (原不变量)
    assert.throws(() => safePath(root, IS_WIN ? "D:\\evil\\x" : "C:\\Windows"), /路径越界拒绝/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("safePath: 工作区内 symlink 指向外部仍然拒绝 (realpath 校验没被放宽)", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ppx-listdir-link-"));
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "ppx-listdir-out-"));
  try {
    fs.writeFileSync(path.join(outside, "secret.txt"), "s", "utf8");
    const linkPath = path.join(root, "link");
    // Windows 上普通用户建目录 symlink 要特权, junction 不要 —— 两者都能验证 realpath 那一关
    const kinds = process.platform === "win32" ? ["junction", "dir"] : ["dir"];
    let made = false;
    for (const kind of kinds) {
      try { fs.symlinkSync(outside, linkPath, kind); made = true; break; } catch { /* 换下一种 */ }
    }
    if (!made) { t.skip("本机无法创建符号链接/junction (权限受限)"); return; }
    assert.throws(() => safePath(root, path.join("link", "secret.txt")), /越界拒绝/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  }
});

test("归因口径钉死: JSON {error:…} 业务失败体不算执行报错 (只有 [工具错误] 才是)", () => {
  const jsonErr = [{ tool: "list_dir", args: { path: "users.json" }, ok: true, error: null }];
  const t1 = triageFailure({ reply: "我数好了", toolCalls: jsonErr, ms: 1000, budgetMs: 90000, detail: "应答 2" });
  assert.notEqual(t1.cause, CAUSE.TOOL_USE, "工具级 ok=true 不应被判为工具用错");
  assert.equal(t1.cause, CAUSE.VERIFICATION);

  const crashed = [{ tool: "list_dir", args: undefined, ok: false, error: "[工具错误] list_dir: 路径越界拒绝: C:\\x" }];
  const t2 = triageFailure({ reply: "…", toolCalls: crashed, ms: 1000, budgetMs: 90000, detail: "应答 2" });
  assert.equal(t2.cause, CAUSE.TOOL_USE);
  assert.ok(t2.evidence.some((e) => /执行报错/.test(e)), JSON.stringify(t2.evidence));
});

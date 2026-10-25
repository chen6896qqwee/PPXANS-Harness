// test/task-cmd-r17-2026-10-24.test.js - 第十七轮回归: /task 命令 + 三方共享 TaskBoard
// 背景: 侧栏任务面板一直提示"发送 /task 创建", 但 /task 命令此前不存在 (空提示);
//   且 HTTP /api/tasks 与 MCP ppx.task.* 各自懒建 TaskBoard 实例 (内存双份, 同文件互覆)。
import test from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PPXAgent } from "../src/agent/index.js";
import { createBuiltinRegistry, BUILTIN_COMMANDS } from "../src/commands/index.js";

function tmp() { return fs.mkdtempSync(path.join(os.tmpdir(), "ppx-r17-")); }
function makeAgent(root) {
  fs.mkdirSync(path.join(root, "config"), { recursive: true });
  fs.writeFileSync(path.join(root, "config", "ppx.json"), JSON.stringify({ agent: { localIntent: false } }));
  return new PPXAgent({ root, dataDir: path.join(root, "data") });
}

test("R17: /task 全生命周期 (add → list → done → del) 走 _executeCommand 主链", async () => {
  const agent = makeAgent(tmp());
  try {
    const add = await agent._executeCommand("/task add 修复登录页样式", "r17");
    assert.match(add, /已创建任务/, `add 应成功: ${add}`);
    const m = add.match(/\(t_\w+\)/);
    assert.ok(m, "回复应带任务 id");
    const id = m[0].slice(1, -1);

    const list = await agent._executeCommand("/task", "r17");
    assert.match(list, /任务面板/, "无参应列出面板");
    assert.match(list, new RegExp(id), "清单应含刚建的任务");

    const done = await agent._executeCommand(`/task done ${id}`, "r17");
    assert.match(done, /已完结/, "done 应完结任务");

    const del = await agent._executeCommand(`/task del ${id}`, "r17");
    assert.match(del, /已删除/, "del 应删除任务");
    assert.match(await agent._executeCommand("/task", "r17"), /任务面板为空/, "删后应空");
  } finally {
    agent.shutdown();
  }
});

test("R17: 宽容解析 —— '/task 买菜' 无前缀整串视为 add", async () => {
  const agent = makeAgent(tmp());
  try {
    const out = await agent._executeCommand("/task 买菜", "r17b");
    assert.match(out, /已创建任务.*买菜/, `宽容 add 应生效: ${out}`);
  } finally {
    agent.shutdown();
  }
});

test("R17: agent/HTTP/MCP 三方共享同一 TaskBoard 实例", async () => {
  const agent = makeAgent(tmp());
  try {
    const tb1 = agent.getTaskBoard();
    const tb2 = agent.getTaskBoard();
    assert.equal(tb1, tb2, "agent 级应懒建复用");
    tb1.create({ title: "共享验证" });
    // 落盘同源: 新起实例 (模拟另一入口) 应读到同一条
    const { createTaskBoard } = await import("../src/mcp/tasks.js");
    const tb3 = createTaskBoard(agent.root);
    assert.ok([...tb3.tasks.values()].some((t) => t.title === "共享验证"), "落盘文件应同源");
  } finally {
    agent.shutdown();
  }
});

test("R17: 命令名册含 task (侧栏提示不再指向空气)", () => {
  const reg = createBuiltinRegistry();
  assert.ok(reg.get("task"), "task 命令应存在");
  const intent = reg.execute("/task add x");
  assert.equal(intent.action, "task_board");
  assert.equal(intent.sub, "add");
  assert.equal(BUILTIN_COMMANDS.length, 15);
});

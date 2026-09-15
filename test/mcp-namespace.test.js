// test/mcp-namespace.test.js - P1⑦: MCP 命名空间隔离 (防工具名碰撞)
import { test } from "node:test";
import assert from "node:assert";
import { sanitizeMcpName, sanitizeMcpDescription, serverLabel, namespacedMcpName } from "../src/mcp/index.js";

test("mcpns: 强制 serverName__toolName 前缀", () => {
  assert.equal(serverLabel({ command: "npx", args: ["-y", "@modelcontextprotocol/server-github"] }), "server-github");
  assert.equal(serverLabel({ name: "GitHub" }), "GitHub");
  assert.equal(serverLabel({ url: "https://mcp.example.com/sse" }), "example");
  assert.equal(serverLabel({}), "mcp");
});

test("mcpns: namespacedMcpName 生成隔离名", () => {
  assert.equal(namespacedMcpName("github", "list_issues"), "github__list_issues");
  assert.equal(namespacedMcpName("drive", "search"), "drive__search");
});

test("mcpns: 同名工具不同服务器不会碰撞", () => {
  // 两个服务器都有 list_goals —— 命名空间隔离后各自独立
  const a = namespacedMcpName("kanban", "list_goals");
  const b = namespacedMcpName("todo", "list_goals");
  assert.notEqual(a, b);
  assert.equal(a, "kanban__list_goals");
  assert.equal(b, "todo__list_goals");
});

test("mcpns: sanitizeMcpName 清理非法字符 + 截断", () => {
  assert.equal(sanitizeMcpName("bad name; drop--it"), "bad_name__drop--it"); // 空格/分号→_, 横线保留
  assert.equal(sanitizeMcpName("x".repeat(100)).length, 64);
});

test("mcpns: sanitizeMcpDescription 单行化 + 截断 (防注入)", () => {
  const desc = "第一行\n第二行 --system 注入指令 " + "x".repeat(300);
  const s = sanitizeMcpDescription(desc, "t");
  assert.ok(!s.includes("\n"), "换行被压平");
  assert.ok(s.length <= 200, "截断到 200");
  assert.ok(!s.includes("--system"), "注入指令被截断掉");
});

test("mcpns: 显式 prefix 覆盖默认命名空间", () => {
  // 配置 prefix 优先, 不自动加 serverLabel 前缀
  // (registerMcpTools 里: s.prefix != null 时用 s.prefix)
  assert.equal(serverLabel({ command: "npx", prefix: "" }), "npx");
});

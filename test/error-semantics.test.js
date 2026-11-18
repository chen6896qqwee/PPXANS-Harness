import test from "node:test";
import assert from "node:assert";
import { ToolCatalog, TOOL_ERROR_PREFIX } from "../src/tools/index.js";

test("工具错误语义: 异常统一返回标准错误前缀", async () => {
  const c = new ToolCatalog();
  c.register({
    name: "boom",
    description: "总是失败",
    parameters: { type: "object", properties: {} },
    execute: async () => { throw new Error("磁盘已满"); },
  });
  const res = await c.call("boom", {});
  assert.ok(res.startsWith(TOOL_ERROR_PREFIX), "错误应带标准前缀: " + res);
  assert.ok(res.includes("磁盘已满"), "应含原始错误信息");
});

test("工具错误语义: 未知工具也走标准前缀", async () => {
  const c = new ToolCatalog();
  const res = await c.call("no_such_tool", {});
  assert.ok(res.startsWith(TOOL_ERROR_PREFIX), "未知工具应带标准前缀: " + res);
});

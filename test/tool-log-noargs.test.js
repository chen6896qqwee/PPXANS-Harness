// test/tool-log-noargs.test.js — F5 不变量: 工具调用日志只打参数名, 不打参数值
//
// 为什么要钉 (2026-10-05 F5 复盘): catalog.call 里那行
//   info(`tool: ${name}(${JSON.stringify(args)})`)
// 把整份 args 原样写进 stdout。实测一次 write_file(200KB) 输出 205,233 字节控制台文本,
// content 里的 api_key=… 明文可见。审计链那边是 scrubArgs(截断 + 密钥掩码) 后落盘的
// (src/audit/audit-chain.js), 这一行等于把同一个洞重新打开 —— 而 .bat/.vbs 启动器
// 本来就开着可见控制台, 项目纪律也写明"绝不打印密钥值"。
// 现口径: `tool: write_file(path, content)` —— 只有形参名, 没有任何值。
import test from "node:test";
import assert from "node:assert";
import { ToolCatalog } from "../src/tools/index.js";
import { setLevel } from "../src/utils/logger.js";

// 捕获 console.log 输出 (logger 的 info 走 console.log)
function captureLogs(fn) {
  const orig = console.log;
  const lines = [];
  console.log = (...a) => { lines.push(a.map((x) => String(x)).join(" ")); };
  try {
    return Promise.resolve(fn()).then(
      (r) => ({ r, lines }),
      (e) => ({ e, lines }),
    ).finally(() => { console.log = orig; });
  } catch (e) {
    console.log = orig;
    return { e, lines };
  }
}

function makeCatalog() {
  const c = new ToolCatalog();
  c.register({
    name: "write_file",
    description: "写文件",
    parameters: { type: "object", properties: { path: { type: "string" }, content: { type: "string" } }, required: ["path", "content"] },
    capability: { riskLevel: "medium", readOnly: false, destructive: false, sideEffect: "workspace" },
    execute: async () => "ok",
  });
  c.register({
    name: "get_time",
    description: "时间",
    parameters: { type: "object", properties: {} },
    capability: { riskLevel: "low", readOnly: true, destructive: false, sideEffect: "none" },
    execute: async () => "now",
  });
  c.register({
    name: "http_request",
    description: "网络",
    parameters: { type: "object", properties: { url: { type: "string" }, headers: { type: "object" }, body: { type: "string" } }, required: ["url"] },
    capability: { riskLevel: "medium", readOnly: false, destructive: false, sideEffect: "network" },
    execute: async () => "200",
  });
  return c;
}

test.before(() => setLevel("info"));
test.after(() => setLevel("info"));

test("F5: 调用日志形如 tool: write_file(path, content) —— 参数值一个字节都不出现", async () => {
  const c = makeCatalog();
  const secret = "api_key=SECRET-DO-NOT-PRINT-9f3a1c";
  const body = `${secret}\n` + "x".repeat(200 * 1024); // 200KB 正文 (旧实现会整份打进 stdout)
  const { lines } = await captureLogs(() => c.call("write_file", { path: "notes/leak.md", content: body }));
  const toolLine = lines.find((l) => l.includes("tool: "));
  assert.ok(toolLine, `应有 tool: 调用行, 实际行: ${JSON.stringify(lines.map((l) => l.slice(0, 60)))}`);
  assert.match(toolLine, /tool: write_file\(path, content\)/, `日志应为名字清单, 实际: ${toolLine.slice(0, 120)}`);
  assert.ok(!toolLine.includes("SECRET-DO-NOT-PRINT"), "密钥值不得出现在调用日志里");
  assert.ok(!toolLine.includes("notes/leak.md"), "参数值 (连路径在内) 不得出现在调用日志里");
  assert.ok(toolLine.length < 120, `调用日志应当很短, 实际 ${toolLine.length} 字节`);
  // 整体 stdout 也不该被参数值撑爆 (旧实现单条 20 万字节)
  const total = lines.join("\n").length;
  assert.ok(total < 4000, `本次调用的控制台输出总量应远小于参数体积, 实际 ${total} 字节`);
});

test("F5: 无参工具 → tool: get_time(); 嵌套对象参数也只显示顶层参数名", async () => {
  const c = makeCatalog();
  const a = await captureLogs(() => c.call("get_time", {}));
  assert.match(a.lines.find((l) => l.includes("tool: ")), /tool: get_time\(\)/);

  const b = await captureLogs(() => c.call("http_request", {
    url: "https://internal.example.com/x?token=TOKEN-SECRET-VALUE",
    headers: { Authorization: "Bearer sk-abcdefghijklmnopqrstuvwxyz" },
    body: "payload-secret",
  }));
  const line = b.lines.find((l) => l.includes("tool: "));
  assert.match(line, /tool: http_request\(url, headers, body\)/);
  assert.ok(!line.includes("TOKEN-SECRET-VALUE") && !line.includes("sk-abcdefghijklmnop") && !line.includes("payload-secret"),
    `URL/query/请求头/正文的值都不得出现: ${line}`);
});

test("F5: 参数校验失败的路径也不出参数值 (校验先于日志, 连调用行都不打)", async () => {
  const c = makeCatalog();
  const { r, lines } = await captureLogs(() => c.call("write_file", { path: "a.md" })); // 缺 content
  assert.ok(String(r).startsWith("[工具错误]"), `应返回参数错误, 实际: ${r}`);
  // 校验失败在 info() 之前短路: 不打 tool: 行, 也不得把参数值写进任何一行日志
  assert.ok(!lines.some((l) => l.includes("tool: ")), `参数错误不该产生调用日志: ${JSON.stringify(lines)}`);
  assert.ok(!lines.some((l) => l.includes("a.md")), "参数值不得出现在任何日志行里");
});

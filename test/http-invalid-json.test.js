// test/http-invalid-json.test.js - HTTP 路由非法 JSON body 的错误语义回归 (2026-10-10 P1 修复)
//
// 背景 (全量测试中发现的真实缺陷):
//   _readJson 的注释自称"JSON 解析失败向上抛错, 由调用方 try/catch 转 400",
//   但 5 处调用方 (_readChatRequest / /sessions/rename / /sessions/delete / /reset) 全都没接
//   try/catch, SyntaxError 一路冒泡到顶层通用处理器被兜成 500 ——
//   客户端分不清"我发错了"(4xx, 不该重试) 与"服务挂了"(5xx, 可重试), 会触发无意义重试风暴,
//   并把脏数据误报成服务端故障。
//
// 修复: _readJson 就地回 400 并 return null (与"超限已回 413"同构), 5 路由无需改动即收敛。
// 本测试锁死该契约 —— 若有人把 try/catch 删回去, 这里必须红。
import test from "node:test";
import assert from "node:assert";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { PPXAgent } from "../src/agent/index.js";
import { HttpChannel } from "../src/channels/http.js";

function tmpRoot(tag) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `ppx-badjson-${tag}-`));
  fs.mkdirSync(path.join(root, "config"), { recursive: true });
  fs.writeFileSync(
    path.join(root, "config", "ppx.json"),
    JSON.stringify({ channels: { http: { mcp: { enabled: false } } } }),
  );
  return root;
}

async function withChannel(fn) {
  const root = tmpRoot("ch");
  const agent = new PPXAgent({ root, dataDir: path.join(root, "data") });
  const ch = new HttpChannel(agent, { port: 0, host: "127.0.0.1" });
  ch.authToken = "tok";
  await ch.connect();
  const port = ch.server.address().port;
  try {
    return await fn(port);
  } finally {
    await ch.disconnect();
    agent.shutdown();
  }
}

const BAD = "{ this is not valid json";

// 覆盖全部 5 个"读 JSON body"的对话/会话类路由
const ROUTES = ["/message", "/message/stream", "/sessions/rename", "/sessions/delete", "/reset"];

test("非法 JSON body: 5 个路由均返回 400 (客户端错误), 而非 500", { timeout: 30000 }, async () => {
  await withChannel(async (port) => {
    for (const p of ROUTES) {
      const res = await fetch(`http://127.0.0.1:${port}${p}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: "Bearer tok" },
        body: BAD,
      });
      assert.equal(
        res.status,
        400,
        `${p} 收到非法 JSON 应回 400 (实测 ${res.status}) —— 500 会把客户端错误误报成服务端故障`,
      );
    }
  });
});

test("非法 JSON body: 响应体带可读错误信息且不泄漏内部细节", { timeout: 20000 }, async () => {
  await withChannel(async (port) => {
    const res = await fetch(`http://127.0.0.1:${port}/message`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer tok" },
      body: BAD,
    });
    const body = await res.json().catch(() => ({}));
    assert.ok(body.error, "应返回 error 字段供客户端排查");
    assert.ok(
      !/SyntaxError|at JSON\.parse|node:internal/.test(JSON.stringify(body)),
      "不应把 Node 内部实现细节泄漏给客户端",
    );
  });
});

test("对照: 合法 JSON 与空 body 的错误语义不受本修复影响", { timeout: 20000 }, async () => {
  await withChannel(async (port) => {
    // 合法 JSON → 走正常链路 (无 LLM 时优雅降级, 非 5xx 崩溃)
    const okRes = await fetch(`http://127.0.0.1:${port}/message`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer tok" },
      body: JSON.stringify({ message: "hi" }),
    });
    assert.ok(okRes.status < 500, `合法 JSON 不应 5xx (实测 ${okRes.status})`);

    // 空 body → 缺 message 字段, 仍应是 400 (既有语义不变)
    const emptyRes = await fetch(`http://127.0.0.1:${port}/message`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer tok" },
      body: "",
    });
    assert.equal(emptyRes.status, 400, "空 body 仍应回 400 (缺 message 字段)");
  });
});

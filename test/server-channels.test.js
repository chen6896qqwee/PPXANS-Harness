// test/server-channels.test.js - server 通道配置合并 (config/ppx.json 基础 + 调用方覆盖)
// 回归保护: 之前 ChannelManager 只读调用方 config, 不读 config/ppx.json, 导致 channels.log 永不启用
import test from "node:test";
import assert from "node:assert";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import { startServer } from "../src/server.js";

function tmpRoot(n) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `ppx-srv-${n}-`));
  fs.mkdirSync(path.join(root, "config"), { recursive: true });
  return root;
}

async function stop(s) {
  s.server?.closeAllConnections?.();
  await new Promise((r) => setTimeout(r, 50));
  if (s.server && s.server.listening) await new Promise((r) => s.server.close(r));
}

test("server: config/ppx.json 里的 log 通道配置生效", async () => {
  const root = tmpRoot("log");
  // config/ppx.json 显式启用 log 通道 (模拟生产配置)
  fs.writeFileSync(path.join(root, "config", "ppx.json"), JSON.stringify({
    channels: { log: { enabled: true } },
    providers: [],
  }));
  const s = await startServer({ root, port: 0 });
  const list = s.manager.list();
  const logCh = list.find((c) => c.name === "log");
  assert.ok(logCh, "log 通道在列表中");
  assert.equal(logCh.enabled, true, "log 通道启用 (来自 config/ppx.json)");
  assert.equal(logCh.connected, true, "log 通道已连接");
  assert.ok(s.manager.get("log"), "可获取 log 通道实例");
  s.agent.shutdown();
  await stop(s);
  fs.rmSync(root, { recursive: true, force: true });
});

test("server: 调用方传入 port 覆盖 config 端口", async () => {
  const root = tmpRoot("port");
  fs.writeFileSync(path.join(root, "config", "ppx.json"), JSON.stringify({
    channels: { http: { enabled: true, port: 9999 } },
    providers: [],
  }));
  // 传入 port=0 (动态), 应覆盖 config 的 9999
  const s = await startServer({ root, port: 0 });
  const http = s.http;
  assert.ok(http, "http 通道存在");
  const addr = http.server.address();
  assert.ok(addr && addr.port !== 9999, `动态端口生效 (${addr && addr.port}), 未用 config 的 9999`);
  s.agent.shutdown();
  await stop(s);
  fs.rmSync(root, { recursive: true, force: true });
});

test("server: 无 config 文件时通道默认 (log 关闭, http 开启)", async () => {
  const root = tmpRoot("default");
  const s = await startServer({ root, port: 0 });
  const list = s.manager.list();
  const logCh = list.find((c) => c.name === "log");
  assert.equal(logCh.enabled, false, "默认 log 关闭");
  assert.ok(list.find((c) => c.name === "http").connected, "http 默认开启");
  s.agent.shutdown();
  await stop(s);
  fs.rmSync(root, { recursive: true, force: true });
});

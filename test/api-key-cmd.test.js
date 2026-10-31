// test/api-key-cmd.test.js — provider 密钥命令通道 (2026-10-31)
// api_key_cmd: 配一条命令取 stdout 作为 key, 密钥不必明文落盘 (零依赖密钥管理出口)。
import test from "node:test";
import assert from "node:assert";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { resolveApiKeyCmd, isUsableProvider, resolveAllLLMs } from "../src/llm/router.js";
import { addProvider, listProviders } from "../src/config/providers.js";

function tmp(tag) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), `ppx-keycmd-${tag}-`));
  fs.mkdirSync(path.join(d, "config"), { recursive: true });
  return d;
}

const IS_WIN = process.platform === "win32";
// 跨平台"打印一个假 key"的命令 (shell:true 执行)
const ECHO_CMD = IS_WIN
  ? "echo sk-from-cmd"
  : "echo sk-from-cmd";

test("resolveApiKeyCmd: 取 stdout 作为 key (去空白)", () => {
  const k = resolveApiKeyCmd({ api_key_cmd: ECHO_CMD });
  assert.equal(k, "sk-from-cmd");
});

test("resolveApiKeyCmd: 命令失败 / 空输出 → undefined (不炸启动)", () => {
  assert.equal(resolveApiKeyCmd({ api_key_cmd: IS_WIN ? "cmd /c exit 1" : "false" }), undefined);
  assert.equal(resolveApiKeyCmd({ api_key_cmd: IS_WIN ? "cmd /c exit 0" : "true" }), undefined, "空 stdout = 无 key");
  assert.equal(resolveApiKeyCmd({}), undefined);
  assert.equal(resolveApiKeyCmd(null), undefined);
});

test("isUsableProvider: api_key_cmd 是一路合法密钥来源 (云端 provider 可用)", () => {
  const p = { id: "c", base_url: "https://api.example.com/v1", model: "m1", api_key_cmd: ECHO_CMD };
  assert.equal(isUsableProvider(p), true);
  // 无任何 key 的云端 provider 仍不可用
  assert.equal(isUsableProvider({ id: "c2", base_url: "https://api.example.com/v1", model: "m1" }), false);
});

test("resolveAllLLMs: api_key_cmd 结果注入 client (api_key 优先级高于 cmd)", () => {
  const root = tmp("resolve");
  fs.writeFileSync(path.join(root, "config", "ppx.json"), JSON.stringify({
    providers: [{ id: "c", base_url: "https://api.example.com/v1", model: "m1", api_key_cmd: ECHO_CMD }],
  }));
  // 直接构造 config (不走 loadConfig, 避免默认 provider 干扰)
  const clients = resolveAllLLMs({
    providers: [{ id: "c", base_url: "https://api.example.com/v1", model: "m1", api_key_cmd: ECHO_CMD }],
  });
  assert.equal(clients.length, 1);
  assert.equal(clients[0].apiKey, "sk-from-cmd", "命令输出已注入");
  // 显式 api_key 存在时 cmd 不执行 (优先级: 明文 > cmd > env)
  const clients2 = resolveAllLLMs({
    providers: [{ id: "c", base_url: "https://api.example.com/v1", model: "m1", api_key: "sk-inline", api_key_cmd: ECHO_CMD }],
  });
  assert.equal(clients2[0].apiKey, "sk-inline");
});

test("providers CRUD: api_key_cmd 过白名单保留, 明文 api_key 永不回传", () => {
  const root = tmp("crud");
  const added = addProvider(root, {
    id: "c", base_url: "https://api.example.com/v1", model: "m1",
    api_key_cmd: ECHO_CMD,
  });
  assert.equal(added.api_key_cmd, ECHO_CMD, "cmd 字段保留 (非机密)");
  assert.equal(added.api_key, undefined, "明文不回传");
  const all = listProviders(root);
  assert.equal(all[0].api_key_cmd, ECHO_CMD);
});

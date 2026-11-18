// test/protected-read.test.js - read_file 受保护路径 (2026-10-31 安全收紧)
//
// 钉住的契约: read_file 在 TRUSTED_TOOLS 白名单里 (免审批直达), 因此必须在工具层自拦
// 三类敏感文件 —— 审计链 HMAC 密钥 / HTTP Bearer token / provider 配置 (可能含明文 key)。
// 被提示注入的 agent 免审批读到 HMAC 密钥 = 可重算重签整条审计链, append-only 名存实亡。
import test from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ToolCatalog, registerBuiltinTools } from "../src/tools/index.js";

function mkRootWithSecrets() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ppx-protread-"));
  fs.mkdirSync(path.join(root, ".ppx"), { recursive: true });
  fs.mkdirSync(path.join(root, "data"), { recursive: true });
  fs.mkdirSync(path.join(root, "config"), { recursive: true });
  fs.writeFileSync(path.join(root, ".ppx", "audit-hmac-key"), "a2cc637566de57c617d84bbe8ded8855a400978a5e1d388e");
  fs.writeFileSync(path.join(root, "data", "http-token"), "ppx_bearer_token_123");
  fs.writeFileSync(path.join(root, "config", "ppx.json"), JSON.stringify({ providers: [{ api_key: "sk-SECRET" }] }));
  fs.writeFileSync(path.join(root, "a.txt"), "normal content");
  return root;
}

test("安全: 审计 HMAC 密钥 / http-token / provider 配置 禁读且不泄漏内容", async () => {
  const root = mkRootWithSecrets();
  const c = new ToolCatalog();
  registerBuiltinTools(c, { rootDir: root });
  try {
    for (const [rel, secret] of [
      [".ppx/audit-hmac-key", "a2cc637566de57c617d84bbe8ded8855a400978a5e1d388e"],
      ["data/http-token", "ppx_bearer_token_123"],
      ["config/ppx.json", "sk-SECRET"],
    ]) {
      const r = await c.call("read_file", { path: rel });
      const j = JSON.parse(r);
      assert.ok(j.error, `${rel} 应被拒绝`);
      assert.match(j.error, /受保护路径/, `${rel} 的拒绝理由应说明受保护`);
      assert.ok(!r.includes(secret), `${rel} 的内容不得出现在回执里`);
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("安全: 大小写与分隔符变体同样拦截 (Windows 不敏感)", async () => {
  const root = mkRootWithSecrets();
  const c = new ToolCatalog();
  registerBuiltinTools(c, { rootDir: root });
  try {
    for (const rel of [".PPX/AUDIT-HMAC-KEY", ".ppx\\audit-hmac-key", "DATA\\HTTP-TOKEN", "CONFIG\\PPX.JSON"]) {
      const r = await c.call("read_file", { path: rel });
      assert.match(r, /受保护路径/, `${rel} 变体应被拦`);
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("安全: 普通文件不受影响", async () => {
  const root = mkRootWithSecrets();
  const c = new ToolCatalog();
  registerBuiltinTools(c, { rootDir: root });
  try {
    const r = await c.call("read_file", { path: "a.txt" });
    assert.ok(r.includes("normal content"), "普通文件照常可读");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

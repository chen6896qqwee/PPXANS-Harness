// test/http-token-persist.test.js - HTTP auth_token 持久化 (第九轮 review P2)
// resolveAuthToken 纯函数: 显式配置 > 持久化文件复用 > 新生成并原子落盘
import { test } from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolveAuthToken } from "../src/channels/http.js";

function tmpfile() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "ppx-tok-"));
  const f = path.join(d, "http-token");
  return { d, f };
}

test("P2: 显式配置优先, 不读写持久化文件", () => {
  const { d, f } = tmpfile();
  try {
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, "stale-token", "utf8");
    const r = resolveAuthToken({ configured: "explicit-abc", persistedFile: f });
    assert.equal(r.token, "explicit-abc");
    assert.equal(r.source, "configured");
    // 持久化文件保持不变 (显式配置不覆盖)
    assert.equal(fs.readFileSync(f, "utf8"), "stale-token");
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

test("P2: 优先复用持久化文件 token (重启不更换)", () => {
  const { d, f } = tmpfile();
  try {
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, "persisted-tok-123", "utf8");
    const r = resolveAuthToken({ configured: "", persistedFile: f });
    assert.equal(r.token, "persisted-tok-123");
    assert.equal(r.source, "persisted");
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

test("P2: 无任何 token 时生成并原子落盘, 第二次复用同一 token", () => {
  const { d, f } = tmpfile();
  try {
    const r1 = resolveAuthToken({ configured: "", persistedFile: f });
    assert.equal(r1.source, "generated");
    assert.ok(r1.token && r1.token.length >= 20, "应生成随机 token");
    assert.equal(fs.readFileSync(f, "utf8").trim(), r1.token, "生成后应立即落盘");
    // 模拟重启: 第二次调用应复用同一 token, 不再生成新值
    const r2 = resolveAuthToken({ configured: "", persistedFile: f });
    assert.equal(r2.token, r1.token);
    assert.equal(r2.source, "persisted");
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

test("P2: persistedFile 为 null 时只生成不落盘", () => {
  const r = resolveAuthToken({ configured: "", persistedFile: null });
  assert.equal(r.source, "generated");
  assert.ok(r.token && r.token.length >= 20);
});

test("P2: 空串显式配置视为未配置, 走持久化/生成路径", () => {
  const { d, f } = tmpfile();
  try {
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, "from-file", "utf8");
    const r = resolveAuthToken({ configured: "   ", persistedFile: f });
    assert.equal(r.token, "from-file", "空白显式配置应落到持久化复用");
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});
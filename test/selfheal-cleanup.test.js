// test/selfheal-cleanup.test.js - 自愈 corrupt 备份清理 (heal 内自动调用)
import test from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Healer } from "../src/selfheal/healer.js";

test("heal(): 自动清理旧 corrupt 备份, 保留最近 2 个", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ppx-heal-"));
  const memDir = path.join(root, "data", "memory");
  fs.mkdirSync(memDir, { recursive: true });
  // 造 4 个 corrupt 文件, mtime 依次递增 (corrupt-3 最新)
  for (let i = 0; i < 4; i++) {
    const f = path.join(memDir, `facts.json.corrupt-${i}`);
    fs.writeFileSync(f, "corrupt");
    const t = new Date(Date.now() - (4 - i) * 60000);
    fs.utimesSync(f, t, t);
  }
  const healer = new Healer(root);
  const report = healer.heal();
  assert.equal(report.cleanedCorrupt.length, 2, "应清理 2 个最旧的 corrupt");
  const remaining = fs.readdirSync(memDir).filter((f) => f.includes(".corrupt-")).sort();
  assert.deepEqual(remaining, ["facts.json.corrupt-2", "facts.json.corrupt-3"], "应保留最近 2 个");
  fs.rmSync(root, { recursive: true, force: true });
});

test("heal(): corrupt 不足 2 个时不误删", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ppx-heal2-"));
  const memDir = path.join(root, "data", "memory");
  fs.mkdirSync(memDir, { recursive: true });
  fs.writeFileSync(path.join(memDir, "facts.json.corrupt-0"), "x");
  const healer = new Healer(root);
  const report = healer.heal();
  assert.equal(report.cleanedCorrupt.length, 0, "1 个 corrupt 不应删除");
  assert.ok(fs.existsSync(path.join(memDir, "facts.json.corrupt-0")), "文件应保留");
  fs.rmSync(root, { recursive: true, force: true });
});

test("heal(): 自动清理旧手动备份目录 (memory-backup-*), 保留最近 2 个", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ppx-heal3-"));
  fs.mkdirSync(path.join(root, "data"), { recursive: true });
  // 造 3 个备份目录, mtime 依次递增 (backup-2 最新)
  for (let i = 0; i < 3; i++) {
    const d = path.join(root, "data", `memory-backup-${i}`);
    fs.mkdirSync(d, { recursive: true });
    fs.writeFileSync(path.join(d, "facts.json"), `{}`);
    const t = new Date(Date.now() - (3 - i) * 60000);
    fs.utimesSync(d, t, t);
  }
  const healer = new Healer(root);
  const report = healer.heal();
  assert.equal(report.cleanedBackupDirs.length, 1, "应清理 1 个最旧的手动备份目录");
  const remaining = fs.readdirSync(path.join(root, "data")).filter((f) => f.startsWith("memory-backup-")).sort();
  assert.deepEqual(remaining, ["memory-backup-1", "memory-backup-2"], "应保留最近 2 个");
  fs.rmSync(root, { recursive: true, force: true });
});

test("heal(): 手动备份目录不足 2 个时不误删", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ppx-heal4-"));
  fs.mkdirSync(path.join(root, "data", "memory-backup-0"), { recursive: true });
  fs.writeFileSync(path.join(root, "data", "memory-backup-0", "facts.json"), `{}`);
  const healer = new Healer(root);
  const report = healer.heal();
  assert.equal(report.cleanedBackupDirs.length, 0, "1 个备份目录不应删除");
  assert.ok(fs.existsSync(path.join(root, "data", "memory-backup-0")), "目录应保留");
  fs.rmSync(root, { recursive: true, force: true });
});

test("heal(): 自动清理旧 .bak-* 文件, 保留最近 2 个", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ppx-heal5-"));
  const memDir = path.join(root, "data", "memory");
  fs.mkdirSync(memDir, { recursive: true });
  // 造 4 个 .bak-* 文件, mtime 依次递增 (bak-3 最新)
  for (let i = 0; i < 4; i++) {
    const f = path.join(memDir, `facts.json.bak-${i}`);
    fs.writeFileSync(f, "bak");
    const t = new Date(Date.now() - (4 - i) * 60000);
    fs.utimesSync(f, t, t);
  }
  const healer = new Healer(root);
  const report = healer.heal();
  assert.equal(report.cleanedBakFiles.length, 2, "应清理 2 个最旧的 .bak-*");
  const remaining = fs.readdirSync(memDir).filter((f) => f.includes(".bak-")).sort();
  assert.deepEqual(remaining, ["facts.json.bak-2", "facts.json.bak-3"], "应保留最近 2 个");
  fs.rmSync(root, { recursive: true, force: true });
});

test("heal(): .bak-* 文件不足 2 个时不误删", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ppx-heal6-"));
  const memDir = path.join(root, "data", "memory");
  fs.mkdirSync(memDir, { recursive: true });
  fs.writeFileSync(path.join(memDir, "facts.json.bak-dedupe"), "x");
  const healer = new Healer(root);
  const report = healer.heal();
  assert.equal(report.cleanedBakFiles.length, 0, "1 个 .bak-* 不应删除");
  assert.ok(fs.existsSync(path.join(memDir, "facts.json.bak-dedupe")), "文件应保留");
  fs.rmSync(root, { recursive: true, force: true });
});

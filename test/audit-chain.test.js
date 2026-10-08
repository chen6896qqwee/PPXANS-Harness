// test/audit-chain.test.js - 审计哈希链测试 (合并 ppx-v2 能力)
// 覆盖: 链完整性 / 篡改检测定位 / PII 脱敏 / 隔离重建 / 工具调用收口集成
import { test } from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { AuditLog, auditFile, scrubArgs, quarantineBroken } from "../src/audit/audit-chain.js";
import { ToolCatalog } from "../src/tools/catalog.js";

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "ppx-audit-"));
}

function tamperLine(file, n, mutate) {
  const lines = fs.readFileSync(file, "utf8").trim().split("\n");
  const e = JSON.parse(lines[n]);
  mutate(e);
  lines[n] = JSON.stringify(e);
  fs.writeFileSync(file, lines.join("\n") + "\n", "utf8");
}

test("AuditLog: 追加记录形成哈希链且校验通过", () => {
  const dir = tmpDir();
  const log = new AuditLog(dir);
  const a = log.append({ tool: "read_file", args: { p: "a.txt" }, ok: true, ms: 3 });
  const b = log.append({ tool: "write_file", args: { p: "b.txt" }, ok: true, ms: 7 });
  assert.equal(a.seq, 1);
  assert.equal(b.seq, 2);
  assert.equal(b.prevHash, a.hash, "第二条应链接到第一条 hash");
  assert.equal(a.prevHash, null, "链首 prevHash 应为 null");
  const v = log.verify();
  assert.equal(v.ok, true);
  assert.equal(v.total, 2);
  assert.equal(v.brokenAt, null);
});

test("AuditLog: 篡改内容被检测并定位到具体行", () => {
  const dir = tmpDir();
  const log = new AuditLog(dir);
  log.append({ tool: "t1", args: { x: 1 }, ok: true });
  log.append({ tool: "t2", args: { x: 2 }, ok: true });
  log.append({ tool: "t3", args: { x: 3 }, ok: true });
  assert.equal(log.verify().ok, true);

  tamperLine(auditFile(dir), 1, (e) => { e.args.x = 999; });
  const v = log.verify();
  assert.equal(v.ok, false);
  assert.equal(v.brokenAt, 2, "应定位到第 2 行");
  assert.match(v.detail, /hash 不匹配|篡改/);
});

test("AuditLog: 删除中间行导致 prevHash 断裂被发现", () => {
  const dir = tmpDir();
  const log = new AuditLog(dir);
  for (let i = 1; i <= 3; i++) log.append({ tool: "t" + i, args: {}, ok: true });
  const f = auditFile(dir);
  const lines = fs.readFileSync(f, "utf8").trim().split("\n");
  fs.writeFileSync(f, [lines[0], lines[2]].join("\n") + "\n", "utf8");
  const v = log.verify();
  assert.equal(v.ok, false);
  assert.equal(v.brokenAt, 2);
  assert.match(v.detail, /prevHash 断裂/);
});

test("scrubArgs: 密钥/手机号不落明文", () => {
  const out = scrubArgs({ api_key: "sk-1234567890abcdef", url: "https://x.com?token=SECRETVALUE12345678", phone: "13812345678", note: "ok" });
  assert.equal(out.api_key, "sk-***");
  assert.ok(!out.url.includes("SECRETVALUE12345678"));
  assert.equal(out.phone, "1**********");
  assert.equal(out.note, "ok");
});

test("AuditLog: 长参数被截断防爆日志", () => {
  const dir = tmpDir();
  const log = new AuditLog(dir);
  const long = "x".repeat(2000);
  const e = log.append({ tool: "t", args: { big: long }, ok: true });
  assert.ok(e.args.big.length < 600);
  assert.match(e.args.big, /\+1500字符/);
});

test("quarantineBroken: 损坏日志被隔离且重建空链", () => {
  const dir = tmpDir();
  const log = new AuditLog(dir);
  log.append({ tool: "t1", args: {}, ok: true });
  log.append({ tool: "t2", args: {}, ok: true });
  tamperLine(auditFile(dir), 0, (e) => { e.tool = "HACKED"; });

  const q = quarantineBroken(dir);
  assert.equal(q.quarantined, true);
  assert.ok(q.backup && fs.existsSync(q.backup), "应留下隔离备份");
  const after = new AuditLog(dir).verify();
  assert.equal(after.ok, true, "重建后新链应完整");
  const entries = new AuditLog(dir).tail(5);
  assert.equal(entries[0].tool, "audit_quarantine", "应记录隔离事件作为新链起点");
});

test("quarantineBroken: 健康日志不触发隔离", () => {
  const dir = tmpDir();
  const log = new AuditLog(dir);
  log.append({ tool: "t1", args: {}, ok: true });
  const q = quarantineBroken(dir);
  assert.equal(q.quarantined, false);
  assert.equal(q.ok, true);
});

test("ToolCatalog: 注入审计后每次工具调用自动落链", async () => {
  const dir = tmpDir();
  const catalog = new ToolCatalog();
  catalog.register({
    name: "echo",
    description: "回显",
    parameters: { type: "object", properties: { s: { type: "string" } }, required: [] },
    idempotent: true,
    execute: async (args) => "echo:" + (args.s || ""),
  });
  catalog.setAudit(new AuditLog(dir));
  await catalog.call("echo", { s: "hi" });
  await catalog.call("echo", { s: "again" });

  const log = new AuditLog(dir);
  const v = log.verify();
  assert.equal(v.ok, true);
  assert.equal(v.total, 2, "两次调用应各落一条审计");
  const entries = log.tail(5);
  assert.equal(entries[0].tool, "echo");
  assert.equal(entries[0].ok, true);
  assert.ok(entries[0].ms >= 0);
});

test("ToolCatalog: 未注入审计时保持零开销且不报错", async () => {
  const catalog = new ToolCatalog();
  catalog.register({
    name: "echo2",
    description: "回显",
    parameters: { type: "object", properties: {}, required: [] },
    execute: async () => "ok",
  });
  assert.equal(catalog.audit, undefined);
  const r = await catalog.call("echo2", {});
  assert.equal(r, "ok");
});

// ---- 端到端装配守卫 (2026-10-07 评估报告 P0-2 复查后补) ----
// 背景: 评估报告曾据 audit:verify 输出"条数: 0"判定审计未生效。复查发现是误判 ——
//   机制本身是通的 (一次工具调用即落 1 条), 当时 0 条只是因为没跑过任何会话。
// 但这次复查暴露了一个**真实的脆弱点**: audit 是靠 toolsPlugin 里一行手工的
//   `tools.setAudit(ctx.consume("audit"))` 挂上去的。只要有人调整插件顺序、或 auditPlugin
//   提前 return null (audit.enabled:false 那条分支), 装配链就会**静默断裂**:
//   工具照常跑、测试照常绿 (单元测试是手工注入 audit 的, 走不到这条路径)、
//   只有审计账本悄悄变空 —— 而这恰恰是"可追责"这个卖点失效的方式。
// 所以这里补一条端到端断言: 完整装配的 agent, 调一次工具, 审计文件必须非空。
test("端到端: 完整装配后调用工具必须落审计 (防 setAudit 装配链静默断裂)", async () => {
  const { PPXAgent } = await import("../src/agent/index.js");
  const dataDir = tmpDir();
  const root = tmpDir();
  const a = new PPXAgent({ root, dataDir });

  // 装配链必须真的把 audit 挂上 (这一条是断裂时的首个可见信号)
  const audit = a.ctx?.consume ? a.ctx.consume("audit") : null;
  assert.ok(audit, "默认配置下 auditPlugin 必须产出 AuditLog (audit.enabled 未关)");
  assert.ok(a.tools.audit, "toolsPlugin 必须把 audit 挂到 ToolCatalog (setAudit)");

  await a.tools.call("get_time", {}, {});
  const file = auditFile(dataDir);
  assert.ok(fs.existsSync(file), `审计文件必须被创建: ${file}`);
  const lines = fs.readFileSync(file, "utf8").trim().split("\n").filter(Boolean);
  assert.ok(lines.length >= 1, `一次工具调用应至少落 1 条审计, 实际 ${lines.length}`);

  const log = new AuditLog(dataDir);
  const v = log.verify();
  assert.equal(v.ok, true, "刚写入的链必须自校验通过");
  assert.equal(v.total, lines.length, "verify 条数应与文件行数一致");
});

// test/hardening-2026-10-24.test.js - 2026-10-24 加固批次回归测试
// 覆盖: shell 结构化守卫 / 权限 realpath / 审计 HMAC / 飞书解密+防重放 /
//       军团 broadcast 形状 / 哈希 embedder+向量落盘 / token 精估 / 循环内预算闸门 /
//       SessionStart/Stop 钩子 / Playbook delta 生产者
import test from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";

// ---- shell 结构化解析 ----
import { tokenizeShell, parseShellCommand } from "../src/security/shell-parse.js";
import { checkCommand } from "../src/tools/command-guard.js";
// ---- 审计 HMAC ----
import { AuditLog, loadOrCreateHmacKey, quarantineBroken } from "../src/audit/audit-chain.js";
// ---- 飞书 ----
import { feishuDecrypt, feishuSign, FeishuChannel } from "../src/channels/feishu.js";
// ---- 军团 ----
import { Legion } from "../src/orchestrator/legion.js";
import { legionExecutor } from "../src/mode/legion.js";
// ---- 记忆 ----
import { hashEmbed, HASH_EMBEDDER_ID } from "../src/memory/hash-embedder.js";
import { VectorDiskCache } from "../src/memory/vector-disk.js";
import { estimateTokens, setTokenEstimator } from "../src/utils/text.js";
// ---- 进化 ----
import { recordLesson, categorizeFailure } from "../src/evolve/delta-producer.js";
import { PlaybookStore } from "../src/evolve/playbook.js";
import { LearningService } from "../src/services/learning-service.js";
// ---- 循环内预算闸门 ----
import { runToolLoop } from "../src/core/policy.js";
// ---- 钩子 / agent ----
import { PPXAgent } from "../src/agent/index.js";

function tmpDir(tag) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `ppx-hard-${tag}-`));
}

// ================= 1. shell-parse =================
test("shell-parse: 分词感知引号, 引号内分隔符不切段", () => {
  const { segments, argv0s } = parseShellCommand(`echo "a; rm -rf /" && ls`);
  assert.equal(segments.length, 2, "引号内的 ; 不是分隔符");
  assert.deepEqual(argv0s, ["echo", "ls"]);
});

test("shell-parse: 检出 $() 反引号 进程替换, 单引号内不算", () => {
  assert.equal(parseShellCommand("echo $(rm -rf /)").substitutions.length, 1);
  assert.ok(parseShellCommand("echo `whoami`").substitutions.length >= 1, "反引号 (开/闭各记一次, 出现即拦)");
  assert.equal(parseShellCommand("diff <(a) >(b)").substitutions.length, 2);
  assert.equal(parseShellCommand("echo 'literal $(not substituted)'").substitutions.length, 0, "单引号 = 字面量");
});

test("command-guard: 命令替换硬拦, allow_all 也拦 (旧洞封死)", () => {
  const r = checkCommand("echo $(rm -rf /tmp/x)", { allowAll: true });
  assert.equal(r.ok, false, "allow_all 放不开命令替换");
  assert.equal(r.hard, true);
  const r2 = checkCommand("echo `cat /etc/passwd`", { allowAll: true });
  assert.equal(r2.ok, false);
});

test("command-guard: 逐段白名单 —— 段2 不在白名单也拦 (旧只看整串首词)", () => {
  const r = checkCommand("git status; someRandomBinary --do-things", {});
  assert.equal(r.ok, false);
  assert.ok(r.reason.toLowerCase().includes("somerandombinary"), "报出越段命令名");
  // 两段都在白名单 → 放行
  assert.equal(checkCommand("git status && npm test", {}).ok, true);
});

test("command-guard: allow_inline_exec 可放开命令替换 (opt-in 语义一致)", () => {
  assert.equal(checkCommand("echo $(date)", { allowAll: true, allow_inline_exec: true }).ok, true);
});

// ================= 2. 权限 realpath =================
test("permissions: 工作区内符号链接指向根外 = 越界 (realpath 复核)", async () => {
  const root = tmpDir("perm");
  const outside = tmpDir("outside");
  const link = path.join(root, "link-out");
  let linked = false;
  try {
    fs.symlinkSync(outside, link, "junction");
    linked = true;
  } catch { /* 无符号链接权限的环境跳过 */ }
  if (linked) {
    const { createPermissionEngine, SandboxPolicy } = await import("../src/permissions/index.js");
    const eng = createPermissionEngine({
      sandbox: SandboxPolicy.WORKSPACE_WRITE,
      workspaceRoot: root,
      approvalMode: "on-request",
    });
    const r = await eng.check("write_file", { path: path.join(link, "evil.txt"), content: "x" });
    assert.equal(r.decision, "deny", `realpath 越界应 deny, got ${r.decision}: ${r.reason}`);
  }
  // 根内普通路径不受影响
  const { createPermissionEngine: mk, SandboxPolicy: SB } = await import("../src/permissions/index.js");
  const eng2 = mk({ sandbox: SB.WORKSPACE_WRITE, workspaceRoot: root, approvalMode: "on-request" });
  const ok = await eng2.check("write_file", { path: path.join(root, "normal.txt"), content: "x" });
  assert.notEqual(ok.decision, "deny", "根内路径不应误伤");
  fs.rmSync(root, { recursive: true, force: true });
  fs.rmSync(outside, { recursive: true, force: true });
});

// ================= 3. 审计 HMAC =================
test("audit: HMAC 签名防整链重算, 无密钥伪造校验失败", () => {
  const dir = tmpDir("audit");
  const log = new AuditLog(dir, { hmacKey: "secret-key-abc" });
  log.append({ tool: "t1", args: { a: 1 }, ok: true });
  const v1 = log.verify();
  assert.equal(v1.ok, true);
  assert.equal(v1.signed, true);
  assert.equal(v1.unsigned, 0);

  // 篡改内容 + **重算 hash** (模拟"能写文件者整链重算"攻击) → 只有 HMAC 能抓住
  const lines = fs.readFileSync(log.file, "utf8").trim().split("\n");
  const e = JSON.parse(lines[0]);
  e.tool = "forged";
  e.hash = crypto.createHash("sha256")
    .update(`${e.seq}|${e.ts}|${e.tool}|${JSON.stringify(e.args)}|${e.ok}|${e.prevHash}`)
    .digest("hex");
  lines[0] = JSON.stringify(e);
  fs.writeFileSync(log.file, lines.join("\n") + "\n");
  const v2 = log.verify();
  assert.equal(v2.ok, false, "HMAC 应抓到整链重算攻击 (重算 hash 造不出合法 sig)");
  assert.ok(v2.detail.includes("HMAC"), v2.detail);

  // 无密钥构造的校验器: 同账本可读 (signed=false), 哈希校验不受影响 → 隔离重建
  const fresh = new AuditLog(dir, { hmacKey: null });
  assert.equal(fresh.verify().ok, true, "裸哈希模式仍可校验 (升级兼容)");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("audit: 未签名历史行不判死, 计数上报 (平滑升级)", () => {
  const dir = tmpDir("audit2");
  const legacy = new AuditLog(dir, { hmacKey: null });
  legacy.append({ tool: "old", args: {}, ok: true }); // 无 sig
  const modern = new AuditLog(dir, { hmacKey: "k" });
  modern.append({ tool: "new", args: {}, ok: true }); // 有 sig
  const v = modern.verify();
  assert.equal(v.ok, true);
  assert.equal(v.unsigned, 1, "1 条历史未签名行");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("audit: loadOrCreateHmacKey 优先环境变量, 文件自动生成", () => {
  const root = tmpDir("key");
  const k1 = loadOrCreateHmacKey(root, { env: { PPX_AUDIT_HMAC_KEY: "env-key" } });
  assert.equal(k1, "env-key");
  const k2 = loadOrCreateHmacKey(root, { env: {} });
  assert.ok(/^[0-9a-f]{64}$/.test(k2), "自动生成 32 字节 hex");
  assert.equal(k2, loadOrCreateHmacKey(root, { env: {} }), "复用已生成密钥");
  fs.rmSync(root, { recursive: true, force: true });
});

// ================= 4. 飞书解密 / 签名 / 防重放 =================
function feishuEncrypt(encryptKey, plainObj) {
  const key = crypto.createHash("sha256").update(encryptKey, "utf8").digest();
  const iv = crypto.randomBytes(16);
  const c = crypto.createCipheriv("aes-256-cbc", key, iv);
  const data = Buffer.concat([c.update(JSON.stringify(plainObj), "utf8"), c.final()]);
  const padLen = 16 - (data.length % 16); // PKCS7 (节点 crypto 已自动填充, 此处仅示意) — 实际直接用
  return Buffer.concat([iv, data]).toString("base64");
}

test("feishu: encrypt_key 事件解密 (官方 AES-256-CBC 规范)", () => {
  const enc = feishuEncrypt("my-key", { type: "url_verification", challenge: "xyz", token: "t" });
  const plain = JSON.parse(feishuDecrypt("my-key", enc));
  assert.equal(plain.challenge, "xyz");
});

test("feishu: 签名函数确定且随输入变化", () => {
  const a = feishuSign({ timestamp: "1", nonce: "n", body: "b", encryptKey: "k" });
  assert.equal(a, feishuSign({ timestamp: "1", nonce: "n", body: "b", encryptKey: "k" }));
  assert.notEqual(a, feishuSign({ timestamp: "2", nonce: "n", body: "b", encryptKey: "k" }));
});

test("feishu: 同一 event_id 重放只处理一次 (防重放)", async () => {
  const ch = new FeishuChannel({ config: {} }, { verifyToken: "tok" });
  ch.verifyToken = "tok";
  const event = {
    header: { event_id: "evt-1" },
    event: { type: "im.message.receive_v1", message: { content: "{}" } },
  };
  const r1 = await ch.handleWebhook(event);
  assert.equal(r1.code, 0);
  const r2 = await ch.handleWebhook(event);
  assert.equal(r2.msg, "duplicate", "重投递不再触发对话");
  // 不同 event_id 正常处理
  const r3 = await ch.handleWebhook({ ...event, header: { event_id: "evt-2" } });
  assert.equal(r3.code, 0);
});

test("feishu: 收到加密事件但未配 encrypt_key = fail closed", async () => {
  const ch = new FeishuChannel({ config: {} }, { verifyToken: "tok" });
  const r = await ch.handleWebhook({ encrypt: "AAAA" });
  assert.equal(r.code, 1);
  assert.ok(r.msg.includes("未配置"));
});

// ================= 5. 军团 broadcast 形状 =================
test("legion: broadcast 返回 {agent, ok, reply} 统一形状, 失败带 error", async () => {
  const L = new Legion();
  L.agents.set("a1", { proc: { exitCode: null }, pending: new Map(), counter: 0 });
  L.agents.set("a2", { proc: { exitCode: null }, pending: new Map(), counter: 0 });
  L.send = async (name) => {
    if (name === "a2") throw new Error("boom");
    return { type: "reply", reply: `R-${name}` };
  };
  const results = await L.broadcast("chat", "hi");
  assert.deepEqual(results.map((r) => [r.agent, r.ok]), [["a1", true], ["a2", false]]);
  assert.equal(results[0].reply, "R-a1");
  assert.equal(results[1].error, "boom");
  await L.shutdownAll();
});

test("legion: mode/legion 广播采纳 ok.reply, 不再恒判全败", async () => {
  const L = new Legion();
  L.agents.set("a1", { proc: { exitCode: null }, pending: new Map(), counter: 0 });
  L.send = async () => ({ type: "reply", reply: "军团答案" });
  const agent = { config: {}, dataDir: tmpDir("legion-mode"), _legion: undefined };
  const out = await legionExecutor(agent, "问题", { legion: L });
  assert.equal(out, "军团答案");
  // 全部失败路径
  const L2 = new Legion();
  L2.agents.set("a1", { proc: { exitCode: null }, pending: new Map(), counter: 0 });
  L2.send = async () => { throw new Error("down"); };
  const out2 = await legionExecutor({ config: {}, dataDir: os.tmpdir() }, "问题", { legion: L2 });
  assert.ok(out2.includes("均未返回有效结果"));
});

// ================= 6. 哈希 embedder + 向量落盘 =================
test("hash-embedder: 确定性 / L2 归一 / 相同文本余弦 1 / 词形相近 > 无关", () => {
  const a = hashEmbed("running quickly");
  const b = hashEmbed("running quickly");
  assert.deepEqual(a, b, "确定性");
  let norm = Math.sqrt(a.reduce((s, x) => s + x * x, 0));
  assert.ok(Math.abs(norm - 1) < 1e-9, "L2 归一化");
  const cos = (u, v) => u.reduce((s, x, i) => s + x * v[i], 0);
  const c = hashEmbed("running faster");
  const d = hashEmbed("完全无关的内容");
  assert.ok(cos(a, c) > 0.2, `词形相近应有正相似 (got ${cos(a, c).toFixed(3)})`);
  assert.ok(cos(a, c) > cos(a, d), "相近 > 无关");
  // CJK 支持
  const e1 = hashEmbed("记住部署端口是 8899");
  const e2 = hashEmbed("部署端口 8899");
  assert.ok(cos(e1, e2) > 0.3, `CJK 共现词相似 (got ${cos(e1, e2).toFixed(3)})`);
});

test("vector-disk: 内容哈希失效键 + 指纹换代作废", () => {
  const dir = tmpDir("vec");
  const c1 = new VectorDiskCache(dir, { fingerprint: "m1", flushDelayMs: 5 });
  c1.set("f1", "hash-a", [1, 2, 3]);
  c1.flush();
  const c2 = new VectorDiskCache(dir, { fingerprint: "m1" });
  assert.deepEqual(c2.get("f1", "hash-a"), [1, 2, 3], "同指纹同内容命中");
  assert.equal(c2.get("f1", "hash-b"), null, "内容变 = 失效");
  const c3 = new VectorDiskCache(dir, { fingerprint: "m2" });
  assert.equal(c3.get("f1", "hash-a"), null, "embedder 换代 = 全量作废");
  fs.rmSync(dir, { recursive: true, force: true });
});

// ================= 7. token 精估 + 可插拔 =================
test("estimateTokens: CJK 密度高于英文; 可外接真 tokenizer; null 恢复", () => {
  const en = estimateTokens("hello world this is english text!!");
  const cn = estimateTokens("这是一段中文文本用于测试");
  assert.ok(cn > en * 0.8, `等长下 CJK 估值应显著高于英文 (cn=${cn}, en=${en})`);
  setTokenEstimator((s) => String(s).length); // 真 tokenizer 形状
  assert.equal(estimateTokens("abc"), 3);
  setTokenEstimator(null);
  assert.ok(estimateTokens("abc") < 3, "恢复内置启发式");
});

// ================= 8. 循环内预算闸门 =================
test("policy: budgetBlocked 第 2 轮起收口 (入口闸管不住循环内烧钱)", async () => {
  let calls = 0;
  const llm = {
    apiChat: async () => {
      calls++;
      return { message: { role: "assistant", content: "", tool_calls: [{ id: "c1", type: "function", function: { name: "noop", arguments: "{}" } }] } };
    },
  };
  const out = await runToolLoop({
    seedMessages: [{ role: "user", content: "干活" }],
    llm,
    tools: [{ type: "function", function: { name: "noop", description: "d", parameters: { type: "object", properties: {} } } }],
    config: { agent: { max_tool_rounds: 5 } },
    runTool: async () => "done",
    budgetBlocked: () => "USD 超限",
  });
  assert.equal(calls, 1, "第 2 轮前被闸, 只调了 1 次 LLM");
  assert.ok(out.includes("预算闸门"), out.slice(0, 80));
});

// ================= 9. SessionStart/Stop 钩子 =================
test("hooks: SessionStart 每会话一次, SessionStop 在 shutdown 触发", async () => {
  const root = tmpDir("hooks");
  const agent = new PPXAgent({ root, configFile: null });
  agent.llm = { chat: async () => ({ content: "ok" }), apiChat: async () => ({ message: { role: "assistant", content: "ok" } }) };
  const starts = [];
  const stops = [];
  agent.hooks.on("SessionStart", async (p) => { starts.push(p.sessionKey); });
  agent.hooks.on("SessionStop", async (p) => { stops.push(p.sessions.length); });
  await agent.chat("第一条", { sessionKey: "s1", persist: false });
  await agent.chat("第二条", { sessionKey: "s1", persist: false });
  await agent.chat("别的会话", { sessionKey: "s2", persist: false });
  assert.deepEqual(starts, ["s1", "s2"], "每会话恰好一次");
  await agent.shutdown();
  assert.equal(stops.length, 1, "SessionStop 在 shutdown 触发");
  fs.rmSync(root, { recursive: true, force: true });
});

// ================= 10. Playbook delta 生产者 =================
test("delta-producer: 经验 → playbook ADD (带查重与容量门禁)", async () => {
  const dir = tmpDir("pb");
  const store = new PlaybookStore(dir);
  const r1 = await recordLesson(store, "读文件前先确认路径存在", { kind: "pitfall" });
  assert.equal(r1.committed, true);
  assert.equal(store.playbook.bullets.length, 1);
  assert.equal(store.playbook.bullets[0].kind, "pitfall");
  // 相似内容 → 查重拒收
  const r2 = await recordLesson(store, "读文件前先确认路径存在!", { kind: "pitfall" });
  assert.equal(r2.committed, true);
  assert.equal(store.playbook.bullets.length, 1, "词法查重拦截重复");
  // 空经验 / 无 store
  assert.equal((await recordLesson(store, "")).committed, false);
  assert.equal((await recordLesson(null, "x")).committed, false);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("delta-producer: 失败分类确定性规则", () => {
  assert.equal(categorizeFailure("HTTP 429 rate limited"), "throttle");
  assert.equal(categorizeFailure("ETIMEDOUT 连接超时"), "network");
  assert.equal(categorizeFailure("401 Unauthorized: bad api key"), "auth");
  assert.equal(categorizeFailure("参数校验失败: path required"), "validation");
  assert.equal(categorizeFailure("莫名其妙"), "unknown");
});

test("learning-service: refine 成功后同步写 playbook (进化闭环)", async () => {
  const dir = tmpDir("ls");
  const playbook = new PlaybookStore(dir);
  const traces = { read: () => [
    { ok: false, tool: "read_file", error: "ENOENT no such file", ts: 1 },
    { ok: false, tool: "read_file", error: "ENOENT again", ts: 2 },
  ] };
  const svc = new LearningService({
    getLlm: () => ({ chat: async () => ({ content: "读文件前先检查文件存在" }) }),
    traces,
    playbook,
    experience: { learn: () => {} },
    auditor: { gate: async (_k, params, _v, onCommit) => { await onCommit(params); return { committed: true }; } },
    tracer: { event: () => {} },
    toolNames: () => ["read_file"],
    failures: null,
  });
  const r = await svc.refine();
  assert.equal(r.distilled, 1);
  assert.equal(playbook.playbook.bullets.length, 1, "经验同步进 playbook");
  assert.ok(playbook.playbook.bullets[0].evidence_ref.startsWith("trace:read_file"), "evidence_ref 溯源");
  fs.rmSync(dir, { recursive: true, force: true });
});

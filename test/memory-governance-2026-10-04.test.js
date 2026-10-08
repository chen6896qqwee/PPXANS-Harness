// test/memory-governance-2026-10-04.test.js — 记忆治理 + 并发落盘回归 (计划 #4 收尾)
// 覆盖本轮修的九件事, 每条都对应一个"以前会静默出错"的现实场景:
//   G1 _prune 只按活跃事实算容量 (软删/归档不再挤占名额把常用记忆裁掉)
//   G2 精确去重按 scope 判定 (跨作用域加分不再"写了等于没写")
//   G3 向量缓存真 LRU + update 后作废
//   G4 e5 类非对称模型 query/passage 前缀分侧
//   G5 TTL 治理接线 (sweepExpired 此前只在测试里被调用过)
//   G6 L2 场景跨进程读-改-写 + 损坏文件留档
//   G7 longterm 滚动/日终/rollup 三处共用 seq 游标 (不再双写原文)
//   G8 会话 seq 跨进程不重复 (含两子进程并发同 key 竞态: 锁内 _ensureUniqueSeq 重排兜底)
//   G9 审计链跨进程加锁 + 尾行重读 (链不断, 不被误判成篡改)
//   G10 安全钩子 fail-closed
import test from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { FactStore } from "../src/memory/fact-store.js";
import { SceneStore } from "../src/memory/l2.js";
import { SessionStore } from "../src/memory/session.js";
import { MemoryTicker } from "../src/memory/memory-ticker.js";
import { AuditLog } from "../src/audit/audit-chain.js";
import { createHookRegistry } from "../src/hooks/index.js";
import { PPXAgent } from "../src/agent/index.js";
import { logicalDay } from "../src/utils/store.js";

function tmp(name = "gov") {
  return fs.mkdtempSync(path.join(os.tmpdir(), `ppx-${name}-`));
}

// ---- G1 容量裁剪只看活跃事实 ----
test("G1 _prune: 软删条目不占 maxFacts 名额, 活跃事实不被误裁", () => {
  // 先关裁剪把"活跃 + 软删"两种状态铺好, 再打开 maxFacts, 隔离出"谁参与名额竞争"这一件事
  const st = new FactStore(tmp("prune"), { maxFacts: 0 });
  const keepHigh = st.add("重要: 止损线是亏损5%清仓", { importance: 20 });
  for (let i = 0; i < 7; i++) st.add(`活跃记忆 ${i}`, { importance: 12 });
  for (let i = 0; i < 4; i++) st.forget(st.add(`废弃记忆 ${i}`, { importance: 1 }).id, { reason: "测试" });
  assert.equal(st.count(), 12, "盘上 12 行, 其中 4 行已软删");

  st.opts.maxFacts = 8;
  for (let i = 0; i < 5; i++) st.add(`后续记忆 ${i}`, { importance: 12 });
  const live = st.list();
  assert.equal(live.length, 8, `活跃事实应裁到 8, 实际 ${live.length}`);
  assert.ok(live.some((f) => f.id === keepHigh.id), "高重要性事实必须留下");
  assert.equal(st.countLive(), live.length, "countLive 与可见列表一致");
  assert.equal(st.count(), 12, "软删行不该被当成'最弱'硬删来凑名额");
  assert.equal(st.deletedList().length, 4, "软删条目留在盘上可 restore");
});

// ---- G2 精确去重按 scope ----
test("G2 去重: 同内容不同 scope 各自成条, 不再命中别处的隐形副本", () => {
  const st = new FactStore(tmp("scope"));
  const a = st.add("服务器重启命令是 systemctl restart ppx", { scope: "sA" });
  const b = st.add("服务器重启命令是 systemctl restart ppx", { scope: "sB" });
  assert.notEqual(a.id, b.id, "不同作用域应各自成条");
  const c = st.add("服务器重启命令是 systemctl restart ppx", { scope: "sA" });
  assert.equal(c.id, a.id, "同作用域同内容仍应去重");
  assert.equal(c.hits, 1, "同作用域命中加分");
  assert.equal(b.hits, 0, "别的作用域不该被顺手加分");
  assert.equal(st.countLive(), 2);
});

// ---- G3/G4 向量缓存与 role 前缀 ----
test("G3 向量缓存: 真 LRU (命中即刷新最近使用)", () => {
  const st = new FactStore(tmp("lru"));
  st._embedCacheMax = 2;
  st._embedCacheSet("a", [1]);
  st._embedCacheSet("b", [2]);
  st._embedCacheGet("a"); // a 变成最近使用, b 成为最久未用
  st._embedCacheSet("c", [3]);
  assert.ok(st._embedCache.has("a"), "刚用过的不应被淘汰 (旧 FIFO 实现淘汰的就是它)");
  assert.ok(!st._embedCache.has("b"), "最久未用的应被淘汰");
  assert.ok(st._embedCache.has("c"));
});

test("G3/G4 embedder: update 后向量作废, query/passage 分侧调用", () => {
  const st = new FactStore(tmp("embed"));
  const roles = [];
  let calls = 0;
  st.setEmbedder(async (text, role) => {
    calls += 1;
    roles.push({ role, len: String(text).length });
    // passage 与 query 给不同向量, 让"分侧"可被断言
    return role === "passage" ? [1, 0] : [0, 1];
  });
  const f = st.add("兄弟喜欢用 Node 22 跑测试");
  st.add("止损规则是亏 5% 清仓");
  return st.querySemantic("测试用什么版本").then(() => {
    const passageCalls = roles.filter((r) => r.role === "passage");
    const queryCalls = roles.filter((r) => r.role === "query");
    assert.equal(queryCalls.length, 1, "查询侧一次, role=query");
    assert.ok(passageCalls.length >= 1, "文档侧 role 应为 passage, 不能也按 query 编码");
    const before = calls;
    st.update(f.id, "兄弟改用 Node 24 跑测试");
    return st.querySemantic("测试用什么版本").then(() => {
      assert.ok(calls > before, "内容变了必须重新向量化, 不能拿旧向量排序");
    });
  });
});

// ---- G5 TTL 治理接线 ----
test("G5 sweepMemoryTtl: 超期未访问软归档, ttl_days=0 时不动", () => {
  const stub = (ttl) => {
    const st = new FactStore(tmp("ttl"));
    const f = st.add("一次性提醒: 周三交报表", { ttlDays: 7 });
    f.lastAccess = new Date(Date.now() - 30 * 86400000).toISOString();
    st._markMutated(f);
    return { st, f, agent: { config: { memory: { ttl_days: ttl } }, facts: st, debug: () => {} } };
  };
  const on = stub(7);
  const r = PPXAgent.prototype.sweepMemoryTtl.call(on.agent);
  assert.equal(r.swept, 1, "30 天未访问 + ttlDays 7 -> 应归档 1 条");
  assert.equal(on.st.list().find((x) => x.id === on.f.id), undefined, "归档后不可见");
  assert.ok(on.st.restore(on.f.id), "软归档可回滚 (不是硬删)");

  const off = stub(0);
  const r2 = PPXAgent.prototype.sweepMemoryTtl.call(off.agent);
  assert.deepEqual(r2, { swept: 0, disabled: true });
  assert.equal(off.st.list().length, 1, "ttl_days=0 应完全不做 TTL 治理");
});

// ---- G6 L2 场景跨进程 ----
test("G6 SceneStore: 两进程各自归档, 后写的不再覆盖前者的场景", () => {
  const dir = tmp("l2");
  const s1 = new SceneStore(dir);
  const s2 = new SceneStore(dir); // 构造期磁盘还是空态
  s1.assign({ id: "f1", content: "A股 量化 交易 资金流向", created: Date.now() });
  s2.assign({ id: "f2", content: "周末 爬山 装备 清单", created: Date.now() });
  const reopened = new SceneStore(dir);
  assert.equal(reopened.count(), 2, `两个场景都应在盘上, 实际 ${reopened.count()}`);
  assert.ok(reopened.findMatch("量化 资金流向"), "s1 的场景没被 s2 的写盘抹掉");
  assert.ok(reopened.findMatch("爬山 装备"), "s2 的场景也在");
  assert.equal(reopened.listWithDesc().reduce((n, s) => n + s.facts, 0), 2, "两条事实各归各的场景");
});

test("G6 SceneStore: scenes.json 损坏时先留档再写, 旧内容可恢复", () => {
  const dir = tmp("l2bad");
  const memDir = path.join(dir, "memory", "l2");
  fs.mkdirSync(memDir, { recursive: true });
  const file = path.join(memDir, "scenes.json");
  const original = JSON.stringify([{ id: "s_old", name: "旧场景", keywords: ["旧"], facts: [] }]);
  fs.writeFileSync(file, original.slice(0, 20) + "{{{坏行", "utf8"); // 制造解析失败
  const st = new SceneStore(dir);
  st.create({ name: "新场景", description: "d", canHelp: "c" });
  const backups = fs.readdirSync(memDir).filter((f) => f.startsWith("scenes.json.corrupt-"));
  assert.equal(backups.length, 1, "覆盖前应把损坏文件改名留档");
  assert.equal(fs.readFileSync(path.join(memDir, backups[0]), "utf8"), original.slice(0, 20) + "{{{坏行");
});

// ---- G7 longterm 不双写 ----
test("G7 MemoryTicker: 滚动归档过的内容, 跨天 _compileDaily 不再追加第二遍", () => {
  const dir = tmp("lt");
  const facts = new FactStore(dir);
  const sess = new SessionStore(dir);
  const ticker = new MemoryTicker(dir, facts, null, sess);
  for (let i = 0; i < 3; i++) sess.append("default", "user/message", { content: `第${i}轮对话内容` });
  const day = logicalDay();
  ticker.state.day = day;
  ticker.state.lastRolledDay = day;
  ticker.state.lastRolledSeq = 0;
  ticker._compileDaily_Rolling();
  const rolled = fs.readFileSync(ticker.longtermMd, "utf8");
  assert.equal((rolled.match(/第0轮对话内容/g) || []).length, 1, "滚动写了一次");

  ticker._compileDaily(); // 旧实现: 无视游标, 把全天原文再追加一遍
  const after = fs.readFileSync(ticker.longtermMd, "utf8");
  assert.equal((after.match(/第0轮对话内容/g) || []).length, 1, "游标已覆盖的事件不应重复落 longterm");
  // 滚动之后新增的事件, 跨天归档时必须补上
  sess.append("default", "user/message", { content: "第3轮新增" });
  ticker._compileDaily();
  const filled = fs.readFileSync(ticker.longtermMd, "utf8");
  assert.ok(filled.includes("第3轮新增"), "游标之后的新对话要补齐");
  assert.equal((filled.match(/第3轮新增/g) || []).length, 1);
});

test("G7 MemoryTicker: rollup 压缩推进游标, 滚动不再重复追加已压缩的原文", async () => {
  const dir = tmp("ltroll");
  const facts = new FactStore(dir);
  const sess = new SessionStore(dir);
  const ticker = new MemoryTicker(dir, facts, async (raw) => `摘要(${raw.length}字节)`, sess);
  for (let i = 0; i < 60; i++) sess.append("default", "user/message", { content: `对话${i} 内容` });
  ticker._lastCompactAt = 0;
  await ticker._compactIfNeeded();
  const afterCompact = fs.readFileSync(ticker.longtermMd, "utf8");
  assert.ok(/(rollup)/.test(afterCompact), "应有 rollup 段");
  assert.ok(afterCompact.includes("摘要("), "rollup 摘要已写入");
  ticker._compileDaily_Rolling(); // 不得把 rollup 已承载的最旧区间再补一遍原文
  const afterRoll = fs.readFileSync(ticker.longtermMd, "utf8");
  assert.equal((afterRoll.match(/对话0 内容/g) || []).length, 0, "已被 rollup 承载的最旧对话不该再补原文");
  assert.ok(afterRoll.includes("对话59 内容"), "近期未被压缩的事件仍应滚动归档");
});

// ---- G8 会话 seq 跨进程 ----
test("G8 SessionStore: 两进程写同一会话, seq 不重复", () => {
  const dir = tmp("seq");
  const a = new SessionStore(dir);
  const b = new SessionStore(dir); // 构造时盘上还没有事件
  const ea = a.append("s1", "user/message", { content: "A" });
  const eb = b.append("s1", "assistant/message", { content: "B" });
  const ec = a.append("s1", "user/message", { content: "C" });
  assert.equal(ea.seq, 1);
  assert.equal(eb.seq, 2, "b 的内存计数器落后于磁盘, 必须重读校正 (旧实现写出重复的 seq=1)");
  assert.equal(ec.seq, 3);
  const seen = new Set([ea.seq, eb.seq, ec.seq]);
  assert.equal(seen.size, 3, "seq 唯一是下游游标消费的前提");
  const reloaded = new SessionStore(dir);
  assert.equal(reloaded.replay("s1").length, 3, "三行都在盘上且没被交错写坏");
});

// ---- G8b/G8c 真·两子进程并发竞态: append 的锁外乐观预读会撞号, 锁内重排才兜得住 ----
// 子进程脚本: 构造好 store 后写 ready 标记, 自旋等父进程 go 文件再齐步开写,
// 最大化 seq 分配窗口重叠。PPX_SEQ_LEGACY=1 时把 _ensureUniqueSeq 换成空操作,
// 回到 2026-10-05 之前的行为 (仅 append 前乐观预读), 用于验证本组测试确实抓得住旧 bug。
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const RACE_N = 20;

function raceChildScript() {
  const sessUrl = pathToFileURL(path.join(ROOT, "src", "memory", "session.js")).href;
  return [
    `import fs from "node:fs";`,
    `const { SessionStore } = await import(${JSON.stringify(sessUrl)});`,
    `if (process.env.PPX_SEQ_LEGACY === "1") SessionStore.prototype._ensureUniqueSeq = () => {};`,
    `const s = new SessionStore(process.env.PPX_RACE_DIR);`,
    `fs.writeFileSync(process.env.PPX_RACE_READY, String(process.pid));`,
    `while (!fs.existsSync(process.env.PPX_RACE_GO)) await new Promise((r) => setTimeout(r, 5));`,
    `for (let i = 0; i < Number(process.env.PPX_RACE_N); i++)`,
    `  s.append(process.env.PPX_RACE_KEY, "user/message", { content: "p" + process.pid + "-" + i });`,
  ].join("\n");
}

async function raceTwoProcesses(key) {
  const dir = tmp("seqrace");
  const go = path.join(dir, "go");
  const marks = [path.join(dir, "ready-a"), path.join(dir, "ready-b")];
  const code = raceChildScript();
  const kids = marks.map((mark) => spawn(process.execPath, ["--input-type=module", "-e", code], {
    env: {
      ...process.env, PPX_RACE_DIR: dir, PPX_RACE_KEY: key,
      PPX_RACE_READY: mark, PPX_RACE_GO: go, PPX_RACE_N: String(RACE_N),
    },
    stdio: ["ignore", "ignore", "pipe"],
  }));
  try {
    let stderr = "";
    for (const k of kids) k.stderr.on("data", (d) => { stderr += d; });
    const started = Date.now();
    while (!marks.every((m) => { try { return fs.readFileSync(m, "utf8").trim(); } catch { return false; } })) {
      if (Date.now() - started > 20000) throw new Error(`子进程 20s 未就绪: ${stderr}`);
      await new Promise((r) => setTimeout(r, 20));
    }
    fs.writeFileSync(go, "go");
    const codes = await Promise.all(kids.map((k) => new Promise((res, rej) => {
      k.on("exit", res); k.on("error", rej);
    })));
    assert.deepEqual(codes, [0, 0], `子进程应正常退出, stderr: ${stderr}`);
    const file = key === "default"
      ? path.join(dir, "sessions", `default-${logicalDay()}.jsonl`)
      : path.join(dir, "sessions", `${key}.jsonl`);
    const lines = fs.readFileSync(file, "utf8").split("\n").filter(Boolean);
    assert.equal(lines.length, RACE_N * 2, "行数不丢 (append-vs-write 判定未被改坏)");
    const seqs = lines.map((l) => JSON.parse(l).seq);
    assert.equal(new Set(seqs).size, RACE_N * 2,
      `seq 零重复, 实到: ${[...seqs].sort((a, b) => a - b).join(",")}`);
    assert.deepEqual([...seqs].sort((a, b) => a - b),
      Array.from({ length: RACE_N * 2 }, (_, i) => i + 1), "seq 是 1..40 连续无空洞");
    const reopened = new SessionStore(dir);
    const evs = reopened.replay(key);
    assert.equal(evs.length, RACE_N * 2);
    for (let i = 1; i < evs.length; i++) {
      assert.ok(evs[i].seq > evs[i - 1].seq, `replay 按 seq 升序返回 (第${i}条 ${evs[i - 1].seq} -> ${evs[i].seq})`);
    }
    assert.equal(new Set(evs.map((e) => e.data.content)).size, RACE_N * 2, "两进程的事件全在且各不重复");
  } finally {
    for (const k of kids) k.kill();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test("G8b SessionStore: 两子进程并发写同一非 default 会话 key, seq 零重复", { timeout: 60000 },
  () => raceTwoProcesses("race"));

test("G8c SessionStore: 两子进程并发写 default (日分片), seq 零重复", { timeout: 60000 },
  () => raceTwoProcesses("default"));

// ---- G9 审计链跨进程 ----
test("G9 AuditLog: 两进程交替追加, 哈希链仍完整", () => {
  const dir = tmp("audit");
  const x = new AuditLog(dir);
  const y = new AuditLog(dir); // 各自构造时 _seq=0
  x.append({ tool: "read_file", ok: true });
  y.append({ tool: "write_file", ok: true });
  x.append({ tool: "run_command", ok: false, error: "e" });
  y.append({ tool: "delete_file", ok: true });
  const v = x.verify();
  assert.ok(v.ok, `链应完整: ${v.detail}`);
  assert.equal(v.total, 4);
  const seqs = x.tail(10).map((e) => e.seq).sort((p, q) => p - q);
  assert.deepEqual(seqs, [1, 2, 3, 4], "seq 不重复 (旧实现两进程各写 seq=1/2)");
});

// ---- G10 安全钩子 fail-closed ----
test("G10 钩子: 安全钩子异常/超时按拒绝, 普通钩子仍放行", async () => {
  const reg = createHookRegistry();
  reg.on("PreToolUse", () => { throw new Error("普通业务钩子崩了"); });
  let r = await reg.emit("PreToolUse", { tool: "read_file" });
  assert.equal(r.blocked, false, "普通钩子故障不该阻断工具");
  assert.ok(r.results[0].error.includes("普通业务钩子"));

  const reg2 = createHookRegistry();
  reg2.onSecurity(() => { throw new Error("守卫崩了"); });
  const r2 = await reg2.emit("PreToolUse", { tool: "run_command" });
  assert.ok(r2.blocked, "fail-closed: 安全钩子故障即拒绝");
  assert.ok(/fail-closed/.test(r2.reason) && /守卫崩了/.test(r2.reason));

  const reg3 = createHookRegistry();
  reg3.onSecurity(() => new Promise(() => {}), { timeoutMs: 20 });
  const r3 = await reg3.emit("PreToolUse", { tool: "run_command" });
  assert.ok(r3.blocked, "超时同样 fail-closed");
  assert.ok(/超时/.test(r3.reason));

  // 非 PreToolUse 事件没有否决语义, failClosed 不该制造假阻断
  const reg4 = createHookRegistry();
  reg4.on("SessionStart", () => { throw new Error("x"); }, { failClosed: true });
  const r4 = await reg4.emit("SessionStart", {});
  assert.equal(r4.blocked, false);
});

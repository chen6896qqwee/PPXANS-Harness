// scripts/probe-r12-turn-real.js - 第十二轮真模型探测: Turn 状态机 + SQ/EQ 接线 E2E
// 用法: node scripts/probe-r12-turn-real.js   (需要真实 GLM/方舟配置, R11 同款)
// 场景:
//   P6-1 chat 通道: 一轮对话 → EQ 收 TURN_STARTED/TURN_CLOSED, SQ 收口清空, 投影 closed
//   P6-2 chatStream 通道: 流式一轮 → 事件 seq 连续递增, 增量非空, 投影 closed
//   P6-3 用户中断: 流式中途 interrupt → TURN_ABORTED, 投影 aborted (不再是"假装中止")
//   P6-4 真 WAL 续读: 对 agent 实际写出的 WAL 文件新建 EQ, seq 不撞号
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PPXAgent } from "../src/agent/index.js";
import { createEventQueue } from "../src/protocol/index.js";

// win32 注意: URL.pathname 是 "/C:/..." 形态, 直接 path.resolve 会得到 "C:\C:\..."
// (root 读不到 config/ppx.json → 无模型 + 本地服务长探测假死)。必须走 fileURLToPath。
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ppx-r12-real-"));

const agent = new PPXAgent({
  root: ROOT,
  dataDir: path.join(tmp, "main"),
  globalDataDir: path.join(tmp, "global"),
});

const results = [];
function check(name, ok, detail = "") {
  results.push({ name, ok });
  console.log(`${ok ? "✔" : "✖"} ${name}${detail ? `  (${detail})` : ""}`);
}

const SK = "r12-real";
const eqEvents = [];
agent.protocolBus?.eq?.subscribe?.((ev) => eqEvents.push(ev));

const t0 = Date.now();

// ---- P6-1: chat 通道真模型一轮 ----
{
  const before = eqEvents.length;
  const reply = await agent.chat("用一句话介绍你自己, 不要用任何工具。", { sessionKey: SK });
  const evs = eqEvents.slice(before).map((e) => e.type);
  check("P6-1 chat: 真模型回复非空", String(reply || "").trim().length > 0, `${String(reply).slice(0, 40)}...`);
  check("P6-1 chat: EQ 收到 TURN_STARTED", evs.includes("turn_started"), evs.join(","));
  check("P6-1 chat: EQ 收到 TURN_CLOSED", evs.includes("turn_closed"));
  check("P6-1 chat: SQ 收口清空", (agent.protocolBus?.sq?.size?.() ?? -1) === 0);
  const st = agent.turnProjection.status(SK);
  check("P6-1 chat: 投影 1 轮 closed", st?.turnCount === 1 && st?.turns?.[0]?.status === "closed");
}

// ---- P6-2: chatStream 通道真模型流式一轮 ----
{
  const before = eqEvents.length;
  let deltas = 0;
  const reply = await agent.chatStream("只回答一个数字: 9 乘以 8 等于几?", {
    sessionKey: SK,
    onDelta: () => { deltas += 1; },
  });
  const evs = eqEvents.slice(before).map((e) => e.type);
  const seqs = eqEvents.slice(before).map((e) => e.seq);
  check("P6-2 stream: 真模型流式回复非空", String(reply || "").includes("72"), `${deltas} 增量, 回复: ${String(reply).slice(0, 30)}`);
  check("P6-2 stream: EQ TURN_STARTED + TURN_CLOSED", evs.includes("turn_started") && evs.includes("turn_closed"), evs.join(","));
  check("P6-2 stream: 事件 seq 无重复", new Set(seqs).size === seqs.length, seqs.join(","));
  const st = agent.turnProjection.status(SK);
  check("P6-2 stream: 投影 2 轮全 closed", st?.turnCount === 2 && st?.turns?.every?.((t) => t.status === "closed"));
}

// ---- P6-3: 用户中断 → TURN_ABORTED (真语义, 非"假装中止") ----
{
  const before = eqEvents.length;
  // 流句柄注册 (_streamAborts.set) 一出现就叫停 —— 不依赖 onDelta 时序:
  // 该 provider 链路可能走非流式兜底 (增量在结束时一次补发), 等增量再中断就晚了。
  const t3 = Date.now();
  const diag = { sawHandle: false };
  const poll = setInterval(() => {
    if (agent._streamAborts?.has?.(SK)) {
      if (!diag.sawHandle) console.log(`  [diag] 流句柄已注册, 发起中断 (t+${Date.now() - t3}ms)`);
      diag.sawHandle = true;
      agent.interrupt(SK);
    }
  }, 50);
  const stream = agent.chatStream("写一篇 3000 字的散文, 主题不限, 尽量长。", { sessionKey: SK });
  const reply3 = await stream.catch((e) => `<error: ${e?.name}: ${e?.message}>`);
  clearInterval(poll);
  console.log(`  [diag] 中断后回复 (${Math.round(reply3.length)} 字, 耗时 ${Date.now() - t3}ms): ${String(reply3).slice(0, 80)}...  interrupted=${agent._interrupted}`);
  const evs = eqEvents.slice(before).map((e) => e.type);
  check("P6-3 abort: EQ 收到 TURN_ABORTED", evs.includes("turn_aborted"), evs.join(","));
  const st = agent.turnProjection.status(SK);
  check("P6-3 abort: 投影记录 aborted", st?.turns?.some?.((t) => t.status === "aborted") || st?.taskStatus === "aborted");
}

// ---- P6-4: 对 agent 真实写出的 WAL 新建 EQ, seq 从尾部续读 ----
{
  const walPath = path.join(tmp, "main", "protocol", "eq.wal.jsonl");
  check("P6-4 wal: WAL 文件真实存在", fs.existsSync(walPath), walPath);
  const eq2 = createEventQueue({ walPath });
  const ev = eq2.push({ type: "probe_r12", payload: {} });
  const replayed = eq2.replay();
  const seqs = replayed.map((e) => e.seq);
  check("P6-4 wal: 重启后 seq 续读不撞号", new Set(seqs).size === seqs.length && ev.seq > 1, `新事件 seq=${ev.seq}, WAL 共 ${seqs.length} 条`);
}

const dt = Math.round((Date.now() - t0) / 100) / 10;
const failed = results.filter((r) => !r.ok);
console.log(`\n===== R12 真模型探测: ${results.length - failed.length}/${results.length} 通过, 耗时 ${dt}s =====`);
try { agent.shutdown(); } catch {}
process.exit(failed.length ? 1 : 0);

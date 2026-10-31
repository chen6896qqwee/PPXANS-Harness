// src/channels/delivery.js — 渠道投递队列 (2026-10-31, 队列⑦)
// 此前 ChannelManager.broadcast 是 fire-and-forget: 逐通道 try/catch, 失败只 console.warn ——
// 飞书/企业微信 API 限流一次、网络抖一下, 主动提醒就永远丢了 (连"丢了"都不可见)。
// 这里补上队列: 失败重试 (指数退避) + 过期丢弃 (提醒过时无价值) + 容量上限 + JSONL WAL
// (重启后未投递的续投, 投递完成的打 done 标记不再重发 —— 与 protocol EQ 同款形态)。
//
// 排队模型: nextAttemptAt 定时调度 + 按通道分组执行 (组内串行保序 / 组间并行无队头阻塞)。
// 失败重试只推迟该条消息; 某通道 send 挂起不阻塞其它通道的重试周期。
// 入站回复不走队列 (base.handleMessage 直发 —— 用户在等), 只有主动投递 (broadcast) 入队。
//
// WAL 折叠语义: 每次入队/重排追加一行完整 job, 终态 (sent/failed/dropped) 追加一行
// {kind:"done"} 标记; 启动 replay 时按 id 折叠取最新, 未完成且未过 TTL 的重新入队,
// 并把 WAL 重写为仅存活的 pending (启动时压缩, 防止无限增长)。

import fs from "node:fs";
import path from "node:path";

const DEFAULTS = {
  retryMax: 3,        // 首次尝试后的最大重试次数 (总尝试 = 1 + retryMax)
  backoffMs: 2000,    // 首次重试前等待; 之后指数 ×2 (2s → 4s → 8s, 上限 60s)
  backoffCapMs: 60000,
  ttlMs: 60 * 60 * 1000, // 入队超 1h 未投出 → 丢弃 (提醒过期即噪音)
  maxQueue: 200,      // 积压上限, 超限丢最旧 (提醒类消息宁可丢旧不可挤爆)
};

export function createDeliveryQueue({
  send,                 // async (channelName, to, text, meta) => any —— 通道解析与发送由调用方注入
  retryMax = DEFAULTS.retryMax,
  backoffMs = DEFAULTS.backoffMs,
  backoffCapMs = DEFAULTS.backoffCapMs,
  ttlMs = DEFAULTS.ttlMs,
  maxQueue = DEFAULTS.maxQueue,
  walPath = null,
  now = () => Date.now(),
  warn = (m) => console.warn(`[delivery] ${m}`),
} = {}) {
  if (typeof send !== "function") throw new Error("delivery queue 需要 send(channelName, to, text[, meta])");
  const jobs = new Map(); // id -> job { id, channel, to, text, enqueuedAt, attempts, nextAttemptAt }
  const stats = { enqueued: 0, sent: 0, failed: 0, dropped: 0, retried: 0, replayed: 0 };
  const lastErrors = [];  // 最近 10 条终态失败 (可观测: 丢了什么、为什么)
  let seq = 0;
  let timer = null;
  let stopped = false;
  const draining = new Set(); // send 在途的通道 (组间并行, 组内串行)

  // ---- WAL (JSONL): job 行折叠取最新, done 行标记终态 ----
  const walAppend = (obj) => {
    if (!walPath) return;
    try {
      fs.mkdirSync(path.dirname(walPath), { recursive: true });
      fs.appendFileSync(walPath, JSON.stringify(obj) + "\n", "utf8");
    } catch (e) {
      warn(`WAL 写入失败 (投递继续, 仅丢续投能力): ${e.message}`);
    }
  };
  const walDone = (id, status) => walAppend({ kind: "done", id, status, at: now() });

  // 启动 replay: 折叠出未完成的 job, 过 TTL 的丢弃, 其余重新入队; WAL 重写为仅存活 pending
  function replay() {
    if (!walPath || !fs.existsSync(walPath)) return 0;
    let lines = [];
    try {
      lines = fs.readFileSync(walPath, "utf8").split("\n").filter(Boolean);
    } catch {
      return 0;
    }
    const latest = new Map();  // id -> job
    const done = new Set();
    for (const line of lines) {
      let j = null;
      try { j = JSON.parse(line); } catch { continue; } // 坏行跳过 (崩溃尾部半行)
      if (!j || typeof j !== "object") continue;
      if (j.kind === "done" && j.id != null) done.add(String(j.id));
      else if (j.kind === "job" && j.job && j.job.id != null) latest.set(String(j.job.id), j.job);
    }
    const t = now();
    const live = [];
    for (const [id, job] of latest) {
      if (done.has(id)) continue;
      if (t - Number(job.enqueuedAt || 0) > ttlMs) { stats.dropped++; continue; } // 上辈子没送出去且已过期
      live.push({ ...job, id: String(id), nextAttemptAt: t });
      jobs.set(String(id), { ...job, id: String(id), nextAttemptAt: t });
      stats.replayed++;
    }
    // 压缩: WAL 重写为仅存活 pending (done/过期/坏行清掉), 防止跨重启无限增长
    try {
      fs.mkdirSync(path.dirname(walPath), { recursive: true });
      fs.writeFileSync(walPath, live.map((j) => JSON.stringify({ kind: "job", job: j })).join("\n") + (live.length ? "\n" : ""), "utf8");
    } catch { /* 压缩失败不影响内存态 */ }
    return live.length;
  }

  function enqueue({ channel, to = "*", text, meta = null }) {
    if (stopped) return { queued: false, reason: "队列已停止" };
    const t = now();
    const id = `dv-${t.toString(36)}-${(++seq).toString(36)}`;
    const job = { id, channel: String(channel || ""), to: String(to ?? "*"), text: String(text ?? ""), enqueuedAt: t, attempts: 0, nextAttemptAt: t, meta };
    // 容量上限: 丢最旧 (提醒宁可丢旧不可挤爆); 需 O(n) 找最旧 —— 队列小 (默认 200), 可接受
    if (jobs.size >= maxQueue) {
      let oldestId = null;
      let oldestAt = Infinity;
      for (const [jid, j] of jobs) {
        if (j.nextAttemptAt < oldestAt) { oldestAt = j.nextAttemptAt; oldestId = jid; }
      }
      if (oldestId != null) {
        jobs.delete(oldestId);
        stats.dropped++;
        walDone(oldestId, "dropped:overflow");
        warn(`队列满 (>${maxQueue}), 丢弃最旧: ${oldestId}`);
      }
    }
    jobs.set(id, job);
    stats.enqueued++;
    walAppend({ kind: "job", job });
    schedule();
    return { queued: true, id };
  }

  function backoffFor(attempts) {
    return Math.min(backoffMs * Math.pow(2, Math.max(0, attempts - 1)), backoffCapMs);
  }

  function drain() {
    if (stopped) return;
    const t = now();
    // 到期的按入队顺序处理。**按通道分组: 组内串行 (同通道消息有序, 不并发重发), 组间并行**
    // —— 某通道 send 挂起/慢不阻塞其它通道: in-flight 状态按通道记 (draining), 重试周期照常推进
    // (队头阻塞只存在于同通道内部, 那是有序性的代价)。
    const ready = [...jobs.values()]
      .filter((j) => j.nextAttemptAt <= t && !draining.has(j.channel))
      .sort((a, b) => a.enqueuedAt - b.enqueuedAt || a.id.localeCompare(b.id));
    if (!ready.length) {
      // 2026-10-31 修复丢失唤醒: 此处此前直接 return, 有个窗口 —— 若"一条重试即将到期"
      //   与"另一通道 send 在途"并存, 本轮回调的 finally 已跑过 (timer 已清), 在途通道的
      //   finally 又要到 send 返回才会跑, 到期的那条将永远无人唤醒 (实测:
      //   channel-delivery 的 WAL 测试偶发 waitUntil 超时 —— 全量直跑 5 连绿, 门禁内偶发 1 红)。
      //   现按"未被在途通道占用的最早到期时间"补一个唤醒定时器; 已到期但被 draining
      //   挡住的条目由其 processGroup.finally 的 schedule() 兜底, 不在此空转。
      let earliest = Infinity;
      for (const j of jobs.values()) {
        if (draining.has(j.channel)) continue; // 在途通道醒来时自己会 schedule
        earliest = Math.min(earliest, j.nextAttemptAt);
      }
      if (earliest > t) schedule();
      return;
    }
    const groups = new Map();
    for (const j of ready) {
      if (!groups.has(j.channel)) groups.set(j.channel, []);
      groups.get(j.channel).push(j);
    }
    for (const [ch, group] of groups) {
      draining.add(ch);
      processGroup(group, t).finally(() => {
        draining.delete(ch);
        schedule(); // 该通道空出, 唤醒下一轮 (其 pending 重试或其它到期消息)
      });
    }
  }

  async function processGroup(group, t) {
    for (const job of group) {
      if (stopped) return;
      // TTL: 入队太久没送出去 → 丢弃 (重试期间也要检查 —— 长退避可能直接跨过 TTL)
      if (t - job.enqueuedAt > ttlMs) {
        jobs.delete(job.id);
        stats.dropped++;
        walDone(job.id, "dropped:ttl");
        warn(`投递超时未送出 (>${Math.round(ttlMs / 1000)}s), 丢弃: ${job.id} → ${job.channel}`);
        continue;
      }
      try {
        await send(job.channel, job.to, job.text, job.meta ?? null); // 2026-10-31 (一期): 回投元数据随 job 透传 (WAL 持久, 重启续投不丢)
        jobs.delete(job.id);
        stats.sent++;
        walDone(job.id, "sent");
      } catch (e) {
        job.attempts++;
        if (job.attempts > retryMax) {
          jobs.delete(job.id);
          stats.failed++;
          const reason = String(e && e.message ? e.message : e).slice(0, 200);
          lastErrors.push({ id: job.id, channel: job.channel, to: job.to, reason, at: now() });
          if (lastErrors.length > 10) lastErrors.shift();
          walDone(job.id, `failed:${reason}`);
          warn(`投递最终失败 (${job.attempts} 次尝试): ${job.channel} ← ${reason}`);
        } else {
          stats.retried++;
          job.nextAttemptAt = now() + backoffFor(job.attempts);
          walAppend({ kind: "job", job }); // 折叠语义: 重排后的 attempts/nextAttemptAt 持久化
        }
      }
    }
  }

  function schedule() {
    if (stopped || timer) return;
    let earliest = Infinity;
    for (const j of jobs.values()) earliest = Math.min(earliest, j.nextAttemptAt);
    if (earliest === Infinity) return; // 队列空, 等下一次 enqueue 唤醒
    const delay = Math.max(0, Math.min(earliest - now(), 2 ** 30));
    timer = setTimeout(() => {
      timer = null;
      drain();
    }, delay);
    // Node: 不让残留 timer 挂住进程退出
    if (typeof timer.unref === "function") timer.unref();
  }

  // 全部就绪 (无 pending 或都已投出/终态) 时 resolve —— 测试与优雅退出用
  function idle() {
    if (jobs.size === 0) return Promise.resolve();
    return new Promise((resolve) => {
      const check = () => {
        if (jobs.size === 0) return resolve();
        setTimeout(check, 10);
      };
      check();
    });
  }

  function shutdown() {
    stopped = true;
    if (timer) { clearTimeout(timer); timer = null; }
    // pending 留在 WAL, 下次启动 replay 续投 (内存态直接丢弃)
    return { abandoned: jobs.size };
  }

  function statsSnapshot() {
    return {
      ...stats,
      pending: jobs.size,
      wal: walPath ? "on" : "off",
      lastErrors: lastErrors.slice(),
      nextAttemptInMs: (() => {
        let earliest = Infinity;
        for (const j of jobs.values()) earliest = Math.min(earliest, j.nextAttemptAt);
        return earliest === Infinity ? null : Math.max(0, earliest - now());
      })(),
    };
  }

  const replayedCount = replay();
  if (replayedCount) warn(`replay: 从 WAL 恢复 ${replayedCount} 条未投递消息`);
  schedule();

  return { enqueue, idle, shutdown, stats: statsSnapshot, _jobs: jobs };
}

// src/protocol/index.js - SQ/EQ 双队列事件流 (对齐 OpenAI Codex SubmissionQueue/EventQueue)
// 通道层与内核解耦的唯一总线:
//   SubmissionQueue: 用户操作入队 (op = {id, type, payload}), 先提交先处理
//   EventQueue:       结构化事件出队 + 订阅回调 + WAL 回放 (JSONL)
import fs from "node:fs";
import path from "node:path";
import { readTailSeq } from "../utils/tail-read.js";
import { warn } from "../utils/logger.js";

// 操作类型 (用户侧动作, 进 SQ)
export const OpType = {
  USER_TURN: "user_turn",
  INTERRUPT: "interrupt",
  RESUME: "resume",
  APPROVE: "approve",
  DENY: "deny",
};

// 事件类型 (内核产出, 供 Web UI 时间线渲染, 进 EQ)
export const EventType = {
  TASK_STARTED: "task_started",
  TURN_STARTED: "turn_started",
  TURN_CLOSED: "turn_closed",
  TURN_ABORTED: "turn_aborted",
  AGENT_MESSAGE: "agent_message",
  TOOL_CALLED: "tool_called",
  TOOL_OUTPUT: "tool_output",
  // 2026-11-01 (三期① 订阅直通): 入站消息进事件流 —— 此前 Trigger 不进 EQ (观测盲区),
  //   thread 字段挂顶层, 话题订阅/长驻 worker 编排据此归组。
  MESSAGE_RECEIVED: "message_received",
  // 2026-11-07 (需求提炼双通道): 入站消息的任务简报元数据进 EQ —— 与 MESSAGE_RECEIVED
  //   的分工: 那是"消息到了", 这是"这条消息被提炼成了什么形状的任务" (isTask/置信/来源/
  //   缺信息计数)。正文与 goal 不入事件 (与 audit scrubArgs 正文折叠同口径)。
  TASK_EXTRACTED: "task_extracted",
  // 2026-11-02 (三期第二批 工单账本): 准入→指派→终态的完整生命周期事件。
  //   与 MESSAGE_RECEIVED 的分工: 后者是"消息到了", 这里是"消息被谁处理、处理到哪、
  //   结果如何" —— Web UI/watchdog/外部订阅按 ticketId 归组。
  TICKET_CREATED: "ticket_created",
  TICKET_ASSIGNED: "ticket_assigned",
  TICKET_WAITING: "ticket_waiting",
  TICKET_COMPLETED: "ticket_completed",
  TICKET_FAILED: "ticket_failed",
  TICKET_CANCELLED: "ticket_cancelled",
  TICKET_REQUEUED: "ticket_requeued",
  TICKET_INTERRUPTED: "ticket_interrupted",
  // 2026-11-04 (DSH 吸收 Step 3): 执行与投递的独立事实。
  //   assignment_* 只描述"这次执行", 不改变工单终态; delivery_* 只描述"结果送没送到",
  //   完成判断 = ticket_done + delivery_delivered (二者正交, 见 docs/dsh-absorb/02-STATE-MATRIX.md)。
  ASSIGNMENT_STARTED: "assignment_started",
  ASSIGNMENT_PROGRESS: "assignment_progress",
  ASSIGNMENT_ENDED: "assignment_ended",
  DELIVERY_ACCEPTED: "delivery_accepted",
  DELIVERY_DELIVERED: "delivery_delivered",
  DELIVERY_FAILED: "delivery_failed",
  DELIVERY_DEAD_LETTER: "delivery_dead_letter",
  // 2026-11-05 (Super-agent 调度事件化): Router 的归属判断/分派与 Worker 结构化汇报。
  //   ticket_* 描述"工单生命周期", 这三类描述"调度决策本身" —— 审计链据此回答
  //   "为什么派、派给谁、做到哪、结果如何", 不复制任务正文。
  ROUTER_DECISION: "router_decision",
  ROUTER_DISPATCH: "router_dispatch",
  WORKER_REPORT: "worker_report",
  APPROVAL_REQUESTED: "approval_requested",
  APPROVAL_RESOLVED: "approval_resolved",
  TASK_COMPLETE: "task_complete",
  TASK_ABORTED: "task_aborted",
  TURN_DIFF: "turn_diff",
  ERROR: "error",
  TOKEN_COUNT: "token_count",
  PLAN_UPDATED: "plan_updated",
  COMPACTED: "compacted",
};

// SubmissionQueue: 用户操作入队, 内部数组队列, 先提交先处理
// 2026-10-25 (SQ 真实化): 此前队列是"提交即消费"的装饰性结构 (评估报告 P1) ——
//   无时间戳、无队头语义、无腐烂清理。现在 op 带提交时刻, 并补三件真实能力:
//   atHead: FIFO 闸口语义 (谁先提交谁先被处理, 供调度/诊断判定)
//   pending: 快照 (不清空), 供 /health 可观测
//   sweep: TTL 清扫 —— 崩溃轮次遗留的 op 不再永久占队头 (防队列腐烂堵死后续判定)
export function createSubmissionQueue() {
  let _seq = 0;
  const queue = [];

  // 默认 id: t_<时间戳>_<自增序号> (对齐 codex Id::UnixMs 唯一性)
  function _newId() {
    _seq += 1;
    return `t_${Date.now()}_${_seq}`;
  }

  // 提交一个操作, 返回分配/给定的 id
  function submit(op = {}) {
    const id = op.id || _newId();
    queue.push({ id, type: op.type, payload: op.payload, submittedAt: op.submittedAt || Date.now() });
    return id;
  }

  // 取出最早一个未处理 op 并出队 (无则 null) — 对齐 codex nextIdle 语义
  function nextIdle() {
    return queue.length ? queue.shift() : null;
  }

  // 按 id 取走一个 op (多会话并发下各轮只消费自己的 op, 不抢别人的队头)。
  // 返回被取走的 op 或 null (已被消费/不存在)。
  function consume(id) {
    const i = queue.findIndex((op) => op.id === id);
    return i >= 0 ? queue.splice(i, 1)[0] : null;
  }

  // 当前未消费 op 数 (诊断/收口断言用)
  function size() {
    return queue.length;
  }

  // 取走全部 op 并清空队列
  function drain() {
    const out = queue.splice(0, queue.length);
    return out;
  }

  // 该 id 的 op 是否在队头 (空队/false = 不在)。FIFO 闸口语义的判定原语。
  function atHead(id) {
    return queue.length > 0 && queue[0].id === id;
  }

  // 按类型取走全部 op (不动其他类型 —— 多会话并发时各轮的 USER_TURN op 互不干扰)。
  // 返回被取走的 op 数组 (无则空数组)。供控制 op (如 INTERRUPT) 的生命周期收口。
  function consumeType(type) {
    const out = queue.filter((op) => op.type === type);
    if (out.length) {
      const rest = queue.filter((op) => op.type !== type);
      queue.splice(0, queue.length, ...rest);
    }
    return out;
  }

  // 队列快照 (不消费): [{id, type, payload, submittedAt, ageMs}]
  function pending() {
    const now = Date.now();
    return queue.map((op) => ({ ...op, ageMs: now - (op.submittedAt || now) }));
  }

  // TTL 清扫: 提交超过 ttlMs 仍未被消费的 op 视为"死轮遗留"(崩溃/断连轮次的残留),
  // 移出队列并原样返回 (调用方负责留痕)。不扫 INTERRUPT (控制 op 生命周期跟随轮次,
  // 由轮收口统一消费); 不设默认 TTL —— 由调用方显式传 (语义上这是策略不是机制)。
  function sweep(ttlMs, { keepTypes = ["interrupt"] } = {}) {
    if (!(ttlMs > 0)) return [];
    const now = Date.now();
    const stale = [];
    const rest = [];
    for (const op of queue) {
      const age = now - (op.submittedAt || now);
      if (age > ttlMs && !keepTypes.includes(op.type)) stale.push(op);
      else rest.push(op);
    }
    if (stale.length) queue.splice(0, queue.length, ...rest);
    return stale;
  }

  return { submit, nextIdle, consume, size, drain, atHead, consumeType, pending, sweep };
}

// EventQueue: 结构化事件出队 + 订阅回调 + WAL 回放
// 2026-11-02 (桌面长运行): 内存历史原先只增不减, 每个 tool_output 都留一份 payload,
//   按天连续运行的桌面进程会线性吃内存。现在只保留最近 maxEvents 条; 更早的按需从
//   WAL 回补 (subscribe since 落在窗口之外时), 长期运行内存有界, 断线续播语义不变。
//
// 2026-11-02 (WAL 分段/归档): 单文件 append 在长运行下会无限增长 —— 启动续读要整文件
//   扫尾、replay 要整文件装载, 一次崩溃/重启的成本随运行时长线性上升。现在按字节阈值
//   轮转: 活跃文件仍是 walPath (eq.wal.jsonl), 满阈值后原样改名为同目录的分段
//   eq.wal.<YYYYMMDD-HHmmss>-<pid>-<n>.jsonl, 新事件写回空的活跃文件。
//   · seq 连续性: 分段只换文件, 不重置 _seq; 重启时按 活跃文件 → 最新分段 → ... 顺序
//     读尾部 8KB 恢复水位, 绝不撞号。
//   · 回放: 分段按文件名时间序拼接; subscribe(since) 从新到旧读, 读够 limit 即停,
//     旧历史不再整库装载。
//   · 保留: walKeepSegments 限制归档分段数 (0=不限), 只删最旧的**已归档**分段,
//     绝不动活跃文件; WAL 是可观测/回放日志, 会话真源仍由 SessionStore 持有。
const DEFAULT_WAL_MAX_BYTES = 8 * 1024 * 1024;
const DEFAULT_WAL_KEEP = 24;

function _walIntEnv(name) {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v >= 0 ? Math.trunc(v) : null;
}

export function createEventQueue({
  walPath = null,
  maxEvents = 5000,
  walMaxBytes = null,
  walKeepSegments = null,
} = {}) {
  const cap = Number.isFinite(Number(maxEvents)) && Number(maxEvents) > 0 ? Math.trunc(Number(maxEvents)) : 5000;
  const events = [];   // 内存历史 (最多 cap 条)
  const subs = [];     // 订阅回调

  // 0 = 关闭轮转 (测试/短生命周期进程可用); 缺省读环境变量, 再退回 8MB
  const envMax = _walIntEnv("PPX_EQ_WAL_MAX_BYTES");
  const maxBytes = walMaxBytes !== null && walMaxBytes !== undefined && Number.isFinite(Number(walMaxBytes)) && Number(walMaxBytes) >= 0
    ? Math.trunc(Number(walMaxBytes))
    : (envMax !== null ? envMax : DEFAULT_WAL_MAX_BYTES);
  const envKeep = _walIntEnv("PPX_EQ_WAL_KEEP");
  const keepSegments = walKeepSegments !== null && walKeepSegments !== undefined && Number.isFinite(Number(walKeepSegments)) && Number(walKeepSegments) >= 0
    ? Math.trunc(Number(walKeepSegments))
    : (envKeep !== null ? envKeep : DEFAULT_WAL_KEEP);

  // WAL 目录不存在先建 (递归)
  if (walPath) {
    const dir = path.dirname(walPath);
    if (dir && !fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  }

  // ---- 分段命名与枚举 (活跃文件之外的历史分段) ----
  // eq.wal.jsonl -> eq.wal.<stamp>-<pid>-<n>.jsonl; 文件名时间序即逻辑序。
  const walDir = walPath ? path.dirname(walPath) : null;
  const walBase = walPath ? path.basename(walPath).replace(/\.jsonl$/i, "") : null;
  let _rotateSeq = 0;

  function _segmentFiles() {
    if (!walPath) return [];
    try {
      const prefix = walBase + ".";
      return fs.readdirSync(walDir)
        .filter((f) => f.startsWith(prefix) && f.endsWith(".jsonl") && f !== path.basename(walPath))
        .sort()
        .map((f) => path.join(walDir, f));
    } catch { return []; }
  }

  function _stamp() {
    const d = new Date();
    const p = (n, w = 2) => String(n).padStart(w, "0");
    return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
  }

  // 尾部读 seq (只读 8KB): 末行可能是别处刚写了一半, 逐行回退到可解析行为止。
  // (2026-11-03 收口: 取尾 + seq 回退语义都在 utils/tail-read.js, 与 session._tailMaxSeq 同源)
  function _tailSeq(file) {
    return readTailSeq(file, 8192);
  }

  // 按时间序读一个文件的事件 (损坏行跳过), 供回放/诊断
  function _readFile(file) {
    try {
      const out = [];
      for (const line of fs.readFileSync(file, "utf8").split("\n")) {
        if (!line.trim()) continue;
        try { out.push(JSON.parse(line)); } catch { /* 跳过损坏行 */ }
      }
      return out;
    } catch { return []; }
  }

  // seq 从 WAL 续读: 活跃文件优先, 为空/损坏则退到最新分段, 依次向前 ——
  // 避免进程重启后从 0 起编, 与历史事件撞号 (消费方会看到 1,2,1 这种重复序列)。
  let _seq = 0;
  if (walPath) {
    const chain = [walPath, ..._segmentFiles().reverse()];
    for (const f of chain) {
      const s = _tailSeq(f);
      if (s > 0) { _seq = s; break; }
    }
  }

  // 当前活跃文件字节数 (轮转判定用); 启动时取一次, 之后按写入增量维护。
  let _walBytes = 0;
  try { _walBytes = walPath ? fs.statSync(walPath).size : 0; } catch { _walBytes = 0; }
  let _rotations = 0;
  let _pruned = 0;

  // 满阈值轮转: 活跃文件改名归档, 下次 append 自动重建。改名失败时保持原文件继续追加
  // (宁可单文件变大, 也不丢事件)。
  function _rotateIfNeeded() {
    if (!walPath || maxBytes <= 0 || _walBytes < maxBytes) return false;
    try {
      if (!fs.existsSync(walPath)) { _walBytes = 0; return false; }
      _rotateSeq += 1;
      const seg = path.join(walDir, `${walBase}.${_stamp()}-${process.pid}-${_rotateSeq}.jsonl`);
      fs.renameSync(walPath, seg);
      _walBytes = 0;
      _rotations += 1;
      _pruneSegments();
      return true;
    } catch {
      return false; // 归档失败: 继续写原文件, 下轮再试
    }
  }

  // 只裁剪**已归档**的旧分段; 活跃文件永不删除。keepSegments=0 表示不裁剪。
  function _pruneSegments() {
    if (keepSegments <= 0) return;
    const segs = _segmentFiles();
    const extra = segs.length - keepSegments;
    for (let i = 0; i < extra; i++) {
      try { fs.unlinkSync(segs[i]); _pruned += 1; } catch { /* 被占用/已删: 跳过 */ }
    }
  }

  // 推送一个事件: ev = {id?, ts?, type, payload, ...ref}; seq 自增
  // 2026-11-01 (v4.1 平台化 事件引用): 事件对象除 payload 外可携带顶层引用字段
  //   (turnId / sessionKey / opId / cause / thread / ref) —— 订阅方据此做因果链与
  //   话题归组 (dsh sourceEventSeqs / AgentCancelCause 同语义的最小版), WAL 原样落盘。
  const REF_KEYS = ["turnId", "sessionKey", "opId", "cause", "thread", "ref", "ticketId", "assignmentId"];
  function push(ev) {
    _seq += 1;
    const full = {
      id: ev.id || `e_${Date.now()}_${_seq}`,
      ts: ev.ts || Date.now(),
      seq: _seq,
      schema_version: 1, // 事件信封契约版本 (docs/dsh-absorb/00-EVENTS.md §2)
      type: ev.type,
      payload: ev.payload,
    };
    for (const k of REF_KEYS) {
      if (ev[k] !== undefined && ev[k] !== null) full[k] = ev[k];
    }
    events.push(full);
    // 内存窗口裁剪: 只淘汰已落 WAL 的最旧事件, 不改变 seq 水位
    if (events.length > cap) events.splice(0, events.length - cap);
    // 同步落 WAL (JSONL, 一行一 JSON); 写完再判轮转 —— 事件先落在活跃文件里,
    // 归档失败也只是文件继续变大, 不会出现"事件写到一半换文件"的缺口。
    if (walPath) {
      const line = JSON.stringify(full) + "\n";
      fs.appendFileSync(walPath, line, "utf8");
      _walBytes += Buffer.byteLength(line);
      _rotateIfNeeded();
    }
    // 同步通知订阅回调 (单个回调异常不影响事件流)
    for (const fn of subs) {
      try { fn(full); } catch { /* 订阅回调不应中断事件流 */ }
    }
    return full;
  }

  // 订阅: 返回取消订阅函数。
  // 2026-11-01 (二期①): 可选 { since, types, thread, limit } ——
  //   since  = 只推 seq 更大的事件 (注册时先同步回放内存历史中 seq > since 的匹配事件,
  //            再挂实时回调, 不丢中间事件; limit 限制回放条数防大历史冲爆消费方, 默认 500);
  //   types  = 类型白名单数组 (其余类型静默跳过);
  //   thread = 话题归组键过滤 (事件顶层 thread 字段, 订阅直通的程序过滤原语);
  // 全部缺省 = 旧行为 (全量实时推送)。
  function subscribe(fn, { since = null, types = null, thread = null, limit = 500 } = {}) {
    const typeSet = Array.isArray(types) && types.length ? new Set(types) : null;
    const match = (e) => {
      if (typeSet && !typeSet.has(e.type)) return false;
      if (thread !== null && thread !== undefined && String(e.thread || "") !== String(thread)) return false;
      return true;
    };
    if (since !== null && since !== undefined && Number.isFinite(Number(since))) {
      const min = Number(since);
      const replayLimit = Number.isFinite(Number(limit)) && Number(limit) > 0 ? Math.trunc(Number(limit)) : 500;
      let hist = events.filter((e) => e.seq > min && match(e));
      // since 落在内存窗口之外 (断线很久/长运行被裁剪) → 从 WAL 补回窗口之前的匹配事件。
      // 只补 seq < events[0].seq 的段落, 与内存部分拼成连续区间, 不会重复推送。
      // 2026-11-02 (WAL 分段): 回放从最新分段向前读, 读够 limit 即停 —— 旧历史不会
      //   因为一次断线续播被整库装载; until 把内存窗口内的事件排除在磁盘扫描之外。
      if (walPath && (!events.length || min < events[0].seq - 1)) {
        const gapEnd = events.length ? events[0].seq : Infinity;
        const old = replay({ since: min, until: gapEnd, limit: replayLimit }).filter(match);
        if (old.length) hist = old.concat(hist);
      }
      for (const e of hist.slice(-replayLimit)) {
        try { fn(e); } catch { /* 回放异常同实时回调口径: 不中断 */ }
      }
    }
    const wrapped = (e) => { if (!match(e)) return; fn(e); };
    subs.push(wrapped);
    return () => {
      const i = subs.indexOf(wrapped);
      if (i >= 0) subs.splice(i, 1);
    };
  }

  // 回放 WAL: 默认按时间序返回全部分段 + 活跃文件的事件 (旧行为)。
  // 可选 { since, until, limit, maxSegments, onGap }:
  //   since       = 只保留 seq > since
  //   until       = 只保留 seq < until (与内存窗口拼段时排除重叠)
  //   limit       = 只要**最新** N 条 (从新分段向前读, 读够即停, 不整库装载)
  //   maxSegments = 最多向前读几个分段 (0/缺省 = 不限制)
  //   onGap       = 缺口回调 (gaps 数组) —— 诊断用, 不改变返回形状
  // 2026-11-06 (评估 P1-8): 回放必须诊断 seq 缺口 —— 旧实现把 WAL 原样返回,
  //   崩溃/截断丢掉的事件 (如 seq=1,2,3,4,6 缺 5) 无任何告警, 观测与审计失真。
  //   检测口径: 文件内相邻原始事件 seq 差 1; 实际扫描到的相邻文件边界首尾 seq 衔接。
  //   缺口不改变返回的事件集 (兼容旧消费方), 但会: ① 挂在返回数组的 .gaps 属性上
  //   (JSON.stringify 不受影响); ② warn 留痕; ③ 触发 onGap 回调。
  function replay({ since = null, until = null, limit = 0, maxSegments = 0, onGap = null } = {}) {
    if (!walPath) return [];
    const files = [..._segmentFiles(), walPath]; // 文件名时间序 = 逻辑序
    if (!files.length) return [];
    // 注意 Number(null) === 0: 缺省值必须先判 null/undefined, 否则 until 会被当成 0
    const min = since !== null && since !== undefined && Number.isFinite(Number(since)) ? Number(since) : -Infinity;
    const max = until !== null && until !== undefined && Number.isFinite(Number(until)) ? Number(until) : Infinity;
    const lim = Number.isFinite(Number(limit)) && Number(limit) > 0 ? Math.trunc(Number(limit)) : 0;
    const segCap = Number.isFinite(Number(maxSegments)) && Number(maxSegments) > 0
      ? Math.trunc(Number(maxSegments)) : Infinity;
    let out = [];
    let scanned = 0;
    const gaps = [];
    const span = []; // 实际扫描过的文件: [{file, first, last}] (扫描序 = 从新到旧)
    for (let i = files.length - 1; i >= 0; i--) {
      if (scanned >= segCap) break;
      scanned += 1;
      const all = _readFile(files[i]);
      // (P1-8) 文件内缺口: 原始事件 (未经 since/until 过滤) 相邻 seq 必须差 1
      for (let k = 1; k < all.length; k++) {
        const a = Number(all[k - 1]?.seq);
        const b = Number(all[k]?.seq);
        if (Number.isFinite(a) && Number.isFinite(b) && b !== a + 1) {
          gaps.push({ from: a, to: b, file: path.basename(files[i]), kind: "in-file" });
        }
      }
      if (all.length) {
        span.push({ file: path.basename(files[i]), first: Number(all[0]?.seq), last: Number(all[all.length - 1]?.seq) });
      }
      const hit = all.filter((e) => Number(e.seq) > min && Number(e.seq) < max);
      if (hit.length) out = hit.concat(out);
      if (lim && out.length >= lim) break;
      // seq 单调: 本段最早一条 <= since, 更早的分段不可能再有命中
      const oldest = all.length ? Number(all[0]?.seq) : 0;
      if (Number.isFinite(oldest) && oldest > 0 && oldest <= min) break;
    }
    // (P1-8) 跨文件边界: 扫描序从新到旧, 相邻两文件 (新/旧) 应满足 新.first === 旧.last + 1。
    //   分段裁剪只删最旧文件, 不产生中段缺口; 边界衔接失败 = 有事件丢失。空文件/seq 非法时跳过该边界。
    for (let j = 0; j + 1 < span.length; j++) {
      const newer = span[j];
      const older = span[j + 1];
      if (!Number.isFinite(newer.first) || !Number.isFinite(older.last)) continue;
      if (newer.first <= 0 || older.last <= 0) continue;
      if (newer.first !== older.last + 1) {
        gaps.push({ from: older.last, to: newer.first, file: `${older.file} → ${newer.file}`, kind: "cross-file" });
      }
    }
    if (gaps.length) {
      for (const g of gaps) warn(`[EQ] WAL seq 缺口: ${g.from} → ${g.to} (${g.file}, ${g.kind}) —— 崩溃/截断丢事件, 观测与审计不可依赖该区间`);
      try { if (typeof onGap === "function") onGap(gaps); } catch (e) { /* 诊断回调不阻断 */ }
    }
    const result = lim ? out.slice(-lim) : out;
    if (gaps.length) result.gaps = gaps; // 数组附加属性: 消费方可选读取, 序列化/遍历不受影响
    return result;
  }

  // 内存历史快照 (仅当前窗口, 不是全量; 全量走 replay())
  function history() {
    return [...events];
  }

  // 诊断快照: 窗口占用/总水位/活跃订阅者数/分段状态 (测试与 /health 观测用)
  function stats() {
    const segments = _segmentFiles();
    return {
      retained: events.length, cap, seq: _seq, subscribers: subs.length,
      wal: walPath ? {
        bytes: _walBytes, maxBytes, rotations: _rotations,
        segments: segments.length, keepSegments, pruned: _pruned,
      } : null,
    };
  }

  return { push, subscribe, replay, history, stats };
}

// createProtocolBus: 便捷工厂 — 把 SQ/EQ 与常用提交动作打包
export function createProtocolBus({ walPath, maxEvents, walMaxBytes, walKeepSegments } = {}) {
  const sq = createSubmissionQueue();
  const eq = createEventQueue({ walPath, maxEvents, walMaxBytes, walKeepSegments });

  // 提交一个用户回合 (USER_TURN op)
  function submitUserTurn(text) {
    return sq.submit({ type: OpType.USER_TURN, payload: { text } });
  }

  // 中断当前回合 (INTERRUPT op)
  function interrupt() {
    return sq.submit({ type: OpType.INTERRUPT, payload: {} });
  }

  // 关闭总线 (无持久连接, 留作未来扩展点)
  function close() {
    /* noop */
  }

  return { sq, eq, submitUserTurn, interrupt, close };
}

// ---- 插件清单契约 (2026-11-02) ----
// 敏感服务能力白名单。放在 protocol (L0) 而不是 plugin/ —— Web 管理页 (L3) 也要校验同一份
// 白名单, 从 plugin (L4) 反向依赖会新增越层边。这里是"清单里允许写什么"的共享契约。
// 诚实边界: 能力限制的是**服务注册范围**, 不是 JS 沙箱。
export const PLUGIN_CAPABILITIES = Object.freeze([
  "routes", "lifecycle", "tools", "shell", "pages", "providers", "extensions",
]);

// 校验清单 capabilities: 必须是字符串数组且每项在白名单内; 未知项整插件 fail-closed。
// 返回 { capabilities } 或 { error } —— 调用方 (加载器/管理 API) 不猜、不降级。
export function parsePluginCapabilities(raw) {
  if (raw === undefined || raw === null) return { capabilities: [] };
  if (!Array.isArray(raw)) return { error: `capabilities 必须是数组, 收到 ${typeof raw}` };
  const out = [];
  for (const c of raw) {
    if (typeof c !== "string" || !PLUGIN_CAPABILITIES.includes(c)) {
      return { error: `未知能力 ${JSON.stringify(c)} (允许: ${PLUGIN_CAPABILITIES.join(", ")})` };
    }
    if (!out.includes(c)) out.push(c);
  }
  return { capabilities: out };
}

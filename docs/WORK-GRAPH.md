# 工单账本 (Work Graph) — Super-agent Tickets/Assignments 的落地

> 2026-11-02 · 三期第二批。设计来源: DeepSeek 产品部《Super-agent 设计探索》的
> Tickets / Assignments / Admission 语义，以及 `deepseek-ai/dsh-superagent-prototype`
> (MIT, 仅阅读设计，未复制源码) 中 `src/core` 的 admission/ticket 分层。
> 本文只描述皮皮虾自研实现；代码在 `src/workgraph/`，零运行时依赖。

## 1. 为什么需要

一至三期的入站链路是「受理即执行」：

- 同步消息走 `Channel.handleTrigger → agent.chat()`，回复即完成；
- 异步受理走 `chatAsync()`，任务注册表在内存（`_bgTasks`，上限 50）；
- 话题直通走 `ThreadBridge → legion.send()`，结果经 delivery 回投。

三条路径都没有**跨重启的工单事实**。进程在任务中途退出后：

- 用户只看到「没有回复」；
- 没有任何地方能回答「这条消息处理到哪了」；
- IM 平台重试 webhook 时，同一消息会被重复执行（重复工具副作用）；
- 也无法显式重跑一条被中断的任务。

工单账本把这四条补上。它不接管执行，只记录事实：**准入即建单，执行即指派，终态即收口**。

## 2. 数据模型

一张工单 (ticket) 对应一条被准入的入站输入：

| 字段 | 含义 |
|---|---|
| `id` | `wk_<base36时间>_<seq>` |
| `status` | `admitted → working → done / failed / cancelled`（`waiting` 为迁移态，预留给长驻 worker） |
| `source/from/group/thread/messageId` | Trigger 来源与话题归组 |
| `sessionKey` | 会话键（记忆/互斥/审计分区） |
| `text` | 原文（截 2000 字符，供显式重跑） |
| `attempts` | 重跑次数（初始 0） |
| `worker / assignmentId` | 当前执行者与指派 |
| `origin / externalId` | 请求来源（`ingress/ans/external/requeue`）与外部系统指派 ID（同时作为去重反查索引） |
| `dedupeKey / dedupeStrategy / requeueOf` | 准入时算定的最终去重键与命中层（explicit > external_id > source_message）；重跑时记录上一轮 assignmentId |
| `deliveryReceipt` | 投递终态缓存（`delivered/dead_letter/unknown`，仅当前 assignment 的首个终态）；权威事实仍在 `DELIVERY_*` 事件流 |
| `result / resultPreview / error / failureKind` | 终态证据（结果截 4000，预览/错误截 300） |
| `usage` | token 统计（prompt/completion/cacheHit/cacheHitPct/total） |
| `createdAt/startedAt/endedAt` | 生命周期时间戳 |

一次执行是工单下的一次**指派** (assignment)：`{id, ticketId, worker, sessionKey, origin, route,
delivery, status, rounds, steps, tools, lastTool, usage, outcome, errorKind, resultPreview, error,
startedAt, endedAt}`。`route` 为 `sync/async/thread`，`delivery` 是 `delivery.v1` 契约快照
（`ticketId/assignmentId/route/origin/sink/execution/policy/dedupe`），`assignmentId` 由账本
在落盘时绑定，旧 ID 永不复用。同一工单重跑会产生新的指派，历史指派全部保留。

投递状态不落账，而是由 `DELIVERY_*` 事件折叠（`foldDeliveryState`）：`none → accepted →
(delivered | dead_letter)`，可重试失败仍算 `accepted`。完成判定由 `judgeTicket` 给出，
**唯一收单条件是 `ticket.status=done && deliveryState=delivered`**；组合矩阵与重试裁决见
[dsh-absorb/02-STATE-MATRIX.md](dsh-absorb/02-STATE-MATRIX.md)。

执行与投递的生命周期各有独立事件流（字段冻结于
[dsh-absorb/00-EVENTS.md](dsh-absorb/00-EVENTS.md)）：

- `assignment_started` → `assignment_progress*`（≤1 条/500ms，合并后 `coalesced=true`）
  → `assignment_ended`（恰好 1 条）；
- `delivery_accepted`（每次尝试、发送前）→ `delivery_failed*`（可重试）→
  `delivery_delivered` | `delivery_dead_letter`（恰好 1 条终态）。

同步直发的回执由 `src/channels/receipts.js` 统一产出（硬超时 30s，失败固定
`failed(willRetry=false) → dead_letter(delivery_timeout)`，不重试）；异步队列共用同一份
实现，只是重试由队列调度。执行超时/取消且从未进入投递时，由服务层补
`dead_letter(attempt=0, reason=execution_timeout|cancelled)`。

持久化默认是 append-only JSONL：`<dataDir>/workgraph/tickets.jsonl`，一行一条事实
（`ticket_created / ticket_patch / assignment_created / assignment_patch / ticket_dropped`）。
内存态由日志折叠，任何时刻可重放；压缩只是把等价折叠结果写回（JSONL 用临时文件 + 原子
rename），不会改变事实。

Step 9 起事实后端可替换（`agent.work_graph.state_backend`）：默认 `jsonl`，行为逐字不变；
`sqlite` 用 `node:sqlite` 的单表 `journal(seq, at, body)` + WAL，压缩在事务内完成。
两种后端产出同一组事实、走同一个折叠函数，状态机/去重/恢复语义完全一致。切换后端**不迁移**
旧数据：旧文件原样保留，新后端从空账本开始（换后端等于换账本位置）。SQLite 需要 Node >= 22.5；
不可用时显式配置会得到可读错误，不会静默回落到 JSONL。

Step 7 的可选检查点是**旁路文件**：`<dataDir>/workgraph/checkpoints/<assignmentId>.jsonl`，
一行一次只读/幂等工具调用（`{v, at, callId, tool, key, ok, chars, result}`，结果截 4KB，
每指派上限 500 条）。它不是账本事实，只用于断点续执行；工单进入终态、`prune` 或
`markInterrupted` 时删除。关闭 `resume_checkpoint` 时不建目录、不写盘。检查点与账本后端
无关：即使 `state_backend=sqlite`，它仍是 per-assignment JSONL 旁路文件。

## 3. 状态机与语义

```
admitted ──begin──> working ──complete──> done
   │                   │
   │                   ├──fail──> failed ──requeue──> admitted
   │                   ├──cancel─> cancelled ──requeue──> admitted
   │                   └──wait──> waiting (长驻 worker 迁移态, 预留)
   └──cancel──> cancelled
```

关键约束（都有测试）：

- **终态不可覆盖**：取消/失败后迟到的 `complete` 不会把工单改回 done；
- **成功不重跑**：`requeue` 只接受 failed/cancelled，避免重复副作用；
- **恢复默认只标记**：启动时上一实例遗留的 `admitted/working/waiting` 工单标为
  `failed/interrupted`，**绝不静默重跑**（工具可能有副作用）；重跑是显式动作；
- **安全自动恢复是两个例外**（都默认关）：`resume_unstarted=true` 只放行**从未 `begin`**
  的 `admitted` 工单（没有执行事实，因而不存在工具副作用）；`resume_started=true`（Step 6）
  额外放行 **`working` 且当前指派 `replaySafe=true`** 的工单（开跑过的工具全为只读/显式幂等，
  整轮重放不会翻倍副作用）。`waiting`、`replaySafe=false`/缺字段、超龄或超限仍一律标记中断；
- **同实例免疫**：恢复按 store 实例 ID 判定，不会误伤当前进程刚建的在途工单
  （标记与恢复候选同一口径：活指派绝不会被收口后重跑）；
- **容量只淘汰终态**：`max_tickets` / `retention_days` 只清理 done/failed/cancelled，
  活跃工单永不因容量被删除。

## 4. 入站路径的接线

`src/channels/base.js` 的 `handleTrigger` 在准入门之后统一建单，再按原分支执行：

| 路径 | 指派 worker | 收口 |
|---|---|---|
| 同步 | `router` | `chat()` 返回 → done；`sendSync` 产投递回执；抛错 → failed 后继续上抛 |
| 异步受理 | `router:async` | 回执照发（不产 delivery 事件）；`chatAsync` 的 onDone/onError 收口，结果经 delivery 队列回投 |
| 话题直通 | `thread:<worker>` | 父进程按 worker 信封收口 → done；随后 deliver 结果入队；未转发 → failed |
| 后台任务取消 | — | `bgCancel` 把对应工单收口为 cancelled |

**不走 `handleTrigger` 的三条直连路径**（2026-11-05 收口）共用 `src/flow/worklink.js`
的 `createTicketLink`，同样是 `submit → begin → complete/fail` 三段式：

| 路径 | source | 说明 |
|---|---|---|
| 微信被动回包 (`_replyFromXml`) | `wechat` | 5s 协议只回 XML，不经 `send()` 二次推送；去重命中已完成工单直接回缓存结果，命中在途回空体 |
| Web UI 对话 (`/message` `/message/stream`) | `http` | `from=sessionKey`；`_acquire` 429 拒绝时不建单；流式在 finally 收口 |
| TUI (`runTurn`) | `tui` | `from=会话键`，与 TUI 单会话队列一一对应 |

三条路径的 `messageId` 留空：`store.findDuplicate` 对空 messageId 恒返回 null，每条消息天然独立建单。
委派（`spawn_agent`）也建单：`cause:"delegate"`、`from=父会话键`、`worker=子 agent 名`，
信封摘要回带 `工单=wk_xxx`，子任务执行证据可在 `/work show` 溯源。

账本写入失败只影响账本：通道层 catch 后照常回复，用户无感（`work_graph.enabled=false`
时连服务都不建）。

**投递契约**：`planIngress` 为每条放行消息解析 `delivery.v1`（`src/flow/delivery-contract.js`），
解析顺序为「显式 `trigger.delivery` > 通道默认 `channels.delivery` / `channels.<name>.delivery`
> flow 默认 > sync」，显式只能把 sync 收紧为 async，不能反向升级。通道按契约执行：

- 同步：`send()` 硬超时 = `min(policy.deadline_ms, 剩余 execution 预算)`，失败不重试；
- 异步：结果 job 携带 `policy`（`max_attempts/backoff/ttl/retry_on`），队列逐 job 执行，
  `retry_on` 不含的错误（如 4xx 参数错）立即死信；无 policy 的旧 job 仍用队列级常量；
- 话题直通：`forward_timeout_ms > 0` 才覆盖桥默认（0 = 沿用 120s），worker 不参与投递。

显式契约只认进程内 `trigger.delivery`，不从 webhook 请求体或 `meta` 读取，避免伪造 sink/route。

**webhook 去重**：同一 `source + from + messageId` 在 `dedupe_ms`（默认 30s）内复用原工单；
若原工单仍在途，不受窗口限制（长任务跑 5 分钟后重试仍命中）；已完成则**重发缓存结果**
（首次回复可能丢包，直接丢弃会让用户永远收不到答案）。

**启动安全自动恢复**：`recover` 在 agent 装配时折叠账本。两类工单可进入恢复队列
（各自在 `resume_max_age_ms` / `resume_limit` 内）：

| 类型 | 条件 | 依据 |
|---|---|---|
| `unstarted` | `resume_unstarted=true`，`admitted` 且从未 `begin` | 没有执行事实 = 没有副作用 |
| `replay` | `resume_started=true`，`working` 且 `assignment.replaySafe === true` | 写前事实证明整轮未碰过有副作用工具 |

**`replaySafe` 是写前事实**：有副作用且非幂等的工具（写文件/命令/网络/记忆写入等）在
**执行前**经 `service.markUnsafeBySession` 把指派标脏，单向锁不允许改回；只读或显式
`idempotent` 的工具不标脏。标脏落账失败时该工具拒绝执行（fail-closed）。旧账本缺字段
按无证据处理，`waiting`（长驻 worker 在子进程执行）不在本步范围内。

`src/server.js` 在 `ChannelManager.start()` **之后**调用 `agent.resumeUnstartedTickets()`，
两类工单都经 `chatAsync` 重跑（replay 的 worker 记为 `router:replay`），并把结果回投原通道
—— 顺序是硬约束，通道没起来就没有投递落点。replay 会生成**新 assignmentId** 并从任务开头
重跑，不是断点续执行；安全性来自"上一轮没有副作用"，不是来自"跳过已做步骤"。
队列一次性消费；失败按普通工单失败收口并回投，不拖垮启动流程。

## 5. 控制面

### 命令

```
/work                    活跃/失败工单清单 + 统计
/work show <id>          单张工单 + 全部指派
/work cancel <id>        取消在途工单（联动 interrupt 后台任务）
/work requeue <id>       显式重跑失败/取消工单（结果回投来源通道）
```

`/work` 是隐藏别名，不改变 15 条内置命令名册。

### HTTP

```
GET  /api/tickets?status=working,failed&limit=30
GET  /api/tickets?status=working,waiting&assignments=1   // 附加当前指派进度
GET  /api/tickets?id=wk_xxx
POST /api/tickets  { "op": "cancel" | "requeue", "id": "wk_xxx", "reason": "..." }
```

`assignments=1` 是外部看门狗用的加法式扩展：为每张工单附加
`assignment:{id,status,worker,sessionKey,rounds,steps,tools,lastTool,startedAt,updatedAt,replaySafe}`。
不传该参数时响应与扩展前逐字一致。

### 外部看门狗（任务级，进程外）

```bash
npm run watchdog:external                       # 单次巡检 (默认 127.0.0.1:8899)
npm run watchdog:external -- --watch --interval 60
npm run watchdog:external -- --act cancel --max-actions 1
```

`src/ans/external-watchdog.js` 只依赖 HTTP 只读接口，可跑在 agent 进程之外；
判定复用本进程看门狗的 `detectWorkerDrift`（`tool_repeat`/`round_spin`）与同一停滞口径。
**默认只报告**：无 `--act` 时不发任何写请求。显式 `--act cancel` 才发取消，单次受
`--max-actions`（默认 1）上限，同一工单停滞 + 漂移只处置一次；不重跑、不批量清理。
认证优先 `--token` / `PPX_AUTH_TOKEN`，缺失时读 `/api/bootstrap`（仅回环可信请求下发）。
退出码：`0` 健康 / `1` 有发现 / `2` 配置、请求或认证错误（列表失败报告为 `crit`）。

### Web UI

工作区抽屉新增「工单」页：状态筛选（全部/排队/执行中/失败/完成）、行内详情
（输入/结果/错误/工具/指派）、在途工单「取消」、失败/取消工单「重跑」。
后台每 5s 自动刷新；展开详情时暂停刷新，避免把正在读的内容折回去。
数据源与 `/work`、`/api/tickets` 完全同源，不另存一份前端状态。

### 事件

EQ 新增 `ticket_created / ticket_assigned / ticket_waiting / ticket_completed /
ticket_failed / ticket_cancelled / ticket_requeued / ticket_interrupted`；`ticketId`
进入事件顶层引用键，订阅方可按工单归组。看门狗/Web UI/外部订阅共用这一条事件流。

Step 3 起再增执行与投递事件：`assignment_started / assignment_progress / assignment_ended`
（服务层产出，`assignmentId` 同为顶层引用键）与 `delivery_accepted / delivery_delivered /
delivery_failed / delivery_dead_letter`（通道直发与 delivery 队列共用
`channels/receipts.js`）。回执身份为 `<assignmentId>:<attempt>:<state>`，`seq` 只排序。
话题直通由父进程产出全部事件，worker 只回带 `ticketId/assignmentId` 的信封（I11/I12）。

调度层再增 `router_decision / router_dispatch / worker_report`：决策在开派前落一次
（模式、任务数、是否注入全局上下文），派发按 assignment 落一次，回执由
`normalizeWorkerReport` 归一化后落一次。三者与工单事件同走 `src/flow/router.js`
的白名单双写（EQ + 审计链），任务正文、回复、思考不入链；订阅方可用
`ticketId/assignmentId` 把决策、派发、回执与工具事件串成一条生命周期。

### 模型侧入口

`follow_thread`（orchestration 工具组）让模型直接驻派/撤驻/查看长驻 worker：
`action=attach` 把当前会话交给同一 worker 持续跟进，后续同会话消息在通道层直通，
不再进 Router LLM；`detach` 撤驻并回收进程；`list` 查看驻派清单与转发次数。
它是 `threadDelegate/threadDetach/threadWorkers` 的薄封装，不改变直通语义。

## 6. 配置

```jsonc
// config/ppx.json → agent.work_graph
{
  "enabled": true,        // 总开关; false = 不建服务/不写盘 (行为完全回到旧版)
  "max_tickets": 2000,    // 容量上限 (只淘汰终态)
  "retention_days": 14,   // 终态保留天数
  "compact_at": 5000,     // 日志行数超过即压缩
  "dedupe_ms": 30000,     // IM messageId 去重窗口
  "recover": "mark",      // mark = 启动只标记中断; off = 跳过恢复扫描
  "resume_unstarted": false,     // true = 安全自动恢复 admitted 子集 (默认关)
  "resume_started": false,       // true = working 且 replaySafe=true 的无副作用重放 (默认关)
  "resume_checkpoint": false,    // true = 写只读工具检查点并在重放时复用 (依赖 resume_started, 默认关)
  "resume_max_age_ms": 21600000, // 自动恢复年龄上限 (6h)
  "resume_limit": 3,             // 单次启动最多自动恢复条数
  "state_backend": "jsonl"       // 事实存储后端: jsonl (默认) | sqlite (Node >= 22.5, WAL)
}
```

无配置文件时默认开启；防御式读取，非法值回落安全默认。

## 7. 诚实边界

- **默认不自动重跑**。自动续跑会重复执行可能有副作用的工具（发消息、写文件、调 API）。
  当前提供的是「可发现 + 可显式重跑」，加上两个默认关的自动例外：`resume_unstarted`
  （没有执行事实的 admitted）与 `resume_started`（整轮未碰过有副作用工具的 working）。
  `replaySafe=false` 的 working、全部 `waiting` 仍需人工 `/work requeue`。
- **replay 默认从任务开头重跑；断点续执行是显式可选项**。`resume_checkpoint=true`
  （且 `resume_started=true`）时，只读/幂等工具的执行结果写入 per-assignment 检查点；
  重放时注入续跑提示，相同 `(工具, 参数)` 的已完成调用直接复用旧结果并标注
  `[断点续执行]`，不再重复执行。有副作用的调用从不进检查点、也永不复用。
  检查点只截 4KB、每指派 500 条，属于尽力而为的加速，不是可恢复的执行状态机；
  沙箱级"从指令中间继续"仍不在范围。
- **复用不校验依赖是否变化**。检查点只按 `(工具, 规范化参数)` 匹配；外部文件/接口内容
  在两次运行间变化时仍返回上次结果。需要新鲜数据时请改变参数（如加时间戳）或关闭
  `resume_checkpoint`。
- **自动恢复有年龄/数量上限**。默认只捞 6h 内、最多 3 条；超限工单保持 `failed/interrupted`，
  用 `/work requeue <id>` 显式确认。启动恢复只扫描最近 500 条活跃工单，更老的 admitted 会
  按中断处理 —— 宁可人工确认，也不放开无界重放。
- **任务级外部看门狗只看 API 快照**。`watchdog:external` 能独立于主进程判定停滞/漂移，
  但服务完全无响应时它只能报告请求失败（`crit`）；进程级存活仍由 Electron 主进程/系统层
  监督。其处置面只有 `cancel`，重跑仍需人工 `/work requeue <id>`。
- **重跑结果只回投来源通道**。来源通道未启动/已删除时，退化为 agent 通知回调，不会全通道广播。
- **同 dataDir 单写者假设**。与 session store 一致：两个进程同时写同一 dataDir 不属于支持场景；
  恢复按实例 ID 只标记「别人的」在途工单，但账本本身没有跨进程锁。SQLite 后端的 WAL 只改善
  崩溃恢复与读写并发，不改变单写者假设。
- **切换后端不迁移数据**。`state_backend` 只决定新事实写到哪里；从 jsonl 切到 sqlite（或反向）
  不会导入旧账本，旧文件保留在原处。需要保留历史时继续使用原后端。
- **SQLite 后端不是"存算分离"**。它仍要求 agent 进程与状态文件在同一 dataDir；无状态副本 +
  外置数据库仍是后续工作。
- **话题直通的 worker 内部进度只进事件、不落账**。直通时桥把 worker 的 `onProgress` 回调
  合并进 `assignment_progress`（≤1 条/500ms），执行与投递事实由父进程统一收口；
  worker 自身不写账本、不产投递事件。

## 8. 验证

```bash
node --test --test-force-exit \
  test/workgraph.test.js \
  test/workgraph-channel.test.js \
  test/workgraph-agent.test.js \
  test/tickets-api.test.js \
  test/follow-thread-tool.test.js \
  test/server-channels.test.js \
  test/workgraph-step2.test.js \
  test/workgraph-step3.test.js \
  test/workgraph-step4.test.js \
  test/workgraph-step6.test.js \
  test/workgraph-step7.test.js \
  test/workgraph-step9.test.js \
  test/external-watchdog.test.js  # Step 8 外部看门狗 (7 项) / Step 9 后端 (6 项)

npm run verify && npm run lint && npm test
```

# DSH 吸收 Step 0 · deliveryState × ticket.status 组合语义表（v1 冻结候选）

> 状态：**契约定义，不含运行时实现**。本表是 DSH 判断「一个 Assignment 是否完成 / 该不该重试」
> 的唯一依据。运行时代码只允许产生 `00-EVENTS.md` 定义的事件，本表只做**折叠与判定**。

## 1. 两个正交维度

| 维度 | 权威来源 | 含义 |
|---|---|---|
| `ticket.status` | workgraph 账本（append-only） | **执行**的结局 |
| `deliveryState` | `DELIVERY_*` 事件折叠（投影，不落库为权威） | **投递**的结局 |

**正交**：工单 `done` 不代表用户收到了；`delivered` 也不代表执行成功（失败通知同样要送达）。
完成判断是两者的**合取**，不是任一单边。

## 2. deliveryState 折叠算法

从该 `assignmentId` 的 `DELIVERY_*` 事件按 `seq` 递增折叠：

```
state = none
for e in delivery_events(assignmentId) ordered by seq:
  accepted      -> state = accepted
  failed        -> state = e.willRetry ? accepted : failed
  delivered     -> state = delivered      // 终态，后续事件非法
  dead_letter   -> state = dead_letter    // 终态，后续事件非法
```

补充规则：

- `none`：没有任何投递事件。**不是**「投递成功」，也**不是**「不需要投递」。
- `accepted`：含「第 n 次失败、第 n+1 次尚未开始」的重试间隙。
- `failed`：`willRetry=false` 且死信尚未写入的**瞬态窗口**，正常应在同一次收口内消失。
- `unknown`：不来自事件，来自**恢复探测**——存在 `accepted`、无终态，且进程重启后
  无法确认 `send()` 是否已到达通道。折叠结果为 `accepted` 时必须先做恢复探测再降级为
  `unknown`，不能直接当成「还在投递」。
- 终态之后又出现同 assignment 的投递事件 → 保留首个终态，后者计为**契约违约**（告警，不覆盖）。

## 3. 组合矩阵（7 × 6）

图例：

| 码 | 含义 | DSH 允许动作 |
|---|---|---|
| `C` | 完成 | 收单，Assignment 完成 |
| `P` | 进行中 | 等待，不得收单、不得重跑 |
| `R` | 执行终态、可显式重跑 | 允许人工/显式 requeue（新 assignmentId），**禁止自动重跑** |
| `F` | 失败终态 | 记录，不自动动作 |
| `H` | 人工介入 | 告警 + 人工核对；**不自动重跑、不自动重投** |
| `X` | 非法组合 | 契约违约，告警；不做任何状态推进 |
| `—` | 终态无动作 | 记录即可 |

| ticket.status ↓ / deliveryState → | `none` | `accepted` | `failed` | `dead_letter` | `delivered` | `unknown` |
|---|---|---|---|---|---|---|
| `admitted` | P | X | X | X | X | X |
| `working` | P | X | X | X | X | X |
| `waiting` | P | P | P | P* | P* | H |
| `done` | H | P | P | H | **C** | H |
| `failed`（普通） | P* | P* | P* | R | R | H |
| `failed`（interrupted） | R | H | H | R | H | H |
| `cancelled` | P* | H | H | — | — | H |

`P*` = 瞬态，允许存在但必须在一个**收口宽限期**内迁出（v1 固定 5 分钟，不提供配置）；
超期仍是该组合 → 降级为 `H`（视为卡死，不自动动作）。

### 3.1 逐格说明（只列非显然格）

| 组合 | 为什么 |
|---|---|
| `admitted/working × accepted` = X | 投递必须先有 `assignment_ended`；执行未结束就有投递事件，说明事件生产端违约。 |
| `admitted/working × 任何投递终态` = X | 同上，且会污染「完成」判断。 |
| `waiting × accepted/failed/dead_letter` = P/P/P* | thread 路由下父进程收到 worker 信封后即可开始投递，工单收口与投递先后**不强制**；等待收口，不据此判完成。 |
| `waiting × delivered` = P* | 结果已送达但工单未收口，属收口滞后；超宽限期转 `H`。 |
| `done × none` = H | 执行成功却从未投递，且没有 `accepted` —— 只可能是同步路径漏发 accepted（违约）或误配了空 sink。 |
| `done × dead_letter` = H | 执行成功但用户没收到。**不允许**因此重跑执行（会重复副作用）；只允许人工重发结果或显式 requeue（新 assignment）。 |
| `done × unknown` = H | 可能已送达也可能没送达；重发前必须人工核对，避免重复。 |
| `failed × dead_letter` = R | 执行失败且结果未送达；可显式 requeue，但不自动。`reason=execution_timeout` 时同样只走显式 requeue。 |
| `failed × delivered` = R | 失败通知已送达；可显式 requeue，但不自动。 |
| `failed × none/accepted/failed` = P* | 终态工单的投递尚未收口（失败通知还在发）；超宽限期转 `H`。 |
| `failed(interrupted) × none` = R | 崩溃恢复标记。**自动**恢复仅限两个子集：`resume_unstarted=true` 且 `admitted` 从未 `begin`（无执行事实）；或 `resume_started=true` 且中断指派 `replaySafe=true`（开跑过的工具全为只读/显式幂等，Step 6）。其余一律显式 requeue。 |
| `failed(interrupted) × delivered` = H | 崩溃前结果可能已送达；自动重跑会造成重复副作用，必须人工核对。 |
| `failed(interrupted) × accepted/failed` = H | 投递结果不确定，先做恢复探测降级 `unknown`，再人工判。 |
| `cancelled × none` = P* | 取消路径应补 `dead_letter(reason=cancelled, attempt=0)`；宽限期内等待。 |
| `cancelled × accepted` = H | 取消到达时投递已受理，用户可能已收到；撤回不成立，人工记录。 |
| `cancelled × dead_letter/delivered` = — | 终态且无可撤回动作；记录即可。 |
| 任意 `X` | 不推进状态、不重试、不告警风暴：每 assignment 每小时最多 1 条违约告警。 |

## 4. DSH 判定算法（伪代码）

```
judge(ticket, delivery):
  if anyViolation(ticket, delivery): return VIOLATION

  if ticket.status == cancelled:            return CANCELLED
  if ticket.status in [admitted, working]:  return IN_PROGRESS
  if ticket.status == waiting:              return IN_PROGRESS

  if ticket.status == done:
    if delivery == delivered:               return COMPLETED
    if delivery in [none, dead_letter, unknown]: return MANUAL_REVIEW   # 执行成功、投递未成
    return DELIVERING                                                 # accepted / failed(瞬态)

  if ticket.status == failed:
    if ticket.failureKind == interrupted:
      if delivery == none and neverBegan(ticket): return REQUEUE_ALLOWED
      return MANUAL_REVIEW
    if delivery in [none, accepted, failed]:  return DELIVERING_OR_STUCK # 超宽限期转 MANUAL_REVIEW
    return FAILED                                                        # dead_letter / delivered
```

**唯一收单条件**：`ticket.status == done && deliveryState == delivered`。其它任何组合都不得
被 DSH 标记为 Assignment 完成。

判定结果到动作的映射（消除「判定名」与矩阵码的歧义）：

| 判定 | 动作 |
|---|---|
| `COMPLETED` | 收单（码 `C`） |
| `IN_PROGRESS` / `DELIVERING` | 等待（码 `P`） |
| `DELIVERING_OR_STUCK` | 等待；超宽限期转 `MANUAL_REVIEW` |
| `FAILED` | 记录失败；允许**显式** requeue（码 `R`），禁止自动重跑 |
| `CANCELLED` | 记录；无动作（码 `—`） |
| `REQUEUE_ALLOWED` | 允许显式 requeue；`resume_unstarted` 子集可自动 |
| `MANUAL_REVIEW` | 告警 + 人工（码 `H`） |
| `VIOLATION` | 告警；不推进任何状态（码 `X`） |

## 5. 该不该重试（唯一裁决表）

| 场景 | 自动重试？ | 依据 |
|---|---|---|
| 投递失败，`willRetry=true` | 是（PPXANS 内部按 `delivery.retry`） | `00-EVENTS.md` §3.6 |
| 投递耗尽 `delivery_exhausted` | 否 | DSH 不重投；告警/人工 |
| sync 发送超时 `delivery_timeout` | 否 | 单次尝试，已落死信 |
| 执行超时 `execution_timeout` | 否（仅显式 requeue） | 新 assignment 需人工/DSH 显式发起 |
| 执行失败（普通） | 否（仅显式 requeue） | 同上 |
| interrupted 且从未 begin | 可自动（仅 `resume_unstarted=true`） | 无执行事实 = 无副作用 |
| interrupted 且指派 `replaySafe=true` | 可自动（仅 `resume_started=true`） | 执行前已记录"未碰过有副作用工具" |
| interrupted 且 `replaySafe=false`/缺字段/waiting | 否 | 可能已有副作用 / 无可靠证据 |
| `unknown` | 否 | 可能已送达/已执行 |
| `cancelled` | 否 | 显式取消 |

**「重试投递」与「重跑执行」是两件事**：前者只重发同一结果，后者生成新 assignment 并重新执行。
本契约中 DSH 只决定后者；前者完全由 PPXANS delivery 层自治。

## 6. requeue 契约（冻结）

- 生成**新** `assignmentId`；旧 ID 永不复用。
- 工单复用，`attempts += 1`；事件为 `ticket_requeued {requeueOf: 原assignmentId}`。
- 只接受 `failed` / `cancelled`（`done` 不重放，避免成功后再执行一遍的重复副作用）。
- requeue **不自动执行**：建单后回到 `admitted`，由显式调用方（命令/HTTP/DSH）触发执行。
- 新 assignment 使用全新的 `delivery` 契约对象，旧投递回执不继承。

## 7. 与代码的对应关系（Step 2 / 3 / 4 已落地，2026-11-04）

| 契约概念 | 载体 | 状态 |
|---|---|---|
| `ticket.status` | `src/workgraph/store.js` `TICKET_STATUS` | 已有 6 态 |
| `ticket.origin / externalId / dedupeKey / dedupeStrategy / requeueOf` | `store.create/update` + `service.submit/requeue` | 已落地（Step 5 前置） |
| `assignmentId` | `assignment.id`；requeue 生成新 ID，旧 ID 由 `requeueOf` 指向 | 已落地 |
| `assignment.route / origin / delivery` | `store.assign` + `service.begin`（delivery 为 `delivery.v1` 快照） | 已落地 |
| `assignment.outcome / errorKind / usage / lastTool` | `_closeAssignment` / `progress` | 已落地 |
| `assignment.replaySafe / replayUnsafeTool` | `assign` 默认 true；`_runTool` / L1 执行前经 `service.markUnsafeBySession` 单向标脏；`recover` 只认 true | 已落地（Step 6） |
| 无副作用证据的安全重放 | `recover({resumeStarted})` + `agent.resumeUnstartedTickets()`（worker `router:replay`，新 assignmentId） | 已落地（Step 6） |
| `deliveryState` | `src/workgraph/state.js` `foldDeliveryState`（事件流为权威） | 已落地 |
| `ticket.deliveryReceipt` | 终态缓存（delivered/dead_letter/unknown），`service.markDeliveryState` 首个终态生效 | 已落地（Step 5 前置） |
| 完成判定 | `src/workgraph/judge.js` `judgeTicket`：显式事实 > 终态快照 > none | 已落地 |
| 去重三段式 | `store.findDuplicate`：explicit > external_id > source_message；显式 key 不回落 messageId | 已落地（Step 5 前置） |
| 契约去重上报 | `delivery-contract.buildDedupe` 如实上报 `key/strategy/external_id` | 已落地（Step 5 前置） |
| `execution_timeout` 口径 | `service.fail(id, err, {failureKind:"execution_timeout"})` | 已落地 |
| `ASSIGNMENT_STARTED / PROGRESS / ENDED` | `service.begin/progress/_closeAssignment`（progress 500ms 合并） | 已落地 |
| `DELIVERY_ACCEPTED / DELIVERED / FAILED / DEAD_LETTER` | `channels/receipts.js` 统一实现；同步直发 + delivery 队列共用 | 已落地 |
| 执行超时/取消的死信（attempt=0） | `service.fail/cancel`，仅当无 `delivery_accepted` 时补 | 已落地 |
| 话题直通的事件归属 | 父进程 `thread-bridge` 收口执行 + 投递；worker 只回信封（I11） | 已落地 |
| `delivery.v1` 解析 | `src/flow/delivery-contract.js`：显式 > 通道默认 > flow 默认 > sync，显式只能收紧 | 已落地 |
| 契约绑定 | `store.assign` 落盘时写入 `assignmentId`；`ticketId` 由 `planIngress` 带入 | 已落地 |
| 同步截止 | `channels/base._syncDeadlineMs(contract)` = `min(policy.deadline_ms, 剩余 execution 预算)` | 已落地 |
| 异步重试预算 | delivery 队列按 job 级 `policy` 执行 `max_attempts / backoff / ttl / retry_on` | 已落地 |
| 线程转发超时 | `policy.forward_timeout_ms > 0` 才覆盖桥默认（0 = 沿用 120s，I1 兼容） | 已落地 |

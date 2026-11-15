# DSH 吸收 Step 0 · 事件命名与所有权表（v1 冻结候选）

> 状态：**契约定义，不含运行时实现**。本文与同目录另外四份文件共同构成 DSH 吸收的
> 唯一真相源，先于任何 `flow/`、`workgraph/`、`channels/` 改动。
>
> 范围：只回答「谁在什么时机、生产什么事件、谁消费、允许多大频率」。
> 不定义数据库表、不定义 HTTP 路由、不定义 UI。

## 0. 四个事实域（先分清，再谈事件）

| 事实域 | 回答的问题 | 事件前缀 | 是否参与 DSH 完成判断 |
|---|---|---|---|
| 消息 | 用户/系统发来了什么 | `MESSAGE_*` | 否 |
| 工单 | 这条请求被谁接、处理到哪个状态 | `TICKET_*` | **是（状态半边）** |
| 指派 | 这次执行由谁跑、跑了多少轮/步 | `ASSIGNMENT_*` | 否（只描述执行） |
| 投递 | 结果有没有送到、送到哪、是否还会重试 | `DELIVERY_*` | **是（投递半边）** |
| 执行轮 | 主进程某一轮 LLM 的生命周期 | `TURN_*` | 否（仅观测） |

完成判断只看 `TICKET_*` × `DELIVERY_*`，详见 `02-STATE-MATRIX.md`。
`TURN_CLOSED` **不等于** `DELIVERED`。

## 1. 事件总表

| 事件 | 回答的问题 | 生产者 | 消费者 | 频率 / 持久化 |
|---|---|---|---|---|
| `assignment_started` | 这次执行由谁、以什么路由开始 | 通道执行分支 / 父进程 | DSH、Web UI、watchdog | 每 assignment 1 次；EQ WAL |
| `assignment_progress` | 执行到第几轮/几步、用了哪些工具 | worker 信封 → 父进程聚合 | Web UI、观测面板 | 每轮 1 次，且 ≥500ms 合并；EQ WAL |
| `assignment_ended` | 执行结束，结果是什么 | 父进程（含 thread 路由） | DSH、UI、工单收口 | 每 assignment 1 次；EQ WAL |
| `delivery_accepted` | 结果已交给通道/WAL，开始投递 | channels / delivery | DSH、UI | 每次 attempt 1 次；WAL（**先于发送**） |
| `delivery_delivered` | 结果已确认送达 | channels / delivery | DSH、UI | 每次 attempt ≤1 次；WAL |
| `delivery_failed` | 本次投递失败，是否还会重试 | channels / delivery | DSH、UI | 每次失败 attempt 1 次；WAL |
| `delivery_dead_letter` | 不会再投递了，原因是什么 | channels / delivery | DSH、UI、告警 | 每 assignment 1 次；WAL |
| `turn_started` | 主进程开了一轮 | agent | UI | 每轮 1 次；WAL |
| `turn_closed` | 主进程这一轮正常结束 | agent | UI、观测 | 每轮 1 次；WAL |
| `turn_aborted` | 主进程这一轮被中止 | agent | UI | 每轮 1 次；WAL |
| `ticket_created` | 工单已建立 | workgraph | DSH、UI、面板 | 每次状态迁移 1 次；WAL |
| `ticket_assigned` | 工单已指派给执行者 | workgraph | DSH、UI | 每次指派 1 次；WAL |
| `ticket_waiting` | 工单迁移到长驻 worker 等待回投 | workgraph | DSH、UI | 每次迁移 1 次；WAL |
| `ticket_completed` | 工单执行成功 | workgraph | DSH、UI | 每工单 1 次；WAL |
| `ticket_failed` | 工单执行失败 | workgraph | DSH、UI | 每工单 1 次；WAL |
| `ticket_cancelled` | 工单被取消 | workgraph | DSH、UI | 每工单 1 次；WAL |
| `ticket_requeued` | 工单被显式重跑（新 assignment） | workgraph | DSH、UI | 每次重跑 1 次；WAL |
| `ticket_interrupted` | 重启恢复时发现执行中断 | workgraph | DSH、UI | 恢复时 1 次；WAL |
| `message_received` | 入站消息到达 | flow | UI、观测 | 每条入站 1 次；WAL（不参与完成判断） |

**消费方约束**

- DSH 只允许用 `ticket_*` + `delivery_*` 做完成/失败/重试决策。
- `assignment_*` 用于展示执行进度、关联 worker，不改变工单终态。
- `turn_*` 是主进程观测：`thread` 路由下执行在 worker 子进程，主进程没有对应的 `turn_*`，
  因此 **DSH 不得把“没有 turn 事件”当成“没有执行”**。

## 2. 公共信封

所有事件复用 EQ 现有信封，引用字段可顶层携带（便于按 assignment 归组）：

```jsonc
{
  "id": "e_...",
  "seq": 123,                 // EQ 全局单调；只做排序/续订，不做去重
  "ts": 1793800000000,
  "schema_version": 1,        // 事件信封契约版本（见 03-INVARIANTS.md I18）
  "type": "delivery_delivered",
  "ticketId": "wk_...",
  "assignmentId": "as_...",
  "sessionKey": "feishu:chat:oc_xxx",
  "turnId": "t_...",          // 仅 turn_* 有
  "cause": "ingress | ans | external | requeue",
  "ref": "callId/..."          // 可选
}
```

`seq` 的职责边界：

- 全局排序、SSE 断点续订用它；
- **不能**用它判断“同一投递的重复事件”，去重键是 `(assignmentId, attempt, state)`；
  ANS notify（无工单）改用 `(deliveryId, attempt, state)`，两者都存在时 `deliveryId` 优先。
- 不要求跨 assignment 连续。

## 3. 字段清单

### 3.1 `assignment_started`

| 字段 | 必需 | 类型 | 说明 |
|---|---|---|---|
| `ticketId` | 是 | string | 所属工单 |
| `assignmentId` | 是 | string | 本次执行 ID（requeue 后是新 ID） |
| `route` | 是 | `sync` / `async` / `thread` | 路由，来自 delivery 契约 |
| `worker` | 是 | string | `router` 或 worker 名 |
| `sessionKey` | 是 | string | 执行会话 |
| `origin` | 是 | `ingress` / `ans` / `external` / `requeue` | 请求来源（requeue = 显式重跑产生的新 assignment） |
| `startedAt` | 是 | epoch ms | 开始时刻 |

### 3.2 `assignment_progress`

| 字段 | 必需 | 类型 | 说明 |
|---|---|---|---|
| `ticketId` / `assignmentId` | 是 | string | 同 3.1 |
| `rounds` | 是 | integer | 当前累计轮次 |
| `steps` | 是 | integer | 当前累计工具步数 |
| `tools` | 否 | string[] | 最近使用的工具名（去重，最多 32） |
| `lastTool` | 否 | string | 最近一次工具名 |
| `coalesced` | 是 | boolean | 是否由窗口合并产生 |
| `at` | 是 | epoch ms | 采样时刻 |

约束：**只做观测，不改变任何状态**；DSH 不得据此收单、重试或取消。

### 3.3 `assignment_ended`

| 字段 | 必需 | 类型 | 说明 |
|---|---|---|---|
| `ticketId` / `assignmentId` | 是 | string | 同 3.1 |
| `outcome` | 是 | `completed` / `failed` / `cancelled` / `timeout` / `needs_approval` | 执行结局（与 DSH Ticket 状态机对齐） |
| `rounds` / `steps` | 是 | integer | 与 worker 信封一致 |
| `tools` | 否 | string[] | 本轮工具名 |
| `usage` | 否 | object | `{prompt, completion, cacheHit, cacheHitPct}` |
| `errorKind` | 否 | string | 失败分类；`timeout` 时为 `execution_timeout` |
| `endedAt` | 是 | epoch ms | 结束时刻 |

### 3.4 `delivery_accepted`

> 身份字段二选一：工单执行用 `ticketId + assignmentId`；**ANS notify（I16，无工单）用 `deliveryId`**。
> submit 多目标时两者同时出现，回执身份取 `deliveryId`（每个 sink 一个）。

| 字段 | 必需 | 类型 | 说明 |
|---|---|---|---|
| `ticketId` / `assignmentId` | 是* | string | 同 3.1；ANS notify 时省略 |
| `deliveryId` | 是* | string | ANS notify / 多目标 submit 的稳定投递身份；存在时优先 |
| `attempt` | 是 | integer | 从 1 开始；无投递尝试的终态用 0（见 3.7） |
| `channel` | 是 | string | 目标通道 |
| `sink` | 是 | object | `{to, thread, replyTo}` 快照 |
| `acceptedAt` | 是 | epoch ms | 交给通道/WAL 的时刻 |

**时序硬约束**：`accepted` 必须在真正调用 `send()` / `delivery.enqueue()` **之前**持久化。
崩溃恢复时“有 accepted、无终态”才能安全判定为 `unknown`，而不是“从未受理”。

### 3.5 `delivery_delivered`

| 字段 | 必需 | 类型 | 说明 |
|---|---|---|---|
| `ticketId` / `assignmentId` / `attempt` | 是* | — | 同 3.4 |
| `deliveryId` | 否 | string | 同 3.4；ANS notify 时为身份字段 |
| `deliveredAt` | 是 | epoch ms | 送达确认时刻 |
| `providerMessageId` | 否 | string | 通道侧回执 ID（如飞书 message_id） |
| `receiptId` | 是 | string | `(身份, attempt, delivered)` 的稳定标识；身份 = `deliveryId` 或 `assignmentId` |

### 3.6 `delivery_failed`

| 字段 | 必需 | 类型 | 说明 |
|---|---|---|---|
| `ticketId` / `assignmentId` / `attempt` | 是 | — | 同 3.4 |
| `error` | 是 | object | `{kind, message, retryable}` |
| `willRetry` | 是 | boolean | 是否还有下一次 attempt |
| `nextAttemptAt` | 否 | epoch ms | `willRetry=true` 时的计划时刻 |

`delivery_failed` 之后若 `willRetry=true`，`deliveryState` 仍为 `accepted`（最新事实是“第 n 次失败、
第 n+1 次尚未开始”），只有 `willRetry=false` 才进入 `dead_letter`。

### 3.7 `delivery_dead_letter`

| 字段 | 必需 | 类型 | 说明 |
|---|---|---|---|
| `ticketId` / `assignmentId` | 是* | string | 同 3.1；ANS notify 时省略 |
| `deliveryId` | 否 | string | 同 3.4；ANS notify 时为身份字段 |
| `attempt` | 是 | integer | 实际尝试次数；执行超时/取消导致未尝试时为 0 |
| `reason` | 是 | `delivery_exhausted` / `delivery_timeout` / `execution_timeout` / `cancelled` | 终止原因 |
| `finalError` | 否 | object | 最后一次错误 |
| `deadAt` | 是 | epoch ms | 终止时刻 |

`reason` 是 DSH 区分“重试投递”与“重跑执行”的唯一依据：

- `execution_timeout` → 失败发生在执行阶段，DSH 应生成 **新 assignment**（requeue）；
- `delivery_exhausted` / `delivery_timeout` → 失败发生在投递阶段，PPXANS 已按 `delivery.retry` 用尽，
  DSH 不应自动重投，交给告警/人工。

### 3.8 `turn_closed`（扩展字段）

在现有 `{sessionKey, turnId, status}` 基础上增加：

| 字段 | 必需 | 说明 |
|---|---|---|
| `assignmentId` | 否 | 关联执行；没有运行在工单里时省略 |
| `ticketId` | 否 | 关联工单 |
| `rounds` / `steps` | 否 | 执行进度 |
| `tools` | 否 | 工具名清单 |
| `usage` | 否 | token 统计 |
| `outcome` | 否 | 与 `assignment_ended.outcome` 同枚举 |

**仍不参与完成判断**。`turn_closed` 只表示“这一轮执行结束”，结果可能还没投递。

### 3.9 `ticket_*`（扩展现有字段）

现有事件保持原样，新增可选字段：

| 字段 | 说明 |
|---|---|
| `origin` | `ingress` / `ans` / `external` / `requeue` |
| `externalId` | DSH 侧 assignment ID（可空） |
| `dedupeKey` | 准入时算定的最终去重键（见 `03-INVARIANTS.md` I6） |
| `dedupeStrategy` | 命中的优先级层：`explicit` / `external_id` / `source_message` / `none` |
| `deliveryState` | 当前投递折叠状态（见 `02-STATE-MATRIX.md`） |
| `requeueOf` | 仅 `ticket_requeued`：原 assignmentId |

## 4. 顺序与频率约束

### 4.1 允许的交错

```
assignment_started
  → assignment_progress*        (0..n，可观测)
  → assignment_ended            (恰好 1 次)
  → delivery_accepted           (每次 attempt 1 次，先于发送)
  → delivery_failed*            (async 重试间隙可多次；sync 失败固定 1 次 willRetry=false)
  → delivery_accepted*          (重试)
  → delivery_delivered | delivery_dead_letter   (恰好 1 次终态)
```

例外（无投递尝试的终态）：

- 执行超时：`assignment_ended(timeout)` → 工单 `failed` → `delivery_dead_letter(attempt=0, reason=execution_timeout)`；
- 取消：`ticket_cancelled` → `delivery_dead_letter(attempt=0, reason=cancelled)`；
- 以上两种情况 **不发** `delivery_accepted`，避免制造“已开始投递”的假事实。

例外（同步投递失败，不重试）：

```
delivery_accepted(attempt=1)
  → delivery_failed(attempt=1, willRetry=false, error.kind="timeout"|"send_error")
  → delivery_dead_letter(attempt=1, reason="delivery_timeout")
```

`sync` 失败必须留一条 `delivery_failed`（哪怕是单次尝试），再落死信 —— 只发死信会让
“投递为什么失败”在事件流里断档。这条 failed **不**回写成执行失败，也不触发新 assignment。

### 4.2 频率上限

| 事件 | 上限 | 合并规则 |
|---|---|---|
| `assignment_progress` | 每 assignment 每 500ms ≤1 条 | 按 round 聚合；窗口内多次采样只保留最新累计值，`coalesced=true` |
| `delivery_*` | 每 attempt ≤2 条（accepted + failed/delivered），整次投递额外 ≤1 条死信 | 不合并，attempt 单调 |
| `ticket_*` | 每次状态迁移 1 条 | 不按心跳发：`working` 期间不发重复事件 |
| `turn_*` | 每轮 1 条 | 不合并 |
| `message_received` | 每条入站 1 条 | 不合并 |

EQ WAL 按 8MB 轮转，`assignment_progress` 是唯一有洪泛风险的观测事件，500ms 合并是硬约束。

## 5. 三条路由的投递时序

### 5.1 `sync`

1. 执行结束 → `assignment_ended`；
2. **发送前**持久化 `delivery_accepted(attempt=1)`；
3. 调用 `send()`，硬超时 = `min(剩余 execution 预算, delivery.deadline_ms)`；
4. 成功 → `delivery_delivered(attempt=1)`；抛错/超时 → `delivery_failed(attempt=1, willRetry=false)`
   → `delivery_dead_letter(attempt=1, reason=delivery_timeout)`。`sync` **不重试**，
   失败路径固定为 accepted → failed → dead_letter 三连。

### 5.2 `async`

1. 执行结束 → `assignment_ended`；
2. `delivery.enqueue()` 前写 `delivery_accepted(attempt=n)`；
3. 队列按 `delivery.max_attempts` / `backoff` / `retry_on` 重试；每次失败发 `delivery_failed`；
4. 送达 → `delivery_delivered`；用尽 → `delivery_dead_letter(reason=delivery_exhausted)`。

用户收到的 `[已受理]` 回执 **不是** 投递事件，不得写成 `delivery_delivered`。

### 5.3 `thread`

1. 父进程 `legion.send` 前发 `assignment_started`；
2. worker 信封回传 `ticketId` / `assignmentId` / `rounds` / `steps` / `tools`，父进程据此发
   `assignment_progress` 与 `assignment_ended`；
3. worker **不参与投递回执**；父进程的 thread-bridge 完成结果投递（固定走 async 队列），
   发 `delivery_*`；
4. `thread` 路由没有主进程 `turn_*`，DSH 不得据此判空。

## 6. 验收自检（不读源码，只靠五个文件回答）

| 问题 | 答案出处 |
|---|---|
| DSH 如何判断一个 Assignment 完成？ | `02-STATE-MATRIX.md` §3 决策算法：只看 `ticket.status × deliveryState` |
| 执行失败后该不该自动重试？ | `03-INVARIANTS.md` I9 + 本文 §3.7：执行失败只走显式 requeue；投递失败才由 `delivery.retry` 处理 |
| ANS 的主动动作是否建单？ | `04-ans-lane.schema.json` 的 `x-projection-rules` + `03-INVARIANTS.md` I16/I17 |
| 同步路径失败算执行失败还是投递失败？ | 本文 §5.1：accepted → failed(willRetry=false) → dead_letter(`reason=delivery_timeout`)，属投递阶段，不重跑执行 |
| 崩溃后如何判断？ | 本文 §4.1 + 矩阵 `unknown` 行：不自动重投，人工/显式 requeue |

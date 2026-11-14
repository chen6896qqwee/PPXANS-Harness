# DSH 吸收 Step 0 · 兼容不变量（v1 冻结候选）

> 状态：**契约定义，不含运行时实现**。每条不变量都必须能翻译成一条回归测试或一条静态守卫；
> 无法守卫的条目不允许进入本清单（不做口号式承诺）。

## 0. 不变量分级

| 级别 | 含义 | 违约处理 |
|---|---|---|
| **MUST** | 破坏即契约失效，必须回滚 | 阻断发布 |
| **SHOULD** | 破坏会导致观测/体验退化 | 记录并排期 |
| **MAY** | 实现自由度 | 不约束 |

## 1. 行为兼容（对现有用户零感知）

### I1 · 缺省即旧行为（MUST）

未配置 `ans_lane`、请求未携带 `delivery.v1` 契约时，现有通道、flow、workgraph 的**用户可见
行为逐字节不变**：同步回复仍同步回复，异步受理仍只有 `[已受理]`，主动推送目标不变，
返回文本与错误文案不变，不新增工单。

新增的 `DELIVERY_*` / `ASSIGNMENT_*` 只是观测事实，只能由**携带契约的调用**或
`ans_lane.enabled=true` 触发；旧调用路径（无契约）不产生任何新事件。

- 守卫：现有 2404 项测试全绿 + 新增「无配置启动」对照测试（对比关键返回串与推送目标）。
- 例外：观测事件对用户不可见，但不得改变回复时序（见 I13）。

### I2 · 只增不改（MUST）

- 既有事件名、字段名、字段语义不得删除或重命名；
- 新增字段一律**可选**，缺省值必须能还原旧行为；
- 消费方必须忽略未知字段（含未知 `type`），不得因新事件崩溃。

- 守卫：事件快照测试（对 `EventType` 与关键 payload 做字段集合断言，只允许新增）。
- 破坏示例：把 `turn_closed` 的 `status` 改名 → 直接违约。

### I3 · 公共签名只加可选参数（MUST）

`Channel.send(to, text, meta?)`、`EventQueue.subscribe(fn, opts?)`、`work.submit(...)` 等
现有公共入口只允许追加**带默认值的可选参数/可选字段**；调用点数 ≥10 的构造函数不得新增
必填参数。

- 守卫：`grep` 调用点数 + 契约测试（旧签名调用仍然通过）。

## 2. 事实与身份

### I4 · 账本即真相，投影只作缓存（MUST）

- `ticket.status` / `assignment.status` 以 workgraph append-only JSONL 折叠为唯一真相；
- `deliveryState` 的权威事实仍是 `DELIVERY_*` 事件流；账本里的
  `ticket.deliveryReceipt` **只是终态缓存**（仅 `delivered` / `dead_letter` / `unknown`），
  用于 judge 免回放 EQ WAL，不作为独立事实源，也不得与事件流冲突时覆盖事件；
- 快照只写入当前 `assignmentId` 的**首个终态**；`assign` / `requeue` 必须清空旧快照；
- DSH 不得直接写 PPXANS 账本；跨系统只通过事件 + API 读。

- 守卫：store 写入白名单（只允许 `ticket_*` / `assignment_*` 记录类型）+
  快照与事件折叠对照测试（写入终态后两者必须一致；旧 assignment 迟到终态被忽略）。

### I5 · 回执身份 `(assignmentId | deliveryId, attempt, state)`（MUST）

`seq` 只用于全局排序与 SSE 续订，**不参与去重**。同一回执重复投递时以身份键幂等。
`seq` 不保证跨 assignment 连续。

- 工单执行路径身份 = `assignmentId`（既有语义不变）；
- ANS notify（无工单，I16）身份 = `deliveryId`；submit 多目标且两者同时存在时 `deliveryId` 优先，
  保证每个 sink 的 `(attempt, state)` 不会互相覆盖；
- `receiptId` 稳定格式 `<身份>:<attempt>:<state>`。

- 守卫：重复事件注入测试（同一身份两次，折叠结果不变）+ ANS notify 回执无 ticket/assignment 的断言。

### I6 · 去重键优先级（MUST）

```
1. explicit      ：调用方 dedupe.key（含 idempotency_key 别名）
2. external_id   ：origin:externalId（DSH/外部系统重投通常没有平台 messageId）
3. source_message：source:from:messageId（IM webhook 重试）
4. none
```

- 键在**准入时算定并落账**（`ticket.dedupeKey` + `ticket.dedupeStrategy`），
  重投时不再依赖"这次请求带了哪些字段"；各段 percent-encode 后用 `:` 连接；
- 显式 key 存在时**不回落** messageId（既有语义，测试锁死）；
- `externalId` 同时作为反查索引保存在 ticket 上；
- 在途工单（`admitted/working/waiting`）**不受** `dedupe.window_ms` 限制；
- 已 `done` 且在窗口内 → 重发缓存结果，不重新执行；
- 已 `failed/cancelled` 且在窗口内 → 复用工单，不自动重跑。

- 守卫：webhook 重放测试（同 messageId 三次 → 1 工单、1 次执行、3 次同结果）+
  三段式优先级测试（无 messageId 的 externalId 重投必须命中同一工单）。

### I7 · assignmentId 永不复用（MUST）

requeue 必须生成新 `assignmentId`，并通过 `requeueOf` 指向旧 ID。
同一 assignment 的 `assignment_started` / `assignment_ended` 各恰好 1 次。

- 守卫：状态机测试（重复 start/end 被拒绝或幂等忽略）。

## 3. 执行与投递分离

### I8 · 两套预算，互不改写（MUST）

- 执行失败/超时**不得**被投递层的重试改写为成功；
- 投递失败**不得**被回写成执行失败（`ticket.status` 保持执行事实）；
- `sync` 的发送超时 = `min(剩余 execution 预算, delivery.deadline_ms)`，且只影响投递。

- 守卫：矩阵测试（`failed × delivered`、`done × dead_letter` 两类组合必须稳定可判）。

### I9 · 自动重试只发生在投递层（MUST）

- `delivery.retry` 只重发同一结果，不重新执行；
- 执行的重跑只接受**显式 requeue**（命令 / HTTP / DSH），且只对 `failed` / `cancelled`；
- `done` 工单永不重放（防重复副作用）；
- `resume_unstarted` 只放行「admitted 且从未 begin」的子集；
- `resume_started`（Step 6）只放行「working 且当前 assignment `replaySafe === true`」的子集；
  `waiting`、`replaySafe=false`、缺字段（旧账本）一律只标记，不自动重放。

- 守卫：requeue 矩阵测试 + 启动恢复测试（默认配置下 working 一律只标记）。

### I10 · 完成是合取，不是单边（MUST）

只有 `ticket.status == done && deliveryState == delivered` 才允许任何一方标记完成。
`turn_closed`、`assignment_ended`、`[已受理]` 回执**均不构成**完成。

- 守卫：`02-STATE-MATRIX.md` §3 全矩阵表驱动测试（6 态 × 7 状态，逐格断言）。

## 4. 事件所有权

### I11 · worker 不生产投递事件（MUST）

- thread 路由下，worker 只回**信封**（必须携带 `ticketId` / `assignmentId` / `rounds` /
  `steps` / `tools`）；父进程 thread-bridge 负责 `DELIVERY_*`；
- 信封缺 ID 时父进程按 legacy 处理：自生成 ID + 一条 warn，**不得丢弃结果**。

- 守卫：worker 信封契约测试 + thread 路由集成测试（断言事件生产者）

### I12 · 事件生产端唯一（SHOULD）

每个事件类型在本进程内只有一个生产模块：

| 事件族 | 唯一生产端 |
|---|---|
| `assignment_*` | 通道执行分支 / 父进程 thread-bridge |
| `delivery_*` | channels / delivery 收口层 |
| `ticket_*` | workgraph service |
| `turn_*` | agent bootstrap/轮次收口 |
| `message_received` | flow 决策入口 |

- 守卫：事件生产者断言测试（注入 spy，按类型检查调用者模块）。

### I13 · 观测不阻断主链（MUST）

任何事件写入 / 投影计算失败只允许 `warn`，**不得**让用户回复失败。
唯一例外：`delivery_accepted` 的持久化失败不阻断发送，但该次投递必须降级为
`deliveryState=unknown`（宁可丢回执，不可丢消息）。

- 守卫：WAL 只读/不可写故障注入测试（回复仍成功）。

## 5. 频率与恢复

### I14 · `assignment_progress` 有硬上限（MUST）

每 assignment 每 500ms ≤1 条；窗口内多次采样合并为最新累计值（`coalesced=true`）。
`working` 期间不得按心跳重复发 `ticket_*`。

- 守卫：时间桩测试（1 秒内触发 10 次进度 → 事件数 ≤2）。

### I15 · 重启不猜（MUST）

- 重放只续投 **pending** 投递，不重跑执行；
- `working/waiting` **默认**降级为 `failed(interrupted)`；唯一例外见 I20
  （`resume_started=true` 且指派 `replaySafe === true` 的 working 工单）；
- 有 `accepted` 无终态 → `unknown`，不自动重投；
- 恢复探测不得调用 `send()`。

- 守卫：崩溃恢复集成测试（kill 后重启，断言无自动执行、无重复发送）。

### I20 · 重放安全是写前事实（MUST）

- 有副作用且非幂等的工具必须在**执行前**把当前 assignment 标脏
  （`replaySafe=false` + `replayUnsafeTool`）；标脏是单向锁，任何补丁不能改回 true；
- 只读（`capability.readOnly === true`）或工具显式 `idempotent === true` 不标脏；
- 标脏写盘失败 → **拒绝执行**该有副作用工具（fail-closed），不得 fail-open 继续执行；
- 恢复只认 `replaySafe === true`；字段缺失（旧账本/无执行事实）一律视为无证据；
- 会话键未知时允许保守地标脏全部在途指派；有明确会话键时不得污染其它会话。

- 守卫：`test/workgraph-step6.test.js`（单向锁 / 写前标脏 / fail-closed / 旧账本 / 默认关闭）。

### I21 · 检查点只缓存重放安全工具且非权威（MUST）

- 只有 `capability.readOnly === true` 或 `meta.idempotent === true` 的工具结果可写入
  检查点；有副作用的调用永不记录、永不复用（与 I20 同一判定口径）；
- 检查点是旁路文件（`<dataDir>/workgraph/checkpoints/<assignmentId>.jsonl`），不是账本
  事实：缺失/损坏只导致回到从头重放，不得改变工单/指派状态；
- 复用仅在本轮续跑上下文存在时生效（`resume_checkpoint=true` 且 `resume_started=true`），
  按 `(工具, 规范化参数)` 匹配，命中后仍写入新指派检查点；轮末必须清除复用表；
- 检查点必须随工单终态清理，不得无限增长；单条结果 4KB / 每指派 500 条为硬上限；
- 默认关闭；关闭时不建目录、不写盘、不注入提示（回到 I1）。

- 守卫：`test/workgraph-step7.test.js`（默认关 / 只记安全工具 / 截断 / 终态清理 / 复用 / 提示注入）。

### I22 · 外部看门狗默认只报告，接管显式且受限（MUST）

- 外部看门狗必须能在主 agent 进程之外运行，只依赖 HTTP API 与 `fetch`，不得读取/
  修改进程内存或共享账本文件；
- 默认巡检（无显式 `act`）**不得发送任何写请求**；只有显式人工接管
  （CLI `--act cancel`）才允许取消，且单次受 `maxActions` 上限约束，不重跑、不批量清理；
- 同一工单同时命中停滞与漂移时只处置一次；接管失败必须如实记录，不得静默重试；
- 判定口径必须复用进程内看门狗的 `detectWorkerDrift`，不得另立漂移定义；
- `/api/tickets?assignments=1` 是加法式扩展：不带该参数时响应必须与扩展前一致；
- 列表/认证/网络失败返回结构化 `{ok:false, level:"crit"}`，不得抛异常吞掉。

- 守卫：`test/external-watchdog.test.js`（只报告默认 / 上限与去重 / 结构化错误 / CLI 退出码）。

### I23 · 账本后端可替换，事实语义不可变（MUST）

- 默认后端必须是 `jsonl`，且输出与抽离后端前逐字一致（`tickets.jsonl` 一行一条事实）；
- 所有后端必须产出同一组事实记录，由**同一个折叠函数**还原内存态；不得因后端不同改变
  状态机、去重、恢复或终态清理语义；
- JSONL 压缩仍用临时文件 + 原子 rename；SQLite 压缩必须在单事务内完成，失败整体回滚；
- 未知后端必须启动即报错，不得静默回落；SQLite 不可用（Node < 22.5）时显式配置也要
  给出可读错误；
- 检查点不属于账本后端：任何后端下仍是 `<dataDir>/workgraph/checkpoints/<assignmentId>.jsonl`；
- 切换后端不迁移旧数据；单写者假设不变（WAL 不承诺多进程同时写同一 dataDir）。

- 守卫：`test/workgraph-step9.test.js`（JSONL 逐字 / SQLite 往返 / 压缩等价 / 未知后端 / 坏行 / 检查点旁路）。

## 6. ANS 边界

### I16 · ANS 默认不建单（MUST）

`ans_lane.create_ticket=false`（默认）时，`origin=ans` 的主动通知**不产生**
ticket / assignment / turn 事件，不参与 DSH 完成判断，只产生投递回执
（身份用 `deliveryId`，见 I5）。

- 守卫：proactive / watchdog 触发测试（断言 workgraph 无新增）。

### I17 · ANS 不绕安全闸门（MUST）

ANS 车道与入站共用同一套权限判定、审计、钩子、审批四档；`extra_deny_tools` 只能**加严**，
不能放宽。`internal_only` 恒为 true：车道只在进程内调用，不暴露 HTTP/WS。

- 守卫：安全闸门测试（ANS 发起的高危工具调用与入站同样被拒）。

## 7. 版本与演进

### I18 · 契约版本显式（MUST）

投递契约对象携带 `version: "delivery.v1"`；事件信封携带 `schema_version: 1`。
新增可选字段 = 小版本；删除/改义 = 必须 v2 + 双读窗口（≥1 个发布周期）。

- 守卫：schema 校验测试（`01-delivery.v1.schema.json` / `04-ans-lane.schema.json` 可解析，
  且 examples 全部通过）。

### I19 · 未知枚举降级为 external（MUST）

`origin` 只允许 `ingress|ans|external|requeue`；读到未知值时按 `external` 处理并 warn 一次，
不得拒绝消息、不得崩溃。

- 守卫：畸形输入测试。

## 8. 契约违约的处理原则（MUST）

1. **不推进状态**：违约组合（矩阵 `X`）不得触发完成/失败/重试；
2. **告警限流**：每 assignment 每小时 ≤1 条；
3. **可回滚**：所有新行为都能通过配置关闭，关闭后回到 I1；
4. **可观测**：违约必须落 `data/evolve/` 或 EQ，不允许只打一行 console。

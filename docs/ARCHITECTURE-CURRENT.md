# PPXANS-Harness 架构现状 (v5.0, 2026-11-08; 结构精简 2026-11-12)

> 本文是**当前实际运行架构**的唯一权威快照, 覆盖 v2.x 基线 ([ARCHITECTURE.md](./ARCHITECTURE.md))、
> v3.0 设计稿 (ARCHITECTURE-V3.md, 2026-11-08 精简归档至 git 历史) 之后到 v4.2 的全部落地变化。
> **v4.0.0 的"五阶段装配"与不完整子系统图已过时** —— 当前装配为七段 (§2), 并新增
> 工单账本 / 分层意图漏斗 / 多协议适配 / daemon 常驻等模块 (§4)。§10 的 2026-10-30
> 热路径测试记录保留为历史基线, 数字口径不变。
> 2026-11-12 结构精简: 顶层模块 51 → 42, core 1552 → 178 行、utils 2113 → 1529 行,
> 五个 590–599 行文件按职责再拆 (见 §4 表下注)。对外行为与测试契约不变。
> 约束不变: 纯 Node ≥20、零运行时依赖、自研 OpenAI 兼容 HTTP 底座。
> 历史文档讲"为什么这么设计", 本文讲"现在长什么样、数据怎么流"。
> 第一次读这套代码建议先看 [PROJECT-OVERVIEW.md](./PROJECT-OVERVIEW.md)
> (端到端阅读地图), 再回到本文查模块细节。

## 一图总览

```
┌──────────────────────────── 接入层 ──────────────────────────────┐
│ Web UI(webapp/dist)  CLI(src/cli.js)  飞书  微信  log   workspace    │
│ daemon(常驻 headless)            MCP 服务端(ppx mcp serve)        │
└───────────────┬──────────────────────────────────────────────────┘
                │ HTTP: 静态资源 / /api/* / SSE(/events) /message/stream /mcp
┌───────────────▼──────────────────────────────────────────────────┐
│ flow/ · 入站决策内核: Trigger 归一 → 两级准入 → 建单/去重    │
│        → 话题直通 / 异步 / 同步 (纯决策, 不发送)             │
├──────────────────────────────────────────────────────────────────┤
│ channels/ · ChannelManager: 通道注册 + 传输 + 发送            │
│   handleTrigger → planIngress(plan) → 执行分支 → workgraph 收口    │
│   delivery WAL: 异步结果回投(失败重试/抖退/死信/幂等)              │
├──────────────────────────────────────────────────────────────────┤
│ channels/http.js — Web 后端 + token 鉴权 + 限幅 + 路由            │
├──────────────────────────────────────────────────────────────────┤
│ protocol/ — SQ 提交队列 + EQ 事件流(WAL) + TurnProjection          │
│   事件：TURN_* / TOOL_* / APPROVAL_* / TASK_* / ticket_*          │
├──────────────────────────────────────────────────────────────────┤
│                    PPXAgent 内核 (src/agent/)                     │
│  七段装配 (§2) · chat/chatStream · 工具循环/多 provider 回退链     │
│  意图漏斗 L1 规则 → L2 上下文提示 → L3 工具循环 (src/intent/)      │
│  ┌──────────┬──────────┬──────────┬──────────┬─────────────┐     │
│  │ 记忆五层  │ 治理四件  │ 模式注册  │ 军团+DAG  │ 工单账本     │     │
│  │ memory/  │permissions│ agent/   │orchestr. │ workgraph/  │     │
│  │          │          │ modes/   │          │             │     │
│  └──────────┴──────────┴──────────┴──────────┴─────────────┘     │
├──────────────────────────────────────────────────────────────────┤
│ llm/ — 多协议客户端: openai-completions / openai-responses /       │
│        anthropic-messages · 多 provider 回退 · 思考强度注入        │
└───────────────┬──────────────────────────────────────────────────┘
                │ (旁路闭环, fire-and-forget)
┌───────────────▼──────────────────────────────────────────────────┐
│ ANS 自治: 免疫闸门 / Reward / 驱逐 / 生命周期 / proactive / watchdog│
│ 进化体系: EvolutionEngine(行为) · SelfIterationEngine(代码)        │
│           EvolutionLoop(每日编排) · journal.jsonl(度量)            │
└──────────────────────────────────────────────────────────────────┘
```

## 1. 进程与入口链

> 2026-11-08 起只有一个 bin: `bin/ppx.js` (薄壳, 逻辑在 `src/cli.js`)。此前的
> ppx-serve / ppx-web / ppx-channels / ppx-daemon / ppx-setup / ppx-mcp 六个入口
> 全部改为 `ppx <子命令>`; `package.json` 只发布 `ppx` / `ppxans`。

| 入口 | 命令 | 链路 |
|---|---|---|
| 桌面客户端 | `npm start` → `scripts/desktop-start.mjs` → `electron/main.js` → 子进程 `ppx web --no-open` | 子进程以 `ELECTRON_RUN_AS_NODE` 拉起 `bin/ppx.js web` (端口/工作副本经参数传入) → `src/server.js startServer()` → `new PPXAgent()` + `ChannelManager(agent)` → http 通道挂回环端口 (对用户不可见); 通道就绪后可执行工单安全自动恢复 (§3) |
| 交互对话 | `ppx` (无子命令) / `npm run chat` | `src/cli.js` REPL (15 条内置斜杠命令 + `.ppx/commands` 用户命令), 直接驱动 agent, 不启通道 |
| 单次问答 | `ppx "今天几号"` | 同一条 CLI 的一发即走模式 |
| 通道管理 | `ppx channels <list\|add\|test\|enable\|disable\|remove>` | 配置/测试/启停飞书/微信等通道 (写 `config/ppx.json`, 备份+原子写); 运行期通道由 `startServer()` 的 `ChannelManager` 承载 |
| 常驻 daemon | `ppx daemon start/status/stop` | 脱管 headless 服务 (计算常驻本机, UI/IM 经 HTTP attach); 日志 `data/ppx-daemon.log`, 同样走 `startServer()` |
| MCP 服务端 | `ppx mcp serve` / `npm run mcp:serve` | 对外暴露标准 MCP 工具面 (走 `_admitToolCall` 同一准入链, 不绕过权限) |
| 手动进化 | `npm run evolve:loop` | `scripts/evolution-loop.js` 独立起一个 agent 跑一轮 (见 §6) |
| 配置/体检/更新 | `ppx setup` / `ppx doctor` / `ppx update` | 引导配置、离线自检、显式版本检查 |

启动横切件: `winutf8`(控制台 UTF-8) → `crashguard`(崩溃残留自检) → banner。HTTP 鉴权 token 持久化在 `data/http-token` (重启不换)。

## 2. Agent 装配七阶段 (`src/agent/index.js` 构造器)

| # | 阶段 | 做什么 |
|---|---|---|
| 1 | **`_initPluginContainer`** | 一切皆插件: 建 `Context` 容器 (`provide/consume`), 按序 `compose` 内置插件 + v3 插件 + 用户插件目录 (`config.plugins.dir`) + 构造参数插件; 用户插件只能覆盖可替换接缝 |
| 2 | **`_bindServices`** | 从容器 consume 成公开属性 (`llm/allProviders/auxLLM/facts/memory/sessions/tools/permissions/commands/protocolBus/failures/audit`…); 挂能力门; `_installUsageTracking()` 零侵入包装 provider 的 `chat/apiChat/streamChat/apiChatStream` (记账 + 预算闸门); 恢复 usage 累计账本; 审批/plan 会话态 |
| 3 | **`_wireANS`** | 免疫闸门同时盖总线命令与工具收口; Reward EWMA 订阅 `tool/result`; 工具失败写故障病历; 驱逐扫描 (Scheduler 幂等注册 + 首启预热); 缺 Key 引导 |
| 4 | **`_initTurnState`** | 单轮运行态: 通知/工具/step 回调、`_interrupted`、按会话的中断句柄/草稿桶/重定向/互斥锁; **TurnProjection** (Session→Task→Turn) 随轮更新 |
| 5 | **`_initEngines`** | 生命周期 (持久化)、EvolutionEngine、Auditor (已验证写回账本)、多根 SkillLoader + SkillRegistry、专家包目录 |
| 6 | **`_initServices`** | MemoryService / LearningService (注入式, aux 模型路由); 跨轮 WorkStack; **WorkGraph** (store + service + 启动恢复 + 安全恢复队列); **意图漏斗** (IntentFunnelState + L1 规则表 + 按会话 L2 提示块) |
| 7 | **`_initStartup`** | 应用禁用工具与 `tool_exposure` (all/core)、MCP 自动连接 (非阻塞)、首次画像、每日进化循环 |

热重载: `reloadProviders()` 重建 LLM 客户端后**必须**重装 usage 包装 (2026-10-30 修复, 此前切模型后统计失明); `reloadSettings()` 只刷内存不重建客户端。

## 3. 对话主链路 (流式) 与入站工单

```
POST /message/stream {message, sessionId, permission}
  → channels/http.js 鉴权/读取 → ChannelManager.handleTrigger()
    → flow.planIngress() 纯决策: 准入 → 建单/去重 → 直通/异步/同步
        · drop      准入拒绝 / 空文本
        · replay    已完成工单 → 重发缓存结果
        · duplicate 在途工单 → 直接返回受理态
        · thread    已驻派 worker → ThreadBridge 直通
        · async     先回执, 结果经 delivery 回投
        · sync      同步执行并回复
    → workgraph.submit() 建工单 → begin() 建指派
  → 意图漏斗 (config.agent.intent_funnel, 默认开):
      L1 规则高置信 → 直答/转工具 (零模型调用)
      L2 纯函数打分 → 「分流提示块」注入本轮 user 尾部 (提示不接管决策)
      L3 → agent.chatStream()
        → supportsStream? 逐字流 (无工具 streamChat / 有工具 apiChatStream 工具循环)
          失败 → policy 兜底降级非流式 chat
    → workgraph.complete/fail() 收口工单 (终态不被迟到回调覆盖)
  → SSE 事件流 (前端 webapp 消费: `webapp/src/api/sse.js` 解析 /message/stream,
     全局 Events 走 `webapp/src/stores/events.js`):
     delta   正文增量           → renderMd 累积渲染
     step    第 N/M 轮推理      → 轮次提示 + 统计条 rounds
     tool    工具 start/finish  → 工具卡片 + 统计条 steps
     done    {content, tokens}  → 终稿; tokens{prompt,completion,cacheHit,cacheHitPct}
     approval / plan / diff / error → 对应事件卡片
```

异步与直通链路: `chatAsync()` 立即回执, 后台走同一条 `chat()` (同会话互斥/合并车道), 结果经
`delivery` WAL 回投原话题; 长驻 worker 话题经 `ThreadBridge` 直通, 后续同会话消息不再进 Router LLM。
六条入站路径 (同步 / 异步 / 话题直通 / 异常 / 微信被动回包 / Web UI) 加 `spawn_agent` (TUI 网关 2026-11-08 退役)
委派共用同一张工单事实 (2026-11-05 收口, 直连路径共用 `flow/worklink.js`); 重启后默认只标记中断,
可选只自动恢复 admitted 且从未执行的子集 (见 [WORK-GRAPH.md](./WORK-GRAPH.md))。

usage 事实链 (2026-10-30 修复后): `streamChat/apiChatStream` 请求带 `stream_options.include_usage` 并解析收尾 chunk → 客户端实例 `__ppxStreamUsage` → 记账包装读入 `agent.lastUsage` → done 事件 `_usageSnapshot()` 透传前端。纯文本聊天此前完全无 usage, 统计条永远空 —— 已修。

## 4. 子系统地图 (src/)

| 目录 | 职责 | 代表文件 |
|---|---|---|
| `agent/` | 内核编排: 七段装配 / 主循环 / 回退链 / 记忆接线 / 工单与线程 API; 工具循环 (`loop/`) 与模式注册 (`modes/`) 随内核 | index.js (+ context/prompt/evidence mixins), agent-worker.js, loop/tool-loop.js, modes/index.js |
| `core/` | 跨层基础: 错误语义 / 自检 / 追踪 / **run 血缘** (2026-11-13: runId 唯一来源 = 当前 traceId, 跨进程走 `PPX_PARENT_RUN_ID`) | errors.js, selfcheck.js, trace.js, run-context.js |
| `verify/` | **验证域** (`L2`, 2026-11-12 从 core 迁出): 回合后置条件闸门 / 声称核对 / 路径证据 / 分级审查 | postcondition.js, claims.js, path-evidence.js, review.js |
| `boot/` | **入口外壳** (`L0`, 2026-11-12 从 utils 迁出): 控制台 UTF-8 / 启动横幅 / 崩溃兜底 | winutf8.js, banner.js, crashguard.js |
| `llm/` | 多协议客户端: `openai-completions` / `openai-responses` / `anthropic-messages` (`adapters/`, 每个适配器一文件 + 共用 wire 工具); 多 provider 回退、思考强度注入 (`_thinkParams`)、fence、定价 | client.js, protocol.js, adapters/*.js, providers.js, router.js |
| `protocol/` | SQ 提交队列 + EQ 事件流 (WAL) + Turn 模型与投影; `ticket_*` 事件与 `ticketId` 引用键; 内存历史有界 (默认 5000, 更早按需从 WAL 回补); **WAL 按 8MB 轮转, 默认保留 24 个归档段, 回放新到旧有界读取** | index.js |
| `session/` | Session→Task→Turn 状态机 + 回合投影 + 跨轮任务栈 + 回合内计划 + 任务指针 (pwf) | turn.js, projection.js, workstack.js, plan-live.js, pwf.js |
| `memory/` | 五层记忆: FactStore(L1) / Experience(L2) / session 日志 / MemoryTicker / 驱逐+生命周期 / 人格画像; **多源召回契约** (RRF 融合 + 每条带来源证据; 2026-11-16 起由 `memory_search.multi_source` 消费) 与 **压缩引擎** (start/summary/end 事件 + 会话锁) | fact-store.js, retrieval.js, compact-engine.js, memory-ticker.js, session.js, persona.js |
| `permissions/` | 能力门 + 审批流 (approval 卡片) + plan 模式 | — |
| `hooks/` | 七类生命周期钩子链 (PreToolUse/PostToolUse/PreCompact/PostCompact/Session*/SubagentStop) | index.js |
| `bus/` | 运行时总线 + 熔断器 | circuit-breaker.js |
| `security/` | deny 规则 / PII 回复掩码 / 沙箱 / **出站 HTTP 代理守卫** (SSRF/凭证剥离/体积上限, 2026-11-12 从 utils 迁入) | http-proxy.js |
| `audit/` | SHA-256 审计哈希链 + 验证 + 已验证写回账本 | audit-chain.js |
| `seam/` | 可替换接缝注册表 (shell 等) | — |
| `edit/` | SEARCH/REPLACE 编辑块解析 + 快照 + **内容锚点编辑** (行哈希 → 改行/改段, stale 与歧义都拒绝) | editblock.js, snapshot.js, anchors.js |
| `evidence/` `repomap/` | 证据入上下文 / 仓库地图 + 知识页生成 (`wiki.js`) | repomap/wiki.js |
| `selfcode/` | 自改与自审: `self_edit` 引擎 (补丁→备份→落盘→语法+测试→绿留红滚→账本); 静态依赖图 (`graph.js`) + 确定性自审 (`audit.js`: 死代码/环/断链/巨石/静默 catch → 0–100 评分) | engine.js, graph.js, audit.js |
| `evolve/` | **SelfIterationEngine (代码自改进)** + **EvolutionLoop (每日编排)** + playbook/delta + **效果闭环** (`effect.js` cohort 前后对照) + **权重级学习桥** (`finetune-bridge.js`: 导出→外部微调→版本账本→cohort 回归, 训练本体在架构外) + **自愈引擎** (崩溃残留清理/健康探测, 2026-11-12 从 selfheal/ 并入) | selfiterate.js, loop.js, effect.js, finetune-bridge.js, healer.js |
| `ans/` | ANS 自治: guard / reward / eviction / lifecycle / proactive / watchdog / boundary / values; EvolutionaryEngine(行为学习) 在 `evolve/trigger.js` | watchdog.js |
| `intent/` | **分层漏斗意图识别** (v4.2): L1 规则 / L2 上下文打分 / 层流量统计持久化 | funnel.js, state.js |
| `flow/` | **原生入站流** (v4.2): Trigger 归一 / 两级准入 / 六动作决策内核 (`planIngress`), 纯决策不发送; **元认知门控** (2026-11-15): 执行前一次轻量 LLM 打分 `{confidence, rationale, suggested_action}`, 规则三 (2026-11-16, opt-in) 低置信且建议 clarify 时改道提问而非执行 | trigger.js, policy.js, kernel.js, gate.js |
| `workgraph/` | **工单账本** (2026-11-02): append-only JSONL + 折叠 / 工单→指派状态机 / 去重 / 恢复标记 / 安全自动恢复 / **runId 血缘** (2026-11-16 贯通 trace/审计/事件); 快照规整在 `snapshots.js` | store.js, service.js, snapshots.js |
| `worldmodel/` | **文件域世界模型** (2026-11-15): 最小可干预模拟本体 `seed/step/snapshot/restore/diff/journal/replay`, 外部本地 HTTP 服务形态 (127.0.0.1); `exec` 步骤 (2026-11-16) 用保守命令解析推演 rm/mv/cp/mkdir/touch/truncate/dd/cd —— 含通配符/变量/管道/子 shell 的命令**明确返回 simulated:false**, 不拿半模拟当安全网 | index.js, server.js |
| `skills/` | 多根技能加载 (项目 > 用户 > 内置) + 注册表 + 覆盖率 | loader.js |
| `orchestrator/` | 军团 spawn_agent 多进程 + DAG + SQUAD/experts + ThreadBridge 话题直通 + 治理 | legion.js, dag.js, thread-bridge.js |
| `tools/` | 工具目录 (capabilities + riskLevel + 审批 + 曝光 + **永久隐藏**); **意图门面** (15 个 action 入口收编 64 个长尾); 检索/代码事实/常驻 shell: `grep`(rg→git→内置三级) `lsp`(JSON-RPC) `shell`(常驻 bash) `edit_lines`(锚点) | index.js, catalog.js, facade.js, grep.js, lsp.js, shell-session.js, anchored-edit.js, builtin.js |
| `mcp/` | MCP 客户端 (stdio/http, namespace) | — |
| `channels/` | ChannelManager + http / feishu / wechat(+crypto) / log / workspace; 传输与发送; delivery outbox (WAL/抖动/死信/幂等); SSE 心跳/退订、静态与 `/uploads/*` 共用 ETag/304 + 有界缓存、桌面优雅退出端点 | base.js, delivery.js, http.js |
| `web/` | 本体形态 API (bot-api / bot-store / plugin-api / usage-stats) | — |
| `services/` | 记忆/学习服务、daemon 控制、诊断、triage、记忆健康、版本检查更新、桌面偏好/诊断 | memory-service.js, daemon-control.js, update.js, desktop/prefs.js |
| `config/` | 配置加载/白名单读写/设置迁移 | index.js, settings.js |
| `plugin/` | 纯 L0 DI 容器 (Context/compose/loadPlugins); 装配器 2026-11-08 归位 agent/plugins/ | context.js, index.js |

> 2026-11-13 架构优化 (5.2.0): **没有新增顶层模块** —— 十个改动全部落在既有目录内 (core / memory /
> edit / tools / agent), 因为"新增目录"本身就是这次要治的病。模块数仍 42, 依赖边 130 → 132
> (新增 `tools → core/run-context` 与 `orchestrator → core/run-context`, 均为向下依赖)。
> 十项改动的论证与证据: [ARCHITECTURE-OPTIMIZATION-2026-11.md](ARCHITECTURE-OPTIMIZATION-2026-11.md)。

> 2026-11-12 碎片收敛: 顶层模块 51 → 42。`persona→memory` / `wiki→repomap` / `review→verify` /
> `commands→agent/command-registry.js` / `selfheal→evolve` / `mode→agent/modes` / `planning→session` /
> `update→services` / `desktop→services/desktop` —— 单文件模块不再各占一个顶层目录。

### 4.1 工具循环可靠性 (2026-11-02)

- **按需曝光默认 `core`**: 只下发约 34 个主干工具 schema, 其余只留名字; `tool_schema(name)`
  取过参数后由 `catalog.expose()` 加入 `_dynamicExposed`, `runToolLoop` 每轮用 getter 重取
  `tools` → **下一轮立即生效**, 不必重复取 schema。MCP 工具 (`category:"mcp"`) 豁免收窄
  (连接即用户显式配置, 不应再被藏一层)。
- **参数不静默吞**: tool_call 的 `arguments` 非法 JSON / 非对象不再退化成 `{}` 执行,
  统一返回可行动错误 (截断预览 + 正确用法), 作为 tool 消息回给模型重试 (`parseToolArguments`)。
- **长任务不占轮次 (2026-11-13)**: `run_background` 启动即返回 job id, 输出落
  `dataDir/jobs/<id>.log`; `job` 负责 status/output/list/kill。启动前仍过命令守卫/会话脚本/
  包清单三道闸门, 进程退出统一终止; 单文件 10MB 封顶。
- **未知工具给近邻**: 名字打错时按编辑距离 + 子串给 2 个候选, 而不是只说"未知工具"。
- **执行纪律进 system**: 取证优先 / 小步并行 / 读错误再改 / 连续失败两次换路 / 写入必验 / 结论带证据。

## 5. Web UI (`webapp/`, Vue 3 + Vite)

- **构建与托管**: 源码在 `webapp/src` (Vue SFC), `npm run web:build` 产出 `webapp/dist` (入库,
  `npm ci` 后可直接跑); http 通道优先托管 dist, 找不到 `dist/index.html` 才回退旧 `public/`
  (`src/channels/http.js` 构造器)。`webapp/public/` 只放原样拷贝资源 (favicon、首屏主题脚本 `theme.js`)。
- **外壳** (`App.vue`): 侧栏 `layout/SideRail.vue` + 主区 + 抽屉 `layout/Drawer.vue` + 全局弹层。
  一级导航只有 **对话 / 项目 / 任务 / 能力** 四项, 由 `stores/ui.js` 的 `ROUTES` 路由表驱动
  (`group:"main"` 进侧栏, `group:"more"` 收进能力页第二层); 设置/运行状态/技能/插件/MCP/统计
  等视图全部 `defineAsyncComponent` 按需加载 —— 首屏只带对话 + 外壳, 其余各自成 chunk。
- **界面文案**: `i18n/lexicon.js` 是用户可见文案的唯一出口 (内部叫法 本体/空间/工单/身体/轨迹/
  姿态/生命周期 → 助手/项目/任务/运行状态/执行过程/工作模式/运行阶段); `scripts/lexicon-check.js`
  在 `npm run verify` 里扫源码, 任何内部词漏进界面即红 (`lexicon-ok(date): 理由` 为唯一例外)。
- **首用与报错**: 引导第 2 步只问模型名称 + API Key, `stores/model-preset.js` 按模型名前缀识别
  厂商接口与协议 (认不出才要求手填, 探测失败如实回报, 可跳过); `stores/errors.js` 把错误分
  self-heal / action / report 三级并给下一步, 原文仍保留在错误卡片。
- **对话** (`chat/ChatView.vue`): `Timeline` (用户/agent/工具卡/审批卡/计划卡/diff 卡/提问卡) +
  `Composer` (20px 圆角浮起卡, 左 `+` 附件、右模型+思考强度座椅) + `Hero` 空态 +
  `TracePane` 轨迹页签。事件由 `api/sse.js` 逐帧解析 `/message/stream`
  (delta/reasoning/tool/step/done/approval/question/plan/diff/error), 进程级事件由
  `stores/events.js` 订阅 `/events`。
- **状态**: `stores/` 按域拆分 (chat / bot / panels / settings / theme / toast / rail …),
  组件不各自另存一份业务状态; 抽屉里的文件树/目标看板/审查报告/工单账本与 `/work`、`/api/tickets` 同源。
- **键盘**: Esc 语义链 (站内弹窗 → 目录 → 文件预览 → 命令面板 → 设置 → 模型/权限浮层 →
  跳过提问 → 拒绝审批 → 停止生成); Ctrl+O 展开/收起全部工具结果; 审批卡 1/2 批准/拒绝。
- **门禁**: `npm run web:check` (`scripts/check-web.mjs`) —— 要求 dist 存在, 在**构建产物**上
  断言 CSP 无内联可执行脚本, 在组件源码里校验图标/资源引用与结构锚点 id (Electron 菜单和冒烟
  脚本依赖这批 id), 外加关键 CSS 类。

## 6. 进化体系 (自主变强闭环)

```
工具轨迹 (traces) ──┐
故障病历 (failures) ─┤→ EvolutionEngine (evolve/trigger.js)
                     │    每 N 次调用: refine 失败→经验 · refineSkill 重复成功→技能
                     │
EvolutionLoop (evolve/loop.js, 每日 cron, 默认 03:30):
  Phase0 audit  静态结构自审 (selfcode/audit.js): 环/断链/死代码/巨石/静默 catch → 0–100 分
                周期记录带 audit 快照 → journal 可画"结构健康趋势" (2026-11-02)
  Phase1 learn  弱点聚类 (同类病历≥3 定向 refine) + 常规提炼
  Phase2 iterate SelfIterationEngine: 跑 target_files 适应度测试
                红了才动手: LLM 诊断 → SEARCH/REPLACE → 备份→落盘→重验 → 绿留/红整体回滚
                护栏: 单飞锁 · 每轮 max_files · max_llm_calls(6) · allow_test_edit=false
  Phase3 journal data/evolve/journal.jsonl 每轮一条 (能力快照 + 审计分可画曲线)
  Phase3.5 effect 蒸馏效果对照 (evolve/effect.js, 只读): 每个 skill cohort 的域内成功率
                基线 vs 产出后窗口 → delta; 轨迹不足标 immature, 不给结论 (防小样本误导)
                cross-task 层: 轨迹按 assignments 时间窗继承确定性 taskType 再分桶 (不用模型分类)
  Phase3.6 feedback 效果反哺 (2026-11-16, opt-in, **唯一写行为的段**):
                mature 且 delta ≤ -degrade_threshold 的 cohort → 给关联 bullet 记 harmful 票
                (关联规则: playbook 走词法相似度 ≥ relate_threshold, lesson 走 tags/task 确定性包含)
                → 达 prune_at 由 growAndRefine 淘汰; 幂等靠 cohort.fedBackAt, 单轮限 max_actions
                默认关闭 (agent.evolution_loop.effect_feedback.enabled), 关闭时零写入
self_audit  — 只读自审工具 (对话内主动找优化目标; 与 Phase0 同一实现, 数字可复现)
self_edit   — 对话内改自己源码, 双门: 工具参数 mode=apply + config
self_verify — 只读验证: 语法关 + 指定测试, 不改文件
self_rewind — 按账本 id 回滚到任意历史版本
```

**为什么 3.5 与 3.6 必须成对** (2026-11-16): 3.5 单独存在时, 系统能测出"这条策略没用"
却照旧按它跑 —— 测量变成仪表盘, 这是"持续学习"名不副实的最典型形态。3.6 把结论变成
动作, 且**动作只有一种语义**: 记有害票。淘汰交给既有 `growAndRefine` 阈值, 不在这里
直接 REMOVE —— 留着可回滚的余地, 也避免"一次错误测量直接删掉一条好策略"。
三重门槛 (mature + delta ≤ -阈值 + 未反哺过) 是防误杀的主要机制, 不是回归门禁
(门禁守"新增策略有没有害", 这里管"已证有害的策略退场", 方向相反)。

**静态结构事实源** (`selfcode/graph.js`, 2026-11-02): import/require/动态 import 解析 →
文件级依赖图; 入口可达性 → 区分 `reserved` (有测试、预留) 与 `unwired` (死代码候选);
反向影响 → 自改前自动选相关测试 (`self_edit` 的 impact 分析)。`self_audit` 工具、每日 Phase0
审计与自改影响分析共用这一份图, 各写一套解析器的旧账已清。分层/依赖环/内核行数另由
`node scripts/arch-guard.js --check` 门禁 —— 它只做硬性约束 (失败即拦), 不替自审打分。

**闸门现状 (config/ppx.json `agent.*`, 2026-10-30 全部打开)**:

| 键 | 值 | 控制点 |
|---|---|---|
| `self_code.mode` | `apply` | 对话内 self_edit 落盘许可 (双门之一) |
| `self_iteration.mode` | `apply` | 每日循环代码自改进的写盘许可 (**独立于 self_code 的第二把锁**) |
| `self_iteration.target_files` | 17 个适应度测试 | 循环的"健康定义"——只对跑挂的测试出手 |
| `evolve.enabled` | `true` | 行为学习引擎 (默认即开, 显式声明) |
| `evolution_loop.enabled/cron` | `true` / `03:30` | 每日编排定时任务 |
| `evolution_loop.effect_feedback.enabled` | `false` (2026-11-16 新增) | 效果反哺: 测出退化后给关联策略记有害票, 达阈值淘汰。默认关 —— 先要有可信的测量再开动作 |
| `agent.metacognition_gate.enabled` | `false` (2026-11-15 新增) | 执行前置信度观测 (一次轻量 LLM 调用); 关闭时零 LLM 调用零写入 |
| `memory.adaptive_budget` | `true` (2026-11-16 新增) | 历史预算消费全局配额规划: 放得下保持 legacy, 放不下收到 `窗口−output−tools−system−记忆预留`; `false` 回退旧公式 |
| `agent.metacognition_gate.reroute_enabled` | `false` (2026-11-16 新增) | 规则三: 低置信且建议 clarify 时**不执行**, 改为向来源方提问; 工单判 MANUAL_REVIEW (改道不算完成) |
| `agent.tool_exposure` | `core` (2026-11-02 起) | `core` = 31 个主干工具下发完整 schema, 其余按需; `all` = 全量; 数组 = 自定义名单 |

**适应度集选取原则** (2026-10-30 定): 文件必须 ①单跑全绿 ②**无 `--test-force-exit` 也能干净退出** (进化引擎裸跑 node --test)。全套 253 个测试文件中有遗留句柄泄漏的会挂住 → 对假失败烧 LLM 预算, 故只收录验证过的文件。当前 17 个覆盖: agent 核心 / 错误语义 / llm fence / 进化体系自身 / 记忆 / PII 安全 / 上下文裁剪 / 工具 / 重试 / 熔断 / 会话 / 自愈 / 配置 / 渠道。

## 7. 配置与事实源

- **唯一配置事实源 = `config/ppx.json`**: providers / channels / security / agent / llm / voice / tools。`src/config/settings.js` 白名单化读写 (备份→原子写→文件锁), `/api/settings`、`/api/llm` (POST provider/reasoning 热重载) 都走它。
- ⚠️ **多实例共写**: 多个 PPX 实例 (如常驻生产实例 + 测试实例) 共享同一份 `config/ppx.json`, `llm.reasoning` 等字段最后写者赢 —— 看到"配置和界面不一致"先查是否另一个实例写的, 不是 bug。
- API Key 走 `api_key_env` 环境变量引用, 配置文件里不落明文。

**运行期事实落盘 (均在 `data/`, 除特别说明)**:

| 文件 | 内容 | 重建方式 |
|---|---|---|
| `workgraph/tickets.jsonl` | 工单 + 指派 append-only 账本 | 日志即真相; 超行数压缩为等价快照 |
| `protocol/eq.wal.jsonl` + `eq.wal.<stamp>-<pid>-<n>.jsonl` | 活跃 EQ 事件 + 8MB 轮转归档段 (默认留 24 段) | 事件回放; 会话真源仍在 sessions/ |
| `channels/delivery.wal.jsonl` | 主动投递/重跑回投的待投队列 (重试/TTL) | 启动 replay 续投 |
| `channels/delivery.dead.jsonl` | 终态失败死信 (完整正文/元数据/原因) | 只追加, 人工追查 |
| `intent-state.json` / `intent-stats.json` | 漏斗会话态 + 三层流量统计 | 可重建统计 |
| `usage-stats.json` | 累计调用/token/缓存命中 | 累计账本, 重启恢复 |
| 会话 JSONL (`sessions/*.jsonl`, 按天分片) | 对话原文/事件 | 会话唯一事实源 |

**会话写盘模式 (2026-11-02)**: 生产装配默认 `SessionStore({ writeBehind: true })` ——
普通 append/flush 合并到下一 tick 每 key 写一次, 内存日志先写、读路径不变; 压缩/重建等强顺序路径
用 `flush(key, { sync: true })`, `agent.shutdown()` / 插件 dispose / `process.once("exit")` 用
`flushAll({ sync: true })` 收口。崩溃窗口最多一个 tick; **不是**并行 I/O, 异步锁重写仍未做。

## 8. 测试与质量门

- **1957 项测试** (1953 通过 / 4 跳过), `npm test` 带 `--test-force-exit`
  (有历史测试留句柄, 见 §9; 逐个治理中)。数字以 `scripts/readme-sync-check.js --with-tests`
  的实测为准, README 顶部机读锚点与本文同步。
- `npm run web:check` 前端静态自检; `npm run verify` 聚合校验; `npm run lint` ESLint;
  `npm run desktop:smoke` 真实 Electron 窗口 DOM/API 冒烟 (未装 Electron 时 SKIP);
  `npm run evolve:loop -- --status` 进化报告。
- **架构守卫** (`node scripts/arch-guard.js --check`): 顶层模块分层 L0–L4 + 依赖环 + 新增越层
  + 内核行数预算。2026-11-16 实测 **43 个模块 / 136 条边 / 0 环 / 0 越层**; 内核预算同步收紧为
  core 400 / plugin 320 / utils 1650 / config 1400 行 (当前分别 178 / 266 / 1529 / 1357)。
- **自研溯源守卫** (`node scripts/native-guard.js`): 禁止上游 import / vendored 源码标记;
  22 个设计来源逐一登记到 `config/native-provenance.json` 与 [PROVENANCE.md](./PROVENANCE.md),
  每个来源必须至少有一个真实存在的原生模块落点。当前 0 违规。
- 2026-10-30 修复的 4 个句柄泄漏: `absorb.hermes` (Scheduler 读真实 data 目录重排定时器 → 改临时目录+shutdown)、`memory-query` / `context-eng-optimize` / `pii-reply-mask` (构造完整 PPXAgent 不 shutdown → 补 `finally { await a.shutdown(); }`)。修完后这 4 个从"挂住"变成可用适应度。

## 9. 已知约束 / 注意事项

1. 全量 `node --test test/` 裸跑可能挂住 (历史句柄泄漏未清零) — 全量回归必须走 `npm test` (force-exit); 适应度集只收干净文件。
2. 双实例共写配置见 §7; **同一 `dataDir` 也不支持多进程同时写** (工单账本/会话/WAL 均按单写者假设)。
3. Web UI 统计条依赖 provider 配置 `context_window`, 未配置时第三段 (占用%) 自动隐藏。
4. `evolve:loop` 不带参数 = 用 config 目标 (2026-10-30 修复 `[]` 短路); 带文件参数则覆盖。
5. **工单恢复默认不重跑**。`resume_unstarted` 只放行 admitted 且从未 `begin` 的子集 (默认 6h / 3 条),
   `working/waiting` 一律标记中断, 需 `/work requeue` 人工确认 —— 自动化的边界停在"没有执行事实"。
6. **意图漏斗 L2 是提示不是决策**。提示块按会话键隔离并在轮末回收; 它只影响模型看到的本轮 user
   尾部, 不改变工具权限/审批/plan 模式。L1 规则表做减法, 用户扩展上限 64 条。
7. **设计来源只做思想对照**。任何新增的"借鉴"必须先在 `config/native-provenance.json` 登记来源、
   原生模块与改造点, 并在 [PROVENANCE.md](./PROVENANCE.md) 落条目; 禁止直接 import/vendor 上游源码。
   `native-guard` 是这条约束的执行者, 不是文档装饰。
7. **上下文预算**: 2026-11-02 起默认 `tool_exposure=core` —— 裸装配固定开销实测
   **5881 tok/请求** (31 个核心 schema), 比全量曝光省约 60%; 全量模式仍可 `"all"`。
   预算账目在 `scripts/ctx-profile.js`, 超预算 `--check` 会红。
8. **EQ 内存有界、WAL 分段归档**: 内存只留最近 `maxEvents` (默认 5000) 条, 更早的 `since`
   从 WAL 回补; WAL 满 8MB 轮转为 `eq.wal.<stamp>-<pid>-<n>.jsonl`, 默认保留最近 24 段
   (`PPX_EQ_WAL_MAX_BYTES` / `PPX_EQ_WAL_KEEP`, 0 = 关闭轮转 / 不限保留)。回放从最新段向前,
   读够 `limit` 即停。保留策略会删除过期归档段, 长期审计前先备份 `data/`; 会话历史不受影响。

---

## 10. 热路径性能基线（2026-10-30）

> §1–§9 描述 v4.2 架构现状；本节是 2026-10-30 性能优化的**实测记录**（优化项、前后数字、口径与边界），保留为历史基线。
> 历轮评审与"没做/建议"清单留档于 git 历史 (2026-11-08 精简)。

### 10.1 测什么

每轮 `agent.chat()` 的**内核固定开销**（stub LLM，零网络）：装配 system prompt、落会话事件、写记忆状态都发生在每轮，与用户问了什么无关。

### 10.2 口径（可复现，别跨机器引用绝对值）

| 项 | 值 |
|---|---|
| 工具 | `scripts/perf-hotpath.mjs`（历史测量脚本，未随源码树发布；本节数字仅作历史基线，勿跨机器引用） |
| 隔离 | `root` = 仓库根；`dataDir/globalDataDir` = `fs.mkdtempSync(os.tmpdir())`；收尾经 `cleanupTmp` 安全护栏删除 |
| 模型 | `agent.llm / allProviders / auxLLM` 全部换成本地 stub（`chat/apiChat` 固定文本），**零网络**；stub 调用 69 次、失败 0 |
| 基线（优化前） | `HEAD b90fe9f` + 还原 5 个被优化文件（`src/skills/loader.js`、`src/memory/session.js`、`src/memory/memory-ticker.js`、`src/memory/l3.js`、`skills/ppx-memory/scripts/l3.js`），在 `os.tmpdir` 的仓库快照上跑，工作树零改动 |
| 优化后 | 当日工作树 |
| 参数 | 每项 N=20，`--repeat=3`，每项取"均值最低那一轮" |
| 机器 | i7-13650HX / 20 线程 / 23.7GB / Node v26.12.1 / win32（2026-10-30） |
| 存档 | `docs/bench/hotpath-baseline-2026-10-30.json` / `hotpath-after-2026-10-30.json` |

⚠️ 测量期间可能有其它进程（队友测试）争用 CPU，**绝对 ms 只作同机前后对比**；最稳的指标是 **fs 调用次数**。

### 10.3 前后对比（mean / median）

| 指标 | 优化前 mean | 优化后 mean | 变化 | 中位数变化 |
|---|---|---|---|---|
| **chat 单轮（内核固定开销）** | **26.67 ms** | **16.51 ms** | **−38.1%** | 25.96 → 15.54（−40.1%） |
| skills.list（每轮 system prompt 都会调） | 6.48 ms | 0.80 ms | −87.7% | 6.44 → 0.75 |
| append×2 + flush（一次落轮） | 3.51 ms | 2.46 ms | −30.0% | 3.50 → 2.38 |
| recordTurn（每轮记忆写入） | 5.89 ms | 4.41 ms | −25.2% | 5.53 → 3.78 |
| agent 构造 | 28.73 ms | 26.64 ms | −7.3% | 27.93 → 26.18 |

### 10.4 fs 调用次数（最稳的证据：换掉的是 readdir，不是把工作藏起来）

chat 单轮：

| 调用 | 前 | 后 | 说明 |
|---|---|---|---|
| `readdirSync` | **88** | **0** | 技能目录扫描改为"目录 mtime 校验"，稳态零 readdir |
| `statSync` | 69.1 | 159.1 | 用 ~5µs 的 stat 换掉 ~70µs 的 readdir（+90 次 stat ≈ +0.45ms，净省 ~5.5ms） |
| `readSync` | 4.55 | 2.55 | 会话 append 的"读末 8KB"同批复用 + flush 锁内不再重复读 |
| `openSync` / `closeSync` | 9.75 | 6.85 | 同上（尾读少了一次 open/close） |
| `readFileSync` | 9.3 | 6.4 | 画像正文命中缓存 |
| `existsSync` | 10.2 | 6.2 | 非重建路径用 append 取代 exists 分支 |
| `writeFileSync` | 12.25 | 11.35 | 剩下的是事实库/usage/审计等其它写路径（不在本轮范围） |

`skills.list()` 单次：`readdirSync 80 → 0`，`statSync 67 → 147`（80 个目录 mtime 校验 + 67 个 SKILL.md 内容签名）。

### 10.5 改了什么（4 项，全部语义不变）

1. **`src/skills/loader.js` 目录扫描缓存**：记录"上次扫描 readdir 过的每个目录 mtimeMs"，下次只 stat 这批目录；全未变 → 复用索引，变了 → 重扫。SKILL.md **内容**变化仍逐文件 `stat(mtime:size)` 校验。
   - 坑与护栏：Windows/NTFS 目录 mtime 是**合并更新**的（实测新建子目录后约 7ms 内父目录 mtime 可能不更新，且目录 mtimeMs 可领先 `Date.now()` 数毫秒）。因此扫描时刻距最近目录变更 <100ms 时，本次结果标 `provisional` **永不复用**，下一次必重扫 —— "刚写完技能目录的第一次 list()"始终读真实目录。
   - 语义边界：多根 first-wins、命中 SKILL.md 不下钻、hidden/node_modules、maxDepth、异常路径（根不存在/权限失败 → 下次重扫）全部保持。
2. **`src/memory/session.js` 尾读按批次复用**：`append()` 的"乐观尾读"同批每 key 只读一次盘（缓存被 `_flush` 的 finally 夹死，`set/delete` 入口也清）；`_flush` 锁内复用 `_ensureUniqueSeq` 刚读到的盘面；非重建路径用 `appendFileSync` 取代 `existsSync? append : write`。
   - **跨进程 seq 唯一性没有削弱**：权威判定仍是 `_flush` 锁内 `_ensureUniqueSeq` **独立重读磁盘**后整批重排（没有改成读缓存、没有给 floor 绕过）。缓存过期最坏只是碰撞窗口回到优化前。
3. **`src/memory/memory-ticker.js` 状态写节流**：`recordTurn` 里纯 `turnCount` 递增改为 `turnCount % TURNS_PER_SUMMARY === 0` 才落盘；跨天 `_rollDay`、`_compileDaily_Rolling`（lastRolledDay/lastRolledSeq）、`_compactIfNeeded`、`_runRetention`、`agent.shutdown()` 一律**强制写**。
   - 游标一个都没动；`turnCount` 的消费方只有滚动归档节奏与轮次标签。崩溃最多丢 <10 次纯计数（滚动晚几轮），会话原文在 SessionStore 不受影响。
4. **`src/memory/l3.js`（+ 镜像副本）画像正文读缓存**：按 `stat(mtimeMs:size)` 命中缓存，迁移重写文件后按迁移后签名落缓存。画像被外部改写/删除后签名变化 → 立即重读；注入 system prompt 的字节不变（前缀缓存契约不受影响）。

### 10.6 伴随约束（改这几处必须同时守住）

- **镜像副本漂移守卫**（`test/skill-memory-drift.test.js`）：`src` 声明符号集 ⊆ `skills/ppx-memory/scripts/*` 副本；副本只能 `node:` 或 `./` 导入（可整目录拷走）。本轮改动刻意**不新增符号**，副本只同步内部逻辑（`session.js` 逐字节等于 src，仅 `../utils/store.js` → `./store.js`）。
- **前缀缓存契约**（`scripts/cache-audit.js`）：system prompt 静态区逐字节稳定、不得烘日期/时间戳 —— 画像读缓存只省 I/O，不碰注入内容。
- **会话即唯一事实源**：落盘优化不得让"内存有、磁盘无"成为常态 —— 节流的只有可重建计数，缓存只影响"乐观预读"。

### 10.7 本轮**没有**解决的（见 OPTIMIZATION 文档 §4/§7）

- 同步 I/O 仍是并发天花板（20 并发 stub 压测 p50 ≈360ms；顺序跑 ≈17ms/轮）。落轮写盘异步化/批量化是下一步最大收益，但涉及"崩溃丢最后几条"的语义取舍，需单独立项。
- 每轮仍有 `writeFileSync ×11` 来自事实库/usage/审计等其它写路径；本轮只动了 4 处收益最大的。

### 10.8 复现

```bash
# 历史脚本未随源码树发布；复现需从 git 历史取回 scripts/perf-hotpath.mjs
node --test --test-force-exit test/skills-scan-cache.test.js test/perf-memory-hotpath.test.js test/persona-read-cache.test.js
```

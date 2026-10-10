# PPXANS-Harness 项目说明文档

> 文档版本：v1.2　|　对应代码版本：**v2.7.1**（2026-09-17）　|　核对时间：2026-09-17
> 核对方式：全量通读 104 个源文件 + 107 个测试文件；实测跑通全量测试、内核启动冒烟、自愈基准，并**扮演用户端到端实测**
> v1.1 变更：第 6 章由"优化建议"改写为**优化执行记录**（7 项问题全部落地修复，测试 745 → 754 项）
> v1.2 变更：新增 **6.6 用户实测驱动的第二轮修复**（P1-1 / P1-2 / P2-1 / P2-2 / P2-3 五项），测试 754 → **768 项**
> 定位：以源码实测为准的系统性项目说明，非营销材料。所有数字、函数名、阈值均可回溯到具体文件。

---

## 目录

1. [项目概述](#1-项目概述)
2. [整体架构与目录划分](#2-整体架构与目录划分)
3. [核心模块与业务功能](#3-核心模块与业务功能)
4. [关键实现逻辑](#4-关键实现逻辑)
5. [技术栈与依赖配置](#5-技术栈与依赖配置)
6. [优化执行记录](#6-优化执行记录)
7. [文档变更记录](#7-文档变更记录)

---

## 1. 项目概述

### 1.1 一句话定位

**PPXANS-Harness（皮皮虾）是一个纯 Node.js 编写、零运行时依赖的自包含 Agent 内核**，把「Agent 神经系（ANS）」与「Harness 运行时」合为一体：既是一个能跑工具循环的对话引擎，也是一套带记忆分层、自我修复、自我进化、可审计治理的半自治系统。

它不是框架、不是 SDK，而是**一个完整可启动的产品**——`npm start` 起内核 + Web 界面（同进程同端口），也提供 npm 全局命令 `ppx` / `ppx-serve` / `ppx-channels`，以及 Windows 双击即用的 `.vbs` / `.bat` 启动器。

### 1.2 项目坐标

| 维度 | 事实 |
|---|---|
| 包名 / 版本 | `ppxans-harness` @ **2.7.0** |
| 许可证 | Apache-2.0 |
| 运行时 | Node.js **>= 20**（ESM，`"type": "module"`） |
| 运行时依赖 | **零**（`dependencies` 字段不存在，仅用 Node 内置模块） |
| 源码规模 | 103 个文件 / **14,930 行** JS |
| 测试规模 | 107 个测试文件 / **10,940 行**；**768 项 / 764 通过 / 0 失败 / 4 跳过**（约 6 秒） |
| 内置工具 | **43 项**（内核实例实测注册并启用数） |
| 内置插件 | **13 个**（按依赖顺序装配） |
| 编排模式 | **7 种**（react / single / plan-exec / router / blackboard / graph / legion） |
| 记忆层级 | **5 层**（L0 原始对话 → L1 原子事实 → L2 场景 → L3 画像 → L4 程序性记忆） |
| 对外协议 | **标准 MCP 服务端**（`POST /mcp`，Streamable HTTP，双 era）+ MCP 客户端 + HTTP + 飞书 + 微信 |

### 1.3 项目来源与演进

本仓库由两条线合并而成，并在 v2.5.0 起主动**剥离全部外部引擎**：

| 版本 | 里程碑 |
|---|---|
| `ppx-agent v1.6.0` | 合并基座：Agent 引擎、工具循环、记忆分层、自愈 |
| `ppx-v2 v0.4.0` | 能力吸收：审计哈希链、记忆治理、L4 程序性记忆、10 个治理工具 |
| `v2.0.0` | 两线合并为 PPXANS-Harness，拆解 `agent/index.js` 上帝文件 |
| `v2.4.0` | P0–P3 框架落地：治理内核、进化内核、记忆画布、supervisor |
| `v2.5.0` | **独立底座**：移除 `openclaw` / `dsh` 外部引擎底座与 `_optional_engines` 配置，只保留自研 HTTP 直连 |
| `v2.6.0` | **MCP 优先**：MCP 服务端落地，Web 壳全面切 MCP，REST `/api/*` 退役 |
| `v2.7.0` | **存储加固**：数据文件 schema 版本 + 迁移钩子，facts WAL 增量落盘 |

> **关键设计取舍**：v2.5.0 是一次"减法"决策——把曾经作为可选引擎的 openclaw / DeepSeek Harness 后端全部删除，只留下自研的 `src/llm/client.js`（纯 `fetch` 直连 OpenAI 兼容 API）。这换来的是**完全自包含**：不装任何 npm 包，`node bin/ppx-web.js` 即可运行。

### 1.4 六大能力支柱

| 支柱 | 落地形态 | 可验证证据 |
|---|---|---|
| 🧠 **记忆** | L0–L4 五层 + 高斯衰减 + 软删回滚 + 版本链 + WAL | `src/memory/`（13 文件 2,389 行） |
| 🩺 **自愈** | 启动体检 / 损坏 JSON 修复 / 崩溃恢复 / 残留清理 | 自愈基准 **7/7 100%**（`scripts/selfheal-bench.js`） |
| 📚 **自学** | 失败→经验（refine）、成功→技能（refineSkill）、技能升级 | `src/services/learning-service.js` |
| 🔐 **治理** | SHA-256 审计链 + deny-wins 策略链 + 免疫闸门 | `npm run audit:verify` |
| 🤖 **军团** | 多进程 spawn_agent + DAG 编排 + legion + supervisor 仲裁 | `src/orchestrator/`（5 文件） |
| 🔌 **接入** | MCP 服务端/客户端 + HTTP + 飞书 + 微信 + Web UI | `src/mcp/`（6 文件 1,642 行） |

---

## 2. 整体架构与目录划分

### 2.1 分层架构总览

```
┌──────────────────────────────────────────────────────────────────────────┐
│  接入层  src/channels/ (http 813行 / feishu / wechat / log)                │
│          src/mcp/server.js (POST /mcp, 双era) · src/cli.js · web/ (Next.js) │
├──────────────────────────────────────────────────────────────────────────┤
│  编排层  src/mode/ (7种模式) ── src/orchestrator/ (legion/DAG/supervisor)   │
├──────────────────────────────────────────────────────────────────────────┤
│  引擎层  src/agent/index.js (715行, 薄编排)                                │
│          ├─ src/core/policy.js  (工具循环策略状态机, 272行)                 │
│          ├─ src/core/trace.js   (AsyncLocalStorage traceId 贯穿)           │
│          ├─ src/agent/context.js + prompts.js (历史/提示词 mixin)           │
│          └─ src/services/ (memory-service · learning-service · health)      │
├──────────────────────────────────────────────────────────────────────────┤
│  能力层  src/tools/ (43工具 + catalog 收口 + seam 策略)                     │
│          src/llm/ (client/retry/router/fence/dsml/embedder)                │
│          src/memory/ (L0-L4) · src/skills/ · src/persona/                  │
├──────────────────────────────────────────────────────────────────────────┤
│  治理层  src/bus/runtime-bus.js (事件/命令/状态 + 拦截器)                    │
│          src/ans/ (values/lifecycle/proactive/reward/eviction/guard)       │
│          src/audit/ (audit-chain SHA-256 / verifier 验证闸门)               │
│          src/selfheal/ · src/evolve/                                       │
├──────────────────────────────────────────────────────────────────────────┤
│  基础层  src/plugin/ (Context 服务定位器, 一切皆插件)                        │
│          src/seam/ (registry 能力缝 / shell 可替换执行)                     │
│          src/utils/ (logger/store/wal/schema/pii/trace/text/winutf8)       │
└──────────────────────────────────────────────────────────────────────────┘
```

### 2.2 「八大器官」职责映射

项目文档 `docs/ARCHITECTURE-ORGANISM.md` 用有机体隐喻对职责做了归位（**目录结构不动，仅做职责映射**）：

| # | 器官 | 对应模块 | 成熟度 |
|---|---|---|---|
| ① | 神经系（认知） | `agent/` `core/policy.js` `services/` `mode/` `llm/` `ans/values.js` | ✅ 最成熟 |
| ② | 循环系（总线+调度） | `bus/runtime-bus.js` + `plugin/context.js` + `memory/session.js` + `tools/advanced.js` Scheduler | ✅ 已补齐 |
| ③ | 呼吸系（环境感知） | `channels/` `mcp/` `tools/document.js` `tools/ocr.js` 多模态读图 | ✅ 完整 |
| ④ | 消化系（信息编译） | `memory/compaction.js` `tools/ocr.js` `tools/document.js` Chunking | ⚠️ 半（缺 ASR/实体抽取） |
| ⑤ | 排泄系（遗忘-归档） | `memory/fact-store.js` 衰减 + `ans/eviction.js` 排遗自治 | ✅ 已补齐 |
| ⑥ | 运动系（工具执行） | `tools/seam.js` + `catalog.js` + 各注册器 + `seam/shell.js` | ✅ 旗舰系统 |
| ⑦ | 内分泌系（目标-调节） | `ans/values.js` `persona/` `ans/proactive.js` `ans/reward.js` | ✅ 已补齐 |
| ⑧ | 免疫系（安全治理） | `ans/guard.js` + `catalog` 策略订阅者链 + `pii.js` + `command-guard.js` | ✅ 已补齐 |

> 该文档记录了一次明确的架构演进：2026-08-21 集中落地 P0–P4 四个缺口（总线 → Reward 闭环 → 排遗自治 → 全局免疫闸门），把「器官靠函数直连」升级为「器官通过统一总线协作」。

### 2.3 源码目录详解

```
src/                                  103 文件 / 14,930 行
├── agent/          3 文件   1,001 行  Agent 引擎（index 编排 + context 历史 + prompts 提示词）
├── ans/            6 文件     650 行  ANS 神经系（values/lifecycle/proactive/reward/eviction/guard）
├── audit/          2 文件     302 行  audit-chain 防篡改哈希链 + verifier 语义验证闸门
├── bus/            2 文件     208 行  runtime-bus 事件/命令/状态总线 + circuit-breaker 熔断器
├── channels/       7 文件   1,383 行  http/feishu/wechat(+crypto)/log + ChannelManager
├── config/         4 文件     758 行  统一配置中心（默认值/深合并/YAML/校验/热重载）
├── core/           2 文件     361 行  policy 工具循环策略 + trace 结构化事件流
├── evolve/         1 文件     194 行  playbook 进化剧本（ADD/UPDATE/REMOVE + 回归门禁）
├── llm/            7 文件     514 行  client 自研 HTTP 底座 + router 路由 + retry + fence + dsml + embedder
├── mcp/            6 文件   1,642 行  server 服务端 + client 客户端 + admin 管理工具 + http + tasks
├── memory/        13 文件   2,389 行  L0–L4 五层 + 会话日志 + 经验库 + 压缩 + 画布 + 资产 + 故障病历
├── mode/           6 文件     295 行  7 种编排模式（react/single/plan-exec/router/blackboard/graph/legion）
├── orchestrator/   5 文件     517 行  军团编排（legion 多进程 + dag 拓扑 + supervisor 仲裁 + worker）
├── persona/        1 文件      29 行  人格注入
├── plugin/         3 文件     356 行  Context 服务定位器 + builtin 13 插件 + compose 装配
├── seam/           2 文件     153 行  registry 能力缝注册 + shell 可替换执行提供方
├── selfheal/       3 文件     243 行  healer 启动体检 + evolve 进化引擎 + run CLI
├── services/       3 文件     436 行  memory-service 记忆协调 + learning-service 自我学习 + health
├── skills/         2 文件     249 行  SkillLoader 技能加载 + verify 技能验证闸门
├── tools/         13 文件   2,326 行  43 工具 + catalog 收口 + seam 策略 + command-guard 守卫
└── utils/          8 文件     469 行  logger/store(WAL/schema)/pii/text/trace/winutf8
```

**顶层入口**（4 个）：`src/server.js`（60 行，HTTP 服务）、`src/cli.js`（120 行，终端对话）、`src/channels-cli.js`、`src/aml-server.js`。

### 2.4 运行时数据目录（`data/`，不进 git）

```
data/
├── sessions/        会话事件日志 *.jsonl（append-only，default 会话按天分片 default-YYYY-MM-DD.jsonl）
├── memory/
│   ├── facts.json          L1 原子记忆 + L4 程序性记忆（+ facts.json.wal / .schema / .lock）
│   ├── l2/scenes.json      L2 场景聚类
│   ├── l3/user.persona.md  L3 用户画像
│   ├── l3/agent.persona.md L3 Agent 人格
│   ├── daily/<day>.md      MemoryTicker 每日滚动压缩视图
│   ├── longterm.md         长期记忆滚动摘要
│   ├── lifecycle.json      生命周期状态（重启不归零）
│   ├── reward.json         工具可靠性权重（EWMA）
│   ├── proactive.json      主动提醒去重/完成状态
│   ├── eviction.json       排遗治理报告
│   ├── failures/episodes.json  故障病历
│   ├── canvas/<day>.json   符号画布
│   └── assets/registry.json 记忆资产中枢
├── experience/lessons.json  经验库（全局共享目录优先，支持跨 agent）
├── audit/verified.json      Auditor「已验证写回」账本
├── evolve/playbook.json     进化剧本
├── logs/audit.ndjson        审计哈希链（append-only + SHA-256 链式）
├── logs/traces/             工具调用轨迹 JSONL + events-*.jsonl 结构化事件流
├── scheduler/               定时任务
└── aml/                     记忆 AML 相关
```

> **测试隔离**：所有测试使用临时目录，不污染生产数据（`test/datadir.test.js` 专项保障）。

### 2.5 项目根目录其余部分

| 目录/文件 | 用途 |
|---|---|
| `bin/` | 5 个可执行入口：`ppx.js`（CLI）、`ppx-web.js`、`ppx-serve.js`、`ppx-channels.js` |
| `config/` | `ppx.json`（主配置）+ `ppx.json.example` + `identity.md` / `ishiki.md`（人格文件） |
| `docs/` | 12 份文档 + `releases/` + `screenshots/` |
| `public/` | **零依赖静态 Web UI**：`index.html` 14KB + `app.css` 23KB + `app.js` 64KB + `vendor/marked.min.js` 35KB |
| `web/` | Next.js 产品壳（16.3.0 / React 19.2.8 / TS 5 / Tailwind 4），浏览器端走 `lib/mcp.ts` JSON-RPC 客户端 |
| `skills/` | 10 个方法型技能（`SKILL.md` 目录式）：brainstorm / plan / debug / verify / humanize 族 / ppx-memory / ppx-selfheal / session-naming / prompt-depth-kit / agent-professional-training |
| `scripts/` | 20 个脚本：eval / bench / selfheal-bench / release / audit-verify / check-web / mcp-smoke 等 |
| `test/` | 106 个测试文件（`node --test` 原生测试运行器） |
| `fixtures/` | `mock-mcp-server.cjs`（MCP 测试桩） |
| `references/` | `THIRD-PARTY-SOURCES.md`（第三方来源登记，不含源码） |
| 启动器 | `启动皮皮虾.vbs`（静默推荐）/ `启动皮皮虾.bat` / `停止皮皮虾.bat` / `高级菜单.bat` / `双击启动皮皮虾.bat` |

---

## 3. 核心模块与业务功能

### 3.1 Agent 引擎（`src/agent/`）

`PPXAgent` 类是系统唯一的总装点，但从 v2.0.0 起已被刻意"掏空"为**薄编排层**（715 行），实际逻辑下沉到三处：

| 下沉去向 | 内容 | 拆分时间 |
|---|---|---|
| `src/core/policy.js` | 工具循环策略（熔断/重复检测/溢出降档/错误重试/超时重试/结果裁剪） | 重构第一刀 2026-09-14 |
| `src/services/` | 记忆升降级 + 自我学习 | 重构第二刀 2026-09-14 |
| `src/core/trace.js` | 结构化事件流 traceId 贯穿 | 重构第三刀 2026-09-14 |
| `src/agent/context.js` + `prompts.js` | 历史裁剪/token 预算/会话压缩 + 提示词构建（以 mixin 挂回 prototype） | 2026-09-15 |

**构造流程**（`constructor`）：

1. 解析 `dataDir`：显式参数 > `PPX_DATA_DIR` > 默认。默认规则有个细节——若 `root` 路径含 `node_modules`（即被 npm 全局安装），数据目录外置到 `~/.ppx`，**防止卸载丢数据**。
2. `globalDataDir`：跨 agent 共享（经验库走这里）。
3. 创建根 `Context`（`access: "full-access"`，内置插件可信），预置 `root` / `dataDir` / `globalDataDir` / `config` / `userName` / `agent` 六个基点。
4. `compose(ctx, [...builtinPlugins, ...loadPlugins(pluginsDir), ...plugins])` —— 装配顺序为 **内置插件 → 用户插件目录（声明式）→ 构造函数传入插件（编程式）**，任何内置插件都可被替换。
5. 从 ctx 取回服务并挂为公开属性（`healer` / `facts` / `memory` / `llm` / `allProviders` / `tools` / `scheduler` / `bus` …），保持向后兼容。
6. 挂**免疫闸门**：`installGuard(this)` 接总线拦截器 + `installGuardOnCatalog(this.tools, guard)` 接工具收口，**两者共享同一 state**，一次授权同时生效。
7. 订阅 `bus.on("tool/result")` → `rewardRecord()`（⑦ Reward 闭环自动采集）。
8. 注册 `eviction-daily` 定时任务（cron `02:00` daily），并**首启立即跑一次**排遗扫描预热。
9. 构造 `MemoryService` / `LearningService`（依赖注入，`getLlm` 用闭包实时取当前 provider），把 `memory.summarizer` / `memory.setExtractor` 反向注入。
10. 应用 `config.tools.disabled`、按需自动连 MCP、首次生成 L3 画像（零依赖高频词统计，不调 LLM）。

**对外能力**：`chat()` / `chatStream()`（SSE 流式 + onTool/onStep 事件透传）/ `interrupt()` / `setNotify` / `setToolEvent` / `stats()` / `reloadProviders()` 热重载 / `reloadSettings()` 热重载 / `enableReadonlyMode()`（SDD 审查者，禁 11 类写操作）/ `connectMcp()` / `proactiveSuggest()` / `shutdown()`。

### 3.2 插件系统（`src/plugin/`）

**设计原则：一切皆插件**（借鉴 deepseek-harness）。每个模块是一个 `(ctx) => void` 函数，通过 `ctx.provide(key, value)` 注册服务，装配顺序即依赖顺序。

`Context` 本质是**服务定位器**而非事件总线：`provide` / `consume`（沿父链向上查找）/ `onDispose`（逆序释放）/ `withAccess()`（原型继承包装，共享存储）。

**权限模型**（P2⑧ 免疫加固）：

- `PLUGIN_ACCESS = { RESTRICTED: "restricted", FULL: "full-access" }`
- `SENSITIVE_SERVICES = [routes, lifecycle, tools, shell, pages, providers, extensions]`
- 顶层 ctx 为 `full-access`（内置插件可信）；用户插件默认 `restricted`，注册敏感 key 直接抛错
- `toolsPlugin.access = "full-access"`（函数外赋值，`compose` 前即可读）

**13 个内置插件装配顺序**（`src/plugin/builtin.js`，依赖在前）：

```
busPlugin → healerPlugin → personaPlugin → factsPlugin → experiencePlugin
→ sessionPlugin → memoryPlugin → llmPlugin → memoryLayersPlugin → tracesPlugin
→ auditPlugin → toolsPlugin → evolvePlugin → modePlugin
```

其中 `busPlugin` **必须最先**（注释明确："②循环系：全局总线必须最先"）；`auditPlugin` 必须在 `toolsPlugin` 之前（catalog 依赖它做审计注入）。`compose` 对单个插件做异常隔离——一个 setup 抛错不影响其余。

### 3.3 工具系统（`src/tools/`，13 文件 2,326 行）

**三层式「能力缝」**（Definition 元数据 / Provider 实现 / Consumer 策略），由 `src/tools/seam.js` 的 `normalizeMeta` + `runWithPolicy` + `toDescriptor` 承载。

**43 项内置工具全清单**（内核实例实测启用数）：

| 类别 | 工具 |
|---|---|
| 文件/系统 | `read_file` `write_file` `list_dir` `run_command` |
| 网络 | `web_search` `fetch_page` `http_request` |
| 记忆 | `memory_add` `memory_search` `memory_forget` `memory_restore` `memory_list_deleted` `memory_clear_layer` `memory_export` `memory_import` |
| 文档/多模态 | `read_document` `ingest_document` `read_image` `ocr_image` |
| 技能/方法 | `load_skill` `create_skill` `humanize` `write_article` `clarify` `refine` `refine_skill` |
| 场景/画像 | `scene_create` `scene_describe` `scene_list` `persona_build` `persona_read` |
| 调度/通知 | `add_schedule` `list_schedules` `notify` |
| 军团/自省 | `spawn_agent` `list_capabilities` `enable_capability` `disable_capability` `replay_session` `code_act` |
| 治理/运维 | `audit_verify` `selfheal_run` |
| 基础 | `get_time` |

**统一收口 `ToolCatalog.call()`** —— 这是全系统安全不变量的锚点：

```
ToolCatalog.call(name, args, ctx)
├─ 未知工具 → 返回 TOOL_ERROR_PREFIX 错误串（不抛异常）
├─ ① 策略链 _runPolicyChain()  ← 免疫闸门/命令守卫/防注入在此拦截，不可旁路
│     ├─ 每个订阅者持独立熔断器 (2026-09-17 接入 circuit-breaker):
│     │     熔断期直接跳过该订阅者 (弃权), 冷却后半开探测
│     └─ Promise.all 并发问询 → consolidateDecisions() deny-wins 合并
├─ ② deny → 返回"策略拦截"错误；ask → 返回"需要人工审批"错误
├─ ③ runWithPolicy()  禁用/超时(AbortController 真中断)/权限/before-after 钩子
└─ ④ audit.append() 落审计链（未注入 audit 时零开销直接跳过）
```

**热挂载**：`enable` / `disable` / `unregister` / `register` 运行期可改，`toOpenAI()` 只输出启用项给 LLM。

**命令守卫三层防线**（`src/tools/command-guard.js`）：用户 deny 规则 + 硬黑名单（`rm -rf /`、fork bomb、`curl|sh` 等，**`allow_all` 也拦**）+ 高危黑名单/前缀白名单，附反混淆检测防引号绕过。

### 3.4 五层记忆（`src/memory/`，13 文件 2,389 行）

```
对话 → L0 原始对话(session 事件日志)
       → L1 原子记忆(高斯衰减, facts.json)
       → L2 场景(关键词聚类, l2/scenes.json)
       → L3 画像(persona.md)
       ↘ L4 程序性记忆(技能/流程, 与 L1 同库 layer=4, 衰减仅为 1/4)
```

| 层 | 实现文件 | 落盘 | 核心机制 |
|---|---|---|---|
| L0 | `l0.js` + `session.js` | `sessions/*.jsonl` | append-only 事件日志 `{seq, ts, type, data}`；`shouldCapture` 过滤寒暄/短句/命令前缀 |
| L1 | `fact-store.js`（843 行，最大单文件） | `memory/facts.json` | 高斯衰减 + 倒排索引 + BM25 + 可选 dense 向量 + RRF 融合 |
| L2 | `l2.js` | `memory/l2/scenes.json` | 中文 2–4 字 tokenize + 关键词命中计数聚类 |
| L3 | `l3.js` | `memory/l3/*.persona.md` | 零依赖高频词统计（取 top 8）+ 去重取最近 10 |
| L4 | `fact-store.js` 内 `layer=4` | 同 `facts.json` | 衰减率固定 `0.005`，仅为 L1 的 1/4 —— 技能应长期留存 |

**辅助子系统**：`memory-ticker.js`（水位线：每 10 轮滚动压缩 / 超 50 条摘要归档 / 60s 节流）、`compaction.js`（五段固定式 LLM 摘要 ≤300 字）、`experience.js`（经验库，`globalDataDir` 优先，跨 agent 共享）、`canvas.js`（符号画布 → Mermaid）、`asset-hub.js`（记忆资产中枢）、`failure-episode.js`（故障病历，5 类分类）、`fork.js`（基线快照）。

### 3.5 ANS 神经系（`src/ans/`，6 文件 650 行）

ANS = Agent Nervous System，是本项目区别于普通 Agent 框架的部分——一组独立的"生理系统"模块，每个都可单独替换。

| 文件 | 器官 | 职责 |
|---|---|---|
| `values.js` | ⑦ 价值对齐 | 4 条核心价值注入 system prompt **最前**，声明"不可违背" |
| `lifecycle.js` | §3 发育 | 状态机 `born → growing → mature`（+ `evolved` / `reproduced` 计数），落盘不归零 |
| `proactive.js` | ⑦ 主动性 | 扫描 L1 里的待办生成主动提醒，24h 去重 + 完成跟踪 + 过期待办跳过 |
| `reward.js` | ⑦ Reward | EWMA 维护工具可靠性权重，识别低可靠工具并注入提示 |
| `eviction.js` | ⑤ 排遗 | bigram 冗余识别 + 冷热分层（14 天），只报告不删除 |
| `guard.js` | ⑧ 免疫 | 全局闸门：危险 verb 未授信默认阻断，白名单/单次审批双模放行 |

### 3.6 总线与治理（`src/bus/` + `src/audit/`）

**`RuntimeBus`** 三通道设计：

- **Event 通道**：`emit` / `on` / `off`，事件对象 `{seq, ts, type, payload, meta}`，`historyLimit: 200`
- **Command 通道**：`register(verb, handler)` + `command(verb, payload, {timeoutMs})` → Promise<Result>，超时返回 `command-timeout`
- **State 通道**：`get` / `set` / `has`，写入时自动 emit `state` 事件
- **拦截器**：`intercept(fn)` 组成前置链，递归 `run(i)`，抛错短路为 `blocked: true` —— **这就是 ⑧ 免疫闸门的挂载点**

已埋点事件：`chat/user`、`chat/reply`、`memory/record`、`tool/call`、`tool/result`、`command`、`state`。

**`audit-chain.js`**（SHA-256 防篡改账本）：工具调用落 `data/logs/audit.ndjson`，每条带 `prevHash` 串成链；append-only；参数落盘前脱敏（`sk-*` / `Bearer` / `api_key` / URL query 凭证 / 手机号）；`verify()` 精确报出**首个断裂行号**；`quarantineBroken()` 隔离损坏段并重建（自愈语义）。

**`verifier.js`** 则提供语义验证闸门 —— `Auditor` 是唯一的「已验证写回」通道，账本落 `data/audit/verified.json`。自学链路（refine / refineSkill / upgradeSkill）必须过这道闸门才允许写回。

### 3.7 编排与执行模式（`src/mode/` + `src/orchestrator/`）

**7 种模式**，通过 `ModeRegistry.run(name, agent, userMsg, opts)` 分发，可插拔：

| 模式 | 机制 |
|---|---|
| `react`（默认） | 标准工具循环 |
| `single` | 单轮直答，不走工具 |
| `plan-exec` | 先出计划（2–6 步，容错 JSON 解析）再逐步执行 |
| `router` | 按技能 description 匹配（CJK bigram + 英文词，命中分 ≥1）后注入 `[已激活技能]` |
| `blackboard` | 黑板多专家（分析师/执行者/审查者），末位审查者输出为答案 |
| `graph` | 节点顺序执行 + checkpoint 到会话日志 |
| `legion` | 多进程军团（懒建 `agent._legion`，每 agent 独立 `data/legion/agent-i`） |

**军团编排**（`src/orchestrator/`）：

- `legion.js`：`maxConcurrent: 8` 的有界并发；`spawnAgent` 派生子进程，stdout 逐行解析 JSON 协议；`send` / `broadcast` / `dispatch`（实验性）/ `runDag`
- `dag.js`：Kahn 算法拓扑分层，层内并行，有环直接抛错
- `supervisor.js`：多轮评审 + 贪心聚类求共识（相似 >0.4 同组），`consensus < 0.6` 判为分歧，LLM 评审返回 JSON `{accept, feedback}`
- `agent-worker.js`：子进程 JSON 行协议（`chat` / `ping` / `shutdown`），`PPX_AGENT_READONLY=1` 自动切只读模式

### 3.8 自愈与进化

**自愈**（`src/selfheal/healer.js`）：`integrity.json` 记录 `{clean, pid, ts}`；`markDirty()` 在启动时置脏 → 若下次启动发现 `clean === false` 即判定**上次是崩溃退出** → 触发 `_cleanupTmp()`。`runStartupChecks()` 补建缺失目录、损坏 `facts.json` 改名 `.corrupt-<ts>` 后重置。清理策略保留最近 2 份备份（`cleanupCorruptBackups` / `cleanupStaleBackupDirs` / `cleanupStaleBakFiles`）。

**进化**（`src/selfheal/evolve.js`）：`EvolutionEngine` 每轮对话 `tick()`，达 `every_calls`（默认 20）且距上次 ≥ `min_interval_ms`（30s）才触发 `_run()`（fire-and-forget）：失败 ≥2 → `refine()`；成功 ≥3 → `refineSkill()`；技能 `uses ≥ 3` → `upgradeSkill()`。

**Playbook**（`src/evolve/playbook.js`）：确定性执行 `ADD/UPDATE/REMOVE` 剧本操作，ADD 相似度 >0.6 拒收（防重复），bullet 带 `counters:{helpful, harmful}`，`harmful - helpful ≥ 3` 自动移除；`createGate()` 提供回归门禁，不通过则拒绝提交。

### 3.9 通道与 MCP

**通道**（`src/channels/`）：`ChannelManager` 统一注册表，各通道实现 `mount()` 自行挂载 webhook。

| 通道 | 状态 | 文件 |
|---|---|---|
| HTTP | ✅ 可用（813 行，最大通道文件） | `http.js` |
| 飞书 | ✅ 已实现 | `feishu.js` |
| 微信 | ✅ 已实现（加解密 + 主动推送 + 加密回包） | `wechat.js` + `wechat-crypto.js` |
| log | ✅ | `log.js` |

**MCP 服务端**（`POST /mcp`，Streamable HTTP，**双 era**：现代 `2026-07-28` + legacy `initialize` 握手），暴露：

- **43 项工具**全量
- **Resources**：`memory://facts`、`memory://scenes`、`sessions://list`、`stats://overview`、`traces://recent`
- **Prompts**：`humanize` / `plan` / `debug` / `verify` / `write_article`（方法型技能）
- **对话工具**：`ppx.chat.send`（结构化 tool/step 事件）/ `ppx.chat.stream`（SSE 流式）
- **管理工具 22 个**：`ppx.sessions.*`（list/history/rename/delete/reset）、`ppx.providers.*`（list/add/update/delete/reorder/test）、`ppx.settings.*`（get/update）、`ppx.task.*`（create/list/update/delete/run/step/templates）

**MCP 客户端**（`src/mcp/client.js`，483 行）：零依赖实现 stdio + HTTP Streamable 两种传输，可接入外部 MCP 服务器。

> **架构决策**：v2.6.0 起 Web 产品壳**全面切 MCP** —— 浏览器端通过 `web/src/lib/mcp.ts` 的 JSON-RPC 客户端直连 `/mcp`，REST `/api/*` 退役（`legacy_rest: false` 时彻底返回 410）。

### 3.10 Web UI（双形态）

| 形态 | 位置 | 特点 |
|---|---|---|
| **零依赖静态 UI**（当前主推） | `public/` | 单页 `index.html` + `app.css` + `app.js`（64KB）+ `marked.min.js`。内核直接托管，**同进程同端口，免 token 配置**（服务端把回环 token 注入首页） |
| Next.js 产品壳（旧版） | `web/` | Next.js 16.3.0 / React 19.2.8 / TS 5 / Tailwind 4；「Codex 桌面版」风格界面，全 CSS 变量题化 |

功能覆盖：会话管理、场景、记忆、轨迹、统计、任务面板、模型/插件/预设设置 5 页；流式打字机 + 工具卡片 + Markdown 渲染。

---

## 4. 关键实现逻辑

### 4.1 单轮对话全链路（`chat()`）

```
用户消息
 → runWithTrace(sessionKey, channel, userMsg)        ← 生成 traceId，AsyncLocalStorage 贯穿
 → bus.emit("chat/user")
 → _localIntent(userMsg)                              ← 内核自主决策：高置信简单指令本地处理，不调 LLM
 │   ├─ 纯问候/告别/感谢 → 固定回复
 │   ├─ 时间/日期 → 直调 get_time
 │   ├─ "记得XXX" → _memoryQuery（LLM 查询扩展 + RRF 融合）
 │   ├─ "记住:XXX" → 直调 memory_add
 │   └─ "读文件X" / "列出X" → 直调 read_file / list_dir
 └─ 未命中 → ctx.consume("modes").run(mode || "react", ...)
      → _llmWithTools → runToolLoop(policy.js)
          每轮: llm.apiChat(messages, {tools, toolRunner})
            ├─ 溢出错误 → shouldShrinkOverflow? → nextOverflowCap → 裁剪历史 → continue
            ├─ 无 tool_calls → 返回 content（收敛）
            └─ 有 tool_calls → 逐个 callWithTimeoutRetry → _runTool
                 → bus.emit("tool/call") → tools.call() → 策略链 → runWithPolicy → audit.append
                 → bus.emit("tool/result") → rewardRecord()  ← ⑦ Reward 自动采集
                 → traces.record()
            ├─ 有错误 → shouldRetryErrors? → 错误喂回模型 → continue
            └─ recordTurn(toolCalls) → 探索熔断/重复检测 → 注入方向盘 → continue
 → _pushTurn + memory.recordTurn + bus.emit("memory/record")
 → memorySvc.afterTurn()   ← L2 场景归档 + 用户经验学习 + L3 画像跨天刷新
 → bus.emit("chat/reply")
 → _lifecycleTick() + evolve.tick()
 → reply
```

### 4.2 工具循环策略状态机（`src/core/policy.js`）

这是全项目**设计最干净的模块**：依赖全部注入，不持有 agent 引用，可独立测试。

| 阈值 | 默认值 | 配置键 |
|---|---|---|
| 最大工具轮次 | `8` | `agent.max_tool_rounds` |
| 工具结果裁剪预算 | `4000` | `agent.tool_result_budget` |
| 工具错误重试上限 | `2` | `agent.max_tool_error_retry` |
| 溢出降档次数 | `2` | 常量 |
| 探索熔断连击 | `3` | `agent.explore_break_limit` |
| 重复命令标记 | `2` | `agent.repeat_flag_limit` |

**四类自转防护**：

1. **探索熔断**：连续 3 轮工具调用**全部**属于 `EXPLORE_TOOLS`（12 个只读/发现类工具）→ 注入"检测到连续探索循环…请停止继续探测，基于已获得的信息直接给出结论"。
2. **重复检测**：签名 `name::JSON(args).slice(0,120)` 命中 2 次 → 注入"检测到重复执行相同工具与参数"。
3. **溢出降档**：`nextOverflowCap(cap) = max(200, floor(cap / (n+1)))` —— 逐档缩紧历史预算，最多 2 次。`isOverflowError` 有精细判定：`AbortError` 一律不算溢出；`413` 算；`400` 只在消息含 `context|token|length|window` 时才算（**避免普适 400 误判**）。
4. **超时重试**：`callWithTimeoutRetry` 仅在**工具幂等**时重试一次。非幂等工具跳过重试，采集 `tool/timeout` 事件（`skippedRetry: true`）。这是 v1.6.0「第四刀」，注释明确说先跑一周采 P50/P95/P99 再谈自适应预算。

### 4.3 记忆衰减与检索（`fact-store.js`）

**高斯衰减公式**（注意是 **t² 项**，比线性指数衰减更快）：

```js
_lambdaOf(layer) = (layer === 4 ? 0.005 : decayPerDay) * forgetSpeed
score(t) = score × exp(-λ · days²)
```

参数来自配置：`decay_per_day = 0.02`、`forget_speed = 1`、`hit_bonus = 5`、`base_importance = 10`。L4 固定 `λ = 0.005`，是 L1 的 1/4 —— 注释点明设计意图：**「技能应当长期留存，不该像闲聊事实一样快速遗忘」**。

**两级索引**：

- 粗召回：`_charKeys` = 中文单字 ∪ 英数 token → 倒排 `_index: Map<key, Set<factId>>`
- 精排：`_bigramSet` = 中文 bigram + `"en:" + token`

**BM25 参数**：`k1 = 1.5`、`b = 0.75`、`tf = 1`（集合去重）。`_idf = ln(1 + (N - df + 0.5) / (df + 0.5))`。统计量按 `scopeKey` 缓存于 `_statsCache`，add 时失效。

**查询排序公式**：

```
总 分 = bm25 × 10 × (0.4 + 0.6 × recency)     ← recency = exp(-λ·days²)
      + 整句子串命中 ? 5 : 0
      + min(hits, 5)                            ← 命中历史权重
      + min(importance, 20) / 20 × 3            ← 重要性权重
门槛 = 1
```

候选集取倒排 key 并集；若 `candIds.size > scoped.length × 0.9` 则退回全量扫描。`bm === 0` 且无子串命中直接丢弃。

**融合**：`queryMulti` 每个变体取 `max(limit×2, 10)` 后 `rrfFuse(lists, {k: 60})`，累加 `1 / (k + rank + 1)`。`querySemantic` 走 embedder + `_cosine`，dense 与 BM25 双路再做 RRF；embedding 缓存 LRU 上限 1000 且不落盘。

**去重**：`_norm`（trim + 空白折叠）→ `_normKey` 再去掉 `MEMORY_VERB_PREFIXES`（"请记住"/"记得"/"别忘了"…）+ 尾部标点。命中则 `hits+1` + `score += hitBonus`。`similarThreshold > 0` 时先 `_jaccard` 再 `_overlap`（交集/较短集合，容忍词序变化）。

**容量裁剪 `_prune`**：超 `max_facts`（1000）时按
`score × (0.4 + 0.6·recency) × (0.5 + 0.5·min(importance,20)/20)` 升序淘汰最弱项。
> 职责分工明确：治理管"想忘的"，`_prune` 管"装不下的"，两者不重叠。

### 4.4 记忆治理：可回滚的遗忘

原版是**不可逆硬删**，现引入治理语义：

| 能力 | 工具 | 实现要点 |
|---|---|---|
| 软删 | `memory_forget` | 标记 `status='deleted'`，检索立即可见性消失，数据保留；幂等且**不覆盖原 reason** |
| 回滚 | `memory_restore` | 恢复即视作一次访问（避免恢复后被立刻衰减清空） |
| 复核 | `memory_list_deleted` | 列出已遗忘条目（含原因与时间） |
| 版本链 | `update()` | 旧版转 `archived` + `supersededBy`，新条 `prevId` 指回 —— **只保留一层历史** |
| TTL 归档 | `sweepExpired()` | 超 `memory_ttl_days`（90）未访问软归档，支持 `dryRun` 预演 |
| 按层清理 | `memory_clear_layer` | 默认软删，`hard=true` 才物理删除 |
| 迁移 | `memory_export` / `memory_import` | 导出含软删/归档条目；`merge` 按内容去重 / `replace` 整体替换 |

**WAL 增量落盘**（v2.7.0 新增，默认关闭）：`{ wal: true, walThreshold: 50 }` 开启后变更走追加日志（`upsert` / `replace` / `remove` 事件），达阈值自动 compact 全量写。崩溃安全靠"主文件 = 最后快照，WAL = 快照后增量"，启动重放**幂等**（按 id upsert/remove）。多进程安全靠文件锁 + flush 时三方合并（磁盘快照 + WAL + 内存，内存优先）。

**并发与原子性底座**：所有读-改-写走 `withFileLock`（同步 `.lock` 忙等，超时 3s 强取），落盘走 `atomicWrite`（rename 重试 3 次）。

### 4.5 审计哈希链

```
第 N 条记录: { tool, args(脱敏), ok, error, ms, prevHash: H(N-1) }
verify(): 逐行重算 SHA-256, 首个不匹配行号即断裂点
quarantineBroken(): 备份损坏段 → 重建空链 → 记录隔离事件
```

改动任意一行会导致**后续所有行**校验失败。`config.audit.enabled: false` 可关闭，未启用时工具调用路径**零开销**（catalog 里 `if (!this.audit) return runWithPolicy(...)` 直接短路）。

### 4.6 策略链与 Deny-Wins 合并

多策略订阅者给出冲突决策时的合并规则（吸收 Aegis/HookBus 治理语义）：

```
任一 deny  → deny（取最高 priority 的 reason）   ← 一票否决，不可被低优先级 allow 覆盖
否则任一 ask → ask
否则       → allow
```

订阅者异常**不拖垮工具执行**：记日志并视同弃权（fail-open）。免疫闸门以 `priority: 100` 注册，天然压过其它订阅者。

**熔断兜底**（2026-09-17 接入 `src/bus/circuit-breaker.js`）：fail-open 本身是"裸"的 —— 一个持续故障的订阅者会被每次调用反复触发。现为**每个订阅者配独立熔断器**（默认 60s 窗口内 3 次异常 → 熔断，冷却 10s），熔断期直接跳过该订阅者（弃权，而非放行），冷却后半开放行单个探测，成功即恢复闭合。状态经 `ToolCatalog.policyStatus()` 与 `agent.stats().policyGuard` 可观测。

### 4.7 免疫闸门（`ans/guard.js`）

**三层危险判定**：

1. 危险 verb：`/^(delete|remove|clear|wipe|drop|purge|truncate|overwrite)/i`
2. 危险工具：`DANGEROUS_TOOLS = Set(["memory_export"])`
3. 危险参数：`memory_import.mode === "replace"` / `memory_clear_layer.hard === true` / `audit_verify.quarantine === true`

统一入口 `dangerVerdict(verb, args)` → `{dangerous, reason}`。放行模式双轨：**白名单**（`config.agent.guardAllowList`）+ **单次审批**（`approveGuard(verb)` → `approveOnce()`，一次用完自动失效）。审计条目带 `payloadHasPII`（调 `hasPII` 探测）。阻断时抛"免疫闸门: 危险命令未授信而阻断"。

**同一 state 共享**：总线拦截版与工具收口版共享状态，一次授权同时作用于总线命令与工具调用 —— 这修补了 MERGE-REPORT 遗留的"guard 之前只盖总线命令、工具走 catalog 绕过闸门"的 P2 缺陷。

### 4.8 多 Provider 回退与多模态路由

`_llmWithFallback` 的回退顺序经**三重重排**后才依次尝试：

1. **多模态优先**：消息含 `image_url` 块时，只保留 `vision: true` 的 provider；若无 vision provider，打印明确提示"图片将无法被模型理解"
2. **工具优先**：`toolsEnabled` 时把支持原生 `tool_calls` 的 provider 排前面
3. **并发健康探测**：`Promise.all` 并发探活（而非串行等待 180s 超时），只对可用 provider 发起调用；全部探测失败则按原配置顺序兜底

回退语义分层清晰：**router.js 负责选主模型，agent 负责运行时失败切换**。`retry.js` 做瞬态错误分类重试（429/5xx/timeout）。

### 4.9 生命周期与 Reward 闭环

**生命周期**：`born` →（首次 `tick()`）`growing` →（`chats >= MATURE_CHATS(10)`）`mature`；`evolving` / `reproducing` **不是 stage，而是累计计数字段**。状态落 `data/memory/lifecycle.json`，重启不归零（v1.0.7 持久化）。

**Reward EWMA**：`ALPHA = 0.25`，`weight = (1-α)·w + α·(ok ? 1 : 0)`，初值 0.5。工具进入 unreliable（`weight < LOW_WEIGHT(0.45)` 且 `samples >= MIN_SAMPLES(5)`）时触发 `lifecycle.evolve()`；`context()` 生成"【警告 低可靠性工具·谨慎使用】…成功率 x%，样本 n 次"注入 prompt。

---

## 5. 技术栈与依赖配置

### 5.1 技术栈

| 层 | 选型 | 说明 |
|---|---|---|
| 运行时 | **Node.js >= 20** | ESM 模块（`"type": "module"`），纯内置模块 |
| 依赖管理 | **零运行时依赖** | `package.json` 无 `dependencies` 字段 |
| 测试 | Node 原生 `node --test` | 107 文件 / 768 项，无 Jest/Mocha |
| LLM 接入 | 自研 `src/llm/client.js` | 纯 `fetch` 直连 OpenAI 兼容 API，SSE 流式 + 原生 tool_calls |
| 前端（静态） | 原生 HTML/CSS/JS + marked.js | `public/`，零构建 |
| 前端（Next.js） | Next 16.3.0 / React 19.2.8 / TS 5 / Tailwind 4 | `web/`，独立 `package.json`，不影响主包零依赖 |
| 协议 | MCP (Streamable HTTP) | 双 era 支持 |
| CI | GitHub Actions | push/PR 跑全量测试 + web 类型检查/构建 + 本地评测 |

> **"零依赖"的边界要讲清楚**：主包 `ppxans-harness` 零运行时依赖；`web/` 子目录是独立的 Next.js 项目（有自己的 `package.json`），只在启用「旧版 Next.js 界面」时才需要安装，不影响主包的内核运行。

### 5.2 配置体系（`src/config/index.js`）

加载链：`config/ppx.json` →（或 `ppx.yaml`，自带子集 YAML 解析器）→ 深度合并 `DEFAULT_CONFIG` → 环境变量覆盖 → 类型校验（**只警告不抛错**，兼容旧行为）。

**`config/ppx.json` 全字段**：

| 段 | 关键字段 | 当前值 |
|---|---|---|
| `agent` | `name` / `max_tool_rounds` / `tool_result_budget` / `max_tool_error_retry` / `model_preference` / `proactive` / `evolve` | 皮皮虾 / 8 / 4000 / 2 / local / `{enabled:true, interval_ms:3600000}` / `{enabled:true, every_calls:20}` |
| `user` | `name` | 兄弟 |
| `providers` | 6 个：openai / deepseek / dashscope / **qwen-vl（vision）** / lmstudio / **zhipu（vision）** | 各带 `timeout_ms: 180000` + `context_window` |
| `memory` | `token_budget` 2500 / `decay_per_day` 0.02 / `hit_bonus` 5 / `base_importance` 10 / `compile_threshold` 4.5 / `forget_speed` 1 / `memory_ttl_days` 90 | |
| `audit` | `enabled` | true |
| `embedding` | `base_url` / `model` | 本地 lmstudio + `text-embedding-nomic-embed-text-v1.5` |
| `experience` / `selfheal` / `tools` | `enabled` | 均 true |
| `channels` | http(8899) / log / feishu(off) / wechat(off) | |
| `security` | `allow_all` false / `command_timeout_ms` 30000 / `deny` [] | |

**`DEFAULT_CONFIG` 独有字段**（配置文件中未写、但代码有默认值）：`memory.max_history_items`(40)、`history_token_budget`(4000)、`context_window`(8192)、`context_window_ratio`(0.6)、`max_facts`(1000)、`session_max_age_days`(30)、`tools.custom_dir`("custom-tools")、`plugins.dir`("plugins")、`mcp.{servers,auto_connect}`、`security.code_act`(false)。

**占位符校验**：`validateConfig` 会识别 `REPLACE_WITH_` / `your-endpoint` / `your_api_key` 等模板残留，启动即警告"该 provider 实际不可用"，**避免静默失败**。

**环境变量**：`PPX_AUTH_TOKEN`（覆盖 HTTP token）、`PPX_PORT`、`PPX_HOST`、`PPX_NO_OPEN`、`PPX_DATA_DIR`、`PPX_AGENT_GLOBAL_DATA_DIR`、`PPX_PROVIDER`（强制指定 provider）、`PPX_AGENT_READONLY`、`PPX_MIN_SELFHEAL`。API key 走各 provider 声明的 `api_key_env`（`OPENAI_API_KEY` / `DEEPSEEK_API_KEY` / `DASHSCOPE_API_KEY` / `ZHIPU_API_KEY` …）。

### 5.3 启动入口矩阵

| 入口 | 命令 / 文件 | 作用 |
|---|---|---|
| **一键 Web**（推荐） | `npm start` → `bin/ppx-web.js` | 内核 + 界面同进程同端口，自动开浏览器，轮询就绪后退出启动器 |
| 终端对话 | `npm run chat` → `src/cli.js` | readline 历史（↑↓）+ `/stop` 中断 + `/reset` 清会话 + Ctrl+C 单次中断 |
| 仅接口 | `npm run serve` → `src/server.js` | 无界面，`/health` + 通道 webhook + `/mcp` |
| 通道 CLI | `bin/ppx-channels.js` | 通道管理 |
| Windows 双击 | `启动皮皮虾.vbs`（静默推荐）/ `.bat`（带窗口）/ `停止皮皮虾.bat` / `高级菜单.bat` | 自动清理上次遗留监听进程 |
| npm 全局 | `ppx` / `ppxans` / `ppx-serve` / `ppx-web` / `ppx-channels` | `npm i -g ppxans-harness` |

`bin/ppx-web.js` 的 `--print-port` 是个巧思：纯查询端口后立即退出（**必须在 `startServer` 之前退出**，否则会真把服务拉起来），供 `.bat` 启动器读取端口后自行清理旧监听。

### 5.4 工程脚本

| 脚本 | 命令 | 用途 |
|---|---|---|
| 测试 | `npm test` | 768 项全量 |
| 发布门禁 | `npm run prepublishOnly` | `selfheal` + `test` 必须先过 |
| 自愈基准 | `npm run selfheal` | 注入破坏 → 修复 → 输出修复率（7/7 100%） |
| 审计校验 | `npm run audit:verify [-- --fix]` | 校验链完整性 / 隔离损坏段重建 |
| 评测 | `npm run eval [-- --llm]` | 零依赖 7 项能力评测 / LLM 端到端回归 |
| 压测 | `npm run bench` | 并发 / 长会话吞吐基线 |
| 界面自检 | `npm run web:check` | 图标 / DOM id / 静态资源引用 |
| 发布 | `npm run release` | 版本发布流水线 |

---

## 6. 优化执行记录

> 本节记录 2026-09-17 的一轮全量优化：先全量通读定位问题，再**逐项落地修复**，每项附复现/验证方式。
> **结果：7 项问题全部处理完毕**；测试从 745 项增至 **754 项（+9 项回归守卫）**，0 失败；内核启动冒烟通过。

### 6.1 🔴 P0 — `src/plugin/builtin.js` 缺失 `info` 导入，内核启动崩溃

**问题**：`sessionPlugin` 第 85 行在"存在过期会话被清理"时调用 `info(...)`，但该文件从未导入 logger。ESM 下 `info` 未定义 → **ReferenceError**。

**危害等级为什么是 P0**：该分支位于 `PPXAgent` **构造函数**的插件装配路径上。一旦触发，`sessionPlugin` 抛错会导致整个 `PPXAgent` 构造失败 —— **内核完全起不来**，Web、CLI、MCP 全线不可用。

**触发条件**：`config.memory.session_max_age_days`（默认 30）生效且存在超龄会话文件。也就是说 —— **正常使用满 30 天后必然触发**。当前 `data/sessions/` 只有一份 9-15 的 `live-test.jsonl`，尚未到期，所以问题被掩盖了。

**复现证据**（本次实测）：
```
结果: 抛错 -> ReferenceError: info is not defined
```

**修复**：在 `src/plugin/builtin.js` 顶部补 `import { info } from "../utils/logger.js";`

**验证**：修复后全量测试保持全绿，内核启动冒烟通过（43 工具注册）。并用全库静态扫描确认 `info/warn/error/debug/ok/fail` 这一族"用了却没导入"的符号已清零（仅剩 `utils/logger.js` 自身的 4 处定义处误报）。

---

### 6.2 已修复 — P1 层

#### 🟠 P1 — `src/memory/fork.js` 快照静默降级（含"测试桩与真实类接口漂移"根因）

**问题**：`exportMemorySnapshot` 声称快照 `facts / persona / experience` 三份，但：

- 原第 32 行调 `agent.personaStore.read()` —— `PersonaStore` 只有 `userPersona()` / `agentPersona()`，**无 `read()`**
- 原第 43 行调 `agent.experience.list({limit})` —— `Experience` 只有 `learn()` / `recall()` / `use()` / `context()`，**无 `list()`**

两处都有 `typeof === "function"` 守卫，因此**不崩溃**，但两个分支永远进不去 —— 实际只写出 `facts.md`，`persona.md` / `experience.md` 永不生成。

**根因（比缺陷本身更值得记录）**：`test/fork.test.js` 用的是**手写桩** `{ personaStore: { read: ... }, experience: { list: ... } }` —— 桩凭空提供了真实类并不存在的方法。于是测试**一直在验证一个虚构的接口**，缺陷自然测不出来。这是典型的 **test double drift（测试替身漂移）**。

**修复**（两处一起改，缺一不可）：
1. `src/memory/experience.js`：补 `list({limit, sort})` 与 `count()` 公开读 API（默认按命中次数排序），使该调用有真实实现。
2. `src/memory/fork.js`：画像分支改用真实方法 `userPersona()` + `agentPersona()`，并把**两份画像一并导出**（原意图只导一份，信息有损）。
3. `test/fork.test.js`：**手写桩替换为真实 `PersonaStore` / `Experience` 实例**，并新增回归守卫用例——断言 `persona.md` 含真实用户画像与 agent 人格内容、`experience.md` 含真实经验内容，且显式校验 `typeof personaStore.userPersona === "function"` / `typeof experience.list === "function"`。接口再漂移会直接测失败。

**验证**：`test/fork.test.js` 7/7 通过（原 6 项 + 1 项接口守卫）。

#### 🟠 P1 — `src/services/memory-health.js` 的 `unhealthy` 状态不可达

**问题**：`status()` 里三元表达式两个分支都返回 `HEALTHY`：
```js
const overall = this.degraded
  ? HEALTH.DEGRADED
  : (totalFail === 0 ? HEALTH.HEALTHY : HEALTH.HEALTHY);   // ← 两分支相同
```
`HEALTH.UNHEALTHY` **永不可能被返回**，三态退化为两态。

**修复**：把判定改为按**滑动窗口内最差单步失败数**分档，并新增 `unhealthyAfter`（默认取 `degradeAfter` 的两倍，保持"先降级、后重度降级"的渐进语义）：

| 窗口内失败数 | 状态 | advice |
|---|---|---|
| `< degradeAfter` | `healthy` | `{action:"normal"}` |
| `>= degradeAfter` | `degraded` | `{action:"degrade", severe:false, skip:["compact","extract"]}` |
| `>= unhealthyAfter` | `unhealthy` | `{action:"degrade", severe:true, reason:含失败次数, skip:["compact","extract"]}` |

同时 `status()` 补齐可观测字段：`unhealthy` / `worstRecentFails` / `thresholds{degradeAfter,unhealthyAfter,windowMs}` / `totalFail`。

**验证**：`test/memory-health.test.js` 14/14 通过（原 9 项 + 5 项新增：三态可达 / 默认阈值两倍 / 恢复健康 / severe 标记 / 阈值可观测）。

#### 🟠 P1 — README 与实测数字不同步

| 位置 | 原声称 | 实测 → 已校正为 |
|---|---|---|
| README 首段 | 716 测试全绿 | **754 项** |
| README 特性表 / MCP 段 / 目录结构 | "45+ 内置工具"（4 处） | **43 项** |
| README 目录结构节 | "720 项 716 过 0 失败 4 跳过" | "754 项 750 过 0 失败 4 跳过" |

顺带核实了 README 的「自愈 7/7」声明 —— 跑 `scripts/selfheal-bench.js` 实测 `Self-heal score: 7/7 (100.0%)`，**属实，未改动**。

---

### 6.3 已处理 — P2 层

#### 🟡 P2 — `CircuitBreaker` 真正接线（从"预留件"变为"生效件"）

**问题**：`src/bus/circuit-breaker.js` 完整实现了三态熔断器（`closed → open → half_open`，含 fail-open / fail-closed 策略），但 `src/` 内**零消费者**，仅有 `catalog.js` 一句注释提及"可被上层熔断器保护"。同时策略订阅者的异常处理是**裸的 fail-open** —— 一个持续故障的订阅者会被每次工具调用反复调用、反复抛错、反复刷日志。

**处置：选择"接线"而非"标注"** —— 因为该模块的注释本身就写明了设计意图是「保护总线/策略链不被故障订阅者拖垮」，这个价值是明确的、非臆测的。

**实现**（`src/tools/catalog.js`）：
- `addPolicySubscriber(fn, { priority, name, breaker })` —— **每个订阅者持有独立熔断器**，默认 `{threshold:3, windowMs:60000, cooldownMs:10000}`，可用 `breaker` 参数覆盖。
- `failPolicy` 固定为 `fail-closed`，使熔断期 `before()` 返回 `{allowed:false}` → 策略链**跳过该订阅者（弃权）**，而非放行。这与 deny-wins 语义自洽：坏掉的订阅者只是不投票，不会把工具调用放行掉。
- 熔断期不再调用订阅者（省开销 + 止住日志刷屏），冷却后进入半开放行**单个探测**，探测成功即恢复闭合。
- 新增 `policyStatus()` 暴露每个订阅者的 `state / calls / opens / recentFailures`，并在 `PPXAgent.stats()` 增加 `policyGuard` 字段（**只列非闭合项，正常时为空数组**），使熔断状态可被外部观测。

**验证**：`test/catalog-guard.test.js` 12/12 通过（原 9 项 + 3 项新增：达阈值熔断且不再被调用 / 熔断不影响其他订阅者的 deny 决策 / 冷却后半开探测成功即恢复闭合）。既有「订阅者异常不拖垮工具」用例保持通过 —— 单次异常不会触发熔断，fail-open 行为未变。

#### 🟡 P2 — 其余未接线模块：加明确"预留/未接线"标注

由于这些模块**没有明确的设计意图说明其应被谁消费**（与 CircuitBreaker 不同），贸然接线等于凭空发明行为，风险高于收益。因此采取**如实标注**的处置：

| 模块 | 处置 | 标注内容 |
|---|---|---|
| `src/seam/registry.js` | 文件头加 ⚠ 标注 | 在 `src/` 内无消费者；服务级替换能力现由 `plugin/context` 服务定位器承担 |
| `src/memory/failure-episode.js` | 文件头加 ⚠ 标注 | 已装配 `ctx.provide("failures")` 但无内置消费方；当前失败沉淀走经验库 + refine 闭环 |
| `src/evolve/playbook.js` | 文件头加 ⚠ 标注 | 已装配 `ctx.provide("playbook")` 但无内置消费方；无代码注入 bullets 或产生 delta |
| `src/orchestrator/supervisor.js` | 文件头加 ⚠ 标注 | `runSupervisor` 无内置调用点；`spawn_agent` 走 `delegate.js` 自带 review 循环 |
| `src/plugin/builtin.js` `evolvePlugin` | 注释补全 | **该插件注册的 6 个服务（playbook / memoryHealth / failures / canvas / fork / assets）在 `src/` 内当前全部零消费**，逐个标注"预留" |

> **这一项本身就是一条重要结论**：`evolvePlugin` 提供的 6 个服务**无一被消费**。它们构造开销极小、单测覆盖完整，属于"能力就绪、链路未接"。读到这些服务**不等于功能已生效**。

#### 🟡 P2 — 文档过期描述修正

| 文件 | 问题 | 处置 |
|---|---|---|
| `docs/ARCHITECTURE-ORGANISM.md` | 正文仍写「`src/llm/` client 多后端 http/**openclaw**/deepseek」，但 v2.5.0 已移除该底座 | 该行改为「自研 http 单底座 —— v2.5.0 起已移除 openclaw/deepseek 外部引擎」；并在文档头加**时效说明**（本文是 2026-08-21 快照，当前状态以 PROJECT-OVERVIEW.md 为准） |
| `docs/ABSORB-DEEPSEEK-HARNESS.md` | 提供 `npm run dsh:install` / `dsh:build` / `npm run dsh` 等**已不存在的可执行指令**，照做必然失败 | 文档头加 🚫 **已废弃（v2.5.0 起）** 标注，明确命令不可执行，仅作决策沿革留档 |
| `docs/EVALUATION-v1.1.1-全面评价.md` | 「多后端 http/openclaw/deepseek 三路回退」等描述与当前不符 | 加 📌 **历史归档** 标注：这些是 v1.1.x 时期的实况，保留以记录评价沿革 |
| `docs/ARCHITECTURE.md` / `docs/CONFIG.md` | — | 已正确注明 v2.5.0 移除，**无需改动** |

> 处置原则：**当前状态类文档**（ARCHITECTURE-ORGANISM）修正正文；**历史留档类文档**（ABSORB / EVALUATION）保留原文、只加时效标注 —— 改历史记录会破坏其证据价值。

#### ⏸ 未处理（有意保留）— `_prune` 硬删不落审计

`fact-store._prune()` 超 `max_facts`（1000）时的裁剪是**硬删**，而治理体系（`forget` / `clearLayer`）默认软删。当前分工是清晰的：**`_prune` 管"装不下的"，治理管"想忘的"**，两者不重叠，因此**不构成缺陷**。

若将来需要"任何记忆消失都可追溯"，可考虑给 `_prune` 补一条审计记录或改走软归档。**属增强项，本轮不动** —— 无实际痛点时不改可工作的设计。

### 6.4 项目优势（建议保持）

通读后的客观判断——以下设计确实做对了，是值得保留的资产：

1. **`src/core/policy.js` 的策略/执行分离**：依赖全注入、零 agent 引用、可独立测试。这是全项目工程质量最高的一块，工具循环的任何策略调整都不用碰 agent 主循环。
2. **`ToolCatalog.call()` 作为唯一收口**：把安全策略做成"架构不变量"而非"可选行为"——策略链先行、deny-wins 合并、审计注入、订阅者异常 fail-open + 熔断兜底，全部收敛在一个方法里。这个设计杜绝了"新增工具绕过安全检查"的可能性。
3. **`deny-wins` 决策合并**：安全策略一票否决且不可被低优先级覆盖，是为纵深防御留的正确接口。
4. **`isOverflowError` 的精细判定**：明确排除 `AbortError`、`400` 必须命中关键词才算 —— 避免了"任何 HTTP 400 都当上下文溢出然后无限裁剪"这类常见陷阱。
5. **非幂等工具不重试**：`callWithTimeoutRetry` 用 `isIdempotent` 守卫副作用安全，这是对"自动重试"危险性的正确认识。
6. **记忆衰减的 L4 差异化**：`0.005` vs `0.02`，四分之一衰减率，体现了"技能与闲聊事实生命周期不同"的领域理解。
7. **测试隔离纪律**：106 个测试文件全部使用临时目录，有 `datadir.test.js` 专项保障不污染生产数据。
8. **文档诚实度**：`ARCHITECTURE-ORGANISM.md` 主动记录自己"缺脊椎和右半脑"，并把每个缺口标注了落地日期与测试数 —— 这种自我批判式文档在开源项目里罕见。

### 6.5 验证方式汇总

| 检查项 | 命令 | 期望 |
|---|---|---|
| 全量测试 | `npm test` | **768 tests / 764 pass / 0 fail / 4 skip** |
| 自愈基准 | `npm run selfheal` | 7/7 100% |
| 审计链完整性 | `npm run audit:verify` | 链校验通过 |
| 内核启动 | `node -e "import('./src/agent/index.js').then(m=>{const a=new m.PPXAgent();console.log(a.tools.list().length);a.shutdown()})"` | 输出 `43` |
| 熔断可观测 | `agent.stats().policyGuard` | 正常时 `[]`，订阅者故障时列出非闭合项 |
| 界面静态自检 | `npm run web:check` | 无缺失资源 |
| 能力评测 | `npm run eval` | 7 项通过 |

### 6.6 已修复 — 用户实测驱动的第二轮（v2.7.1）

> 本章 6.1–6.3 来自**源码通读**；6.6 来自**扮演用户端到端实测**（Web / MCP / CLI / 真实 LLM / 跨进程记忆 / 安全边界）。
> 实测方法与原始证据见 `docs/USER-TEST-REPORT.md`。共发现 2×P1 + 3×P2，**全部修复**，测试 754 → **768 项（+14 回归守卫）**，0 失败。

#### 🔴 P1-1 用户提问被当作长期事实入库（记忆污染，实测污染率 40%）

**根因是一处"形同虚设的条件"**：

```js
// 修复前 (src/memory/fact-store.js)
if (clean.length <= 8 && /[?？]|几点|多少|什么|怎么|为什么|在哪|帮我|请|查一下/.test(clean)) return null;
```

正则本身没问题，但被 `clean.length <= 8` 前置 —— **只有 8 字以内的提问才会被拦**。实测中
「今天几号了现在」（9 字）、「帮我看看这个文件里写了什么内容」（15 字）全部畅通入库。
污染入口是 `src/memory/memory-ticker.js:98`：无 LLM 提炼器时，**整段用户原话**直接喂给 `addMemory()`。

**修复**：拆掉长度条件，改为四道**与长度无关**的句式判据 ——
① 问号/疑问助词/「来着」收尾；② 疑问词起手（允许「现在/今天」前缀）；③ 句中强制疑问词；④ 祈使句起手。
判据③ 特意**不收 `多少`** 这类可能出现在陈述中的词，避免「不管花多少钱都要做」被误杀。

> 记录一个取舍：这个过滤器是启发式，必然存在边界。选的是"宁可少收几条边缘陈述，也不要让提问污染长期记忆" —— 因为记忆是**越用越脏且会喂回上下文**的，而漏掉一条陈述的代价只是"那句话没被记住"。

#### 🔴 P1-2 自愈只认 `<root>/data`，不认实际 `dataDir`

`src/selfheal/healer.js:13` 把 `dataDir` 硬编码为 `path.join(rootDir, "data")`，而唯一的装配点
`src/plugin/builtin.js:58` 传进来的参数是 **`root`**（不是数据目录）。同文件第 71 行 `factsPlugin`
传的却是 `dataDir` —— 整个插件集里**只有 healer 一处这么写**。

**后果**：只要 `PPX_DATA_DIR` 或构造参数把数据目录指到别处（npm 安装形态走 `~/.ppx` 时就是这种情况），
自愈就会去 `root/data` 建一堆空目录、写 `integrity.json`、清理 `.tmp` ——
**真实数据目录永不体检，`root/data` 反而被反复重建**。属"静默失效"。

**修复**：`constructor(rootDir, dataDir = null)`，默认值保持旧行为；`healerPlugin` 改传 `ctx.consume("dataDir")`。
选默认值而非必填参数，是因为 `new Healer(root)` 在项目里有 **15 处**调用（`builtin.js` / `run.js` / 6 处测试 / 7 处 bench 脚本），改必填会波及一片。

#### 🟠 P2-1 本地意图回复泄漏内部标记与原始 JSON

`_localIntent()` 四处分支都是 `return \`[工具] ${await this.tools.call(...)}\``。用户输入「记住: X」
会收到 `[工具] {"ok":true,"id":"f_1a2b"}` —— 内部标记 + 原始 JSON 直接怼脸。

**修复**：新增 `_humanToolResult()` 做"外向化"（错误前缀 → 「没办成: …」；JSON → 抽载荷字段；
数组 → 逐项罗列），并给每个意图配自然话术（时间 → 「现在是 …」，记忆 → 「好, 记下了: X」）。
**这层只作用于"直接回给用户"的通道**，模型侧上下文里的工具结果仍保持原始保真。

#### 🟠 P2-2 静默回退，用户全程无感知

多 provider 回退本身工作正常（实测救场成功），但只在日志里 `warn` 一句，**用户端完全静默**。

**修复的难点不是加提示，而是"加在哪里不破坏既有约束"**：`test/chaos.test.js` 锁死了
`_llmWithFallback` 成功时必须返回**模型原文**。所以采用"旁路留痕 + 上层拼接"：

1. `_llmWithFallback` 只**记录** `_lastFallback` 并广播 `llm/fallback` 总线事件，**返回值不动**；
2. `chat()` 在 `persist`（写会话历史 + 记忆）**之后**才把提示拼到 `reply` 尾部；
3. `_shortReason()` 把原始错误归一为「鉴权失败 / 限流 / 超时 / 连接失败」—— 否则整段 JSON 报错体会喷给用户；
4. `chatStream()` 写历史前用 `_stripFallbackNotice()` 剥掉提示。

最终用户看到的是：`> ⚠ 主模型 deepseek-chat 不可用: 鉴权失败 (key 无效或已过期)。本轮回答已自动切换到 glm-5v-turbo。`

#### 🟠 P2-3 占位符模型被选为主模型，且校验器看不见它

`resolveLLM()` 选出的主模型是 **`YOUR_LOCAL_MODEL_NAME`** —— 配置模板里 lmstudio 的占位符，
指向没在运行的本地端点。因为 `base_url` 落在 `127.0.0.1`，`isLocal()` 判它"零配置可用"。

**根因不是"漏了一种写法"，而是同一个语义有三份正则且各自漂移**：

| 位置 | 原正则 | 能否匹配 `YOUR_LOCAL_MODEL_NAME` |
|---|---|---|
| `src/llm/router.js` | `/REPLACE_WITH_YOUR_\|YOUR_ENDPOINT\|YOUR_API_KEY\|sk-xxx\|<your_/i` | ❌ |
| `src/config/index.js` | `/REPLACE_WITH_\|your.?endpoint\|your[_-]?api[_-]?key/i` | ❌ |
| `src/config/providers.js` | `/REPLACE_WITH_\|your_?endpoint\|your[_-]?api[_-]?key/i` | ❌ |

三份都只认 endpoint / api_key 形态，**共同漏掉 `YOUR_*_MODEL`**。

**修复**：抽出 `src/config/placeholder.js` 作为**唯一真相源**（`PLACEHOLDER_RE` + `isPlaceholder` +
`hasPlaceholderField`），三处改为共用；`isUsableProvider` 同时校验 `model` 与 `base_url`；
`_warnMissingCloudApi` 原本自己手搓了一套"有本地/有云端 key"判定（既不看占位符也不看 model），
现改为复用路由的可用判定 —— **让"启动告警"与"实际选模型"共用一个口径**，并明确指出哪些条目还是占位符。

### 6.7 本轮验证方式

| 检查项 | 手段 | 结果 |
|---|---|---|
| 全量回归 | `npm test` | **768 / 764 pass / 0 fail / 4 skip**（5.7s） |
| 自愈基准 | `npm run selfheal` | **7/7 100%**（`new Healer(root)` 单参路径未被破坏） |
| P1-2 端到端 | 自定义 `dataDir` 启动内核 | `healer.dataDir == agent.dataDir`；`root/data` **未被创建**；真实目录 `memory/` 与 `integrity.json` 就位 |
| P2-3 端到端 | 屏蔽真实 key 后 `resolveLLM(真实 config)` | `lmstudio` 判不可用；`resolveLLM()` → `null`（修复前返回 `lmstudio/YOUR_LOCAL_MODEL_NAME`） |
| P2-2 端到端 | 强制主模型"健康通过但调用 401"，走真实 `chat()` | 回复尾出现 `> ⚠ 主模型 deepseek-chat 不可用: 鉴权失败 …`，并广播 `llm/fallback` 事件 |
| 记忆写入洁净性 | 回归测试断言 `recordTurn` 收到的文本 | 提示**不进**会话历史/记忆，下一轮上下文不被污染 |

> 一个过程中发现的**测试命令陷阱**（值得记下来）：诊断时用 `node --test test/*.test.js` 会出现"跑到某个点就再也不动"的假死，
> 一度误判为代码引入挂起。真实原因是项目 `npm test` 脚本里带了 **`--test-force-exit`** ——
> 缺少它时，遗留了句柄（未关闭的 server/timer）的测试进程会让父进程一直等下去。
> 加上该参数后同一套代码 **5.7 秒**跑完。**复现问题请一律用 `npm test`，不要手敲 `node --test`。**

---

## 7. 文档变更记录

| 版本 | 日期 | 变更 |
|---|---|---|
| v1.0 | 2026-09-17 | 首版：全量通读源码产出的项目说明文档 |
| v1.1 | 2026-09-17 | 第 6 章由"优化建议"改写为"优化执行记录"（7 项问题落地，754 项测试） |
| **v1.2** | 2026-09-17 | 新增 6.6 / 6.7：**用户实测驱动的 5 项修复**（P1-1 / P1-2 / P2-1 / P2-2 / P2-3），测试 754 → **768 项** |

---

*文档结束。本文所有结论均来自对 v2.7.1 源码的实测通读，未依赖 README 的自我陈述；凡与文档不符处已标注实测值。*
*2026-09-17 更新：第 6 章已从"建议"改写为"执行记录"；并补充 6.6 用户实测驱动的第二轮修复。*

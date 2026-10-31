# PPXANS-Harness 架构现状 (v4.0.0, 2026-10-30)

> 本文是**当前实际运行架构**的唯一权威快照, 覆盖 v2.x 基线 ([ARCHITECTURE.md](./ARCHITECTURE.md))
> 与 v3.0 设计稿 ([ARCHITECTURE-V3.md](./ARCHITECTURE-V3.md)) 之后到 v4.0.0 的全部落地变化。
> 约束不变: 纯 Node ≥20、零运行时依赖、自研 OpenAI 兼容 HTTP 底座。
> 历史文档讲"为什么这么设计", 本文讲"现在长什么样、数据怎么流"。

## 一图总览

```
┌──────────────────────── 通道层 ────────────────────────────┐
│  Web UI(public/)   CLI(cli.js)   飞书   微信   log   工作区  │
│  app.js + bot.js                (channels/*, ChannelManager)│
└──────────────┬──────────────────────────────────────────────┘
               │ HTTP: 静态资源 / /api/* / SSE /message/stream
┌──────────────▼──────────────────────────────────────────────┐
│  channels/http.js — Web 后端 + 鉴权(token) + 限幅 + 路由      │
├──────────────────────────────────────────────────────────────┤
│  protocol/  SQ 提交队列 + EQ 事件流(WAL) · Session/Task/Turn  │
├──────────────────────────────────────────────────────────────┤
│                 PPXAgent 内核 (src/agent/)                   │
│   chat/chatStream → policy(流式降级) → 工具循环/回退链        │
│   ┌───────────┬───────────┬───────────┬───────────┐          │
│   │ 记忆五层   │ 治理四件   │ 模式注册表 │ 军团+DAG   │          │
│   │ memory/   │ permissions│ mode/    │ orchestr.  │          │
│   └───────────┴───────────┴───────────┴───────────┘          │
├──────────────────────────────────────────────────────────────┤
│  llm/ — OpenAI 兼容客户端 (多 provider 回退链 + 思考强度注入)  │
└──────────────┬───────────────────────────────────────────────┘
               │ (旁路闭环, fire-and-forget)
┌──────────────▼───────────────────────────────────────────────┐
│ 进化体系: EvolutionEngine(行为) · SelfIterationEngine(代码)   │
│           EvolutionLoop(每日编排) · journal.jsonl(度量)       │
└───────────────────────────────────────────────────────────────┘
```

## 1. 进程与入口链

| 入口 | 命令 | 链路 |
|---|---|---|
| Web 应用 | `npm run web` / `bin/ppx-web.js` | → `src/server.js startServer()` → `new PPXAgent()` + `ChannelManager(agent)` → http 通道挂 8899 |
| 终端对话 | `npm run chat` | `src/cli.js` 直接驱动 agent |
| 渠道服务 | `bin/ppx-channels.js` | 按配置拉起飞书/微信等通道 |
| 手动进化 | `npm run evolve:loop` | `scripts/evolution-loop.js` 独立起一个 agent 跑一轮 (见 §6) |
| 配置/体检 | `ppx-setup` / `cli-doctor` | 引导配置与自检 |

启动横切件: `winutf8`(控制台 UTF-8) → `crashguard`(崩溃残留自检) → banner。HTTP 鉴权 token 持久化在 `data/http-token` (重启不换)。

## 2. Agent 装配五阶段 (`src/agent/index.js` 构造器)

1. **`_initPluginContainer`** — 一切皆插件: `Context` 容器 (`provide/consume`), 内置插件按依赖序注册 bus / healer / persona / facts / experience / legionBoard / sessions / memory(可换后端) / llm+allProviders / L0 记录器 / scenes / traces / audit / scheduler / shell / tools / modes / playbook。用户插件目录 (`config.plugins.dir`) 可覆盖任何一个。
2. **`_bindServices`** — 从容器 consume 成公开属性 (`this.llm` / `this.facts` / `this.sessions`…), 并挂权限能力门 → 工具系统; ** `_installUsageTracking()` 零侵入包装所有 provider 的 `chat/apiChat/streamChat/apiChatStream`** (记账 + 预算闸门 + `lastUsage` → Web 统计条)。
3. **`_wireANS`** — 神经系: 免疫闸门 (guard 拦截+审计)、Reward 闭环 (工具成败 → EWMA 行为倾向)、proactive 主动任务、边界/生命周期/驱逐/价值观 (ans/*)。
4. **`_initEngines`** — 编排引擎: 模式注册表、军团 (spawn_agent 多进程 worker + DAG)、SQUAD/experts、协议总线接线。
5. **`_initServices/_initStartup`** — 会话恢复、`installEvolutionLoop(agent)` (按配置挂每日进化定时任务)、审批面注册、mcp 连接。

热重载: `reloadProviders()` 重建 LLM 客户端后**必须**重装 usage 包装 (2026-10-30 修复, 此前切模型后统计失明); `reloadSettings()` 只刷内存不重建客户端。

## 3. 对话主链路 (流式)

```
POST /message/stream {message, sessionId, permission}
  → channels/http.js 鉴权/读取 → agent.chatStream()
    → supportsStream? 逐字流 (无工具 streamChat / 有工具 apiChatStream 工具循环)
      失败 → policy 兜底降级非流式 chat
  → SSE 事件流 (前端 public/app.js 消费):
     delta   正文增量           → renderMd 累积渲染
     step    第 N/M 轮推理      → 轮次提示 + 统计条 rounds
     tool    工具 start/finish  → 工具卡片 + 统计条 steps
     done    {content, tokens}  → 终稿; tokens{prompt,completion,cacheHit,cacheHitPct}
                                  → tokPill + 底部统计条 (tok · 缓存命中 · 上下文占用%)
     approval / plan / diff / error → 对应事件卡片
```

usage 事实链 (2026-10-30 修复后): `streamChat/apiChatStream` 请求带 `stream_options.include_usage` 并解析收尾 chunk → 客户端实例 `__ppxStreamUsage` → 记账包装读入 `agent.lastUsage` → done 事件 `_usageSnapshot()` 透传前端。纯文本聊天此前完全无 usage, 统计条永远空 —— 已修。

## 4. 子系统地图 (src/)

| 目录 | 职责 | 代表文件 |
|---|---|---|
| `agent/` | 内核编排 (装配/主循环/回退链/记忆接线) | index.js (+ context/prompt/evidence mixins) |
| `llm/` | OpenAI 兼容客户端: 多 provider、思考强度注入 (`_thinkParams`: 智谱/方舟 thinking、通义 enable_thinking、OpenAI reasoning_effort)、fence | client.js, providers.js, fence.js |
| `protocol/` | SQ/EQ 双队列 + Turn 模型 (codex 对齐) | — |
| `session/` | Session→Task→Turn 状态机, rollout JSONL 持久化, fork/rewind | — |
| `memory/` | 五层记忆: FactStore(L1 事实) / Experience(L2 经验) / session 日志 / MemoryTicker / 驱逐+生命周期 | fact-store.js, memory-ticker.js |
| `permissions/` | 能力门 + 审批流 (approval 卡片) | — |
| `bus/` | 运行时总线 + 熔断器 | circuit-breaker.js |
| `security/` | deny 规则 / PII 回复掩码 / 沙箱 | — |
| `audit/` | SHA-256 审计哈希链 + 验证 | audit-chain.js |
| `seam/` | 可替换接缝注册表 (shell 等) | — |
| `edit/` | SEARCH/REPLACE 编辑块解析 + 快照 | editblock.js, snapshot.js |
| `evidence/` `repomap/` `review/` | 证据入上下文 / 仓库地图 / OCR 分级审查 | — |
| `commands/` | 斜杠命令注册表 (/plan /task /review…) | — |
| `selfcode/` | **self_edit 引擎**: 补丁→备份→落盘→语法+测试→绿留红滚→账本 | engine.js |
| `selfheal/` | 崩溃残留清理 / 健康探测 / **EvolutionEngine (行为学习)** | evolve.js |
| `evolve/` | **SelfIterationEngine (代码自改进)** + **EvolutionLoop (每日编排)** | selfiterate.js, loop.js |
| `channels/` | http / feishu / wechat(+crypto) / log / workspace | http.js |
| `web/` | 本体形态 API (bot-api / bot-store) | — |
| `tools/` | 工具目录 (capabilities + riskLevel + 审批) | index.js, advanced.js(Scheduler) |
| `mcp/` | MCP 客户端 (stdio/http, namespace) | — |
| `plugin/` | Context 容器 + 内置插件 + manifest | builtin.js |

## 5. Web UI (`public/`, 零构建零依赖)

- **app.js** — 对话/工作台: 事件流渲染、命令面板、附件、语音、**composer**。
  - composer (2026-10-29 对齐图一重构): 20px 圆角浮起卡, 上输入下工具栏; 左 `+` 附件; 右「模型+思考强度」**座椅** (`#pillModel` + 紫色强度徽章) → `.seatcard` 浮层 = 模型行(→模型列表二级页) + 思考强度滑杆 (分段变色 蓝/紫/品红、闪光粒子、白色方块拇指、指针拖拽+键盘, 移植自 dsh-plugin-reasoning-seat); 圆形渐变发送钮。
  - 底部统计条: `N 轮 M 步 · X tok/s` | `tok · 缓存命中%` | `上下文占用%` (需要 provider 配 `context_window`)。
- **bot.js** — 本体/设置/轨迹三层视图 (与 app.js 分工: "对话页的 stream/composer 是 app.js 的地盘")。
- **app.css/bot.css** — 变量驱动, dark 优先 + light 主题; `[hidden]{display:none!important}` 全局兜底。
- 门禁: `npm run web:check` (scripts/check-web.mjs) — 图标 defs/引用、$() id 存在性、重复 id、JS 语法、关键 CSS 类、静态资源。

## 6. 进化体系 (自主变强闭环)

```
工具轨迹 (traces) ──┐
故障病历 (failures) ─┤→ EvolutionEngine (selfheal/evolve.js)
                     │    每 N 次调用: refine 失败→经验 · refineSkill 重复成功→技能
                     │
EvolutionLoop (evolve/loop.js, 每日 cron, 默认 03:30):
  Phase1 learn  弱点聚类 (同类病历≥3 定向 refine) + 常规提炼
  Phase2 iterate SelfIterationEngine: 跑 target_files 适应度测试
                红了才动手: LLM 诊断 → SEARCH/REPLACE → 备份→落盘→重验 → 绿留/红整体回滚
                护栏: 单飞锁 · 每轮 max_files · max_llm_calls(6) · allow_test_edit=false
  Phase3 journal data/evolve/journal.jsonl 每轮一条 (能力快照可画曲线)
self_edit 工具 (tools/selfcode.js) — 对话内改自己源码, 双门: 工具参数 mode=apply + config
self_rewind — 按账本 id 回滚到任意历史版本
```

**闸门现状 (config/ppx.json `agent.*`, 2026-10-30 全部打开)**:

| 键 | 值 | 控制点 |
|---|---|---|
| `self_code.mode` | `apply` | 对话内 self_edit 落盘许可 (双门之一) |
| `self_iteration.mode` | `apply` | 每日循环代码自改进的写盘许可 (**独立于 self_code 的第二把锁**) |
| `self_iteration.target_files` | 17 个适应度测试 | 循环的"健康定义"——只对跑挂的测试出手 |
| `evolve.enabled` | `true` | 行为学习引擎 (默认即开, 显式声明) |
| `evolution_loop.enabled/cron` | `true` / `03:30` | 每日编排定时任务 |

**适应度集选取原则** (2026-10-30 定): 文件必须 ①单跑全绿 ②**无 `--test-force-exit` 也能干净退出** (进化引擎裸跑 node --test)。全套 233 个测试文件中有遗留句柄泄漏的会挂住 → 对假失败烧 LLM 预算, 故只收录验证过的文件。当前 17 个覆盖: agent 核心 / 错误语义 / llm fence / 进化体系自身 / 记忆 / PII 安全 / 上下文裁剪 / 工具 / 重试 / 熔断 / 会话 / 自愈 / 配置 / 渠道。

## 7. 配置与事实源

- **唯一事实源 = `config/ppx.json`**: providers / channels / security / agent / llm / voice / tools。`src/config/settings.js` 白名单化读写 (备份→原子写→文件锁), `/api/settings`、`/api/llm` (POST provider/reasoning 热重载) 都走它。
- ⚠️ **多实例共写**: 多个 PPX 实例 (如常驻生产实例 + 测试实例) 共享同一份 `config/ppx.json`, `llm.reasoning` 等字段最后写者赢 —— 看到"配置和界面不一致"先查是否另一个实例写的, 不是 bug。
- API Key 走 `api_key_env` 环境变量引用, 配置文件里不落明文。

## 8. 测试与质量门

- 233 个测试文件 / ~1790 用例, `npm test` (带 `--test-force-exit` — 有历史测试留句柄, 见 §6; 逐个治理中)。
- `npm run web:check` 前端静态自检; `npm run verify` 聚合校验; `npm run evolve:loop -- --status` 进化报告。
- 2026-10-30 修复的 4 个句柄泄漏: `absorb.hermes` (Scheduler 读真实 data 目录重排定时器 → 改临时目录+shutdown)、`memory-query` / `context-eng-optimize` / `pii-reply-mask` (构造完整 PPXAgent 不 shutdown → 补 `finally { await a.shutdown(); }`)。修完后这 4 个从"挂住"变成可用适应度。

## 9. 已知约束 / 注意事项

1. 全量 `node --test test/` 裸跑会挂住 (句柄泄漏未清零) — 全量回归必须走 `npm test` (force-exit); 适应度集只收干净文件。
2. 双实例共写配置见 §7。
3. Web UI 统计条依赖 provider 配置 `context_window`, 未配置时第三段 (占用%) 自动隐藏。
4. `evolve:loop` 不带参数 = 用 config 目标 (2026-10-30 修复 `[]` 短路); 带文件参数则覆盖。

---

## 10. 热路径性能基线（2026-10-30）

> §1–§9 描述 v4.0.0 架构现状；本节是本轮性能优化的**实测记录**（优化项、前后数字、口径与边界）。
> 评审与"没做/建议"清单见 [OPTIMIZATION-2026-10-30.md](./OPTIMIZATION-2026-10-30.md)。

### 10.1 测什么

每轮 `agent.chat()` 的**内核固定开销**（stub LLM，零网络）：装配 system prompt、落会话事件、写记忆状态都发生在每轮，与用户问了什么无关。

### 10.2 口径（可复现，别跨机器引用绝对值）

| 项 | 值 |
|---|---|
| 工具 | `scripts/perf-hotpath.mjs`（本轮新增；`--json` 存档、`--repeat=3`） |
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
node scripts/perf-hotpath.mjs --json --repeat=3     # 当前代码
node --test --test-force-exit test/skills-scan-cache.test.js test/perf-memory-hotpath.test.js test/persona-read-cache.test.js
```

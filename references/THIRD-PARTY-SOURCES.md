# 外部参考项目来源说明

本目录不包含第三方源码，仅登记**非本仓库自研**项目的来源与获取方式。

PPXANS-Harness 是**零运行时依赖**的自包含项目：不接入任何第三方引擎，只保留自研的 OpenAI 兼容 HTTP 底座。第三方项目一律不复制进本仓库源码树——这既保持自包含定位，也避免上游许可证与体积污染。

---

## 1. openai/codex（未被吸收）

| 项 | 值 |
|---|---|
| 来源 | https://github.com/openai/codex |
| 性质 | OpenAI 官方 Codex CLI，**Rust / Bazel** 技术栈 |
| 规模 | 7,804 个受版本控制文件，约 111 MB |
| 为何不吸收 | 技术栈完全不同（Rust vs 纯 Node），无任何代码可复用；作为架构参考阅读即可，纳管源码只会让仓库体积膨胀两个数量级并引入无关许可证义务 |

**结论**：保留为独立原始仓库，不纳入 PPXANS-Harness。如需查阅请 clone 官方仓库。

---

## 2. deepseek-ai/deepseek-harness（未接入，仅吸收设计）

| 项 | 值 |
|---|---|
| 来源 | https://github.com/deepseek-ai/deepseek-harness |
| 性质 | DeepSeek 官方 Harness（pnpm monorepo + TypeScript） |
| 规模 | 10,319 个受版本控制文件 |
| 当前状态 | v2.5.0 起移除 `deepseek` / `dsh` 外部引擎后端，只保留自研 `http` 底座（沿革见 `src/llm/client.js` 文件头） |
| 为何不接入 | 上游是 TypeScript monorepo，与纯 Node 自研底座不同层；保留它会引入额外构建链与许可证义务 |
| 吸收的设计 | seam 三分法（§5）、事件源事实（§5、`src/utils/trace.js`）、会话即事实源（`src/memory/session.js`） |

**结论**：不复制源码、不设运行时依赖，只在设计层吸收；落地位置见 §5 与 §7。

---

## 3. 已吸收的自研项目

| 项目 | 版本 | 处理方式 |
|---|---|---|
| `../ppx-agent` | v1.6.0 | **合并基座**——整体作为 PPXANS-Harness 的代码基底 |
| `../ppx-v2`（ppx Harness） | v0.4.0 | **能力吸收**——抽取独有能力移植，不整仓合并（详见 `MERGE-REPORT.md`） |

---

## 5. P0 (2026-09-15) 借鉴登记 — Aegis / HookBus / dsh / ACE 设计思想

> 仅借鉴**设计思想**，未复制任何源码；全部用皮皮虾自有结构重写。新增能力对应的实现文件见下表。

| 借鉴来源 | 借鉴点 | 皮皮虾自研实现 |
|---|---|---|
| Aegis / HookBus（UK Patent GB2608069.7 论文描述） | Deny-Wins 策略合并：任一高优先级 deny 一票否决，安全策略不可被低优先级 allow 投票覆盖 | `src/tools/catalog.js` 的 `addPolicySubscriber()` + `consolidateDecisions()` |
| Aegis / HookBus | 订阅者熔断器三态（Closed/Open/Half-Open），防故障订阅者拖垮工具链 | `src/bus/circuit-breaker.js`（新增，基础设施层，区别于 agent 探索熔断） |
| deepseek-harness / dsh | seam 三分法注册表：Service Definition / Provider / Consumer，一行换实现 | `src/seam/registry.js`（新增，与既有 `src/seam/shell.js`、`src/tools/seam.js` 互补） |
| dsh | 事件源事实（model-visible = logged）：会话日志是模型可见内容的唯一事实源 | `src/utils/trace.js` 新增 turn/step 边界事件 + `verifyReplay()` 不变量断言 |
| MERGE-REPORT 遗留 P2 | guard 免疫闸门空转（工具走 catalog 不走总线） | `src/ans/guard.js` 新增 `installGuardOnCatalog()`，guard 接入 ToolCatalog 策略链，与总线版共享状态 |
| ACE（ICLR 2026，agentic-context-engineering） | 语境即 Playbook：bullets + Generator/Reflector/Curator + 增量 delta 合并 + grow-and-refine | `src/evolve/playbook.js`（applyDelta / growAndRefine / createGate / renderBullets） |
| HanaAgent（openhanako） | 记忆管线健康监控（healthy/degraded + 分步失败计数 + 降级） | `src/services/memory-health.js`（MemoryHealthMonitor） |
| ReLoop / Vial / Aegis | 故障记忆：结构化失败 episode + 相似检索 + 元学习命中 | `src/memory/failure-episode.js`（FailureEpisodeStore） |
| Hermes 生产数据（51 工具 MCP 服务器工具名碰撞） | MCP 命名空间隔离：serverName__toolName 前缀 + 精确匹配短路 | `src/mcp/index.js` 的 `serverLabel()` / `namespacedMcpName()`，描述清洗增危险 flag 剔除 |
| TencentDB-Agent-Memory | 符号画布记忆：任务状态画成 Mermaid 图，node_id 全链路追踪（上层结构、下层证据） | `src/memory/canvas.js`（buildCanvasFromEvents / toMermaid / CanvasStore） |
| HanaAgent（openhanako） | 会话 fork 基线：子代理带记忆快照，结束 merge/discard | `src/memory/fork.js`（exportMemorySnapshot / mergeSnapshotBack） |
| HanaAgent（openhanako） | 插件两级权限：restricted / full-access | `src/plugin/context.js` 的 SENSITIVE_SERVICES + `src/plugin/index.js` 的 compose 权限装配 |
| LangGraph supervisor 拓扑 / OpenAI Agents SDK handoff | supervisor 模式：监督者分解→派发→评审→修正循环 | `src/orchestrator/supervisor.js`（runSupervisor / findDisagreement / judgeRound） |
| TencentDB-Agent-Memory | 记忆资产中枢：资产登记 + 可见性 + 装备（loadout）+ 使用计数 | `src/memory/asset-hub.js`（AssetHub） |

---

## 4. 未吸收的重复副本

| 目录 | 判定 | 证据 |
|---|---|---|
| `../ppx Harness` | **ppx-agent 在 v1.5.1 的旧快照，不合并** | 其 remote 与 ppx-agent 完全相同（`chen6896qqwee/ppx-agent.git`），版本号 1.5.1 < 1.6.0，且缺少 v1.6.0 的 `src/core/policy.js`、`src/core/trace.js`、`src/services/*` |

合并旧快照会导致 v1.6.0 的四刀重构成果被覆盖回退，因此明确排除。该目录可自行删除或留作历史对照。

---

## 6. 2026-10-24 加固批次借鉴登记（零依赖吸收, 源码未复制）

| 来源 | 吸收的思想/算法 | 落地 |
|---|---|---|
| [ljharb/shell-quote](https://github.com/ljharb/shell-quote) (MIT) / [vorpaljs/bash-parser](https://github.com/vorpaljs/bash-parser) (MIT) | "先分词后分析"的 shell 命令结构化解析：引号/转义感知分词 → 简单命令段 → 逐段 argv0 校验；命令替换/进程替换视为代码执行构造 | `src/security/shell-parse.js`（tokenizeShell / parseShellCommand，自研实现），接入 `src/tools/command-guard.js` |
| [niieani/gpt-tokenizer](https://github.com/niieani/gpt-tokenizer) (MIT) | 离线 BPE tokenizer 可作为高精度估算插件注入 | `src/utils/text.js` 的 `setTokenEstimator(fn)` 插拔点；默认内置分语言启发式（CJK≈0.85 token/字, ASCII≈0.25 token/字符），不引 BPE 词表保零依赖 |
| 飞书开放平台官方文档（Encrypt Key 加密配置 / 事件签名） | AES-256-CBC（key=SHA256(encrypt_key), IV=密文前16字节, PKCS7）事件解密；X-Lark-Signature = sha256(ts+nonce+body+key)；event_id 防重放 | `src/channels/feishu.js`（feishuDecrypt / feishuSign / event 去重缓存） |
| ACE (ICLR 2026, agentic-context-engineering) | delta 生产者闭环：经验教训 → 增量 ADD → 门禁 → 注入 | `src/evolve/delta-producer.js`（recordLesson / categorizeFailure），接入 LearningService.refine 与 agent 失败总线（Playbook 首次有了写入端） |
| HMAC 审计链通行实践（git commit 签名同思想） | 链外密钥 HMAC 锚定每行 hash，防"能写文件者整链重算" | `src/audit/audit-chain.js`（sig 字段 + loadOrCreateHmacKey，密钥 env PPX_AUDIT_HMAC_KEY > <root>/.ppx/audit-hmac-key） |
| 特征哈希（feature hashing, Weinberger et al.） | 零模型文本向量：字符 n-gram FNV-1a 双哈希定桶定符号 + 亚线性词频 + L2 | `src/memory/hash-embedder.js`（语义检索默认兜底通道）；向量落盘缓存 `src/memory/vector-disk.js`（内容哈希失效键 + embedder 指纹换代作废） |

---

## 7. 2026-10-27 自改代码批次借鉴登记（零依赖吸收, 源码未复制）

本批次目标只有一个：**让皮皮虾能自己改自己的代码，且改得可验证、可回滚、有账可查**。
下列项目均未复制任何源码，只吸收设计与思想，用皮皮虾自有结构重写。

### 7.1 GitHub 上重名的两个 `dsh-bot`

| 项 | wqty123/dsh-bot | aitcmhk-web/DSH-bot |
|---|---|---|
| 定位 | DSH 的**常驻智能体实体**（不属于任何会话） | DSH 的 **Telegram/微信桥接插件** |
| 关键设计 | 实体状态存 `$DSH_HOME/bot/`；记忆是 `.md` 文件树而非向量库；根文件常驻上下文、子目录只贡献「名字 + 一行描述」；每条记忆带 origin 标签（user/agent/tool）；记忆有年龄，过期标 stale；任务队列 + 可选执行器，空闲默认不动；**越界操作进 `awaiting`，是一等状态而非错误分支**，停下时给出工具名与完整参数 | 一个 bot 绑定一个工作区；handoff 记忆接续（重启/新会话续上进度）；远程审批卡片（允许一次/拒绝）；语音转文字；命令集 `/whoami /status /model /new /restart /help` |
| 皮皮虾对应的既有能力 | 五层记忆 + `provenance.js` 的来源分级（tier）已覆盖「带来源标签」；`src/memory/*` 的分层已覆盖「结构分层」 | `src/channels/`（feishu / wechat / http / workspace）已覆盖通道入口；`src/permissions/` 已覆盖审批 |
| 本批次实际吸收的点 | ① **「停下等待」是合法状态**，不是异常 —— 落地为自改的 `propose` 模式（只出 diff 不动盘，等人放行）② **动作前留可恢复快照**，账本必须活过进程重启 —— 落地为 `src/selfcode/ledger.js` 的磁盘账本 + 备份目录 ③ **记忆有年龄/不确定就记 `-1`** 的诚实语义 —— 落地为自改账本里 `durationMs`/`verify.summary` 缺失时留空而不猜 | ① **改动必须能续上**：`pending-reload.json` 让「已落盘未生效」跨进程可见 ② **远程审批面向具体动作**（工具名 + 完整参数），而非面向类别 —— 落地为 `self_edit` 回执里直接给文件、增删行数与失败测试名 |

> **为什么不把这两个仓库拷进源码树**：PPXANS-Harness 的硬定位是零运行时依赖的自包含内核。
> 拷进来等于同时引入两套外部约定、两份许可证义务和数倍体积，而它们能提供的东西已经用
> 150 行自有代码覆盖了。这也是本文件第 1、2 节的同一条纪律。

### 7.2 DeepSeek 开源推理框架 DeepInfer（serving 层，不同层，未接入）

| 项 | 值 |
|---|---|
| 仓库 | https://github.com/deepseek-ai/DeepInfer （Apache-2.0，2026-10-20 开源） |
| 配套 | https://github.com/deepseek-ai/deepseek-recipe （生产级 token 编解码，与官方 API 对齐） |
| 性质 | V4.1-Flash 线上推理框架：优化算子（FlashMLA/DeepGEMM/DeepEP/TileKernels）、Prefill/Decode 分离、DSpark 投机解码 + 置信度调度验证、SWA Bounded Replay（只回放有界后缀）、批不变推理、确定性采样、结构化输出 |
| 硬件 | NVIDIA SM100 / 华为昇腾 950；未开源的部分：KVCache 管理与负载均衡 |
| 为何**不接入** | 它是 **模型服务层**（Python/CUDA/CANN，跑在 GPU/NPU 上），皮皮虾是 **agent 编排层**（纯 Node）。两者不在同一层，硬接只会得到一个装不上的依赖。官方线上数据（单集群 155 万亿 token/天、平均 96% 输入命中缓存）也属于其自身基础设施口径，与本项目无因果关系 |
| 吸收的思想 | ① **只重算有界后缀**（SWA Bounded Replay）→ 自改验证只重跑**受影响的测试文件**，不全量回归 ② **批不变 / 结果可复现** → 自改在同一补丁同一测试下结论必须是确定的，账本记 `verify.summary` 供复算 ③ **投机解码 + 置信度调度** → `propose` 模式先给低成本预览（diff），人对高风险改动再决定是否进 `apply` |

### 7.3 本批次新增文件与对应思想

| 新增文件 | 职责 | 对应思想来源 |
|---|---|---|
| `src/selfcode/ledger.js` | 磁盘账本（append-only jsonl）+ 改动前备份 + 待生效清单 | wqty123/dsh-bot「实体状态存盘、活过会话」 |
| `src/selfcode/verify.js` | 三关验证：语法 / 行为 / 边界；路径禁区与测试文件保护 | DeepInfer「只验受影响范围」+ 本仓库既有的「修代码不修考卷」纪律 |
| `src/selfcode/engine.js` | 解析 → 边界 → 原子落盘 → 验证 → 绿留红滚 → 记账 → 待生效标记 | aitcmhk-web/DSH-bot「改动要能续上」+ wqty123「停下是合法状态」（propose） |
| `src/tools/selfcode.js` | `self_edit` / `self_verify` / `self_rewind` (+ 账本并入 `evolution_status`, CLI `npm run selfcode`) | wqty123「审批面向具体动作」：回执给文件、增删行数、失败测试名 |
| `test/selfcode.test.js` | 12 项不变量：propose 不动盘 / 绿保留 / 双红回滚 / 多块原子 / 逃逸拒 / 记考试卷拒 / rewind / 双门 | — |

**顺带修掉的一个真实缺陷**：`node --check some.js` 在文件含 `export` 但目录链上缺 `type:"module"` 时**退出码为 0**（Node 识别 ESM 语法后切换解析器，该路径不回报语法错误）。手工验证：同样内容 `.mjs` 正确报错，`.js` 静默放行。自改常发生在临时夹具目录，若沿用原写法语法关等于形同虚设 —— `verify.js` 现对 `.js` 先复制为同目录临时 `.mjs` 再校验。

---

## 8. 2026-10-27 前端换骨批次借鉴登记（零依赖吸收, 源码未复制）

本批次目标：**把 Web 前端从「会话工作台」改成以「常驻本体」为中心的 bot 面板形态**。
参照 [wqty123/dsh-bot](https://github.com/wqty123/dsh-bot) 的界面结构，但它的 `client.js`
依赖 React + `window.__ModuleLoader__.load()` + DSH 私有包（那是 DSH web profile 插件的壳）。
皮皮虾是零依赖 vanilla 单页，照搬等于凭空引入一个装不上的运行时，因此**源码一行未取**，
只吸收信息架构与三处设计取舍，用自有 DOM/CSS 重写。

### 8.1 吸收的取舍（这是本批次真正的收获）

| dsh-bot 的做法 | 背后的判断 | 皮皮虾落地 |
|---|---|---|
| 头像**不戴**状态环 | 状态环是「仪表盘思维」：一屏十几个环，人眼分不清哪个在动。状态属于**文字**，不属于装饰 | `.avavt` 只画头像；状态点走 `.bsub::before`，由 `[data-tone]` 驱动，且只出现在名字下面一行 |
| 说明文字**不加框** | 每段话都套一个 card，边界一多，读者会先看见框再看字 | 首页类型卡只给「类型选择」加框（那里框有语义：可选）；已有本体的说明是裸文本 |
| 服务健康**三态** ok / warn / unknown | 「没人看过」≠「没问题」。二态设计会把未探测说成健康，这是撒谎 | `src/web/bot-api.js` 的 `toneOf()` 返回 error/waiting/quiet/warn/ok；取不到的字段一律 `null`，前端渲染 `—` 而不是 `0` |

### 8.2 结构映射（dsh-bot 栏目 → 皮皮虾视图）

| dsh-bot | 皮皮虾 | 说明 |
|---|---|---|
| 本体首页（头像 / 名字 / 一句话 / 今日日程） | `#view-home` | 上半是「按类型开工」，下半是已有本体列表；**不提供「再建一个」**，因为一个进程只绑一个 root，多开是 `ppx-web --port` 的事 |
| 对话 + 轨迹双页签 | `#view-chat` 的 `#pane-talk` / `#pane-trace` | 轨迹不是「日志尾巴」，是双源合并：`logs/traces/<day>.jsonl`（工具调用）+ `events-<day>.jsonl`（结构化事件），可按天回翻 |
| 设置页（身份 / 主动 / 记忆 / 权限） | `#view-settings`，13 个分节 | 全部走 `/api/bot.manage` 单入口 + `BotStore.apply()` 动作白名单；白名单外的 action 直接 400，不靠前端自觉 |
| 服务状态条 | 侧栏底部 `#svcRows` | 三态点 + 文字，数据来自 `/api/health/summary` 与 provider 探测，不编 |

### 8.3 本批次新增/重写文件

| 文件 | 职责 | 对应取舍 |
|---|---|---|
| `src/web/bot-store.js`（353 行） | 本体档案持久化 `data/bots/profile.json`；坏 JSON → `.broken` 备份 + 退回默认；`normalize()` 补字段/纠类型/夹数值 | 档案是「活过进程重启的东西」，读坏不能连带把好数据一起毁掉 |
| `src/web/bot-api.js`（391 行） | `buildBotState` / `buildTraces` / `applyBotAction` / `handleBotApi`；只读聚合，取不到就 `null` | 8.1 的「unknown 是一等状态」 |
| `public/bot.js`（922 行） | 三层视图渲染 + 5 秒轮询 + `window.PPXBOT` 对外接口 | 三态状态点；`—` 而非 `0` |
| `public/bot.css`（238 行） | 只新增类，不改老类；`.view/.view.on` 切屏 | 8.1 的「少加框」 |
| `public/index.html`（511 行，重写） | sprite **字节保持不变**（CSP sha256 强耦合）+ 三层视图骨架 | — |
| `test/bot-api.test.js` | 13 项：默认派生 / 坏 JSON 恢复 / settings 夹取 / 内置类型保护 / 悬空类型回落 / 头像校验 / 双源合并 / 401 / 改名落盘 / 翻历史 | — |

### 8.4 顺带修掉的两个真实缺陷

1. **CSP 拦掉引导数据**（潜伏已久）。`renderIndex()` 注入的
   `<script>window.__PPX_BOOTSTRAP__={...时间戳...}</script>` 是页面里第二个可执行内联脚本，
   哈希每次都变，必被 `script-src sha256-...` 拦掉。此前一直被 `app.js` 的 401 兜底掩盖。
   → 改为 `<script type="application/json" id="ppx-boot">`（不可执行的 JSON 节点）+ 前端 `bootData()` 解析，
   页面只剩主题脚本一个可执行内联脚本。`test/security-headers.test.js` 新增一项钉死。
2. **重复 id 导致设置页永久空白**。抽屉里已有 `id="settingsBody"`，新容器用了同名 id，
   `getElementById` 只返回第一个（`display:none`），`clientHeight` 恒为 0，**控制台无任何报错**。
   → 改名 `#botSettings`；`scripts/check-web.mjs` 增加重复 id 检查（218 个 id 全查）。

> 同 7.1 的纪律：**不拷源码**。这里能省的是一整套 React 构建链与 DSH 私有模块加载器，
> 换来的界面复杂度由 4 个 vanilla 文件（约 1600 行）承担，且不需要任何 `npm install` 前置。

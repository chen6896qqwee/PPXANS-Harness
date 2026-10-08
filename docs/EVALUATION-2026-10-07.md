# 皮皮虾（PPXANS-Harness）评估报告

**版本**：v3.2.2 ・ **评估日期**：2026-10-07 ・ **方法**：GitHub 对标检索 + 本地实测 + 8 维加权评分
**总分：83 / 100**（加权，8 个维度）

---

## 0. 一句话结论

皮皮虾在全球 Agent Harness 赛道里占的是一个**几乎无人占的格子**：**零运行时依赖 + 个人 Agent + 中文全栈 + 自带治理与审计**。
它的短板不在"功能少"，而集中在三处：**文档漂移**（README 数字已落后实测 3 个版本）、**协作层缺少真实长任务压测**、**生态接入仍靠手工**。
按"任务成功率 × 泛化 × 成本 × 安全"的能力框架看，它在**成本**（零依赖、5355 tok 固定开销）与**安全**（deny-wins + 审计链 + 能力边界）两项上是第一梯队，在**任务成功率实证**上还缺一份能对外讲的基准。

---

## 1. 实测基线（本报告全部数字均为本地实跑，非引用）

| 指标 | 实测值 | 采集方式 |
|---|---|---|
| 源码规模 | **163 个 JS 文件 / 32569 行** | 递归统计 `src/**/*.js` |
| 测试规模 | **187 个测试文件 / 26176 行** | 递归统计 `test/**/*.test.js` |
| 测试结果 | **1543 项 / 1539 通过 / 0 失败 / 4 skip**（69.9s） | `npm test` |
| 自愈基准 | **7/7（100%）** | `node scripts/selfheal-bench.js` |
| 内置工具 | **85 个具名工具**（88 处 `register` 调用，3 处覆盖注册） | 静态解析 `src/**` register 块 |
| 核心 schema | 26 个常驻，其余按需 `enable_capability` | `scripts/ctx-profile.js` |
| 固定上下文开销 | **5355 tok/请求**（工具 schema 3337 + `_context()` 2018） | `node scripts/ctx-profile.js` |
| 技能库 | **56 个 SKILL.md，12/12 能力域 100% 覆盖** | 递归统计 + `skill_coverage` |
| 专家体系 | 23 专家 · 10 班组 × 5 拓扑 · **10 个专家包** · 17 档人格 | 模块导出计数 |
| 运行时依赖 | **`package.json` 里根本没有 `dependencies` 字段** | 直接读文件 |
| engines | `node >=20` | package.json |
| 可执行入口 | 6 个 bin：`ppx / ppxans / ppx-web / ppx-serve / ppx-channels / ppx-setup` | package.json |
| 数据资产 | 24 个 scripts · 20 篇 docs · 10 个专家包 manifest | 目录统计 |

**模块行数 TOP 10**（看得出钱花在哪）：

| 模块 | 行数 | 模块 | 行数 |
|---|---:|---|---:|
| tools | 5631 | utils | 997 |
| memory | 5150 | config | 865 |
| agent | 2827 | services | 846 |
| orchestrator | 2617 | llm | 816 |
| channels | 1887 | ans | 763 |
| mcp | 1672 | permissions | 687 |
| skills | 1080 | verify / core / plugin | 608 / 586 / 576 |

---

## 2. GitHub 对标盘（18 个项目，本次实检索）

检索式：`agent harness in:name,description` + `ai agent in:name,description` + `personal ai assistant`，候选池 **58 个**，取 18 个拉详细指标。

| 项目 | ★ | 语言 | 许可 | 最近推送 | 定位 |
|---|---:|---|---|---|---|
| affaan-m/ECC | 274496 | JS | MIT | 10-05 | agent harness 性能优化系统（skills/instincts/memory/security） |
| NousResearch/hermes-agent | 251786 | Python | MIT | 10-07 | "The agent that grows with you" |
| addyosmani/agent-skills | 102287 | JS | MIT | 10-03 | 生产级工程技能集（**本次已吸收 18 个**） |
| mem0ai/mem0 | 66749 | Python | Apache-2.0 | 10-06 | Agent 记忆层（基础设施） |
| crewAIInc/crewAI | 59412 | Python | MIT | 10-07 | 角色扮演多 Agent 编排框架 |
| aaif-goose/goose | 55028 | Rust | Apache-2.0 | 10-07 | 可扩展 AI agent，超越代码补全 |
| **zhayujie/CowAgent** | **47259** | Python | MIT | 10-06 | **开源个人 AI 助手 & Agent Harness**（最可比） |
| tinyhumansai/openhuman | 41517 | Rust | GPL-3.0 | 10-07 | 最快最省的个人 agent harness，local-first |
| wshobson/agents | 40265 | Python | MIT | 10-05 | 多 harness 插件市场 |
| langchain-ai/deepagents | 29983 | Python | MIT | 10-07 | "The batteries-included agent harness" |
| 1jehuang/jcode | 20331 | Rust | MIT | 10-07 | Rust 高性能 coding agent harness |
| HKUDS/OpenHarness | 15917 | Python | MIT | 06-04 | 开放 Agent Harness + 内置个人 Agent |
| mindfold-ai/Trellis | 14877 | TS | AGPL-3.0 | 09-29 | "The best agent harness" |
| OrchestratorInc/agent-orchestrator | 12856 | Go | Apache-2.0 | 10-07 | 编排 coding agent 团队，接任意 harness |
| MemTensor/MemOS | 11741 | TS | Apache-2.0 | 09-29 | 自进化记忆 OS |
| aden-hive/hive | 11091 | Python | Apache-2.0 | 10-07 | 生产级多 Agent Harness |
| revfactory/harness | 9129 | — | Apache-2.0 | 09-28 | 设计领域专属 agent 团队的元技能 |
| **TencentCloud/Octop** | **7575** | Python | MIT | 10-06 | 自托管 AI 助手，多用户多 Agent（**本次已吸收**） |

### 定位矩阵：皮皮虾站在哪一格

| 维度 | 主流赛道分布 | 皮皮虾 |
|---|---|---|
| 目标形态 | 60%+ 是 **coding agent harness**（jcode/Trellis/goose/agent-orchestrator） | **个人全能 Agent**（与 CowAgent / Octop / openhuman 同格） |
| 依赖策略 | 几乎全部重依赖（Python SDK / Rust crate / langgraph） | **零运行时依赖，纯 Node 内建** |
| 语言与受众 | 全英文，无中文内容资产 | **全中文技能库 + 中文人格 + 中文专家包** |
| 治理深度 | 多数为事后日志 | **事前边界 + 事中 deny-wins 拦截 + 事后 SHA-256 审计链** |
| 记忆 | 多数靠外部向量库 | **BM25 主导 + 可插拔 dense embedder**（零依赖下自建） |
| 协作 | crewAI 式角色编排 / orchestrator 式 git worktree | **班组×拓扑 + 专家包 + 常驻房间（异步派工回叫）** |
| 生态协议 | MCP 客户端为主 | **MCP server + client 双向** |

**结论**：皮皮虾不在这 18 个项目的正面战场上打；它的可比对手只有 CowAgent、Octop、openhuman 三个，且在这三个里它是唯一"零依赖 + 治理/审计前置"的。

---

## 3. 八维加权评分

| # | 维度 | 权重 | 得分 | 加权 | 等级 |
|---|---|---:|---:|---:|---|
| 1 | 架构与模块化 | 15% | 82 | 12.30 | 🟢 强 |
| 2 | 记忆与知识 | 14% | 84 | 11.76 | 🟢 强 |
| 3 | 工具与生态 | 13% | 78 | 10.14 | 🟠 中 |
| 4 | 多 Agent 协作 | 14% | 84 | 11.76 | 🟢 强 |
| 5 | 权限与治理 | 13% | 86 | 11.18 | 🟢 最强项 |
| 6 | 可测试性与 CI | 11% | 84 | 9.24 | 🟢 强 |
| 7 | 内容资产与可增长性 | 10% | 76 | 7.60 | 🟠 中 |
| 8 | 工程克制与零依赖 | 10% | 92 | 9.20 | 🟢 差异化 |
| | **合计** | **100%** | | **83.18 → 83** | |

---

### 维度 1：架构与模块化 — 82/100

| 证据 | 值 |
|---|---|
| 顶层模块数 | **33 个**（tools/memory/agent/orchestrator/channels/mcp/skills/ans/permissions/verify/evolve/audit/…） |
| 最大模块 | tools 5631 行 / memory 5150 行 |
| 分层清晰度 | `core → plugin → agent → tools/orchestrator` 装配链，依赖单向 |
| 插件机制 | `src/plugin/builtin.js` 提供 18 个插件，`ctx.provide/consume` 解耦 |

**加分**：模块边界干净，装配走 DI 容器而非直接 import；`seam.js`（158 行）作为显式接缝层，避免跨层偷渡。
**扣分根因**：
- 🔵 33 个顶层目录偏碎，`session/commands/security/persona`（344/148/115/29 行）这类小模块可以并入邻域，新增贡献者的心智负担高。
- 🔵 `tools`（5631）与 `memory`（5150）两个模块占源码 33%，是明显的"胖模块"，改动时的 blast radius 大。
- 🔵 缺少一份"模块依赖图"的自动化守卫——现在只能靠 review 人工保证单向。

**对策**：补一个 `scripts/arch-guard.js`，从静态 import 提取模块依赖边，断言 `core` 不被任何上层反向引用、断言无环；同时把 4 个小模块并入邻域（P1）。

---

### 维度 2：记忆与知识 — 84/100

| 证据 | 值 |
|---|---|
| 层次 | L0–L4 五层（l0/l2/l3 + session + compaction） |
| 检索 | **BM25 主导**（IDF + 长度归一）+ 子串强信号 + 高斯时效衰减 + 命中权重；**可插拔 dense embedder**（`fact-store.js:108`，默认 null 即纯 BM25） |
| 生命周期 | 事实带有效期、软删可回滚（`memory_restore` / `memory_list_deleted`）、装不下才裁剪（compaction + eviction） |
| 溯源 | `provenance.js` 记录来源；`fork.js` 支持记忆分叉 |
| 经验沉淀 | `experience.js` + `failure-episode.js`（失败→经验→技能升级 `refineSkill`） |
| 后端 | `sqlite-store.js`（`node:sqlite`）+ `backend-migrate.js` |

**加分**：在零依赖约束下自建 BM25 而不是砍掉语义检索，还留了 dense embedder 插口——这是"克制但不自残"的正确做法。
**扣分根因**：
- 🟠 **dense embedder 默认关闭**，实际检索质量等于纯关键词；对"说法不同但意思相同"的召回无解。开它需要外部向量源，与零依赖有张力。
- 🔵 `memory` 模块 5150 行，17 个文件，缺少跨层一致性测试（L0 写入后 L3 何时可见）。
- 🔵 记忆冲突消解规则不可观测——两条矛盾事实并存时谁赢，没有对外的断言。

**对策**：给 `fact-store` 补一组"矛盾事实"回归用例并把消解规则写进 `docs/ARCHITECTURE.md`；dense 通道做成"可选 provider + 检测到即启用"的降级路径（P1）。

---

### 维度 3：工具与生态 — 78/100（本维度评分最低的两项之一）

| 证据 | 值 |
|---|---|
| 内置工具 | **85 个**具名工具 |
| 渐进披露 | 26 个核心 schema 常驻（3337 tok），其余按需加载 |
| MCP | **server + client 双向**（`src/mcp/server.js` / `client.js`，1672 行） |
| 技能导入 | `skill_import`（GitHub，限 40 文件 / 4MB / 20s 超时，白名单域名防 SSRF） |
| 专家包安装 | `expert_pack_install`（60 文件 / 4MB，扩展名白名单） |
| 通道 | feishu / wechat / http / workspace / log 五通道 |

**扣分根因**：
- 🟠 **没有在线市场**。`wshobson/agents`（40265★）、`addyosmani/agent-skills`（102287★）这类项目的核心卖点就是"一句话装技能/插件"。皮皮虾装技能要手工给 GitHub repo ref，且**没有索引、没有搜索、没有评分**——这是"能装"和"好用"的差距。
- 🟠 **无 A2A / 跨进程协议**。只有 MCP 与自有 legion。CowAgent、Octop 同类也没有，但 `agent-orchestrator`（12856★）靠"接任意 harness"拿到生态位。
- 🔵 85 个工具里**没有版本化**：工具签名变了没有 deprecation 通道，外部 MCP 客户端会静默断。

**对策**：做一个**离线技能索引** `skills/index.json`（id + 域 + 描述 + 校验和），`skill_search` 先查本地索引、未命中再走 GitHub；工具 schema 加 `deprecated` 标记与替代名映射（P1）。

---

### 维度 4：多 Agent 协作 — 84/100

| 证据 | 值 |
|---|---|
| 专家 | 23 员（含 medical/legal/finance/compliance/security 五个高风险只读专家） |
| 班组 | **10 个班组 × 5 种拓扑**（parallel / pipeline / supervisor / debate / review） |
| 专家包 | **10 个内置包**（manifest + SOUL.md），`manifest.skills` 只存引用不拷内容 |
| 人格 | 17 档 MBTI（16 型 + `_default`），四轴 × 六项行为映射；custom 只追加不覆盖 |
| 常驻房间 | 六态 inbox（queued/running/replying/done/failed/cancelled）；**按 callee 并发**（同成员串行、跨成员并行）；**回叫闭环**（composeFollowup → 主持人收口 → onReply）；**在途账本**（有活时 `TEAM_MEMBER_BUSY` 拒移成员） |
| 并发治理 | `ConcurrencyGovernor` 进程级单例：`acquire(n)` 批量原子、`release()` 幂等、`setLimit()` 运行期可调、FIFO 队列 |
| 会话键 | `<agent>:<surface>:<session>:<dm\|group>` 四段编码 + 反解析；房间键 `房间~成员` |

**加分**：这一层是本次两轮优化的主战场，"按 callee 并发 + 在途账本 + 回叫闭环"三条从 Octop 吸收的契约全部有测试覆盖，`team-room.test.js` 25 项。
**扣分根因**：
- 🟠 **零真实长任务压测**。全部是单元/桩测试；班组在 8 小时级任务上会不会有成员饿死、房间状态膨胀、主持人上下文溢出——没有数据。
- 🟠 ** governor 只管本进程**。`spawn_agent` 起的是子进程，跨进程的全局配额没有兜底。
- 🔵 拓扑选择靠调用方指定，`supervisor` 不会根据实际负载在拓扑间自适应切换。

**对策**：补一个 `bench/team-longrun.js` 用桩 LLM 跑 100 任务 × 5 拓扑，输出吞吐/饿死率/峰值并发三张表；`governor` 加一层跨进程配额文件锁（P0/P1）。

---

### 维度 5：权限与治理 — 86/100（最强项）

| 证据 | 值 |
|---|---|
| 决策模型 | `permissions/intersection.js` — **deny-wins** 交集决策 |
| 硬边界 | `ans/boundary.js` 六条常驻静态区（事实/推断分开、不越权、隐私最小化、法律伦理红线、成本受预算、物理世界有限） |
| 动态护栏 | 五个高风险域（medical / legal / finance / security / compliance）关键词命中才注入，**闲聊零成本** |
| 事后验证 | `verify/postcondition.js` 工具后置条件校验 |
| 审计 | `audit/audit-chain.js` — append-only + SHA-256 链式，篡改可定位到行；`npm run audit:verify` |
| 熔断 | `ans/guard.js` + `aml-server.js`（210 行）+ `seam.js` |
| 高风险专家 | 5 个专家带 `readonly: true` + `requiresHuman: true` |

**加分**：这是 18 个对标项目里**几乎没人做**的一层。多数 harness 的"安全"止于"不让跑 rm -rf"，皮皮虾把"我做不到什么"直接写进 system 指令区，且动态护栏的成本设计（不命中不注入）是对的。
**扣分根因**：
- 🟠 **审计链实测为空**（`audit-verify` 输出"条数: 0"）。链式防篡改的机制在，但本次评估的环境里没有一条真实记录，说明默认路径下审计可能未默认开启或落点分散。
- 🟠 关键词正则护栏天然可绕过（换个说法就不命中），缺一层语义级判定兜底。
- 🔵 `requiresHuman` 的人工确认通道在 CLI / Web / 通道三种 surface 上的行为是否一致，无跨端测试。

**对策**：P0 查清审计落点并让默认会话必写；护栏加一层"低置信度即按高风险处理"的默认保守策略。

---

### 维度 6：可测试性与 CI — 84/100

| 证据 | 值 |
|---|---|
| 测试 | **187 文件 / 26176 行 / 1543 项**（1539 通过 / 0 失败 / 4 skip，69.9s） |
| 测试/源码比 | **0.80**（26176 / 32569） |
| CI 矩阵 | **ubuntu + windows 双 OS**，node **20 / 22 / 24** 三版本（Windows-first 项目的正确选择） |
| CI 七道闸门 | test → skill-lint → ctx-profile --check → cache-audit --check → selfheal-bench → audit-verify → bench/falsify |
| 反证门禁 | `bench/falsify.js` — 判分器必须"参考解判正 + 全部变异体判负"，**不给 `\|\| true`，不给豁免开关** |
| 前缀缓存守卫 | `cache-audit.js` 真跑多轮会话断言四条不变量，离线零密钥 |

**加分**：**falsify 反证门禁**是这批对标项目里我没见过的东西——它防的不是"测试挂了"，是"测试恒过"。`ctx-profile` 与 `cache-audit` 两道闸门分别守"字节数"和"字节内容"，覆盖了单看预算看不出的缓存失效。
**扣分根因**：
- 🟠 **无覆盖率门禁**。`npm test` 没有 `--experimental-test-coverage` + 阈值断言，1543 项通过不等于关键路径被覆盖。
- 🟠 真实 LLM 路径仍靠桩，`eval` 脚本的实际通过率没进 CI（只在 `prepublishOnly` 里跑）。
- 🔵 4 个 skip 未标注原因与解禁条件。

**对策**：加覆盖率门禁（建议全局 60% / `permissions`+`audit`+`governor` 90%）；把 `npm run eval` 的一个子集搬进 CI 作为 smoke（P1）。

---

### 维度 7：内容资产与可增长性 — 76/100（最低分）

| 证据 | 值 |
|---|---|
| 技能 | **56 个 SKILL.md**，12/12 能力域 100% 覆盖（自研 27 + anthropics 导入 18 + 原有 11） |
| 名册开销 | 全量 56 个技能名册仅 **354 tok**（按能力域分组，只列名字） |
| 专家包 | 10 个（general-assistant / ai-coding-coach / ops-engineer / aigc-showrunner / prompt-engineer / data-analyst / multi-agent-orchestrator / legal-reviewer / financial-analyst / parenting-companion） |
| 人格 | 17 档 MBTI |
| 自增长 | `refine` / `refine_skill` / `playbook` / `failure-episode` |
| 文档 | 20 篇 docs |

**扣分根因（这一维度扣得最狠，且全是自伤）**：
- 🔴 **README 数字漂移**。README 仍写"1440 项测试 / 4285 tok / 64 内置工具 / 23 个核心 schema"，实测是 **1543 / 5355 / 85 / 26**。三处数字全错，且 badge 也错（`tests-1440_passing`）。外人第一眼看到的就是这张脸。
- 🟠 **技能质量参差**。56 个里 18 个是第三方导入（英文、流程/验证段缺失，lint 已降级为 warning）；剩下 38 个中只有 27 个自研的含完整"流程 / 反合理化 / 验证"三段。
- 🟠 **专家包只有 10 个且全是内置**，无用户贡献路径的文档说明。
- 🔵 20 篇 docs 里 6 篇是历史审计/评价文档（EVALUATION-v1.1.0 / v1.1.1 / AUDIT-2026-09-17 …），新读者分不清哪篇是准的。

**对策**：**P0 修 README 数字**并加一个 `scripts/readme-sync-check.js` 让 CI 兜住（README 里的数字必须来自实测，不许手写）。

---

### 维度 8：工程克制与零依赖 — 92/100（差异化最高分）

| 证据 | 值 |
|---|---|
| 依赖 | `package.json` **完全没有 `dependencies` 字段**，`devDependencies` 也没有 |
| 实现 | 全部 Node 内建（`node:fs` / `node:path` / `node:os` / 内建 `fetch` / `node:sqlite`） |
| 运行 | `node bin/ppx-web.js` 直接起，**没有 `npm install` 这一步** |
| 分发 | `package:portable` / `package:installer` 两种打包 |
| 约束传导 | 零依赖这条约束**逼出了**自建 BM25、自建 importer、自建 SSE/MCP——每一个都是"本来可以 pip install 但选择自己写" |

**加分**：这是 18 个对标项目里**唯一**做到零运行时依赖的。CowAgent（Py）、Octop（Py）、openhuman（Rust，但 crate 一堆）、deepagents（langgraph）全都重依赖。
**扣分根因**：
- 🟠 **代价真实存在**：没有成熟向量库（dense 通道默认关）、没有官方 SDK（各家 LLM 兼容层自己维护）、没有现成的 YAML/TOML 解析器（配置只能 JSON）。这不是设计失误，是取舍，但必须承认它压住了维度 2 和维度 3 的天花板。
- 🔵 `node:sqlite` 在 node 20 上是实验性的，`engines: >=20` 的承诺与稳定 API 之间有缝（CI 已用 node 20 验一次，但实机行为没写进文档）。

**对策**：在 README 明确写出"零依赖换来了什么、代价是什么"，别让新用户到用的时候才发现（P1）。

---

## 4. 与最可比对手的逐项差异

只挑**同格**的三个 + 两个专项冠军（其余是 coding harness，不同赛道，比了没意义）：

| 能力 | 皮皮虾 | CowAgent (47k★) | Octop (7.6k★) | openhuman (41k★) | mem0 (66k★) |
|---|---|---|---|---|---|
| 零运行时依赖 | ✅ **唯一** | ❌ Py 生态 | ❌ Py 生态 | ❌ Rust crates | ❌ Py SDK |
| 个人 Agent 定位 | ✅ | ✅ | ✅ | ✅ | ❌（纯记忆层） |
| 中文内容资产 | ✅ **56 技能全中文+18 英文** | ❌ | ❌ | ❌ | ❌ |
| 多 Agent 协作 | ✅ 10 班组×5 拓扑 + 常驻房间 | 部分 | ✅ 多用户多 Agent | ✅ 编排 | ❌ |
| 记忆层次 | ✅ 五层 + BM25 + 可插拔 dense | ✅ 自进化记忆 | ✅ 长期记忆 | ✅ second-brain | ✅ **专项最强** |
| 治理/审计 | ✅ **deny-wins + SHA-256 链 + 六条硬边界** | ❌ | ❌ | ❌ | ❌ |
| MCP 双向 | ✅ server + client | 部分 | 部分 | ✅ | ❌ |
| 生态市场 | ❌ **无** | 部分 | 部分 | 部分 | ❌ |
| 社区规模 | ❌ 起步 | ✅ 47k★ | ✅ 7.6k★ | ✅ 41k★ | ✅ 66k★ |

**读法**：皮皮虾在"工程纵深"（治理、审计、零依赖）上领先，在"生态与社区"上落后。这两件事的改善速度完全不同——前者靠自己写代码，后者靠时间和曝光。所以 P0 应该全部押在**自己能改的**那一侧。

---

## 5. 改进项（P0 / P1 / P2）

### 🔴 P0 — 下次发布前必须做

| # | 项 | 根因 | 对策 | 复验 |
|---|---|---|---|---|
| P0-1 | **README 数字全面漂移** | 数字手写、无闸门 | 改 README 为实测值（1543 / 5355 / 85 / 26），新增 `scripts/readme-sync-check.js` 进 CI | CI 红即阻断 |
| P0-2 | **审计链实测为空** | 默认会话未落审计或落点分散 | 查清 `audit-chain` 写入触发点，断言"任意一次工具调用后链非空"并加测试 | `npm run audit:verify` 条数 > 0 |
| P0-3 | **并发治理只覆盖本进程** | `spawn_agent` 起子进程绕开 governor | 加跨进程配额（共享状态文件 + 原子锁）或明确降级为"软约束"并写进文档 | `bench/team-longrun` 实测峰值不超 limit |

### 🟠 P1 — 两个版本内

| # | 项 | 对策 |
|---|---|---|
| P1-1 | 协作层零真实压测 | 新增 `bench/team-longrun.js`：100 任务 × 5 拓扑，输出吞吐 / 饿死率 / 峰值并发表 |
| P1-2 | 无覆盖率门禁 | CI 加 `--experimental-test-coverage` + 阈值（全局 60%，`permissions`/`audit`/`governor` 90%） |
| P1-3 | 装技能靠手工 | 离线索引 `skills/index.json`（id/域/描述/校验和），`skill_search` 先本地后 GitHub |
| P1-4 | 关键词护栏可绕过 | 加"低置信度按高风险处理"保守兜底 |
| P1-5 | dense 检索默认关 | 做成"检测到 provider 即启用"的自动降级通道 |
| P1-6 | 模块数偏碎 / 胖模块 | 4 个小模块并入邻域；新增 `scripts/arch-guard.js` 断言依赖单向无环 |
| P1-7 | 零依赖代价未披露 | README 增补"零依赖换来了什么、代价是什么"章节 |
| P1-8 | 工具无版本化 | schema 加 `deprecated` + 替代名映射 |

### 🔵 P2 — 有空再说

| # | 项 |
|---|---|
| P2-1 | 拓扑自适应：supervisor 按负载在 5 种拓扑间切换 |
| P2-2 | 6 篇历史审计/评价文档归档到 `docs/archive/` |
| P2-3 | 4 个 skip 测试标注原因与解禁条件 |
| P2-4 | 专家包用户贡献路径文档 |
| P2-5 | A2A 协议探针（先只读监听，不投入实现） |

---

## 6. 诚实清单（这次没做的 / 做不到的）

| 项 | 说明 |
|---|---|
| **没跑 `npm run eval`** | eval 需要真实 LLM 密钥，本次评估全程离线。1543 项测试与 7/7 自愈是实测，eval 分数**未采集**，报告里不写这个数 |
| **没跑真实长任务** | 班组/房间的 84 分全部基于设计完整度 + 桩测试，**没有真实 8 小时任务的实证**。这个分是"设计分"，不是"实测分" |
| **对标项目只读了元数据** | 18 个项目的 README 只拉了 3 份（ECC / CowAgent / openhuman），功能对比基于 description + topics + 定位推断，**没有逐个读源码**。涉及实现细节的对比可能不准 |
| **star 数不代表质量** | hermes-agent 251786★ / 47723 open issues，ECC 274496★——这批项目的 star 数与其工程严谨度无因果关系，本报告只用它做"社区规模"一维的证据 |
| **83 分是主观加权** | 权重是我按"个人 Agent"定位定的；若按"coding agent harness"定位，工具/生态权重上升，总分会掉到 ~76 |
| **审计链"完整但 0 条"** | 机制存在且校验通过，但**没有数据**。这条不能算作"治理已生效"的证据 |

---

## 7. to-dos for human

| # | 动作 | 为什么需要你 |
|---|---|---|
| 1 | **确认 P0 三件事的优先级** | P0-1（README）我可以自己做完；P0-2（审计落点）和 P0-3（跨进程配额）涉及架构取舍，需要你点头 |
| 2 | **决定要不要一个真实 eval 基线** | 现在对外讲不出"任务成功率"。要跑就得配密钥、跑一批任务、把分数固化成基准。你说了算 |
| 3 | **决定生态策略** | 是继续"零依赖孤勇者"，还是开一个受控的"可选依赖通道"（比如 dense 检索允许装一个包但不进主依赖）。这决定维度 3 能不能上 85 |
| 4 | **指定哪篇 docs 是 canonical** | 20 篇里 3 篇评价文档（本文档 + v1.1.0 + v1.1.1）会打架。建议保留最新一篇，其余归档 |
| 5 | git 处置 | 按你的一贯约定，**本次未执行任何 `git commit`**，改动全在工作区 |

---

## 附：评估可复现命令

```bash
cd PPXANS-Harness
npm test                        # 1543 项
node scripts/selfheal-bench.js  # 7/7
node scripts/ctx-profile.js     # 5355 tok
node scripts/audit-verify.js    # 链完整性
node scripts/skill-lint.js      # 56 技能
```

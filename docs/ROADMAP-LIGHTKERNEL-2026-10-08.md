# 轻内核愿景差距评估与强化路线 (2026-10-08)

> 输入: 用户提供的开源全能 Agent 架构愿景 (轻内核重生态 / 一切皆插件 / 标准协议 / 社区共建)。
> 方法: 每一项判定都对照当前代码核实过, 不给"设计分"—— 分层给结论, 已达成/部分达成/未达成。

## 一、现状对照 (v3.2.3, 逐项核实)

| 愿景支柱 | 皮皮虾现状 | 判定 |
|---|---|---|
| 内核四件事 (注册/路由/仲裁/生命周期) | 能力注册 (capability seam) + 工具目录 + 治理内核 (deny-wins/熔断/配额) + agent 生命周期/crashguard | ✅ 基本达成, 见缺口 1 |
| 一切皆插件 | `src/plugin` 装配器 (compose/loadPlugins/access 声明) + 技能库 (66 个, manifest 式 SKILL.md) + 专家包 | 🟡 部分: 工具/技能/专家可插, 但**记忆/沙箱/会话/存储仍是硬编码子系统** (见缺口 2) |
| 插件契约 (manifest/schema) | 技能有 skill-lint 契约校验; 工具有参数校验器; 但**插件本体无 manifest 文件**, 契约靠代码约定 | 🟡 部分, 见缺口 3 |
| 标准协议 (MCP) | MCP client + server 双向齐备, `ppx-channels` CLI | ✅ 达成 (对齐愿景的连接器层) |
| 一键体验 | 双 PC 安装包 (内置 Node, 不写注册表) + 启动向导; **Dockerfile 本轮新增** | ✅ 达成 (安装包 Linux 可构建, 本轮打通) |
| 评估体系 | taskbench 基准 (20 任务) + eval (无 key 可跑) + 红队 9 向量 + selfheal 7/7 门禁 + readme-sync/ctx-profile 等 7 道闸门 | ✅ 达成, 但缺**公开可复现的榜单跑法** (见缺口 5) |
| 社区基建 | CONTRIBUTING (含零依赖铁律) + SECURITY + 行为规范 + issue 模板 (.github) | 🟡 部分: 缺 good first issue 标签动作和 CONTRIBUTORS (见缺口 6) |

## 二、六个缺口 (按投入产出排序)

### 缺口 1: 内核行数没有"预算"概念 (轻内核的度量)
愿景说"内核代码尽量少, 每一行都要有理由"。现状没有度量, 就无法防止回胖。
- **动作**: `scripts/arch-guard.js` 增加内核体积基线 (core/agent/plugin 三目录总行数), 超基线 5% 报警; README 晒出"内核行数 vs 插件生态行数"比值。
- 工作量: 半天。这是把愿景变成可执行约束的关键一步。

### 缺口 2: 记忆/存储/会话未插槽化 (最重的重构)
`src/memory` 五层 + sqlite 双实现是硬接线进 agent 的, 不可替换。
- **不建议一步到位**: 这是架构级手术, 收益 (社区可贡献 Qdrant/Redis 后端) 与风险 (记忆回归面巨大) 不成比例, 且违背"小步快改"哲学。
- **建议分三步**: ① 先抽接口 (MemoryStore trait 式接口 + 现有实现为默认插件) ② 技能侧副本 (skills/ppx-memory) 同步改 ③ 再放行第三方后端。每步都要全量回归 + 漂移守卫。
- 工作量: 每步一个独立迭代窗口, 不进例行优化轮。

### 缺口 3: 插件 manifest 缺失
技能有 SKILL.md 契约, 但代码级插件 (plugin) 靠 `compose()` 顺序约定, 无声明式清单。
- **动作**: 插件目录支持 `plugin.json` (name/version/access/requires 声明), `loadPlugins` 读取并校验; 无 manifest 的旧插件按内置白名单兼容。
- 工作量: 1-2 天。这是"社区按契约贡献"的前提——没契约, 贡献者只能读源码猜行为。

### 缺口 4: 沙箱硬编码 (愿景里的"沙箱即插件")
现沙箱策略 (READ_ONLY/WORKSPACE_WRITE/DANGER_FULL_ACCESS) 是权限预设枚举, 不是可插拔执行后端。对 Node 单进程架构来说, 完整沙箱插件化性价比低, **建议只做**: 允许 `run_command` 的执行前缀可配 (如包一层 firejail/nsjail 命令), 这就把"换沙箱"变成换配置字符串。
- 工作量: 半天。

### 缺口 5: 公开可复现跑法 (公信力缺口, 与用户既有判断一致)
基准脚本齐备但对外讲不出数: 无"一条命令跑出与你 README 一致的数字"的公开口径。
- **动作**: `scripts/taskbench.js --full` 加 `--report-json` 输出机器可读结果 + README 徽章链接到 JSON; CI 夜间跑, 结果存 `bench/results/`。
- 工作量: 1 天。这是把"设计分"换"实测分"的基建, 比任何功能都值钱。

### 缺口 6: 社区动作 (代码之外)
- issue 模板已有, **缺动作**: 给现有 backlog 打 `good first issue` / `help wanted` 标签 (GitHub 侧操作, 需仓库权限)。
- 建 `CONTRIBUTORS.md` 并在 release note 致谢。
- 中文文档已有基础 (README 双语结构), 缺 Hermes 式的"上手 5 分钟"中文首屏——现有 QUICKSTART 可做入口。

## 五、缺口落地进度 (随迭代更新)

| 缺口 | 状态 | 落地 |
|---|---|---|
| 1 内核行数预算 | ✅ 2026-10-08 | arch-guard 内核预算闸门 (core/plugin/utils/config 四目录, 超预算告警 / 超 20% 失败) |
| 3 插件 manifest | ✅ 2026-10-08 | `ppx.plugin.json` 目录式插件契约 (name/entry/access 声明式; 穿越防线 + 非法 access fail-closed; 散文件行为不变); 守卫 test/plugin-manifest.test.js |
| 4 沙箱前缀可配 | ⛔ 评估后关闭 | runInSandbox 的 timeout/heap 已参数化, 权限侧已有具名预设 (PERMISSION_PRESETS)——剩余"可配化"无真实需求, 为可配而可配会扩大安全面 |
| 5 公开跑法 | ✅ 2026-10-08 | taskbench `--report-json` + CI nightly-bench |
| 2 记忆插槽化 | 🟧 第一步完成 | ①`memory.backend` 插槽 (2026-10-09): config.memory.backend + `memoryBackend:<名>` 工厂契约, compose 后统一切换, 工厂缺失/抛错 fail-safe 回退默认——第三方后端接入点就位。②抽 trait 接口 (MemoryStore 接口 + 现有实现为默认插件) 待独立迭代窗口 |
| 6 社区动作 | ⏳ 等仓库侧 | 需 GitHub 权限 |

## 三、本轮已落地 (对应愿景)

| 项 | 产出 |
|---|---|
| 一键体验 (Linux 构建线) | package.js 去 PowerShell 硬编码, POSIX 回退 (unzip/zip), Linux CI/容器可出双包 |
| 一键体验 (Docker) | Dockerfile + .dockerignore (非 root / 数据卷 / healthcheck; 密钥与运行数据不进镜像层) |
| 打包安全加固 | ppx.json.bak-* 与技能 .bak-* 排除规则 (实测抓到配置备份被打进发布物) |
| 技能生态 (+10) | 见 CHANGELOG v3.2.3: addyosmani 8 个 + superpowers 2 个, 与自研去重 |

## 四、不建议做的 (诚实边界)
- **全面插件化一步到位**: 12 子系统 90%+ 的成熟度是靠"每步全量回归"换来的, 大手术风险 > 收益。
- **追求 star 数的功能堆叠**: 愿景本身就说"全能不是靠塞功能"。skill 库 66 个已接近 top-K 名册的压力测试边界 (5800 tok 预算), 再加技能前先过 ctx-profile。

## 六、v3.3 候选清单 (2026-10-09 全面评价后固化, 按杠杆率排序)

> 依据: 2026-10-09 六维评价 (工程质量 A- / 功能完整性 B+ / 生态成熟度 C+)。
> 核心结论: 瓶颈不在代码在生态破冰。每项附验收标准, 完成即打勾。

| # | 项 | 动作 | 验收标准 | 状态 |
|---|---|---|---|---|
| 1 | 公开基准跑通 | 配 GitHub Secrets → nightly-bench 首跑 | Actions 产出首份 benchmark 报告 (taskbench 20 任务 + report-json), README 挂徽章 | ⏳ 等仓库侧 |
| 2 | 插件生态种草 | 写 2-3 个 manifest 示范插件 (如 qdrant 记忆后端走 memory.backend 插槽 / 一个 restricted 权限样例) | plugins/ 有可安装样例; README 链接; 插槽契约有真实消费方 | 🟧 1/3 —— A-Mem 记忆后端已落地 (plugins/amem-memory, 2026-10-09, 论文锚点 NeurIPS 2025 arXiv 2502.12110; 守卫 5 项 test/amem-plugin.test.js) |
| 3 | 英文首屏 | README 英文版首屏 (对照中文首屏裁剪) + QUICKSTART 英文 | HN/Reddit launch 材料可直接引用 | 🟧 大部分 —— README 英文段 (既有) + docs/QUICKSTART-EN.md 全流程英文上手 (2026-10-09); 剩余: 全量 README 翻译与截图英文版 |
| 4 | 记忆 trait 接口 | 缺口 2 第②步: MemoryStore 接口 + 现有实现注册为默认插件 | 全量回归 0 失败; memory.backend=default 经 trait 分发; 第三方可实现接口 | ⏳ 独立迭代窗口 |
| 5 | Windows CI 矩阵 | Actions 加 windows-latest 跑测试矩阵 (发布物仍 Linux 构建) | windows 矩阵绿; 跨平台 bug (v3.2.3 修过 2 个) 从此 CI 先报 | ⏳ |
| 6 | ~~记忆检索 BM25 化~~ 撤销改向 | **复核发现 facts.query 已是 BM25**（初评四轴漏检）—— 改为: 语义检索接入（embedder 钩子已预留，需可选依赖本地模型） | 降级为观察项，待有真实换说法召回需求再启动 | ⏸ 观察项 |

### 不做 (评价重申, 防回头)
- 图编排 / 多 agent 编排层: 单 agent + 技能模式够用, 为对齐 LangGraph 而做违背轻内核定调
- 沙箱可配化: 已有据关闭 (缺口 4), 不重开

## 七、研究前沿 → 落地映射 (2026-10-09 论文扫描, 供 v3.3/v3.4 取材)

> 方法: 顶级会议/高引论文 → 只取能映射到皮皮虾现有子系统增量动作的条目。每条附论文锚点与落地位置。

| 论文 | 核心机制 | 皮皮虾映射 | 动作 | 优先级 |
|---|---|---|---|---|
| A-Mem (NeurIPS 2025, arXiv 2502.12110) | Zettelkasten 式记忆卡片: 新记忆触发邻居卡片链接与内容演化 | 记忆后端插槽 (memory.backend) 已就位 | **插槽首个真实消费方**: A-Mem 式链接演化作为第三方后端示范插件 —— 与 v3.3 #2 插件样例合并做, 一石二鸟 | 🟧 高 |
| ACE (ICLR 2026, arXiv 2510.04618) | Generator/Reflector/Curator 三角色进化 playbook 上下文 (delta 更新 + grow-and-refine) | evolve 子系统已有 playbook/refine/reflector 雏形 | 对照 ACE 三角色查差距: delta 更新与去重合并是否完备 (avoid context collapse); playbook 进化质量基准 (eval.js 扩展) | 🟧 高 |
| LLM Agent Memory 机制演进综述 (ACL 2026 Findings, arXiv 2605.06716) | 记忆演化分类学: 写入/遗忘/检索/演化四轴 | 五层记忆 + TTL 软归档 + provenance | **✅ 四轴自评已做 (2026-10-09, docs/MEMORY-FOUR-AXIS-SELF-CHECK.md)**: 写入A/遗忘A-/检索C+/演化B- —— 最弱轴确认为检索; 零依赖 BM25 打分列入 v3.3 候选 | ✅ |
| 长期记忆安全综述 (arXiv 2604.16548) | 记忆投毒/越权读取/跨会话泄漏攻击面 | fact 治理 + tombstone + 审计链已有 | 做一次记忆攻击面自查 (投毒: memory_add 来自工具调用是否可被 prompt injection 利用), 有洞补守卫 | 🟨 中 |
| Agentic Tool Use 综述 (arXiv 2604.00835) | 工具创建/工具进化 (agent 自己写工具) | code_act + create_skill 已有自造能力 | 低成本增强: 自造工具的 postcondition 校验已有 (P2), 补"工具质量回归"——自造工具入库前跑一遍最小用例 | 🟩 低 |
| Repo-To-Skill (BAAI, arXiv 2609.02749) | A=(M,H,K) 三层公式; 仓库→技能自动蒸馏; SKILL.md/references/scripts 三层 + progressive disclosure + 验证后入库; MLE-bench +134% 只换 K | 77 技能已是同构三层格式; 白名单导入+验证闭环同源; 检索精度瓶颈同病 | **✅ 设计被规模化验证**: 远期唯一真差距是 Creator 自动蒸馏流水线 (人工选材→自动); 列 v3.4+ 候选 | ✅ 已验证 |
| alibaba/skill-up (开源, Apache 2.0) | 技能评测进化闭环: 声明式用例 + with/without 对照 + 失败驱动修复 + 回归用例 + CI 门禁 | taskbench (任务级) + --check-regression + --learn 已有; 缺技能级对照实验 | **✅ A/B 对照首环已落地 (2026-10-09)**: PPX_DISABLE_SKILLS 注册表钩子 + skill-eval.js 声明式用例 (JSONC) + rule_based 三判分器; 首份真实报告 Δ0 (用例天花板效应, 诚实记录 → 下一步: 超出模型先验的难题库 + agent_judge) | ✅ 首环落地 |
| professor-synapse (3.4k★ 开源) | 专家调度: 名册匹配失败→领域研究员调研→自动建档→持久复用 (越用越厚) | EXPERTS 名册+专家包已双层 | **✅ 可生长名册已落地 (2026-10-09)**: 用户专家库 (user-experts.json) + opt-in 自动建档 autoCreateExpert + 高危域中文闸门; 守卫 5 项 test/user-experts.test.js | ✅ 已落地 |

### 诚实排除 (论文热点但与轻内核定调冲突)
- **Agentic RL (arXiv 2509.02547)**: 需要训练管线与算力, 单机零依赖项目不碰。
- **GUI Agents (arXiv 2412.13501)**: 桌面自动化是另一条产品线, 违背"单 agent + 技能"收口期纪律。
- **多智能体协作框架**: 与 v3.3 "不做"清单一回事, 不重开。

## 八、评测体系 v2 (2026-10-09, GPA/AgentEval/T-SAIAS 对照落地)

> 方法: 业界评测方法论 → 全部映射为确定性代码 (零 LLM 裁判, 防"文本像不像"陷阱)。

| 项 | 落地 | 状态 |
|---|---|---|
| 轨迹评分器 (GPA 化) | taskbench `scoreTrajectory` + `TASK_PLANS` oracle 工具计划表: 计划遵循度/工具错误率/冗余度/唯一工具数, 聚合进 report schema 2 (`summary.gpa`) | ✅ |
| 判分器可证伪 (扰动/对抗) | bench/falsify.js 已在 CI 双 OS 矩阵门禁 (既有, 确认就位) | ✅ (既有) |
| 分级自评 | docs/AGENT-GRADING-L1-L4.md: T/SAIAS L2+ (接近 L3), L3 差距=扰动集标准化 | ✅ |
| 主观任务 LLM-Judge | 可选层, 仅写作类任务; 显式标注"文本层判断"不与确定性判分混权 | ⏳ 设计位 |
| 扰动集标准化进 nightly | chaos/mutants 重组为标准扰动用例集, 报告单列通过率 | ⏳ v3.3 |

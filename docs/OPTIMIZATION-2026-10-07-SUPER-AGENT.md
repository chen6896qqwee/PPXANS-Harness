# PPXANS-Harness → 全能超级 Agent 深度优化报告

> 日期: 2026-10-07 ｜ 基线: v3.2.2 (f8b0363) ｜ 目标: 把 GitHub 通用 Agent 技能内置进 PPX, 支持最大子智能体并发可调, 补齐"全能超级 Agent"的九维能力面
> 全程零运行时依赖纯 Node 约束未破 (无新增 npm 依赖)

---

## 0. TL;DR

| 指标 | 改造前 | 改造后 | 证据 |
|---|---|---|---|
| 内置技能 | 11 个 (单根扁平目录) | **56 个** (12 个能力域全覆盖) | `skill_coverage` / `registry.coverage()` |
| 能力域覆盖 | 0/12 (无域概念) | **12/12 = 100%** | `test/skills-registry.test.js` |
| 子智能体并发 | 硬编码 8, 每实例独立, 嵌套委派乘法爆炸 | **进程级配额, 运行期可调** | `test/governor.test.js` (10 用例) |
| 单次派发宽度 | 硬编码 | 配置化 (`per_call`), 与全局配额解耦 | `governor.effPerCall()` |
| 专家名册 | 9 个通用工程角色 | **23 个** (含 5 个高风险域只读专家) | `expert_list` |
| 班组/协作拓扑 | 无 (只有 review/supervisor 两个开关) | **10 个班组 × 5 种拓扑** | `team_list` |
| 能力边界护栏 | 无 (只有价值观) | 6 条硬边界 + 5 个高风险域人审 | `src/ans/boundary.js` |
| 测试 | 1440 项 | **1503 项** (新增 63) | `npm test` |
| 固定上下文开销 | 3976 tok | 5351 tok (预算闸门 5800) | `ctx-profile.js --check` |

一句话: **技能从"12 个示例"变成"一个可增长、可导入、按能力域组织的内置库"; 并发从"每层各持一份的假上限"变成"进程级真配额 + 运行期可调"; 协作从"9 个角色 + 2 个开关"变成"名册 + 班组 + 拓扑 + 收敛机制"的分层架构; 并首次把"我做不到什么"写进了 system 指令区。**

---

## 1. 现状体检 (改造前)

基线绿: `npm test` → 1440 项, 1436 通过 / 0 失败 / 4 跳过。

### 1.1 逐维评分

| 维度 | 改造前 | 评分 | 证据 |
|---|---|---|---|
| 感知 (看/听/读) | 读图 (vision provider) / OCR / ASR / 文档解析 | **78** | `prompts.js visionUserContent`, `tools/ocr.js`, `tools/voice.js` |
| 记忆 | L0-L4 五层 + WAL + 衰减 + 回滚 + 画像 | **92** | `src/memory/*` (15 个模块) |
| 规划 | plan 模式 / plan-exec / DAG / goal_board | **80** | `src/mode/plan-exec.js`, `orchestrator/dag.js` |
| 推理 | 工具循环策略 / DSML 协议 / 轮次与预算闸门 | **82** | `src/core/policy.js`, `src/llm/dsml.js` |
| 工具调用 | 64 个工具 + 渐进披露 + deny-wins 策略链 + MCP 双端 | **90** | `src/tools/catalog.js`, `src/mcp/*` |
| 执行 | 命令 / 沙箱 CodeAct / apply_patch / 文档产出 | **85** | `tools/sandbox.js`, `tools/document.js` |
| 反思 | verify / postcondition / review 循环 / refine | **78** | `src/verify/postcondition.js`, `delegate.js` |
| 协作 | 军团 + 委派 + 仲裁 + 监督者 | **61** | `orchestrator/*`, `tools/delegate.js` |
| 权限管理 | 三档沙箱 × 四档审批 + 能力闸门 + 审计链 | **90** | `src/permissions/index.js` (501 行) |
| **技能与知识组织** | 11 个技能, 单目录, 无分类, 无获取通道 | **34** | `skills/` (12 个目录), `skills/loader.js` |
| **并发治理** | 每实例硬编码 8, 嵌套乘法 | **30** | `legion.js:15` |
| **能力边界** | 无边界自述, 无高风险域监督机制 | **25** | `src/ans/values.js` 只有立场 |

**加权总评: 68/100** —— 内核与治理已经很硬 (记忆/权限/工具面 90 上下), 拖后腿的是**能力面的组织方式**: 技能太少没分类、并发名不副实、协作缺组织层、边界没写。

### 1.2 三个根因

1. **技能是"示例"不是"库"**。`SkillLoader` 只扫单目录一层, 11 个技能既没有能力域坐标, 也没有获取通道。用户问"帮我写份研报"时, 能选的方法论只有 `plan` / `brainstorm` / `ponytail` 三个。
2. **并发上限在乘法下不存在**。`new Legion()` 各自持 `maxConcurrent = 8`, 而 `spawn_agent` 嵌套可达 (子 agent 再派子 agent), 每层都 `new Legion()`。三层就是 27 个独立 `PPXAgent` 进程, 每个还带独立的记忆文件与连接。真实故障形态不是慢, 是机器被打满。
3. **"全能"没有坐标, "边界"没有声明**。九维能力散落在十几个模块里, 没有任何一处能回答"我现在会什么、哪块薄"; 同时 system prompt 里只有"价值观", 没有"我做不到什么" —— 一个被要求做全能的系统, 最危险的失败模式恰恰是**越界自信**。

---

## 2. 优化方案 (P0/P1/P2)

| 优先级 | 项目 | 交付物 | 状态 |
|---|---|---|---|
| **P0** | 技能内置层 v2 | 多源加载器 + 领域注册表 + GitHub 导入器 + 56 个内置技能 | ✅ |
| **P0** | 并发调度治理 | `ConcurrencyGovernor` 进程级配额 + 运行期可调 + 观测工具 | ✅ |
| **P0** | 多 Agent 协作架构 | 23 专家 + 10 班组 + 5 拓扑 + `team` 委派入口 | ✅ |
| **P1** | 能力边界与人类监督 | `ans/boundary.js` 静态边界 + 动态高风险护栏 + 自检工具 | ✅ |
| **P1** | 九维能力矩阵自述 | `capability_matrix` / `skill_coverage` / `legion_status` | ✅ |
| **P2** | 文档/配置/CI 闸门同步 | README + CONFIG.md + 上下文预算重定基 | ✅ |
| **P2** | 技能库继续扩充 | 再导入更多上游技能 / 自研领域技能 | ⏳ 通道已就绪, 内容待续 |

---

## 3. 技能内置方式 (重点一)

### 3.1 三层渐进加载 (第 1 层重做)

| 层 | 内容 | 成本 | 触发 |
|---|---|---|---|
| **L1 名册** | 56 个技能**全量**按 12 个能力域分组, **只有名字** | 354 tok/请求 | 常驻 system |
| **L1.5 常用** | 被真正用过 (usage>0) 的 top-8 附一句描述 | ~200 tok (新环境 0) | 常驻 system |
| **L2 检索** | `skill_search` 按关键词打分 (name 权重 3 > desc 1) | 按需 | 模型主动调用 |
| **L3 全文** | `load_skill` 读 SKILL.md 全文 / `readSection` 按章节读 | 按需 | 模型主动调用 |

**为什么改**: 旧版是"按热度取 top-16 + 每个附描述" = 1257 tok, 且 56 个技能里 2/3 连名字都进不了 prompt —— 而 `skill_search` 需要模型先"想到要搜"才能用, 名册太短等于发现链断掉。新版把"有什么"做成无损的 (全量名字, 按域分组), 把"每个是什么"交给按需检索。**名册开销 1257 → 354 tok, 且零遗漏。**

### 3.2 多源装配 (roots 顺序 = 优先级)

```
config.skills:
  builtin (随包 skills/)  →  user (~/.ppx/skills)  →  project  →  extra_dirs[]
     先到先得: 同 id 时内置打底、用户覆盖、项目收尾
```

读与写分离: `loader` 负责读取 (多源), `loader.writeDir` 是唯一可写根 —— `create_skill` / 自动提炼的技能落可写根, **升级内置库时不会冲掉用户沉淀**。

### 3.3 能力域分类 (12 域)

```
knowledge 信息与知识处理    planning 任务规划与执行    office 办公与生产力
code 代码与 IT 自动化       data 数据与决策支持        content 内容与创意
research 科研与教育         business 商业与专业辅助    life 个人生活助理
multimodal 多模态与具身智能  collab 多 Agent 协作      meta 元能力与自进化
```

目录即分类: `skills/<domain>/<skill>/SKILL.md`。**旧扁平结构 (11 个技能) 零迁移继续可用** —— 加载器同时认 `skills/x/SKILL.md` 与 `skills/domain/x/SKILL.md`, 命中 SKILL.md 的目录不再下钻 (技能内 `references/` 里的 SKILL.md 不会被误认成独立技能)。

### 3.4 内容构成 (56 个)

| 来源 | 数量 | 说明 |
|---|---|---|
| 上游 GitHub 导入 | 18 | 来自 `anthropics/skills` (MIT): mcp-builder / webapp-testing / docx / pdf / pptx / xlsx / canvas-design / frontend-design / theme-factory / algorithmic-art / web-artifacts-builder / brand-guidelines / internal-comms / doc-coauthoring / skill-creator / academy-guide / claude-api / discernment-nudge |
| 自研中文领域技能 | 27 | 覆盖 knowledge/planning/office/code/data/content/research/business/life/multimodal/collab/meta 全 12 域, 含 `流程 / 反合理化 / 验证` 三段 |
| 原有内置 | 11 | 补 `domain:` 标注后纳入分类 |

自研技能带的"反合理化"段是**抗绕过机制**: 只写流程的技能会在第一次"这次情况特殊"时失效。

### 3.5 获取通道 (不只搬一次)

`skill_import` 工具 + `src/skills/importer.js`: 零依赖 (Node 内建 fetch), 支持 `owner/repo`、`owner/repo#branch`、GitHub URL。安全约束:

- 只接 `github.com` / `raw.githubusercontent.com` / `api.github.com` (否则 SSRF 到内网)
- 单文件 512KB / 单技能 4MB / 最多 40 个附随文件; 只抓文本类
- 每段路径白名单校验 (挡 `../` 穿越) + 落点必须在技能库目录内 (双保险)
- **只写文件, 绝不执行导入内容**; 单次请求 20s 超时 (无超时会在网络半开时静默卡死整个导入 —— 实测踩过)
- 导入时自动补 `domain` / `source` / `imported_at` frontmatter, 落成 `<domain>/<skill>/` 布局

一次性拷贝会立刻过期; 通道才是资产。

---

## 4. 并发调度机制 (重点二)

### 4.1 问题形状

```
改造前:  maxConcurrent = 8 (每 Legion 实例私有)
         spawn_agent → new Legion() → 8
            └─ 子 agent → spawn_agent → new Legion() → 8
                 └─ 孙 agent → spawn_agent → new Legion() → 8
         上限在乘法下等于不存在
```

### 4.2 治理器设计 (`src/orchestrator/governor.js`)

```
ConcurrencyGovernor
  limit           全局同时存活的子 agent 进程数 (硬上限, 运行期可调)
  perCallMax      单次派发能一次拿走多少槽位
  queueTimeoutMs  排队等槽位的耐心

  acquire(n)   批量原子: 要么一次拿到 n 个, 要么排队 (否则 3 路各拿 2 个会把上限 4 撑到 6)
  tryAcquire() 非阻塞, 满额返回 null 并计入 ungoverned (诚实报告, 不假装受控)
  release()    幂等 (子进程 exit / error / kill 三条路径都会调)
  setLimit()   放宽立即 drain 放行排队者; 收紧只影响后续, 不杀在跑进程
```

**进程级单例**: 所有 `Legion` 实例 (含嵌套委派懒建的) 共享同一份配额 —— "能同时活多少子进程"是机器级事实, 不该每层各持一份。

### 4.3 接线点

| 位置 | 改动 |
|---|---|
| `Legion.spawnAgent` | 自带治理器租约 (tryAcquire), 进程退出/error/kill 时归还 |
| `Legion.spawnAgents(specs)` | 新增: 逐槽 `acquire` → spawn, 排队而非打爆机器 |
| `Legion.maxConcurrent` | getter: 缺省跟随治理器 `effPerCall`, 可显式覆盖 |
| `tools/delegate.js` | 每次委派前 `governor.configure(governorOptsFromConfig(config))`; 并行 spawn 改走 `spawnAgents` |
| `orchestrator/supervisor.js` | 派发从**串行 for-await** 改为有界并行 (旧实现把并行度退化成 1) |
| `mode/legion.js` | 军团启动走 `spawnAgents`; 显式合并 `config.orchestrator` 旧别名 |
| `tools/delegate.js` DELEGATE_TIMEOUT_MS | 从硬编码常量改为 `agent.legion.delegate_timeout_ms` |

### 4.4 运行期可调 (用户明确要求)

```
legion_status                        → 上限/在跑/排队/峰值/超时/未纳管
legion_set_concurrency {limit, per_call, queue_timeout_ms, persist}
                                     → 立即生效 + 同步内存配置; persist=true 写回 config/ppx.json
```

配置侧 (config/ppx.json):

```json
{ "agent": { "legion": {
  "max_concurrent_agents": 8,
  "max_concurrent_per_call": 4,
  "queue_timeout_ms": 300000,
  "delegate_timeout_ms": 120000,
  "default_size": 2,
  "kill_on_finish": true
} } }
```

### 4.5 设计取舍 (踩过的坑)

- **不 unref 排队定时器**: 试过 unref, 结果是排队者永远拿不到结果 (请求未完成而事件循环已空)。排队是真实的未完成工作, 进程不该在有人等锁时静默退出。
- **非法参数回落默认而非钳到下限**: `limit: -5` 钳成 1 会把并发彻底冻住, 回落默认 8 才是可预期行为。
- **FIFO + 队头阻塞**: 不做"跳队头塞小请求", 那会让大队列被饿死。

---

## 5. 多 Agent 协作架构 (重点三)

### 5.1 三层结构

```
班组 Team (组织单位: 谁 + 怎么协作)
  └─ 专家 Expert (角色: 视角 + 技能绑定 + 安全属性)
       └─ 子 Agent 进程 (执行单位: 隔离数据目录 + 独立上下文)
```

**为什么要三层而不是"直接给一堆角色"**: 单个专家回答的是"这件事从我的视角怎么看"; 端到端做完一件事需要的是**一组角色 + 一个收敛机制**。"帮我上个功能"不是一个角色的活 —— 要有人拆解、有人实现、有人审查、有人验收。班组把这套编排固化成可点名的一等对象。

### 5.2 专家名册 (9 → 23)

| 类别 | 成员 |
|---|---|
| 原通用工程角色 (id/名 未变) | code / architect / review(只读) / test / security(只读,需人工) / design / docs / data / product |
| 新增领域专家 | researcher / synthesizer / planner / office_assistant / creative / scholar / consultant / life_assistant / vision / coordinator |
| 高风险域 (只读 + 需人工) | medical 医疗信息顾问 / legal 法务顾问 / finance_analyst 金融分析师 / compliance 合规风控专家 |

每个专家带: `domain` (能力域) / `skills` (推荐先行加载的内置技能) / `readonly` / `requiresHuman`。

**高风险域专家在名册层只读**: 与其靠提示词自觉, 不如让角色本身只读 + 输出带 flags, 让上层 UI/链路无从绕过。

### 5.3 班组 (10 个) × 协作拓扑 (5 种)

| 班组 | 拓扑 | 成员 |
|---|---|---|
| dev 研发 | pipeline | 产品 → 架构 → 代码 → 审查(只读) → 测试 |
| hotfix 紧急修复 | review | 代码 + 审查(只读) |
| research 研究 | supervisor | 研究员 + 蒸馏 + 学术导师 |
| data 数据 | supervisor | 数据 + 规划 + 商业顾问 |
| content 内容 | parallel | 创意总监 + 设计 + 多模态 |
| office 办公 | pipeline | 办公助理 + 文档 + 设计 |
| business 商业 | supervisor | 商业顾问 + 数据 + 合规 |
| governance 评审 | parallel | 安全 + 合规 + 法务 (**全员只读**) |
| life 生活 | parallel | 生活助理 + 研究员 |
| debate 对抗论证 | debate | 架构 + 安全 + 产品 |

**拓扑只描述依赖形状, 不覆盖安全属性** —— 是否只读、是否需要人类签字由专家自身决定, 不让班组去覆盖个体的安全属性。

| 拓扑 | 形状 | 适用 |
|---|---|---|
| parallel | 各自独立产出 → 仲裁整合 | 广撒网探索 |
| pipeline | 前环产出 = 后环输入 (串行) | 强顺序依赖 ("拆解→实现→审查") |
| supervisor | 并行 → 分歧检测 → 评审打回 → 定稿 | 需收敛的决策 |
| debate | 正反方对抗 + 仲裁 | 有争议的判断 |
| review | 实施 + 只读审查循环 | 质量要求高的产出 |

### 5.4 调用方式

```
spawn_agent { task, team: "评审" }                    点名班组 (整体接管分工与拓扑)
spawn_agent { task, experts: ["product","code"], topology: "pipeline" }   临时专家组
spawn_agent { tasks: [...], experts: [...], supervisor: true }            旧接口保持可用
spawn_agent { task, review: true, fix_rounds: 3 }                         旧接口保持可用
```

优先级明确: **team > experts/expert/topology > supervisor/review > role/perspectives**。混着给只会产出无法解释的分工, 所以班组直接赢。

### 5.5 安全贯通

- 只读专家 → 子进程挂 `PPX_AGENT_READONLY=1` (经 Codex 权限交集不变量: 只准变窄)
- 含高风险域的班组 → 产出自动附 `⚠ 需人类复核后执行`
- 所有子进程在 `finally` 统一回收 (长跑进程防堆积)

---

## 6. 能力边界与人类监督

`src/ans/boundary.js` 分两层:

**静态层 (常驻 system 指令区, 483 tok, 确定性文本零日期 → 不破坏前缀缓存)**: 六条硬边界
1. 事实与推断必须分开 (幻觉)
2. 权限不超过被授予的范围
3. 隐私与数据最小化
4. 法律与伦理红线
5. 成本受预算约束
6. 物理世界有限

**动态层 (命中高风险域才注入, 闲聊零成本)**: 五个高风险域各一段禁令 — 医疗 (不诊断/不建议用药/急症先就医) / 法律 (不出法律意见/不判个案) / 金融 (不给投资建议/不预测价格) / 安全 (不提供针对具体目标的攻击步骤) / 合规 (先列授权链条与签署人)。

命中判定是关键词正则 (零依赖), 白名单可配置扩展。`boundary_check` 工具可在动手前自检。

---

## 7. 验证证据

| 闸门 | 结果 |
|---|---|
| `npm test` | **1503 项 / 1499 通过 / 0 失败 / 4 跳过** (新增 63: governor 10 + skills-registry 9 + teams 8 + boundary 9 + orchestration-tools 12 + skill-importer 7 + team-orchestration 8) |
| `node scripts/skill-lint.js` | 38 全过 / 18 告警 (全为第三方技能结构差异, 已降级并标注) / **0 不合格** |
| `node scripts/ctx-profile.js --check` | ✓ 5351 ≤ 5800 tok |
| `node scripts/cache-audit.js --check` | ✓ 4/4 通过 (静态区逐字节恒定 3877 字符; 动态护栏确实落在静态边界之后) |
| `node scripts/selfheal-bench.js` | 7/7 (100%) |
| `node scripts/audit-verify.js` | 链完整性 完整 |
| `node bench/falsify.js` | 参考解 20/20, 变异体 88/88 判负 |
| `node scripts/eval.js` | 9 过 / 0 挂 |
| 端到端冒烟 | 73 个工具注册, 26 暴露 / 47 按需; 8 个新工具真跑输出正确 |

**上下文预算重定基 (4500 → 5800)**, 涨价逐项对账:

```
+1260  多 Agent 协作进核心 schema (spawn_agent / legion_status / team_list)
 +483  【能力边界】护栏常驻
 +354  【可用技能】全量按域名册 (56 个)
 -903  同名册不再常驻全员描述 (旧版 1257 tok)
 -683  spawn_agent 参数描述瘦身 (名册内联 → 指向 expert_list/team_list)
────────
净增 511 tok, 占单任务实测 (~17836 tok) 的 3%
```

省下的正是"要多花两三轮工具调用才能问清'有什么技能/能派几个 agent'"的那部分。

---

## 8. 诚实清单: 没做的与做不到的

1. **导入技能是英文的**。18 个上游技能保留英文原文 (这是我们不代改上游内容的副产物)。中文任务命中它们时, 描述是英文 —— `skill_search` 的中文 2-gram 分词对纯英文描述命中率偏低。**建议**: 需要哪个就本地化一份放在 `<domain>/<name>-zh/`。
2. **领域专家是提示词角色, 不是微调模型**。换的是视角与约束, 不是能力。视角只是提示不是牢笼。
3. **班组拓扑是"依赖形状", 不是工作流引擎**。没有条件分支/循环/重试策略配置; `pipeline` 是严格线性。
4. **并发上限压不到"内存/连接数"维度**。8 个子 agent × 各自 SQLite/JSON 记忆 + LLM 连接, 内存占用随 limit 线性上涨。默认 8 是保守值; 想在 4GB 的机器上跑 32 并发, 自己承担后果。
5. **高风险域护栏是提示层, 不是执行层**。它改变模型行为, 但没有硬闸门阻止模型绕过 —— 硬闸门在 `permissions` (只读专家 + 沙箱 + 审批) 那一层, 两层是互补不是替代。
6. **关键词探测会漏报**。`药` 单独出现不触发 (避免"山药/弹药"误报), 只认 `用药/剂量/药物/药品/吃什么药` 等。宁可漏报也不要在闲聊里刷护栏。要更严就把 `agent.boundary.high_risk_domains` 扩到自定义域并自己加正则。

---

## 9. to-dos for human

| # | 事项 | 为什么需要你 |
|---|---|---|
| 1 | 决定是否继续扩技能库 (再导入 obra/superpowers 等) | `skill_import` 已就绪, 但导入哪些属于内容取向决策 |
| 2 | 确认 `max_concurrent_agents` 默认值 8 是否符合你的机器 | 我的判断依据是"每子进程约 60–120MB RSS", 你可以按实测定 |
| 3 | 医疗/法律/金融/安全/合规 五个高风险域是否要增删 | 你的行业决定 |
| 4 | 是否要把 `agent.boundary` / `skills` 放进 Web 设置面板 | 目前只能改配置文件 (有意保守: 边界条款改错代价大) |
| 5 | git commit / push | 按你的一贯要求, 我没有提交; 工作区改动待你处置 |

---

## 10. 改动文件清单

**新增 (13 个源文件 / 6 个测试 / 27 个自研技能 / 18 个导入技能)**

```
src/orchestrator/governor.js      进程级并发治理器
src/orchestrator/teams.js         班组与协作拓扑
src/skills/registry.js            技能注册表 (12 域 + 覆盖率)
src/skills/importer.js            GitHub 技能导入器
src/ans/boundary.js               能力边界与人类监督护栏
src/tools/orchestration.js        编排自省工具 (6 个)
src/tools/skill-hub.js            技能库扩展工具 (3 个)
test/{governor,teams,boundary,skills-registry,skill-importer,orchestration-tools,team-orchestration}.test.js
skills/<domain>/<skill>/SKILL.md  ×45 (27 自研 + 18 导入)
```

**修改 (10 个)**

```
src/skills/loader.js              多源 + 领域二级目录 (向后兼容扁平)
src/skills/lint.js                递归扫描 + 第三方技能豁免
src/orchestrator/legion.js        治理器接入 + spawnAgents + status
src/orchestrator/experts.js       9 → 23 员, 原契约不变
src/orchestrator/supervisor.js    派发改有界并行 (原串行)
src/tools/delegate.js             team/topology + 可配置超时 + 受治理 spawn
src/tools/selfmod.js              读多源加载器 / 写可写根, 支持领域前缀
src/tools/index.js / src/plugin/builtin.js   新工具与技能库装配
src/agent/prompts.js              边界静态块 + 高风险动态护栏 + 技能名册重做
src/agent/index.js / src/mode/legion.js       技能注册表与军团配置接线
src/config/index.js + test/config-consistency.test.js + scripts/ctx-profile.js + .github/workflows/ci.yml
```

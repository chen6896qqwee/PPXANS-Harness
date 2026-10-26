# PPX v3.0 架构设计 — Codex 对齐 + 七项目特性吸收

> 基线：codex-main（OpenAI Codex CLI）为主骨架参照；吸收 claude-code-main / opencode-dev / open-code-review-main(OCR) / OpenHands-main / aider-main / claude-agent-sdk-typescript(CASDK) / oh-my-hermes(OMH)。
> 版本：2.7.0 → **3.0.0**。约束不变：纯 Node、零运行时依赖、110 个测试文件全量绿。

## 一、设计总纲

v3.0 在 v2.x「一切皆插件 + 会话即事实源」之上，引入 codex 的 **SQ/EQ 双队列 + Turn 模型** 作为交互主轴，把散落在 agent 内核里的权限、钩子、编辑、审查、证据能力**分层独立成可替换模块**。

```
┌────────────── 通道层（不变） ──────────────┐
│  CLI   Web UI(codex风格)   HTTP  飞书  微信  │
└──────────────────┬─────────────────────────┘
                   │ 提交(Submission) ↓  事件(Event) ↑
┌──────────────────▼─────────────────────────┐
│        protocol/  EQ 事件流 + SQ 在轮账本        │
│  submissionQueue  →  eventQueue(WAL)       │
└──────────────────┬─────────────────────────┘
┌──────────────────▼─────────────────────────┐
│   session/  Session → Task → Turn 状态机    │
│   rollout JSONL 持久化 · fork/rewind        │
│   结构化 message parts (opencode)           │
└──────────────────┬─────────────────────────┘
┌──────────────────▼─────────────────────────┐
│              PPXAgent 内核（保留）           │
│  工具循环 + 记忆五层 + 模式注册表 + 军团      │
│  ┌─────────┐ ┌────────┐ ┌──────────────┐   │
│  │permis-  │ │ hooks/ │ │ edit/        │   │
│  │sions/   │ │ 钩子链  │ │ SR-编辑+快照 │   │
│  │审批·沙箱 │ └────────┘ └──────────────┘   │
│  └─────────┘                               │
│  ┌─────────┐ ┌────────┐ ┌──────────────┐   │
│  │repomap/ │ │ review/│ │ evidence/    │   │
│  │仓库地图  │ │分级审查│ │ 证据·目标看板 │   │
│  └─────────┘ └────────┘ └──────────────┘   │
│  ┌──────────────────────────────────────┐  │
│  │ commands/ 斜杠命令统一模型 (claude-code)│  │
│  └──────────────────────────────────────┘  │
└─────────────────────────────────────────────┘
```

## 二、新模块与职责（9 个）

| 模块 | 出处 | 职责 |
|---|---|---|
| `src/protocol/` | codex core | **SQ/EQ 双队列**：`SubmissionQueue`（用户操作入队，Id::UnixMs 唯一）与 `EventQueue`（结构化事件出队 + WAL 回放）。通道层与内核解耦的唯一总线 |
| `src/session/` | codex + opencode | **Session→Task→Turn 状态机**：taskTurn/aborted/complete；`rollout.js` JSONL 追加式持久化（ResponseItem 流，按 id fork/rewind）；`parts.js` 结构化消息部件（text/file/image/reasoning/agent嘯声，opencode 风格）。**⚠️ standalone 未接入运行时**（仅实现+测试引用，无生产 import，见「集成现状」，v3.1 集成） |
| `src/permissions/` | codex + opencode + CASDK | **三合一权限引擎**：①`AskForApproval` 四档（UnlessTrusted/OnFailure/OnRequest/Never）；②`SandboxPolicy` 三档（ReadOnly/WorkspaceWrite/DangerFullAccess + 网络开关）；③opencode 通配符规则链（`*` / `git *` / `git push`，last-match-wins）+ CASDK `canUseTool` 回调 + 审批请求对象（Bash/Edit/Plan 三类模板） |
| `src/hooks/` | claude-code | **钩子链**：PreToolUse（可否决/改参）/ PostToolUse（可附加上下文）/ PreCompact / SessionStart / SessionStop / SubagentStop。事件驱动注册，超时熔断，纯 JS 无进程钩子 |
| `src/edit/` | aider + opencode | **SR 编辑块**：SEARCH/REPLACE 块解析与应用（多候选匹配、空白容错、失败块回灌 LLM 修复循环 ≤2 次）；`snapshot.js` 编辑前快照 + 逐文件回滚 |
| `src/repomap/` | aider | **仓库地图**：正则提取 def/ref（js/ts/py/md/json/c/go/java 六族）→ 引用图 → PageRank（纯 JS，迭代幂迭代）→ token 预算内渲染目录+签名骨架，缓存 30s |
| `src/review/` | OCR | **分级审查流水线**：plan(范围/上下文) → group(语义分组) → review(逐组高/中/低) → relocate(变更换位识别) → filter(噪音过滤)，输出 P0/P1/P2 报告 |
| `src/evidence/` | OMH | **证据边界**：prepared（注入上下文，禁伪造）/ observed（工具产出，准入校验）双层标记；`handoff_input_manifest` 哈希清单；goal board 只读看板状态；conformance 一致性核查 |
| `src/commands/` | claude-code types/command | **斜杠命令统一模型**：`{name, description, argumentHint, isEnabled, run}`；内置 /init /plan /review /compact /new /resume /model /status /memory /skills /agents /goal，用户命令从 `.ppx/commands/*.md` 加载 |

## 三、集成点（不动 v2.x 主链路，全部经插件装配）

1. `plugin/builtin.js` 新增 4 个内置插件：`permissions` / `hooks` / `commands` / `evidence`，按依赖序装配，均可被用户插件替换。
2. `agent._runTool` 织入：**PreToolUse → 权限引擎(canUseTool) → 执行 → PostToolUse**；权限拒绝产出结构化审批请求事件（Web UI 审批卡片的数据源）。
3. `core/policy.js`：`AskForApproval=Never` 时跳过审批；`OnRequest` 时工具自带 `requires_approval` 语义。
4. tools 新增：`repo_map`（repomap 渲染）、`apply_patch`（SR 编辑块）、`review_code`（分级审查）、`session_rewind`（rollout 回退）、`goal_board`（evidence 看板）。`command-guard` 升级接 SandboxPolicy（工作区写白名单 + 网络开关）。
5. `mode/plan-exec` 接 ExitPlanMode 工具（claude-code）：计划模式先出计划 → 审批 → 转 react 执行。
6. `channels/http.js` 端点（2026-10-25 据实修订）：`GET /events`（EQ→SSE 桥，一次性 ticket 鉴权）、`POST /events-ticket`（换 60s 单次 ticket）、`POST /message`（对话）。~~`POST /api/submissions`~~ 与 ~~`GET /api/events`~~ 为早期设计稿口径，未实现（SQ 真实语义见 §三·六）。
7. `memory/project-md.js`（新）：**PPX.md 四级记忆**（managed→user→project→local），启动时合并注入 system prompt（claude-code CLAUDE.md 模式）。
8. `skills/` 升级：YAML frontmatter 解析（name/description/when_to_use）、三级来源（builtin/user/project）、注入时 token 估算。

## 三·五、集成现状（v3.0 发布口径）

v3.0 的 9 个新模块中 **8 个已真实装配进运行时**：
- `plugin/v3.js` 装配 permissions / hooks / commands / evidence / protocol（经 `agent/index.js` 插件链，可被用户插件替换）
- `tools/v3.js` 装配 repo_map / apply_patch(SR+快照) / review_code / goal_board（经 `plugin/builtin.js` 工具注册）
- 均经 MCP/REST 实测可调，非纸面接线

**`src/session/` 的 rollout/parts 除外**（standalone 保留，无生产引用）；`session/projection.js` + `turn.js` 已于 R12 接入主链路（chat/chatStream 逐轮 begin/end）。

## 三·六、SQ/EQ 真实语义（2026-10-25 修订，替代早期"双队列总线"设计稿口径）

- **EQ（事件流）是主出口**：TURN_STARTED/CLOSED/ABORTED + APPROVAL_* + TOOL_CALLED/TOOL_OUTPUT（callId 配对，2026-10-25 补齐工具事件对）经 WAL 落盘 + `/events` SSE 桥外发；16 种事件类型中 7 种有生产者（其余为预留）。
- **SQ（提交队列）是"在轮账本 + 控制通道"**，不是异步任务总线：
  - USER_TURN op 在轮开始提交、轮收口消费 —— 队列内容 = 当前在轮的回合（`/health` 的 `protocol.sqPending` 可观测，持续上涨 = 死轮泄漏信号）；
  - INTERRUPT 控制 op 经队列流转：`interrupt()` 入队 → 置位/掐流生效 → 轮收口 `consumeType` 清扫；
  - TTL 清扫（10 分钟）：崩溃轮遗留 op 不会永久占队；
  - `atHead`/`pending`/`sweep`/`consumeType` 为队列语义原语，供未来调度器演进。

## 三·七、自主迭代进化（2026-10-25 新增，evolve/selfiterate.js）

自愈内核之上的**可验证自改进闭环**（自主迭代/自主优化自身代码的最小可审计实现）：

```
发现(node --test TAP 解析) → 诊断(LLM+失败用例+关联源码)
  → 补丁(SEARCH/REPLACE 块) → 快照落盘 → 重跑验证
  → 绿: 保留 + 审计链 ok + EQ 事件   红: Snapshot.rollback + 故障留痕
```

- 双模式：`propose`（默认，只出补丁不动盘）/ `apply`（config `agent.self_iteration.mode="apply"` 显式开启）
- 边界：只改 root 内 `.js`、默认不碰测试文件、LLM 调用预算上限、子进程超时强杀、审计链全程留痕
- 接入面：`self_improve` 工具（riskLevel=high，权限引擎按高风险处理）/ `npm run selfiterate`（CLI）/ `--list-failing` 全量失败清单
- 回归：`test/selfiterate.test.js`（修复成功/无效回滚/propose 不动盘/TAP 解析/双重确认门）

## 三·八、持续进化循环（2026-10-25 第二层，evolve/loop.js）

把行为学习（EvolutionEngine）、代码自改进（SelfIterationEngine）、故障病历/Playbook 三个孤立能力编排成**每日自主进化闭环**：

```
Phase 1 learn    弱点聚类 (故障病历按 tool+category 聚类, 同类 ≥N 先治)
                 → 定向 refine + 常规 refine (失败→经验) + refineSkill (成功→技能)
Phase 2 iterate  代码自改进 (SelfIterationEngine, 需 LLM + target_files, 沿用 propose/apply 安全门)
Phase 3 journal  进化度量落账 (data/evolve/journal.jsonl: 能力快照 + 各段结果, 曲线可画)
```

- 编排护栏：单飞锁（上轮未完不叠加）/ 最小间隔 / 各段独立 try 隔离（一段崩不拖垮整轮）/ 无 LLM 段级跳过
- 接入面：`config.agent.evolution_loop { enabled, cron, weakness_threshold }` 每日定时（Scheduler 幂等注册，防 JSON 序列化丢 action 的恢复陷阱）+ `npm run evolve:loop`（手动一轮 / `--status` 报告）+ `evolution_status` 工具（只读，能力快照/弱点头部/最近 N 轮进化）
- 回归：`test/evolution-loop.test.js`（三段编排/弱点驱动/单飞锁/定时装配/工具输出）

## 四、Web UI（codex 风格，public/ 零依赖重制）

- **布局**：左栏会话列表（codex 侧栏），中栏**事件时间线**（EQ 流：用户消息/思考/工具调用卡片/审批卡片/turn diff/计划/最终答案，各类型独立渲染），底部输入框 + `/` 命令补全面板。
- **审批卡片**：Bash（命令+cwd+风险标注）、Edit（diff 预览）、Plan（计划+批准/拒绝）三种模板，approve/deny 直打 `/api/approvals/:id`。
- **工作区 Tab**：文件树 / diff / 任务（goal board）/ 审查报告（P0/P1/P2 徽标）四个 Tab，codex 式抽屉。
- **子 agent 颜色**：legion/delegate 产物按 agent 实例着色（claude-code 8 色环）。
- **交互细节**：Esc 中断（aborted turn）、Resume 恢复、compact 进度提示、token 用量角标。

## 五、目录结构（v3.0 增量）

```
src/
├── protocol/    [新] SQ/EQ 双队列 + WAL
├── session/     [新] Turn 状态机 + rollout + parts
├── permissions/ [新] 审批 + 沙箱 + 规则链 + canUseTool
├── hooks/       [新] 六事件钩子链
├── edit/        [新] SR 编辑块 + 快照回滚
├── repomap/     [新] 仓库地图(PageRank)
├── review/      [新] 分级审查流水线
├── evidence/    [新] 证据边界 + 目标看板 + manifest
├── commands/    [新] 斜杠命令模型 + 内置命令
└── ...（v2.x 既有层全部保留）
```

## 六、落地顺序

1. 9 个新模块 + 单测（并行，互不依赖）
2. 集成接线（插件装配 + agent 织入 + tools 注册 + http 端点）
3. Web UI codex 风格重制
4. 全量回归（110 旧测试 + 新测试）→ 文档更新 → 交付

# 质量基线与契约补全 2026-11-16

> 起因: "全面优化" 之前先回答一个问题——**现在的优化有没有回归网?**
> 答案是没有: 源码树里 `test/` 整个不存在 (v5.2.0 重构提交把它删了), `npm test` 脚本也不存在,
> 而 README/架构文档仍在引用 2626/2867 项测试与 `npm test`。任何"优化"在这个状态都无法被证伪。
> 本轮的顺序因此是: 先恢复可验证性, 再修它暴露出来的真问题, 最后接通三个"就绪但半接"的回路。

## 0. 回归网: 从 95 红到 0 红

**恢复**: 从 git 历史 (合并的另一父提交 `623c4d7`) 取回 `test/` 与 `fixtures/`。
首次全量: **1646 项 / 95 失败**。失败不是产品全坏了, 而是四类资产的腐化。

| 类别 | 数量 | 处理 |
|---|---|---|
| 2026-11-12 模块收敛后的旧 import 路径 (`core/policy` → `agent/loop/policy`, `plugin/builtin` → `agent/plugins/builtin` …) | 36 个文件 | 机械重映射 (仍保留原文件名/断言) |
| 契约已变更 (默认 `tool_exposure=core`、五档审批决策、LaneMerger 合并、pageSize) | 12 项 | 按现行契约更新断言, 注释写明变更日期与原因 |
| 被测模块已按死代码显式移除 (`canvas`/`assets`/`memoryHealth`/`supervisor`/`triage`/`rollout`/`parts`/`aml-server`/`sqlite memory`) | 15 个文件 | 退役 (测试文件移到 `_retired` 之外, 不随主套件运行) |
| 真缺陷 | 4 项 | 修产品 (见 §1) |

最终: **253 个测试文件 / 1957 项测试 / 1953 通过 / 4 跳过 / 0 失败**。
`npm test` 脚本补回 (`node --test --test-force-exit test/`), 与文档宣称一致。

## 1. 测试暴露出的真缺陷 (已修)

1. **事实库墓碑无界增长** (`src/memory/fact-store-normalize.js`): 2026-11-06 让
   `purgeGraceDays` 把保留期内墓碑整体排除出容量淘汰, 但没有给"保护期总量"设上限 ——
   600 次 add+forget 后 live=0 而盘上 600 行, 每次 add 的锁内重载重新变成 O(累计删除数)。
   现在容量上界是硬约束 (优先保留最近墓碑), 宽限期只作用于年龄回收路径。
2. **技能包镜像副本漂移** (`skills/ppx-memory/scripts/experience.js`): src 的
   `retire/restore` 与退休过滤没有跟进副本 —— 技能包整目录拷走后, 治理动作会静默失效。
   已同步退休语义; 漂移守卫同时改为按模块族 (host + mixins) 检查, 并把 mixin 容器符号
   排除出"符号集 ⊆ 副本"判定。
3. **MCP 对话入口被分页挤到第二页** (`src/mcp/server.js`): 工具总数 129 > pageSize 128,
   只读首页的客户端直接看不到 `ppx.chat.*`。默认 pageSize 上调为 256 (客户端翻页语义不变)。
4. **预算体检与预算消费不同源** (`src/agent/context.js`): `contextBudget()` 只计 tools、
   历史裁剪却按另一套公式; 报告说"放得下", 实际可能超窗。现在固定开销统一
   (`_fixedContextTokens`) 并成为历史预算的输入。

## 2. 三个"就绪但半接"的回路

### ② 上下文配额: 从体检变成硬约束 (`memory.adaptive_budget`)

- `_historyBudget()` 成为 `_trimHistory` / `_ensureContextFit` / `_maybeCompact` 的唯一预算入口;
- 只回答"现网公式会不会超窗": 放得下 → 保持 legacy (行为不变); 放不下 → 收到
  `窗口 − 输出预留 − tools − system − 记忆预留`; 绝不放大 (24K 帽仍在);
- `memory.adaptive_budget=false` 可回退纯 legacy;
- 8K 窗口 + core schema 属于"固定开销本身超窗": 预算退到下限并在体检里如实报 `overflow`,
  不假装放得下。

### ③ 记忆召回: 统一契约有了真实消费方 (`memory_search.multi_source`)

- `retrieval.js` 的 RRF 融合此前零调用方。现 `memory_search({multi_source:true})` 把
  事实/经验/场景/画像降级为 Provider, 融合后每条带来源标注 (`[事实/经验/场景/画像]`);
- 默认 `false` 时单源路径逐字节不变; `scope` 只约束事实源并在输出头注明;
- 单源故障只降级该源 (`experience:降级`), 不拖垮整次召回。

### ② Run 血缘: runId 贯通工单账本

- `submit` 在 trace 上下文内创建工单时记录 `runId`; `begin` 的指派继承工单血缘 (可显式覆盖);
  `ticket_created` 等事件 payload 带 `runId`;
- 旧账本无该字段 → `null` (不推测), 旧记录可读;
- 依赖边 `workgraph → core/run-context` (+1, 向下依赖; 架构守卫 43 模块 / 137 边 / 0 环 / 0 越层)。

## 3. 声称可核验: README 数字闸门

新增 `scripts/readme-sync-check.js` (README 与 `docs/lib/readme-version-refs.js` 一直在引用它,
但脚本此前不存在):

```bash
node scripts/readme-sync-check.js              # 校验 (不跑测试, 秒级; 已进 npm run verify)
node scripts/readme-sync-check.js --fix --with-tests   # 同步锚点/散文数字 + 测试统计缓存
```

口径: tools / skills / core_schema / ctx_tokens / mcp_tools / test_files 由真实装配实测;
tests/pass/skip 由全量测试实测并缓存到 `docs/bench/test-count.json`。同时修正:
README 工具数 111 → 127、测试 2867 → 1957、文件 376 → 253; package 描述的 "符号画布" 与
supervisor/画布模块早已按死代码移除; ARCHITECTURE-CURRENT 的 2626 项/282 文件/42 模块。

## 4. 证据

```bash
npm test                     # 253 文件 / 1957 项 / 0 失败
node scripts/verify.js       # 17/17 (新增 README 数字同步)
node scripts/arch-guard.js --check   # 43 模块 / 137 边 / 0 环 / 0 越层
node scripts/selfcode.js ... # 静态自审 100/100 (376 模块 / 944 边 / 0 死代码候选)
```

新增测试: `context-budget-wiring-2026-11-16` (8) · `workgraph-runid-2026-11-16` (4) ·
`memory-recall-multi-source-2026-11-16` (4)。

## 6. 第二波: 子 agent 的 git worktree 隔离 (已落地)

- `src/orchestrator/worktree.js`: 建/收/删 worktree 的最小原语。detached HEAD、含未跟踪新文件
  的补丁 (`git add -N`)、用完即删; 只负责隔离, 不自动 merge。
- `spawn_agent({isolation:"worktree"})`: 每个子任务一个 worktree, worker 以它为 cwd;
  回执附 `[worktree 隔离] N files changed + 补丁路径 (git apply --3way)`;
  成功/失败/异常都清理。非 git 仓库/无 HEAD → 明确工具错误, **不静默退回共享目录**。
- `Legion._spawnAgentRaw` 接受 `cwd`; 指定 cwd 时不接管热池 worker (池里工作区不同);
  `send` 在进程已死/stdin 已关时先行拒绝, 修掉迟到消息触发 EPIPE 的宿主崩溃风险。
- 关键踩坑: try 块里的 `const` 在 finally 里不可见 —— worktree 句柄必须在 try 外声明,
  否则任何失败路径都会在清理时二次抛错 (`worktrees is not defined`)。
- 证据: `test/worktree-isolation-2026-11-16.test.js` (5 例: 真 git 建收删 / 非 git 报错 /
  worker cwd / spawn_agent 回执与清理 / 不静默降级)。

## 7. 第三波: 溢出重试的 generation 证明 (借 DSH, 已落地)

来源: DeepSeek Harness 的 [after-call compaction pressure and overflow recovery](https://github.com/deepseek-ai/deepseek-harness/blob/master/.agents/notes/archived/architecture/2026-07-10-after-call-compaction-pressure-and-overflow-recovery.zh.md)。
它把重试条件钉成"模型可见表层 generation 真的变了", 而不是"压缩函数返回了结果"。

- `runToolLoop` 溢出降档新增 `sameMessageList` 浅比较: 裁剪后消息列表没变化 → 直接抛原提供方错误,
  不再空烧降档次数; 有变化才重试。同时发 `tool/overflow-no-progress` 事件。
- `histTokenCap` 注入从 `_histTokenCap()` 改为 `_historyBudget()`, 与历史裁剪/压缩同一预算入口。
- 旧测试里的 `shrinkMessages: m => m` 全部改成真实裁剪输入; 单条 user 输入无历史可裁时,
  新行为是**一次请求后抛原错误**, 这是刻意的。
- 证据: `test/overflow-generation-guard-2026-11-16.test.js` (2 例) + `context-overflow` /
  `policy` / `trace` 全部绿; 全量 1964 项 0 失败。

## 5. 本轮没做 (诚实清单)

- **同步 I/O 异步化**: 已知并发天花板 (20 并发 stub p50 ≈360ms), 但涉及"崩溃丢最后几条"
  的语义取舍, 需要独立立项。
- **压缩阈值改到 80% 窗口 (DSH 口径)**: 会改变现网摘要密度, 需要基准对比。
- **多源召回进每轮 system prompt**: 需要 A/B 证明 token 成本换来的召回收益; 本轮只给了
  显式工具出口, 不动每轮注入面 (前缀缓存与预算都更安全)。
- **worktree 自动合入**: 补丁已留档, 合入由主 agent/用户显式执行; 不做自动 merge/rebase。

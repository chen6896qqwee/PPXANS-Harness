# 架构优化 2026-11 · 四项契约落地

> 起因: 对 5.1.0 做了一次架构级审计 —— 结构本身没病 (42 模块 / 131 依赖边 / 0 环 / 0 越层,
> 最大文件 650 行), 病在**四件事没有单一契约**: 工具面、run 血缘、记忆召回、上下文配额。
> 本文件记录这一轮做了什么、证据在哪、还剩什么没做。

---

## ① 工具面: 意图门面 (107 → 15 门面 + 43 直达)

**问题**: 同一种意图多个人口 —— 团队房间 7 个、记忆治理 6 个、技能管理 5 个、进化自改 9 个、
git 7 个。对模型不是"能力强", 是"选哪个"的歧义; 对内核是 64 份权限/审计/错误识别重复接缝。

**做法** ([src/tools/facade.js](../src/tools/facade.js)): 同族低频工具收进一个 `action` 分派入口。
- 门面**只转发** → `catalog.call(target, ...)`, 策略链 / 审批 / 审计 / 参数校验一处不少;
- 原工具名保持可调用 (测试、脚本、既有 skills 零影响), 只是不再单独下发;
- schema 由真实注册项**运行时合成** (action 枚举 + 参数并集), 不手写第二份定义。

**证据**: `test/tool-facade.test.js` (5 例) + `test/tool-exposure-2026-10-30.test.js` (10 例)。
实测: 对模型可见 34 个 (schema ≈ 4.0k tok 不变), 按需名单 **73 → 24 行**。

**未做**: 把剩下 43 个直达工具继续合并 (读写/命令/检索是主干, 合并只会多一跳);
`manifest` 级工具分组留给 MCP 侧。

---

## ② Run 血缘: 一条 runId 串起六个记录面

**问题**: 一轮对话分叉到 trace 事件流 / 审计哈希链 / 工单账本 / 委派 worker / 军团并发 /
话题驻派, 各自生成 id。排查"这次为什么失败"只能靠时间戳猜。

**做法** ([src/core/run-context.js](../src/core/run-context.js)): runId **只有一个来源** ——
当前 trace 上下文 (`AsyncLocalStorage`, 已有)。本模块只做投影与派生:
- `currentRun()` / `currentRunId()`: 给审计、工单、工具轨迹统一取 id;
- `patchTrace()`: 入口一行补写 sessionKey/kind, 不用改闭包收尾;
- `runEnvForChild()`: 跨进程 (legion worker) 用 `PPX_PARENT_RUN_ID` 带血缘;
- `announceChildRun()`: 派生子 run 的事件经 sink 落 `run/child`;
- `runLineage()`: 纯函数还原 root → 目标链。

**接线**: `catalog.call` 的 4 处审计条目带 runId; agent 装配把 sink 接到 EventTracer;
legion 冷启动注入 env。

**未做**: 工单账本 (workgraph store) 的记录尚未写 runId —— 存储格式加字段要迁移,
留到下一轮 (验收: `work.ticket()` 返回体带 runId, 且旧账本可读)。

---

## ③ 记忆召回: 一个入口 + 带证据的排序

**问题**: 33 个记忆文件、五层 + 事实 + 经验 + 场景 + 画像, 谁先回答谁就决定上下文放什么;
"为什么召回这条"没有答案, 所以调不动。

**做法** ([src/memory/retrieval.js](../src/memory/retrieval.js)): 所有来源降级为 Provider,
`retrieveMemory()` 并发查 → RRF 融合 (复用 `fact-store-retrieval` 同一实现) → 每条带
`evidence:[{source, rank, score}]`。逐条置信度按本源最大值归一化, 弱命中不因名次靠前压过强命中。
单源抛错只让该源降级 (`degraded=true`), 不拖垮整次召回。

**证据**: `test/memory-retrieval-contract.test.js` (7 例: 跨源同 id 抬升 / 权重 / 归一化 /
降级 / 空输入 / 渲染预算 / Provider 探测)。

**未做**: 尚未接进 `_context()` 的记忆注入点 (现有注入链路另有 3 处调用), 接线需要一轮
A/B (验收: 同一查询下 recall 命中率与 token 占用对比)。所以这轮只落契约, 不改召回行为。

---

## ④ 上下文配额: 溢出前就知道该让谁

**问题**: 只有历史有预算 (`window*0.3` clamp 2K~24K), tools schema / system / 记忆各自为政;
窗口被固定开销吃掉多少、何时溢出, 只能等 400 报错。

**做法** ([src/agent/context-budget.js](../src/agent/context-budget.js)): 纯函数把窗口切成
`output/tools/system/history/memory`, 溢出按固定顺序让位: **tools > system > 历史下限 > 记忆**。
`agent.contextBudget()` 给出体检报告 (人话摘要), 但**不改**既有历史预算公式 —— 行为零变化。

**证据**: `test/context-budget.test.js` (6 例: 配额守恒 / 让位顺序 / 小窗口不产负配额 /
24K 封顶 / 摘要 / token 估计)。

**未做**: 让 `_trimHistory` 真正消费规划结果 (会改变现网预算, 需一轮基线对比)。

---

## ⑤ 评测门禁: 基线不再只是"存着"

**问题**: 有真 LLM 任务基准 (20 任务, 确定性判分) 和 `bench/baseline.json`, 但没有比较器 ——
基线从不判断"这次是不是更差"。

**做法** ([scripts/bench-gate.js](../scripts/bench-gate.js)): 基线 vs 最新报告 → 逐任务比对。
判据保守: 任何 pass→fail 都拦; 覆盖率 < 80% 也拦 (少跑不等于跑过); 成功率下降即非零退出。
`npm run bench:gate`。

**证据**: `test/bench-gate.test.js` (6 例)。

**未做**: 接进 CI 需要模型 key (真 LLM 任务有成本), 建议 nightly 带 key 跑、PR 只跑离线 20 任务。

---

## ⑥ 内容检索: 借 ripgrep / git grep, 不手搓搜索

**缺口**: 本仓只有 `search_files` (按**文件名** glob)。搜内容得让模型自己拼
`run_command` 的 grep/findstr —— Windows 的引号、编码、无匹配退出码全变成模型要猜的东西
(上一轮为此专门给 `tail`/`findstr` 打了补丁)。

**行业现状** (GitHub 同类): OpenCode、Oh My Pi(omp)、OpenClaw、Hermes 的内容检索全部落在
ripgrep / fd / git 这类成熟程序上; 据 repowise 对 7 个 agent 仓库的代码级分析,
**没有一个默认构建代码索引** —— 大家用的都是 grep/find/read, 差异在"丢掉什么"而不是"索引多好"。

**做法** ([src/tools/grep.js](../src/tools/grep.js)): 三级阶梯, 全部可选外部程序, 零运行时依赖不变。
1. `rg` 存在就用 —— .gitignore、二进制识别、编码、并行全由它处理;
2. 仓库内退回 `git grep` (自带索引, 比 JS 全盘扫快一个量级);
3. 都没有才用内置扫描 (跳过 node_modules/.git/dist、二进制、>512KB 文件)。

**证据**: `test/grep-tool.test.js` (8 例)。实测本机: auto → git 后端 148ms;
`*.js` 的文件名语义已对齐 rg/git (这一点写错会让兜底后端静默零命中)。

---

## ⑦ 代码事实: 接 LSP, 不自建符号索引

**缺口**: 代码理解只有自建 repomap (词法级) + grep 后读文件。模型问"这符号在哪定义/谁引用/
类型是什么", 只能靠猜。这活儿 IDE 早已标准化 (LSP)。

**行业现状**: OpenCode (LSP 集成)、Oh My Pi (14 个 LSP 操作 + 28 个 DAP 操作)、Crush (LSP-aware),
以及我们直接对标的 **DeepSeek Harness 有官方 `tool/lsp`** (definition/references/implementation/hover)。

**做法** ([src/tools/lsp.js](../src/tools/lsp.js)): 极简 LSP 客户端 (JSON-RPC over stdio,
Content-Length 分帧) + 按扩展名选服务器 + 按 (命令, 根目录) 常驻复用。
- `action`: definition / references / hover / diagnostics (拉模式优先, 退推送);
- 服务器由用户环境提供 (typescript-language-server / pyright / gopls / rust-analyzer / clangd),
  探测不到就如实报"没装", 不假装能查;
- 路径限工作区内; `shutdown()` 显式收口子进程, 不留孤儿。

**证据**: `test/lsp-tool.test.js` (7 例, 用 `test/fixtures/fake-lsp-server.js` 走真实 stdio 分帧,
覆盖粘包/半包/0→1 基换算/服务器报错不静默/越界路径)。

---

## ⑧ 常驻 shell: cd / export / venv 活过多条命令

**缺口**: `run_command` 每条命令起一个新 shell。`cd sub && npm test` 是模型在绕这个限制,
`export FOO=1` 之后再 `npm run` 则**静默失效** (第二条命令根本看不到)。DSH 的 persistent bash /
PTY、OpenHands 的 bash session 解决的正是这件事。

**做法** ([src/tools/shell-session.js](../src/tools/shell-session.js)): 一个常驻 `bash -s`,
stdin 喂命令, 每条命令后跟一行 `echo "__PPX_END_<id>$?|$PWD"` 作为结束标记 ——
读到标记即判定完成, 同时把 `$?` 与会话 cwd 一起收回来。
- 串行队列: 同一 shell 不允许两条命令交错 (输出会串);
- 超时**杀进程树**(Windows 用 `taskkill /T`)并重启, 挂死的 shell 不污染后续命令;
- cwd 跟踪 + `cd` 边界校验: 只能在工作区内 `cd`, `~` / `..` 越界直接拒;
- 内建 (`export/unset/alias/...`) 放行 (只改本 shell 环境), 其余命令照旧过 `checkCommand`
  白名单 + 受保护路径 + 会话自写脚本拦截;
- 没有 bash 的环境**不注册该工具** (模型看不到, 自然退回 `run_command`), 不假装支持。

**踩过的三个坑** (都写进注释了):
① 用 `where bash` 的输出拼路径 —— Windows 上 GBK 路径被按 UTF-8 解码成乱码, spawn 直接 ENOENT;
   改成"让 PATH 自己解析 + 固定候选路径兜底"。
② 结束标记最初用 `printf` 的 `
`, 在 JS 模板里层层转义后写成真换行, 协议直接废掉; 换成 `echo`。
③ 命令超时定时器 `unref` —— 又是老毛病: 没人等 = 永远等不到。

**证据**: `test/shell-session.test.js` (8 例: 状态持久 / 退出码 / 串行不串输出 / 超时自愈 /
守卫拦截 / cd 越界 / restart 清环境 / 无 bash 不注册)。

**边界**: 只支持 bash; 后台任务 (`cmd &`) 的 `$?` 不代表任务结果 (与 shell 语义一致)。

---

## ⑨ 压缩: 一份实现、三件事件、一把锁

**缺口**: "把旧对话压成摘要"有两份实现 —— `agent/context.js._maybeCompact` 与
`agent/evidence.js._maybeCompact`。各自 replay 会话、各自算 `upToSeq`、各自调 LLM、各自写事件。
差别只在证据侧多了保真闸门、上下文侧多了 spill 归档 —— 于是"能不能续读被压原文"取决于
哪个 mixin 的方法最后挂上 prototype。而且两条路都没有事件: 压了没压、压了多少、为什么没压,
只能靠 `warn` 日志猜。

**做法** ([src/memory/compact-engine.js](../src/memory/compact-engine.js)) —— 借 DSH 的
compaction 接缝形状:
- **事件三件套**: `compaction/start` → `compaction/summary` → `compaction/end`;
  跳过/失败/被拒**也发 end**, 带 `status` 与原因 (不再有"静默跳过");
- **锁**: `WeakMap<agent, Set<sessionKey>>`, 同一会话并发压缩时后到的直接退让 (`status: busy`),
  不重复烧一次 LLM; 失败/拒绝路径也保证释放;
- **行为不变**: 阈值与取半仍走 `compactionSplit` 单源; 保真闸门与归档按开关保留
  (上下文侧 `fidelity:false` 维持原行为, 证据侧 `fidelity:true`);
- 两个调用点各自变成 15 行委托, 差异只剩开关, 不再有两份逻辑。

**证据**: `test/compact-engine.test.js` (10 例: 跳过事件 / 成功三件套+钩子 / 保真拒绝不落盘 /
并发锁 / LLM 失败不抛 / 空摘要 / 无模型 / 归档指针 / 哈希稳定)。
既有 `compaction` / `tool-evidence-context` / `config-consistency` 29 例全绿 (行为未漂移)。

**未做**: DSH 的"80% 窗口触发"没有直接照搬 —— 本仓的触发点是 `1.5 × history 预算`
(约 45% 窗口), 换阈值会改变现网摘要密度, 需要一轮基准对比后才动。

---

## ⑩ 锚点编辑: 改代码不必复述旧内容

**缺口**: `apply_patch` 的 SEARCH/REPLACE 要求模型把旧内容原样复述。改一行长代码要把那行
再吐一遍 (输出 token 直接翻倍), 而且记错一个空格就整块作废。omp 的 hashline 用
"内容哈希锚点"解决这件事。

**做法** ([src/edit/anchors.js](../src/edit/anchors.js) + [src/tools/anchored-edit.js](../src/tools/anchored-edit.js)):
- `read_file(anchors:true)` 返回 `行号#锚点| 原文` (锚点 = 行内容的 4 字符 FNV/36);
- `edit_lines({path, edits:[{anchor, content}]})` 改一行, `{from, to, content}` 改一段;
  content 省略 = 删行;
- **锚点只认内容**: 行号会因上方插删漂移, 锚点不会 —— 对不上就说明文件变了, 直接拒绝;
- **歧义拒绝**: 同内容多行时不猜, 报出候选行号让人改用更长上下文;
- **原子性**: 任一条编辑不合法 → 一个字都不写; 区间重叠也算不合法;
- 与 `write_file` 共用撤销栈、敏感写入提示、会话写盘记账 (安全面不打折)。

**证据**: `test/anchored-edit.test.js` (15 例: 锚点稳定性 / 切片 / 单行改 / 删行 / 区间改 /
多行插入 / stale 拒绝 / 歧义拒绝 / 原子性 / 区间重叠 / 空编辑 / 工具层往返 / 过期不改盘 /
末尾换行无幽灵行)。

**基准 (补上了, `npm run bench:edit`)**: 量的是**协议信息成本** —— 模型为表达一次编辑必须
输出多少字符 (不含模型会不会写错, 那要真模型 A/B)。读侧代价也算进去了: 锚点视图每行多出
`行号#hash| ` 前缀, 这是纯额外开销, 不算它就会得出"锚点永远赢"的假结论。

| 任务 | 编辑数 | 读入行 | SEARCH/REPLACE | 锚点(含读税) | 净差 | 比值 |
|---|---|---|---|---|---|---|
| 改一行配置值 (短行) | 1 | 30 | 70 | 378 | +308 | 5.40 |
| 改一行长表达式 (~180 字符) | 1 | 20 | 459 | 479 | +20 | 1.04 |
| 整段重写 40 行函数 | 1 | 60 | 1944 | 1324 | −620 | 0.68 |
| 重写 200 行片段 (大重构) | 1 | 200 | 16006 | 9245 | −6761 | 0.58 |
| 同文件批量改 5 处 | 5 | 100 | 1444 | 1319 | −125 | 0.91 |
| 删 10 行死代码 | 1 | 50 | 280 | 563 | +283 | 2.01 |

**结论 (不好听但有用)**: 锚点**不是普适更省**。
- 大段重写省 32%~42%; 批量小改勉强赢 9%;
- 改一行短内容贵 5.4 倍, 删 10 行贵 2 倍 —— 因为 JSON 载荷 + 读税压过了那一行的旧内容。

所以工具描述里直接写了路由规则: 整段重写/批量改用 `edit_lines`, 改一两行短内容用 `apply_patch`。
判定式: **被替换内容的字符数 > 读入行数 × 每行税 × 编辑次数** 时才净省
(`breakEvenReadLines()` 可逐任务复算)。

omp 宣称的 "Grok 4 Fast 输出 token −61%" 是它模型+任务上的结果, 这里不搬。

---

## 借鉴清单 (GitHub, 按"可直接抄的成熟轮子"排)

| 来源 | 已有轮子 | 本仓状态 | 结论 |
|---|---|---|---|
| OpenCode / omp / Crush | LSP 集成 | ✅ 本轮接入 | 抄 |
| OpenCode / Hermes / OpenClaw | ripgrep 内容检索 | ✅ 本轮接入 (三级降级) | 抄 |
| DeepSeek Harness | LSP tool / 压缩在 80% 触发 / 常驻 bash / PTY | 常驻 bash ✅ 本轮; LSP ✅ 上轮 | 压缩阈值待做 |
| omp | **hashline 编辑** (按内容哈希锚点改) | ✅ 本轮 (edit_lines + read_file anchors) | 机制已抄, 收益待基准 |
| DSH 插件生态 | 压缩做成"能力接缝"(start/summary/end 三事件 + 锁) | ✅ 本轮 (引擎统一 + 事件 + 锁) | 已抄 |
| repowise 7 仓分析 | 无人默认建代码索引, 差异在"丢什么" | 有 repomap | **不要再投索引**, 投压缩与丢弃策略 |
| Hermes | 用便宜模型做摘要 (50% 触发) | 有辅助模型路由 | 可复用 |
| omp / Codex CLI | 子 agent 隔离 worktree + schema 校验回传 | 有 legion 子进程 | 已有, 不重复造 |

---

## 审计里被推翻的两条 (写下来免得下次又提)

- **"通道层没有统一 ingress 契约"** —— 错的。`src/flow/trigger.js` 的 `createTrigger`
  + `src/flow/kernel.js` 的 `planIngress` 已经是纯函数契约 (准入/去重/话题直通/同步异步),
  再造一层就是重复抽象。**不做**。
- **"工具 schema 吃掉 11.2k token"** —— 那是 `tool_exposure="all"` 的历史数字;
  默认 `core` 实测 34 个 / ≈4.0k tok。门面的收益是**名单清晰**与**接缝收敛**, 不是省那 7k。

---

## 剩下的三项 (按 ROI 排, 未开工)

| # | 事项 | 为什么还没做 | 验收标准 |
|---|---|---|---|
| ~~6~~ | ✅ **已落地 (2026-11-14)**: `PPXAgent` 拆 TurnRunner / LaneMerger —— `src/agent/turn-runner.js` (_chatCore/chatAsync, 单轮执行面) + `src/agent/lane-merger.js` (chat 路由/合并车道/中断/回放缓存, 同会话并发面), 类体 571 → ~178 行只剩引擎壳。方法名与 `this._chatCore` 调用点原样保留 (125 个测试文件的猴补丁透明), `_withSessionLock` 仍留 work-thread.js (零行为收益不挪)。三场景实测钉在 `test/agent-split-turnlane-2026-11-14.test.js`: 同会话 3 追打合并 1 轮 + [[回复 #n]] 分段 / interrupt 会话隔离位与流式掐断 / resumeCtx 旁路车道 + 断点 memo 复用 | —— | 验收达成: 全量测试绿 + 三场景逐一实测 |
| 7 | 零依赖红线重划 (内核零依赖 + 能力外挂) | 这是**产品定位决策**, 不是重构: 一旦允许外挂, "零运行时依赖"宣称与 claim-gate 都要改写 | README/claim-gate 措辞落地 + 至少一个外挂能力 (docx 生成) 跑通 |
| ~~8~~ | ✅ **已落地 (2026-11-14, PC 端优先)**: 四入口共用请求口径 —— ① `src/services/desktop/kernel-client.js` 统一桌面壳↔内核私有协议 (探活 HMAC 挑战/优雅退出, 自 electron/server-proc 迁入, secret 参数化, 纯 node 可测, 补上 server-proc 一直缺的单测 `test/kernel-client-2026-11-14.test.js`); ② 前端 `webapp/src/api/url.js` 纯函数 (apiUrl/authHeaders) 成为 client.js 与 sse.js 的同一实现 —— 流式请求不再裸拼路径绕过 401 刷新钩子, EventSource 地址也走 base 口径; ③ 权限写路径单轨化: `permissions.applyPermissionUpdate` 成为 POST /api/permissions 与 /api/bot.manage 的唯一实现 (校验/提权留痕/落字段, 响应形态各自保留)。**口径**: CLI 进程内直调 PPXAgent 是设计而非缺口 (in-process 无 HTTP 一跳); 817kB 主包是 Vue+markdown 渲染栈, 与 api 层无关; server REST vs MCP admin 双轨另立项 | —— | 验收达成: 同一请求同函数 (探活/退出/鉴权头/权限写) + `web:check` 绿 + desktop:smoke 绿 |

---

## 变更清单

新增: `src/tools/facade.js` · `src/core/run-context.js` · `src/memory/retrieval.js` ·
`src/agent/context-budget.js` · `scripts/bench-gate.js`

修改: `src/tools/catalog.js` (hide/hiddenNames, 审计带 runId, 按需名单口径) ·
`src/core/trace.js` (patchTrace) · `src/agent/index.js` / `stream.js` (补 trace 元信息) ·
`src/agent/bootstrap.js` (run sink) · `src/orchestrator/legion.js` (跨进程血缘) ·
`src/agent/context.js` (contextBudget 体检) · `src/agent/plugins/builtin.js` (门面装配) ·
`src/tools/index.js` / `src/memory/index.js` (导出) · `package.json` (bench:gate)

测试: 新增 4 个文件 24 例 (facade 5 / retrieval 7 / budget 6 / bench gate 6),
更新 `tool-exposure-2026-10-30` 到新契约 (10 例全绿)。

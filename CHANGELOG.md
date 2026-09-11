# CHANGELOG

## v1.5.0-dev (2026-08-21) - 有机体八系统全通 + 模型路由中枢 + WebUI 美感升级
> 一次"从躯体到会进化"的冲刺: P0-P4 四大系统落地打通循环/内分泌/排泄/免疫, 模型接入重构为"本地零配置默认可跑、云端/本地自由接入", 产品壳与静态壳 WebUI 视觉统一升级。

### Architecture / 架构 (P0-P4 全落地, 见 docs/ARCHITECTURE-ORGANISM.md)
- **P0 ②循环系 · 全局总线** (新增 src/bus/): RuntimeBus = Event广播 + Command/Result回路 + State槽 + intercept拦截器; busPlugin 排装配数组首位注入 ctx.consume("bus"); agent 在 chat 入口/_runTool/记忆写入三处埋点 event. 29/29 测试过.
- **P1 ⑦内分泌系 · Reward 闭环** (新增 src/ans/reward.js): 订阅总线 tool/result 自动采集 (无需主动触发), EWMA 平滑维护各工具倾向权重 + 低可靠工具识别注入 system prompt; 驱动 lifecycle evolve + 上下文 db; 持久化跨重启. 6/6 测试过.
- **P2+P3 ⑤排泄系 · 排遗自治** (新增 src/ans/eviction.js): 冗余识别用自实现 bigram overlap 两两比较 (findSimilar 对自身返回1.0用不了), 冷热分层 + 治理报告; 启动挂每日02:00扫描(幂等); runMemoryEviction()/evictionStatus() 入口. 顺带修 Scheduler 缺 shutdown() 导致 daily 任务挂住进程退不出 (新增 Scheduler.shutdown + agent.shutdown 清定时器). 4/4 测试过.
- **P4 ⑧免疫系 · 全局闸门** (新增 src/ans/guard.js): 挂总线 intercept() 做全局免疫——危险 verb(delete/clear/wipe) 未授信默认阻断, 静态白名单 + approveGuard() 单次审批双模式授权; 全部命令记 Auditor 账本 + PII 探测 (实现 RC1 §5.3). 5/5 测试过. agent 暴露 guardStatus()/approveGuard().

### 模型接入重构 (新增 src/llm/router.js, 本地零配置默认可跑)
- **模型路由中枢** 替换旧"按配置序找第一个有key": 占位死配置过滤(REPLACE_WITH_YOUR_ENDPOINT 自动剔除不再误选/报噪音) + 云端真key优先 + 本地零配置兜底 + orderByHealth() 健康排序.
- builtin.js 旧 resolveLLM/resolveAllLLMs 迁 router.js, 只 re-export 向后兼容 (坑: import 而非 export 曾致 52 处 SyntaxError, 已修).
- 修本地兜底死穴: lmstudio 带字面 api_key 被 isLocal&&!hasRealKey 误排除 -> 本地收所有本地服务.
- config/ppx.json: volcengine 占位配置移出 providers 主体进 _optional_engines 说明. 6/6 测试过.

### WebUI 美感升级 (web/ Next.js 产品壳 + public 静态壳)
- globals.css: 设计令牌 --ppx-*(品牌色系) + @keyframes msgIn 进场动画 + .glass 毛玻璃 + 细滚动条 + 品牌选中色 + .field 输入聚焦光晕.
- page.tsx: header 毛玻璃吸附 + logo 光晕; 消息气泡带头像角标"虾"+名字+进场动画, 用户渐变/agent 深底; 空态品牌引导卡; 发送按钮渐变发光; 输入 field; 工具卡/tab/会话/场景/记忆/轨迹卡片统一边框+动效.
- settings/*: 侧栏导航品牌渐变 + 四页(general/model/plugins/presets)卡片/错误左色条/成功左绿条/按钮统一规范.
- public/index.html 静态壳: 追加 CSS 同款动效/渐变/聚焦/滚动条/阴影.
- 验证: tsc=0 + npm run build 482ms Compiled + 静态预渲染正常. 备份 globals.css.bak_0821 / page.tsx.bak_0821.

### 运维/踩坑记录
- model 页修复: 脚本链式 replace 把行卡片 className 尾段吞了(p-3.5"), 直接定位字节复位.
- **误删警示**: 清理临时脚本时 `Get-ChildItem -Filter '_*.mjs' -Recurse` 把 web/node_modules 的 babel/runtime 转译 helper 缓存(_apply_decorated_descriptor.mjs 等约百个)也删了; npm install 重建 + build 验证恢复, 源码零损伤 (page.tsx/globals.css/layout 完好). 教训: 清临时文件必须限定 workdir 且排除 node_modules; 别用裸 -Recurse 广扫.
- CHANGELOG: 本次为 v1.5.0-dev, 上一条 v1.4.0-dev (2026-08-19).


## v1.4.0-dev (2026-08-19) - Harness 强化: Auditor 独立验证 + held-out 回归 + 探索熔断
> 基于 AI-Agent 架构 7篇研究 (LongHorizon MEA / Self-Harness / Meta-Harness): 不信任模型自评, 只有独立验证通过的事实才写回持久状态。

- P0① Auditor 独立验证 + 已验证账本 ( 新增 src/audit/verifier.js ):
  - verifyLesson: 经验必须通过确定性闸门才写回经验库 (接地防幻觉 / 可操作动词 / 单句精炼), 拆掉 refine() 模型自评裸写的反模式。
  - Auditor.gate: "唯一已验证写回"通道, 账本持久到 data/audit/verified.json (含 reject 审计)。
- P0② held-out 回归闸门: refineSkill 样本够多时切出未见过的 held-out 子集, 要求接地工具在那里也有背书, 防过拟合训练集 (对应 Self-Harness "helled-out 无退化才合并")。
- P0③ 探索熔断 + 重复命令检测 (_llmWithTools): 连续 3 轮只有只读/查询无产出 -> 注入方向盘停止探测转交付; 同工具+同参数命中 2次 -> 警告重复。 config.agent.explore_break_limit / repeat_flag_limit 可调。
- 修复 verifyUpgradeSkill: 原 regex 无效 + 不剥 frontmatter -> 升级带 ---meta--- 的技能会误判"缩水"; 现先剥 frontmatter 再比正文, "缩水"检查真正生效。
- 新增 test/audit.test.js (14例) + test/circuit-breaker.test.js (3例)。
- 非网络全量 442 pass / 0 fail (+3 skipped); 网络类测试 (mcp/channels/wechat/ocr) 在 CI 本就挂起, 与本次无关。


## v1.3.1-dev (2026-08-19) — P2整改: context_window按模型预设 + 主动提醒温和通电
- **context_window 按模型预设**: openai=128k, deepseek=64k, qwen-turbo=131k, qwen-vl=32k, zhipu/glm-5v=64k; volcengine/lmstudio(本地)保持 8192 保守默认。长对话不再被过早压缩, 改善连贯性。
- **主动提醒温和通电**: proactive 默认 enabled=true(1h扫描), 无待办信号返回 null 不打扰 + 24h去重 + 过期检测(昨天/上周/已过日期)兜底。护城河特性默认可见。
- 同步更新 ans-features.test.js 断言(默认开启逻辑)。
- 全量测试 464 pass / 0 fail。


## v1.3.0-dev (2026-08-19) — 测试期整改: 控制台UTF-8 + 多模态接智谱 + 配置占位符校验
- **控制台 UTF-8 根治**: 新增 `src/utils/winutf8.js`（启动强制 chcp 65001 + stdout/stderr 锁 utf8），挂进 cli/server/channels-cli/agent入口/start-web 全部 5 个入口, 解决 PowerShell/GBK 终端把中文解成乱码。
- **DEP0190 修复**: `scripts/start-web.js` 去掉 shell:true → 数组传参 + 显式 npm.cmd, 消除子进程参数注入风险。
- **多模态接智谱**: providers 新增 `zhipu`(base_url=open.bigmodel.cn/api/paas/v4, model=glm-5v-turbo, vision:true, ZHIPU_API_KEY)。lmstudio 本地 gemma 视觉不可靠, 已关 vision=false, 避免和智谱抢读图。
- **配置占位符校验落地**: `config/index.js` 的 validateConfig 增加占位符检测(REPLACE_WITH_/your_endpoint/your_api_key), 启动即警告不可用户提供者, 杜绝 volcengine REPLACE_WITH_YOUR_ENDPOINT 静默失败的坑。
- 全量测试 464 pass / 0 fail (4 skipped 均为 !NET 网络用例)。


## v1.2.0 (2026-08-19)
- `src/memory/memory-ticker.js` + `src/memory/session.js`: 记忆滚动归档改用游标(lastRolledDay/lastRolledSeq), 只追加新事件, 修复同一段对话在 longterm 反复出现导致重复回话的问题。
- `src/tools/advanced.js`: HTTP fetch 重定向改 SSRF 安全模式(redirect:manual 逐跳校验公网地址), 堵住 "302→内网/云元数据" 绕过。
- 修复 `release_body_payload.json` v1.1.1 发布负载中文被 GBK 读坏(UTF-8 乱码), 用 `release_v1.1.1_body.md` 重建。
## v1.1.1 (2026-08-18) — bin 入口可执行性修复 + 性能/可靠性/一致性全面整改

v1.1.0 首次 npm 发布后暴露一个入口缺陷: `ppx-serve` 指向的 `src/server.js` 首行是 **UTF-8 BOM 且无 shebang**。npm 全局安装后 `ppx-serve` 被 symlink 到该文件, shell 无 shebang 会按默认 sh 解析, 遇到 JS 语法直接报错; 即便补 shebang, 前置 BOM 也会让内核把它当普通文本导致 shebang 仍失效。本版修复根因并重构为更稳的 bin 包装层。在此基础上, 依据对 v1.1.1 源码的全面评价(六维取证), 本轮同步落地一批性能/可靠性/一致性的代码整改。

### 入口修复
- **`src/server.js` 去 BOM + 补 shebang**: 删除文件首行 UTF-8 BOM(三字节 `EF BB BF`), 首行改为 `#!/usr/bin/env node`, 保存为无 BOM 的 UTF-8。`ppx-serve` 现在可被直接执行
- 验证: 文件头字节 `23 21`(`#!`), 无 BOM 前缀; `node --check` 语法通过; `bin/ppx-serve` 启动后 `GET /health` 返回 `{"status":"ok","agent":"皮皮虾"}`

### bin 包装层 (更稳做法, 业务文件不再直接当 CLI 入口)
- **新增 `bin/` 纯 shebang 包装脚本**, 三个 npm 命令统一走干净入口, 即使被杀瘘文件带 BOM 也不影响 CLI 执行:
  - `bin/ppx.js` → `import "../src/cli.js"`
  - `bin/ppx-serve.js` → `import { runServer } from "../src/server.js"` 并显式启动
  - `bin/ppx-channels.js` → `import "../src/channels-cli.js"`
- **`src/server.js` 提取 `runServer()` 公共启动逻辑**, 保持原有 `export async function startServer()` 导出(测试/web 均从它 import)和 `node src/server.js` / `scripts/start-web.js` 直接运行两条路径不变
- **`package.json`**: `bin` 三个目标改为 `bin/ppx.js` / `bin/ppx-serve.js` / `bin/ppx-channels.js`; `files` 增加 `"bin/"`(否则 npm publish 不会把 bin 打入包)

### 性能整改 (P1)
- **`session.deriveCompacted` / `eventsByDay` 增量/版本缓存**: 每轮/每工具轮都要调用的两条路径从「每次 O(T) 全量扫描」降为「O(Δ) 追加 + 版本失效」。deriveCompacted 用"数组引用标识"做增量——数组没换只把尾部新 user/assistant 追加进结果, 命中 O(Δ); set/rename/fork/delete 换新数组或追加 compaction 时整体重算。eventsByDay 用版本门控的全库按天缓存(保持本地自然日语义, 与分片命名一致), 每轮兜底一次仍远优于每次全扫
- **一轮对话只写一次磁盘**: `_pushTurn` 原先是 user 事件 + assistant 事件各触发一次同步落盘。新增 `append(..., { skipFlush })` + `flush(key)` 支持批量延后落盘, `_pushTurn` 用两条 skipFlush + 一次 flush, 单轮同步写从 2 次降为 1 次; 单条 append 缺省仍即时落盘(向后兼容, 不改写法)
- **`deriveCompacted` 返回同一数组引用**: 命中缓存时返回缓存数组, 减少每次请求的分配与 GC

### 可靠性 / 并发控制 (P1/P2)
- **HTTP 通道并发护栏**: 新增 `MAX_INFLIGHT=4` 计数信号量, `/message` 与 `/message/stream` 超出同时处理数立即 429 (`Retry-After: 5`), 防多慢请求无限叠加占用单线程主 agent; 复用/释放走 `finally`, 异常不漏。
- **Legion/DAG 并发上限**: `Legion` 新增 `maxConcurrent`(默认 8); `broadcast` 从一次性 `Promise.allSettled` 改为有界并发 `_mapBounded`; `dag.runDag` 支持 `{ concurrency }` 层内限流(缺省 0 = 不设限, 兼容旧调用), `Legion.runDag` 透传自身上限。防大 DAG/广播瞬间 spawn 海量子进程。
- **`dispatch` 标注实验性**: 按角色分工 API 生产无内置消费方, 补充「实验性」注释与使用指引, 避免镀金面误导。

### 响应质量 / DSML 适配 (P1/P2)
- **接线 `buildDsmlPrompt`(修复从未注入缺口)**: `DSML` 原生文本模型可通过 http provider 显式 `dsml: true` 开启。开启时 `_context` 会把 DSML 工具协议注入 system prompt, 让这类模型能稳定输出 DSML 结构做工具调用; 默认所有 provider 不注入(零回归)。新增 provider 键 `dsml` + 校验(须布尔)。
- **工具描述 token 预算**: `buildFencePrompt` / `buildDsmlPrompt` 对超长工具描述截断到 `MAX_TOOL_DESC_CHARS=240`(保留工具名 + `…`), 防超大/恶意描述在围栏/DSML 注入路径撑爆小上下文窗口 (围栏工具清单此前在预算之外)。

### 一致性 / 死代码 (P1)
- **`config/ppx.json` `proactive.enabled` 对齐 `false`**: 随包配置默认「主动任务生成」关(与 DEFAULT_CONFIG/文档一致, 兑现"默认关防打扰"), 不再默认开启打扰用户。
- **删除 `remove_schedule` 死引用**: `enableReadonlyMode` 禁用列表引用了从未注册的工具, 属死代码。
- **OpenClaw/API-key 报错文案统一**: 中英夹杂错误(`OpenClaw run status=` / `LLMClient: 缺少 API key`)改为 `[皮皮虾]` 前缀中文框架, 协议 token 保留括号说明。
- **前端术语统一**: 设置页侧栏「插件」→「插件与能力」对齐页面头; `model` 页 `Provider ID` →「提供方 ID（Provider ID）」; **`web/README.md` 从 Next.js 英文样板翻新为中文项目说明**。

### 新增测试
- `test/session-cache.test.js`: deriveCompacted 增量缓存 / 数组替换重算 / compaction 重投影 / eventsByDay 缓存一致性 / skipFlush+flush 批量落盘 / 单条 append 兼容。
- `test/dsml-prompt.test.js`: `buildDsmlPrompt` / `buildFencePrompt` 的工具协议输出、超长描述截断(保工具名)、协议转义防注入。
- 追加 `test/dag.test.js`: `runDag` 层内并发限流 + 缺省不限流。
- 追加 `test/providers-api.test.js`: provider `dsml` 键类型校验。

### 验证
- 4 个入口文件均无 BOM、首字节 `#!`、语法通过
- `bin/ppx-serve` → `/health` 正常; `bin/ppx-channels list` 正常输出通道; `startServer` 消费者路径(导入→启动→健康检查→退出) exit 0
- 注: 本测评环境沙箱禁止 `node --test` 子进程 spawn 管道捕获(EPERM), 无法完整跑测试套件; 已用单进程方式覆盖测试所消费的核心 `startServer` 路径, 本地 `npm test` 应全绿

## v1.1.0 (2026-08-17) — 第十轮评价整改: 配置键一致性 + 上下文溢出兜底 + 脚本数据隔离统一 + token 持久化 + 会话按天分片

依据 EVALUATION-2026-08-17 (第十轮) 整改。这轮兑现第九轮报告第六节「下一轮候选」全部 6 项 (P1×3 + P2×3)。

### P1 配置键一致性 (第九轮建议 #1)
- **新增 `test/config-consistency.test.js`**: 读 DEFAULT_CONFIG → 递归收集所有叶子键 → 断言每个键要么被 `CONSUMED` 表消费、要么进了 `RESERVED` 表(显式预留)。任何新增配置键不接消费点/不改注册表 → 该测试直接 FAIL, 杜绝"配置写了对但静默失效"。CONSUMED/RESERVED 两表兼作活文档
- 审计补齐遗漏: `security.deny` / `tools.disabled` 从未在 DEFAULT_CONFIG 声明却已被消费 → 补进默认结构; 新增 `memory.context_window`/`context_window_ratio`/provider `context_window`
- 移除死配置 `selfheal.max_restart_attempts` (代码零消费) — DEFAULT_CONFIG/config/ppx.json/docs/CONFIG.md 三处清理干净

### P1 上下文溢出兜底 (第九轮建议 #2, 本地小模型上下文溢出实测场景)
- **窗口感知历史预算**: `LLMClient.context_window` + `_histTokenCap()` — 用 provider 上下文窗口 ×60% 反推历史 token 硬上限, 与 `history_token_budget` 取小; 本地小模型即使历史预算配大也不会把上下文塞爆
- **强制硬裁剪**(不依赖 LLM): `_ensureContextFit()` 在 `_trimHistory` 基础上加绝对兜底(条数硬截 + 最近优先 token 裁剪, 必保最后一条); `_getSession` 双保险
- **溢出检测 + 自动降档重试**: `_isOverflowError()` 识别 `Context size exceeded`/`maximum context length`/413 等措辞(不误判 AbortError); `_llmWithTools` 捕获溢出 → `_shrinkMessagesForOverflow` 保留 system + 最后 user 起完整单元(含 in-flight 工具配对, 不剪成孤立 tool 消息) → 重发, 最多 2 档
- 新增 `test/context-overflow.test.js` (7 用例)

### P1 脚本数据隔离统一 (第九轮建议 #3)
- 新增 `scripts/lib/tmp-agent.js`: `makeTmpRoot`/`makeTmpAgent`/`makeAgentOnRoot`/`cleanupTmp`, dataDir 强制落在临时根内(覆盖 PPX_DATA_DIR), 清理必经安全护栏(路径须在 os.tmpdir 内, 否则抛错绝不删)
- 改造 bench/eval/acceptance/e2e-response-smoke/memory-benchmark/e2e-volcengine-smoke 6 个脚本, 消除各自手写 mkdtemp/dataDir/rmSync (杜绝将来重蹈误删生产数据的覆辙)

### P2 Web token 失效自动引导 (第九轮建议 #4)
- HTTP 自动生成的 token 持久化到 `data/http-token` (原子写), 重启复用 — 优先级: 显式配置(env/config) > 持久化复用 > 新生成并落盘。前端 localStorage 无需每次重启重贴
- `resolveAuthToken()` 纯函数可单测; 新增 `test/http-token-persist.test.js`

### P2 default 会话按天分片 (第九轮建议 #5)
- SessionStore 仅对 `default` 会话分片: `default-YYYY-MM-DD.jsonl` (按事件 ts 自然日), 单文件不再无限增长; 非 default 会话保持单文件
- seq 跨天连续递增(不每天重头数, compaction upToSeq/fork/replay 不错乱); 合并读取跨片按 seq 升序; 兼容旧 `default.jsonl`; delete/set/fork 处理全部分片
- 新增 `test/session-daily-shard.test.js` (13 用例)

### P2 selfheal 死配置清理 (第九轮建议 #6)
- `max_restart_attempts` 无人读取 → 按"要么实现要么移除"移除(实现成本高且无进程监督架构, 移除更合理)

### 验证
- 全量测试 node --test 见 README 数字 (新增 config-consistency 4 + session-shard 13 + http-token 5 + context-overflow 7 + 修复 session 死断言 1)
- scripts: acceptance 23/23, bench 0 失败, eval 7/7; 均过统一数据隔离 helper

## v1.0.9 (2026-08-17) — 第九轮评价整改: 命令执行安全 + 配置键修正 + 脚本数据保护 + 全链路审查

依据 EVALUATION-2026-08-17 (第九轮) 整改 (第八轮整改经实测验证: 通道认证/军团超时/MCP 加固全部生效):

### P0 脚本数据安全 (压测/评测可能删除生产数据)
- **scripts/bench.js + eval.js**: `new PPXAgent({ root })` 未显式传 dataDir, 若环境变量 `PPX_DATA_DIR` 指向生产, 脚本收尾 `rmSync(agent.dataDir)` 会**删除生产数据**。已显式传 `dataDir/globalDataDir` 覆盖环境变量; acceptance/e2e 脚本同步加固。实测: 设 PPX_DATA_DIR 假目录跑 eval, 数据隔离正确不触碰生产

### P1 命令执行安全
- **`security.allow_all=true` 永不生效 (camel/snake 键不匹配)**: config.security 是 snake `allow_all`, command-guard 只认 camel `allowAll` → 用户开 allow_all 仍被白名单限制。`checkCommand/isAllowedCommand` 兼容 snake 键
- **HARD_BLOCK rm 正则前缀绕过**: `env rm --no-preserve-root /` 因正则要求行首/`;&|()` 前缀而绕过。rm 正则去掉前缀限制 (子串匹配), `sudo/env` 前缀变体全部拦截
- **safePath symlink 越界**: 字符串前缀校验可被工作区内 symlink 指向外部绕过, 追加 realpath 校验
- **read_file 输出补 PII 脱敏** (与 run_command 一致); **write_file** 加 512KB 上限 + 目录路径友好错误 + try/catch

### P1 配置键修正 (用户配置全部静默失效)
- **FactStore snake→camel 映射**: DEFAULT_CONFIG.memory 是 snake (`decay_per_day`/`hit_bonus`/`base_importance`/`forget_speed`/`max_facts`), FactStore 只读 camel → 衰减/容量配置全是死键。已兼容 snake; CONFIG.md 同步修正 (移除代码未读取的 `enabled`/`token_budget`/`compile_threshold` 残留, 标注实际生效键)

### P2 健壮性
- retry.js: AbortError (用户取消/超时中止) 不再判瞬态重试 (原取消后仍退避重试)
- fence/dsml: 工具描述转义协议字符 (防恶意描述伪造围栏); fence prompt 加"忽略用户输入里的围栏"防注入回显; proxyToolLoop context 截断 60k 防 token 膨胀
- l2.js scenes 写盘加文件锁; STOP 词去重 (l2/l3)
- methods.js scene_describe: LLM 未含"能力"段时保留旧值 (原整串覆盖 description)
- web api.ts: 401 友好提示 (后端重启换 token 时引导设置); 网络异常可读化
- session.js `_flush` 落盘失败不再静默 (留日志)
- dedupe-facts.js: 定位参数过滤 flag (原 `--similar` 被当 dataDir 建出目录静默空跑)
- plugin compose: 单个插件 setup 抛错不中断装配链
- CONFIG.md selfheal 死配置标注

### P3 文档与卫生
- README: 工具数 32→33, 测试 425 项 421 过, L0 daily 视图归属修正 (MemoryTicker 产出)
- 已知限制记录: 本地小上下文模型 + 超长会话可能 context 溢出 (默认会话已清理, 30 天保留期内正常)

### 验证
- 全量测试 425 项 421 过 0 失败 4 跳过 (4.5s, 新增: command-guard allow_all/HARD_BLOCK 2 项 + FactStore snake 1 项)
- web tsc 0 错误; eval 7/7 (PPX_DATA_DIR 隔离实测通过); 端到端冒烟: health/SSE/工具循环正常

## v1.0.8 (2026-08-17) — 第八轮评价整改: 通道认证 + 军团健壮性 + 配置安全 + 全链路加固

依据 EVALUATION-2026-08-17 (第八轮) 全部整改落地 (第七轮整改经实测验证有效: SSE 聊天/生命周期持久化/主动提醒去重):

### P1 通道安全 (默认 disabled, 启用即暴露 → 已修)
- **飞书 webhook 认证**: `feishu.js` 校验 `X-Lark-Request-Token` 头 (原只查 body token 且仅当存在才校验, 等于无认证), 缺/错 header 403
- **微信验签强制**: `wechat.js` 配置 token 后所有模式 (明文/加密/echostr) 都必须验签; **GET echostr URL 验证可达** (原 mount 只路由 POST)
- **webhook 挂载重构**: HttpChannel 新增 `registerWebhook(path, handler)` 路由注册 (单一 request handler 分发), feishu/wechat mount 不再 `removeAllListeners` 吞主 handler, 消除多通道互踩与双响应竞态 (ERR_HTTP_HEADERS_SENT)

### P1 军团通信 (worker 异常不再永久挂起)
- `agent-worker.js` error 行带 `req.id` (原无 id → 主进程 pending 永不 settle)
- `Legion.send()` 加超时兜底 (默认 30s, 可覆盖), pending 超时清理; `broadcast` 使用 timeout 参数 (原声明未用); spawn 监听 `error`; stdin.write 错误处理
- `shutdownAll()` 兜底 kill 未退出进程 (worker 无响应不残留); `agent.shutdown()` 清理 `_legion` 子进程
- worker 串行队列 (防并发 data 事件覆盖 currentReqId/_perspective)

### P1 MCP 加固
- 工具描述清洗: 单行化 + 截断 200 (服务器描述直接进 LLM prompt, 防换行/长文本注入指令); 工具名白名单 `[\w.-]` + 截断 64
- stdio 子进程: 关闭时杀进程树 (Windows taskkill /T, POSIX 负 pid), stdin error 监听 (防 EPIPE 崩溃), stdout 缓冲上限 1MB

### P2 配置与数据安全
- `settings.updateSettings`: patch 顶层/分区字段按 SETTINGS_FIELDS 白名单过滤 (原任意字段可写入磁盘); 写盘在文件锁内读-改-写
- `providers.js`/`channels.js` 写操作加 `withFileLock` (原 read-modify-write 并发丢更新)
- `channels.js` boolean 识别字符串 `"false"` (原 `!!"false"` → true)
- `store.js` `atomicWrite`: rename 失败重试 3 次 (原降级非原子直接写, 并发可损坏文件)
- `trace.js`: args/result 落盘前 PII 脱敏 (凭证不写日志); `read(day)` 支持指定日期 (原忽略参数恒读今天)
- `pii.js`: 补邮箱/手机号规则, inline_secret 值域放宽 (含 `:#`) + 8 位起

### P2/P3 边界与健壮性
- readonly 模式禁 `refine` (会写经验库, 审查者也不应触发)
- DAG: 校验重复 id / 依赖不存在 (原静默丢弃); mode/legion workflow 节点结构校验
- `create_skill` 内容长度上限 (description 300 / content 50000)
- `delegate.js`: fix_rounds=0 可设 0 (原 `||3` 变 3); 审查严重级 token 中文化 (严重/重要/次要, 解析兼容中英); send 传超时对齐 withTimeout
- blackboard 空专家数组回退默认; healer 英文日志中文化; notify 消息中文化
- ARCHITECTURE.md 修正 (dispatch 无生产消费方说明 + 军团协议细节)

### 验证
- 全量测试 422 项 418 过 0 失败 4 跳过 (网络型), 3.5s (新增 test/hardening.test.js 9 项 + 微信验签/通道测试更新)
- web tsc 0 错误; 端到端冒烟: health / SSE 聊天 / sessions / 静态页 / 未挂 webhook 路径 404 全部正常
- 生产数据卫生保持: facts 1 条真实待办, 经验 1 条


## v1.0.7 (2026-08-17) — 第七轮评价整改: Web 聊天链路修复 + ANS 状态化 + 性能健壮性

依据 EVALUATION-2026-08-17 (第七轮) 全部整改落地:

### P0 Web UI 聊天链路修复 (实测 404 → SSE 正常)
- **`web/next.config.ts` 补 `/message/stream` 代理** (原漏配, 浏览器聊天 404); 顺带补 `/sessions` + `/sessions/:path*` 代理
- **`web/src/app/page.tsx` 重写**: send() 统一带 Bearer token (从 localStorage, 与 api.ts 一致); 会话管理 tab (列表/新建/切换/重命名/删除 + 恢复历史); 工具调用卡片 (调用中→✓完成/✗失败, 含耗时); 场景新建改 modal 表单 (替代 prompt); 首启引导/多会话/统计保留
- **后端 `GET /sessions/:key/history`** 新增: 切换会话时恢复消息显示

### P1 ANS 状态化 (从"壳"到"有状态")
- **Lifecycle 持久化**: `src/ans/lifecycle.js` 状态落盘 `data/memory/lifecycle.json`, 跨进程/重启不归零; 新增 `evolve()/reproduce()` 方法 (内部落盘), agent/delegate 全部改用 (不再直接改字段)
- **proactive 去重 + 完成跟踪**: 提醒状态存 `data/memory/proactive.json`; 同待办 24h 窗口内不重复提醒; `markTaskDone(id)` 标记完成后永不再提醒; CLI `/proactive-done <id>` + HTTP `POST /api/proactive/done`; 过期待办 (昨天/已过日期) 自动跳过
- **记忆噪声治理**: `addMemory` 寒暄词开头短句拦截 (修 "你好皮皮虾" hits=123 逃逸精确匹配) + 长度上限 200; 提炼器 prompt 显式跳过寒暄/元讨论; 生产 facts 19→1 条 (删 3 噪声 + 15 条"三件套"元记忆变体), 经验库 2→1 条

### P1/P2 性能与健壮性
- **辅助 LLM 调用快速失败**: `llm.chat/apiChat` 支持 `timeoutMs`/`retryMax` 覆盖; 压缩/提炼/查询扩展/经验提炼/主动提醒 统一 10s 短超时 + 禁重试 + 前置 health 探测 (模型不可用毫秒级跳过)。修复模型不可用时主对话 30-40s 卡死
- **压缩节流**: `_compactIfNeeded` 压缩后 60s 内不重复 (修复每轮对话重复付 8s LLM 压缩成本, 实测 10s→0.39s)
- **工具执行统一**: `_llmWithTools` 内嵌工具执行改走 `_runTool` (trace/事件只此一份), 移除死参数 `llmInstance`
- **经验同义合并**: `Experience.learn` 增加 bigram overlap 同义变体合并 (阈值 0.5, 真实变体校准), 排除"仅编号不同"模板句
- **CORS 可配白名单**: `channels.http.cors_origin` 数组, 配置后仅放行白名单浏览器来源 (403 拒绝), 无 Origin 非浏览器请求放行; 未配置默认 `*` 兼容

### P2 语言与卫生
- 语言残留清零: notify 参数描述中文化 / `[interrupted]` 改中文 / catalog 日志中文化
- 生产数据清理: facts 19→1, 经验库 2→1 (同义合并 uses 累加)

### 验证
- 全量测试 412 项 408 过 0 失败 4 跳过 (网络型), 3.7s (新增 10 项: 生命周期持久化 2 / 主动提醒去重 2 / addMemory 过滤 / 经验同义合并 2 / CORS 2 / 过期待办)
- web tsc 0 错误; 端到端实测: Web 代理 /message/stream SSE 正常 (原 404), 会话历史/列表可用, /message 首次 10s (压缩) 后续 0.39s
- eval 本地能力 7/7; 生产 facts 只留真实待办 "记得明天提交周报"


## v1.0.6 (2026-08-17) — MCP 配置 UI + 工具启停 + 首启引导

依据 EVALUATION-2026-08-17 (第六轮) 四项整改全部落地:

### P1
- **MCP 配置进 UI**: settings.js 加 mcp 分区 (servers 白名单字段 + auto_connect), headers/env 只回 set 标志
  (明文不回传); 插件页新增 MCP 服务器配置表单 (stdio command/args / HTTP url / 删除 / 自动连接开关)
- **工具启停进 UI**: settings.js 加 tools.disabled 分区; `agent._applyDisabledTools()` 启动时 + reloadSettings
  热应用禁用列表; 插件页工具列表加启停开关 (即时生效, 持久化到 config)

### P2
- **首启引导升级**: 横幅从单维度 (模型未配) 升级为多维度 (模型未配 > MCP 未配), 可分别关闭
- MCP 校验: 每项至少 command 或 url, 只保留白名单字段

### 验证
- 全量测试 402 项 398 过 0 失败 4 跳过 (新增 4 项: mcp 白名单/脱敏、tools.disabled、启动应用)
- web tsc 0 错误; 端到端冒烟: PUT mcp+tools → web_search 禁用生效 / run_command 保持启用

## v1.0.5 (2026-08-17) — Web 设置页补齐 (1 精 3 空 → 4 全)

依据 EVALUATION-2026-08-17 (第五轮) 补齐 Web 产品壳短板:

### 后端
- **`src/config/settings.js` (新建)**: 通用设置读写 (user/http/security/agent 预设), 复用 providers 的备份+原子写+校验模式
- **`GET/PUT /api/settings`**: 读取安全视图 (auth_token 只回 set 标志) / 白名单字段更新 (端口 1-65535 / 超时 >=1000ms / values 字符串数组校验)
- **`agent.reloadSettings()`**: 写盘后热重载 userName/mode/values, 立即生效
- **`stats()` 扩展**: 新增 tools.list (明细+enabled+category) / skills 列表 / mcp 连接状态, 供插件页展示

### 前端 (3 个占位页全部实现)
- **通用设置页**: 用户名/HTTP 端口/安全 (allow_all+命令超时)/agent 名称+编排模式
- **插件与能力页**: 内置工具启用状态 (绿/红点+分类) + 方法技能列表 + MCP 连接状态
- **智能体预设页**: 核心价值 (values 按行编辑) / 额外系统提示词 (system_extra) / 引用规则 (citation_rule)

### 验证
- 全量测试 398 项 394 过 0 失败 4 跳过 (新增 9 项 settings-api)
- web tsc --noEmit 0 错误; /api/settings GET/PUT 端到端冒烟通过 (含热重载)

## v1.0.4 (2026-08-17) — 感知式记忆提炼 + 存量变体清理

依据 EVALUATION-2026-08-17 (第四轮) 三项整改全部落地:

### P1 感知式提炼 (从源头防同主题重复)
- **`_extractMemory(user, assistant, existing)`**: 提炼前检索与本次对话相关的已有记忆 (同主题 top 3), 喂给 LLM 让其跳过与已有记忆同义/被覆盖的提炼结果 — 从源头减少"任务描述要详细"这类松散变体反复入库
- **`FactStore._overlap()` + `findSimilar(method=overlap)`**: bigram overlap (交集/较短者) 系数, 对"词序变化大但共享核心词"的松散同义改写比 Jaccard 更敏感
- **`add()` 双保险**: similarThreshold 时先 Jaccard 再 overlap 兜底命中
- **`memory-ticker` extractor 通道**: 传入相关记忆 + 高命中 (hits>5) 事实跳过提炼

### P2 存量清理
- 生产 facts 23→19 条 (overlap 0.65 合并 4 条同义变体, 最高 Jaccard 0.583→0.385)
- L3 画像"三件套"重复行 10→1
- `dedupe-facts.js` 新增 `--overlap <阈值>` 选项 (与 --similar 可叠加)

### P3 文档
- README 新增「评测与 CI」节: eval/--llm/PPX_E2E_* secrets 配置指引

### 验证
- 全量测试 389 项 385 过 0 失败 4 跳过 (网络型), 3.6s
- 新增 3 项 overlap 去重测试 (真实生产变体数据校准)

## v1.0.3 (2026-08-17) — 数据卫生收尾 + 测试提速 30 倍

依据 EVALUATION-2026-08-17 (第三轮) 五项整改全部落地:

### P2 数据卫生
- **自愈补清 `.bak-*` 文件**: `Healer.cleanupStaleBakFiles()` 保留最近 2 个更早删除 (data/ 现有 3 个手动备份残留清零)
- **会话过期清理**: `SessionStore.pruneOld()` 启动时清理超期会话 (config.memory.session_max_age_days, 默认 30; default 始终保留); 删除 test.jsonl 测试遗留
- **测试隔离根治**: `test/memory.layers.test.js` 发现用真实 ROOT 构造 agent 污染生产 data/sessions (违反 P0 测试隔离), 改为 tmp 目录

### P2 CI secrets + P3 并发锁
- **CI eval job 接 secrets**: 配了 PPX_E2E_BASE_URL/API_KEY/MODEL 时自动跑 `eval.js --llm` LLM 端到端回归, 未配只跑本地能力
- **FactStore 并发写锁**: add/hit 锁内读-改-写 (withFileLock), 与 Experience 对称, 防军团多进程共享 dataDir 丢更新

### P3 测试提速 (107s → 3.5s, 30 倍)
- **legion.test.js 90s → 1.5s**: dispatch 测试原发 type=chat 触发真实 LLM (lmstudio 未运行等 180s 超时), 改 ping 验证派发路由
- **health.test.js 10.7s → 0.09s**: 真实 /models 探测加网络 gate skip (PPX_NET_TEST=1 才跑, 与其他网络测试一致)

### 验证
- 全量测试 386 项 382 过 0 失败 4 跳过 (网络型) — 从 107s 降至 3.5s
- web tsc --noEmit 0 错误

## v1.0.2 (2026-08-17) — 记忆去重闭环 + 语言统一中文

依据 EVALUATION-2026-08-17 (第二轮) 整改: 修复记忆层重复污染 + web 语言统一。

### P0 记忆去重闭环 (三层)
- **经验库内容去重**: `Experience.learn()` 按 lesson 归一化查重, 命中则 uses+1 并刷新时间, 不新增 — 消除高频学习路径写放大 (src/memory/experience.js)
- **记忆语义去重**: `FactStore.findSimilar()` (bigram Jaccard) + `add(similarThreshold)` 可选参数 — LLM 提炼的字面变体 (同义不同词) 与已有事实相似度达标时命中加分而非新增; `memory-ticker` extractor 通道默认启用 (阈值 0.6)
- **L3 画像展示去重**: `buildUserPersona` / `buildAgentPersona` 展示前 `_uniqByContent` 去重 (src/memory/l3.js)
- **存量清理**: 经验库 60→2 条 (59 条重复「零依赖」), facts 35→19 条 (12 条「三件套」变体→2 条), L3 画像 force 重建; 备份保留 .bak-dedupe / .bak-simdedupe
- **工具沉淀**: `scripts/dedupe-facts.js` 新增 `--similar <阈值>` 语义去重选项

### P1 web 语言统一中文 + 字体本地化
- `layout.tsx` `lang="en"` → `lang="zh-CN"`; 移除 `next/font/google` (Geist) 依赖 → 系统字体栈 (无网/国内 build 不挂)
- 界面英文残留清零: 「vision」标签→「视觉」、「Enter 发送」→「回车发送」、「Agent 预设」→「智能体预设」
- `globals.css` body font-family 引用 `var(--font-sans)` 统一

### 修复
- `server.js` 通道配置合并 bug: port/host 参数优先级低于 config 端口, 导致测试动态端口 (port=0) 失效 — 改为 port/host 参数最高优先级

### 验证
- 全量测试 382 项 379 过 0 失败 3 跳过 (新增 12 项: dedupe-adv 9 + server-channels 3)
- web tsc --noEmit 0 错误

## v1.0.1 (2026-08-17) — 全面优化: CI/CD + 阈值可调 + 主动提醒通电

依据 EVALUATION-2026-08-17 六项整改全部落地。

### P0 持续验证机制
- **CI/CD**: 新增 `.github/workflows/ci.yml` — push/PR 自动跑 Node 20/22 全量测试 + web tsc --noEmit + 生产构建 + 本地能力评测
- **README 同步**: 测试统计 368/365 → 370/367

### P1 LLM 端到端回归 + 阈值可调
- **eval.js 升级**: provider 三选一 — `--provider <id>`(config) / `PPX_E2E_*` 环境变量(CI 注入真实 key) / LM Studio 兜底; 新增 `--quick` 跳过 LLM 层
- **阈值 config 化**: `MAX_TOOL_ROUNDS` / `TOOL_RESULT_BUDGET` / `MAX_TOOL_ERROR_RETRY` 硬编码 → `config.agent.{max_tool_rounds,tool_result_budget,max_tool_error_retry}` (DEFAULT_CONFIG + ppx.json 双份)

### P2 数据卫生 + 主动提醒通电
- **自愈增强**: `Healer.cleanupStaleBackupDirs()` 自动清理 `memory-backup-*` 手动备份目录 (保留最近 2 个), heal() 内调用; 清理 8/14 旧备份残留
- **主动提醒通电**: 修复 server.js 通道配置 bug (原来只读调用方 config, 不读 config/ppx.json, 导致 channels.log 永远不启用) — 现在以 agent.config.channels 为基础合并; CLI 也接入 proactive ticker 输出 stdout; config/ppx.json 默认启用 log 通道 + proactive
- **验证**: 全量测试 370 项 367 过 0 失败 3 跳过 (新增 4 项: cleanupStaleBackupDirs 保留/不误删), proactive→ChannelManager→log 链路实测广播成功

## v1.0.0 (2026-08-17) — 独立自包含 + 可发布

皮皮虾从「依赖 OpenClaw/dsh 外部引擎的壳」进化为「独立自包含、零外部引擎依赖」的 agent，并补齐分发链路。这是首个正式版。

### 引擎整合：吸收 OpenClaw/dsh 精华（四阶段）
- **重试内核** `src/llm/retry.js`：瞬态分类重试（429/5xx/timeout + Retry-After + 可取消指数退避），`_request` 抛结构化 status
- **会话压缩层** `src/memory/compaction.js`：超阈值时 LLM 压缩成结构化摘要（目标/进展/关键决策/待办/关键上下文），投影层替换被压缩区间（日志不可变）
- **能力 seam** `src/seam/shell.js`：命令执行抽象为可替换 provider，run_command 解耦硬编码 execFile；工具层加 before/after 钩子链
- **纯文本工具调用修复**：http 后端返回文本工具意图时自动恢复为原生 tool_calls
- **turn/step 分层**：`setStepEvent` + 推理轮次事件，军团 worker 上报进度（legion `send` 支持 onProgress 中间事件）
- **移除引擎默认依赖**：config 默认纯 http 直连，openclaw/dsh 移入 `_optional_engines` 注释配置（后端代码保留为可选接缝）

### 分发准备
- **npm 发布字段**：bin（`ppx`/`ppx-serve`）、repository、author、exports
- **去本机硬编码**：`C:/Users/<user>/...` 路径清零，改环境变量 `PPX_OPENCLAW_MJS`/`PPX_DSH_ROOT`
- **Node 版本放宽**：`>=22.22.3(排除23/24.0-24.14)` → `>=20`（openclaw 后端运行时检测降级）
- **数据目录外置**：`PPX_DATA_DIR` 环境变量 + node_modules 包自动外置 `~/.ppx`

### 体验改进
- **Web UI**：send() 从非流式改为 SSE 流式 + step 推理轮次 + 工具调用状态；修复 settings 页历史 TS 类型错误
- **文档**：新增 `docs/QUICKSTART.md`、`docs/CONFIG.md`、`docs/ARCHITECTURE.md`
- **打包流程**：`npm run release` 一键打包（build 前端 + pack 内核到 dist/）+ Dockerfile（一条 docker run 起内核+Web UI）
- **benchmark** 去硬编码，从 config 读 provider
- **注释统一**：英文残留清零

### 验证
- 全量测试 292 项 289 过 0 失败 3 跳过（网络型）
- 前端 `tsc --noEmit` 0 错误 + `next build` 生产构建成功
- `npm run release` 完整跑通（68 文件 110.5KB tgz）

## v0.10.3 (2026-08-16) — 模型配置 Web UI (DSH 风格首启向导)

补上"首启即可视化配置 LLM 提供方", 用户不再需要手改 `config/ppx.json`。

### 后端: 提供方 CRUD + 热重载
- **`src/config/providers.js`** (新建): 提供方 CRUD (load/validate/sanitize/add/update/remove/reorder) + 原子写盘 + .bak 备份 (保留最近 3 个)
- **`src/channels/http.js`**: 新增 6 个路由
  - `GET    /api/providers`        列表 (key 抹掉, 只返 api_key_set 标志)
  - `POST   /api/providers`        新增 (body: { provider: {...} })
  - `PUT    /api/providers`        更新 (body: { id, patch })
  - `DELETE /api/providers`        删除 (body: { id })
  - `POST   /api/providers/test`   健康探测 (复用 agent LLM 客户端 → 兜底从磁盘构造)
  - `POST   /api/providers/reorder` 重排 (默认 = 第 0 个)
- **`src/agent/index.js`**: `reloadProviders()` 方法, 写盘后立即重建 `this.llm` / `this.allProviders`, 无需重启
- **`src/server.js`**: 测试 stub 注入同步覆盖 `allProviders`, 让 /test 路由也能命中 stub

### 前端: 设置子路由 + 首启引导
- **`web/src/lib/api.ts`** (新建): fetch 封装 + Bearer token 处理 (localStorage)
- **`web/src/app/settings/layout.tsx`** (新建): 设置页布局, 左侧子导航 (模型 / 通用 / 插件 / Agent 预设)
- **`web/src/app/settings/model/page.tsx`** (新建): 模型设置主面板
  - 提供方卡片列表 (状态点: 绿=就绪 / 红=未配)
  - 编辑 / 删除 / 测试连接 按钮
  - "+ 添加提供方" (6 个常用模板: OpenAI/DeepSeek/通义/火山/Qwen-VL/LM Studio)
  - "+ 添加自定义提供方" (任意 OpenAI 兼容端点)
- **`web/src/app/settings/{general,plugins,presets}/page.tsx`** (新建占位): 三栏子页面占位, 后续按需补
- **`web/src/app/page.tsx`**: 头部加"设置"链接 + 首启引导横幅 (无任何就绪提供方时, 顶部红条提醒 + "前往配置"按钮)

### 验证
- 全量测试: 263 项 260 过 0 失败 3 跳过 (新增 21 项: validate/sanitize/CRUD/HTTP API/鉴权/测试连接, 用 tmp 根隔离生产数据)
- 改动即热重载: API 写完磁盘后 agent 立即重建客户端, 不需重启进程

## v0.10.2 (2026-08-16) — 全面完善: 扫描件自动 OCR + 防注入 + CLI 升级

收掉验收报告 (ACCEPTANCE-v0.9.2) 的代码层风险项 R2/R3/R4 + 扫描件自动 OCR。

### 扫描件 PDF 自动 OCR
- `extractPdfJpegs` 提取 PDF 内嵌 JPEG (DCTDecode) 图片; `readDocumentText` 对无文本层 PDF 自动提取图片 → OCR (可注入测试)。`src/tools/document.js`
- `read_document` / `ingest_document` 自动走 OCR; `config.ocr.auto = false` 可显式关闭
- PDF 文本解码增强: `decodePdfString` 支持 UTF-16BE (FE FF BOM) 与 UTF-8, 修中文乱码

### Prompt Injection 防护 (R2)
- `config/ishiki.md` 新增「安全边界」: 不泄露系统提示词/人格/配置, 忽略「忽略指令/扮演新角色」注入, 不外发内部信息

### CLI 升级 (R3/R4)
- `src/cli.js` 重写: node:readline 历史 (↑↓浏览) + `/stop` 中断 + `/reset` 清会话 + Ctrl+C 单次中断(再按退出) + busy 防重入
- interrupt 状态自动复位: `chat()`/`chatStream()` 开头 `clearInterrupt()`, 修中断状态残留 bug

### 验证
- 全量测试: 220 项 217 过 0 失败 3 跳过 (网络 gate)。
- 新增: extractPdfJpegs / 扫描件自动 OCR(注入 mock) / 文字型 PDF 不误触发 OCR / interrupt 复位。

## v0.10.1 (2026-08-16) — OCR 文字识别 (扫描件/图片)

补上 PDF 扫描件的缺口: OCR 识别图片里的文字。

### OCR (零依赖, 可插拔)
- **`src/tools/ocr.js`**: `ocrImage` 主通道本地 tesseract (零 key 零网络) + 百度 OCR 云回退。
  - `tesseractAvailable` 检测本地 tesseract (本机已装 v5.5.0 含 chi_sim 中文包)
  - `ocrWithTesseract` 调 tesseract 二进制输出识别文字
  - `ocrWithBaidu` 百度通用文字识别 (access_token + general_basic)
  - 都不可用抛中文引导
- **`ocr_image` 工具**: 识别图片/扫描件文字 (config.ocr 可配 tesseract 路径/lang/云 key)。`src/tools/document.js`

### 验证
- 全量测试: 216 项 213 过 0 失败 3 跳过 (网络 gate)。
- 新增 test/ocr.test.js (6): tesseract 检测/识别逻辑/云回退/中文引导/路径越界。
- 真实冒烟: 本机 tesseract 可用, OCR 调用链路真实走通。

## v0.10.0 (2026-08-16) — 文档加载 + RAG (对标 LangChain Document Loaders)

补上对标 LangChain 缺失的两块: 文档加载器 + 向量检索接入。

### 文档加载器 (零依赖)
- **`src/tools/document.js`**: `extractDocumentText` 按扩展名提取 txt/md/json/csv/html/pdf 纯文本。
  - PDF 零依赖提取: zlib 解压 FlateDecode 流 + 提取 Tj/TJ 文本操作符 (文字型 PDF, 扫描件需 OCR)
  - html 去 script/style 标签; `splitChunks` 按段落分块 (~500 字)
- **`read_document` 工具**: 读本地文档转纯文本 (复用 safePath 防路径穿越)

### 向量检索接入 (可选)
- **`src/llm/embedder.js`**: `createEmbedder` 从 `config.embedding` 读 OpenAI 兼容 embedding 端点 (零依赖 fetch), 返回 embed 函数。
- **自动注入**: toolsPlugin 启动时配了 `config.embedding` 则 `facts.setEmbedder`, 记忆检索自动切 dense cosine + BM25 RRF 融合; 不配则纯 BM25 + LLM 扩展兜底。

### RAG 入库闭环
- **`ingest_document` 工具**: 读文档 → 分块 → 写入 FactStore (带 scope 来源标签, 与对话记忆同库统一检索)。

### 验证
- 全量测试: 210 项 207 过 0 失败 3 跳过 (网络 gate)。
- 新增 test/document.test.js (9): txt/md/html/pdf 提取 / 分块 / read_document / ingest_document / embedder。

## v0.9.2 (2026-08-16) — P0 工程收尾 (版本号/残留清理/自愈修复)

### 修复
- **版本号同步**: `package.json` `version` 0.1.0-beta → 0.9.1 (与真实版本脱节 9 个小版本)
- **自愈 corrupt 清理 bug**: `Healer.cleanupCorruptBackups` 定义了但 `heal()` 从未调用, 导致 `.corrupt-*` 备份持续累积。修复: `heal()` 内自动调用, 保留最近 2 个。`src/selfheal/healer.js`
- **清理 data/ 残留**: corrupt 备份 6 → 2 (保留最近 2 个), 无 tmp/bak 残留

### 验证
- 全量测试: 201 项 198 过 0 失败 3 跳过 (网络 gate)。
- 新增 test/selfheal-cleanup.test.js (2): 自动清理保留最近 2 / 不足 2 不误删。

## v0.9.1 (2026-08-16) — 多模态读图接通 (视觉模型接入)

把「多模态为零」补齐为可用的读图链路。此前 read_image 工具 + toToolContent 转 image_url 块存在, 但图片落在 tool 消息里 (OpenAI 视觉 API 要求图片在 user 消息), 且没有视觉模型。

### 多模态链路
- **图片自动注入**: `_visionUserContent` 扫描 user 消息里的图片路径 (png/jpg/gif/webp/bmp), 同步读图注入为 OpenAI 视觉格式的 `[{type:text},{type:image_url}]` content 数组。`src/agent/index.js`
- **视觉路由**: `_llmWithFallback` / `chatStream` 检测到消息含 image_url 块时, 优先路由到 `vision: true` 的 provider (否则图片发到文本后端浪费)。`src/agent/index.js`
- **provider 标记**: `LLMClient` 新增 `vision` 字段 (provider.vision)。`src/llm/client.js`
- **纯函数复用**: `imageFileToDataUrl` 抽出, read_image 工具与图片注入共用。`src/tools/builtin.js`
- **视觉模型接入**: config 新增 `qwen-vl` provider (qwen-vl-max, vision: true, DASHSCOPE_API_KEY)。`config/ppx.json`
- buildMessages / chatStream 统一走 `agent._userContent()` 组装 user 消息。`src/mode/index.js`

### 用法
对话中说「看这张图 ./screenshot.png 里有什么」即可, 图片自动读入 + 路由到视觉模型。openclaw/dsh 是文本围栏不传图, 图片只走 http+vision 后端。

### 验证
- 全量测试: 199 项 196 过 0 失败 3 跳过 (网络 gate)。
- 新增多模态用例: imageFileToDataUrl / _userContent 注入 / 无 vision 回退 / _visionLLM 路由 (test/multimodal.test.js)。

## v0.9.0 (2026-08-16) — 路线图收尾: 微信/沙箱/军团模式/自我进化

依据 `docs/EVALUATION-v0.8.2.md` 的 P1/P2 剩余项, 一次性收尾四个离线可做的硬骨头。

### P1 微信通道收尾 (半成品 → 完整)
- **主动推送 send()**: 企业微信应用消息 API (gettoken + message/send), 需 corp_id + corp_secret + agent_id。`src/channels/wechat.js`
- **加密模式被动回复**: 新增 `encryptReplyXml()` 生成含 MsgSignature/TimeStamp/Nonce 的加密回包; 加密 webhook 解密处理后自动加密回包。`src/channels/wechat-crypto.js`
- **config 补字段**: `channels.wechat.{path,token,encodingAESKey,corpId,corpSecret,agentId}` + `channels.feishu.{appId,appSecret,verifyToken}`。`src/config/index.js` `config/ppx.json`

### P1 code_act 沙箱化 (进程级加固)
- **干净环境变量**: `sandboxEnv()` 白名单只留运行必需变量, 剥离一切 API_KEY/TOKEN/SECRET/凭证, 防脚本窃取宿主凭据。`src/tools/builtin.js`
- **node 内存上限** `--max-old-space-size=256` + 输出上限 512KB + `windowsHide` + 超时强杀进程树。
- 真正隔离需外部 Docker/MicroVM, 文档注明 (见 docs/CONFIG.md)。

### P2 多 Agent 军团模式接入 mode 系统
- 新增 `src/mode/legion.js`: `legionExecutor` 懒建 Legion (缓存到 agent._legion), workflow 走 DAG 编排, 否则 broadcast 取首答。
- `PPXAgent` 支持 `dataDir` 覆盖 + `agent-worker.js` 用 `PPX_AGENT_DATA_DIR` 隔离军团数据目录 (修 worker 读取未使用的半成品)。
- mode 注册 6 → 7 个 (react/single/plan-exec/router/blackboard/graph/legion)。`src/plugin/builtin.js`

### P2 自我进化闭环补全 (轨迹 → 经验 → Skill)
- 新增 `PPXAgent.refineSkill()`: 成功轨迹 → 高频成功工具模式 → LLM 提炼 → 复用 create_skill 落盘。与 refine() (失败→经验) 互补。`src/agent/index.js`
- 新增 `refine_skill` 工具, 供 LLM 主动触发自我进化。`src/tools/selfmod.js`

### 验证
- 全量测试: 195 项 192 过 0 失败 3 跳过 (网络 gate)。
- 新增 test/wechat-channel.test.js (5) + test/legion-mode.test.js (4) + 微信加密回包/沙箱/refineSkill 用例。

## v0.4.1 (2026-08-14) — 评估报告修复 (P0/P1)

依据 `docs/EVALUATION-v0.4.md` 修复安全与工程质量问题。

### P0 安全/数据
- **HTTP 认证**: `auth_token` 为空时启动自动生成随机 token 打印到控制台 (类似 Jupyter), 不再裸奔。`src/channels/http.js`
- **请求体上限 + 限流**: 新增 1MB body 上限 + 每 IP 60 req/min 令牌桶。`src/channels/http.js`
- **SSRF 防护**: `http_request` 拦截内网/保留地址 (127/10/172.16/192.168/169.254/0/100.64)。`src/tools/advanced.js`
- **run_command 白名单精确匹配**: `startsWith` → 精确 token 匹配, 防 `node_malicious` 绕过。`src/tools/builtin.js`

### P0 测试隔离
- 修复 4 个测试文件 (agent/absorb.deepseek/advanced.tools/tools) 用真实 ROOT 污染生产 `data/` → 全部改用 `tmpRoot()` 临时目录
- 清理生产污染: facts.json 全测试数据清空, 删除 tmp-skills, 清理 l0 测试会话行
- 新增 `test/session.test.js` 覆盖会话持久化

### P1 会话持久化
- 新增 `src/memory/session.js` (SessionStore): 会话 JSONL 落盘 `data/sessions/<key>.jsonl`, 重启不丢
- `agent/index.js` 接入: 构造加载, `_pushTurn` flush, `resetSession` 同步删文件

### 杂项
- README: 工具清单 11→24, 补认证/SSRF/会话/测试隔离特性, 修乱码
- 修复 agent/index.js 5 处注释乱码

### 验证
- 测试: 58 过 0 失败 2 跳过 (网络型) + channels 3 过
- LLM 链: 本机 Node v26.4.0 满足 OpenClaw (>=25.9.0), `通了` 实测通过


## v0.4.2 (2026-08-14) — 测试修复 + fetch_page + Provider 健康探测

### 修复
- **channels 测试**: 固定端口(EADDRINUSE) + 缺少鉴权 token(401) → 改动态端口(0) + 读取自动生成的 authToken。`test/channels.test.js`
- **测试全绿**: 67 测试 65 过 0 失败 2 跳过(网络型)

### 新增
- **fetch_page 工具**: 抓网页正文转纯文本(去 script/nav/footer, 截断), 复用 httpRequest 的 SSRF 防护, 配合 web_search 让 agent 能读网页内容作答。`src/tools/advanced.js`
- **LLMClient.health()**: 并发健康探测 — openclaw 后端校验 Node 版本(>=22.22.3/>=24.15/>=25.9), http 后端 3s 探测 /models。`src/llm/client.js`
- **_llmWithFallback 并发探测**: 多 provider 时先并发 health() 跳过不可用项, 避免串行等待 180s 超时(最坏 15 分钟 → 秒级)。`src/agent/index.js`

### 验证
- 新增 test/fetch-page.test.js + test/health.test.js


## v0.4.3 (2026-08-14) — 记忆倒排索引 + Web UI 体验优化

### 记忆检索升级 (文档4方向4, P2-1)
- **fact-store 倒排索引**: 字符级索引(中文单字+英文token) -> Set<factId>, 检索 O(n) 全遍历 -> O(候选)。`src/memory/fact-store.js`
- 新增 `rebuildIndex()` 支持外部变更后重建
- 阈值保护: 候选过散(命中常见字)自动回退全量, 防索引退化; 无命中同样回退全量保证召回
- 新增 test/inverted-index.test.js (5 用例)

### Web UI 体验优化 (P2-5)
- **主题跟随系统**: 固定暗色 -> `prefers-color-scheme` 深浅两套 CSS 变量, 自动适配 light/dark IDE
- **marked 本地化**: 下载 marked.min.js 到 public/vendor/, 离线可用, 不再依赖 CDN
- **场景新建改表单**: prompt() 弹窗 -> modal 表单(名称/介绍/能力), 支持 Esc/点遮罩关闭
- **移动端响应式**: 窄屏(<=768px)侧栏变抽屉, 右上角"面板"按钮切换
- **http.js 通用静态服务**: 支持 public/ 子目录(vendor/), 含路径穿越防护
- 修复 esc() 重复定义

## v0.5.1 (2026-08-15) — 评估报告修复 (EVALUATION-v0.5 P0/P1)

依据 `docs/EVALUATION-v0.5.md` 修复。

### P0 — 环境一致性
- **Node 版本声明统一**: `package.json` engines 从 `>=20.0.0` 改为实际要求 `>=22.22.3 <23 || >=24.15 <25 || >=25.9` (OpenClaw 引擎真实下限, 且明示 23 与 24.0-24.14 不支持)。`package.json`
- **health.test.js 参数化**: 抽纯函数 `nodeVersionOk(version)` 导出 (client.js), health() 复用之; 测试不再硬编码当前环境版本断言, 改为版本矩阵参数化, 消除环境可移植性缺陷。`src/llm/client.js` `test/health.test.js`

### P1 — 体验与质量
- **LLM 失败引导**: openclaw 后端新增 `_openclawReadyOrThrow()` (启动前校验 Node 版本, 不满足抛中文引导) + `_translateOpenclawError()` (将 CLI 版本类报错译为"请升级 Node 至 >=22.22.3 (推荐 26.x)"), 替代原始报错。`src/llm/client.js`
- **记忆内容去重**: `FactStore.add()` 前按归一化内容 (去空白折叠) 比对, 相同内容已存在则命中加分而非重复新增; 覆盖 addMemory/recordTurn/schedule 笔记。`src/memory/fact-store.js`
- **corrupt 备份自动清理**: Healer 新增 `cleanupCorruptBackups(keep=2)`, heal() 启动时保留最近 2 个 `.corrupt-*` 备份, 更早自动删除。`src/selfheal/healer.js`

### 语言一致性
- 修复 `src/agent/index.js:22` 注释乱码 (`????? token ??????` → `会话历史 token 预算`)
- README 14 处 `??` 残留清零 (→ ✅), 特性标题乱码修复 (→ ✨)

### 验证
- 全量测试: 73 个, 71 通过 / 0 失败 / 2 跳过 (网络型)。上轮唯一 health 失败已修复
- 实测: 记忆去重 (相同2条→1条, 不同仍新增)、corrupt 清理 (3→2)

> 未含 openclaw 后端真实流式 (P1-3): openclaw CLI 非流式, 需引擎侧 SSE 支持, 暂保留一次性返回。

## v0.5.2 (2026-08-15) — DeepSeek Harness 底座整合

对比 deepseek-ai/deepseek-harness (110k★, Cordis 插件化 Agent 框架) 后，把 dsh 一次性运行器作为皮皮虾的 LLM 底座后端接入（与既有 OpenClaw 后端并列，可按 provider 切换）。

### 新增 DeepSeek Harness 后端
- **`src/llm/client.js`**: 新增 `deepseek` 后端 (provider `backend: "deepseek"` 或 `id: "dsh"`)。
  - `_dshChatAsync()`: 驱动 `node --import tsx/esm apps/cli/src/bin.ts --profile headless "<task>"`，stdout 提取最终助手文本，exit 0=turn 完成 / 1=出错(stderr 带错误)
  - `_dshReadyOrThrow()`: dsh 源码缺失时抛中文引导
  - `health()`: 校验 dsh 源码存在 + Node 版本
  - `chat/apiChat/streamChat` 均接入 deepseek 分支
- **`src/agent/index.js`**: `_resolveAllLLMs`/`_resolveLLM` 纳入 dsh 后端 (backend=deepseek / id=dsh)
- **`config/ppx.json`**: 新增 `dsh` provider (dsh_root 指向桌面源码)

### dsh 源码落地
- `./deepseek-harness` (master, 7441 文件)
- 已 `pnpm install` + `pnpm run build:lib:host`（headless 不需 web 前端）
- 跑通: `dsh --profile headless` 全链路 14s 返回 (DEEPSEEK_API_KEY)

### 验证
- dsh headless 直连: 返回正常, exit 0
- 皮皮虾 dsh 后端: health=true, chat 13.8s 返回
- 皮皮虾全量测试: 73 个 71 过 0 失败 2 跳过

### 待办
- dsh 首次启动需先 `pnpm install` + `pnpm run build:lib:host`（构建产物在 lib/，typert loader 依赖）
- 底座切换: 想让皮皮虾用 dsh 当大脑，把 openclaw provider 移到 dsh 之后或临时注释掉

## v0.5.3 (2026-08-15) — openclaw + DeepSeek Harness 合并为统一底座

把 openclaw 后端与 deepseek(dsh) 后端合并成一个 `combined` 底座: 一个大脑按优先级驱动多个 CLI 引擎, 健康探测 + 自动回退。openclaw / deepseek 单引擎后端保留可用。

### 新增 combined 底座
- **`src/llm/client.js`**: `backend: "combined"` 时构建 `subClients` (provider.engines 数组), 新增 `_combinedCall(fn)`:
  - 先并发 health() 过滤不可用引擎, 全挂则按原顺序兜底
  - 依次调用, 失败自动回退下一个, 抛最后错误
  - chat / apiChat / streamChat / health 全部接入 combined 分支
- **`config/ppx.json`**: 新增 `brain` provider (backend=combined, engines=[openclaw, dsh]), 排第一为默认底座
- **`test/combined.test.js`**: 新增 5 个合并底座单元测试 (subClients 构建/health/无engines引导/失败回退/顺序短路)

### 验证
- 合并底座: health=true, chat 14.9s 走 openclaw 正常返回
- 故障回退实测: openclaw 引擎故意损坏 -> 自动切 dsh -> 13.1s 正常返回
- 皮皮虾全量测试: 78 个 76 过 0 失败 2 跳过

### 说明
- combined 让 openclaw 和 dsh 互为冗余, 一个引擎挂了自动切换, 皮皮虾对话不中断
- 想单独用某个引擎时, 仍可用 backend=openclaw / backend=deepseek 的单引擎 provider

## v0.6.5 (2026-08-16) — 记忆主动提炼 (EVALUATION-v0.6-final P1#9)

### P1#9 记忆主动提炼 (LLM 结构化)
- memory-ticker: recordTurn 新增 extractor 通道。命中信号预筛(_hasSignal)时调 LLM 结构化提炼关键事实/偏好/待办, 替代简单启发式 addMemory
  - _hasSignal: 关键词信号(我喜欢/记住/偏好/股票/仓位/工作等)或整轮>40字非寒暄才触发, 省成本
  - 无 extractor 或提炼为空时退回原启发式 addMemory
- agent: 新增 _extractMemory(user, assistant) 用 LLM 提炼, 解析 JSON 数组; 启动时 setExtractor 注入

### 验证
- 全量测试: 107 个 104 过 0 失败 3 跳过 (网络 gate)
- 新增 memory-extract.test.js (3) 覆盖高/低信号触发与退回

## v0.6.4 (2026-08-16) — Web UI 工具调用可视化 (EVALUATION-v0.6-final P1#7)

### P1#7 工具调用过程可视化
- agent: 新增 setToolEvent() 回调 + _runTool 触发 start/done 事件 (工具名/参数/耗时/状态/结果), 供 Web UI 推送
- agent.chatStream 改造: 从纯流式改为优先走 _llmWithTools 工具循环 (能触发 onTool 事件), 最终结果一次推送; 失败降级 streamChat 流式, 再降级非流式 chat
- http.js /message/stream: 新增 onTool 回调, 推送 SSE type:"tool" 事件
- Web UI: send() 处理 tool 事件, 显示工具调用卡片 (⏳调用中→✓完成/✗失败, 含参数+耗时+结果摘要)

### 验证
- 全量测试: 104 个 101 过 0 失败 3 跳过 (网络 gate)
- 新增 tool-vis.test.js (2) 覆盖 chatStream 工具循环 + onTool 事件

## v0.6.3 (2026-08-16) — Web UI 多会话管理 (EVALUATION-v0.6-final P1#6)

### P1#6 多会话管理
- SessionStore.list(): 列出所有会话 (key/count/lastTs/标题), 按 lastTs 倒序
- SessionStore.rename(): 复制事件到新 key 删旧 key, 保留 seq 顺序
- http.js: 新增 GET /sessions (列表)、POST /sessions/rename、POST /sessions/delete
- Web UI: 侧栏新增"会话"tab, 支持新建/切换/删除/重命名会话, 显示条数+时间+标题

### 验证
- 全量测试: 102 个 99 过 0 失败 3 跳过 (网络 gate)
- 新增 session-manage.test.js (3) 覆盖 list/rename/delete

## v0.6.2 (2026-08-16) — 评估报告 P1 修复 (EVALUATION-v0.6-final)

### P1 修复
- **notify 工具描述中文化** (P1#8): advanced.js 的 notify 描述由英文改为中文, 统一工具描述语言
- **会话日志增量落盘** (P1#5): session.js _flush 由全量重写改为 appendFileSync 增量追加, 用 _flushedSeq 追踪已落盘进度; 首次/重建时全量覆盖, 消除大会话(1000+条)写放大
- **AML 限流对齐** (P1#10): aml-server.js 新增 60 req/min 令牌桶限流(对齐 http.js), 超限回 429; 顺带修复 readBody 超限时 req.destroy() 导致客户端 ECONNRESET 而非 413 的真实 bug
  - aml-server 导出 createAmlServer() 供测试进程内起停, CLI 入口保留

### 验证
- 全量测试: 99 个 96 过 0 失败 3 跳过 (网络 gate)
- 新增 session-append.test.js (3, 增量落盘跨实例) + aml-server.test.js (3, Add/Search/413/限流)

## v0.6.1 (2026-08-16) — 评估报告 P0 修复 (EVALUATION-v0.6-final)

### P0 修复
- **openclaw/dsh 后端工具调用代理**: 新增 src/llm/fence.js 围栏协议。openclaw/dsh 是外部进程无法直调 PPX 内部工具, 现通过围栏语法 (\u27ea tool:name \u2502 {json} \u27eb) 让引擎以纯 LLM 输出工具意图, client 解析执行 PPX 工具并喂回结果, 收敛后返回最终回复。agent 层零改动, 与 http 原生 tool_calls 并存。
  - parseToolFence / buildFencePrompt / proxyToolLoop 纯函数, 独立可测
  - LLMClient.apiChat 新增 toolRunner 参数; openclaw/dsh 后端有 toolRunner 时走代理循环, 否则退化纯 LLM
  - agent/index.js 新增 _runTool 统一工具执行入口 (trace 记录)
- **hardcoded 路径外部化**: DEFAULT_DSH_ROOT / DEFAULT_MJS 改为环境变量 PPX_DSH_ROOT / PPX_OPENCLAW_MJS, 缺失回退内置默认
- **dead code 确认**: _queryJaccard / _jaccard 已在前序版本清理, 报告基于旧快照, 无需处理

### 验证
- 全量测试: 93 个 90 过 0 失败 3 跳过 (网络 gate)
- 新增 fence.test.js (9) + tool-proxy.test.js (2) 覆盖围栏解析与代理循环

## v0.6.0 (2026-08-15) — 新架构: 吸收 DeepSeek Harness 设计原则 + openclaw 为唯一底座引擎

应兄弟要求: 不要套两个引擎的路由器, 而是吸收两者优势合并成一个新架构。定案:
**一个底座 (新架构内核) + 一个可插拔引擎接缝 (openclaw 默认)**。

### 吸收 dsh 的三大设计原则
1. 会话即唯一事实源 (model-visible means logged): src/memory/session.js 从覆盖式 JSONL 重写为不可变 append-only 事件日志 (每条 seq/ts/type/data)。
   - 模型可见历史 = deriveMessages() 从日志投影 (无可变状态, 仅从日志重建)
   - replay() 回放完整事件流 | fork() 从边界派生新会话 | 事件域 user/assistant/system/tool
   - 老格式文件优雅跳过 (不崩), 新写自动用事件格式
2. 引擎 = 可插拔接缝 (Service|Provider|Consumer): LLM 后端 (openclaw/deepseek/http) 是单一底座后面的可换服务, 由 config provider 决定, 不再有组合路由器
3. 分层配置可覆盖: config provider 顺序即优先级, 引擎可换

### 架构收敛
- 移除 combined wrapper (两个引擎的路由器, 违反单个底座), 删除 test/combined.test.js
- 唯一默认底座引擎 = openclaw (config 第一), deepseek(dsh) 保留为可换的后端接缝
- src/agent/index.js: _pushTurn 改为 append 事件, _loadHistory/_getSession 改为 deriveMessages + 投影层裁剪

### 验证
- 会话事件日志: append 不可变 / derive 投影 / replay / fork / 跨实例恢复 全测过
- 全量测试: 76 个 74 过 0 失败 2 跳过
- 旧 default.jsonl 新格式正常加载, 旧 eval-test 格式优雅跳过


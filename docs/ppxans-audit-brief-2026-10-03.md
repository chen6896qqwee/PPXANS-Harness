# PPXANS-Harness 深度体检报告 (2026-10-03)

> 只读调查 → 老板批准 P0+P1 → 批量修复 → 全量复测。修复状态见文末。

## ✅ 修复执行记录 (2026-10-03, 批准范围: P0+P1)

**修复前全量备份**: `Desktop\PPXANS-Harness_backup_2026-10-03` (384 文件 + _MANIFEST.txt, robocopy /E)

| # | 状态 | 修复方式 |
|---|------|----------|
| 1 🔴 | ✅ 已修 | readJson 失败时告警 + readJsonGuarded 带 parseFailed 信号；FactStore 构造期损坏时跳过覆盖写，文件原地保留交 healer/人工恢复。定向实测：损坏文件保留 ✅ |
| 2 🔴 | ✅ 已修 | SSE send 前查 `destroyed\|\|writableEnded` + res.on(error) 兜底 + res.on(close) 未正常结束则按会话中断上游 |
| 3 🟠 | ✅ 已修 | interrupt(sessionKey) 按会话 Set + 全局标志兼容 CLI；工具循环经 ALS currentTrace().sessionKey 判定 |
| 4 🟠 | ✅ 已修 | onTool/onStep 按 traceId 注册 (_turnCbs)；usedTools/降级事实按 traceId 路由；替代 prev/restore 单槽 |
| 5 🟠 | ✅ 已修 | 锁文件写 `pid:ts`；超时先判持有者存活（活进程持锁→抛错不抢）；Atomics.wait 零 CPU 等待替代自旋 |
| 6 🟠 | ✅ 已修 | cli.js 安装 installCrashGuard({tag:"ppx-cli"}) |
| 7 🟠 | ✅ 已修 | reloadProviders() 末尾补调 _installUsageTracking() |
| 8 🟠 | ✅ 首片 | 新增 src/session/projection.js (TurnProjection)：chat/chatStream 挂 begin/complete/abort 生命周期，纯可观测投影，bus 发 chat/turn/* 事件 + EQ 推 TASK_TURN_*，`agent.turn_projection=false` 可旁路。排队输入承接留 v3.1 后续 |
| 9 🟠 | ✅ 已修 | _originTrusted 追加同端口判据 (监听后回填真实端口)；CORS 默认收紧（同源 UI 不需要 ACAO）；/mcp 对本机回环任意端口保留 ACAO（浏览器 MCP 客户端场景，Bearer 门禁不泄凭据） |
| 10-18 🔵 | ⏸ 未动 | P2 按批准范围跳过（#18 定时器核查确认无泄漏，无需修） |

**测试适配**: channels.test.js CORS 用例更新锁新语义（外部来源不发 ACAO / 同端口回显）。

**复测结果**: 989 tests (985 pass / 0 fail / 4 skip 联网用例) = 基线持平 · selfheal 7/7 · web:check 全过 · bench 200 并发 0 失败 13.8ms/轮

**过程中发现并规避的坑**: 初版 readJson 自动改名隔离与 healer 的损坏文件恢复契约冲突（healer 期望文件原地存在再自行改名 .corrupt-N），实测炸 selfheal-bench ENOENT → 改为非破坏式（readJson 只告警，FactStore 跳过覆盖写），healer 契约完整保留。

---

## 总评：82/100

| 维度 | 得分 | 证据 |
|------|------|------|
| 测试健康度 | 95 | 989 项：985 pass / 0 fail / 4 skip（skip 均为需网络/key 的联网用例，合理） |
| 自愈能力 | 100 | selfheal-bench 7/7 (100%) |
| Web 静态自检 | 100 | check-web 全部通过 |
| 安全防线 | 85 | 命令守卫三层+反混淆、SSRF 重定向逐跳校验、恒定时间 token 比较、symlink 越界防护均扎实；扣分：CORS 端口校验缺口 (#9)、SSRF DNS rebinding TOCTOU (#14)、权限引擎 fail-open (#16) |
| 并发正确性 | 65 | 🔴 全局中断标志串台 (#3)、chatStream 回调互相覆盖 (#4)、文件锁超时强取破坏互斥 (#5) |
| 数据安全 | 70 | 原子写+Windows rename 重试扎实；但损坏 JSON 静默清库路径 (#1) 是硬伤 |
| 上下文工程 | 90 | 渐进披露已做，固定开销 3367 tok/请求（实测 bench:ctx） |
| 性能 | 75 | 压测 200 并发 0 失败 p50 238ms、长会话 12.8ms/轮；扣分：同步 IO 热路径 (#10)、facts 全量重写 (#11)、stats 无缓存 (#17) |
| 架构完整度 | 80 | v3 八模块已装配；session/ 模块 0 接入，能力就绪链路未通 (#8) |

---

## 🔴 P0（2 项）

### #1 JSON 存储损坏时静默清库（数据丢失）
- 位置：`src/utils/store.js:33-42` + `src/memory/fact-store.js:50,69`
- 问题：`readJson` 解析失败静默返回 fallback；FactStore 构造器拿到空数组后第 69 行立即 `save()` 把空数组原子写回。磁盘满/半写/进程被杀导致损坏 → **整个记忆库被静默清空，无备份无日志**。
- 修复：readJson 失败时 rename 损坏文件为 `.corrupt-<ts>` 再回退；构造时文件存在但解析失败必须告警，绝不立即覆盖写。

### #2 SSE 客户端断连后写入已销毁流 → 未捕获错误
- 位置：`src/channels/http.js:507`（只查 `writableEnded` 不查 `destroyed`）+ `agent/index.js:452-454`（每个 delta 回调 send）
- 问题：客户端中途断开后 `res` 变 destroyed，后续 write 触发 `ERR_STREAM_DESTROYED`，res 无 error 监听器 → 每个 delta 炸一次 uncaughtException，错误风暴；crashguard 未覆盖的入口直跑会崩。
- 修复：send 前查 `res.destroyed || res.writableEnded`；挂 `res.on("error")`；`req.on("close")` 中断上游 chatStream。

---

## 🟠 P1（7 项）

| # | 问题 | 位置 | 要点 |
|---|------|------|------|
| 3 | interrupt() 全局中断所有会话 | agent/index.js:195,275 | `_interrupted` 实例级单标志，会话 A 中断打断并发会话 B。改按 sessionKey 的 Map |
| 4 | 并发 chatStream 回调互相覆盖 | agent/index.js:442-446 | prev/restore 模式在并发下错乱；`_lastTurnUsedTools`/`_lastFallback` 同病。改 AsyncLocalStorage 或按 sessionKey 路由 |
| 5 | withFileLock 超时强取破坏互斥 + 忙等阻塞事件循环 | utils/store.js:64-71 | 3000ms 强删锁文件可致双写；`while` 同步自旋卡死事件循环。锁文件写 pid+mtime，先判存活再强取 |
| 6 | CLI 直跑入口未装 crashguard 且 stdin 回调未捕获 rejection | agent/index.js:1174-1178 | chat 内部 `_persistTurn` 抛错 → unhandledRejection → Node≥15 直接退进程 |
| 7 | reloadProviders 后使用统计静默失效 | agent/index.js:1062-1068 | 热重载新 provider 实例未重包装，usageStats 从此不计数。末尾补调 `_installUsageTracking()` |
| 8 | session/ 模块集成缝隙（v3.1 待办确认属实） | src/session/ 全目录 | grep 证实 src/ 内 0 个 import。Turn 状态机的排队输入功能实际不存在。集成时以 SessionStore 为唯一事实源，Turn 作投影层 |
| 9 | CORS/token 下发的同机绕过面 | channels/http.js:231-242, 419-435 | Origin 只校验 hostname 不校验端口，同机恶意端口页面可领 token；CORS 默认 `*`。收紧为同源（含端口） |

---

## 🔵 P2（9 项）

| # | 问题 | 位置 | 修复方向 |
|---|------|------|----------|
| 10 | 同步 IO 热路径密度高 | http.js:719-733 静态服务无缓存；memory-ticker.js longterm.md O(N²) 累积读写 | ETag/304 + longterm.md 分节化 |
| 11 | 非 WAL 模式每次记忆变更全量重写 facts.json | fact-store.js:74-81 | 文档引导启用 sqlite 后端；forget/update 增量索引 |
| 12 | 审批缓存无界增长 | agent/index.js:155 | LRU 或上限 |
| 13 | 工具循环空 callable 边缘 400 循环烧满 8 轮 | core/policy.js:259-266 | callable 空时 push 占位 tool 消息 |
| 14 | SSRF DNS rebinding TOCTOU | tools/advanced.js:126-138 | 校验后用 IP 直连 + Host 头保持原域名 |
| 15 | SessionStore 多进程无锁追加 | memory/session.js:384-398 | 与 facts 锁策略对齐 |
| 16 | 权限引擎 fail-open 与 fail-closed 语义矛盾 | agent/index.js:667 | 改 fail-closed（权限引擎抛错=拒绝） |
| 17 | agent.stats() 每请求同步聚合（读 10000 行 JSONL） | agent/index.js:952-986 | 1-5s 缓存 |
| 18 | 定时器清理核查 | 全库 | **结论：无泄漏**，无需修 |

---

## ✅ 值得肯定的点（不修）
- 命令守卫三层防线 + 反混淆、safePath realpath 校验、workspace symlink 越界防护
- SSRF 重定向逐跳校验 + IPv6/映射地址处理（超出常见水准）
- 原子写 + Windows rename 重试、恒定时间 token 比较、请求体超限继续消费防挂死
- 无空 catch 吞异常；hooks/Scheduler/proactive/审批 timer 清理完整

---

## 修复顺序建议
#1 → #2 → #5 → #3/#4 → #9 → #6/#7 → P2 按 13/16/10/17/12/14/11/15

## to-dos for human
- [x] 批准修复范围：P0+P1（已执行完毕并复测）
- [x] 修复前全量备份：Desktop\PPXANS-Harness_backup_2026-10-03（384 文件 + MANIFEST）
- [ ] P2 八项（#10-#17）：**#10/#12/#13/#14/#15/#17 已于 2026-10-04 修复（见下节）；#11 默认后端决策、#8 剩余仍挂起**
- [ ] #11 决策：默认记忆后端是否切到 sqlite（写入实测快 18.7 倍）
- [ ] #8 剩余部分（排队输入 queuedUserInputs 承接、rollout 持久化）留 v3.1 后续

---

## P2 批量修复记录 (2026-10-04)

| # | 状态 | 修复方式 |
|---|------|----------|
| 10 🟡 | ✅ 已修 | ① http.js 静态服务: ETag(mtime+size 弱etag)/304 协商 + 进程内内容缓存(上限64, mtime/size 失效), 实测 200→304 通过; ② memory-ticker: longterm.md 三处 read全量+write全量 改 appendText 追加 (utils/store.js 新增), 单次归档 O(N)→O(新增字节) |
| 12 🟡 | ✅ 已修 | _approvalCache FIFO 淘汰上限 500 (超限淘汰最早插入项, 只影响重复 ask 不影响安全) |
| 13 🟡 | ✅ 已修 | core/policy.js: tool_calls 存在但 callable 为空时补占位 tool 消息 (tool_call_id 对齐 + 可判读错误), 堵住 8 轮 400 空转 |
| 14 🟡 | ✅ 已修 | advanced.js: assertPublicUrl(校验后 fetch 重新解析) 重写为 _resolvePublic(解析+校验一次) + _pinnedFetch(node:http/https 直连校验过的 IP, Host 头/SNI 保持原域名, TLS 校验不放松), rebinding TOCTOU 窗口关闭; 逐跳重校验语义保留 |
| 15 🟡 | ✅ 已修 | session.js _flushLegacy 追加段 + _flushDaily 每日分片 各加 withFileLock (与 facts 锁策略对齐, 分片级粒度互不阻塞); 失败由 _flush catch 告警兜底 |
| 17 🟡 | ✅ 已修 | stats() TTL 缓存外壳 (_statsUncached 拆分), 默认 2000ms, `agent.stats_cache_ms=0` 关闭退回旧行为 |
| 16 🟡 | ⊘ 无需 | 核查发现 2026-10-03 P1 轮已顺手修为 fail-closed (agent/index.js 权限引擎 catch 段), 简报滞后 |
| 11 🟡 | ⏸ 部分 | WAL 增量落盘设施已在位 (默认关); 默认后端切换属人工决策仍挂起 |

**另**: zip 快照核对发现 Desktop\PPXANS-Harness.zip 为旧版 (缺 72 个 v3.2.x 文件, 含 pricing/sandbox/vad/projection/skills 全套/CI); 其中独有的 test/oobox.test.js 经核查为旧 API 时代死文件 (localEmbed/buildTTSCommand 导出已不存在, 覆盖已由 v31-embed-local.test.js 接管), 不予恢复。最新全量快照已重打包: Desktop\PPXANS-Harness-v3.2.2-full-20261004.zip (417 文件, 1.1MB, 排除 .git)。

**复测**: 1029 tests (1025 pass / 0 fail / 4 skip 联网) = 基线持平 · web:check 全过 · ETag/304 内存级实测通过

---

## v3.1 内嵌能力增强 (2026-10-03 下午, 批准"全部开始"后落地)

| 能力 | 实现 | 降级路径 |
|------|------|----------|
| 本地向量 (P0) | src/llm/local-embedder.js: transformers.js 可选依赖, config.embedding={backend:"local"} → FactStore.setEmbedder; 默认 Xenova/multilingual-e5-small (中文稳) | 包未装/embed 失败 → null → 云端 API → BM25, 主包仍零依赖 |
| 事实有效期 (P1) | fact-store: add({validFrom,validTo,supersedeId}) + setValidity() + listOutOfWindow(); query/querySemantic 默认过滤窗外事实, includeExpired=true 检视; importAll 透传 | 旧数据无字段=永久有效, 完全兼容 |
| 本地 ASR (P1) | voice.js: voice.asr={backend:"local",model} → nodejs-whisper (可选依赖) 动态 import; voiceStatus 反映 backend | 未装时报错并给出安装指引; 云端路径不变 |
| JS 沙箱 (P2) | src/tools/sandbox.js + sandbox-worker.js: worker_threads 强杀 + node:vm 裁剪全局, code_run 工具, 10s 上限 | — |
| VAD (P2) | src/tools/vad.js: energy 后端 (WAV 16bit 解析 + 帧 RMS + 滞回 + 自适应底噪, 零依赖); silero 后端可选 (onnxruntime-node) | silero 缺包返回明确指引 |

**复测**: 1001 tests (997 pass / 0 fail / 4 skip 联网用例, +12 新能力测试) · selfheal 7/7 · web:check 全过 · bench 200 并发 0 失败 15.6ms/轮
**新文件**: src/llm/local-embedder.js · src/tools/sandbox.js · src/tools/sandbox-worker.js · src/tools/vad.js · test/v31-embed-local.test.js

---

## 全量强化记录 (2026-10-04 → 10-05, 批准范围: 全量 P0-P3 / 免备份 / 允许真 LLM 基准)

改动规模: 51 个已跟踪文件 +2112/-493，另新增 9 个文件（1 个迁移模块 + 1 个 vendored 工具 + 7 个测试）。分四波。

### T1 安全闸门 (8)

| 缺口 | 位置 | 修复 |
|---|---|---|
| 沙箱 realm 跳跃读尽宿主环境变量 | tools/sandbox-worker.js（整文件重写） | `vm.createContext(Object.create(null))` + V8 原生内在对象，不再注入任何宿主 realm 对象；原实现注入了宿主 `Promise/Math/JSON`，`Promise.resolve().constructor.constructor("return process")()` 一步就拿全密钥 |
| code_run 资源与信任级失配 | tools/sandbox.js:22-36,84 | Worker `env:{}` + `execArgv:[]` + `resourceLimits.maxOldGenerationSizeMb`(默认 128)；riskLevel low→medium |
| 命令守卫缺内联执行层 | tools/command-guard.js:53-120,158-176 | 新增 HARD_BLOCK（`>`/`>>` 重定向进 `~/.ssh`、启动件、shell rc、/etc）+ 第 3.5 层 `INLINE_EXEC_RULES`（`node -e`/`python -c`/`git -c`/`find -exec`/`tar --checkpoint-action`/`npx pkg`，按段解析并跳过 `env/sudo/nohup` 与 `FOO=bar` 前缀）；`allow_all` 也拦，仅 `security.allow_inline_exec` 可放 |
| MCP 目录工具绕过整条准入链 | mcp/server.js:308-320 | 原 `tools.call(name,args,{})` 传空 ctx → deny/ask/审批/安全/工作区校验全部静默跳过；改走 `agent._runTool()` |
| 记忆入库不带密钥 | memory/fact-store.js:315,795,278 | `scrubPII(keep:["email","phone"])` 单点化到 add/update/_normalizeFact 三个写入点（sqlite 后端同步补齐，见 T4） |
| JSON 工具结果完全不扫注入 | security/injection.js:35-66 | 新 `scanToolResult()`：解析 JSON 后逐叶重扫（深度≤6、≤400KB）；agent/index.js:893 去掉旧的 `!result.startsWith("{")` 跳过 |
| Webhook 无 token 即可驱动带工具的 agent | channels/base.js:52-63 + feishu.js:64-88 + wechat.js:53-84 | `_webhookSecretGate()` fail-closed 403（原为 `if (token) 校验`）；先鉴权后读体；逃生阀 `security.allow_unauthenticated_webhooks` |
| AML 服务默认全网卡 + auth=none | aml-server.js:18,197-206 | 默认绑 127.0.0.1（`PPX_AML_HOST`），非回环+无鉴权拒绝启动；`AUTH_VALUE` 为空时 `authOk` fail-closed |
| 发 token 的本地判定可被 DNS rebinding 绕 | channels/http.js:266-290,427-445 | `_hostTrusted()` 重解析校验；限流前置到 MCP/webhook/SSE 分支之前（原先这些路径完全不限流），`_ppxRateLimited` 修 `/mcp` 双重扣额度 |

### T2 能力提升 (5)

- `search_files` 新工具（builtin.js:218+，glob/正则/list_only，上限 4000 文件/深度 14/2MB）；`read_file` 加 `offset/limit` 行窗口 + 续读提示（`sliceLines` 导出便于单测）；`write_file` 内容收缩告警。
- 核心披露清单补入 `search_files`/`apply_patch`/`repo_map`（config/index.js:74-79，此前实现了却没进 schema，模型看不见）。
- `_context()` 按前缀缓存重排：静态块前置、记忆/场景后置（prompts.js），稳定可缓存前缀 ~2.6k→更大；固定请求开销实测 3976→4095 tok/请求。
- 审批面接线：`_approvalSurfaces` + `registerApprovalSurface/hasApprovalSurface`，headless 无入口时立即拒绝并给可执行下一步（不再死等 120s）；`agent.approval_headless_wait` 可退回等待。
- 流式真中断路径（`_streamAborts` AbortController）、fallback `chat(persist:false)` 去重、流式轮次补 `_persistTurn(afterTurn:true)`（此前流式回复不喂 L2/L3 学习）、`tools.enabled` 热加载。

### T3 并发与生命周期 (9)

- 军团子进程按需回收：`legion.killAgent(name,{graceMs})` + `delegate.js` 每个 spawn_agent 在 `finally` 并行回收（此前长跑进程只增不减）。
- `shutdown()` 改 async 并 await，且仅在确有 worker 时走 `legion.shutdownAll`；cli.js:54/115、server.js:56、agent-worker.js:61、ctx-profile.js、ppx-web.js:136 全部改为 await。
- 会话 seq 跨进程竞态（本轮新发现）：`_ensureUniqueSeq()` 在文件锁内以磁盘末行真值重排整批 seq，`append()` 里的磁盘预检降级为乐观提示；原先两进程并发各 +1 → 重复 seq，而 seq 唯一性是 ticker 游标/compaction/fork 截断的前提。
- 会话文件被覆盖丢失（本轮新发现的真数据丢失 bug）：`_flushLegacy` 是否整写改由磁盘事实（`_diskMaxSeq>0`）决定，`set/rename/fork` 用显式 unlink 表达"重建"意图。
- SceneStore 陈旧内存覆盖磁盘 + 坏文件：`readJsonGuarded`、损坏文件先改名 `.corrupt-<ts>` 归档、锁内 `_reload`+`mergeScenes` 读-改-写，id 走 `shortId`（原 `Math.random` 6 位）。
- memory-ticker 双写整天：日/滚动/汇总三条写路径共享同一 seq 游标，`_appendLongterm`/`_saveState` 进锁，归档内容统一过 `_scrub()`。
- 审计链分叉（会被 audit_verify 误报篡改）：`append()` 链头→seq→落盘整体进 `withFileLock` 且锁内重读磁盘；`_tailEntry()` 16KB 尾读使 `lastHash()` 慢路径 O(N²)→O(1)。
- trace 事件把 JSON 从中间剪断→落盘不可解析：`shrinkPayload()` 改为钳制字段值而非序列化后的整行，超限退化为骨架行。
- 钩子故障语义：`on()` 支持 `failClosed`，新 `onSecurity()`；PreToolUse 钩子异常/超时=拒绝而不是静默放行。协议总线 EventQueue 加 2000 条环形上限（原内存无界，长活服务 OOM 风险）。
- 记忆治理真正接线：`memory.ttl_days:90` → `sweepMemoryTtl()` 挂进每日 02:00 作业与 `runMemoryEviction()`（`sweepExpired` 此前只有测试在用）；`_prune` 只计存活条目（原把软删条目一起打分）；去重按 scope；`_embedCache` 写真 LRU 且 update 失效。

### T4 工程卫生 (6)

- CI 此前是结构性坏的：`web` job 安装并不存在的 `web/` 包。重写为 ubuntu+windows × node 22/24（+node 20 include）、`fail-fast:false`，步骤换成真实存在的检查：`npm test` + `skill-lint` + `ctx-profile --check`（新 4500 tok 预算闸门）+ selfheal + audit-verify + `web:check`，另加 1 任务 taskbench 冒烟。
- `taskbench.js` 原恒 `process.exit(0)` → CI 基准步骤毫无把关力。改为有未通过即退 1，`--allow-fail`/`--min-pass N` 显式豁免，非法 `--min-pass` 在烧配额前退 2。
- sqlite 后端从"不可用"补到与 JSON 后端平价：`valid_from/valid_to` 列 + 老库 `ALTER TABLE`、`_row2fact` 字段名对齐（`deleteReason`/`deletedAt`/`ttlDays`）、`setValidity`/`listOutOfWindow`、`sweepExpired` 重写为按条 ttl + 软归档 + `{swept}`、`exportAll` 统一 `{items}`、`meta` 解析失败不再整库崩、嵌入缓存按 role 键 + 真 LRU、`add/update/importAll` 三处补 `scrubPII`（原后端一换就重新漏密钥）。新增 `backend-migrate.js`：目标后端为空且源数据存在时一次性导入（幂等、绝不覆盖非空目标、失败只降级告警），默认后端仍是 `json`。
- e5 非对称检索 bug：`local-embedder.js` 原把 passage 也用 query 前缀编码；改 `(text, role)`，并删掉零调用的 `createLocalBatchEmbedder`。
- skill 记忆副本漂移：`skills/ppx-memory/scripts`（2428 行 vendored，且默认写同一个 `data/`）同步到 src 当前行为（锁、尾读、PII、TTL、scope 去重），修 `cli.js` 读旧形状 `all.facts`/`deletedReason` 导致 `export/deleted` 恒空；新增 `test/skill-memory-drift.test.js`（标记存在 + src 符号超集）做漂移守卫，实测能抓住同步前的 6/6 处缺失。
- 配置不再谎报：`memory.enabled`/`token_budget`/`compile_threshold`（代码从不读取）从默认值、example、CONFIG.md 移除；`config/ppx.json.example` 里 `memory_ttl_days` 拼错为无效键 → 改 `ttl_days`；PROJECT-OVERVIEW 的配置表与 TTL 行同步为真实键。清理死代码 `_onApprovalEvent`。
- 明确保留不删：`canvas`/`asset-hub`/`fork` 与 `src/session/{rollout,parts,turn}.js` —— 有通过测试、已被 builtin 注入，属"预留待接线"而非死码，删了只是丢能力。

### 本轮由新测试暴露并修掉的真 bug（不修就是数据损坏/误报）

1. 第二个进程构造 SessionStore 会整文件覆盖第一个进程的会话历史（只剩 2/3 行）。
2. 两进程并发 append 产生重复 seq（40 行不丢，但 14-16 条撞号）→ 锁内重排序号后为 0 撞号。
3. SceneStore 用构造期载入的内存态覆盖磁盘，损坏 `scenes.json` 一次写入即静默清零。
4. 审计链多进程写出现 prevHash 分叉，`audit_verify` 把自家日志误报成"遭篡改"。
5. 基准代码类 4 任务**永远无法通过**：`nodeRun` 用裸 Windows 路径做 `import()`（`ERR_UNSUPPORTED_ESM_URL_SCHEME` → 恒 null），沙箱又缺 `{"type":"module"}`。新增 `test/bench-tasks-verify.test.js` 用"已知正确/已知错误"两套夹具双向钉住判分器确有判别力。
6. `apply_patch` 被披露进核心 schema，却仍在 `REQUIRES_APPROVAL_TOOLS` 里 → headless 秒拒，等于递给模型一把用不了的枪（json-edit/fix-logic/rename-symbol 栽在这）。改为工作区内受限补丁与 `write_file` 同权放行，越界仍 ask；`run_command`/`delete_file`/`rm` 审批不变。
7. 系统提示从未说明工作目录绝对路径（工具描述只说"相对工作目录"）→ fix-syntax 直接 `clarify` 向真人索要 `broken.js` 位置；补【工作目录】静态段 + "点名文件先读再改、写完确认"。
8. `safePath` 在 Windows 上拒绝**一切** `^[a-zA-Z]:` 形式的绝对路径，且包含性判定区分大小写 → 工具带绝对路径的调用（读/写/列目录）几乎全被判"路径越界拒绝"。改为盘符拒绝只在 Win 宿主生效、包含性走大小写/分隔符归一（POSIX 侧不折叠反斜杠，`/work\evil` 仍是越界）。
9. `list_dir` 参数校验层与执行层读的是不同形状：`{}`/缺省能通过校验却在 `execute` 里 `args.path` 抛 TypeError → 整个工具在"无参调用"这一最常见形态下不可用。已在 catalog 层归一化。
10. `apply_patch` 解析器把 `<<<<<<< SEARCH` 后第一行无条件当文件名，而工具描述与 schema 都没提这个约定（schema 只有 `content`）→ 每块 `search` 恒空，补丁工具按文档写法**永远改不动文件**；同时权限层从这些坏 path 里推落点，正常补丁被"无法证明在工作区内"拖去 ask。现路径可选、支持 aider 前置约定与 `args.path`，描述给出准确格式，权限落点同源并保留 fail-closed。
11. 判分器对模块系统有偏见：夹具加上 `{"type":"module"}` 后，`nodeRun` 只认 ESM 命名导出，`module.exports` 写法 `import()` 不抛错但命名空间为空 → 正确答案判 null。现按 `[import, require, new Function CJS] × [m, m.default]` 逐个试探取首个定义值；函数缺失/实现错仍判失败。
12. 判分器的第二处同类偏见（定向重跑暴露）：三条 loader 里 `asCjs` **确实**取回了 `module.exports = sum` 那个函数对象，但 `probe` 只会对"对象形状"求 `m.sum`，裸函数导出的名字挂在 `Function.prototype.name` 上 → 正确答案与"文件不存在"同样得 null。现补 `aliasNamed()`：候选值是函数时按它自己的名字挂别名，**名字对不上或匿名（`name === ""`）不挂**，于是 `module.exports = add` 与 `module.exports = (a,b)=>a+b` 照旧判负。真跑里模型那 3 行字节直接做夹具，`实际 null` 变成 `实际 42`。

### 定向重跑驱动的最后一轮修复 (2026-10-05 补)

- 提示词补一条落盘纪律（`prompts.js` `_workspacePrompt()` 静态段，+56 tok）："要求改/写/修/重命名文件时必须 write_file 或 apply_patch 落盘后再作答，只在回复贴代码不算完成；clarify 不是第一步"。真跑验证有效：`fix-logic` 此前 `clarify→read_file→在回复里贴一段 java 代码` 结束（磁盘没动），现 `clarify→read_file→write_file` 落盘判分通过。
- `write_file`/`apply_patch` 写后确定性自查，**零额外 LLM 调用、只报告不门控**：JS 文件内容既无 `export` 也无 `module.exports`/`exports.` 时回一行"此文件无法被 import/require 为模块"；另每次 JS 写入跑一次 `node --check`（5s 超时、失败文案截一行、注明 ESM 在无 `type:module` 目录可能误报），写入字节与成功/失败语义完全不变（语法错也不回滚）。修的是"工具成功了但模型声称的内容与磁盘字节不符"这一类谎报。
- **未修，只记录**：`rename-symbol` 那轮 `llm_stall` 根因是超时预算倒挂 —— `LLMClient` 兜底 `timeout_ms || 120000`（`src/llm/client.js:24`，注意这是硬编码兜底，`DEFAULT_CONFIG` 里根本没有 provider 超时键）× `retry_max ?? 3` 最坏 4×120s，而基准单任务预算 `TASK_BUDGET_MS = 90000`（`scripts/taskbench.js:20`）——**第一次尝试就超预算，重试永远够不着**。`src/services/triage.js:28` 早就开出过这张处方（"单次 LLM 超时必须小于任务级时限"）。没动它：改全局 LLM 超时会影响真实深推理请求，爆炸半径比这一道题大。

### 复测 (2026-10-05，两轮修复后)

**离线闸门（全部本人独立复跑，非子 agent 转述）**：
`npm test` → 1183 tests / 1179 pass / **0 fail** / 4 skip（本轮 1171→1179→1183）· `ctx-profile --check` → **4305 tok ≤ 4500 ✓** · `selfheal` 7/7 · `eval` 9 过/0 挂 · `skill-lint` 11 全过/0 告警/0 不合格 · `web:check` 全部通过 · `audit:verify` 链完整无断裂
`bench`（stub LLM，压内核开销）→ 并发 200 × 200 轮：失败 **0**，p50 2039ms / p95 2058ms / p99 2060ms；同一 session 长会话 200 轮全成，**14.1ms/轮**（上轮 15.6），会话事件 800 条

**真 LLM 基准（本轮授权额度内，共 4 次调用：整轮 2 + 定向 2）**：
- 整轮 `--full`（修复前）12/20 = 60% → **13/20 = 65%**（204715 tok，`REAL_EXIT=1` 退出码闸门实测生效）
- 定向 6 题（补丁解析/`safePath`/工作目录三段修复后）：3/6 通过 —— `fix-syntax` ✓、`json-edit` ✓ 相对整轮新转绿，`extract-field` ✓ 复现稳定；`代码` 类从 **0/4** 变 1/4（`fix-syntax` 首次破题，90512 tok）
- 定向 2 题（落盘纪律后）：`fix-logic` ✓（39896 tok）；`write-function` 当时仍红 —— 已查明是上面第 12 条判分器偏见，修后离线用真跑字节复现即证 `42`
- **按各轮任务并集推算当前 16/20 真跑绿**（整轮 13 + 定向新转的 `fix-syntax`/`json-edit`/`fix-logic`），再加判分器修复后离线可证的 `write-function` → **约 17/20**。这不是单轮整跑数，配额已封顶未再烧第三次 `--full`。余下 3 道：`rename-symbol`（超时预算倒挂 + provider 抖动）、`delete-file`（**设计如此**：headless 无审批入口即拒，不给可执行替代路径就不该删）、`analyze-and-report`（【工作目录】段正是为它加的，但没再单跑确认）。
- 对照旧基线 `bench/baseline.json`（17/20）：基线里代码类 4 题**本来是绿的** → 这一轮的代码类退化确定是新加的 schema 披露/审批门/`safePath` 造成的工程回归，不是模型能力下降；这条结论决定了后面所有修复的投向（全在 harness 侧，一行模型配置都没改）。

**本会话 API 开销记账**：约 535k tok（两次整轮 + 三次定向），已全部用于"失败任务是否真的转绿"的复现验证；离线可证的（判分器形状、补丁解析、路径守卫）一律没花配额。

### 明确没做、需要人拍板的 (2026-10-05)

1. **默认记忆后端仍为 `json`**：sqlite 后端已从"不可用"补到与 JSON 平价（列迁移、字段名对齐、`setValidity`/`listOutOfWindow`、PII 三点齐），`backend-migrate.js` 也保证首次切换自动导入旧数据。但**翻转默认值**会让所有现存用户的 `data/` 走另一条读写路径，属用户级决定，没替你做。
2. **`src/session/{rollout,parts,turn}.js` 与 `canvas`/`asset-hub`/`fork` 仍未接进主循环**：有通过测试、已被 builtin 注入，属"预留待接线"而不是死码，所以按约定保留未删。真要删需要产品侧确认这些能力不再要。
3. **两个配置键不在 `DEFAULT_CONFIG`，配置守卫看不见它们**：`agent.approval_headless_wait`（`src/agent/index.js:847` 读）与 `agent.stats_cache_ms`（`:1197` 读）。`test/config-consistency.test.js` 只遍历 `DEFAULT_CONFIG` 的叶子键，所以"代码读了但默认值没声明"这个**反方向漂移**是守卫的结构性盲区 —— 补这两个键是五分钟的事，改守卫（反向扫 `config.agent?.` 消费点）是另一个量级的活，留给决定要不要动守卫的人。
4. **LLM 超时 vs 任务预算倒挂**（详见上节，`client.js:24` 120s 兜底 / `taskbench.js:20` 90s 预算）：改任何一边都会同时影响真实深推理请求与基准判分，属权衡而非 bug 修复。建议做法是 provider 侧按调用类型分档（主轮长、辅助调用短 —— `AUX_TIMEOUT_MS` 已有这个形状），但基准那 90s 该不该为慢 provider 放宽是产品取向。
5. **`runInSandbox` 的 `maxHeapMb` 参数没有任何调用方传**：能力在、接线缺。要么接上要么删，但删等于丢一个已测能力。
6. **`session.js` 还剩三个已知但没动的窗口**：多天回填时 `_flushDaily` 的重排只跑一次（跨天批次可能整批挪到同一天）、`set`/`rename`/`fork` 的 unlink 在文件锁**外**、压缩写回的 `data.upToSeq` 不参与重排。都是"第二个进程恰好在同一瞬间做同一件事"级别的窄窗口，现有锁/尾读已覆盖主路径；再收紧要把这些也移进锁内，代价是锁持有时间变长。

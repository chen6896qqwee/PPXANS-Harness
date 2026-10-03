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
- [ ] P2 八项（#10-#17）未动，待下次批准
- [ ] #11 决策：默认记忆后端是否切到 sqlite（写入实测快 18.7 倍）
- [ ] #8 剩余部分（排队输入 queuedUserInputs 承接、rollout 持久化）留 v3.1 后续

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

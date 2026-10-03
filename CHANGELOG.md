## v3.2.2 (2026-10-03n) - 性能: provider 健康探测 TTL 缓存

> 全量测试 **1029 项：1025 通过 + 4 skip，0 失败**（新增守卫 4 项 `test/health-cache.test.js`）。

### 性能
- **健康探测 TTL 缓存**：`_llmWithFallback` 原先**每轮对话**都对全部 provider 串行 `Promise.all` 探活 —— 高频对话下每次都多一段探活往返延迟。改为 TTL 内复用上次探测结果（默认 30s，`config.agent.health_cache_ms` 可调，0 = 关闭），provider 集合变化（键不匹配）自动失效重探；不健康跳过/全挂兜底语义不变。
- 守卫 4 项：TTL 内只探一次 / 过期重探 / 不健康跳过语义不受缓存影响 / 关闭开关退回逐轮探活。

## v3.2.1 (2026-10-03m) - 成熟度冲刺: 除生态外全维度 90+

> 全量测试 **1025 项：1021 通过 + 4 skip，0 失败**（红队 +2、预算守卫 +1、eval 反向 +2）。

### 安全 (+2 红队向量)
- **红队G — 网络工具结果通道间接注入**：http_request/web_search 结果走 `_processToolOutcome` 同管线，投毒页面（正常公告夹带指令）必带"不可信"标注且原文/正常内容均保留（零网络，管线级验证）。
- **红队H — 事件流落盘凭证脱敏**：tracer 事件里的 sk- key / 邮箱 / auth_token 值落盘前必须脱敏（崩溃现场与日志不留明文凭证），嵌套 payload 同样覆盖。

### 可靠性 (+1)
- **usage-stats 周期落盘**：原先只在 shutdown 写 `usage-stats.json`，长跑进程被 kill = 全量丢账。改为每满 10 次调用自动落盘一次 + 退出兜底 flush（`_flushUsageStats` 抽出复用），崩溃最多丢 9 笔。

### 工程/发布
- **prepublishOnly 三重卡点**：`selfheal && test && eval` —— 发版前必须过自愈体检 + 全量测试 + 分层评测。
- **异盘备份落地**：全量 485 文件（含 v3.2.1 全部源码/测试/文档）核数一致复制至 `D:/PPXANS-Backup/PPXANS-Harness-v3.2.0-20261003/`，版本控制风险缓解（此前源码+备份同盘）。

### 评测 (功能完备度)
- **localIntent 反向用例**：复合请求（"你好，帮我写…" / "帮我把现在几点记下来"）不得被高置信短句模板误劫持——误劫持 = 模型根本收不到任务。

### 文档
- `docs/CONFIG.md` 新增 **budget（成本预算）** 配置节（usd / model_prices 语义、优先级、落盘行为）。
- 回归网抓住一次 README 改写事故：品牌词"皮皮虾"被整体丢失导致 2 项测试挂——已补回标题行（README 18:47 的外部改写本身质量不错，保留其结构）。

## v3.2.0 (2026-10-03l) - 成本预算闸门: usageStats 金额化 + 支出上限 (发版节)

> 本节起正式发布 **v3.2.0**（自 2026-10-02j 起的全部"未发布"节一并带入本版本）。全量测试 **1022 项：1018 通过 + 4 skip，0 失败**（本节新增 8 项守卫 `test/budget-cost.test.js`）。`npm pack` 干跑验证：187 文件 / 410.2 kB / 含 `skills/`。

### 成本预算控制 (增强框架第 8 条收官)
对照"Agent 变强"增强框架逐维盘点：评估/归因（eval + triage + diagnose）、上下文工程、工具重试（超时+错误双路）、规划验证（supervisor/反思闸门）、五层记忆、学习（refine/reward/playbook）、多 Agent（legion/supervisor/seam）、安全边界均已在位 —— 唯一缺口是 **usageStats 只记 token 数，无金额折算与支出上限**。本节补齐：
- 新增 `src/llm/pricing.js`：内置常用模型价格表（USD/1M tokens，前缀最长匹配，glm-4-flash 不误入 glm-4 收费档），`config.budget.model_prices` 可覆盖（精确 > 前缀 > 内置）；未知模型 cost 记 0 **不编数字**；仅 total_tokens 无拆分时按 completion 价计（预算取保守侧）。
- `usageStats` 增加 `cost`（USD）与 `byModel[m].cost` 维度，落盘 `usage-stats.json` 同步携带；配置了 `budget.usd` 时落盘附 `budget_usd` 快照。
- **支出预算闸门**：`config.budget.usd`（USD，0/缺省 = 不限）达限后 `chat()/chatStream()` 拒绝继续调用模型并返回可操作的提示文案（含调整入口），tracer/bus 发出 `budget/exceeded` 事件。闸门只拦用户入口，不拦后台 refine/记忆提炼（小额，避免自学习链路断粮）。按进程累计、重启归零 —— 跨进程持久预算属外部计量职责，诚实不做。
- 守卫测试 8 项：价格表前缀/覆盖优先级/金额折算/未知模型零编造/达限拦截 chat+chatStream/未配置零拦截/usd=0 语义。

## 未发布 (2026-10-03k) - 第三轮深度优化: 剩余 P2 全清 + Supervisor 接线

> 全量测试 **1014 项：1010 通过 + 4 skip，0 失败**（守卫累计 13 项 `test/audit-2026-10-03.test.js`）。

### Supervisor 编排接线 (预留件清零)
- `spawn_agent` 新增 `supervisor: true` 模式 (runSupervisor 首个产品入口)：同一任务派发多专家 (默认 2, 上限 4, 复用专家名册与只读防线) → 分歧检测 → 监督者 LLM 评审 (接受/打回带反馈重派) → 定稿整合；`fix_rounds` 控制最大轮数 (1-5)；编排后 lifecycle.reproduce 计数。
- 至此三件预留骨架: playbook ✅ 接线 / supervisor ✅ 接线 / seam-registry 保留 (服务定位由 plugin/context 承担, 注释明示)。

### 安全/正确性
- **MCP Origin 校验修复 (重要)**: 原 `channels/http.js` 传 `skipOriginCheck: true` 且被工厂吞参 —— 双重失真。核查发现宿主 `_applyCors` 对恶意 Origin 仅"不回显 ACAO"并不拒绝, 无法独立防 DNS rebinding；改为宿主与 MCP handler **共享同一 cors 白名单** (handler 保留安全默认: 仅回环 Origin), rebinding 防线回归 handler 内。
- **Auditor 账本哈希链化**: `verified.json` 从明文数组升级为 SHA-256 链式哈希 (对齐 audit-chain.js), 新增 `verify()` 完整性校验; guard/learning/refineSkill 全部写入方自动受益, 兼容旧账本 (legacy 前缀不算篡改)。
- **前端流式事件配对**: `toolEls[ev.id || ev.tool]` 同名工具错配 → id 优先 + 无 id 同名 FIFO 队列串行配对。

### 性能
- **记忆写放大修复**: 主链路 FactStore 默认开启 WAL 增量落盘 (`wal: true, walThreshold: 50`, config.memory 可覆盖) —— 原每次记忆变更全量原子重写 facts.json; 变更走追加日志达阈值才 compact; `agent.shutdown` 时 flush 兜底。轻量构造/测试保持旧行为。

### ANS 语义
- **lifecycle evolving/reproducing 升为真阶段**: evolve()/reproduce() 达成时从 mature 推进 stage (原为"阶段名存在但永远不可达"的纯计数器); 持久化测试断言同步新语义。

### UX / 打包
- CLI busy 期输入从静默吞掉改为可判读提示 (`/stop` 引导); npm `files` 补 `skills/` (npm 用户技能加载不再靠 cwd 撞运气); `.gitignore` 清理死规则; a11y: toast `role="status"` + 命令面板 `listbox/option` 语义 + aria-selected 动态同步。

## 未发布 (2026-10-03j) - 第二轮优化: 预留件接线 + Web UI 实时化

> 落地"全部优化"轮。全量测试 **1014 项：1010 通过 + 4 skip，0 失败**（累计新增 13 项守卫 `test/audit-2026-10-03.test.js`）。

### 接线 (预留件 → 真实消费链)
- **语境 Playbook** (`src/evolve/playbook.js`): 引擎就绪但零消费 → 三线接线：
  - `agent/index.js` 持有 `ctx.consume("playbook")`，`prompts.js` 新增 `_playbookPrompt()` 注入 system prompt（bullets 为空时返回空串，零 token 成本）；
  - `LearningService.refine` 教训过闸后自动 `apply(ADD)` 沉淀为 playbook bullet（grow-and-refine 去重内置）。
- **协议总线 EQ** (`src/protocol/index.js`): 零消费者 → `channels/http.js` 构造时 `eq.subscribe` → 经 SSE `/events` 广播结构化事件给 Web UI（`APPROVAL_REQUESTED` 到达即提示，不再只靠 5s 轮询）。
- **协议总线 WAL**: `plugin/v3.js` 原硬编码 `walPath: null`（注释宣称默认落盘但从未开启）→ 默认落 `data/protocol/eq.wal.jsonl`（`config.protocol.wal_enabled=false` 可关），`replay()` 可用。

### Web UI 主动提醒 (断链修复)
- `HttpChannel.send` 原为 no-op（`return text`），server.js 主动提醒 ticker 的 `manager.broadcast` 到 Web UI 永远蒸发 → 新增 `GET /events` SSE 端点（鉴权兼容 Bearer 头与 `?token=` 查询参数，EventSource 无法自定义头），`send()` 广播 `{type:"reminder"}`；心跳 25s 防空闲断连，断连自动回收；前端 `connectEvents()` 订阅 + 8s 提醒横幅。

### 前端死交互修复 (4 处)
- 设置面板读 `ag.llm.model`/`j.tools`/`j.root`（bootstrap 从未返回）→ bootstrapPayload 补 `model`/`toolsCount`/`root` 字段，面板真实展示；
- `updTokPill` 优先级 bug（total 为 0 时拼出 "undefined/undefined"）→ 显式分支；对话 done 帧补 `usage`（累计 calls/tokens），token 徽标复活；
- token 手输死路（localStorage 读 `ppx_token` 但全站无写入点）→ 401 时 prompt 输入 token 存储并自动重试一次（同时补齐"401 无自助恢复"缺口）；
- 工作区目录切换参数不匹配（前端发 `?path=`，后端读 `?root=`）→ 对齐为 `root`。

### API 一致性
- `memory_forget` / `memory_restore` 参数命名统一：两者均接受 `id` 与 `id_or_content`（互相兜底），schema 同步，消除同族工具参数口径不一。

### 处置决策
- **supervisor / seam-registry**：保留为预留骨架（文件头诚实标注接线状态、有单测覆盖、零运行时成本）；接线需产品拍板入口形态（supervisor 建议作为 spawn_agent 的编排模式或 CLI 命令，不在本轮擅自定）。

## 未发布 (2026-10-03i) - 全面体检修复 (2×P0 + 9×P1)

> 五路并行只读体检后落地修复。全量测试 **1007 项：1003 通过 + 4 skip，0 失败**（基线 1001 项零回归，新增 6 项守卫 `test/audit-2026-10-03.test.js`）。

### 修复 - P0（均有实证复现）
- **aml-server 直跑静默不启动**：入口判断正则误写 `/\\\\/g`（匹配双反斜杠），Windows argv1 单反斜杠永不匹配 → `node src/aml-server.js` 无输出退出。改用 `pathToFileURL` 规范比较。（src/aml-server.js）
- **删除任意会话误删 default 主会话**：前端 delSession 发 `{ sessionKey }`，后端只读 `data.key` → 恒 undefined → 兜底删 default。9-18 的修复只改了后端解析、未对齐前端字段名。现在两侧字段兼容读取。（src/channels/http.js）

### 修复 - P1
- **tool 消息补标准 `tool_call_id`**：原只写非标 `_id`，严格 OpenAI 兼容后端（官方/vLLM）第二轮必 400。（src/core/policy.js）
- **本地模型预设可用了**：lmstudio/ollama 预设 build 出的 provider 原先无 api_key → `LLMClient._request` 必抛。注入占位 key（`"local"`），与 ppx.json.example 手工模板行为对齐。（src/llm/presets.js）
- **权限引擎异常改为 fail-closed**：原 catch 后放行（fail-open），引擎崩溃=防线全开，与 permissions 内核口径相反。现在拒绝执行并给可判读错误。（src/agent/index.js）
- **打包不再泄漏明文密钥**：`npm run package` 原整目录复制 config/ → 会把含 api_key 的 ppx.json 打进发布物。打包时排除。（scripts/package.js）
- **打包摆脱 python3/Info-ZIP 依赖**：解压改 PowerShell Expand-Archive、压缩改 Compress-Archive，裸 Windows 可跑。（scripts/package.js）
- **HTTP 错误响应统一净化**：`_fail` 原样回传 e.message（含 ERR_* 内部细节），统一过 `publicErrorMessage`。（src/channels/http.js）
- **MCP 任务失败不再僵尸 running**：`ppx.task.run` 的 agent.chat 抛错时回滚 status=failed。（src/mcp/admin.js）
- **aml-server 加固四合一**：限流桶回收（防内存无界增长）、鉴权恒时比较、请求体 Buffer.concat 修复跨块 UTF-8 截断、非法 JSON 回 400（超限仍 413）、/health 免鉴权但仍受限流。（src/aml-server.js）
- **桌面启动器修复**：「皮皮虾 Web.vbs」硬编码旧绝对路径 → 相对脚本定位（GBK 编码保留）；「高级菜单.bat」移除死选项 [7]（无 web/ 目录、无 web:build script）、版本横幅对齐 3.1.0。

### 修复 - P2
- **学习闭环对网络类失败失明**：`http_request` / `web_search` 的网络级失败（DNS 解析失败/连接拒绝/超时）原样返回优雅 JSON（`ok=true`），故障病历闭环（只认 `[工具错误]` 前缀）对这类最常见的执行失败完全不记录。改为统一 `[工具错误]` 前缀返回，对齐项目"工具永不 throw、错误编码进前缀"纪律。（src/tools/advanced.js）

### 运行时配置
- 补建 `config/ppx.json`（标准运行时配置，此前缺失）：智谱 glm-4-flash，`api_key_env: ZHIPU_API_KEY` 引用环境变量，**密钥零明文落盘**。注：环境中的 `DEEPSEEK_API_KEY` 实测 401 无效（key 本身问题，非本项目缺陷）。

### 文档
- README 测试数三口径（1001/989/1015）统一为实测 1007。

## 未发布 (2026-10-03h) - 语音能力 + 内嵌记忆数据库 + 两处深度修复

> 三件事: ① 加语音模型（ASR/TTS）② 加内嵌记忆数据库（SQLite）③ 继续深度修复。

### 新增 - 语音能力（ASR + TTS），**零运行时依赖**
- `src/tools/voice.js` → `voice_transcribe`（语音转文本）+ `voice_speak`（文本转语音）。
- **零依赖实现**：走 OpenAI 兼容 HTTP 端点（`/audio/transcriptions`、`/audio/speech`），
  multipart 用 Node 内置 `FormData` + `Blob`，**不引入任何 npm 包**。
- 兼容 OpenAI / 硅基流动 / 火山 / 智谱 / 本地 whisper.cpp server 等任意 OpenAI 兼容端点。
- 配置：`config/ppx.json` → `voice.asr { base_url, api_key_env, model }` +
  `voice.tts { base_url, api_key_env, model, voice, format }`；未配置时工具返回**可行动的配法提示**。
- 校验：音频格式白名单 + 25MB 上限 + 文本长度上限；错误信息指路。
- 凭证零外泄：`api_key_env` 走环境变量，不落配置文件。

### 新增 - 内嵌记忆数据库（SQLite，`config.memory.backend`）
- `src/memory/sqlite-store.js`：基于 **Node 内置 `node:sqlite`**（Node ≥ 22.5）的内嵌库实现，
  **接口与 FactStore 完全对齐**（19 个公开方法），可一键切换。
- **中文检索**：FTS5 内置分词器对中文不友好（unicode61 把连续汉字当一个 token，trigram 又要求查询 ≥3 字符），
  故采用「应用层 bigram 切分 → FTS5 存切分文本 → 查询同口径切分」，中文子串检索正常工作。
- **WAL 模式**：读写不互斥、崩溃可恢复；事务级并发安全，不再依赖文件锁忙等。
- 后端：`"json"`（默认，向后兼容）| `"sqlite"` | `"auto"`（优先 sqlite）；不可用时自动回落 JSON。
- 装配点 `plugin/builtin.js:factsPlugin`；`agent.shutdown()` 会释放数据库句柄。

**实测对比（800 条写入 / 200 次查询，`npm run bench:store`）**：

| 后端 | 写入总耗时 | 单次查询 | 体积 |
|---|---|---|---|
| json | 7337 ms | 0.202 ms | 303 KB |
| **sqlite** | **392 ms（18.7×）** | 0.467 ms | 4.6 MB |

> 优化过程记录：初版 SQLite 查询 10.8ms/次（比 JSON 慢 52 倍）。逐层 profile 后定位到两处：
> ① 精排里对每条候选重复调 `tokenize()`（改为落库 `toks` 列）；
> ② **`ORDER BY bm25()` 与外层 JOIN 写在一起会让 SQLite 走错执行计划** ——
> 把 bm25 排序隔离进子查询后，同样数据量从 16ms/次 降到 **0.16ms/次（100×）**。
> 最终查询 0.467ms/次，写入快 18.7 倍。

### 修复 - `_runTool` 上帝函数拆分（136 行 → 41 行）
- 抽出 `_admitToolCall()`（PreToolUse 钩子链 + 权限引擎 + 审批缓存，50 行）与
  `_processToolOutcome()`（注入扫描 + 事件/轨迹落库 + 故障病历回灌，51 行）。
- 行为**逐行等价**（仅做搬移，不动语义），全量测试零回归。

### 修复 - 95 处裸静默 catch 全部加固
- `catch {}` / `catch (e) {}` → `catch (e) { debug(\`[<模块>] 已忽略异常: ${e?.message || e}\`); }`，
  覆盖 35 个文件共 95 处；带注释的"有意静默"catch 一律跳过。
- 动机：本会话**两次**被空 catch 咬 —— `agent/index.js` 用了 `fs` 却没 `import`（ReferenceError 被吞，
  用量统计永不落盘）、`aml-server` 模块顶层副作用撞 ESM import 提升。
- 新增守卫测试：`src/` 出现裸静默 catch 即失败（防新增）。
- 注：脚本首次运行时自动插入的 logger import 相对层级算错（`src/tools/` → `src/utils/` 只需 `../`），
  从备份还原后修正公式重跑。

### 验证
- 全量 **1015 项：1011 通过 + 4 skip + 0 失败**；自愈 7/7；eval 7/7；web:check 全过；skill-lint 11/11。
- 内核工具数 **59 → 61**（+voice_transcribe / voice_speak）；`test/audit-2026-10-03.test.js` 增至 26 项。
- 新增 `npm run bench:store`（存储后端对比）。全量测试后 `data/` 零残留。

## 未发布 (2026-10-03g) - 失败归因闭环: 评测从"知道失败"升级到"知道为什么失败"

> Agent 增强框架第 1 条说得很直白：「先建评估和日志，否则就是盲调 …… **对失败归因**」。
> 项目的评测、轨迹、基线都有，唯独缺归因 —— 基线里 3 个失败任务清一色 90000ms 超时，
> 但没有任何结构化结论说明"为什么卡住"，`self_diagnose` 只能写一句「需人工判定」。

### 新增 - `src/services/triage.js` 失败归因模块（确定性，零 LLM）
从执行轨迹判定根因，输出 `{cause, confidence, evidence[], action}`，`action` 直接对应
"按症状下药"表的处方。八类根因：

| 根因 | 判据 | 处方 |
|---|---|---|
| `llm_stall` | 跑满时限 + 工具调用 ≤2 | 单次 LLM 超时必须小于任务级时限 |
| `loop` | 跑满时限 + 同一调用重复 ≥3 | 任务分解 + 验证器 + 重规划 |
| `timeout_unknown` | 跑满时限 + 多次调用无重复 | 补全轨迹后重跑定位 |
| `tool_use` | 有工具返回错误（参数/未知/权限/超时分类统计） | 结构化输出 + 参数校验 + 重试 + 沙箱 |
| `planning` | 轮次逼近上限且无错误 | 任务分解 + 验证器 + 重规划 |
| `verification` | 工具全成功、有产出，但判分失败 | 生成 → 验证 → 修正 |
| `knowledge` | 几乎没查就作答 | RAG + 引用核验 + 工具查询 |
| `unknown` | 轨迹不足以判定 | 采集更多样本 |

附带 `summarizeCauses()`：按根因分布汇总，给出**主因 + 主因处方**。

### 改造 - `scripts/taskbench.js` 采集轨迹并自动归因
- `setToolEvent` 收集**工具调用序列**（tool / args / ok / error / durationMs）—— 这是三类
  超时与工具类根因的判据来源；此前只记"成功/失败"，无从归因。
- 失败任务自动跑 `triageFailure`，控制台即时打印 `↳ 归因[loop] 85% — 证据…`。
- 结果与基线新增 `trace`（调用数/错误数/工具名序列）与 `triage` 字段；`--baseline` 合并时保留。
- 汇总新增「失败归因」段：根因分布 + 主因处方。

### 接线 - `self_diagnose` 消费归因
基线失败项若带 `triage`，诊断报告直接给出确定性根因与处方，**不再回落「需人工判定」**；
无归因数据时明确提示「重跑 taskbench 可自动归因」。

### 验证
- 全量 **1007 项：1003 通过 + 4 skip + 0 失败**。
- `test/audit-2026-10-03.test.js` 增至 18 项（新增归因 8 类判定 / 汇总 / taskbench 代码路径守卫 /
  self_diagnose 消费 4 项）。
- 实测 `self_diagnose` 对当前 baseline 输出：`根因: 未归因 (重跑 taskbench 可自动归因)` —— 链路就绪，
  只差一次真 LLM 运行即可产出确定性归因。

## 未发布 (2026-10-03f) - 上下文工程: 工具渐进披露 (固定开销 -59%) + 配置隔离缺陷修复

> 用「Agent 增强框架」(想/记/做/学/评 + 按症状下药) 做透镜体检，落在框架第 2 条（上下文工程）
> 与成本症状（上下文压缩）上。实测发现**每请求 82% 的固定开销花在工具 schema 上**。

### 新增 - 工具渐进披露（Progressive Tool Disclosure）
- **诊断**：空会话下固定开销 ≈ **8172 tok/请求**，其中 `tools.toOpenAI()` 的 59 个工具 schema 占
  **6725 tok（82%）**；而单个任务通常只用 3–5 个工具。最大浪费不在记忆、不在历史，在工具清单。
- **实现**：`ToolCatalog` 新增**披露层**，与 `enabled` **正交** ——
  `setExposure(list)` / `expose(name)` / `isExposed(name)` / `hiddenFromLLM()`；
  `toOpenAI()` 改为输出「启用 **且** 已披露」的工具。
- **关键不变式**：未披露 ≠ 不可调用。未披露的工具仍可被 `catalog.call` 调用，
  内部链路与既有测试完全不受影响 —— 只是不进 LLM 的 `tools` 参数。
- **按需加载**：`_context()` 新增【按需工具】清单（**只列名、不列参数**，约 240 tok），
  agent 需要时 `enable_capability` 启用，该工具下一轮即进入 schema。
- **配置**：`tools.progressive`（默认 true）+ `tools.core`（20 个核心工具白名单）；
  设 `progressive: false` 可一键恢复全量披露。
- **实测**：工具 schema **6725 → 1713 tok**，固定开销 **8172 → 3357 tok（-59%）**。

### 修复 - 配置隔离缺陷（`deepMerge` 浅拷贝污染全局默认值）
- `loadConfig` 的 `deepMerge` 用 `{ ...base }` 只做浅拷贝，**未被 override 覆盖的嵌套分支
  沿用 `DEFAULT_CONFIG` 的同一个引用**。
- 后果：任何实例级配置修改都会改写全局默认值 —— 实测 `c1.tools.progressive = false` 会让
  `DEFAULT_CONFIG.tools.progressive` 一起变，且**同进程内后续所有实例与测试用例被带偏**
  （多 agent 同进程、Web 多会话、`reloadSettings` 热改配置均中招）。
- 修：改为先 `deepClone(base)` 再合并，实例配置与全局默认彻底隔离。

### 新增 - 诊断工具
- `npm run bench:ctx`：打印单请求上下文构成（工具 schema / 各注入段 / 合计），改工具后应重跑。
- `npm run bench:audit`：审计链写入性能基准（守住 O(N²) 不回归）。

### 验证
- 全量 **1003 项：999 通过 + 4 skip + 0 失败**；自愈 7/7；eval 7/7；web:check 全过；skill-lint 11/11。
- `test/audit-2026-10-03.test.js` 增至 14 项（新增渐进披露 3 项 + 配置隔离 1 项）。
- 全量测试后生产 `data/` 零残留。

## 未发布 (2026-10-03e) - 补全丢失的 skills 层 + 四项缺陷修复 + 性能与能力接线

> 起点是一次完整性审计：该副本缺失 `src/skills/` **整层**，内核根本无法启动（71 个测试文件加载失败）。
> 补齐后复测又揪出 4 个"测试全绿时潜伏"的真实缺陷，并把两个"装配了却零消费"的服务真正接上线。

### 修复 - `src/skills/` 整层丢失（P0，内核不可启动）
- 补回 `loader.js` / `search.js` / `verify.js` / `lint.js`。
- 症状：`import('./src/agent/index.js')` → `ERR_MODULE_NOT_FOUND`；`npm test` 575 项 / 503 过 / **71 失败**；
  Web / CLI / MCP / selfheal-bench / eval / skill-lint 全线崩溃。
- 契约来源：完全由现有调用点（`agent/index.js:36`、`mode/router.js:5`、`tools/selfmod.js:4-5`、
  `services/learning-service.js:14`）+ 8 个测试文件反推，零猜测。
- 关键设计：`list()` 用 mtime+size 签名缓存（内容改动与目录增删必须实时反映）；
  `verifySkill` 检查顺序必须是 结构→长度→接地→轨迹（否则空壳正文会误报"未引用工具"）；
  `matchSkill` 需 ≥2 次命中且并列同分返回 null。

### 补全 - `skills/` 技能目录（11 个技能 + 两套独立引擎脚本）
- 11 个 SKILL.md：brainstorm / verify / plan / debug / ponytail / ppx-memory / ppx-selfheal /
  prompt-depth-kit / session-naming / agent-professional-training / cupid-lover-comms。
- `skills/ppx-memory/scripts/`（13 文件）：从 `src/memory` + `src/utils` 扁平化，import 改 `./`，
  附 `cli.js`（add / search / context / session / forget / restore / deleted / stats / export），**不依赖主项目可独立运行**。
- `skills/ppx-selfheal/scripts/`（4 文件）：同上，附 `cli.js`（check / crash / status / prune / heal）。
- 实测：`node skills/ppx-memory/scripts/cli.js add "..."` → search / stats 全链路跑通。

### 修复 - 军团 broadcast 契约错位（功能完全失效）
- 生产 `orchestrator/legion.js:broadcast()` 返回 `{agent, id, type:'reply', reply}`，
  而消费方 `mode/legion.js` 按 `{status:'fulfilled', value:{reply}}` 取值 —— 那是**测试桩伪造的形状**。
- 后果：filter 恒空，军团 broadcast 100% 落兜底串；测试因桩喂虚构字段而一直全绿（test double drift）。
- 修：消费方改匹配真实形状 + 桩改为真实形状 + 新增契约守卫（断言不得存在 `status` / `value` 字段）。

### 修复 - 用量统计永不落盘（空 catch 掩盖 ReferenceError）
- `agent/index.js` 调 `fs.writeFileSync` 却**从未 import fs**，ReferenceError 被空 catch 吞掉。
- 修：补 import + 新增 shutdown 落盘回归守卫。

### 修复 - 沙箱把 URL 当盘符路径
- `permissions/index.js` 的盘符正则 `[A-Za-z]:[\\/]` 在 `curl http://x` 中匹配到 `p:/` → 判"路径越界"直接 deny。
- 影响：`WORKSPACE_WRITE`（默认预设）下任何带 URL 的命令都跑不了，且报误导性的安全理由。
- 修：扫描前先剔除 URL 字面量；真实越界路径仍照旧拦截（permissions 27/27 保持通过）。

### 修复 - 测试污染生产 `data/`（ESM import 提升陷阱）
- `src/aml-server.js` 在模块顶层 `const store = new FactStore(DATA, {})` —— ESM 静态 import 先于调用方代码执行，
  于是测试里"先设 `PPX_AML_DATA` 再 `createAmlServer()`"完全无效，每跑一轮测试就往真实 `data/aml` 写 2 条记录。
- `test/legion.test.js` 的 `spawnAgent` 不传 dataDir → worker 退回默认 root（项目根）的 `data/`，
  把记忆库 / 审计链 / L3 画像 / 定时任务全写进生产目录（139 个测试文件中**唯一**一个）。
- 修：aml-server 改懒初始化（import 零副作用）+ legion 测试补 tmp dataDir + `spawnAgent` 未传 dataDir 时告警。
- 验证：全量测试跑完后 `data/` **零残留**。

### 性能 - 审计链 O(N²) → O(N)
- `audit-chain.lastHash()` 原先每次 append 都全量读日志文件，整体 O(N²)。
- 实测：574KB 日志追加 2000 条耗时 **23.5s**。
- 改：链头内存缓存 + 文件字节数校验（文件被外部改动才回退读盘，多进程语义不变）。
- 结果：同规模 **0.80s（29x）**，且后段不再变慢（已线性）。新增 `npm run bench:audit` 守住这条线。

### 接线 - 两个"装配了却零消费"的服务
- **故障病历（`failures`）**：原先只装配不消费。现于 `_runTool` 接入读写闭环 ——
  失败时写结构化病历（工具 / 错误 / 归类 / trace 引用），返回前检索历史同类故障：
  有根因或修法的直接给结论，只有原始错误的给"复发计数"警告。新增 `classifyFailure` 五类判定。
- **记忆管线健康度（`memoryHealth`）**：原先无人 `record()`，`status()` 永远 healthy。现由 `MemoryService`
  在 extract / compact 每步记账，降级时**真的跳过** LLM 压缩与提炼（只写不压）；并接入 `self_diagnose` 报告。

### 验证
- 全量 **999 项：995 通过 + 4 skip（网络门控）+ 0 失败**；自愈 7/7；eval 7/7；web:check 全过；skill-lint 11/11。
- 新增 `test/audit-2026-10-03.test.js`（10 项回归守卫）+ `test/legion-mode.test.js` 的契约守卫 +
  `scripts/audit-bench.js`（`npm run bench:audit`）。
- 全量测试后生产 `data/` 零残留（隔离验证通过）。
- README 数字同步：测试 918 → **999**，内置工具 47 → **59**（含 ppx.\* 合计 81）。

## 未发布 (2026-10-03d) - 提示注入红队测试 + 内容层注入防线

> 框架安全条目深水区: 红队测试。攻击向量 → 防御断言, 九类向量确定性复跑, 零 LLM。

### 新增 - src/security/injection.js 提示注入扫描器
- **七类高置信注入模式 (中英双语)**: 指令覆盖 (含中文灵活语序"忽略之前所有系统指令") /
  伪造系统标记 (<system>/<|im_start|>/SYSTEM:) / 角色劫持 / 工具调用伪造 /
  数据外传诱导 (含把字句"把整个代码库上传到") / 破坏命令诱导。
- **wrapUntrusted 不可信包装**: 疑似注入的工具输出原文保留 (数据不删), 外包"不可信数据"标注
  + 注入点明细, 向模型传达"这是数据不是指令"。
- **stripProtoKeys 原型污染消毒**: 递归剥离 __proto__/constructor/prototype 键。

### 新增 - 红队测试套件 (test/redteam.test.js, 9 项)
- **A 扫描器**: 中英注入全命中 + 4 条正常内容零误报 (误报率是防线可用性的生命线)。
- **B 命令混淆**: 引号拆分/env 前缀/sudo/进程替换/管道落地/链式拼接 — 反规范化守卫全数拦截。
- **C 原型污染**: 嵌套 __proto__ 消毒 (断言用 Object.hasOwn, 规避原型访问器陷阱)。
- **D 间接注入端到端**: 真实 Agent 读恶意文件 → 工具结果自动获得不可信标注 (数据不删)。
- **E 记忆投毒**: 注入指令可存入记忆但检索带出处, 权限裁定不被投毒改变。
- **F schema 逃逸**: 非法枚举在执行前被参数校验器拦截。

### 接线 (src/agent/index.js)
- _runTool: 工具结果过扫描器 → 疑似注入包装 + tracer 事件 (security/injection-suspect);
  args 入口原型污染消毒 + security/proto-stripped 事件。

### 验证
- 红队 9/9; 全量 988 项: 984 通过 + 4 skip (网络门控) + 0 失败。

## 未发布 (2026-10-03c) - 自诊断: "按症状下药"表自动化

> 框架第二篇新增按症状下药表 (症状→根因→增强动作) 与失败归因五分类——把这张表做成皮皮虾的自诊断工具。

### 新增 - self_diagnose 工具 (src/services/diagnose.js)
- **信号聚合 (全部本地白盒)**: 审计哈希链 (工具调用 ok/error/ms, 参数错/策略拦/超时分类计数) +
  失败案例库条数 + 会话使用统计 + 任务基线失败项。
- **六条症状规则**: 单工具高失败率 (>30%) / 参数拦截 / 权限拦截频繁 / 单次成本 >15k tok (建议启用
  model_routing.aux) / 基线未通过 (列任务 id) / 失败案例堆积 (建议 --learn 复跑 + 归因分类)。
- 零 LLM 参与, 确定性可复现; 报告含严重度分级 + 可行动处方。
- **跨仓库防污染**: 基线只读显式传入的 rootDir, 不回落 cwd。

### 实测
- 对皮皮虾自身诊断: 正确读出 47 次调用 / 715000 tok / 基线 3 项未通过, 并开出"启用分层路由"处方
  (它推荐的正是上一轮刚建的 model_routing.aux)。

### 验证
- 新增 test/diagnose.test.js 3 项守卫 (空数据不误报/高失败率与参数拦截/基线+案例库联动)。
- 全量 979 项: 975 通过 + 4 skip (网络门控) + 0 失败。

## 未发布 (2026-10-03b) - "想记做学评"框架对齐: 工具参数校验 + 单位成本度量 + 失败案例库联动

> 用户提供了 Agent 强化框架 (想/记/做/学/评, 七维公式), 以其为审计透镜盘点皮皮虾并补齐最弱环节。

### 框架审计结论
- 已强: 评估 (taskbench/基线/验收)、记忆 (五层+经验库+失败病历)、规划 (plan-exec+反思+仲裁)、
  多智能体 (军团+审查循环)、安全 (DSH 预设/能力门/命令守卫)。
- **最弱环节 = 工具杠杆: 声明了 JSON Schema 但运行时零参数校验** — 参数错误浪费一整轮 LLM 交互。

### 新增 - 工具参数校验器 (框架第 3 条: 参数要校验)
- **validateArgs** (catalog 层): required / type / enum 三查; 字符串数字自动转换 (宽容);
  未知键放行 (LLM 冗余键不误杀); 校验先于权限/策略链 (参数都错了就别问权限)。
- 错误文案可行动: 指明缺什么/该是什么 + 列出可用参数, LLM 一轮自修正。
- 附带收益: enum 类错误 (如 code_act 非法语言) 在工具执行前即拦截。

### 新增 - 度量与学习闭环 (框架第 1/5 条)
- **单位成本成功率**: summarize 新增 costEfficiency (通过任务数/10万 token), 汇总行展示。
- **失败案例库联动**: taskbench --learn 将失败任务写入 FailureEpisodeStore (rootCause 含回复片段),
  接通"评估失败 → 反思原因 → 写入记忆"的学习循环。

### 验证
- 新增 3 项守卫 (校验三查+宽容/实弹不执行/codeact 文案升级)。
- 全量 976 项: 972 通过 + 4 skip (网络门控) + 0 失败。

## 未发布 (2026-10-03a) - ZCode 吸收第三波: Wiki 陈旧感知 + 会话使用统计

### 新增
- **Wiki 陈旧检测** (checkStaleness): 源码 mtime 晚于 wiki → 标记陈旧; repo_wiki 调用时
  陈旧自动重生成而非返回过期内容 (ZCode repo-wiki 的对话轮次自动刷新语义)。
- **repo_wiki 能力诚实化**: 陈旧刷新会写 docs/WIKI.md → 撤销 readOnly 声明 (sideEffect: workspace)。
- **会话使用统计**: agent._installUsageTracking 零侵入包装全部 provider (apiChat+chat),
  累计调用次数/token/按模型分解; `usage_stats` 工具查询; shutdown 落盘 data/usage-stats.json。

### 验证
- wiki 测试 4/4 (新增陈旧检测三态: 未生成/同步/变更); usage 闭环实测 (累计→工具→落盘)。
- 全量 974 项: 970 通过 + 4 skip (网络门控) + 0 失败。
- 补记: 上一轮 CHANGELOG (10-02r) 因编辑与提交竞态未入库, 本轮一并提交。

## 未发布 (2026-10-02r) - ZCode 深度吸收第二波: Wiki 生成器 + 数据流白盒披露

> 用户诉求: 继续吸收并深度优化, 阅读两篇 ZCode 协作文章。微信原文被验证墙拦截, 改用镜像全文
> (博客园 GLM-5.3 官方 Harness 全解析) 完成调研, 提炼出两项 ppx 尚未覆盖的机制。

### 新增 - 代码库 Wiki 生成器 (ZCode repo-wiki 对齐)
- **src/wiki/index.js**: 按目录生成架构文档 — 核心定义签名 + file:line 绑定 + mermaid 模块依赖图
  (相对 import 解析为内部边, 节点限幅)。
- **敏感文件排除** (ZCode 同款语义): 文件名含 token/secret/credential/password/api-key/pem/key 等一律不读不引;
  未入扫描扩展名的文件 (txt/pem) 天然双重排除。
- **噪音治理三级过滤**: json 键值不进正文 / md 只留一二级标题 / function·class 优先于裸 const 赋值。
- **repo_wiki 工具** (readOnly, 可 save 写入 docs/WIKI.md) + **scripts/wiki.js** CLI。
- 实测: 皮皮虾自身 220 文件 / 5258 定义 / 307 依赖边。

### 新增 - 数据流透明披露 (ZCode NOTICE.md 模式)
- **docs/DATA-FLOWS.md**: 按业务场景列全 7 类出站数据流 (触发条件/数据范围/去向), 审计方法可复现;
  明确声明不做的事 (无代码快照上传/无遥测/无网关转发); 用户自担部分按 ZCode NOTICE 同款措辞。
- 差异化定位: ZCode 用 NOTICE 重建信任, 皮皮虾从第一天就把白盒披露当作架构不变量。

### 验证
- 新增 test/wiki.test.js 3 项守卫 (敏感排除/源码绑定/mermaid 边)。
- 全量 973 项: 969 通过 + 4 skip (网络门控) + 0 失败。

## 未发布 (2026-10-02q) - 吸收智谱 ZCode: 声明式工具能力门

> 用户诉求: 智谱 ZCode 开源了 (zai-org/ZCode), 吸收到皮皮虾。调研其权限子系统
> (PermissionService/broker/approval-gate/plan-mode-policy), 选定最有架构价值的
> 「声明式工具能力元数据」机制落地, 其余 (ask/never 预设、fail closed) 与上一轮 DSH 对齐重合。

### 背景 — ZCode 权限设计精髓
- 工具注册时自带 PermissionToolCapability: readOnly / destructive / riskLevel / alwaysAsk / sideEffect。
- PermissionService 按元数据裁定: alwaysAsk 压过一切放行分支 (yolo/白名单直通都要问);
  riskLevel critical/high 分级; plan 模式只允许只读非破坏工具。
- 教训: ZCode 曾因静默上传用户代码库+Git 历史引发维权后整改开源 — 高权限工具必须显式声明能力边界。

### 新增 - 声明式工具能力门
- **ToolCatalog.getCapability(name)**: 工具→能力元数据; 未声明时按 category 保守推断 (system=high, net=high, 其他=low 只读)。
- **9 个内建工具完成声明**: read_file/list_dir/get_time/memory_search (readOnly/low),
  write_file/append_file (medium), delete_file/run_command (destructive/high)。
- **引擎能力门 (b2 段)**: capabilityGate + getCapability + planEnabled + autoApproveHighRisk,
  全部可运行时热切换; alwaysAsk/critical 必问, high 默认问, plan 模式只读直通破坏性拒绝,
  high+never 降级拒绝 (高危不可静默放行 — CVE 教训)。
- **agent 接线**: config.agent.capability_gate (默认开) / auto_approve_high_risk (默认关)。

### 兼容性
- capabilityGate=false 时行为与旧版逐位一致 (守卫锁定); 默认开启后唯一语义变化:
  NEVER 模式下高风险工具由"静默放行"改为"降级拒绝" — 有意的安全收紧。

### 验证
- permissions 测试 27/27 (新增 4 项: high ask/直通、never 降级拒绝、plan 模式进退、关闸向后兼容)。
- 全量 970 项: 966 通过 + 4 skip (网络门控) + 0 失败。

## 未发布 (2026-10-02p) - 沙箱权限对齐 DeepSeek Harness (DSH)

> 用户诉求: ppx 沙箱权限参考 DeepSeek 的 agent。调研 deepseek-ai/deepseek-harness 开源仓库及其
> 沙箱/审批文档 (runoob 教程、腾讯云开发者解析、PresetSpec README), 提炼三个 ppx 缺失的机制级设计。

### 调研结论 — DSH 核心设计
- **两个独立 knob**: sandbox/mode (read-only / workspace-write / danger-full-access, 只管文件效果)
  × approval/policy (ask / never), 权限预设层捆绑成具名预设 (PresetSpec) 供客户端单选。
- **Fail Closed**: 应答者缺失/不负责/抛异常 → unavailable → 调用方一律拒绝; 沙箱后端缺失 →
  SandboxUnavailableError, 静默无隔离透传永远不合法。
- **一次性提权**: 已批准的显式模式胜过会话策略, 单次重试消费后自动还原; 提权只放宽沙箱不改审批。
- **审批≠沙箱**: 审批是人机交接班 (高危/提权问人), 沙箱是能力边界 (文件效果隔离); 审计事件只进日志不进模型 transcript。
- **CVE-2026-82533 教训**: 常规 bash 执行绕过审批 = 架构级漏洞, 命令执行必须在守卫管线内。

### 新增 - src/permissions/index.js (DSH 对齐)
- **PERMISSION_PRESETS 具名预设**: workspace-write+on-request (默认) / read-only+on-request /
  danger-full-access+never (捆绑全自动, 只配可丢弃环境 — DSH 事故复盘语义)。
  `applyPreset(engine, name)` 一键应用 + `currentPreset(engine)` 折叠 (非预设组合 → "custom")。
- **requestEscalation(mode, {oneShot})**: 一次性提权 — check 时显式模式胜过会话沙箱策略,
  oneShot 消费后自动还原; 提权不接管审批策略 (审批是审批, 沙箱是沙箱)。
- **onAsk 应答者链**: check 的 ask 决策可交给异步应答者; 应答者异常/空值 → deny (fail closed);
  NEVER 模式不进应答者链 (never 在分发前强制执行, DSH 语义)。

### 已对齐项 (无需改动)
沙箱三档与 DSH 同构; 审批四档比 DSH ask/never 更细; 命令守卫反混淆 + 硬黑名单 (CVE 教训已覆盖);
审计哈希链独立于模型可见层。

### 验证
- permissions 测试 23/23 (新增 4 项: 预设捆绑折叠/一次性提权消费还原/应答者链三态/never 旁路)。
- 全量 966 项: 962 通过 + 4 skip (网络门控) + 0 失败。

## 未发布 (2026-10-02o) - 可选分层路由: 辅助任务走便宜模型 (不配置零影响)

> 用户约束: 不强制用户必须填 — 不配置时辅助调用跟随主模型, 零配置零门槛。

### 新增 - model_routing.aux (可选)
- **配置**: `config.model_routing.aux = "<providerId>"` 或 `ppx-setup --aux deepseek` / `--aux off`。
- **生效范围**: 记忆提取/摘要/压缩/查询扩展/学习服务等辅助调用走 aux 厂商 (主对话/工具循环/军团不变)。
- **三级回落保障**: 不配置 → 主模型; 配错 id → 启动 warn + 主模型; 厂商不可用 (占位 Key) → 主模型。
- 实现: agent.auxLLM 解析自 allProviders (providerId 匹配), MemoryService/LearningService 的
  getLlm 闭包改为 `() => this.auxLLM || this.llm` — 热重载语义保持 (实时取当前 provider)。

### 文档
- docs/MODEL-SETUP.md 增补「可选: 分层路由」节。

### 验证
- 新增 test/model-routing.test.js 4 项守卫 (配置生效/未配置回落/配错回落/占位 Key 回落)。
- 全量 963 项: 959 通过 + 4 skip (网络门控) + 0 失败。

## 未发布 (2026-10-02n) - repo-map 签名化: rank 噪音换函数骨架

### 优化 - src/repomap/index.js
- **渲染升级**: 定义节点从 `名字 (rank 0.0123)` → **定义行签名原文 + file:line 出处**
  (如 `export function calcDiscount(n){ // src/calc.js:1`)。rank 只做排序依据不再展示——
  对 LLM 而言函数骨架的信息密度远高于一个无意义的分数。
- 签名取定义行原文 (trim, 120 字符截断), token 预算机制不变, PageRank 排序不变。

### 验证
- 新增 2 项守卫 (签名+出处渲染/超长截断+预算), repomap 测试 6/6。
- 全量 959 项: 955 通过 + 4 skip (网络门控) + 0 失败。

## 未发布 (2026-10-02m) - 编辑失败诊断: 从瞎蒙到精准自修正

### 优化 - editblock 最佳匹配窗口
- **not-found 时自动定位"最像 SEARCH 的区域"**: 逐行归一化比较 (相等 1 分/包含 0.6 分),
  给出行号 + 相似度百分比, 随失败信息回灌 LLM——agent 拿着原文改 SEARCH 块, 一轮命中, 不再拿
  "未找到+首尾 20 行"瞎蒙。
- **formatRetryFeedback 升级**: 有 hint 时摘录最佳匹配区域原文 (±5 行带行号前缀),
  无相似区域回落旧首尾模式; apply_patch 整体回滚后 LLM 拿到的就是可直接对照的上下文。

### 验证
- 新增 3 项守卫 (hint 定位/无相似不造 hint/feedback 摘录+回落), 编辑块测试 16/16。
- 全量 957 项: 953 通过 + 4 skip (网络门控) + 0 失败。

## 未发布 (2026-10-02l) - 文件操作工具面补齐 (基线暴露缺口)

### 新增
- **append_file**: 末尾追加不覆盖原内容, 无换行结尾自动补 \\n, 不存在则创建。
- **delete_file**: 删除工作区内文件, 目录拒绝 + safePath 防逃逸。
- 两者补齐基线暴露的工具面缺口: 之前 agent 无追加/删除能力, 只能整体重写或绕道。

### 基线更新
- append-file 由失败翻绿: **基线 16/20 → 17/20 (85%)**。剩余 find-symbol / delete-file / extract-field
  三项在云沙箱反复复跑均被平台掐断 (>5s 的工具调用被杀), 判定无效需在稳定环境 (用户本地 Windows 直连)
  复跑 `node scripts/taskbench.js --only find-symbol,delete-file,extract-field --baseline` 定论。
- 全量 954 项: 950 通过 + 4 skip (网络门控) + 0 失败。

## 未发布 (2026-10-02k) - 任务级评测基准: 让「变强」可测量

> 用户诉求: 按杠杆清单推进第一优先——建立外部可复现的任务成功率, 区别于自评。

### 新增 - bench/ 任务级评测基准
- **bench/tasks.js**: 20 个可确定性验证的任务, 5 大分类:
  检索 (读配置/数文件/找符号/算数/列结构) · 文件 (创建/追加/JSON改/删/Markdown) ·
  代码 (语法修复/逻辑修复/写函数/重构改名, node --check + ESM 求值判分) ·
  协作 (board 往返/memory 闭环) · 多步 (读数→写报告/条件写入/JSON 生成)。
  判分全部确定性 (文件存在/内容匹配/语法可执行/数值正确), **不用 LLM 评审**, 可复现。
- **scripts/taskbench.js** 运行器: 沙箱隔离 (mkdtemp, 不污染仓库) · token 记账 (包装全部 provider 的
  chat+apiChat, 工具循环走 apiChat 的坑已踩平) · 单任务 90s 护栏 (LLM 卡死不拖垮整场) ·
  --only/--limit/--full/--baseline 参数 · summarize 汇总 (成功率/分类/token/失败明细)。
- **bench/baseline.json**: 基线文件 (--baseline 写入), 以后每次大改动跑对比防能力退化。

### 意义
守卫型单测回答「功能没坏」; 任务级基准回答「真能干活」。这是 T0 排名话语权 (SWE-bench 式) 的地基,
也是后续所有优化的量化标尺。

### 验证
- test/taskbench.test.js 4 项守卫 (任务集完整性/判分正反例/汇总聚合)。
- 实弹冒烟: 3 任务 3/3 通过, 16s, 54219 tok (检索 13k / 文件 20k / 代码 20k)。

## 未发布 (2026-10-02j) - 专家名册: 固化分工 (MetaGPT 式)

> 用户诉求: 像多专家项目一样固化角色——代码交给代码专家, 设计交给设计专家, 各司其职。

### 新增 - src/orchestrator/experts.js
- **9 大专家名册**: code(代码)/architect(架构)/review(代码审查·只读)/test(测试)/security(安全·只读)/
  design(设计)/docs(文档)/data(数据)/product(产品)。每个专家 = 中文名 + 专属视角 (注入 worker 对抗同质失败)。
- **只读专家**: review/security spawn 时自动置 PPX_AGENT_READONLY=1, 禁修改类工具。
- **resolveExpert 双向匹配**: 英文 id (code) / 中文名 (代码专家) / 简称模糊 (设计→设计专家) / 整句包含;
  未命中返回 null, spawn_agent 静默降级为普通角色, 不炸委派。

### spawn_agent 新参数
- **expert**: 单任务指派专家; **experts**: 与 tasks 一一对应分派 (优先于 expert)。
  专家生效优先级: 显式 perspectives > 专家视角; 显式 role > 专家中文名 (worker 命名/发板署名用专家名)。
- 工具描述内嵌名册摘要 (listExperts), LLM 自主协作时可直接点专家名。

### 验证
- 新增 test/experts.test.js 3 项守卫 (双向匹配/只读标记/名册完整性)。
- 全量 948 项: 944 通过 + 4 skip (网络门控) + 0 失败。
- 三专家实弹演练通过 (scripts/expert-drill.mjs, 128s): 代码专家指出 spawnAgent 健壮性风险 / 设计专家给出
  API Key 掩码建议 / 数据专家超时 1 项 (如实记录)。**查证**: 代码专家的 Critical 为误报——exit/error 监听、
  pending 拒绝与 agents 清理在 v1.0.8 已实现 (src/orchestrator/legion.js), 无需改动; 评审发现须验证后再动手。

## 未发布 (2026-10-02i) - 军团实弹演练通过 + 中文角色名修复

> 用户诉求: 真实端到端军团演练——3 并行侦察兵走真方舟 API, 验证发板→仲裁读板全链路。

### 新增
- **scripts/legion-e2e.js**: 军团模式实弹演练脚本 (可复用验收)。真 LLM 派 3 个并行侦察兵
  (读 README / 数 src/memory 模块 / 解析 package.json) → share_board 自动发板 → arbitrate 自动读板聚合,
  校验板条目数 ≥ 子任务数, 全程计时。

### 修复
- **中文角色名被清洗** (实弹演练暴露): role 清洗正则 `[^\w-]` 把「侦察兵」洗成「___」,
  记忆板 topic/from 全变下划线导致查询落空。改为保留 CJK: `[^\w\u4e00-\u9fff-]`。
  (中文向导项目, 中文角色名是常态——这类缺陷只有真 LLM 端到端能暴露, 单测的 mock 全用英文。)

### 演练结果 (真方舟 API)
- 委派+仲裁 ~20s; 仲裁简报准确 (14 个记忆模块全数列出含新增 legion-board.js, 版本/协议/入口无误)。
- 发板验证: 3 子任务结论自动上板, from=侦察兵_i_xxx, topic=侦察兵; 全量 945 项: 941 + 4 skip + 0 失败。

## 未发布 (2026-10-02h) - share_board: 共享记忆从可用变默认协作习惯

> 用户诉求: 把军团共享记忆板从「手动可用」升级为「自动协作习惯」——并行子任务结束自动发板, 仲裁前自动读板。

### 新增 - spawn_agent 接入记忆板
- **share_board 参数** (默认 true, 显式 false 关闭):
  - **发板**: 每个并行子任务结束自动发布结论 (topic=角色, from=执行 agent, 成功/失败/熔断状态标注, 任务截 120 字+结论截 400 字);
    review 循环在通过/熔断停放后同样发布, 熔断条目带「熔断停放」状态提示主 agent 复核。
  - **读板**: arbitrate=true 时主 agent 仲裁提示自动注入「军团记忆板 (本角色近期发布)」上下文 (最近 20 条),
    仲裁者能看到军团累积知识而非只看本次结果。
- **publishToBoard / arbitrateWithBoard** (delegate.js 导出): 发布永不阻塞委派 (板满/IO 异常静默吞掉),
  板空/无板时仲裁退化为原行为, 零破坏。

### 验证
- 新增 2 项守卫: publishToBoard (正常可见/null 板/异常吞掉) + arbitrateWithBoard (上下文注入/空板不注入/无板退化)。
- 全量 945 项: 941 通过 + 4 skip (既有网络门控) + 0 失败。
- 修复接线顺序 bug: registerDelegateTools 曾在 board 声明前引用 (TDZ), 已移正。

## 未发布 (2026-10-02g) - 悬空修复闭环 + 军团共享记忆板

> 用户诉求: 修复上轮平台故障冻结的 2 个 P0 + 视觉 E2E; 深度加强多 agent 协作军团模式, 每个 agent 共享记忆。

### 修复 (悬空 P0 清偿)
- **scripts/acceptance.js 记忆断言**: 原断言要求回复含 ok/true, 但成功文案是「好, 记下了: ...」必假失败。
  升级为双重验证: 回复非失败文案 + 记忆库真实检索命中刚写入事实 (落库闭环)。验收 23/23 全绿。
- **scripts/multimodal-smoke.js**: 硬编码本机截图路径 → 仓库内置测试图 (scripts/assets/test-vision.png, node 零依赖生成,
  CRC 校验通过); provider 选择单选硬退 → 候选链降级 (本地 → vision 厂商 → 其余, 探活失败自动切换);
  新增可行动诊断: 区分「模型不支持图像」(exit 2, 给出配置视觉模型的具体指引) 与「视觉识别失败」。
- **config/ppx.json**: volc-coding 的 vision 标记实测修正为 false (方舟 Coding Plan 端点仅编程特化模型, 不含视觉;
  deepseek-v4-flash 收图后报「数据不完整」, /models 列表实锤无视觉模型, 见 docs/MODEL-SETUP.md)。
- 视觉链路验证结论: 图片传输/请求格式/降级链路全部打通 (模型真实收到并尝试解码), 唯一阻塞是 Key 权益, 非代码缺陷。

### 新增 - 军团共享记忆板 (每个 agent 共享记忆)
- **src/memory/legion-board.js LegionBoard**: 跨 agent 实时共享知识层。全局共享目录 (globalDataDir),
  每次读/写走盘 + 文件锁, 锁内「重读→改→写」防陈旧覆盖 (并发模式对齐 Experience)。
  与 FactStore (内存快照, 各 agent 私有) 有意区分: 私有事实不串台, 协作知识走记忆板。
  支持 topic 频道 / tags 标签 / 发布者过滤, 容量 FIFO 裁剪 (maxEntries=500) + TTL 过期 (ttlDays=7)。
- **board_publish / board_query 工具** (toolsPlugin): 所有 agent (主 + worker) 默认可用,
  发布者名取 agent.config.agent.name; worker 经 PPX_AGENT_GLOBAL_DATA_DIR 与主 agent 共享同一板文件, 实时互通。
- 实测: 主 agent 发布 → worker 独立实例立即检索命中, 反向亦通; 4 实例 × 10 并发发布 0 丢失。

### 优化 - dispatch 并行化
- **src/orchestrator/legion.js dispatch**: 串行逐条派发 → 有界并行 (_mapBounded 背压, 与 broadcast/runDag
  共享 maxConcurrent 口), 原「实验性 API/吞吐低」注释移除, 补空军团守卫。

### 验证
- 新增 test/legion-board.test.js 4 项守卫 (跨实例实时可见 / 过滤排序 / 并发不丢 / 容量裁剪)。
- 全量 943 项: 939 通过 + 4 skip (既有网络门控用例, 云环境无外网) + 0 失败。验收 23/23。

## 未发布 (2026-10-01f) - 模型配置主流化 + MCP 统一接口

> 用户诉求: 内置多家模型 API 预设, 只输 Key 即完成配置; 配置流程引导化; 集成接口统一 MCP 协议。

### 新增
- **src/llm/presets.js**: 12+ 主流厂商预设库 (DeepSeek/智谱/通义/Kimi/火山/OpenAI/Anthropic/Gemini/OpenRouter/Groq/硅基流动 + LM Studio/Ollama 本地)。
  全部 OpenAI 兼容协议直连, 预设含 base_url/api_key_env/默认模型/Key 获取地址; buildProvider 生成与 providers 配置完全一致的对象。
- **bin/ppx-setup.js 配置向导** (npm run setup): 选厂商 → 输入 Key (回车=用环境变量) → 自动探活 → 写入 config/ppx.json
  (providers 首位=默认厂商, 同 id 幂等覆盖); 支持 --list / --provider --key --model 非交互模式 (CI 友好); ppx-setup 全局命令。
- **docs/MODEL-SETUP.md**: 厂商预设总表 + 向导用法 + MCP 统一接口声明 + Claude Desktop/Cursor 一段式接入配置。

### 设计
- 接口统一收敛 MCP: 服务端 http://127.0.0.1:8899/mcp (现代流式+legacy 双兼容), tools/list + tools/call 覆盖全部能力,
  客户端宿主 (Claude Desktop/Cursor/Cline) 一段 JSON 即接入; 亦可作 MCP 客户端挂载外部工具。
- Key 优先写配置文件, 留空则回落 api_key_env 环境变量 (不强制落盘密钥)。

### 验证
- 新增 test/model-presets.test.js 3 项守卫 (完备性/buildProvider/幂等合并); 全量 939 项 0 失败。

## 未发布 (2026-10-01e) - Git 集成工具 (GitHub 主流 Agent 对标轮)

> 对标 aider 自动提交 / Claude Code / OpenHands / Cline: 版本控制是编码 Agent 的标配一等工具。
> PPXANS 此前只有通用 run_command, 无结构化输出与防误操作护栏 — 本轮补齐。

### 新增
- **src/tools/git.js** 四工具 (category=vcs):
  - git_status: 分支 + 结构化变更清单 (clean/entries);
  - git_diff: 未提交/已暂存改动, 可限文件, 输出截断 4000 字符;
  - git_log: 最近提交历史 (默认 10, 上限 50, 空仓库返回空数组);
  - git_commit: 唯一写操作 — 仅 add+commit, message ≤500 字符, 无改动时返回可读错误。
- 已接入 plugin/builtin.js 装配链。

### 硬护栏 (设计原则)
- 不提供 git_push / git_reset / rebase / clean / force — 无此工具即无此能力;
- 全部 execFile 参数数组, 不经 shell, 命令注入不可能;
- 非仓库目录返回可读错误, 不抛异常。

### 验证
- 新增 test/git-tools.test.js 6 项守卫 (临时仓库实测提交闭环); 全量 936 项 0 失败, 自愈基准 7/7。

## 未发布 (2026-10-01d) - Skill 发现与路由优化 (《Skill 蓝皮书 2026》/中科大/上交大/微软 AI 课程吸收轮)

> 阅读四篇资料 (ilearnai.online: JasonZhu《Skill 蓝皮书 2026》/ 中科大 ai-agent-book / 上交大 dive-into-llms / 微软 AI for Beginners)
> 后对照项目技能体系的落地优化。核心吸收: 蓝皮书「description 是触发路由的唯一依据, 发现机制是技能生态瓶颈」+
> 中科大「上下文工程/持续进化是一等公民」。

### 新增
- **src/skills/search.js**: 技能发现与路由打分器一等化 — name 命中加权 ×3, description 命中 ×1;
  matchSkill 高置信阈值 (≥2 分且严格高于次高分, 并列=歧义不押注), 替代原"单 bigram 即触发"的低精度路由。
- **skill_search 工具** (selfmod): agent 可按关键词检索技能目录 (排序返回), 三层渐进加载补上"发现"入口。

### 优化
- **SkillLoader 签名缓存**: _scan 改为 mtime+size 签名命中复用, 每条消息的 _context 不再全量重读解析全部 SKILL.md
  (内容修改/条目增删仍即时生效)。
- **技能目录注入加预算** (prompts._skillsPrompt): 常用优先 (usage 降序) + 描述截断 120 字 + top-16 上限,
  其余提示用 skill_search 发现 — 目录层保持轻量, 随技能数增长不再线性膨胀。
- **router 路径补全自进化闭环**: 复用 agent.skills (原每条消息 new loader 全量重扫) + 命中即 trackUse
  (原路由路径绕过使用统计, auto_skill/升级闸门因此少计数)。
- **发布门禁接入 skill-lint** (release.js 步骤 0.5): 元数据质量不达标的技能阻止发布 (评估驱动闭环)。

### 验证
- 新增 test/skills-search.test.js 4 项守卫; 全量 930 项 0 失败, 自愈基准 7/7;
- skill-lint 现状: 3 全过 / 7 告警 / 0 不合格 (门禁可安全接入);
- 真实目录实测: "帮我记住这个偏好"→ppx-memory (3 分) 命中, "做红烧肉" null (噪音不触发)。

## 未发布 (2026-10-01c) - 安装器中文化 + Codex 风格 UI

### 变更
- **安装器全中文界面**: chcp 65001 + UTF-8, 任意系统区域正常显示; 四步中文向导 (解包/安装/快捷方式/卸载器),
  安装完成按任意键自动启动皮皮虾; 失败分支中文提示。PowerShell 命令行内字符串保持 ASCII 防代码页串扰。
- **前端 UI 对齐 OpenAI Codex 观感** (public/app.css token 重构):
  - 暗色为默认主题 (近黑 #0d0d0d 底, 非纯黑), 浅色降为可选;
  - Codex 调色板精修: surface #161615 / border #262625 / codex 橙 #d97757 点睛;
  - 扁平化: 侧栏/抽屉与主区同底色, 靠 1px 边框分层 (去重色填充);
  - 顶栏标题/品牌名/快捷指令/底注等宽字体化 (终端感);
  - 用户消息去气泡化: 改为 Codex 式扁平圆角卡片 (去 accent 底色与不对称圆角);
  - 无障碍补课: 全局 :focus-visible 焦点环 + accent 选区色 + prefers-reduced-motion (修审计 P1 焦点缺失)。
- app.js: 未设置主题偏好时默认 dark。

### 验证
- 全量测试 926 项 0 失败, 自愈基准 7/7;
- 无头浏览器实测: 暗色默认渲染 / 浅色切换 / 对话气泡 / 会话列表 / 未配置模型错误分支均正常;
- 安装包重建自校验通过 (payload SHA-256 回读一致)。

## 未发布 (2026-10-01b) - PC 端打包 + 启动器重构

### 新增
- **scripts/package.js**: 零依赖 PC 端打包 — Windows 便携版 zip (内置 Node 运行时, ~31MB)
  + 单文件自解压安装器 Setup-win64.cmd (~41MB, 系统 PowerShell 解压, 装至 %LOCALAPPDATA%,
  桌面/开始菜单快捷方式 + 卸载器, 不写注册表, 无需管理员)。
  运行时下载带官方 SHA-256 校验, 安装器写入带 payload 回读自校验。
  npm 快捷命令: package / package:portable / package:installer。详见 docs/PACKAGING.md。

### 重构
- 启动器统一「内置运行时优先, 系统兜底」: runtime\node.exe 存在则用之 (便携版/安装包免装 Node), 否则回退系统 node。涉及 启动皮皮虾.bat / 停止皮皮虾.bat。
- 高级菜单.bat 版本号 v2.7.0 -> v3.0.0 (与 package.json 对齐)。
- scripts/release.js 修复: web/ (Next.js 深度定制 UI) 子项目缺失时优雅跳过, 不再必然报错 (GitHub 仓库不含 web/)。

### 验证
- 全量测试 926 项 0 失败; 打包 payload 解包后内核冒烟 (HTTP 200 + /api/bootstrap 正常)。

## 未发布 (2026-10-01) - 跨平台安全不变量 + 工具循环并发化

> 外部实测轮: 全量测试 922 项 (Linux 上 1 失败暴露跨平台安全差异), 修复 + 性能优化, 新增 4 项回归守卫。

### 安全
- **safePath 跨平台盘符拒绝**: Windows 盘符路径 (C:\... / C:/... / D:...) 此前在 POSIX 宿主上会被当作普通相对路径放行
  (可在工作区创建名为 C:\Windows 的怪异文件, 且 Windows 宿主语义与 Linux 宿主不一致)。现统一在 safePath 入口拒绝,
  write_file / apply_patch / read_document / repo_map 等所有路径防护工具共享同一跨平台安全不变量。

### 性能
- **同轮独立工具调用并发执行** (审计 P1 遗留项): LLM 一轮返回 N 个相互独立的 tool_calls 时原先串行排队,
  延迟线性叠加。现默认 Promise.all 并发执行, Promise 保序保证 tool 消息回传顺序与 errors 汇总顺序不变,
  下游 recordTurn 重复检测 / 错误喂回语义不变。配置 agent.parallel_tool_calls=false 可回退串行。

### 测试
- 新增 test/parallel-tools.test.js 4 项: 并发加速 / 回传保序 / 串行回退 / 盘符路径拒绝。

# CHANGELOG

## v3.0.0 (2026-09-18) — codex 对齐整体重构: 九大新层 + codex 风格 Web UI

> **定性**: 以 codex-main 为主骨架参照的整体升级，吸收 claude-code / opencode / aider / OpenHands / open-code-review / claude-agent-sdk / oh-my-hermes 七项目特性。
> 全量回归 **882 项测试全绿**（v2.7.0 基线 787 → 新增 95 项），纯 Node 零运行时依赖不变。

### 新增核心层（src/ 九个模块）
- **protocol/** — codex SQ/EQ 双队列事件流: SubmissionQueue + EventQueue(WAL JSONL) + OpType/EventType 常量 + createProtocolBus
- **session/** — Session→Task→Turn 状态机 (turn.js) + rollout JSONL 持久化/fork/rewind (rollout.js) + 结构化消息部件 (parts.js, opencode 风格)
- **permissions/** — 三合一权限引擎: codex AskForApproval 四档 + SandboxPolicy 三档 + opencode 通配符规则链(last-match-wins) + CASDK canUseTool 回调；支持运行时热更新
- **hooks/** — claude-code 六事件钩子链 (PreToolUse 可否决/改参 / PostToolUse 可附加上下文 / Pre·PostCompact / Session·Start·Stop / SubagentStop)，优先级 + 超时熔断
- **edit/** — aider SEARCH/REPLACE 编辑块 (精确/去空行/模糊三级匹配 + 失败回灌反馈) + Snapshot 编辑快照回滚
- **repomap/** — aider 仓库地图: 正则 def/ref 提取 + 纯 JS PageRank + token 预算渲染，30s 缓存
- **review/** — open-code-review 分级审查流水线: plan→group→review→relocate→filter，P0/P1/P2 报告
- **evidence/** — oh-my-hermes prepared/observed 证据边界 + handoff manifest (SHA-256) + goal board 目标看板 + conformance 校验
- **commands/** — claude-code 斜杠命令统一模型: 13 个内置命令 + `.ppx/commands/*.md` 用户命令

### 集成接线
- agent._runTool 织入: PreToolUse 钩子 → 权限引擎 → (ask 时) 审批等待流 → 执行 → PostToolUse 钩子
- 审批流 (codex approval flow): `_requestApproval`/`resolveApproval`/`pendingApprovals`，超时默认拒绝
- 新工具 4 个: `repo_map` / `apply_patch`(SR 编辑块+失败整体回滚) / `review_code` / `goal_board` (工具总数 43→47)
- v3 插件组 (`plugin/v3.js`): hooks/permissions/commands/evidence/protocol 五插件，可被用户插件替换
- HTTP 端点 6 个: `/api/commands` `/api/approvals/pending` `/api/approvals/:id` `/api/goalboard` `/api/review/latest` `/api/permissions`

### Web UI — codex 风格整体重制 (public/, 零依赖 vanilla)
- 左栏会话/能力 · 中栏**事件时间线**(用户气泡/agent markdown/工具折叠卡/审批卡/计划卡/diff 卡/错误卡) · 右栏**工作区抽屉**(文件树/目标看板/审查报告/设置 四 Tab)
- **斜杠命令面板** (/ 唤起 + ↑↓ 选用)、**审批卡片** (Bash/Edit/Plan 三类模板 + 批准/拒绝)、子 agent 颜色徽标、Esc 中断、主题切换
- check-web.mjs 升级: 括号粗检 → 真语法解析 + v3 结构断言

## 未发布 (2026-09-17) - 全面代码与架构体检轮: 安全 / 可用性 / 无障碍

> **定性**: 一轮**覆盖全项目的代码 + 架构 + 用户体验三维体检**（源码 18,138 行 / 866 文件 / 五路并行模块通读 + 隔离根端到端实证），
> 产出 `docs/AUDIT-2026-09-17.md`（含 4×P0 / 14×P1 / 18×P2 与优化路线图）。
> 本轮落地其中 **4 个 P0 + 8 个 P1/UX** 修复；测试 768 → **780 项（+12 回归守卫）**，0 失败。
> **综合评分 76/100** —— 内核扎实（ANS 六件套全部为真实实现，无桩代码），扣分集中在"产品外壳最后一公里"。

### 安全（P0）

- **任意网站可窃取本机 API token**: `/api/bootstrap` 对"回环请求"免鉴权以支持本地零配置启动，但**浏览器的源地址也是 127.0.0.1** —— 配合默认 `Access-Control-Allow-Origin: *`，用户访问任意恶意网页即可 `fetch('http://127.0.0.1:8899/api/bootstrap')` 读走 `authToken`，此后可调用全部 API（读写文件、执行命令）。**已实证复现**：`curl -H "Origin: https://evil.example.com" …/api/bootstrap` 返回 `200` + `ACAO: *` + 明文 token。处置：新增 `_originTrusted()`（`Origin` 存在时必须为本机回环；`Sec-Fetch-Site: cross-site` 一律拒绝）与 `_isTrustedLocal() = 回环 && 来源可信`，`bootstrapPayload` 与 `/api/bootstrap` 免鉴权分支统一改用后者；响应体新增 `tokenTrusted` 字段便于前端判断。修复后跨源与 cross-site 均返回 `401`，本机访问不受影响。
- **`ppx-channels` 入口 100% 不可用**: `src/channels-cli.js:16` 的 `ensureUTF8Console();` 被误插进第 13 行 `import {` 语句内部，`node bin/ppx-channels.js` 直接 `SyntaxError: Identifier 'ensureUTF8Console' has already been declared`。`package.json` 声明的 5 个 bin 之一彻底失效、通道管理整块功能不可达。已把该调用移到 import 块之后。**用 grep 全库扫描确认无其他同类"调用混入 import"事故。**
- **SSE 并发护栏失效**: `/message/stream` 先 `writeHead(200, SSE头)` 再 `_acquire()`，超限时 `_acquire` 内 `writeHead(429)` 抛 `ERR_HTTP_HEADERS_SENT`，被外层 catch 转成 SSE error 事件。**已实证复现**：占满 4 槽后第 5 个请求收到 `HTTP 200` + `text/event-stream` + 正文 `data: {"type":"error","error":"Cannot write headers after they are sent to the client"}`（**Node 内部错误原文直接泄漏**），前端表现为"空回复 + 永久转圈"而非 429 提示。已把 `_acquire` 提到 `writeHead` 之前，并新增 `publicErrorMessage()` 屏蔽内部实现细节。修复后稳定返回 `429` + `application/json` + `Retry-After: 5`。
- **XSS（渲染层）**: `public/app.js` 的 `renderMd()` 直接 `innerHTML = marked.parse(text)`。实测 marked v12 对原始 HTML **原样透传**（`<img src=x onerror=alert(1)>` 不转义），且**不过滤 `javascript:` / `data:text/html` 链接**。而进入该函数的文本不受控 —— 模型回复、`read_file` 读到的文件、`fetch_page` 抓回的网页、文档解析结果都会流到这里，一旦执行即可读取 `localStorage.ppx_token` 并调用本机 API（与上一条形成叠加风险）。已新增 `sanitizeHtml()` 白名单净化（剔除可执行标签 / 全部 `on*` 事件属性 / `srcdoc` / 危险协议，外链补 `rel=noopener`），净化失败时退回纯文本转义。

### 修复（P1 / 可用性）

- **SSE 首包不 flush**: `writeHead(200)` 后无任何 `res.write` 或 `flushHeaders()`，响应头要等首个 delta 才下发。**已实证**：4 个已获槽位的请求 **6 秒内收不到任何响应头**。LLM 慢首包时前端完全无反馈，且经反向代理极易被判超时。已补 `res.flushHeaders()`；实测响应头 **23ms** 到达。
- **token 比较非恒定时间**: `_authed()` 用 `h === "Bearer " + this.authToken`，首字节不同即提前返回。新增导出函数 `safeEqual()`（两侧先 SHA-256 摘要成定长 32 字节再 `crypto.timingSafeEqual`，长度差异一并消除）替代。
- **无全局异常兜底**: 全项目仅有 SIGINT/SIGTERM 处理，**无 `uncaughtException` / `unhandledRejection`**。Node ≥15 下未处理的 Promise 拒绝直接终止进程 —— 对"双击即用"的桌面产品表现为服务突然消失、用户只看到"未连接"。新增 `src/utils/crashguard.js`：`createCrashReporter()`（栈指纹去重折叠，防日志风暴）+ `installCrashGuard()`（幂等安装，默认**记录后继续运行**；`PPX_EXIT_ON_UNCAUGHT=1` 可恢复"记录即退出"供外部守护托管）。已接入 `bin/ppx-web.js` 与 `src/server.js` 的 `runServer()`。
- **限流令牌桶只增不减**: `_buckets` Map 每个新 IP 建桶且从不回收，长期运行 + 多变源地址会持续吃内存。新增 `_sweepBuckets()`，桶数超 512 时顺手回收 2 倍窗口外的过期桶（摊还 O(1)，不引入定时器）。
- **自愈日志因果颠倒**: `heal()` 原本把"崩溃残留已清理, 状态置回 clean"打在"修复 N 项"与"检测到崩溃残留 -> …"之前，日志读起来是「先说痊愈、再说发现崩溃」，使用者无法判断自愈到底生效没有。已改为 `先判定崩溃 → 先报问题 → 再报处置 → 最后报结果`，并把 `checkCrash()` 提到 `runStartupChecks()` **之前**（否则重建的目录会掩盖证据）。
- **工具卡片同名串卡**: Web UI 只能按"工具名"匹配 start/done 事件，同一轮出现两个 `read_file` 时后到的事件会回填到前一张卡片（旧代码注释里也自述了这个缺陷）。`PPXAgent._runTool()` 现为每次调用生成唯一 `callId`（`t<seq>-<ts36>`）并随 `tool/start`、`tool/done` 事件下发；`src/channels/http.js` 透传 `id`；前端 `addTool`/`finishTool` 改为按 `id` 精确配对（无 `id` 时保留旧的名字回填兜底）。
- **侧栏"收起"按钮是死的（P0/UX）**: HTML 有 `#btnCollapse` / `#btnSide`，CSS 有 `.side.collapsed` 规则，**但 app.js 从未绑定任何事件** —— 点"收起侧栏"毫无反应。已补齐事件绑定 + `localStorage` 持久化 + `aria-expanded` 同步。
- **输入框承诺的 `@ 引用文件` 不存在**: placeholder 写着"（@ 引用文件）"，代码里没有任何 `@` 解析。**没有选择把承诺删掉，而是把它做出来了**：输入 `@` / `@前缀` 弹出工作区文件候选（复用 `/api/workspace/tree`，索引缓存 15s、上限 800 条），支持 ↑↓ 选择、Enter/Tab 插入路径、Esc 取消，并带并发竞态保护（丢弃过期请求结果）。
- **无障碍近乎空白**: `public/index.html` 全文 `aria-` 只出现 1 次（还是 sprite 的 `aria-hidden`）；弹窗无 `role="dialog"` / `aria-modal`、无焦点管理；CSS 只给 `input/select/textarea` 定义了 `:focus`（且 `outline:none`），按钮/导航/标签页**无可见焦点环**。已补：两个弹窗加 `role="dialog" aria-modal="true"` + 标签；对话流加 `role="log" aria-live="polite"`；输入框加 `aria-label`；图标按钮补 `aria-label`/`aria-controls`/`aria-expanded`；新增 `:focus-visible` 焦点环样式；弹窗实现**焦点移入 + Tab 循环陷阱 + 关闭归还焦点**。
- **401 不清 token**: token 轮换后旧值一直卡在 `localStorage` 反复撞 401。`req()` 收到 401 时主动清除并重置内存态。

### 文档

- `docs/AUDIT-2026-09-17.md`（新增）: 结构化体检报告 —— 项目结构与架构 / 核心运行时 / 记忆系统 / ANS 神经系 / 编排与插件 / 接口与安全 / **用户体验专项** / 问题总表（P0·P1·P2）/ 三轮优化路线图。所有 P0 结论均附可复现实证输出，P1/P2 均附 `文件:行号`。
- 更正 `src/channels/http.js` 中"产品壳已全部走 MCP（前端不再调用 REST）"的注释 —— 实测前端仍调用 **16 个 REST 端点**，该注释与实现不符（并因此埋着"一旦把 `legacy_rest` 设为 false，设置页/模型页/抽屉面板/工作区树整体失效"的隐患，已记入报告 P1）。

### 测试

- 新增 `test/audit-2026-09-17.test.js`（**12 项回归守卫**，每项对应一个"修复前会失败"的断言）：跨源 token 三例（含端到端）+ `ppx-channels` 可解析 + SSE 429 与首包时延 + `safeEqual` 语义 + `publicErrorMessage` 净化 + 异常上报器去重与监听真实增删 + 令牌桶回收 + 自愈日志顺序 + 工具事件唯一 id。
- 全量 **780 项通过 (776 pass / 0 fail / 4 skip)**，5.6 秒；`npm run web:check` 全绿。
- **未落地项已在报告中标注并给出设计方案**（不在本轮范围内）：会话状态按 `sessionId` 隔离（`_interrupted`/`_lastFallback` 目前是实例级共享，4 路并发时会串台）、工具在一轮内并行执行、记忆语义检索接线、记忆冲突消解、`legacy_rest=false` 时前端降级、收敛遗留的 `web/`（Next.js）子项目、两套 legion 合一、`spawn_agent` 真并发。


## 未发布 (2026-09-17) - 用户实测轮: 记忆污染 / 自愈目录 / 交互泄漏 / 降级可见性 / 占位符 五修

> **定性**: 一轮"**扮演用户端到端实测** → 逐项修复"的优化。实测覆盖启动、本地意图、真实 LLM 对话、工具循环、跨进程记忆、Web、MCP、安全闸门、自愈，产出 `docs/USER-TEST-REPORT.md`。
> 共发现 2×P1 + 3×P2，**全部修复**；测试 754 → **768 项（+14 回归守卫）**，0 失败；自愈基准 7/7。
> **有意未处理**: DeepSeek 401 —— 发布前主动删除 key 所致，非缺陷。

### 修复

- **P1 记忆污染（用户提问被当长期事实入库，实测污染率 40%）**: `src/memory/fact-store.js` 的 `addMemory()` 里，疑问/指令过滤器写成了 `if (clean.length <= 8 && /…/.test(clean)) return null;` —— **长度前置条件把整条正则架空了**，8 字以上的提问一律畅通。配合"无 LLM 提炼器时整段用户原话直喂 `addMemory()`"的兜底路径（`memory-ticker.js`），提问持续入库并喂回后续上下文。已拆掉长度条件，改为四道与长度无关的句式判据（问号/疑问助词/「来着」收尾 · 疑问词起手 · 句中强制疑问词 · 祈使句起手），并刻意**不收 `多少`** 这类可能出现在陈述句中的词，避免误杀「不管花多少钱都要做」。
- **P1 自愈目录归属错误**: `src/selfheal/healer.js` 把 `dataDir` 硬编码为 `path.join(rootDir, "data")`，而唯一装配点 `src/plugin/builtin.js` 的 `healerPlugin` 传的却是 **`root`**（同文件 `factsPlugin` 等其余插件传的都是 `dataDir`）。后果：自定义 `PPX_DATA_DIR`（npm 安装形态走 `~/.ppx`）时，自愈去 `root/data` 建空目录、写 `integrity.json`、清 `.tmp`，**真实数据目录永不体检**。已给 `Healer` 增加可选 `dataDir` 参数（默认保持旧行为，15 处 `new Healer(root)` 调用点零改动），装配层改传真实目录。
- **P2 本地意图回复泄漏内部标记与原始 JSON**: `src/agent/index.js` 的 `_localIntent()` 四个分支都是 `` return `[工具] ${await this.tools.call(...)}` ``，用户输入「记住: X」会收到 `[工具] {"ok":true,"id":"f_1a2b"}`。已新增 `_humanToolResult()` 做外向化（错误前缀 → 「没办成: …」；JSON → 抽载荷字段；数组 → 逐项罗列），并为各意图配自然话术。**该层只作用于直接回给用户的通道，模型侧工具结果保持原始保真。**
- **P2 静默回退无提示**: 多 provider 回退功能正常（实测救场成功），但只在日志 `warn` 一句，用户端无从感知回答来自备用模型。已让 `_llmWithFallback()` 记录降级事实并广播 `llm/fallback` 总线事件，`chat()` 在**写入会话历史/记忆之后**才把提示拼到回复尾部。**关键约束**：`test/chaos.test.js` 锁死了 `_llmWithFallback` 成功时返回模型原文，故采用"旁路留痕 + 上层拼接"，不改其返回值；`_shortReason()` 把原始错误归一为「鉴权失败 / 限流 / 超时 / 连接失败」，避免整段 JSON 报错体喷给用户；`chatStream()` 写历史前用 `_stripFallbackNotice()` 剥掉提示。
- **P2 占位符模型被选为主模型**: `resolveLLM()` 选出的主模型是配置模板里的 `YOUR_LOCAL_MODEL_NAME`（因 `base_url` 落在 `127.0.0.1` 被 `isLocal()` 判为"零配置可用"）。**根因不是漏了一种写法，而是同一语义有三份正则且各自漂移** —— `src/llm/router.js` / `src/config/index.js` / `src/config/providers.js` 三份都只认 endpoint / api_key 形态，**共同漏掉 `YOUR_*_MODEL`**。已抽出唯一真相源，三处共用；`isUsableProvider` 同时校验 `model` 与 `base_url`；`_warnMissingCloudApi` 原来自行手搓了一套"有本地/有云端 key"判定（既不看占位符也不看 model），现改为复用路由的可用判定，并明确指出哪些条目仍是占位符。

### 新增

- `src/config/placeholder.js`: 占位符判定唯一真相源（`PLACEHOLDER_RE` / `isPlaceholder` / `hasPlaceholderField`），消除三处正则漂移。
- `test/user-test-fixes.test.js`: 14 项回归守卫，按 P1-1 / P1-2 / P2-1 / P2-2 / P2-3 分组，每项锁死一个实测发现。
- `docs/USER-TEST-REPORT.md`: 用户视角实测报告（第一至六章为纯实测记录，第七章为修复记录与前后对比）。

### 测试

- 全量 **768 项通过 (764 pass / 0 fail / 4 skip)**，5.7 秒；自愈基准 **7/7 100%**（确认 `new Healer(root)` 单参路径未被破坏）。
- 端到端验证：自定义 `dataDir` 启动后 `healer.dataDir == agent.dataDir` 且 `root/data` 未被创建；屏蔽真实 key 后 `resolveLLM(真实 config)` 返回 `null`（修复前返回 `lmstudio/YOUR_LOCAL_MODEL_NAME`）；强制主模型"健康通过但调用 401"后回复尾出现可见降级提示并广播事件。
- ⚠ **复现问题请一律用 `npm test`**：诊断时手敲 `node --test test/*.test.js`（缺 `--test-force-exit`）会出现"跑到某个点再也不动"的假死，曾被误判为代码引入挂起。真实原因是遗留句柄的测试进程让父进程一直等待；补上该参数后同一套代码 5.7 秒跑完。


## 未发布 (2026-09-17) - 优化轮 (第 1 轮): 修复 P0 启动崩溃 + 接入熔断器 + 文档校正

> **定性**: 一轮"全量通读 → 逐项修复"的优化。共处理 7 项问题（1×P0 / 3×P1 / 3×P2），测试 745 → **754 项（+9 回归守卫）**，0 失败。新增项目说明文档 `docs/PROJECT-OVERVIEW.md`（v2.7.0 实测基线）。

### 修复

- **P0 内核启动崩溃**: `src/plugin/builtin.js` 的 `sessionPlugin` 调用 `info(...)` 但该文件从未导入 logger。该分支位于 `PPXAgent` **构造函数**的插件装配路径上，一旦触发 `ReferenceError` 会让**整个内核起不来**（Web/CLI/MCP 全线不可用）。触发条件为 `session_max_age_days`（默认 30）生效且存在超龄会话 —— 即**正常使用满 30 天必然踩中**。已补 logger 导入；并用全库静态扫描确认 `info/warn/error/debug/ok/fail` 这一族"用而未导入"已清零。
- **P1 fork 快照静默降级**: `src/memory/fork.js` 调 `personaStore.read()` / `experience.list()`，两者在真实类上都不存在（有 `typeof` 守卫故不崩，但分支永不进入 → `persona.md` / `experience.md` 从未生成）。**根因是测试桩漂移**：`test/fork.test.js` 的手写桩凭空提供了这两个不存在的方法，于是测试一直在验证虚构接口。处置：① `Experience` 补 `list({limit,sort})` / `count()` 公开 API；② fork 改用真实 `userPersona()` + `agentPersona()` 并导出两份画像；③ **测试桩换成真实 `PersonaStore` / `Experience` 实例** + 新增接口同步守卫断言。
- **P1 `unhealthy` 状态不可达**: `src/services/memory-health.js` 的 `status()` 三元两分支都返回 `HEALTHY`，三态退化为两态。改为按窗口内最差单步失败数分档（新增 `unhealthyAfter`，默认取 `degradeAfter` 两倍），`advice()` 增加 `severe` 标记，`status()` 补齐 `unhealthy` / `worstRecentFails` / `thresholds` / `totalFail` 可观测字段。
- **P1 文档数字失真**: README 的「716 测试全绿」（3 处）、「45+ 内置工具」（4 处）、「720 项 716 过」统一校正为实测值。顺带核实「自愈 7/7」属实（`selfheal-bench` 实测 100%），未改动。

### 新增

- **熔断器接线** (`src/bus/circuit-breaker.js` 原为"完整实现但零消费者"的预留件): 接入 `ToolCatalog` 策略订阅者链 —— 每个订阅者持独立熔断器（默认 60s/3 次异常 → 熔断，冷却 10s），熔断期跳过该订阅者（**弃权而非放行**，与 deny-wins 语义自洽），冷却后半开探测、成功即恢复闭合。消除了"故障订阅者被反复调用 + 日志刷屏"的问题。新增 `ToolCatalog.policyStatus()`，并在 `PPXAgent.stats()` 增加 `policyGuard` 字段（只列非闭合项）实现可观测。
- **未接线模块如实标注**: `seam/registry.js` / `memory/failure-episode.js` / `evolve/playbook.js` / `orchestrator/supervisor.js` 文件头加 ⚠ 标注；`plugin/builtin.js` 的 `evolvePlugin` 补全注释 —— **其注册的 6 个服务（playbook/memoryHealth/failures/canvas/fork/assets）当前全部零消费**，属"能力就绪、链路未接"，读到服务不等于功能已生效。
- `docs/PROJECT-OVERVIEW.md`: 项目说明文档（项目概述 / 架构与目录 / 核心模块 / 关键实现逻辑 / 技术栈与配置 / 优化执行记录）。

### 文档

- `docs/ARCHITECTURE-ORGANISM.md`: 修正「client 多后端 http/openclaw/deepseek」为 v2.5.0 后的单 http 底座；文档头加时效说明（本文为 2026-08-21 快照）。
- `docs/ABSORB-DEEPSEEK-HARNESS.md`: 加 🚫 已废弃标注 —— 文中 `npm run dsh:install` / `dsh:build` / `npm run dsh` 等命令**已不存在**，照做必然失败；保留作决策沿革。
- `docs/EVALUATION-v1.1.1-全面评价.md`: 加 📌 历史归档标注（其中规模与能力描述为 v1.1.x 时期实况）。

### 测试

- 新增 9 项回归守卫: `fork.test.js` +1（接口同步 + 快照内容真实性）、`memory-health.test.js` +5（三态可达 / 默认阈值 / 恢复 / severe / 可观测）、`catalog-guard.test.js` +3(熔断达阈值不再被调用 / 熔断不影响其他订阅者 deny / 半开探测恢复)。
- 全量 **754 项通过 (750 pass / 0 fail / 4 skip)**；自愈基准 7/7 100%。

### 有意未处理

- `fact-store._prune()` 超 `max_facts` 的硬删不落审计。当前分工清晰（`_prune` 管容量、治理管意愿），非缺陷；无实际痛点故不动。


## v2.7.0 (2026-09-16) - 记忆存储加固: schema 版本迁移 + WAL 增量落盘

> **定性**: 针对外部体检报告的记忆存储建议，补两块硬能力：数据文件 schema 版本号 + 迁移钩子（版本兼容与迁移），以及 facts 增量落盘（WAL，减少高频写场景的全量写放大）。数据文件（facts.json / scenes.json）保持纯数组格式不变，现有读取者无感。

### 新增: 数据文件 schema 版本 + 迁移钩子
- `src/utils/schema.js`: 版本号写在旁挂 `<file>.schema` 小文件（原子写），数据文件本身保持纯数组，healer / 外部读取者 / 现有测试全部无感
- `registerMigration(name, from, to, fn)` 注册迁移链：不允许跳级、不允许覆盖冲突；无迁移函数时安全跳过（版本标记到目标，数据不动）
- `migrateData()` 启动自动迁移：读当前版本 → 沿链逐级推进 → 原子写回 + 更新版本；迁移中断重跑幂等
- `FactStore` / `SceneStore` 构造时接入：`FACTS_SCHEMA_VERSION` / `SCENES_SCHEMA_VERSION` 常量导出，未来数据结构变更时 +1 并注册迁移

### 新增: facts 增量落盘 (WAL, 可选默认关闭)
- `src/utils/wal.js`: 追加式变更日志——`appendWal`（单行 JSON 原子追加）/ `readWal`（尾部半行崩溃丢弃）/ `truncateWal`
- `FactStore({ wal: true, walThreshold: N })` 开启：变更走追加日志（upsert/remove/replace 事件），达阈值自动 compact 全量写，默认 50 条触发
- 崩溃安全：主文件 = 最后一次 flush 快照，WAL = 快照后增量；启动重放恢复，重放幂等（按 id upsert/remove，重复应用无害）
- 多进程安全：变更与 flush 同用文件锁，flush 时合并磁盘快照 + WAL + 内存（内存优先），防丢其他进程增量事件
- 锁内重读改用 `_reload()`：WAL 模式下磁盘快照 + 重放 WAL 才是完整状态，修复原 add/update 等锁内重读导致的内存回退丢未 flush 变更

### 修复
- `importAll(mode: "replace")`: 旧版只保留 id/content 字段，lastAccess/importance 缺失导致衰减/recency 计算 NaN，检索永远返回空——补全与 merge 分支一致的全部字段
- `_flushLocked()`: 非 WAL 模式直接写内存（内存即真相），避免合并逻辑把磁盘上已删条目合回

### 测试
- `test/schema-migration.test.js` (8 项): 基线兼容 / 版本读写 / 迁移链推进 / 无迁移安全跳过 / 幂等 / 冲突拒绝 / FactStore+SceneStore 文件保持数组格式
- `test/fact-wal.test.js` (9 项): 默认关闭兼容 / 延迟落盘 / 阈值 compact / 崩溃恢复重放 / 半行丢弃 / 重放幂等 / 软删更新重放 / importAll 重放 / 批量一致
- 全量 745 项测试通过 (741 pass / 0 fail / 4 skip)


### Web UI: Codex 桌面版风格界面 (2026-09-16)
- 全局 UI 令牌化重构 (`web/src/app/globals.css`): 全部硬编码色收敛为 `--ppx-*` CSS 变量, Codex 浅色单主题 (白底 + 灰阶, 移除蓝绿品牌色)
- 布局对齐 Codex 桌面版: 左侧导航栏 (新对话/技能请求/已安排/轨迹/插件) + 会话列表 + 底部「开始使用」折叠区块
- 顶部菜单栏真下拉: 文件/编辑/视图/帮助, 菜单项可执行 (新对话/清空输入/复制最后回复/面板显隐/切右侧 tab)
- 中央空态: 「我们要构建什么?」+ 4 张建议卡片, 点击直接发送 (真 Codex 行为)
- 底部输入框前挂「选择会话」下拉 (绑定真实会话切换)
- 全局快捷键: ⌘/Ctrl+N 新建对话 · ⌘/Ctrl+K 聚焦输入框 · ⌘/Ctrl+1-5 切右侧面板 · Esc 关闭全部弹窗
- 新增 modal: 技能请求 (提交走 refineSkill) / 快速开始 / 关于皮皮虾
- settings 5 页硬编码色全部变量化 (一次性脚本 `web/scripts/themeify-settings.ps1`)
- 验证: web tsc 0 错 + next build 8 页预渲染全绿 + dev 冒烟 HTTP 200

## v2.6.0 (2026-09-15) - MCP 服务端 + web 壳全面切 MCP + 任务面板

> **定性**: 皮皮虾从"MCP 客户端"升级为"MCP 客户端 + 服务端"双向。对外全部能力经标准 MCP 协议 (Streamable HTTP, `POST /mcp`) 暴露; web 产品壳全面切换, REST `/api/*` 从产品壳退役 (服务端保留兼容开关)。

### 新增: MCP 服务端 (零依赖, 双 era)
- `src/mcp/server.js`: 核心分发 — 现代 era `2026-07-28` (每请求 `_meta` 版本/身份/能力, 无握手, `server/discover`, 结果带 `resultType`) + legacy era `initialize` 握手兼容 (2025-06-18/2025-03-26/2024-11-05)
- `src/mcp/http.js`: Streamable HTTP 传输 — 单端点 POST, `MCP-Protocol-Version` 头校验 (HeaderMismatch -32020), 通知 202, SSE 流式 (progress 通知, 关流=取消), Origin 防 DNS rebinding, 标准错误码 (-32021/-32022)
- 暴露能力: 43+ 内置工具全量 (tools/list + tools/call, 走统一策略链) / 资源 (memory://facts, traces://recent, stats://overview, sessions://list, sessions://<key>/history) / prompts (humanize/plan/debug/verify/write_article) / 对话工具 (ppx.chat.send / ppx.chat.stream)
- 错误语义: isError 兼容皮皮虾 `[工具错误]` 前缀 + 内部 `{"error":...}` JSON
- 鉴权: 复用 HTTP 通道 Bearer token (自动生成/持久化/显式配置), 401 未授权响应

### 新增: MCP 管理工具 + 任务面板
- `src/mcp/admin.js`: 管理虚拟工具 (不进 catalog 不污染 LLM) — `ppx.sessions.*` (list/history/rename/delete/reset) / `ppx.providers.*` (list/add/update/delete/test/reorder) / `ppx.settings.get/update` / `ppx.task.*` (create/list/update/step/delete/run)
- `src/mcp/tasks.js`: 任务面板存储 — 任务队列 (todo/running/done/failed) + 步骤状态 (pending/running/done/failed, 自动派生任务状态) + 结果回填, 持久化 `data/tasks.json` (原子写)
- **任务模板库**: `TASK_TEMPLATES` 内置 6 套技能模板 (Agent 训练评估 / 会话重命名 / 回答深度提示词 / 代码审查 / MCP 合规 / 技能吸收), `ppx.task.templates` 列出, `ppx.task.create` 支持 `template_id` 一键套用步骤; web 新建任务 modal 加模板下拉
- 修复: 空 root 时 `config/` 目录缺失导致 withFileLock 的 openSync(wx) 抛 ENOENT 被误判为"锁冲突"超时 → 写配置前 ensureDir

### SSE 流式实测
- `test/mcp-stream.test.js`: `ppx.chat.stream` 经 Streamable HTTP 的 SSE 响应流 — progress 通知分段推送长文本 (>4KB 完整) + 最终 JSON-RPC 响应 + 非流式 `ppx.chat.send` 单 JSON 对比
- 结论: MCP 层 SSE 分帧正确 (LLM 逐字流式在 `tools.enabled=false` + `supportsStream` 后端生效; 工具模式走 `_llmWithTools` 一次性返回属预期产品行为)

### x-mcp-header 客户端支持 (MCP 2026-07-28 规范)
- `src/mcp/client.js`: `parseXMcpHeaders` 解析工具 inputSchema 的 x-mcp-header 标注 — 纯 properties 链静态可达 + 仅 primitive (string/integer/boolean, number 禁止) + HTTP token 语法 + 大小写不敏感唯一
- 非法标注工具整体排除 (单个坏工具不影响其他有效工具, 符合规范); 合法标注在 `callToolRaw` 时镜像为 `Mcp-Param-*` HTTP 头 (仅 Streamable HTTP 传输生效)
- 测试: 合法链解析 / number+重复头非法 / items+oneOf 内非法 / HTTP 端到端镜像 / 坏工具排除 (5 项)

### web 前端流式打字机恢复
- `web/src/app/page.tsx` send(): 切 `ppx.chat.stream`, 直读 SSE 流 — progress 通知逐字追加 agent 消息 (打字机效果), message 通知渲染工具卡片 (start/done) + 推理轮次进度, 最终 JSON-RPC 响应兜底
- `src/mcp/http.js`: streamCtx 新增 `onTool`/`onStep` — 结构化事件经 notifications/message (data 为对象, type=tool/step) 透传
- `src/mcp/server.js`: ppx.chat.stream 虚拟工具把 agent 的 onTool/onStep 接上 ctx.stream (替代原先压成字符串的 onMessage)
- 测试: SSE 结构化事件透传 (step×1 + tool start/done×2 + delta×2 + 最终响应)

### 变更: web 产品壳全面切 MCP
- `web/src/lib/mcp.ts` (新增): 浏览器 JSON-RPC over Streamable HTTP 客户端 (mcpCall/mcpTool/mcpResource)
- `web/src/lib/api.ts`: providers/settings 函数签名不变 (settings 页面零改动), 内部改走 MCP 工具; 仅 /health 保留 REST
- `web/src/app/page.tsx`: 会话/场景/记忆/轨迹/统计全部从 REST `/api/*` 切到 MCP 工具/资源; 对话从 `/message/stream` 切到 `ppx.chat.send`; 新增任务面板 tab (任务列表/进度徽章/步骤推进/运行/删除/新建 modal)

### 退役: REST /api/*
- 产品壳不再调用任何 `/api/*` / `/message*` / `/sessions*` REST 端点
- 服务端默认保留兼容 (legacy_rest 缺省=true, 旧脚本/测试不受影响); `channels.http.mcp.legacy_rest=false` 彻底退役 → `/api/*` 与 `/message*` 返回 410 并引导 `/mcp`

### 真机运行发现并修复: CORS 头缺失 (浏览器跨域拦截)
- **问题**: `/mcp` 响应不带 `Access-Control-Allow-Origin` 头 — web 前端 (localhost:3000) 直接 fetch 8899 会跨域被浏览器拦截, 产品壳实际用不了
- **根因**: MCP 路由在 webhook 分发之前提前 return, 没走到原有的 CORS 头设置逻辑
- **修复**: `src/channels/http.js` 把 CORS 响应头 (ACAO/Vary/Allow-Methods/Allow-Headers 含 MCP-Protocol-Version/Mcp-Method/Mcp-Name) 统一前置到 request handler 顶部, 全路由共用; OPTIONS 预检 204; MCP handler 内 Origin 校验改由顶部统一 (skipOriginCheck)
- **验证**: 带 Origin POST 200 + ACAO 头, OPTIONS 204 + Allow-Headers 含 MCP 头; 真机 8/8 全链路通过 (discover/工具/对话/会话/任务/资源/SSE 流式)
- 回归测试: `test/mcp-server.test.js` 新增 CORS 用例 (ACAO 头 + OPTIONS 预检)

### 测试
- 新增: `test/mcp-server.test.js` (21 项: 双 era/工具/资源/提示/错误码/HTTP 端到端/410 开关/CORS) + `test/mcp-admin.test.js` (12 项: 会话/提供方/设置/任务面板/模板) + `test/mcp-stream.test.js` (3 项: SSE 流式/结构化事件) + `test/mcp.test.js` 扩 5 项 (x-mcp-header)
- 全量: **716 pass / 0 fail / 4 skip** (较 v2.5.0 净 +37)

## v2.5.0 (2026-09-15) - 独立底座: 移除全部外部引擎, 只保留自研基座

> **定性**: 皮皮虾不再依赖任何第三方智能体底座 (OpenClaw / DeepSeek Harness)。LLM 直连全部走自研 http 底座 (纯 Node fetch, OpenAI 兼容 API)。

### 移除 (外部引擎底座全删)
- `src/llm/client.js`: 删除 `backend=openclaw` / `backend=deepseek` 两个外部引擎后端分支 (~290 行)，仅保留自研 http 后端 (原生 tool_calls / SSE 流式 / 文本工具调用修复)
- `src/llm/router.js`: 删除 isOpenclaw/isDeepseek/engine 排序，只留 local → cloud
- `src/llm/fence.js`: 删除 buildFencePrompt/proxyToolLoop (围栏代理仅服务外部引擎)，保留自研 parseToolFence/parseToolCalls (文本工具调用修复仍用于本地/DSML 模型)
- `src/config/providers.js`: 白名单去掉 mjs/session_key/dsh_root；validate 显式拒绝非 http 后端
- `config/ppx.json`: 删除 dsh provider (原 default 首位) + `_optional_engines`
- `package.json`: 删除 dsh / dsh:install / dsh:build 三个 npm 脚本
- 删除: `scripts/openclaw-smoke.js`、`test/absorb.deepseek-harness.test.js`、`test/tool-proxy.test.js`

### 修复
- `src/plugin/builtin.js`: 修复 `resolveLLM is not defined` —— 仅 `export {x} from` 不产生本地绑定，导致 llmPlugin 装配失败被隔离、LLM 实际未注入；改为 import + re-export (既存 bug)

### 测试
- 全量: **679 pass / 0 fail / 4 skip** (移除外部引擎专属测试后净 679，较 v2.4.0 的 699 减少 20 项外部引擎相关)
- 自愈基准: **7/7 (100%)**
- 更新: fence/dsml/dsml-prompt/health/multimodal/providers-api/tool-vis/context-eng-optimize (mock 全部改为 http 后端语义)

## v2.4.0 (2026-09-15) - 正式发布: P0-P3 全部落地

> **定性**: v3.0 框架四阶段全部完成, 从 v2.0.0 基线 597 测试增至 699 (+102 全绿)。
> 框架设计见 `docs/ppxans-harness-v3-framework.md` (已标记落地状态)。

### 发布门禁验证
- 全量测试: **699 pass / 0 fail / 6 skip**
- 自愈基准: **7/7 (100%)**
- 审计链校验: **完整 (audit:verify 通过)**
- 本地能力评测: **7/7 (eval)**
- 零运行时依赖: package.json dependencies 仍为空, engines.node >= 20 不变

### v2.4.0 新增 (P3)
- `src/orchestrator/supervisor.js`: supervisor 编排模式 (分解→派发→评审→修正循环, 分歧检测)
- `src/memory/asset-hub.js`: 记忆资产中枢 (登记/软删/装备/可见性/使用计数)

### 里程碑回顾
- v2.1.0 (P0 治理内核): guard 收口 + deny-wins + 事件源 + seam 注册表 + 熔断器 (+32)
- v2.2.0 (P1 进化内核): Playbook + 记忆健康 + 故障记忆 + MCP 命名空间 (+33)
- v2.3.0 (P2 记忆增强): 符号画布 + fork 基线 + 插件两级权限 (+21)
- v2.4.0 (P3 编排资产): supervisor + 记忆资产中枢 (+16)

## v2.3.0-dev (2026-09-15) - P2 记忆画布 + fork 基线 + 插件权限

> **定位**: 框架设计文档 `docs/ppxans-harness-v3-framework.md` 的 P3 阶段落地 —— 最后一个阶段。
> 吸收 LangGraph supervisor 拓扑 + TencentDB-Agent-Memory 记忆资产思想 (仅思想, 无源码复制)。

### P3⑨ supervisor 编排模式
- 新增 `src/orchestrator/supervisor.js`: 监督者分解→派发→收集→评审→修正循环 (构建在现有 Legion 之上)
  - `findDisagreement()`: 词法相似度聚类识别分歧 (中文 bigram, 与 playbook 同策略) + 一致率
  - `buildRevisionPrompt()`: 监督者反馈驱动子 agent 修正
  - `runSupervisor()`: 多轮修正循环 (maxRounds 默认 3), 分歧低于阈值自动打回重派
  - `judgeRound()` / `finalizeRound()`: 监督者 LLM 评审/定稿 (失败降级拼接不阻塞)
  - 与 delegate.js 的 arbitrate (一次性聚合) 互补: 本模块是完整编排循环

### P3⑩ 记忆资产中枢
- 新增 `src/memory/asset-hub.js`: 资产 = 带 scope 的 facts + 元数据登记
  - register / remove(软删) / restore / equip(使用计数) / list / availableFor(可见性过滤)
  - 可见性规范化 (team/private, 大小写兼容); renderAvailable 注入上下文 (空则零 token)
  - 与 ingest_document (文档入库) 衔接: 入库的 scope 可登记为资产

### 装配
- `src/plugin/builtin.js` evolvePlugin: +assets (AssetHub)

### 验证
- 新增 2 个测试文件 16 项: supervisor(8) + asset-hub(8)
- 全量测试: 699 pass / 0 fail / 6 skip (原 683 → 699)
- 修复: 资产可见性 key 大小写映射 (VISIBILITY["team"] 原为 undefined 回退 private); 分歧检测中文 bigram

## v2.3.0-dev (2026-09-15) - P2 记忆画布 + fork 基线 + 插件权限

> **定位**: 框架设计文档 `docs/ppxans-harness-v3-framework.md` 的 P2 阶段落地。
> 吸收 TencentDB-Agent-Memory (符号画布) / HanaAgent (fork baseline + 插件两级权限) 设计思想 (仅思想, 无源码复制)。

### P2⑥ 符号画布记忆 (TencentDB 思想)
- 新增 `src/memory/canvas.js`: 长任务上下文只放轻量 Mermaid 状态图, 细节按 node_id 从事件日志取
  - `buildCanvasFromEvents()`: 从 trace 事件流 (turn/step/tool) 纯代码归纳状态图 (边界/步骤/工具/失败节点)
  - `toMermaid()` 渲染 + `renderCanvasContext()` 注入片段 (只含画布+最近节点, 省 token)
  - `CanvasStore.captureFromEvents()`: 步骤数达标才保存 (默认 8, 防过度设计)

### P2⑦ 会话 fork 基线 (HanaAgent fork baseline 思想)
- 新增 `src/memory/fork.js`: 子代理 spawn 携带记忆快照, 结束按结果 merge/discard
  - `exportMemorySnapshot()`: L1 facts (top N) + L3 persona + 经验精选 → 子 dataDir
  - `mergeSnapshotBack()`: 词法相似度精确去重 (BM25 分数不可靠: 短查询常命中不相关事实) + dryRun 预演
  - `hasSnapshot()` 快照标记

### P2⑧ 插件两级权限 (HanaAgent restricted/full-access 思想)
- `src/plugin/context.js`: `SENSITIVE_SERVICES` (routes/lifecycle/tools/shell/pages/providers/extensions) 仅 full-access 可注册
  - `withAccess()` 返回共享存储的权限包装 (原型继承, restricted 插件服务仍全局可见, 仅敏感 key 被拒)
- `src/plugin/index.js`: `compose()` 按插件声明权限装配 (函数属性/导出对象 access 字段), 违规注册隔离不中断
- `src/agent/index.js`: 顶层 ctx 为 full-access 基座 (内置插件可信), 用户插件默认 restricted
- `src/plugin/builtin.js`: toolsPlugin 标记 full-access (函数外赋值, 修复 compose 调用前读权限的时序 bug)

### 验证
- 新增 3 个测试文件 21 项: canvas(8) + fork(6) + plugin-access(7)
- 全量测试: 683 pass / 0 fail / 6 skip (原 662 → 683)
- 修复: canvas endedAt 无兜底; withAccess 不共享存储致父 consume 失效; fork merge 误判重复

## v2.2.0-dev (2026-09-15) - P1 进化内核: Playbook 引擎 + 记忆健康 + 故障记忆 + MCP 命名空间

> **定位**: 框架设计文档 `docs/ppxans-harness-v3-framework.md` 的 P1 阶段落地。
> 吸收 ACE (ICLR 2026) / HanaAgent / ReLoop / Vial / Hermes 设计思想 (仅思想, 无源码复制)。

### P1④ 语境 Playbook 引擎 (ACE 思想)
- 新增 `src/evolve/playbook.js`: 语境即 Playbook (静态基底 + 动态 bullets)
  - `applyDelta()` 增量合并 (ADD/UPDATE/REMOVE, 非 LLM 确定性应用, 防语境塌缩)
  - `growAndRefine()` 语义去重 (lexicalSimilarity, 中文 CJK bigram 支持) + harmful 裁剪
  - `createGate()` 门禁 commit: 回归基准不过自动回滚不落盘 (model proposes, code guarantees)
  - `renderBullets()` 空时返回空串 (零 token 成本)

### P1⑤ 记忆管线健康监控 (HanaAgent 思想)
- 新增 `src/services/memory-health.js`: healthy/degraded 两态 + 分步失败计数 + 滑动窗口
  - `wrap()` 包装原方法自动统计成败; degraded 时 `advice()` 给"只写不压"降级建议

### P1⑥ 故障记忆 (ReLoop/Vial 思想)
- 新增 `src/memory/failure-episode.js`: 故障即知识
  - 结构化 episode (错误类型/根因/修复/置信度/类别) + 容量保护
  - `search()` 相似故障检索 (同工具强信号 + 错误文本词法相似) + 命中计数 (元学习)

### P1⑦ MCP 命名空间隔离 (防工具名碰撞)
- `src/mcp/index.js`: 强制 `serverName__toolName` 前缀 (serverLabel 取 name>包名>command>url 二级域), 显式 prefix 可覆盖
- `sanitizeMcpDescription` 额外剔除危险 flag (--system/--dangerously 等命令行注入惯用手法)

### 装配
- `src/plugin/builtin.js`: 新增 `evolvePlugin` 提供 playbook / memoryHealth / failures 三服务 (tools 之后, 依赖 dataDir)

### 验证
- 新增 4 个测试文件 33 项: playbook(12) + memory-health(9) + failure-episode(7) + mcp-namespace(6)
- 全量测试: 662 pass / 0 fail / 6 skip (原 629 → 662)

## v2.1.0-dev (2026-09-15) - P0 治理内核: guard 收口 + deny-wins + 熔断器 + seam 注册表

> **定位**: 框架设计文档 `docs/ppxans-harness-v3-framework.md` 的 P0 阶段落地。
> 吸收 Aegis/HookBus/dsh/ACE 的设计思想 (仅思想, 无源码复制, 见 references/THIRD-PARTY-SOURCES.md §5)。

### P0① 免疫闸门接入工具收口 (修 MERGE-REPORT 遗留 P2)
- `src/tools/catalog.js`: 新增 `addPolicySubscriber()` 策略订阅者链 + `consolidateDecisions()` deny-wins 合并 (任一 deny 一票否决, 安全策略不可被低优先级 allow 投票覆盖)
- `src/ans/guard.js`: 新增 `installGuardOnCatalog()` —— 同一闸门状态挂到工具执行唯一收口, 与总线版共享 allowList/计数; `approveGuard` 一次授权同时作用于总线命令 + 工具调用
- `src/agent/index.js`: 装配时接线, guard 从"只盖总线"升级为"盖住所有工具调用"
- 顺带修复 `src/utils/pii.js` 真实漏洞: `inline_secret` 正则漏检 JSON 序列化形式 ("key":"value" 的 key 后闭合引号), 已兼容 key=value / key: value / "key":"value" 三种形式

### P0② 事件源事实 (model-visible = logged)
- `src/utils/trace.js`: 新增 turn/start · turn/end · step/start · step/end 边界事件落盘 (PII 脱敏) + `verifyReplay()` 不变量断言 (配对完整性 / 顺序性 / 重复 round / 坏行定位)

### P0③ seam 注册表骨架
- 新增 `src/seam/registry.js`: 通用能力缝注册表 (define/provide/resolve/require/swap/status), 一行换实现消费方跟着切; 与既有 shell.js / tools/seam.js 互补

### P0④ 订阅者熔断器
- 新增 `src/bus/circuit-breaker.js`: Closed/Open/Half-Open 三态 + 滑动窗口 + fail-open/fail-closed 策略 + wrap 包装器; 基础设施层, 与 agent 探索熔断互补

### 验证
- 新增 4 个测试文件 32 项: catalog-guard(9) + trace-replay(7) + seam-registry(7) + circuit-breaker-util(9)
- 全量测试: 629 pass / 0 fail / 6 skip (原 597 → 629)

## v2.0.1-dev (2026-09-15) - 工程规范 + 上帝文件拆解

> **定性**: v2.0.0 合并后的第一轮工程打磨, 非功能增量。修复真实缺陷 + 拆解上帝文件 + 修正仓库元数据。

### 真实缺陷修复 (bench 压测发现)
- `_llmWithFallback`: `this.allProviders.length` 在 allProviders 未初始化 (stub/轻量实例) 时崩溃, 已加 `|| []` 防御 — 此前压测一直带病运行, 每次辅助调用报错被吞

### 上帝文件拆解 (agent/index.js 892 → 646 行)
- 新增 `src/agent/context.js`: 历史裁剪/token 预算/会话压缩 (`_historyPriority/_trimHistory/_ensureContextFit/_shrinkMessagesForOverflow/_getSession/_pushTurn/_loadHistory/_maybeCompact`)
- 新增 `src/agent/prompts.js`: 技能清单/核心价值/DSML/画像/多模态注入 (`_skillsPrompt/_context/_dsmlPrompt/_valuesPrompt/_l3Context/_visionLLM/_userContent`)
- mixin 方式挂回 prototype, 实例行为完全不变; 测试走 agent._xxx 不感知拆分

### 工程元数据
- package.json: repository 指向 PPXANS-Harness, 补 homepage/bugs
- CHANGELOG: 补 v2.0.0 合并条目 (含 bf72a59 不可达说明)
- README: 修正 .deps 表述为「可选底座, 需手动安装」
- CI: test job 补 selfheal bench + audit chain verify 门禁
- git tag v2.0.0 已打

### 验证
- 全量测试: 597 pass / 0 fail / 6 skip
- eval 7/7 | 自愈基准 7/7 (100%) | audit verify 通过
- 压测: 200 轮 0 失败, 8.3ms/轮 (修复后无报错噪音)

## v2.0.0 (2026-09-15) - 合并版: ppx-agent v1.6.0 + ppx-v2 v0.4.0

> **定性**: 以 `ppx-agent v1.6.0` 为基座, 吸收 `ppx-v2 v0.4.0` 的审计哈希链与记忆治理能力, 合并为统一项目。
> 合并范围与取舍详见 [MERGE-REPORT.md](MERGE-REPORT.md); 第三方来源见 [references/THIRD-PARTY-SOURCES.md](references/THIRD-PARTY-SOURCES.md)。

### 吸收自 ppx-v2 的能力
- **SHA-256 审计哈希链**: 工具调用 append-only 账本 + 链式防篡改, 篡改/删行可定位到具体行, 支持隔离损坏段重建 (`npm run audit:verify`)
- **记忆治理**: 软删可回滚 (forget/restore) + 版本链 (update 留痕) + TTL 自动归档 + 按层清理 + 导出/导入迁移
- **L4 程序性记忆**: 技能/流程记忆层, 衰减率仅为 L1 的 1/4
- **10 个治理运维工具**: memory_forget/restore/export/import/clear_layer/list_deleted、audit_verify、persona_build/read、selfheal_run

### 基座新增 (v1.6.0 至合并前)
- 工具超时预算 (全局默认 30s + Promise.race 双层兑底 + 超时 trace 事件)
- 工具循环策略抽离 `src/core/policy.js` / 事件流 `src/core/trace.js` / 服务化 `src/services/*`
- DeepSeek Harness 底座接入 (dsh 优先, 未安装自动回退 http/cloud)

### 验证
- 全量测试: 597 pass / 0 fail / 6 skip
- 自愈基准: 7/7 (100%)

> ⚠️ 历史说明: 原 ppx-agent / ppx-v2 的独立 git 历史未能保留 (GitHub 旧仓库已重定向合并), 当前仓库仅含 v2.0.0 一个提交。
> CHANGELOG 中 v1.6.0 提到的回滚点 `bf72a59` 在现仓库不可达, 仅作设计记录。

## v1.6.0 (2026-09-14) - FEATURE: 工具超时预算 (首个功能增量, 前三刀 dev 归入此版)

> **定性**: 这是四刀里第一个功能增量, 非等价重构。前三刀 (抽 policy / trace 事件流 / 服务化) 是等价重构归入 v1.6.0-dev;
> 第四刀引入超时后, 之前会永久挂起的工具调用现在会被中断 — **验证标准从「行为等价」切换为「超时行为正确」**。
> 回滚点: 前三刀重构完成状态 = bf72a59 (干净的"三刀重构完成"), 第四刀如需大改可整体回退到该点。

### 超时设计 (最小版本)
- **工具声明 timeoutMs**: 工具级覆盖已存在 (seam.js normalizeMeta, 0=不限时)。本次补全局默认兑底 `agent.tool_timeout_ms = 30000`
  - 优先级: 工具级 timeoutMs > 全局默认; 无声明 + 无默认 = 不限时 (向后兼容)
- **超时触发产生 trace 事件**: `tool/timeout` 带 toolName/elapsedMs/budgetMs/retried/gaveUp/skippedRetry
  - 这是后续熔断/自适应预算 (第五刀) 的数据基础 — 现在开始采集 P50/P95/P99 样本
- **循环决策**: 超时 → 幂等工具重试一次 → 失败返回结构化错误
  - 幂等边界: 非幂等工具超时不重试 (避免副作用二次执行), 事件带 skippedRetry
  - 不做退避/熔断/自适应预算 — 需真实失败数据后 (第五刀) 再设计

### 双层层超时兜底 (测试抓出的真 bug 修复)
- seam.js runWithPolicy 原实现只靠 AbortController signal 中断: **工具不响应 signal 时会永远挂住** (abort 只是设 flag, execute 仍挂, await 永不返回)
- 新增 Promise.race 强制超时返回: 即使工具不响应 signal 也 100ms 内强制返回 (语义超时兑底); 配合 signal 的工具仍能提前释放资源 (资源超时)
- 哨兵 pRun.catch 防输掉方 rejection 导致 unhandledRejection 崩进程
- 验证: 挂起工具 (永不 resolve) 超时测试从"卡死"变为 109ms 强制返回

### 改动
- `src/tools/seam.js`: 全局默认超时 (ctx.timeoutMs) + Promise.race 双层兑底
- `src/tools/catalog.js`: 新增 metaOf(name) 元数据查询 (幂等/预算)
- `src/core/policy.js`: isTimeoutResult + callWithTimeoutRetry (超时重试一次) + runToolLoop 接线 (isIdempotentTool/toolTimeoutOf 注入)
- `src/agent/index.js`: _runTool 传全局默认超时; _toolIdempotent/_toolTimeoutOf 查询
- `src/config/index.js`: DEFAULT_CONFIG agent.tool_timeout_ms=30000 (保守默认, 待数据调优)
- 新增 test/timeout.test.js (6 项) + policy.test.js 加 7 项超时重试用例

### 验证
- 全量测试: 577 pass / 0 fail / 6 skip (566 + 11 新增)
- 自愈基准: 7/7 (100%)
- 超时行为正确: 挂起工具强制返回 / 工具级覆盖优先 / 幂等重试 / 非幂等不重试 / 向后兼容 (无声明不限时)

### 遗留 (第五刀候选, 需真实超时数据支撑)
- 熔断 (连续超时工具降级) / 自适应预算 (按 P95/P99 动态调 timeoutMs) / 退避策略
- 现状: 停在 v1.6.0, 跑一段时间积累超时数据后再决策

## v1.6.0-dev (2026-09-14) - 重构第一刀: 工具循环执行策略抽离 (core/policy.js)

> **起点**: 原 PPXAgent._llmWithTools (1238 行上帝对象的一部分) 集循环驱动/探索熔断/重复检测/溢出降档/错误重试于一身, 策略焊死在内核, 无法独立测试/替换。本刀把执行策略从 agent 抽离为纯逻辑模块。

### 重构
- 新增 `src/core/policy.js` (纯逻辑, 零 agent 引用):
  - 纯函数: `isOverflowError` / `trimToolResult` / `toToolContent` / `LLM_FAILED_HINT` (从 agent 原样迁出)
  - 状态机 `ToolLoopPolicy`: 阈值从 config.agent 读, 状态收敛 (探索连击/重复 sig/错误重试/溢出降档计数)
  - 循环驱动 `runToolLoop`: 依赖全部注入 (llm/tools/runTool/shrinkMessages/histTokenCap/isInterrupted/onStep), 不持有 agent
- `src/agent/index.js`:
  - `_llmWithTools` 瘦身为 12 行依赖注入, 策略全部委托 runToolLoop
  - 删除 6 个常量 + 3 个纯函数定义 (迁至 policy.js)
  - `export { isOverflowError as _isOverflowError, trimToolResult, toToolContent } from "../core/policy.js"` 重新导出, 保持测试/外部兼容
  - 1238 → 1109 行
- `test/config-consistency.test.js`: CONSUMED 活文档 3 个键消费位置更新为 src/core/policy.js
- 新增 `test/policy.test.js` (16 项): runToolLoop 循环驱动 (工具回传/中断/轮次上限/探索熔断/重复检测/溢出降档/错误重试) + ToolLoopPolicy 状态机 + 纯函数

### 验证
- 全量测试: 546 pass / 0 fail / 6 skip (含新增 16 项 policy 回归)
- 自愈基准: 7/7 (100%)
- 行为等价: 抽取前 530 pass / 0 fail → 抽取后 530 + 16 新增全绿

### 说明
- 本刀纯重构, 无功能变更, 不改任何行为与配置键语义
- 后续刀序 (方案): ② 记忆+学习服务化 (MemoryService) → ③ 结构化事件流 traceId → ④ 工具超时预算。

## v1.6.0-dev (2026-09-14) - 重构第三刀: 结构化事件流 traceId 贯穿 (core/trace.js)

> **刀序调整**: 原方案 ②→③ 对调为先 ③→②。理由: 记忆模块此前零可观测性 (src/memory/ 全 9 文件仅 1 个 console.warn), 没有事件流, 第二刀记忆服务化抽取后无法验证"L1 何时升 L2"等行为等价。事件流是记忆服务化的验证基础设施。

### 新增
- `src/core/trace.js`: AsyncLocalStorage (node:async_hooks 原生, 零依赖) 贯穿 traceId + EventTracer 事件流
  - `runWithTrace(fn, meta)`: 入口生成 traceId, 深层异步子调用自动继承, 无需手动传参
  - `EventTracer.event(type, payload, {durationMs, error})`: 写 data/logs/traces/events-YYYY-MM-DD.jsonl, 落盘前 PII 脱敏
  - `EventTracer.span(type, fn)`: 包装子操作自动记录耗时, 失败带 error 并重抛
  - 与 src/utils/trace.js (工具调用轨迹) 互补, 工具轨迹结构不动

### 埋点 (关键路径, 高频工具调用不碰)
- 对话入口: chat()/chatStream() 包 runWithTrace (traceId 生成)
- 记忆升降级: memory/extract (提炼条数) / memory/summarize / memory/query (命中数) / memory/scene_assign / memory/persona (L3 画像) / memory/learn (经验)
- 工具失败路径 (policy.js 增 onEvent 回调): tool/overflow (溢出降档) / tool/explore_break (探索熔断) / tool/repeat_warn (重复) / tool/error_retry (错误重试)
- 学习: learning/refine / learning/refine_skill / learning/upgrade_skill
- Agent spawn: agent/spawn (spawn_agent 工具调用时)

### 安全增强
- `src/utils/pii.js` 补 URL query 敏感参数脱敏规则 (url_secret): `?token=/key=/secret=/sign=` 等参数值落盘前替换为 [REDACTED], 保留参数名不误伤合法 URL 参数
  - 此前 URL query 里的凭证 (最常见的泄漏渠道) 完全未覆盖, traces.record 同样受益

### 验证
- 新增 test/trace.test.js (8 项): traceId 贯穿深层异步 / meta 注入 / 无上下文降级 / PII 脱敏 / span 成败 / runToolLoop onEvent 事件
- 全量测试: 560 pass / 0 fail / 6 skip (552 + 8 新增)
- 真实 smoke: agent chat 事件落盘, 构造期画像 build 事件 traceId=null 为预期 (无对话上下文), 对话内 build 带 traceId (已实证)
- 零功能变更, 配置键语义不变

## v1.6.0-dev (2026-09-14) - 重构第二刀: 记忆+学习服务化 (services/)

> **目标达成**: 依托第三刀事件流验证基础设施, 把散在 PPXAgent 上的记忆升降级 + 自我学习逻辑抽为独立服务。
> 验证策略: 外部调用点 (selfheal/evolve.js, tools/selfmod.js, 全部相关测试) 都走 agent 公共 API,
> agent 保留签名做薄委托, 服务可独立装配 — 行为等价由全量测试锁死。

### 新增
- `src/services/memory-service.js` — 记忆协调服务 (对应方案「升降级协调器」轻量版)
  - extractMemory / summarizeMemory / expandQuery / query (原 agent 四方法)
  - refreshPersona (L3 跨天刷新, 日期标记 _personaBuilt 移入 service)
  - archiveScenes (L2 归档) / learnFromTurn (用户主动经验)
  - **afterTurn() 升降级协调器**: 一轮对话落盘后统一触发 L2 归档 + 经验学习 + L3 画像刷新 (原 chat persist 块三个散调用收敛于此, 可单独调参/替换)
- `src/services/learning-service.js` — 自我学习服务
  - refine (失败→经验) / refineSkill (成功→技能) / upgradeSkill (使用中进化), 验证闸门 (verifyLesson/verifySkill/verifyUpgradeSkill) 原样保留
- 新增 test/services.test.js (6 项): 两个 service 不依赖 agent 直接装配, 无 LLM/轨迹不足降级分支, afterTurn 聚合, refreshPersona 跨天一次, learnFromTurn 指令识别

### 改动
- `src/agent/index.js`: 10 个方法改薄委托 (公共 API 不变, evolve/selfmod/测试零改动), chat persist 块收为 memorySvc.afterTurn, 删除 4 个不再使用的 import
  - 行数: 1238 → 1109 (第一刀) → **955** (第二刀), 两刀合计减 283 行
- 构造器装配: memorySvc/learningSvc 依赖注入 (llm 用 getLlm 闭包 — reloadProviders 会热替换 agent.llm, 固定引用会过期)
- memory.summarizer/setExtractor 注入改指向 service 方法

### 验证
- 全量测试: 566 pass / 0 fail / 6 skip (560 + 6 新增)
- 自愈基准: 7/7 (100%)
- 行为等价: refine/skill-upgrade/audit/memory-extract/query/layers/verify 等直接调 agent 公共 API 的测试全绿
- 零功能变更, 配置键语义不变

## v1.5.2 (2026-09-13) - 修复: src/memory 被 .gitignore 误排除 (仓库完整性)

> **事故**: .gitignore 裸规则 `memory/` 匹配了任意层级的 memory 目录，包括 `src/memory/`，导致整个记忆子系统 9 个文件从 git 仓库静默消失（npm 包仍含源码，但 clone 仓库后代码无法运行，536 测试全挂）。

### 修复
- .gitignore: `memory/ experience/ sessions/ logs/` → 精确 `/data/*` 前缀（运行数据实际都在 data/ 下）
- 从 git 历史恢复 `src/memory/*` 9 文件（与 npm v1.5.1 载荷逐字节一致）
- 测试: `.deps` 内嵌 dsh 为可选底座（README 声明未安装自动回退 http/cloud），缺失时 skip 而非 fail

### 验证
- 全量测试: 530 pass / 0 fail / 6 skip (4 网络 + 2 dsh 可选)
- 自愈基准: 7/7 (100%)
- 已推送 GitHub main (b422201)，远程 `src/memory` 9 文件确认在库

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


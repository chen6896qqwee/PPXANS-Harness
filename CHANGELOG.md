## 5.3.0 (2026-11-18) · 对话体验轮 + 外观/身份系统轮 + 覆盖率补全轮 + 世界模型轮

### 对话体验吸收 (2026-11-18, WorkBuddy 式思考链路收拢 + 个性化面板 + 对话流基础配置)

- **思考链路回合收拢 (ThoughtChain)**: Timeline 渲染层把连续 think/tool 条目归组为新 chain 节点
  (`useTimeline.viewItems`), 组头一行 = 状态点 + 「思考与执行」+ 步数/工具数 + 时长。简洁模式 (默认):
  正文开始输出即整组收拢成一行「思考了 Xs · N 步」(不跟回答抢注意力), 点开随时回看; 等待审批/提问
  时不收拢 (需要看到正在跑什么才能做决定); 详细模式全平铺如旧, 组头仍可手动收拢。数据模型不变
  (chat.items 仍是扁平数组, 组是渲染期派生), Ctrl+O 全展开联动组开关。验证: 离线合成回合截图
  `docs/bench/ui/workbuddy-02/03-*.png`。
- **个性化面板** (本体设置 → 个性化): **对你的称呼** (`config.user.name`, 走 PUT /api/settings +
  reloadSettings 热重载, 下轮生效) / **回复风格** (新 `config.agent.reply_style`: 白名单 + 非字符串/超
  2000 字拒绝 + prompts.js 在 persona 后注入【回复风格】静态段, 不在裁剪表永不裁, 前缀缓存契约不破) /
  **给助手的指令** (`agent.system_extra` 首次接进 UI) / **人设设定** (`config/identity.md` + `ishiki.md`
  经 `bot.manage personaWrite` 写盘 + `persona.reload()` 热重载, 文件名固定白名单) / **预览系统提示词**
  (`GET /api/persona.preview` 调真实 `_context` 返回最终 system 文本; 快照/恢复 `_lastContextStats`,
  预览不留痕)。测试 `test/persona-panel.test.js` 5 项 (白名单校验/注入与静态位/未设置零 token/
  personaWrite 落盘+热重载/preview 真实组装+无副作用)。
- **对话流基础配置** (设置 → 对话, `stores/dialog.js` localStorage 本机持久化): **欢迎语** (开关+文案,
  空会话首屏 Hero 卡显示) / **显示文件修改过程** (关 = diff 卡折叠成「+x / -y」摘要行, 点开可看) /
  **队列发送方式** (排队 = 原行为; 新增**立即打断** = 中断当前回合, 流收口后由 finally 优先发送,
  不进排队队列) / **过程展示** (简洁·自动收拢 | 详细·平铺) / **回合完成提示音** (WebAudio 双音上行 /
  失败下行三音, 零音频资源; 长回合结束且窗口在后台时与系统通知同触发, 通知改 silent 防双响)。
  面板映射修复: `ui.settingsModal="dialog"` 打开时不再落到通用设置。
- **UI 截图回环固化**: 新增 `PPX_UI_CAPTURE=1` 模式 (`electron/ui-capture.js` 逐帧 executeJavaScript
  注入 + capturePage, `scripts/ui-capture.mjs` 隔离驱动 + 归档), webapp 暴露 `window.__ppx =
  { chat, dialog, ui }` 截图契约 (window.PPXMarkdown 同款, 只读引用); 6 帧验收截图归档
  `docs/bench/ui/workbuddy-*.png` (离线合成数据, 非生产回合)。
- **顺手修复**: `test/web-api-routes-2026-11-17.test.js` usage 夹具日期敏感缺陷 (账本日硬编码
  2026-11-17, 会话时间戳用 now, 跨天后 streak.current 断言必挂) — 账本日改 `logicalDay()` 参数化。
- **验证**: 全量 **2206 项 (2202 通过 / 4 跳过 / 0 失败)**; `npm run verify` **17/17** (顺手修掉
  ui-capture 一处关键路径静默 catch → swallowed-ok 留痕); `npm run web:build` + `web:check` 全绿
  (主包 197kB ≤250kB); eslint 干净。

### 覆盖率补齐 II (2026-11-17: 通道执行路径 / Web 管理 API 集成 / REPL 进程内测试)

- **通道执行路径**: `src/channels/base.js` 22%→99.7%; 29 个分支测试用 stub agent
  (chat/chatAsync/threadForward/threadRoute/llm) + 真 workgraph 账本 (临时目录) 走完
  handleTrigger 全部六种计划 (DROP/REPLAY/DUPLICATE/THREAD/ASYNC/SYNC), 覆盖需求提炼前缀
  注入、元认知三规则 (低置信回执+工单双路透传 / 同 dedupeKey 重复低置信 escalated /
  reroute_enabled 真改道 clarify 及其发送失败落账上抛)、delivery 队列 enqueue 与
  直发/回执链回投三路、账本故障吞错不阻断、THREAD 信封带 ticketId/assignmentId 与
  onExecuted 收口/兜底、_deliverAsync/_receipts/_syncDeadlineMs/_registrar/兼容壳。
- **Web 管理 API**: `src/web` 四域真实 HTTP 集成测试 (真 http.createServer + fetch 客户端,
  channel stub 只实现 _json/_readBody/_requireAuth 最小接口, 落盘全在临时目录):
  `usage-stats.js` 13%→97.6% (聚合账本/未定价单列/延迟分桶近似/连续天数两天不锚定/
  超 16MB 会话头尾切片中段不计入/账本抛错 500 兜底); `skills-api.js` 23%→100% (停用启停
  落盘 config/ppx.json + reloadSettings 契约/未知 id 404/缺加载器 409); `mcp-api.js`
  19%→100% (增删改查全流程落盘 + 热重连/校验矩阵逐条拒绝/index 定位更新合并原值/
  密钥只回 set 标志); `plugin-api.js` 16%→93.6% (创建缺省模板/详情/更新/删除回收站/
  散文件插件只读/坏清单报错/语法与 id 校验/非法 access 400)。
- **REPL 拆分**: `src/cli.js` 顶层内联的 REPL 主循环提取为 `src/cli-repl.js`
  `createRepl(agent, opts)` (input/output/onExit/version/updateCheck 可注入), cli.js 只留
  argv 闸门与一次性装配, 生产行为逐字不变 (输出走 output.write, 退出经 onExit)。11 个
  进程内测试 (PassThrough 流 + stub agent) 覆盖 busy 忽略与 busy 中 /stop 仍可用、
  quit/exit/q 三态退出、/stop /reset /proactive (有待办/无待办) /proactive-done 本地命令、
  registry 斜杠命令直通 chat、chat 抛错不断 REPL、SIGINT 两击退出、主动提醒 ticker 注册。
- **验证**: 全量 **2201 项 (2197 通过 / 4 跳过 / 0 失败)**; src 行覆盖 **85.70%**
  (coverage gate 82 通过); `npm run verify` **17/17**; eslint 干净。剩余低覆盖块:
  pwf.js 52% / advanced.js 51% / update.js 59% / importer.js 65% / browse.js 25%。

### 前端外观系统 (2026-11-16, 吸收 Tobs/DeepSeekBot 设计)

- **5 套配色 + 5 种壁纸 + 面板材质**: 珊瑚默认 / 雾蓝 / 雾紫 / 森林 / 琥珀; 极光 / 薄雾 / 网格 /
  暮色 纯 CSS 壁纸 (零外部图片); 实色 / 通透 (透明度 + backdrop blur) 两档面板。设计参考
  Tobs (BotHarness/DeepSeekBot, MIT) 的预设主色与"壁纸降低面板不透明度"分层, 实现为本仓自研
  CSS 变量, 未复制源码。
- **首屏与运行时同源**: `webapp/public/theme.js` 在首次绘制前写 `data-palette` /
  `data-wallpaper` / `data-material` / `--wallpaper-opacity`; `stores/appearance-data.js`
  是设置面板/首屏/测试共用的 ID 白名单与校验; 坏 JSON/未知 ID 全量回落默认。
- **入口与持久化**: 设置 → 外观、侧栏底部「外观」、顶栏主题按钮三处入口; 只写本机
  `localStorage` (`ppx_appearance_v1`), 不影响其他端。
- **验证**: 全量 **2036 项 (2032 通过 / 4 跳过 / 0 失败)**; `npm run verify` **17/17**;
  `npm run web:build` + `web:check` 全绿 (主包 181kB ≤250kB); Electron 真实窗口截图
  (默认深色珊瑚 / 雾蓝极光通透 / 亮色暮色 / 主界面壁纸) 归档 `docs/bench/ui/*.png`。

### 像素身份系统 (2026-11-16, 吸收 Tobs 设计)

- **名字即身份**: `webapp/src/stores/pixel-avatar.js` 用 FNV-1a + mulberry32 生成左右对称
  8×8 网格, 眼睛/嘴/触角固定, 8 套独立调色板 (默认"皮皮虾"用品牌珊瑚)。同名确定性, 改名换脸。
- **展示**: 对话头部 32px; 本体设置 54px 身份卡 + 28px 页头; 流式生成时头像内圈轻脉冲。
- **安全**: 只输出自研 SVG, 名字只参与哈希, 不进入 SVG; 6 个纯函数测试钉住确定/对称/眼嘴/
  调色板/尺寸/SVG 纯净。
- **验证**: 全量 **2042 项 (2038 通过 / 4 跳过 / 0 失败)**; `npm run verify` **17/17**;
  `npm run web:build` + `web:check` 全绿 (主包 184kB ≤250kB); Electron 真实窗口截图
  (主界面头像 / 皮皮虾身份卡 / 改名 Mira 换脸) 归档 `docs/bench/ui/identity-*.png`。

### 覆盖率补齐 (2026-11-16/17: 世界模型 / 技能导入 / 自改代码图谱 / 通道簇 / 配置与 stdio)

- **世界模型**: `src/worldmodel/index.js` 22.9%→99.3%, `server.js` 16.8%→100%; 新增 23 个
  行为测试 (shell 效果解析 10 + 引擎/HTTP 13), 覆盖路径逃逸、父目录缺失、非空目录递归、
  exec 超出模拟域、快照淘汰、journal/replay、diff 与全部 HTTP op。
- **技能导入**: `src/tools/skill-hub.js` 60%→88%; 覆盖覆盖率自述/域目录/无写目录/未知源/
  坏仓库/非 GitHub 主机的拒绝路径 (真实 GitHub 导入仍不联网测)。
- **自改代码图谱**: `src/selfcode/graph.js` 55.7%→99.3%; 临时仓库覆盖四种 import 解析、
  入口发现、断链、环、unreachable/reserved/unwired、impactOf 与 summarizeGraph。
- **通道簇**: `ans-lane.js` 21.1%→92.2%, `telegram.js` 27%→100%, `output.js` 53%→100%,
  `receipts.js` 58%→100%, `workspace.js` 60%→100%; 33 个行为测试覆盖 IM 降噪、回执双身份、
  sendSync 超时契约、工作区越界/引用上限/搜索、Telegram 分段/游标/白名单、ANS 车道的
  去重三策略/限流/加严黑名单安装还原/失败回投与 async/sync/直发三条路径 (fetch 桩, 零真实网络)。
- **配置加载 + stdio 宿主**: `config/index.js` 85.1%→96.7%, `mcp-stdio.js` 73.6%→87.2%;
  YAML 子集解析 (嵌套/数组项/标量/注释)、环境变量覆盖、validateConfig 各告警分支;
  progressToken 流式 ctx 构造、通知报错静默、未知工具错误响应 (进程内注入流, 无 spawn)。
- **修缺陷 ×2**: ① `truncate -s 0 <path>` 的 `0` 被当路径导致文档形态被拒, 已修正参数解析;
  ② parseYaml 数组项分支是死代码 (arrKey 恒 null) —— `providers:` + `- id:` 列表被静默
  丢弃, 首版修复又产生 providers.providers 双层嵌套; 终版以帧记 {obj, key, parent} 把
  "空值键的宿主上的键"转成真数组。
- **验证**: 全量 **2113 项 (2109 通过 / 4 跳过 / 0 失败)**; src 行覆盖 **82.41%**,
  `coverage:gate` 阈值 82 并通过; `npm run verify` 17/17。

### 质量基线与契约补全批 (2026-11-16: 回归网恢复 + 三个半接回路 + 声称可核验)

先回答"优化有没有回归网": 没有 —— 源码树里 `test/` 与 `npm test` 都不存在, 文档却还在引用
2626/2867 项测试。本轮先恢复可验证性, 再修它暴露出的真问题:

- **回归网**: 从 git 历史取回 265 个测试文件。首跑 1646 项 / 95 失败, 分诊为: 36 个文件是
  2026-11-12 模块收敛后的旧 import 路径 (机械重映射) / 12 项是契约已变更 (core 曝光默认、
  五档审批、LaneMerger 合并、pageSize) / 15 个文件测的是已按死代码移除的模块 (canvas/assets/
  memoryHealth/supervisor/triage/rollout/aml-server/sqlite 记忆后端, 退役) / 4 项真缺陷。
  终态 **253 文件 / 1957 项 / 1953 通过 / 4 跳过 / 0 失败**; `npm test` 脚本补回。
- **真缺陷**: ① 事实库墓碑在 purgeGraceDays 内无界增长 (600 次 add+forget 后 600 行) —— 容量
  上界恢复为硬约束, 宽限期只管年龄回收; ② 技能包副本缺 `retire/restore` 与退休过滤 —— 已同步,
  漂移守卫改按模块族检查; ③ MCP 工具 129 > pageSize 128 把 `ppx.chat.*` 挤到第二页 —— 默认
  pageSize 上调 256; ④ `contextBudget()` 与历史裁剪不同源 —— 固定开销统一为
  `_fixedContextTokens()`。
- **上下文配额落地 (架构优化 ④ 消费侧)**: `_historyBudget()` 成为 `_trimHistory` /
  `_ensureContextFit` / `_maybeCompact` 的唯一预算入口 —— legacy 放得下时行为不变, 放不下时
  收到 `窗口 − output − tools − system − 记忆预留`。`memory.adaptive_budget=false` 回退。
- **记忆召回落地 (③ 消费侧)**: `memory_search({multi_source:true})` 走统一 RRF 契约,
  事实/经验/场景/画像四源融合、每条带来源标注; 默认单源路径逐字节不变, 单源故障只降级该源。
- **Run 血缘落地 (② 未做项)**: 工单记录 `runId`, 指派继承/可覆盖, 事件 payload 带血缘;
  旧账本无该字段按 null 读取。依赖边 +1 (workgraph → core/run-context, 向下)。
- **声称可核验**: 新增 `scripts/readme-sync-check.js` (README 引用了它但脚本不存在) ——
  tools/skills/core_schema/ctx_tokens/mcp_tools/test_files 实测对齐, tests 计数走
  `--with-tests` 缓存; 已进 `npm run verify` (17/17)。同步 README 111→127 工具、2867→1957 项、
  376→253 文件; 删掉 package 描述里的"符号画布"(模块已移除)。
- 论证与未做清单: `docs/ARCHITECTURE-OPTIMIZATION-2026-11-16.md`。

### 溢出恢复补全批 (2026-11-16: generation 证明, 借 DSH)

- **无进展不重试**: `runToolLoop` 溢出降档后比较消息列表, 没变化直接抛原提供方错误,
  不再空烧降档次数; 有真实裁剪才重试 (DSH replaceGeneration 语义)。新增
  `tool/overflow-no-progress` 事件。
- **预算同源**: 溢出重试的 `histTokenCap` 注入改走 `_historyBudget()`, 与历史裁剪同一口径。
- 旧测试的 `m => m` 假裁剪全部改为真实输入; 单条 user 输入无历史可裁时一次请求后抛原错误。
- 测试: `overflow-generation-guard-2026-11-16` 2 例; 全量 1964 项 0 失败。

### 隔离执行补全批 (2026-11-16: 子 agent worktree + 迟到消息 EPIPE 修复)

- **子 agent 隔离执行**: `spawn_agent({isolation:"worktree"})` 每个子任务从 HEAD 建独立
  worktree, worker 以其为 cwd; 回执附变更统计与补丁路径 (`git apply --3way` 显式合入),
  成功/失败/异常都清理目录。非 git 仓库给可行动错误, 不静默退回共享目录。
- **可靠性**: Legion 支持 cwd 传入 (指定隔离目录时不接管热池); `send` 在进程已死/stdin 已关
  时先行拒绝, 修掉迟到消息写 EPIPE 的宿主崩溃风险。try 内 const 不可用于 finally 的清理
  作用域已修正。
- 测试: `worktree-isolation-2026-11-16` 5 例 (真 git 建收删 / 非 git 报错 / cwd 传递 /
  回执与清理 / 不降级)。

### 认知闭环接通批 (2026-11-16: 测量→反馈、观测→行为、模拟域扩容)

病根不是"缺认知模块", 而是**五个模块都停在了"就绪但半接"**: 能力造出来了, 回路差最后
1mm 没闭。本轮不加第六个模块, 只把已有的四条回路各接通一毫米。

- **效果反哺 Phase 3.6 (`evolve/loop.js`)**: `effect.js` 的注释自己写着"只记账不改行为" ——
  系统能测出某条策略没用, 却照旧按它跑, 这是"持续学习"名不副实的最典型形态。新增
  `feedbackFromEffect`: mature 且 `delta ≤ -degrade_threshold` 的 cohort 给关联 bullet 记
  harmful 票, 达 `prune_at` 由既有 `growAndRefine` 淘汰。**动作只有一种语义**(记票, 不直接
  REMOVE), 三重门槛防误杀 (mature + delta 阈值 + 未反哺过), 幂等靠 `cohort.fedBackAt` 与
  `EffectTracker.isFedBack` 双闸 (调用方拿旧测量快照来调也不会重复动手), 单轮限
  `max_actions`。默认关闭 (`evolution_loop.effect_feedback.enabled`) —— 会真改 prompt 内容的事,
  先看清测量质量再开。
  配套: `effect.js` 的 measure 行补 `cohortKey`/`fedBackAt`, 新增 `markFedBack`/`isFedBack`。
- **低置信真改道 (`flow/gate.js` + `channels/base.js` + `workgraph/`)**: gate 原来只有
  "双路透传"和"重复低置信升级"两条规则 —— 观测得再准也不改变行为。新增纯函数
  `decideReroute` (不调 LLM、不写状态) 作决策位: 显式开启 `reroute_enabled` 且置信低于阈值
  且模型建议 `clarify` 时**不进入执行**, 用模型自己给的理由向来源方提问。工单标 `rerouted`,
  `judgeTicket` 把 `done ∧ delivered` 降级为 `MANUAL_REVIEW` —— **改道不算完成**, 否则"没干活"
  会混进完成率。三重门槛 (配置开启 / 必须 clarify / 重算置信) 都在纯函数里, 可单测。
- **世界模型 exec 预演域 (`worldmodel/index.js`)**: v1 只覆盖文件动作, `exec` 显式
  `simulated:false` —— 等于所有命令类不可逆动作仍在 token 序列上裸奔。新增
  `parseShellEffects` 保守解析器: 支持 rm/mv/cp/mkdir/touch/truncate/dd/cd 的简单命令,
  含通配符/变量/管道/子 shell/后台符的**一律 parseable:false**。诚实边界写在代码头注里 ——
  半模拟比不模拟更危险。`rm -rf` 现在能在执行前看清会删掉什么, 且可 snapshot 回滚。
  修掉的自身 bug: 第一版在原始命令上扫 `&`, 把每条 `cd x && rm y` 都误杀 —— 危险字符检查
  必须在 splitSegments 之后 (段内残留才是后台/管道)。
- **可观测面**: `evolution_status` 新增「效果对照与反哺」段 (cohort 基线→对照→delta、
  immature 标注、反哺开关、上轮动作与淘汰清单); `ARCHITECTURE-CURRENT.md` §4 补
  `worldmodel/` 行、§6 补 Phase 3.5/3.6 与"为什么必须成对"; `CONFIG.md` 补
  `metacognition_gate` 三键与 `effect_feedback` 五键。
- **注释校准 (防止下次审计被骗)**: `playbook.js` 的"引擎就绪、链路未接"写于 2026-09-17,
  实际 `prompts.js:221` 早已注入 delta 也已接通 —— 改为逐条列出注入/delta/反哺三个接线点
  及日期; `effect.js` 的"只记账不改行为"改注"反哺在 loop Phase 3.6"; `gate.js` 的
  "绝不自行改道"改注"不自行改道, 但导出 decideReroute 作消费方决策位"。
- **门禁**: 修掉 `evolve/finetune-bridge.js#_anchor` 的关键路径空 catch (silent-catch-guard
  strict 的唯一 FAIL), 改为 `noteCatch` 留痕。
  验证: `npm run verify` 16/16 全绿 (含 arch-guard/native-guard/审计链/离线基准/记忆召回/
  静默 catch/文案词典), silent-catch-guard PASS; 独立验证脚本 37 项断言全过 (命令解析
  正负例、exec 真推演与快照回滚、改道三重门槛、judge 降级、反哺动作与幂等、默认关闭零副作用)。

## 5.2.0 (2026-11-15) · 个人最强补全轮 + 评测修复轮 + 架构精简轮 + 自带模型体验轮 + 多步基准轮 + 双轨收敛轮

### 个人最强补全批 (2026-11-14: 渠道×沙箱×语音×外部基准)

补全个人最强 agent 的四块结构性缺口 (此前盘点: 强隔离只覆盖 run_command / ASR 只通云端 / 渠道缺 Telegram / 基准全是自建):

- **Telegram 渠道 (long polling)**: `src/channels/telegram.js` —— getUpdates 长轮询 (不需要公网 webhook,
  凭据只要 botToken), `triggerFromTelegramEvent` 归一 (群聊/论坛话题/回复串 → 四段式会话键), 整条
  两级准入/工单去重/REPLAY/THREAD/异步回投/WAL 与渠道无关**免费继承**; 4096 字硬限按换行分块;
  `allowed_chats` 渠道级首道白名单; 失败退避复用 delivery 退避公式; 诚实边界: allowed_updates 只订阅
  message (edited_message 不重触发), 媒体消息只取 caption。注册: BUILTIN_CHANNEL_TYPES + CHANNEL_SCHEMAS
  (botToken secret) + IM_CHANNELS + SURFACES + DEFAULT_CONFIG + example。CLI/Web 设置页随 schema 自动出现。
  钉子: `telegram-channel.test.js` 11 例 (全离线 mock fetch: Trigger 映射/会话键/游标推进/白名单/分块/断连);
  快照更新 `channels-config.test.js` (+telegram 默认禁用 + secret 不回明文)。
- **code_act 容器沙箱打通**: `runCodeAct` 接入 shell seam —— `shell_provider="docker"` 时临时脚本落
  workspace 挂载内 (`<root>/.ppx/tmp/`, os.tmpdir() 容器看不到) 并经容器执行, 回执注明
  `[execEnv: docker 容器沙箱]`; 删除"docker 只覆盖 run_command"的旧边界提示 (已不成立); 本地模式
  (进程级约束) 行为不变。钉子: `codeact.test.js` +4 例 (挂载落点/容器命令形态/失败超时编码/执行中脚本可见)。
- **ASR 本地 whisper 兜底**: `voice_transcribe` 的本地分支从"诚实报错空桩"变真实现 —— `voice.asr.bin`
  (openai-whisper 的 `whisper` / whisper.cpp 的 `whisper-cli`) + `flavor: cli|whispercpp` +
  `model_path`/`timeout_ms`; 二进制缺失 ENOENT 转译为配置指引, 不编结果。新增统一入口 `transcribeAudio`
  (工具与 Web `/api/voice/transcribe` 同一实现, 消除两处漂移) + 可选 `voice.asr_fallback` 兜底块
  (主路失败自动切换, 回执 `engine` 注明 `(fallback)`; 单块内云/本互斥语义不变); uploads 回显补音频 mime
  (wav/mp3/m4a/ogg/flac); settings 白名单补本地字段 + local 后端判空条件修正。
  钉子: `voice.test.js` +5 例 (两种 flavor 参数拼装/诚实报错/兜底顺序/云成功不触本地)。
- **外部基准适配器 external-bench**: `scripts/external-bench.js` —— GAIA 文本题风格 JSONL
  (question/answer/eval_type: exact_match|contains|numeric + files 落沙箱), FINAL ANSWER 协议注入,
  判分器纯函数可证伪 (**离线负对照: 错答案必须判红, 实测抓掉 contains 子串假阳性与次数乘数两个 bug**);
  `--offline` 管线自检 (脚本模型 + 负对照, 零 LLM 零网络) / 默认真 LLM 模式 (复用 taskbench runOne);
  数据集由使用者提供 (GAIA gated 下载不进仓库, `bench/external/sample.jsonl` 为合成样本),
  转换方法见 `docs/EXTERNAL-BENCH.md`。npm script: `bench:external`。
  钉子: `external-bench.test.js` 9 例。
- **门禁同步**: config-consistency CONSUMED 登记 telegram 6 键; claim-gate 登记 4 条新宣称;
  `config/ppx.json.example` 补 voice/telegram 块; `docs/CONFIG.md` (docker 边界新说法 + voice.asr 表
  + telegram 行) + `docs/EXTERNAL-BENCH.md` (索引已登记); README 核心特性表 +3 行。

### 评测修复批 III (二次评测 2026-11-14: 账本可追责 + 硬拒绝语义闸门 + 观测补全)

二次评测 (审计链 402→412 独立校验 + 217 条带结果体轨迹 + 5 份会话正文) 复核批 II 修复落地后, 对残留洞逐个闭环:

- **审计死信通道 (评测-II P1-1a)**: `AuditLog.append` 写失败只 `writeFailures++` + warn ——
  断档那条的正文无任何持久落点 (计数重启归零)。新增 `<dataDir>/logs/audit.dead.jsonl`
  死信 (封顶 50 条丢最旧, 模式同 channels/delivery), `health()` 暴露 `deadLetters`。
  钉子: `audit-dead-letter.test.js` 4 例 (死信落盘/封顶/健康路径/审计干净)。
- **提权 audit=null 静默洞 (评测-II P1-1b)**: `config.audit.enabled=false` 时 consume 返回
  null, recordEscalation 的双重可选链 (`agent?.audit?.appendEvent?.()`) 无声跳过审计通道 ——
  提权这一安全决策点的留痕消失得无影无踪。改显式分支: 通道缺失 / appendEvent 返回空都
  noteCatch 留痕; 两个 HTTP 入口 (POST /api/permissions 与 bot.manage action=permission)
  显式传 `dir: agent.dataDir` —— flag 落本 agent 数据目录, 不再依赖 markEscalation 的 cwd 兜底。
  钉子: `audit-dead-letter.test.js` 第 4 例。
- **测试污染生产账本 (评测-II P1-1c)**: `permissions-apply-shared-2026-11-14.test.js` 未传
  `dir`, 直跑 `node --test test/xxx.test.js` (无 test-run.mjs 注入的 PPX_TEST_TMP_ROOT) 把
  测试提权写进生产 `data/security/escalation-flag.json` —— 生产账本 11-14 13:16 的
  test/bot.manage/http 三条即此来源 (非真实提权)。所有相关测试显式传 tmp dir;
  被污染的 flag 文件已重置 (该文件是 24h 滚动标志, 非 append-only 账本)。
  验证: 直跑三份测试文件后 flag 保持空 entries。
- **历史提权补录 (评测-II P1-1d)**: 10 次 via:http 提权 (2026-11-03~11-09) 发生在 11-13
  修复之前 (当时只有 tracer 通道), 唯一账本是会轮转的事件流。新增
  `scripts/audit-backfill-escalations.js` (幂等 + `--dry-run`), **append-only** 补录 10 条
  (`occurredAt` 保留原始发生时刻 + `backfill:true`, 不改写任何历史行),
  `npm run audit:verify` 412/412 完整、HMAC 启用、幂等复跑零副作用。
- **语义闸门前置 (评测-II P1-3)**: tool-loop 旧实现把 `selfReviewError` 包在
  `shouldRetryErrors` 里, 与"语义闸门在次数闸门之前"的注释自相矛盾 —— 重试预算耗尽
  (2 次) 后硬拒绝连 `self_review_stop`/强制收口都不再触发, 模型继续换工具绕行烧满 24 轮
  (生产 11-08 s_mw8151np9quw 实测 10 次软错误打转)。语义裁决提前到次数闸门之前
  (纯正则, 零成本), 注释与代码同步。钉子: `tool-loop-semantic-gate-order.test.js`
  1 例 (预算耗尽后硬拒绝仍收口), 既有 loop 套件回归全绿。
- **提权 TTL 自动回落 (评测-II P1-2)**: opt-in `security.escalation_ttl_minutes` (默认
  0=关 —— 不反转 11-03 拆除确认门的即时生效决策, 给想要兜底的部署)。提权 N 分钟自动
  回落到提权前档位, 回落走 tracer `security/permission-reverted` + 审计链
  `security_permission_reverted` + notify; 快照守卫 (用户中途手动变更则尊重, 不覆盖);
  收紧/持平解除定时器。前端"完全权限"卡片文案补后果警示 (高危命令不经审批直接执行,
  事后无法追回)。钉子: `escalation-ttl-revert.test.js` 4 例; 配置键注册
  config-consistency + `config/ppx.json.example` + `docs/CONFIG.md`。
- **长命令提示词引导 (评测-II P2-1)**: 3 个生产会话 (11-03/08/09) 的全量验证命令反复撞
  30s 命令预算 (5 次 tool/timeout), `run_background`/`job` 常驻曝光却零调用 —— 工具描述
  里写了用法, 但【执行循环】纪律从未提过, 模型每轮都要重新发现一遍。补第 7 条纪律:
  预计超过 30 秒的命令用 run_background 启动 + job 轮询。钉子:
  `prompt-execution-longtask.test.js` 1 例。
- **LLM 延迟账本 (评测-II P2-2)**: 评测窗口内用户感知延迟完全不可度量 (会话时间戳是
  落盘时刻而非真实回合墙钟)。usage 包装层对**成功**调用记墙钟, 六档分桶
  (1/3/10/30/60/120s) 落进累计账本与按天×按模型账本 (体积恒定, 不存样本);
  `buildUsageStats` 吐 `latencySummary` (avg 精确 / p50·p95 分桶近似 / ge120s 开口段
  null 不编造)。钉子: `usage-latency.test.js` 4 例 (桶边界/记账落位/失败不计/近似口径)。
- **孤儿标题回收 (评测-II P2-3)**: delete/rename/pruneOld 只删正文文件不清标题台账 ——
  生产实测 13 个标题仅 5 份正文, 台账变成不可信索引。构造 SessionStore 时对 `/^s_/`
  键对账, 正文缺失的标题移出并备份 `_titles.orphans.json` (可追溯; 11-14 的
  archive-before-delete 已防新孤儿)。ppx-memory 技能副本 (session.js) 同源跟进,
  漂移测试钉住。钉子: `session-orphan-titles.test.js` 3 例 (回收+备份/非 s_ 键豁免/幂等)。
- **双口径报表 (评测-II P2-4)**: 评测报告 §3 的数字 (表面 95.85% vs 严格 74.65%) 此前靠
  一次性脚本算出, 不可复现。新增 `scripts/eval-ledger-report.js` (`npm run eval:ledger`,
  只读不改账本), 五分类 (success/exitNonzero/deniedByDesign/softError/hardFail) 复用
  `isToolErrorResult` 与运行时同口径, 双成功率 + 会话链路 + 恢复率 + 按天分解。
  生产账本实测严格口径 74.65% (162/217) —— 与批 II 自查值精确吻合。
  钉子: `eval-ledger-report.test.js` 3 例 (五分类/双口径/fixture 聚合)。
- **杂项**: `src/tools/catalog.js` 过期注释更正 (默认 tool_exposure 已是 "core", 11-02 起
  —— 评测报告曾引用该注释误报 "全量下发仍在"); `test/config-consistency.test.js`
  陈旧 owner 注释更正 (src/core/policy.js → src/agent/loop/tool-loop-policy.js)。

验证: 全量 **2838 例 (2832 通过 / 6 跳过 / 0 失败)**, `npm run verify` 18 门禁全绿,
`npm run audit:verify` 412 条完整 (含补录 seq 403-412)。

### 评测修复批 II (分层采样评测 P1×4 + P2×6 全量闭环, 独立评测脚本先红后绿)

外部评测 (eval-ppx: 402 条审计链独立密码学验证 + 217 条轨迹 + 5 会话) 发现的问题全部闭环:

- **审计脱敏误伤 (P2-1)**: `scrubArgs` 的 `sk-` 正则无左边界, "ask-user-loop-*.test.js" 里的
  sk- 被当密钥, 生产审计 seq383 实际把命令改写成 `ask-***.test.js` (追责对不回原文);
  手机号正则无边界, 13 位 epoch 时间戳会被打码成 `1**********46678`。改为 `(?<![A-Za-z])sk-…`
  (负向后顾挡字母前缀, 保留 `_-` 覆盖 sk-proj 类真密钥) + `\b1[3-9]\d{9}\b` (对齐 pii.js)。
  钉子: `audit-body-redaction.test.js` 新增生产实例回归。
- **审批等待超时误分类 (P2-2a)**: 审批等待 120s 超时的结果文本 `TOOL_ERROR_PREFIX +
  "[permission] …审批被拒绝或超时"` (approval.js:87 拼接) 含"超时"二字, 被 `isTimeoutResult`
  的裸 includes 判成执行超时 —— tool/timeout 事件里 elapsedMs(120003, 含审批等待) 与
  budgetMs(30000, 执行预算) 口径撞车 (生产 events-2026-11-03 实测 2 次)。`isTimeoutResult`
  排除 `[permission]`/`审批` 面, 审批终态回归 approval/resolved(timeout)+tool/perm-rejected 采集。
- **超时只放弃不杀树 (P2-2b)**: execFile 的 timeout 只杀直接子进程, 孙进程 (npm/node 长驻脚本)
  持 stdio 管道存活 —— 心跳探针实测超时后孙进程继续跑 (生产 "npm test 没跑完" 的资源泄漏面)。
  新增 `execFileTree`: 关掉 execFile 自带 timeout, 到点对**活着的直接子进程**一次性整树终止
  (win: `taskkill /PID x /T /F`; posix: detached + 组杀), AbortSignal (seam 工具预算) 触发同一
  树杀并在结果标 `aborted`; Docker provider 对齐接受 signal (运行中容器的树杀不做, --rm 自清理)。
  run_command 透传 `ctx.signal` —— 两层预算 (tool_timeout_ms vs command_timeout_ms) 不再互不知晓。
  钉子: `timeout-semantics-2026-11-14.test.js` 4 例 (误分类×2 + 心跳探针证明树死 + abort 快速返回)。
- **提权看门狗 CRIT (P1-1)**: 提权留痕原有 tracer/审计链/notify 三通道, 但"非本人提权"场景
  30 分钟一次的心跳完全无感 (生产 11-03 十次 via:http 提权, 心跳 level 恒 ok)。照 needs-action
  模式新增 `src/security/escalation-flag.js` 持久标志 (`<dataDir>/security/escalation-flag.json`),
  recordEscalation 第四通道写入 (24h 内), 看门狗 collectSignals→renderWatchdogPrompt 出 CRIT 段
  ("若非本人操作, 检查 http token 并重启还原")。不反转 11-03 拆除确认门的决策 (即时生效保持)。
  钉子: `escalation-flag-2026-11-14.test.js` 4 例 (累加/过期/CRIT 渲染/四通道齐发)。
- **硬拒绝×2 强制收口 (P2-5)**: `self_review_stop` 旧实现是"方向盘消息 + continue" —— 模型
  继续拿下一轮调用且工具未禁用, 生产实测写桌面被拒后连续换 4 种工具绕行 (每次换工具都绕过
  repeat 签名检测), 且路径越界文案 (`[permission] …被拒绝` / `路径越界拒绝`) 根本不命中硬拒绝
  正则 (四连试期间零 stop 事件)。修复: selfReviewError 正则补 `\[permission\]|路径越界|被拒绝`;
  policy 新增 `shouldFinalizeHardDeny()` (默认阈值 2, `hard_deny_finalize_rounds` 可配 /
  `hard_deny_finalize=false` 可关); 达阈值 break 出循环, 走与轮次耗尽同款的**无工具收口调用**
  (`exhaustedFinalizeText` 泛化为 `finalizeTurn`, 事件/提示词/尾注注入, exhausted 路径字节不变),
  收口失败回落诚实硬停止文案, 事件用 `tool/self_review_finalize` 不冒用 exhausted_finalize。
  钉子: `hard-deny-finalize-2026-11-14.test.js` 3 例 (阈值/强制收口/回落), 既有 loop 套件 106 例回归全绿。
- **成本三口径进 UI (P2-6)**: API 层 11-13 已吐 recordedCost/estimatedCost/effectiveCost,
  前端没接 (历史 $0 账被误读成"用得省")。StatsView KPI tip 与底部账目行改用三口径
  (costIsEstimated 时展示 effectiveCost 并明标"含估算, 仅供量级参考"), 模型行区分 记录/估算;
  `buildUnpricedNote` 拼接 `reconciliation.unbucketedCalls` 对账差额 ("历史累计差额, 不是丢账")。
- **前缀缓存契约 E + 预期说明 (P2-4)**: `catalog.toOpenAI()` 已按名字稳定排序, 补契约钉子
  (`prefix-cache-tool-order-2026-11-14.test.js`: 两次构建逐字节一致 + 收窄后仍字母序子集);
  README 前缀缓存一节补命中率合理预期 (跨会话 miss 受 provider TTL 约束; neutral 只管跨机器;
  按需曝光是设计内的一次前缀换血)。
- **注入重放钉死 (P1-4)**: 11-07 生产注入事件 (role-hijack "you are now") 因会话文件被删
  最终行为不可考 —— 用生产同款样本在真实管道上重放并钉死: `injection-replay-2026-11-14.test.js`
  3 例 (JSON 深层叶子扫描 / wrapUntrusted 语义 / 端到端: tracer 事件+审计链事件+会话打标+结果包裹,
  哈希链 verify 仍过)。
- **后台任务长任务补强 (P1-2)**: 既有钉子只测即时命令, 补 1.5s 真实长任务用例
  (`run-background-longtask-2026-11-14.test.js`: 启动 <1s 非阻塞返回 / 运行中可查询 / 结束取全输出)。
  P1-3 (needs-action 401 停摆可视化) 与 P2-3 (load_skill 报错附可用清单) 为 11-13/11-14 既有修复,
  本轮回归验证 23/23 通过。

### 评测整改轮 III (外部评测跟踪: P1-1 落盘 + 文档同步, 先红后绿)

- **被拒调用进会话 jsonl (P1-1)**: 准入拒绝 / PreToolUse 钩子否决 / 写前事实落账失败三类
  "未执行即拦截"都发生在 bus "tool/call" 之前, 证据采集器永远看不到 —— 会话轨迹零留痕,
  模型自述"被拒"无法对账 (生产实例: rw 会话称"两次 run_command 被拒", jsonl 0 条 run_command)。
  现按执行路径同形双发 call/result(ok=false), _pushTurn 落会话日志; fail-closed 分支补发
  result 防孤儿调用。副作用方向核对过: denial 进 Reward EWMA 与故障病历语义正确
  (fence 类拒绝本就已入病历)。钉子: `denied-call-journal-2026-11-14.test.js` 3 例 (先红后绿)。
- **README 数字同步 (锚点漂移)**: tests 2749→2818 (新增测试后未跑 `--fix --with-tests`)、
  test_files 366→367、散文覆盖率 89.5%→91.9% (coverage:gate 实测)、verify 17→18 项。
- **README review/ 路径修正 (P2-8)**: 分级审查流水线 2026-11-12 已迁入 `verify/review.js`
  (claim-gate target 早已钉对), 表格与目录树两处文档路径跟上; 目录树 verify/ 首次单列。

### 双轨收敛 (REST/MCP admin: 修真缺陷, 不做宏大统一)

调研修正了预设: providers/settings/routing 的配置层**早已同源** (两轨都调 src/config/*),
真问题是四个具体缺陷 —— 本轮逐一修复, 信封形状零变化 (两侧契约各有测试钉):

- **TaskBoard 三方同源 (P0 数据丢失)**: `admin.js` 自建 TaskBoard 实例 + REST 走
  `agent.getTaskBoard()` —— 两个实例各自整表覆写 `data/tasks.json`, 一边建任务另一边一写
  就抹掉 (R17 只接通了 agent↔REST, 漏了 MCP)。admin.js 改走 `agent.getTaskBoard?.()`。
- **MCP settings.update 补审计**: 此前 MCP 通道改设置不写 `settings_updated` (REST 写) ——
  哈希审计链对 MCP 变更不可见。补齐, 只记键名不记值, 带 `via:"mcp"`。
- **provider 探活单一实现**: 新增 `src/web/provider-ops.js` (cache→disk 回退 + health()),
  REST `_apiProviderTest` 与 MCP `ppx.providers.test` 同一函数, detail 文案不再漂移。
- **REST readonly 旁路关闭**: MCP admin 写早有 readonly 检查, REST 的 providers/settings/
  tasks 写路径一直没有 (审查者可经 REST 绕过) —— 三处补 403 (主 agent 永不 readonly, UI 零影响)。
- **REST 首启自愈补齐**: `_ensureConfigDir` (与 MCP admin 同款) —— 空 root 时 withFileLock
  把 ENOENT 误判为锁冲突超时 3.5s, 此前自愈只在 MCP 侧。
- **/interrupt 会话参数**: 此前读了 `data.sessionId` 却调无参 interrupt —— 会话级中断退化成
  全局 (并发会话误伤)。带 sessionId 走会话级, 不带保持全局旧兼容。
- **文档纠偏**: PROJECT-OVERVIEW "Web 全面切 MCP/REST 退役"改为共存口径 (v5.0 webapp 走 REST,
  MCP admin 服务外部宿主); admin.js 头注释同步。
- 钉子: `test/admin-track-parity-2026-11-14.test.js` 7 例 (同源/审计/探活 parity/readonly 403×3/
  interrupt 会话级+全局兼容)。

### 基准 (多步链 8 题, 20 → 28)

- **bench 新增「多步」任务组**: 4-6 步工具链 (锚点改→grep 确认 / 跨文件重命名→清零确认 /
  写→覆盖→撤销→删→撤销→读 / 读脚本→执行→读产物 / **write+node 连招必须被闸门拦下** /
  记忆写×2→搜→落库 / 一次调用三处编辑)。离线基准 **20 → 28 题, 首跑 28/28 (100%)**,
  多步单题 63-293ms (单步的 5-10 倍, 链长反映在成本里); falsify 判分器门同步扩容
  (oracle 28/28, 60 变异体全部正确判负, 含近失题)。
- **闸门口径进基准**: 多步链显式钉住两条设计内行为 —— edit_lines 落账
  rememberSessionWrite 后不能 run_command 跑刚写的文件 (编辑链的执行验证放 verify);
  write_file→node 的连招拒绝链 (首拒 + 同会话重试短路)。锚点是行内容哈希
  (`lineHash`), plans 里预计算并与 tasks.js 夹具逐字同源 (漂移 = 任务红, 不是静默错判)。
- 判分精度: ms-anchored-multi-edit 的新值断言精确到分号 (裸 includes 会放过 "A = 100"
  这类近失变异体)。
- **depcheck 夹具生成器豁免**: bench/tasks.js + bench/offline-plans.js 的字符串里故意含有
  `"import ... from \"./x.js\""` (写给沙箱的夹具内容) —— depcheck 的字符串保真扫描会把它们
  当缺失模块报 P0。这两文件显式豁免 (IGNORE_FILES), 其正确性由 falsify + 离线基准双门覆盖;
  真代码的字符串保真检测不削弱。

### 自带模型体验轮 (对标 zcode/qoder 的"接模型"环节, 用户自带模型)

### 自带模型体验轮 (对标 zcode/qoder 的"接模型"环节, 用户自带模型)

- **修 CLI 向导回归**: `preset.models` 是 v4.2 结构化对象数组, 向导裸 `join` 打出
  `[object Object]`——展示口径收敛到 `presets.formatPresetModels` (label 优先), `--list`
  与交互选模型全部可读。
- **doctor --net 走协议适配器**: 旧探测裸 POST `{base}/chat/completions`, 对
  anthropic-messages / openai-responses 协议的 BYO 配置必然误报不通。改走
  `LLMClient.health()` (与 setup 探活、`POST /api/providers/test` 同一函数), 路径与鉴权头
  按 protocol 生成。实测: anthropic 协议 mock 服务探活通过 (x-api-key 头正确生成)。
- **needs-action 用户面闭环**: `ppx doctor` 读 `data/llm/needs-action.json` (兑现
  needs-action.js 注释承诺) —— 坏 Key/欠费点名 provider/model/reason/userHint/次数;
  `GET /api/run.state` 带 `llmNeedsAction` 摘要, Web 状态条即时上浮 (每个故障只提示一次,
  成功调用自清)。修好后换 Key 重试一次即从 doctor/状态条同时消失。
- **CLI 向导接入本机模型发现**: 交互向导输 `0` 即扫描 6 个回环端口 (LM Studio/Ollama/
  vLLM/llama.cpp/Jan/textgen), 列出已加载模型与上下文窗口, 选中即走探活写盘链 ——
  与 Web「一键接入本机模型」同一实现 (discoverLocalServers)。
- **文档/示例对齐**: MODEL-SETUP.md 更正 anthropic 原生 protocol 口径、补 Key 三通道/
  本机自动发现/doctor 排障节; `config/ppx.json.example` deepseek 条目补
  `protocol/display_name/models` v4.2 字段展示。

### 结构 (优化循环: 前端主包分块, 817kB → 175kB)

> 2026-11-14 生产评测 (402 条审计全量 + 5 轨迹 + 60 轮离线基准) 的整改。先红后绿,
> 每项有钉住测试 (`test/eval-fixes-2026-11-14.test.js`); P1-1 (审计 ok 保真) 与
> P2-2 (超时可配) 已在 2026-11-13 轮修复, 钉在 `eval-fixes-2026-11-13.test.js`。

### 修复

- **grep Windows 盘符冒号吞命中 (P1-3a)**: `rg` 以绝对路径搜索时输出 `C:\...\a.js:1:text`,
  旧解析按前两个冒号切分 → 行号 NaN → **全部命中静默丢弃**, 且 rg "有命中但解析为空"
  被当终态直接返回 (不降级), auto 与 js 后端给两个答案。改为非贪婪正则 + rg/git 改传
  相对路径 + 跳过目录 (-g! / pathspec exclude) 与内置后端对齐 + 去掉每文件口径的 `-m`。
- **LLM needsUserAction 静默停摆可见化 (P1-2 代码侧)**: 新增 `src/llm/needs-action.js`
  持久标志 (data/llm/needs-action.json) —— auth/balance/404 类失败标记累加, HTTP 成功
  即清除; 看门狗心跳简报带出并要求 CRIT 分级。此前 deepseek 401 失效后停摆无感半天多
  (last-error.json 会被瞬时失败/测试桩覆写, 撑不起告警面)。**API Key 本体仍需人工更换**。
- **load_skill 未知技能报错附可用清单 (P2-1)**: 只报"未知技能"实测诱导同参盲试 5 连败
  (Word×2 / webapp-testing×3); 现在报错自带可用技能列表, 一步自纠。
- **会话删除前归档 (P2-3)**: `SessionStore.delete` 现在把轨迹移入 `sessions/archive/`
  (原名+时间戳+pid), 评测/追责事实源不随清理消失 (实测 13 会话只剩 5 份 jsonl)。
  清盘重写路径不归档 (删后同文件重写, 归档会自复制)。

### 测试

- **delivery TTL 测试去脆弱 (P1-3b)**: "重试窗口跨过 TTL 也要拦"的钉子原用 60ms 真实时钟
  窗口, 全量 2000+ 用例并发下首次重试定时器被饿到跨过 TTL → "首发即丢" 断言挂。
  语义不变 (跨 TTL 照拦、拦前必须重试过), 窗口放宽为 5ms 退避 × 500ms TTL。

### 结构 (优化循环: 前端主包分块, 817kB → 175kB)

- **webapp 主包按库分块**: `vite.config.mjs` 增 `manualChunks` (Vue 运行时 / markdown 渲染栈
  markdown-it+dompurify+katex+highlight.js / 其余第三方), 主包 **816.94 kB → 178.95 kB (-78%)**,
  浏览器并行加载、按块缓存。**实测坑**: 本仓 Vite 7 打包内核对顶层 `build.manualChunks`
  静默无视 (函数整轮不调用, 连强制同名实验都不改变产物), 必须放
  `build.rollupOptions.output.manualChunks` —— 构建告警文本自己指的就是这条路。
- **尺寸预算门**: `scripts/check-web.mjs` 新增 chunk-budget 检查 (主包 ≤250kB / 渲染栈 ≤650kB /
  Vue ≤120kB / 未预算块 >200kB 即红), 取代 `chunkSizeWarningLimit: 1500` 的告警静音带
  (旧值曾把 817kB 主包捂住)。web:check 10 项全绿; desktop:smoke PASS (分块后渲染栈
  markdown/KaTeX/highlight 用例全过)。

### 结构 (自审驱动轮: builtin.js 巨石清零, 自审 100/100)

- **`src/tools/builtin.js` 按失效域二次拆分** (666 → 41 行装配外壳, 自审唯一 [large-module]):
  文件域 → `builtin-file.js` (读/写/追加/删/移/撤销/列目录/搜索/读图 + 锚点编辑, 撤销栈为域内
  闭包); 执行域 → `builtin-exec.js` (run_command/code_act/run_background/job + Windows 尾管道
  助手 + 同会话拒绝记忆, run_command 与 run_background 的三道启动闸门收敛为同一 `execGates`)。
  全部既有 import 路径经 re-export 不变; 工具名/能力声明/错误文案逐字保留。自审复评
  **100/100 (A)**: 巨石 0 · 环 0 · 断链 0 · 死代码 0 · 高/中/低风险全零 (366 模块 / 901 边)。

### 结构 (战役遗留项 #8: 四入口共用请求口径, PC 端优先)

- **桌面壳↔内核客户端统一**: 新增 `src/services/desktop/kernel-client.js` —— 探活 (HMAC
  挑战应答) 与优雅退出 (`POST /desktop/shutdown`) 的私有协议实现自 `electron/server-proc.js`
  迁入 (行为逐字不变, secret 参数化)。server-proc 只剩进程管理, 协议单一来源且纯 node 可测:
  新钉 `test/kernel-client-2026-11-14.test.js` 用真实 HttpChannel 实测握手/错密钥拒绝/幂等退出。
- **前端请求口径单一来源**: 新增 `webapp/src/api/url.js` 纯函数 (`apiUrl`/`authHeaders`),
  client.js 与 sse.js 同一实现 —— 流式 `/message/stream` 不再裸拼路径与 Bearer 头 (401 现在
  同样触发 unauthorized 刷新钩子), EventSource 地址也走 base 口径 (token 仍走 query, 无法带头)。
- **权限写路径单轨化**: 新增 `permissions.applyPermissionUpdate` —— POST /api/permissions 与
  `/api/bot.manage` action=permission 的唯一实现 (rank 校验 fail-closed / detectEscalations
  提权留痕 / 落引擎三字段), 两个入口只保留各自的响应形态, 消灭"同步靠注释自觉"的双轨。
  planEnabled/sessionKey 是会话级开关, 留在 http 入口。

### 数据

- 智能体记忆新增 2 条环境事实 (L1): tail/head 由内置截取器处理; 全量测试 ~50s 超
  run_command 默认 30s, 用 test-run.mjs 分片或 timeout_ms/后台 worker。

### 结构 (战役遗留项 #6)

- **`PPXAgent` 拆 TurnRunner / LaneMerger**: `src/agent/index.js` 类体 571 → ~200 行只剩引擎壳
  (构造装配/会话路由访问器/通知回调/只读模式)。单轮执行面 (`_chatCore`/`chatAsync`) 迁入
  `src/agent/turn-runner.js`, 同会话并发面 (`chat` 路由/合并车道/中断位/回放缓存分桶,
  含纯函数 `splitSegmentedReply`) 迁入 `src/agent/lane-merger.js`, 与 work.js 三路拆分同款
  plain-object mixin 挂回 prototype。行为零变化: 方法名与 `this._chatCore` 调用点原样保留,
  125 个测试文件的实例猴补丁透明; `splitSegmentedReply` 从 index.js re-export 导入点不变。
  验收钉子 `test/agent-split-turnlane-2026-11-14.test.js` 三场景逐一实测 (同会话 3 追打合并
  1 轮 + 分段回信 / interrupt 会话隔离与流式掐断 / resumeCtx 旁路车道 + 断点 memo 复用)。
  `_withSessionLock` 留在 work-thread.js (零行为收益不挪); 与 `ans-lane.js` (ANS 出站车道) 无关。

## 5.2.0 (2026-11-13) · 架构优化: 十项契约 + 三个借来的轮子

> 5.1.0 之后没有继续堆功能, 而是把十处"各写各的"收成单一契约, 并借了三个成熟轮子
> (ripgrep / LSP / 常驻 bash)。能力面变大, 工具面对模型反而更清楚 —— 这一点在下面的
> "行为变化"里能看到实证 (按需名单 73 行 → 24 行)。
>
> 完整论证、源码证据与"故意没做什么": [docs/ARCHITECTURE-OPTIMIZATION-2026-11.md](docs/ARCHITECTURE-OPTIMIZATION-2026-11.md)

### 升到 5.2.0 的三个理由

1. **能力面**: 新增内容检索 (`grep`)、代码事实 (`lsp`)、常驻 shell (`shell`)、锚点编辑 (`edit_lines`)。
2. **可诊断性**: runId 贯穿审计/委派/军团; 压缩有 `compaction/start|summary|end` 事件; 评测有回归门禁。
3. **可复算的收益**: `npm run bench:edit` 用 6 个编辑任务量协议成本 —— 大段重写省 32~42%,
   而短行小改贵 5.4 倍。**收益与代价都写在数字里, 不靠形容词**。

### 用户能感知的三处变化

- **按需工具名单从 73 行缩到 24 行**: 15 个意图门面收编 64 个同族低频工具, 能力一个没少
  (原工具名仍可直接调用, 测试/脚本/技能零影响);
- **超时终于真的会超时**: `receipts` / `approval` / `questions` 三处定时器不再 unref,
  挂起的审批/提问由 `shutdown()` 显式收口。此前 21 个用例 `cancelledByParent`, 而 CHANGELOG 写着"全绿";
- **审计与事件更好查**: 审计条目带 `runId`, 事件流多 `run/child` 与 `compaction/*`,
  一条命令能串起"用户轮 → 工具 → 委派 worker"。

### 十项改动

- **工具面 (①)**: 新增 `src/tools/facade.js` —— 15 个意图门面 (team_room / memory_admin /
  skill_admin / expert / evolve / git / scene / persona / task_plan / capabilities / repo /
  audit / legion / voice / ingest) 收编 64 个同族低频工具。门面只转发 `catalog.call`,
  策略链/审批/审计/参数校验一处不少; 原工具名保持可调用, 只是不再单独下发。
  `catalog.hide()` 新增"永久隐藏"语义 (优先于任何曝光策略), 按需名单按新口径只列
  "模型真能按需取到的工具" —— **73 行 → 24 行**, 能力一个没少。
- **Run 血缘 (②)**: 新增 `src/core/run-context.js`, runId 唯一来源 = 当前 traceId。
  审计条目 (4 处) 带 runId; `patchTrace()` 在 chat / chatStream 入口补 sessionKey+kind;
  legion 冷启动注入 `PPX_PARENT_RUN_ID` 跨进程带血缘; `announceChildRun()` 落 `run/child` 事件。
  一条 runId 现在能串起 trace / 审计 / 委派 worker。
- **记忆召回 (③)**: 新增 `src/memory/retrieval.js` —— 四源 (事实/经验/场景/画像) 统一为 Provider,
  `retrieveMemory()` 并发查 + RRF 融合 + 每条带 `evidence:[{source,rank,score}]`; 单源故障
  只降级不拖垮 (`degraded`), `formatForPrompt()` 按预算渲染并如实标注丢弃条数。
  本轮只落契约, 未改现有召回链路 (接线需 A/B)。
- **上下文配额 (④)**: 新增 `src/agent/context-budget.js` —— 纯函数把窗口切成
  output/tools/system/history/memory, 溢出按 **tools > system > 历史下限 > 记忆** 让位;
  `agent.contextBudget()` 提供体检摘要。历史预算仍走既有公式, 现网行为零变化。
- **评测门禁 (⑤)**: 新增 `scripts/bench-gate.js` + `npm run bench:gate` —— 基线 vs 最新报告
  逐任务比对, pass→fail 必拦、覆盖率 <80% 必拦、成功率下降即非零退出。此前基线只存不比。
- **内容检索 (⑥, 借轮子)**: 新增 `src/tools/grep.js` —— 三级阶梯: `rg` → `git grep` → 内置扫描。
  此前只有"按文件名 glob", 搜内容得让模型拼 `run_command` 的 grep/findstr (Windows 引号/编码全踩坑)。
  三个后端结果一致 (有测试钉住), 缺 rg 自动降级, 零运行时依赖不变。
- **语言服务器 (⑦, 借标准)**: 新增 `src/tools/lsp.js` —— JSON-RPC over stdio + Content-Length 分帧,
  `definition` / `references` / `hover` / `diagnostics` 四个动作, 按扩展名选服务器并按 (命令,根目录) 常驻;
  没装服务器如实报错, `shutdown()` 收口子进程。对标 DSH 的 `tool/lsp` / OpenCode / omp 的 LSP 集成。
- **常驻 shell (⑧, 补 DSH 已有能力)**: 新增 `src/tools/shell-session.js` —— 常驻 `bash -s`,
  `cd` / `export` / venv 在后续命令里继续有效 (此前每条命令都是新 shell, `export` 静默失效)。
  结束标记协议 + 串行队列 + 超时杀进程树并重启 + cwd 跟踪与 `cd` 越界校验;
  内建放行, 其余仍过命令守卫; 没有 bash 的环境不注册该工具。
  **踩坑记录**: `where bash` 的 GBK 路径被当 UTF-8 → ENOENT; 标记用 printf 的 `\n` 被转义成真换行;
  超时定时器又写成 unref (同 ⑧ 之前那批挂死用例的根因)。
- **压缩引擎 (⑨, 对齐 DSH 的 compaction 接缝)**: 新增 `src/memory/compact-engine.js`。
  此前压缩有两份实现 (`context._maybeCompact` / `evidence._maybeCompact`), 各自 replay、各自调
  LLM、各自写事件, 差异只在"证据侧有保真闸门、上下文侧有 spill 归档" —— 能否续读被压原文取决于
  mixin 顺序。现在统一为一个引擎: `compaction/start|summary|end` 三件事件 (跳过/失败/拒绝也发 end)、
  按会话加锁 (并发只跑一个)、保真闸门与归档按开关保留。两个调用点各缩成 15 行委托。
  阈值与取半规则不变 (`compactionSplit` 单源), 既有 29 例行为测试全绿。
- **锚点编辑 (⑩, 借 omp 的 hashline 思路)**: 新增 `src/edit/anchors.js` +
  `src/tools/anchored-edit.js`。`read_file(anchors:true)` 返回 `行号#锚点| 原文`,
  `edit_lines` 用锚点改行/改段 —— 不必复述旧内容 (省输出 token), 锚点对不上即拒绝 (stale 保护),
  同内容多行拒绝猜测, 多条编辑原子生效。与 `write_file` 共用撤销栈与写盘记账。
  **只落机制, 未做 token 基准对照** —— 收益数字不编。
- **编辑协议基准 (⑩ 的补证)**: 新增 `bench/edit-protocol.js` + `npm run bench:edit` ——
  6 个代表性任务上量"表达一次编辑要输出多少字符" (含锚点读侧前缀税)。
  结论不客气: 大段重写省 32~42%, 批量小改省 9%, 而**改一行短内容贵 5.4 倍**、删 10 行贵 2 倍。
  于是 `edit_lines` 的描述里写死了路由规则 (整段重写用它, 一两行用 apply_patch),
  并给出净收益判定式 (`breakEvenReadLines`)。基准自身有 6 例测试钉住口径 (含"必须承认 patch 更省的场景")。
- **被推翻的两条审计结论**: ①"通道层缺统一 ingress" 不成立 (`createTrigger` + `planIngress`
  已是纯函数契约); ②"工具 schema 吃 11.2k token" 是 `all` 模式旧数字, 默认 core 实测 ≈4.0k。
- **修复 (审计顺带挖出的真 bug)**: 三处超时定时器此前用 `unref()` —— 进程无事可做时直接退出,
  超时永不触发, 调用方拿到永不 resolve 的悬空 Promise。全量测试里表现为 **21 个用例
  cancelledByParent** (approval / ask_user / 投递回执 / 通道全链路), 而 CHANGELOG 一直写着"全绿"。
  - `src/channels/receipts.js`: 同步投递超时改为 ref'd (`workgraph-step3` 5 通过/7 挂死 → 12/12);
  - `src/agent/approval.js` + `src/agent/questions.js`: 改为 ref'd, 并把"进程能退出"交给
    新增的 `cancelApprovals()` / 既有 `cancelQuestions()`, 由 `shutdown()` 在首个 await 之前
    同步收口 —— 语义更准: 有人在等就活着, 说不等了才退。
  - 结果: 21 → 0 cancelled; `approval-loop-r13` / `ask-user-loop` / `superagent-runtime` /
    `split-modules-contracts` 4 个文件 24 例全绿。
- **验证**: 新增 10 个测试文件 78 例 (facade 5 / retrieval 7 / budget 6 / bench-gate 6 / grep 8 / lsp 7 / shell 8 / compact 10 / anchor 15 / edit-bench 6),
  `tool-exposure` 更新到新契约; `npm run verify` 18/18、`arch-guard` (0 环 / 0 越层)、
  `silent-catch-guard --strict` 全绿。

## 5.1.0 (2026-11-13) · 成熟开源打磨: 四项导航 + 文案词典门禁 + 结构精简

> 5.0 之后的一轮"成熟度"打磨: 内核没有变弱, 但第一次打开它的人知道该点哪里、看到的是人话,
> 而这两个承诺不再靠自觉 —— 文案词典与机器门禁把它们钉住。

### 评测整改: 度量可信度 / 凭据边界 / 长任务 (2026-11-13)

> 依据 2026-10-30 ~ 11-13 的生产轨迹评测 (336 次工具调用 / 217 条带结果体 trace / 5 份完整会话)。
> 原则: 不改写历史账本, 只修产生账本的代码; 所有结论都能用 `test/eval-fixes-2026-11-13.test.js` 复现。

- **度量语义**: 新增 `isToolErrorResult()` ([src/core/errors.js](src/core/errors.js)), 统一识别
  `[工具错误]` 前缀、元数据头后的错误行、顶层 `{"error":...}` 三种失败形态。此前 `run_command`
  失败结果以 `[exit=1 ...]` 开头, `ok` 判据只认字符串前缀 → 执行失败被记成成功 (朴素 95.54%,
  净 74.65%)。新口径在 catalog / 审批 / 工具循环 / MCP / 投机复现全部接线; 失败结果同时保留
  stdout+stderr, 不再只回 “Command failed” 外壳。
- **凭据边界**: `/api/bootstrap` 与首页注入的 `auth_token` 只发给“回环 + 可信 Host/Origin +
  浏览器形态 (Sec-Fetch-* 或同源 Referer)”请求; Node/脚本客户端 (含 agent 的 `browse` 兜底抓取)
  不再能读走 token。`read_document` 补齐 `isProtectedRead`, 不再旁路 `read_file` 的凭证保护。
- **提权留痕**: `recordEscalation()` 把提权同时写到 tracer、SHA-256 审计链
  (`security_permission_escalated`) 与用户通知; 审批超时补写 `APPROVAL_RESOLVED` WAL,
  requested/resolved 不再因超时差 2 条。注入命中写审计并给会话打 `injection-suspect` 标记,
  后续工具轨迹带 flags。
- **成本账本**: 按模型/按天记录 `cachedTokens`; 使用统计页新增 `recordedCost` / `estimatedCost` /
  `effectiveCost` 与 `reconciliation` (总 calls、按天 calls、`unbucketedCalls`、最后调用/记账时间)。
  历史 `deepseek-flash` 的 $0 记录不被改写, 但会在只读聚合里给出保守估算值, 不再把“账不准”与
  “真省钱”混为一谈。
- **命令执行**: Windows 末尾 `| tail/head` 由内置截取; `findstr` 无匹配 (exit=1 且无输出) 归为
  正常负结果; 本地 shell 以 Buffer 捕获并按 UTF-8→GBK 回退解码; `maxBuffer` 默认 1MB→8MB;
  `execFile` 超时透传 `timedOut`; 同会话同一被拒命令硬短路 (权限签名变化自动失效)。
  安全回放 6 条 tail + 14 条 findstr 失败样本: **20/20 转为成功**。
- **长任务**: 新增 `run_background` + `job` 工具 (启动/状态/分页输出/列表/终止), 日志落
  `dataDir/jobs`, 单文件 10MB 封顶, 进程退出统一清理; 启动前仍过命令守卫/会话脚本/包清单闸门。
- **记忆/技能/自愈**: `load_skill` 支持 id 与唯一 slug/叶子名双解析 (`code/webapp-testing` ↔
  `webapp-testing`); `memory_add` 写入前做保守冲突检测, 新事实权限 >= 旧事实时用 `supersedeId`
  收口旧结论, 否则只打 `conflictsWith` 不推翻用户事实; `Healer` 启动先读上次标记再写 dirty,
  死 pid 的崩溃残留可被识别并清理, 活着的另一实例不会被误清。
- **验证**: 全量 **2671 测试 / 2665 通过 / 6 跳过**, `npm run lint`、`npm run verify` (18/18)、
  `npm run desktop:smoke` (PASS, result.json 已产出) 全绿。

### 产品化: 从"能力全"到"人能上手" (2026-11-08 ~ 11-13)

- **四项一级导航**: 侧栏从「6 分组 + 8 能力入口 + 3 脚注」收成 **对话 / 项目 / 任务 / 能力** 四项, 由 `webapp/src/stores/ui.js` 路由表统一驱动; 设置/运行状态/技能/插件/MCP/统计收进能力页第二层, 功能一个没删, 只是不再并列摊开。项目页把「空间」落成「一个项目 = 一个文件夹」, 任务页把「工单账本」落成可续跑的任务记录。
- **文案词典 + 门禁**: 新增 `webapp/src/i18n/lexicon.js` 作为界面文案唯一出口 (助手/项目/任务/运行状态/执行过程/工作模式/运行阶段), 并补上它承诺却一直不存在的 `scripts/lexicon-check.js` —— 注释剔除后扫描 `webapp/src` 全部用户可见文本, `lexicon-ok(date): 理由` 为唯一例外。首跑抓出 **13 处内部词泄漏** (空间/工单/本体/轨迹/新开一局/生命周期), 已全部改为用户词; 门禁接入 `npm run verify`, 现 **18 项**。回归守卫 `test/lexicon-check.test.js` 钉住字符串命中/注释豁免/URL 里的 `//` 不误吞同行/例外写法。
- **引导只问两样**: 首次启动第 2 步就地填 **模型名称 + API Key**, 按前缀自动识别 DeepSeek/OpenAI/通义/智谱/Kimi/火山/零一/Claude 的接口地址与协议 (`webapp/src/stores/model-preset.js`), 认不出才要求手填; 探测失败如实回报, 也可直接跳过, 顶部留一条"还没接模型"提示 (ReadyBanner), 随时回来补。
- **错误分三级**: `webapp/src/stores/errors.js` 把底层原文分成 `self-heal / action / report` 三级, 每级给一句人话的下一步 (Key 不对 → 去设置重贴; 429/额度 → 等或查控制台; 网络抖动 → 通常下一条就恢复), 原文仍保留在卡片里。
- **契约与宣称**: 新增 `test/v51-product-polish.test.js` (四项导航 / 常见厂商前缀识别 / 错误三级); `claim-gate` 补两条宣称证据 (四项一级导航、首次启动只问两样), 33/33 条有证据。
- **验证**: 全量 **2634 测试 / 2628 通过 / 6 跳过**, `npm run lint`、`npm run verify` (18 项)、`node scripts/arch-guard.js --check`、`npm run web:check` 全绿。

### 结构精简: 内核减重 + 碎片模块收敛 + 准巨石拆分 (2026-11-12)

> 只动结构与落位, 不改对外行为: 全部公共导出 / 工具名 / 配置键 / 测试契约保持原样, 全量测试与门禁为证。

- **内核减重** (验证域迁出 `src/core`): `claims` / `path-evidence` / `postcondition` 移入 `src/verify/`, core 仅留 `errors` / `selfcheck` / `trace`, 由 **1552 → 178 行**; `src/core` 预算收紧到 400 行 (占用 45%)。
- **内核减重** (工具面迁出 `src/utils`): 出站抓取落 `src/security/http-proxy.js`, 启动横幅落 `src/boot/banner.js`, utils 由 **2113 → 1529 行**, 预算 1650 (占用 93%)。
- **碎片模块收敛** (`51 → 42` 个顶层模块, 130 条依赖边 / 0 环 / 0 越层): 既有归属就近合并 —— `mode/*` → `agent/modes/`, `commands/*` → `agent/command-registry.js`, `planning/pwf.js` → `session/pwf.js`, `review/*` → `verify/review.js`, `wiki/*` → `repomap/wiki.js`, `selfheal/*` → `evolve/healer.js`, `update/*` → `services/update.js`, `desktop/*` → `services/desktop/*`, 另有小模块并入其消费方。
- **准巨石拆分** (5 × 590–599 行): `llm/protocol.js` **590 → 83** (协议适配器拆到 `llm/adapters/{wire,completions,responses,anthropic}.js`); `workgraph/store.js` **591 → 547** (`snapshots.js`); `memory/session.js` **597 → 473** (`session-derive.js`); `tools/builtin.js` **599 → 470** (`builtin-paths.js` 扩展 + `builtin-memory.js`); `agent/bootstrap.js` **592 → 465** (`turn-observation.js` 承接轮观测/SQ-EQ 三件套)。拆分沿用 mixin 挂回 prototype, 调用方零改动。
- **顺带修缺陷**: `findSessionWrittenScript` 迁入 `builtin-paths.js` 后新增 `rootDir` 首参, 调用点漏传会让「会话内自写脚本」直通执行 —— 已由 `test/session-written-js.test.js` 抓到并修正 (回归守卫保留)。`session/pwf.js` 迁入关键路径目录后, 两处「计划文件缺失即降级」的 catch 被静默守卫拦下, 按既有惯例补 `swallowed-ok(2026-11-12)` 判读理由 (缺文件 = 无计划, 不记噪声日志)。
- **门禁与文档**: `arch-guard` 预算按实测重定基线 (core 400 / plugin 320 / utils 1650 / config 1400), `native-guard` 的原生落点表同步新路径; `ARCHITECTURE-CURRENT.md` (§4 模块表 / §8 数字)、`PROJECT-OVERVIEW.md` (分层图 / 模式表 / 自愈路径)、`PROVENANCE.md`、`CONFIG.md`、`TEST-MAP.md` (重新生成) 全部对账。全量 **2626 测试 / 2620 通过 / 6 跳过**, `npm run lint`、`npm run verify`、`node scripts/arch-guard.js --check`、`node scripts/native-guard.js` 全绿。

### 结构精简: 前端超大 store 拆分 + 导出面收敛 (2026-11-13)

> 只动落位与可见性, 不改对外行为: 组件 import 路径、导出名、界面表现全部保持, 全量测试与 18 道门禁为证。

- **`webapp/src/stores/chat.js` 971 → 489 行**: 按域拆成 `chat/{state,approval,tools,history,format,session}.js` (合计 521 行), 原文件只留 SSE 泵 (`send` / `doSend` / `stopGen` / 重新生成) 与命令/模型/权限/运行状态查询, 再用六条 `export *` 把兄弟模块重新导出 —— 11 个 Vue 组件与 `stores/events.js` 的 `import ... from "./chat.js"` 一行未改。`state` 模块对外保留 `push` / `makeThinker` / `liftAnswer` 供兄弟模块复用, 审批、工具卡、历史、格式化、会话切换各归其位, 不再共享一个 900 行作用域。
- **零引用导出与前端死代码**: 删掉 `ticketsApi`、`pluginDeleteApi`、`stopEventBus`、`ticketWhen`、`retrySessions`、`routeOf`、`runWithMajority` 七个导出, 以及 `webapp/index.html` sprite 里 7 个没有任何 `Icon` 引用的符号 (`i-stop` / `i-term` / `i-hook` / `i-image` / `i-clip` / `i-space` / `i-more`); `web:check` 的图标定义/引用契约仍全绿。
- **导出面收敛**: 全仓扫描 (src / webapp/src 定义, test / scripts / docs / electron / bin / skills / webapp 全量引用) 找出 **110 个只在自己文件内使用的 `export`** (58 个文件), 去掉多余关键字; `package.json` 的四个公开子路径 (`.` / `./server` / `./cli` / `./audit`) 不受影响, 内核模块的对外契约保持不变。
- **验证**: 全量 **2634 测试 / 2628 通过 / 6 跳过**, `npm run lint`、`npm run verify` (18/18)、`npm run web:build`、`npm run web:check` 全绿。

### 结构精简: 两个超大 Vue 组件拆分 (2026-11-13)

> 同上: 只挪落位, 模板与样式一行未改, 组件交互与可见行为保持一致。

- **`webapp/src/chat/Composer.vue` 721 → 476 行**: 交互逻辑抽到 `chat/composer/` 四个 composable —— `useModelSeat.js` (思考强度滑轨的几何/拖拽/键盘 + 模型卡与席位切换)、`usePermissionScope.js` (当前档位与「可访问」范围文案)、`useVoiceInput.js` (云端 ASR 录音上送, 浏览器 SpeechRecognition 兜底)、`useStatusBar.js` (轮次/上下文/累计用量三个状态项)。组件只留输入框、发送/停止、附件与队列撤回, 模板与 `<style scoped>` 原样保留。
- **`webapp/src/modals/SettingsModal.vue` 623 → 433 行**: `settings/useGeneralSettings.js` 接管通用面板的表单状态、读取与保存 (审批/沙箱/外观/工具轮次/语音/永久允许清单), `settings/useModelPanel.js` 接管模型面板的交互动作 (连通性测试、删除、预设切换、目录增删、路由保存); 组件只留侧栏导航、面板切换与二级编辑器骨架。顺带删掉从未被引用的 `keyHint()` 与 `routing` 绑定。
- **导出面二次清扫**: 拆分后重跑死导出扫描, 又发现 **21 个只在自己文件内使用的 `export`** (audit-chain 三个常量、`MCP_SERVER_KEYS`、`INJECTION_PATTERNS`、`DEFAULT_AUDIT_THRESHOLDS`、catch-scan / graph 的六个内部函数、`applyBotAction`、`VIEWS`、store 的 `loadModels`/`loadPermissions`), 去掉多余关键字; `package.json` 的四个公开子路径不受影响。
- **浏览器实测** (本地 `PPX_PORT=8899` + CDP evaluate): 座椅卡打开、滑轨几何算出 thumb 111px / fill 137px / 档位「低」; 斜杠面板选中 `/model` 进设置弹窗, 模型面板渲染提供商卡 + 编辑器 (12 个内置预设、目录 2 行), 通用面板三个下拉值正确, 目录「添加/删除」行数 2→3→2; 权限卡列出三档并显示「可访问：PPXANS-Harness（仅此目录）」; 全程 console 无 error/warn。
- **验证**: 全量 **2634 测试 / 2628 通过 / 6 跳过**, `npm run lint`、`npm run verify` (18/18)、`npm run web:build`、`npm run web:check` 全绿。

### 结构精简: 时间线行为层 + 设置 store 按域拆分 (2026-11-13)

> 第二轮回访: 前端已无 500 行以上文件, 剩下两处是"逻辑与模板/请求混在一起", 拆开后各自只做一件事。

- **`webapp/src/chat/Timeline.vue` 525 → 380 行**: 滚动跟随 (近底部才自动滚 / 离底部浮「新内容」)、复制 (代码块与整条消息 + execCommand 兜底)、编辑重发、卡片文案 (工具名人话映射、思考摘要、结果折叠) 抽到 `chat/timeline/useTimeline.js` (171 行); 组件只剩模板与样式, 展开/折叠仍写 item 字段, 与拆出前同一个数据回路。
- **`webapp/src/stores/settings.js` 410 → 10 行桶文件**: 按域拆成 `settings/{state,providers,editor,quick}.js` (38 / 84 / 197 / 108 行) —— 共享状态与纯查询、提供商列表拉取与启停删、二级编辑器与目录拉取保存、本机模型一键接入各归其位; 21 个导出名逐一核对不变 (`node -e` 直接 import 桶文件比对), `SettingsModal` / `Onboarding` / `useModelPanel` 的 import 一行未改。
- **绑定完整性检查**: 用 `vue/compiler-sfc` 对 Timeline / Composer / SettingsModal 做 `compileScript(bindingMetadata) + compileTemplate`, 产物里 `_ctx.xxx` 未解析引用为 **0**, 确认模板里每个标识符都有 setup 绑定 (避免拆分后模板静默取到 undefined)。
- **浏览器实测** (本地 `PPX_PORT=8899` + CDP): 历史会话渲染出用户/Agent 卡, 「编辑」→ 取消回到气泡; 设置弹窗加载提供商卡与用量, 一键接入扫描如实回报「没发现本机模型服务」, 编辑器 12 个预设 / 4 行目录 / 密钥框齐全; 当前页 console 无 error/warn。
- **验证**: 全量 **2634 测试 / 2628 通过 / 6 跳过**, `npm run lint`、`npm run verify` (18/18)、`npm run web:build`、`npm run web:check` 全绿。

### 结构精简: 统计图表纯函数层 + 抽屉逻辑抽离 (2026-11-13)

> 第三轮回访: 前端所有 Vue 文件已降到 500 行以下, 这一轮处理的是"组件里混着可独立测试的算法"和"模板里塞着轮询调度"。

- **`webapp/src/views/StatsView.vue` 426 → 244 行**: 窗口补齐、Top5+其他、趋势折线、环形占比、热力格、KPI 与未定价提示全部搬到 `views/stats/derive.js` (194 行, 零 vue/DOM 依赖, 只 import 三个格式化函数); 组件只保留 ref/computed 包装、SVG 模板与样式, 顺带删掉从未使用的 `ui` / `showToast` 导入。
- **新增 `test/webapp-stats-derive.test.js` (8 个用例)**: 覆盖此前完全没有单测的图表数学 —— 窗口补齐/`all` 全量/370 天上限/空数据、Top5 合并「其他」、单点趋势 (`58.0,16.0`, grid 0→42)、环形图空值与填充段、热力 7 格/未来格 null/L4/三种模式、KPI 兜底、未定价提示文案。切图后可直接断言数字, 不再依赖肉眼截图。
- **`webapp/src/layout/Drawer.vue` 399 → 273 行**: 标签页/文件树过滤/开文件/工单详情/轮询暂停恢复抽到 `layout/drawer/useDrawer.js` (111 行), 递归文件树改为 `layout/drawer/TreeNodes.js` (45 行, `defineComponent` 渲染函数, 按扩展名着色); 组件只留侧栏、四个面板模板与样式, `reviewHtml` / `evolveSum` 两个展示计算仍在组件内。
- **绑定完整性检查**: `vue/compiler-sfc` 对 `Drawer.vue` / `StatsView.vue` 做 `compileScript(bindingMetadata) + compileTemplate`, `_ctx.xxx` 未解析引用 **0**。
- **浏览器实测** (本地 `PPX_PORT=8899` + CDP evaluate): 文件页 91 目录 / 455 文件, 过滤 `package.json` 精确剩 1 条, 点击后预览显示完整 `package.json` (name/version 5.1.0/许可证); 目标页渲染「目标看板」空态; 审查页渲染报告/验收/进化三段 (`启用 · 每 20 次提炼`); 任务记录页 13 条, 「失败」筛选剩 1 条, 点开详情显示 `process_restart (interrupted)` 与指派轮次; 当前页 console 无 error/warn。
- **验证**: 全量 **2642 测试 / 2636 通过 / 6 跳过**, `npm run verify` (18/18, README 机读数字同步为 337 个测试文件), `npm run web:build` (入口 817.04 kB / gzip 284.84 kB, StatsView 独立 chunk 14.08 kB), `npm run web:check`、`npx eslint .`、`node scripts/arch-guard.js --check` (依赖环 0 / 越层 0) 全绿。

### 结构精简: 对话 store 拆到桶文件 (2026-11-13)

> 第四轮: `stores/chat.js` 489 行是前端最后一个大文件, 里面其实是两件事 —— 一轮对话的发送/流式泵, 以及启动时的一堆只读状态查询。

- **`webapp/src/stores/chat.js` 489 → 14 行桶文件**: 发送/排队/SSE 帧分发/收口 (`chat/send.js`, 285 行) 与命令/模型/权限/运行状态查询 (`chat/runtime.js`, 207 行) 分家; 桶只做八组 `export *`, 组件 import 路径一行未改。
- **导出面核对**: `send.js` / `runtime.js` 与原有六个模块合计 **62 个唯一导出、0 重名**; 扫描 `webapp/src` 全部 `.js`/`.vue`, 组件实际从桶导入的 **38 个名字全部可解析**, `npm run web:build` 通过。
- **导出面第三扫**: 全仓扫描找到 **24 个零引用导出** (只在定义文件内使用), 去掉多余 `export` 关键字 —— `electron/seed.js` 的播种清单与三个内部函数 (主入口只 import `seedWorkspace`/`resetWorkspace`, 旧注释"主入口复用清单"已失真并一并修正)、`agent/plugins/builtin.js` 十个插件工厂 (仍按原顺序参与 `builtinPlugins` 装配, 只是不再单独对外)、`hasXMcpHeader`、`NPM_MANIFEST_BASENAMES`、`SCOPES`、`fallbackHostReply`、`scripts/` 四个工具内部符号。`dangerVerdict`、`PLACEHOLDER_RE`、`SAFE_TMP_ROOTS` 因文档明确描述为扩展入口而保留导出。
- **浏览器实测** (本地 `PPX_PORT=8899` + CDP): 启动后 `initChat` 正常补拉 —— 会话列表 5 条、席位 `deepseek-flash / 低`、权限档「工作区内修改」; 输入 `/help` 走本地命令短路, 时间线追加命令面板卡且输入框清空 (不触发任何模型调用); 点席位卡弹出「模型 / 思考强度」面板; 当前页 console 无 error/warn。
- **验证**: 全量 **2642 测试 / 2636 通过 / 6 跳过**, `npm run verify` (18/18)、`npm run web:build` (入口 817.05 kB / gzip 284.91 kB)、`npm run web:check`、`npx eslint .`、`node scripts/arch-guard.js --check` (依赖环 0 / 越层 0) 全绿。

### 运行噪音与重复实现: 计划缺失不留痕 + 去注释口径合一 (2026-11-13)

> 第五轮不是拆文件, 而是"同一条规则两处实现"和"预期缺失被当成异常"这两类长期噪音。

- **计划文件缺失不再记异常账**: `src/session/plan-live.js` 首次读取必然 ENOENT, 此前每次冷启动/`verify` 都留一条「关键路径异常留痕 1 条」; 现在只对坏 JSON/IO 错误调用 `noteCatch`, 常规运行摘要恢复干净 (实测 `verify` 不再输出该 warn)。
- **`stripComments` 收敛为单一实现**: `selfcode/graph.js` (字符扫描) 与 `selfcode/catch-scan.js` (正则) 各有一份"去注释但保留字符串"的扫描器, 正则版会把字符串里的 `//` 当注释切掉; 现统一到 `src/selfcode/source-text.js`, 依赖图与静默 catch 判定使用同一口径 (放在 selfcode 域内, 不占 utils 轻内核预算)。
- **新增 `test/source-text.test.js` (6 个用例)**: 行/块注释、URL 与模板串里的 `//`、转义引号、未闭合块注释、null 输入; 另补 `test/plan-live-catch.test.js` (2 个用例) 钉住「缺失不记、坏文件记一条」的边界。
- **文档对账**: `docs/TEST-MAP.md` 用 `node scripts/test-map.js --md` 重新生成 (339 文件 / 287 个 src 模块 / 199 个被直接 import, 69.3% 下界), `docs/PROJECT-OVERVIEW.md` 的测试规模同步为 2650 项 / 339 文件 / 287 个 src 文件。
- **验证**: 全量 **2650 测试 / 2644 通过 / 6 跳过**, `npm run verify` (18/18, README 同步为 339 个测试文件), `npx eslint .`、`node scripts/silent-catch-guard.mjs --strict`、`node scripts/arch-guard.js --check` 全绿。

### 死签名与格式化去重: 前端时间/词元格式化单一来源 (2026-11-13)

> 第六轮处理的是"函数参数留着但没人用"和"同一个格式化函数抄了两份"——都不影响行为, 但会让下一个改的人误以为这两处有关联。

- **前端格式化单一来源**: `stores/rail.js` 里的 `fmtTs` / `shortAgo` 与 `stores/fmt.js` 逐字相同, 现由 `SideRail.vue` 直接从 `fmt.js` 导入, rail 回归纯数据域 (顺手删掉 rail 里再也没人用的 `shortAgo`); `stores/chat/format.js` 的 `fmtTok` 与 `fmt.js` 同实现, 改为一行 `export { fmtTok } from "../fmt.js"`, 对话桶的导出面与 38 处调用路径不变。`fmtSize` 与 `fmtBytes` 语义不同 (空值返回 "" vs "0B"), 保留两处。
- **无效导入与死签名**: 删掉 `stores/admin.js` / `stores/panels.js` 里用 `void fmtBytes` / `void fmtMs` 硬挂着的死导入, 以及 `stores/bot.js` 那组没有任何消费方的格式化透传导出 (`fmtBytes` / `fmtMs` / `pct`, 各页面本就直连 `fmt.js`); 内核侧去掉 `_admitToolCall` 的第 4 参 `t0` (从未读取, 调用方与测试多传也无害)、`registerSandboxTools` 的 `rootDir` 选项 (沙箱无文件访问)、`_flushLegacy` 的 `_flushed` 参数 (2026-10-04 起判定已改看磁盘事实)、`work.js` 里 `const { id } = … ; void id;` 的占位解构, 以及 `electron/render-svc.js` 未使用的 `app` 导入。全仓 `void <ident>;` 占位语句清零。
- **技能副本同步**: `skills/ppx-memory/scripts/session.js` 是 `src/memory/session*.js` 的可独立拷出副本, 同步移除 `_flushed`; `test/skill-memory-drift.test.js` 的行为标记从 `void _flushed` 换成 `_flushLegacy` 的新签名, 51 项漂移守卫全绿。
- **验证**: 全量 **2650 测试 / 2644 通过 / 6 跳过**, `npm run verify` (18/18)、`npx eslint .`、`npm run web:build` (入口 816.79 kB, gzip 284.87 kB)、`npm run web:check`、`node scripts/arch-guard.js --check` 全绿; 本地 `PPX_PORT=8899` 打开页面, 侧栏 6 条会话正常渲染、Markdown 全局契约在场、当前页 console 无 error/warn。

### 遍历骨架单一实现: 四道脚本门禁共用一个递归 (2026-11-13)

> 第七轮把"同一个 readdirSync 递归写了四遍"收成一处。四份的差别只有扩展名、跳过目录、是否跳过点开头条目、读不了的目录是否容忍 —— 这些用选项表达, 递归与顺序不再各写一遍。

- **`scripts/lib/walk-js.js` 扩成 `walkFiles(dir, { exts, skipDirs, skipDot, tolerant })`**: `depcheck` (全树 .js/.mjs/.cjs, 跳过 9 个产物目录, 坏目录跳过继续扫)、`lexicon-check` (.js/.vue, 不跳格子, 根读不了直接失败不静默)、`test-map` (.js, 跳过 node_modules)、`analysis/dep-graph` (.js/.mjs, 跳过点开头条目) 四份本地 `walk(dir, out = [])` 全部删除; `walkJs` 保留为 `.js` 默认口径的回调版, arch-guard / native-guard 不改。
- **口径等价有实测**: 临时对照脚本用旧实现与新骨架在四组选项下逐项比较 —— depcheck 762 个文件、lexicon 68 个、test-map 287 个、dep-graph 287 个, **文件集合与顺序完全一致**; `node scripts/test-map.js --md` 与 `docs/TEST-MAP.md` 表格逐字节相同, depcheck 报告 762 个文件、lexicon 0 命中。
- **新增 `test/walk-js.test.js` (6 个用例)**: 默认只收 .js 且点开头条目不跳、扩展名过滤、`skipDirs` 只作用于目录项、`skipDot` 连点文件一起跳、两次遍历逐项一致 (门禁输出稳定性的前提)、坏目录默认抛出而 `tolerant` 返回空、`walkJs` 与默认口径一致。
- **文档对账**: README 机读锚点与散文同步 (2656 项 / 340 个测试文件), `docs/TEST-MAP.md` 重新生成 (340 文件 / 287 个 src 模块 / 199 个被直接 import, 孤儿测试 26 个), `docs/PROJECT-OVERVIEW.md` 五处数字同步。
- **验证**: 全量 **2656 测试 / 2650 通过 / 6 跳过**, `npm run verify` (18/18)、`npx eslint .`、`node scripts/arch-guard.js --check` 全绿。

### 出站抓取与退出链路: 跨源重定向剥离凭据 + 响应体上限 + SIGTERM 收口 (2026-11-12)

> 抓公网内容的链路此前有两处没有边界: 手动跟随重定向时原样转发凭据头, 响应体整包进内存; 而 `ppx serve` 只挂 SIGINT, daemonStop 发的 SIGTERM 直接终止进程。本轮全部收口, 并顺手对账 2026-11-08 精简后的文档残留。

- **跨源重定向丢凭据** (`src/tools/net-guard.js`): `_fetchWithSsrSafe` 手动逐跳跟随重定向, 但每跳复用同一份 headers —— 公网 URL 302 到攻击者域名即可拿走调用方的 `Authorization`/`Cookie`/`Proxy-Authorization`。新增 `stripSensitiveOnCrossOrigin` (fetch 规范同款语义, origin 比对, 大小写不敏感, URL 解析失败从严剥离), 跨源跳转前剔除; 同源 (scheme+host+port) 保留。
- **响应体无上限** (`src/utils/http-proxy.js`): 原三条抓取路径 (pinnedFetch / 原生 fetch / curl) 都把正文整包读进内存, 公网页面或被投毒接口返回 GB 级内容即可打爆 agent 进程。新增 `DEFAULT_MAX_BYTES` (16MB) 与 `init.maxBytes` 覆盖: pinnedFetch 改为**流式 zlib 解压 + 截断即断开** (解压炸弹同受约束), 原生 fetch 用 ReadableStream 读到上限即 cancel, curl 路径按字节截断; 返回值补 `truncated` 标记, 三条路径口径一致。大文件流式下载走原生 fetch, 不受影响。
- **SIGTERM 直接终止进程** (`src/server.js`): `services/daemon-control.js` 的 daemonStop 发 SIGTERM, 而 `runServer` 只挂 SIGINT —— daemon 停止时通道不关、军团子进程不回收、记忆不落盘。抽出幂等 `createGracefulShutdown`: `manager.stop()` → `agent.shutdown()`, 重复信号只跑一次, 4s 超时强制退出 (赶在 daemonStop 的 5s SIGKILL 前); `runServer` 同时注册 SIGINT 与 SIGTERM, 并把 shutdown 挂到返回值上便于外部触发。
- **文档对账**: README `verify (14 项)` → 17 项、钩子链六 → 七事件 (补 PostCompact)、集成段插件路径 `plugin/*` → `agent/plugins/*` 并删除已移除的 rollout/parts 描述、目录树 session 行按现状重写; `ARCHITECTURE-CURRENT` 的 session 行 (rollout JSONL/fork/rewind) 与 `sessions/*.jsonl` 落盘口径、hooks 七类; `PROJECT-OVERVIEW` 内置插件 13 → **15** 个并补 legionBoardPlugin; `THIRD-PARTY-SOURCES` 的 `seam/registry.js` 引用改为现存的 `plugin/context.js` + `tools/seam.js`。README 机读锚点随新测试文件同步 (334 文件 / 2626 测试)。
- **回归守卫**: 新增 `test/http-outbound-guard.test.js` (跨源剥离含代理链路端到端、三条路径的截断、gzip 截断) 与 `test/graceful-shutdown.test.js` (顺序/幂等/stop 失败/超时)。全量 2626 测试 / 2620 通过 / 6 跳过, `npm run lint`、`guard:catch` 与 17 道 verify 门禁全绿。

### 并发/安全/跨进程: 元数据合并 + 事实导入去重 + SSRF DNS 锁定 + 虚拟工具准入 (2026-11-12)

> 第三轮体检的剩余高价值缺陷: 多进程写元数据互相覆盖、事实导入不分 scope 且墓碑拦内容、嵌入串行、MCP 管理工具绕过权限、DNS rebinding TOCTOU、并发流式记账串账、跨会话降级提示/推理草稿串味。

- **会话元数据跨进程覆盖** (`src/memory/session-meta.js`, `src/memory/session.js`): 归档/置顶/标题三份 JSON 各自手写固定 `.tmp` 落盘 —— 两进程并发写时同名临时文件互踩, 且整表回写会覆盖对方新增的 key。改为 `withFileLock` + 唯一临时后缀的 `atomicWrite` + **基线 diff 合并** (base→current 的增删改套到新鲜磁盘内容上), 删除仍按「current 缺失即删」传播; 损坏文件不再静默归一成 `{}`, 改备份为 `.corrupt-<ts>`。技能副本 `skills/ppx-memory/scripts/session.js` 同源跟进。
- **事实导入丢语义** (`src/memory/fact-store-governance.js`, `src/memory/fact-store-normalize.js`): `importAll` 用 `_live()` 内容集去重却把墓碑也计入, 且忽略 scope —— 同文不同 scope 被误并, 忘掉后再导入又被旧墓碑拦住。改为 active 行按 `scope+内容` 对活跃集去重、墓碑行按 id 幂等; `_normalizeFact` 保留 `archivedAt`/`supersededBy`, 迁移后墓碑清理顺序不乱。技能副本同步。
- **嵌入逐个 RTT** (`src/memory/fact-store-embed.js`): 记忆检索逐条 `await _embedFor`, N 条事实就是 N 个串行往返。新增 `_embedMany` 有界并发 (8 路, 产出顺序与输入一致); `querySemantic` 改走批量向量再逐条打分。技能副本同步。
- **MCP 虚拟工具绕权** (`src/mcp/server.js`, `src/mcp/admin.js`): `createAdminTools` 注入的 `ppx.*` 工具走 `extraTools` 分支, 直接 `execute`, 绕开 `_runTool` 的只读闸门与 deny 规则。新增 `_admitVirtualTool`: readonly 模式只放行 `readOnly` 工具, 权限引擎 deny/fail-closed 生效; 给 7 个纯读管理工具补 `readOnly`, 并在 `tools/list` 透出 `annotations.readOnlyHint` (Claude 客户端据此判断免审批)。
- **SSRF DNS rebinding TOCTOU** (`src/tools/net-guard.js`, `src/utils/http-proxy.js`): `assertPublicUrl` 校验 DNS 后 fetch 再解析一次, 攻击者可在两次解析间把域名指向内网。现在 `assertPublicUrl` 返回已验证 IP, 由自研 `pinnedFetch` 直连该地址 (Host 头与 TLS SNI 仍用原域名), 逐跳重定向照旧校验; 同步补 gzip/deflate/br 解压, 防止压缩体绕过内容扫描。
- **MCP 头体一致性** (`src/mcp/http.js`): 现代协议要求 `Mcp-Method`/`Mcp-Name` 头与 body 一致, 此前只校验 `MCP-Protocol-Version`。补齐两项, 不一致回 400 HEADER_MISMATCH (防中间层按头路由、按体执行的错配)。
- **并发流式记账串账** (`src/llm/client.js`, `src/agent/usage.js`): `__ppxStreamUsage` 单槽被并发 `streamChat` 互相覆盖, 用量记到别人头上。改为按调用注入 `__ppxUsageSink` 回调 (保留旧槽位兼容); sink 异常走 `noteCatch` 留痕。
- **跨会话状态串味** (`src/agent/index.js`, `src/agent/bootstrap.js`): `_lastFallback`/`_lastReasoning` 是单字段, 两个会话并发时降级提示与推理草稿会串到对方回复。改为按 `sessionKey` 的 Map (惰性创建, 上限 128, 超限逐出), 通过 getter/setter 保持旧字段读写面不变。
- **回归守卫**: 新增 `test/session-meta-concurrent.test.js`、`test/fact-embed-parallel.test.js`、`test/ssrf-pinned.test.js`、`test/turn-state-session.test.js`; 扩展 `test/memory-governance.test.js`、`test/mcp-admin.test.js`、`test/mcp-server.test.js`。全量 2614 测试 / 2608 通过 / 6 跳过, `npm run lint`、`guard:catch --strict` 与 17 道 verify 门禁全绿。

### 架构巡检: 入口/观测/审查链修复 + 死导出清理 (2026-11-12)

- **review_code 按文件审查恒空** (`src/review/index.js`): 调用方普遍显式传 `diff: null`, 旧判断 `diff !== undefined` 把 null 当 diff 源, `files` 被整个忽略 —— 工具与 `POST /api/review` 的按文件审查从未真正读过文件。改判 `typeof diff === "string"`。无参兜底的「最近写过的文件」同时修正 (`src/tools/v3.js`): 不再把 `"write_file"` 当日期传给 `traces.read`, 并从脱敏/截断的 args 字符串里取 path; 新增 `test/review-code-traces-fallback-2026-11-12.test.js` 钉住。
- **打包启动器命令行坏引号** (`scripts/package.js`): 生成的 `ppx-web.cmd` 末尾多一个 `"`, cmd 会把 `web"` 当子命令交给 CLI, 便携版快捷方式起不来; 去掉多余引号。
- **轨迹统计口径** (`src/utils/trace.js`, `src/web/bot-view.js`): `stats()` 只统计 `tool/call`, 不再把 turn/step 边界事件算成失败调用 (假失败率 / `tool=undefined` / NaN 耗时); 面板改为单次扫描, 无边界事件时 `turns` 如实给 null。
- **Electron 权限处理器漏参** (`electron/main.js`): `isAppUrl(wc.getURL())` 少传 `appUrl` → 麦克风/通知请求一律被拒; URL 判等同时收紧为同源比较 (`electron/window-state.js`)。
- **daemon 入口失效** (`src/services/daemon-control.js`): 单一 CLI 后仍 spawn 已删除的 `bin/ppx-serve.js`; 改拉 `bin/ppx.js serve`, 并补参数常量。
- **死导出清理**: 删除无任何引用的 `jsSyntaxCheck` / `settingsSchema` / `disabledTools` / `getProvider` / `isDangerous` / `relOf` / `__internal` / `runSelfIteration` / `WORKSTACK_STATUS` / `getTokenEstimator`; 三份 `clip` 实现收敛到 `src/utils/text.js`。README 散文正则删掉三条已不存在的句式 (对应数字仍由机读锚点守)。

### 计费准确性: 价格表重写 + 流式记账补洞 + 未定价可见化 (2026-11-12)

> 实测账本 250 次调用 / 4.03M tokens 只记了 $0.08 —— 其中 232 次 `deepseek-flash` 全程 $0。原因不是用量丢了, 是价格表停在上代模型名上, 且未知价格被静默折算为 0。

- **价格表重写** (`src/llm/pricing.js`): 覆盖 DeepSeek 现役 `deepseek-flash`/`v4-pro`（工作日峰谷 `peak`, 高峰 2 倍）、GLM-4.7（免费档/缓存价/≥32K 输入阶梯）、Qwen-Plus 阶梯、Moonshot、Claude 3.x（族名在型号后, 此前全落未知）、`vendor/model` 形式回落段名匹配。国内厂商直接抄 CNY 目录价 (`currency: "CNY"`), 统一按 `PRICING_META.cny_per_usd` 折算 USD, 表可审计。
- **流式记账补洞** (`src/agent/usage.js`): 无 usage 的流式轮次此前把 `{}` 传给 `estimateCost` → 金额恒 0, 预算闸门对纯流式路径完全失明。现按输入(消息体)+输出(回复文本)分别估算入账, 缓存命中按 `cached` 单价计费并夹逼到输入量。
- **未定价可见化**: 未知价格仍**不编数字**, 但写入账本 `unpriced`、进程内每模型告警一次, 并透出到 `/api/usage/stats`、`/api/run-state`、`/api/health/summary` 与「使用统计」页/底部状态条; 本地端点 (127.0.0.1/localhost) 不算未定价。新增 `budget.assume_price` 兜底单价, 让私有网关的预算闸门仍然有效。
- **门禁**: 新增 `scripts/pricing-audit.js`（打印全表 + 核对云端预设覆盖; `--check` 已接入 `npm run verify`, 现 17 道）。配置默认值补 `budget: { usd, model_prices, assume_price }`, `config/ppx.json.example` 补同名示例块（发版模板开箱可见）, 并在 `docs/CONFIG.md` 补节。

### 优化轮: 门禁回绿 + 安全收口 + 架构精简 (2026-11-08, 评估驱动)

> 独立评估报告驱动的修复轮。三批次: 回绿 → 安全 → 精简。全程 verify 16 道门禁可复跑。

### 回绿 (此前 HEAD 门禁红)

- **prefix-cache 测试 C/D 机器相关修复**: 两测试曾用 `root: process.cwd()` —— 开发机 `data/` 与 `.ppx/plan/` 的带时间戳工作数据泄漏进静态区 (仓库自身"最近进度"含模型自写的分钟精度戳, 2026-10-30 起就红着)。改为全 tmp root + seed 技能, 机器无关。
- **pwf 剥离正则放宽** (`src/planning/pwf.js`): 原 `MACHINE_STAMP_RE` 要求秒位, 漏掉模型经 plan_files 自写的分钟精度戳 (`2026-11-08T14:49Z`); 放宽为 T+HH:MM 起步, 行中/纯日期的用户文字不剥。新增 `test/pwf-summary-strip.test.js` 钉住三种精度形态。
- **eviction.js 两处吞错补 noteCatch** (`src/memory/eviction.js:49,63`), silent-catch-guard --strict 回绿。
- **cache-audit 探针根隔离** (`scripts/cache-audit.js`): 机制审计曾直接以仓库根为 agent root, 开发者 `.ppx/plan/` 里的历史日期 (事实内容) 周期性打红 volatile_isolation; 改用固定名隔离探针根 (ppx-probe-root, 刻意避开 mkdtemp-dir 模式), 负例夹具 (volatile-clock/static-drift) 仍可证伪地红。

### 安全收口 (评估报告 #3/#4/#7)

- **白名单命令组合逃逸收口**: `.git/` 一律拒写 (write/append/delete/move/apply_patch 五通道, `sensitiveWriteHint`); 本会话写过 package.json/lockfile 后 npm/pnpm/yarn/npx 执行即拦 (scripts 植入连招); 会话脚本拦截解释器词表扩面 (sh/bash/python/powershell + .sh/.py/.ps1/.bat/.cmd)。
- **browse SSRF 缺口**: 兜底直抓由 `redirect:"follow"` 无校验改为复用 fetch_page 同源防线 (`assertPublicUrl` 导出 + `_fetchWithSsrSafe` 逐跳校验); 桌面渲染通道属设计内能力, 注释声明边界。
- **provePatchTargets realpath 纵深** (`src/permissions/path-guard.js`): apply_patch 落点判定补 realpath 层, 根内 symlink 指根外不再免审批直通 (与 findEscape 同款二段判定)。

### 架构精简 (务实刀法)

- **plugin 装配器归位**: `plugin/builtin.js`(427 行)+`plugin/v3.js`(93 行) 搬至 `src/agent/plugins/`; `plugin/` 只剩纯 L0 DI 容器 (context.js+index.js, 264 行)。arch-guard 基线越层 **agent→plugin 清零** (全仓唯一一条), plugin 内核预算 880→400。native-provenance 落点同步。
- **日志双轨收敛**: 库代码 12 文件 ~24 处 console.* 换 logger (channels/utils/tools/agent); 保留 fact-store 独立版、入口文件、PPX_VERBOSE 调试口 (逐处注释登记)。
- **私有 JSON/原子写收敛**: selfcode/engine atomicWrite、selfcode/graph readJson、services/diagnose readJson、skills/loader readJsonSafe → 唯一实现 utils/store.js (获得 Windows EPERM 退避等已修好的落盘原语)。
- **electron 安装包瘦身**: build.files 移除 test/**、bench/**、fixtures/**、references/** (开发资产不进安装包; npm publish 的 files 字段本就不含)。

### 文档对账

- README 第二层散文数字全部对齐实测 (77→105 内置 / 103→105 注册 / 318→316 测试文件 / 24→22 设计来源 / bin 清单 / public→webapp); README.en.md 版本 4.3.0→5.0.0; PROJECT-OVERVIEW 横幅与 ARCHITECTURE-CURRENT 标题补 v5.0。

### PC 客户端启动失败修复 (bin 合一回归)

- **常驻子命令"就绪即退"** (`src/cli.js`): bin 收敛重构把原始 `bin/ppx-web.js` / `bin/ppx-serve.js` 并入单一 CLI 时, 给 serve/web 分支误加了 `process.exit(0)` —— ESM import 在模块体执行完即 resolve (不等事件循环), 而内核常驻靠事件循环句柄 (HTTP 监听/定时器) 而非 pending promise。结果: 内核 200ms 内完成启动、打印横幅后立刻退出, 桌面端 waitReady 探到子进程消失, 误报"服务未在 60 秒内就绪" → **PC 客户端启动失败**。修复: serve/web 分支去掉 exit、启动后停驻 (退出走信号 //desktop/shutdown 优雅链), 与原始 bin 薄壳语义逐字一致; mcp 分支经核实有真 stdin await, 不受影响。
- 新增 `test/cli-resident-web.test.js`: 拉起真实 `ppx web` 子进程, 钉住"就绪后进程仍存活"—— 此前该回归能溜过所有单测与门禁 (只有 desktop:smoke 能抓到)。

## 5.0.0 (2026-11-08) · 打碎重铸: 前端 Vue3 框架化 + 最强 agent 强化

> 大版本。两条主线: ① 前端打碎重铸 (Vue3+Vite 构建链, 视觉全面翻新); ② 核心 Router/Worker 强化 + 记忆上下文升级 + 新工具面。

### 前端 (webapp/, 旧 public/ 退役)

- **Vue3 + Vite 构建链**: 40+ SFC 组件 + 响应式 store, 替代 8 个 window 全局 IIFE 单体 (3532 行 app.js 拆干净)。发布产物仍零运行时依赖 (dist 预构建入库, npm ci && npm start 无需构建)。
- **时间线数据化**: 消息/工具卡/审批/提问全部从 "DOM 即状态" 改为 store 数据, 轮询重绘不再吞焦点。
- **接入 /events SSE 总线**: 审批/提问/工单/生命周期/计划实时推送 (旧前端从未消费过这条服务端早已建好的总线), 轮询收敛 (审批 25s / 生命周期 45s 兜底)。
- **真双主题**: [data-theme] CSS 变量驱动, 废除 223 处 .ppx-white-shell 硬编码覆盖层。
- **设置写路径统一**: 审批/沙箱旋钮只走一条路径; 站内确认弹窗全站唯一入口。
- 工单详情展示信封 v2 交付物; /events plan_updated 实时渲染回合内计划卡。
- 门禁迁移: check-web v2 (构建产物 + Vue 源码扫描), 7 个跨端契约测试改锚 webapp/, vendor 固化体系退役换 npm devDeps。

### 核心 (最强 agent)

- **Worker 热池** (agent.legion.pool_size, 默认 2): 预热常驻委派 worker, spawn_agent 接管热进程免冷启动; 只读委派不混用; 空闲 15 分钟自动回收。
- **信封 v2**: worker 汇报新增 commands/artifacts (实际执行的命令 + 写盘产物), 随工单账本落账、API 透出、UI 工单详情展示 —— "说了做"有硬证据可核。
- **合并批逐条回信**: Router 批处理不再共享一条回复 —— 模型按 [[回复 #n]] 分段作答, 各回各的消息 (IM 各回各的发送者); 缺标记回退整批共享 (旧行为兜底)。
- **链式召回二期**: 被裁历史与压缩原文全文归档 spill (确定性 id), context_read 续读; 摘要事件持久携带续读指针 —— "历史找不回"从死路变两级可续读。
- **真 token 预算**: history_token_budget / max_history_items / tool_result_budget 支持 0 = 随 provider 真实窗口自适应 (128K 窗口 → 历史预算 24K tok / 80 条 / 工具结果 8K 字符), 大窗口模型上下文利用率 ~3% → ~30%。
- **新工具**: browse (桌面 Chromium 渲染优先 + 直抓兜底, 标题/正文/链接/截图)、update_plan (回合内计划, core 常驻下发, EQ 实时推 UI)、5 段 cron 调度 (add_schedule 支持 "*/15 * * * *", 跨重启恢复重排)。
- Router/Worker 双层: 新装默认开启 router_role (config/ppx.json.example), 开发仓默认保守关闭 (测试基线安全), 两键即启。

### 兼容与门禁

- 全量 2611 项测试通过 (新增 16 项 v5 直测); verify 16 项门禁全绿; eslint 0 errors。
- HTTP API 契约不变 (会话字段 key/sessionId 字面量继续被测试锚定); 静态根切 webapp/dist (public/ 不存在时回退旧路径的能力随 public/ 一并退役)。

## 4.5.0 (2026-11-05) · DSH 吸收 Step 9 (可替换状态后端 / SQLite 账本)

工单账本此前只能写 `tickets.jsonl`。Step 9 把"读到全部事实 / 追加一条 / 压缩重写 / 关闭"
抽成后端接口，为存算分离打掉第一块硬约束。默认 `jsonl` 逐字不变；显式配置可切到
`node:sqlite`（WAL、事务压缩）。换的是事实存在哪，不是事实是什么。默认关闭（即默认仍
JSONL），不加载 SQLite 模块、不弹实验特性告警。

- **后端抽象**：新增 `src/workgraph/journal.js`；`store.js` 的启动折叠、追加、压缩、关闭
  全部经由 `journal`。所有后端产出同一组事实，走同一个折叠函数。
- **JSONL（默认）**：`tickets.jsonl` 追加、坏行跳过、压缩用临时文件 + 原子 rename，与
  抽离前逐字一致。
- **SQLite（可选）**：`tickets.sqlite3` 单表 `journal(seq, at, body)` +
  `PRAGMA journal_mode=WAL` / `synchronous=NORMAL`；压缩在 `BEGIN IMMEDIATE … COMMIT`
  内完成，失败 `ROLLBACK` 后抛原错误。`node:sqlite` 惰性加载，需 Node >= 22.5；
  显式选择但不可用时启动即报可读错误，不静默回落。
- **配置**：`agent.work_graph.state_backend`（默认 `"jsonl"`）。
- **观测**：`stats()` 新增 `journalKind`。
- **边界**：只覆盖工单/指派账本；检查点在任何后端下仍是 per-assignment JSONL；切换后端
  不迁移旧账本（旧文件原样保留）；单写者假设不变，SQLite WAL 不承诺多进程同时写。
- 文档：`docs/WORK-GRAPH.md` §2/§6/§7/§8；`docs/CONFIG.md`；`docs/dsh-absorb/03` 新增 I23；
  `docs/SUPERAGENT-GAP.md` §十六。
- 测试：新增 `test/workgraph-step9.test.js` 6 项（JSONL 逐字/SQLite 往返/压缩等价/未知后端/
  坏行/检查点旁路）；全量 2549 用例 2543 过 / 0 挂 / 6 跳过；`npm run verify` 16/16；
  变更文件 eslint 0 error；README 数字锚点同步。

## 未发布 (2026-11-04 ~ 11-05) · v5.0 重铸批次 (DSH 吸收 Step 5a-8 / 调度闭环 / Router 分层)

### ·DSH 吸收 Step 8 (任务级外部看门狗 / 人工接管) (2026-11-05)

进程内 watchdog 与主服务同生共死：主进程卡死、事件循环被长任务占满时，它自己也不会
心跳。Step 8 把**任务级**监督移出进程 —— 只依赖 HTTP 只读接口即可判定停滞/漂移，
默认只报告；只有显式 `--act cancel` 才做受上限约束的人工接管。不新增配置项、不改主
链路行为，服务端只加了一个默认关闭查询参数。

- **独立控制面**：`src/ans/external-watchdog.js` 提供纯函数 `evaluateTickets` 与可注入
  fetch 的 `createExternalWatchdog`。判定口径复用进程内看门狗的 `detectWorkerDrift`，
  不另写一套漂移定义；工单列表按 `GET /api/tickets?status=working,waiting&limit=200&assignments=1`
  拉取。认证优先 `--token` / `PPX_AUTH_TOKEN`，缺失时读 `/api/bootstrap`（仅回环请求下发）。
- **默认只报告**：`pollOnce()` 无 `act` 时绝不发写请求；报告含 `level(ok/warn/crit)`、
  在跑/等待计数、停滞工单（闲置分钟）、漂移工单（`tool_repeat`/`round_spin`）与阈值。
- **受约束的人工接管**：`--act cancel` 才 `POST /api/tickets {op:"cancel"}`；单次受
  `--max-actions`（默认 1）上限，同一工单停滞 + 漂移只处置一次，不重跑、不批量清理。
- **CLI**：`npm run watchdog:external`（`scripts/external-watchdog.mjs`）支持单次/`--watch`
  常驻、`--json`、阈值参数；退出码 `0` 健康 / `1` 有发现 / `2` 配置、请求或认证错误，
  便于 cron 与外部监控直接消费。
- **服务端增补（加法式）**：`GET /api/tickets?assignments=1` 才为每张工单附加当前指派的
  `rounds/steps/tools/lastTool/replaySafe` 等字段；不传该参数时响应逐字不变。
- **边界**：外部看门狗的处置只有"取消"，没有重跑/重启/改配置；它看到的是 API 快照，
  不读取进程内存，因此进程完全无响应时只能报告请求失败（`crit`），存活判定仍归
  Electron 主进程/系统层。
- 文档：`docs/WORK-GRAPH.md` §5/§7/§8；`docs/dsh-absorb/03` 新增 I22；
  `docs/SUPERAGENT-GAP.md` §十五。
- 测试：新增 `test/external-watchdog.test.js` 7 项（纯判定/令牌引导/只报告/上限与去重/
  结构化错误/CLI 退出码）；全量 2543 用例 2537 过 / 0 挂 / 6 跳过；`npm run verify` 16/16；
  变更文件 eslint 0 error；README 数字锚点同步。

### ·DSH 吸收 Step 7 (工具级检查点 / 断点续执行) (2026-11-05)

Step 6 让"整轮没碰过副作用"的 working 工单可以安全重放，但重放从任务开头重跑：
读过的文件、查过的数据、跑过的只读命令全部再来一遍。Step 7 在显式开启时补上
"跳过已完成的只读步骤"，同时不让检查点变成第二套账本。默认关闭
(`resume_checkpoint=false`)，关闭时不建目录、不写盘、不注入提示，行为与 Step 6 逐字一致。

- **检查点**：`resume_started=true && resume_checkpoint=true` 时，`_runTool` 把
  **只读或显式幂等**工具的执行结果写入 `<dataDir>/workgraph/checkpoints/<assignmentId>.jsonl`
  （一行一调用，`key=sha256(工具名 + 规范化参数)`，键排序；结果截 4KB，每指派上限 500 条）。
  有副作用的调用从不记录。`_toolReplaySafe` 与 Step 6 写前标脏共用同一判定。
- **续跑上下文**：replay 路径从旧指派读检查点构建 `resumeCtx`，经 `chatAsync → chat →
  _chatCore` 挂到本轮；提示块注入 user wire 尾部（与 L2 分流提示同机制），会话历史
  按含提示的 wire 落库。带 `resumeCtx` 的轮次**绕过 Router 合并车道**（续跑不能与用户
  追打的文本合并）。
- **复用**：`_runTool` 在准入之后、执行之前按同一 key 查本轮复用表；命中且工具名一致
  直接返回上次结果并追加 `[断点续执行]` 标注，不再执行；复用结果同时写入新指派检查点，
  二次中断仍可继续。复用表按会话键隔离，轮末清除。
- **生命周期**：检查点是旁路文件，不是账本事实；工单终态（done/failed/cancelled）、
  `markInterrupted`、`prune` 时删除，`stats().checkpoints` 暴露开关状态。缺失/损坏只
  导致回到 Step 6 的从头重放。
- **边界**：恢复粒度是"整次工具调用"，不是指令/沙箱级续执行；复用只按 key 匹配，
  外部依赖变化时仍返回上次结果（需新鲜数据时改参数或关闭开关）；`waiting` 子进程执行
  没有父进程检查点。
- 配置：`agent.work_graph.resume_checkpoint`（默认 false，依赖 `resume_started`）。
- 文档：`docs/dsh-absorb/03` 新增 I21；`docs/WORK-GRAPH.md`、`docs/CONFIG.md`、
  `docs/SUPERAGENT-GAP.md` §十四。
- 测试：新增 `test/workgraph-step7.test.js` 10 项；全量 2536 用例 2530 过 / 0 挂 / 6 跳过；
  `npm run verify` 16/16；变更文件 eslint 0 error；README 数字锚点同步。

### ·DSH 吸收 Step 6 (无副作用证据的安全重放) (2026-11-05)

Step 2 的启动恢复只放行「admitted 且从未 begin」；working/waiting 一律标 interrupted。
本轮把自动恢复推进到 working 的一个可证明安全子集 —— 不靠猜工具做了什么，而是把安全
前提变成**写前事实**。默认关闭 (`resume_started=false`)，关闭时行为与 Step 5b 完全一致。

- **写前标脏**：`_runTool` 在真正执行前读取工具能力：`readOnly=true` 或显式
  `idempotent=true` 不改事实；写文件/命令/网络/记忆写入/spawn 等有副作用工具立即把当前
  assignment 标成 `replaySafe=false` + `replayUnsafeTool`。单向锁，任何补丁不能改回 true。
- **fail-closed**：标脏写盘失败时**拒绝执行**该有副作用工具（账本不可用 = 无法保证崩溃后
  不重复副作用）；只读工具与不在工单执行中的调用不受影响。
- **旁路覆盖**：L1 规则直调（`memory_add` / 规则动作 `tool`）不经 `_runTool`，同样在执行前
  标脏；会话键未知时保守标脏全部在途指派，有明确会话键时只标本会话。
- **恢复判定**：`recover({resumeStarted})` 额外保留 `working` 且 `assignment.replaySafe===true`
  的工单；旧指派收口为 `failed(interrupted)`，工单留在 working 等新指派接管。
  `waiting`（长驻 worker 在子进程执行）、`replaySafe=false`、旧账本缺字段、超龄/超限
  一律仍只标记。恢复候选与 `markInterrupted` 同口径，只收**其他实例**的工单 ——
  本进程还在执行的活指派绝不会被收口重跑（防双执行）。
- **消费**：`resumeUnstartedTickets()` 支持 `resumeKind=replay`，新指派 worker 记为
  `router:replay`；消费前复查工单仍在 working 且旧指派仍 replaySafe，取消/人工处理后不抢跑。
- **边界**：重放生成新 assignment 从任务开头重跑，不是断点续执行；会重复只读 I/O 与模型
  调用，但不会翻倍副作用。
- 配置：`agent.work_graph.resume_started`（默认 false），与 `resume_unstarted` 共用
  `resume_max_age_ms` / `resume_limit`。
- 文档：`docs/dsh-absorb/02`（矩阵与 §5/§7）、`03`（I9/I15 修订 + 新增 I20）、
  `docs/WORK-GRAPH.md`、`docs/CONFIG.md`、`docs/SUPERAGENT-GAP.md` §十三。
- 测试：新增 `test/workgraph-step6.test.js` 12 项；全量 2526 用例 2520 过 / 0 挂 / 6 跳过；
  `npm run verify` 16/16；变更文件 eslint 0 error；README 数字锚点同步。

### ·DSH 吸收 Step 5b (ANS 车道运行) (2026-11-05)

Step 5a 只归一化了 `ans_lane.v1` 配置，proactive/watchdog 仍全通道广播。本轮把车道接上，
**默认关闭**：`enabled=false` 时继续 `manager.broadcast`，行为逐字不变（I1）。

- 新增 `src/channels/ans-lane.js`（L3）：`createAnsLane` → `handles/notify/submit/stats`。
  - notify：只投显式 `targets`，不建工单、不产 ticket/assignment（I16）；async 走投递队列
    （重试/TTL/WAL 续投），sync 复用同一份回执实现并受 `deadline_ms` 硬超时；
  - submit：经 `agent.chatTracked → workgraph.submit` 建单（origin/cause=ans），
    命中账本去重不重复执行，结果/失败文本按同一目标表回投并携带工单身份；
  - 去重：显式 key 优先；`period_bucket` 按 `<prefix>:<source>:<bucket>`，按目标拆分幂等；
  - 限流：按 `(source, 通道)` 的 `min_interval_ms` / `max_per_hour`，超限丢弃计 dropped；
  - 通道未启动 → 跳过并告警，不隐式改投其它通道。
- 回执身份扩展（只增不改）：工单路径仍是 `(assignmentId, attempt, state)`；ANS notify 用
  `(deliveryId, attempt, state)`，多目标 submit 时 `deliveryId` 优先，避免 sink 间互相覆盖。
  `delivery.js` 新增 `sendSyncJob`，sync 与 async 共用一份 `receipts`。
- 安全：`extra_deny_tools` 在 submit 会话内加严准入（`_admitToolCall` 读取会话级黑名单），
  只叠加、不改全局；`internal_only` 仍恒为 true。
- 接线：`server.js` 按 `ansLane.handles(source)` 分流 proactive/watchdog；默认关闭路径不变。
- 文档：`docs/SUPERAGENT-GAP.md` 新增 §十二；`docs/dsh-absorb/00,03,04` 写清 ANS notify
  无工单时的回执身份；顺手清理"投机执行仍待做"的过期表述（实现见 §七）。
- 测试：新增 `test/ans-lane-step5b.test.js` 15 项；投递/回执/工单回归继续通过。
  全量 2514 用例 2508 过 / 0 挂 / 6 跳过；`npm run verify` 16/16；变更文件 eslint 0 error；
  README 数字锚点同步（tests 2514）。

### ·架构对齐审计修复 (隐私 / 调度事实 / 入口 / 外部监督) (2026-11-05)

对照 DeepSeek Super-agent 五柱做了一次只读审计，核实出六处"承诺与实际不一致"或"只覆盖一半"。
本轮逐项修复；Router 角色仍默认关闭，不改变任何既有对话的模型调用次数。

- **P0 审计链正文脱敏**：`scrubArgs` 此前只掩码密钥/手机号，`spawn_agent` 的 `task`
  以及 `message/content/prompt/reply` 等正文字段会整段进 `audit.ndjson`，与
  "任务正文永不入链"的文档承诺相悖。现按字段折叠为
  `[正文已脱敏 N字符 sha256:<16hex>]`（保留可比对摘要、不可逆推），数字/布尔保留原类型，
  其余字段继续做密钥/URL 凭证/手机号掩码。
- **P1 Router 内联决策**：此前只有分派才记 `router_decision`，最常见的"不分派、直接回答"没有事实。
  现在开轮记归属、轮收口补一条 `route=inline`（`answered_inline` / `turn_aborted`），
  已分派/驻派的轮不重复记。
- **P1 话题 Worker 汇报**：`ThreadBridge` 增 `onReport`，首任务与每次直通的成功/失败都产
  `worker_report (route=thread)`，直通携带 `ticketId/assignmentId`；报文白名单，不含话题正文。
- **P1 高级编排逐 Worker 建单**：新增 `beginWorkerRun`（team / supervisor / review / team-room 共用）：
  建单 → `router_dispatch` → complete/fail + `worker_report`，与 `spawn_agent` 直派同口径；
  `finish` 幂等，账本/审计缺失时全部降级。
- **P1 无通道入口统一建单**：新增 `agent.chatTracked`；MCP `ppx.chat.send/stream`、
  `ppx.task.run`、CLI 一问一答与 REPL 对话全部落工单 —— 此前这些入口在 `/work`、watchdog、
  审计链上完全不可见。无 `work` 时直通旧路径。
- **P1 Worker 结论回写记忆**：`spawn_agent` 成功结论（≥12 字）以 `[worker:<角色>]` 摘要写入
  `FactStore`（`source:"fork-merge"` = `model-inferred`，去重），跨会话可检索；
  `agent.delegate_memory_writeback`（默认 true）可关。
- **P2 审计补漏**：审批裁决/超时写 `approval_resolved`；设置变更写 `settings_updated`
  （只记改动的键名，不记值）。两者与工具调用同一条哈希链。
- **P2 外部存活监督**：新增 `electron/liveness.js` 与主进程接线：`/health` 连续失败 →
  指数退避（1s→30s）限次重启（5 分钟最多 3 次），耗尽弹窗交人工，退出中不重启。
  只拉起进程，**不静默重放任务**（任务级 watchdog 仍在进程内、只报告）。
- 文档：`docs/SUPERAGENT-GAP.md` §十/§十一补 ⑤ 收口清单，移除"高级编排逐 Worker 待做"；
  审计承诺改为与 `scrubArgs` 实际行为一致。
- 测试：新增 `test/superagent-runtime-2026-11-05.test.js` 8 项、
  `test/electron-liveness.test.js` 3 项、`test/audit-body-redaction.test.js` 2 项，
  config 一致性登记新键。全量 2499 用例 2493 过 / 0 挂 / 6 跳过；
  `npm run verify` 16/16；`npx eslint` 变更文件 0 error；README 数字锚点同步。

### ·Router 调度事件化与 Worker 漂移巡检 (2026-11-05)

前一轮把 Router 角色、工单账本、Watchdog 铺好后，调度仍然"只发生、不可见"：并行委派没有
`router_*` 事件，父会话看不到 Worker 轮次/步数，Worker 反复调同一个工具也无人察觉，跨会话记忆
只能靠 Worker 自己再搜一次。本轮只做事件化与观测补齐，不改执行路径。

- 新增 `src/flow/router.js`（调度协议唯一实现）：
  - `emitRouterEvent(agent, type, fields)` 双写 EQ（`_eqPushRef`）与审计链，字段走白名单
    （id/status/worker/route/轮次/步数/工具名等），任务正文、回复、思考永不入链；
    `audit.lifecycle_events=false` 时只发 EQ；审计/EQ 缺失或抛错均静默降级，不阻断派发。
  - `normalizeWorkerReport` 归一化 Worker 回执（旧 worker 无信封也有稳定形状；明确失败不采信
    自称 `ok`），`buildDelegationBrief` 组装 `[全局上下文]`（全局记忆 top3 + 同角色共享板最近 2 条，
    上限 800 字符）。
- 协议新增 `router_decision` / `router_dispatch` / `worker_report` 三类生命周期事件。
- `spawn_agent`：派发前发 `router_decision`（kind/route/并行原因/是否注入记忆）；
  每个子任务 `work.begin` 后发 `router_dispatch`；回执统一发 `worker_report`。
  信封双向携带 `ticketId` / `assignmentId`，父工单与 Worker 会话可对账。
- Worker 实时进展：工具循环 step 事件补 `steps` / `lastTool`；`work.progress` 增工具轨迹
  （最近 32 个），`spawn_agent` 通过 `onProgress` 把轮次/步数/最后工具写回 assignment，
  停滞与漂移判断从此有数据。
- Watchdog 新增 `detectWorkerDrift`：连续 6 次同一工具判 `tool_repeat`，轮次 ≥18 且步数 ≤1
  判 `round_spin`；`collectSignals` 输出 `workers.{running,drifting,drift}`，简报增加「Worker 进展」行。
  只报告，不自动中断/重跑；阈值 `watchdog.drift_repeat` / `watchdog.drift_rounds` 可调。
- `agent.delegate_memory_inject`（默认 false）开启后，派发前注入 `[全局上下文]`；检索失败
  降级为空串，任务文本不加前缀时逐字节不变。
- 测试：新增 `test/superagent-router.test.js` 11 项；全量 2486 用例 2480 过 / 0 挂 / 6 跳过；
  `npm run verify` 16/16；README 数字锚点同步（ctx_tokens 5961）。
- 边界：team/topology/review/supervisor 四条高级编排路径的逐 Worker `dispatch/report` 与工单对账
  已在本日"架构对齐审计修复"一轮补齐（见上）。

### ·客户端请求层与限流恢复 (2026-11-05)

服务端按 IP 限 60 请求/分；两个标签页或连点几个面板就能打满。此前各页面各自 fetch，
不认 429、不去重，撞上限流后整片停在「加载中…」/「状态不可用」/「未配置模型」，只能手动刷新。

- 新增 `public/api.js` 统一请求层（app / bot / settings-ui / stats 全部改走它）：
  - 同路径并发 GET 合流；401 交给既有刷新流程；
  - 429 读 `Retry-After` 记全局窗口：轮询类（quiet）立即失败，交互类最多等 2.5s，
    不把 60 秒挂进一次点击；窗口结束向 UI 广播「已恢复」；
  - 超时 / 断连给中文可读文案，不再是裸 `TypeError`。
- 限流期间界面如实说明而不是装死：侧栏底部同步条显示 `同步暂停 · Ns 后自动恢复`，
  点一下立即重试；恢复后变绿「连接已恢复」并自动补拉会话/任务/模型/审批/当前面板，无需刷新。
- 各面板空态带「重试」按钮；有旧数据就保留旧数据（工单/文件树/插件），首次失败才落占位；
  模型徽标在读取中显示 `—`，不再把「还没读到」误报成「未配置模型」。
- 空态 hero 的「开工姿态」类型卡由 2×2 改一行四列（1440×900 下原网格会把提示语挤到输入框下面）；
  侧栏与 hero 溢出时统一用底部渐隐提示可继续滚动。
- 审计：CDP 真机截图覆盖打满令牌桶 → 倒计时占位 → 60s 后自动恢复（无刷新，会话/模型/工单恢复）；
  常规十一面板巡检无 console 错误、无失败请求。
- 门禁：`npm run verify` 16/16；`npm run lint` 0 error（56 条既有 warning）；
  全量 2475 用例 2469 过 / 0 挂 / 6 跳过；`npm run desktop:smoke` PASS。

### ·调度闭环收口 (五项架构断点) (2026-11-05)

一~三期把 Trigger/Thread、Work Graph、Router、Watchdog 铺上后，复查核实出 5 个"管道铺了、
水没通"的断点，本轮只接线、不新增子系统（详见 `docs/SUPERAGENT-GAP.md` §十）。

- ① 入站统一建单：新增 `src/flow/worklink.js`（`createTicketLink` 三段式 + 去重直通）；
  微信被动回包 `_replyFromXml`、Web UI `/message` `/message/stream`、TUI `runTurn` 全部落账本，
  `/work` 面板 / watchdog / 审计链从此能看到这三路入站。被动回包去重命中已完成工单直接回
  缓存结果 XML，命中在途回空体；账本失败降级 `ticket=null`，不阻断回复。
- ② `spawn_agent` 普通并行路径改走 `await L.spawnAgents(specs)`（ConcurrencyGovernor 配额），
  逐项返回 `{ok, name, error}`，失败跳过派发并如实回报；每个子任务建 `cause:"delegate"` 工单，
  信封摘要回带工单号。`ORIGIN` 增 `DELEGATE`。
- ③ `memory_add` / `memory_search` 新增 `scope` 参数（缺省全局、`"session"` 映射当前会话、
  自定义作用域名），打通此前零调用方的 `FactStore.scope`；`agent.delegate_memory_inject`
  （默认 false）开启后派发前注入 `[相关记忆]` 前缀（截 500 字符）。
- ④ Watchdog `collectSignals` 增 `tickets` 段：working/waiting 计数 + 超 `stall_minutes`
  （默认 15）停滞工单 top3，prompt 增「工单账本」行；只报告，不自动取消/重跑。
- ⑤ `AuditLog.appendEvent` 让 `TICKET_*` / `ASSIGNMENT_*` / `DELIVERY_*` 进 SHA-256 哈希链，
  白名单字段（ticketId/status/worker/assignmentId/origin/route），text/result 不入链；
  开关 `audit.lifecycle_events`（默认 true）。
- 测试：新增 `test/superagent-phase5.test.js` 14 项；全量 2475 用例 2469 过 / 0 挂 / 6 跳过；
  `npm run verify` 16/16；README 数字锚点与 ctx_tokens（5961）同步。

### ·DSH 吸收 Step 5a (ANS 车道配置模式) (2026-11-05)

- 新增 `src/config/ans-lane.js`（`ans_lane.v1` 的唯一运行时归一化实现，位于 config L1 层，
  不反向依赖 ans L2）：
  - `ANS_LANE_DEFAULTS` 深冻结默认值，`DEFAULT_CONFIG.ans_lane` 直接引用同一对象，杜绝默认值两处漂移；
  - `resolveAnsLaneConfig(raw)` 返回 `{ config, warnings, disabledReason }`，非法值只告警不抛错：
    版本硬校验、来源白名单过滤、`mode` ↔ `create_ticket` 强制、数值夹取、目标白名单净化；
  - 安全不变量：`internal_only=true` / `origin="ans"` / `security.inherit=true` 不可被用户关闭或改写；
  - 硬条件不满足（enabled=true 但 targets/sources 为空、版本不符、类型非法）→ `enabled=false` +
    `disabledReason`，宁可不开也不半开；
  - `ansLaneAllowsSource(lane, source)` 提供 Step 5b 路由判据（未开启或来源不在白名单 → 继续旧 broadcast）。
- `loadConfig` 深合并后统一归一化 `ans_lane`，告警以 `[config] [ans_lane]` 前缀输出；
  默认 `enabled:false` 且不接任何运行路径 —— 无新事件、无新投递，行为与之前完全一致。
- 配置一致性注册表补 24 个 `ans_lane.*` 叶子键（消费点 = `src/config/ans-lane.js`），死键闸门继续生效。
- 内核行数预算显式上调 `src/config` 1050 → 1400（实测 1339，96%）：新增归一化属启动期安全治理，
  不能下移到 `src/ans`（L2）反向破分层，目录内再拆也不减总量；决策理由已写入 `scripts/arch-guard.js`。
- 测试：`test/ans-lane-step5a.test.js` 17 项（默认关闭 / 缺 targets 安全关闭 / mode 强制 /
  版本与来源校验 / 数值夹取 / 目标净化 / 安全不变量 / 非法类型 / loadConfig 集成与默认值隔离）；
  全量 2461 用例 2455 过 / 0 挂 / 6 跳过；`npm run verify` 16/16。

### ·Router 角色分层 (只分派不执行) (2026-11-04)

- 新增 `src/agent/role.js`：`ROUTER_TOOL_ALLOW`（11 个委派/检索/提问/元工具）、
  `shouldApplyRouterRole`（配置 + 环境标记 + 防递归判定）、`applyRouterRole`（装配期收窄）、
  `routerRolePrompt`（静态角色提示）。
- 配置 `agent.router_role = { enabled: false, allow: [] }`（默认关闭）；自定义 `allow` 只追加，
  `spawn_agent` 恒保留。
- 装配：`bootstrap._initStartup` 在曝光后应用角色；MCP 自动连接完成后对 Router 重新收窄，
  覆盖启动后动态注册的工具。`usage._applyRouterRole` 落日志。
- 准入：`_admitToolCall` 新增角色闸（先于 plan/权限判定）—— 名单外工具在唯一执行收口硬拒，
  拒绝信息给出可执行下一步（改用 `spawn_agent` / 关闭配置重启）。
- 防递归：`agent-worker.js` 构造 agent 前写入 `PPX_AGENT_ROLE=worker`，子进程不继承 Router 角色。
- 提示：`prompts._context` 新增静态【角色】段（仅 Router 非空，无时间戳，前缀缓存契约不破）。
- 测试：`test/router-role.test.js` 8 项（角色判定/名单并集/装配收窄/准入硬拒/真实 agent 接线）；
  全量 2400 用例 2394 过 / 0 挂 / 6 跳过；`npm run verify` 16/16。

### 真实对话实测修复 (2026-11-04)

Router 开启后跑真实 LLM 对话（deepseek provider + 真 worker 子进程）暴露两个缺陷，均已修：

- **委派被 30s 全局预算掐断**：`spawn_agent` 未声明 `timeoutMs`，`tools/seam.js` 回退到
  `agent.tool_timeout_ms=30000`，`DELEGATE_TIMEOUT_MS=120000` 永远到不了 —— worker 30.5s 才收尾，
  外层 30s 已判超时。注册时声明 `timeoutMs: DELEGATE_TIMEOUT_MS + 60000`（180s）。
  实测复跑 38.4s 一次委派成功，无超时。
- **只读任务被 claim-without-write 误拦**（`src/core/claims.js`）：
  1. `"不修改文件"` 的裸「不」未被识别为否定指令 → `looksLikeMutationRequest` 误判；
  2. 否定式终稿（"未做任何修改"）被当完成声称 → 剥离否定短语；
  3. 引用原文（围栏/行内代码/引用行，以及未加围栏的整段粘贴）里的 `改完请重跑`、`Node.js`、
     `*.test.js` 被当成"本轮声称 + 落盘对象" → 剔除引用块、过滤产品名 token、拒绝通配碎片。
  真阳性保持：代码块外的"已修改 X"仍拦，"没改 A 只改 B"仍拦。
- 测试：`test/claims-negation-2026-11-04.test.js` 11 项（否定语义/引用剔除/产品名过滤/真阳性）。

### 用户视角实测第二轮修复 (2026-11-04)

隔离目录 + 真实 provider 走完十大项实测后, 修复三项:

- **`safePath` 正斜杠 root 误判越界** (`src/tools/builtin-paths.js`)：调用方以 `C:/x/y` 传入 root 时,
  `path.resolve(root, p)` 产出反斜杠子路径, 旧前缀比较拿原始 root 比 → 根目录下连 `README.md`
  都报"路径越界拒绝", 整套文件工具失效。现先把 root `path.resolve` 归一化再比较;
  realpath/新建父目录回退同步改用归一化 root。越界拒绝不受影响。
- **`globToRegex` 的 `**/` 强制至少一层目录** (`src/tools/code-act.js`)：`src/tools/**/*.js`
  被译成 `src/tools/.*/[^/]*\.js`, 直接子文件永远匹配不到 —— 真实对话里模型搜索得到
  "(无匹配文件)"。改为标准 globstar: `**/` → `(?:.*/)?`（零或多层）。
- **帮助文本工具数写死 76** (`src/agent/work.js`)：实际注册 103 个; 改为从 `ToolCatalog` 即时取数。
- **冷启动误报"上次进程未干净退出"** (`src/selfheal/healer.js`)：启动顺序是 `markDirty()` → `heal()`,
  脏标记本属当前进程, 旧 `checkCrash` 只看 `clean===false`, 每次冷启动都报"上次进程 (pid=当前pid)
  未干净退出"。现同 pid 视为自身标记, 不算崩溃; 旧 pid 仍正常触发清理。
- 测试：`test/user-test-round2-2026-11-04.test.js` 4 项（正斜杠 root/globstar 语义/帮助文本/自愈自标记）；
  全量 2404 用例 2398 过 / 0 挂 / 6 跳过；`npm run verify` 16/16。

### DSH 吸收 Step 0–2 (2026-11-04)

- **Step 0 契约冻结**（`docs/dsh-absorb/`）：事件命名与所有权、`delivery.v1` JSON Schema、
  `deliveryState × ticket.status` 7×6 矩阵、19 条兼容不变量、`ans_lane` 配置 schema。
  五份文件先于任何运行时代码，作为后续实现的唯一真相源。
- **Step 2 workgraph 字段**（`src/workgraph/`）：
  - ticket 新增 `origin / externalId / dedupeKey / requeueOf / usage`；
  - assignment 新增 `origin / route / delivery(v1 快照) / usage / outcome / errorKind / lastTool`；
  - `findDuplicate` 支持显式 `dedupeKey` 优先且不回落 `messageId`（I6）；
  - `requeue` 记录 `requeueOf`，新 assignment 不复用旧 ID，来源标记 `requeue`；
  - `service.fail` 支持 `errorKind` / `envelope`，`execution_timeout` 口径可落账。
- **新增纯函数**：`state.js`（origin/route 归一化、`foldDeliveryState`）、`judge.js`
  （`judgeTicket` / `isTicketCompleted`）。唯一收单条件 `done && delivered`；
  执行重跑仅显式 requeue；组合矩阵与 `02-STATE-MATRIX.md` 逐格对齐。
- 未改 channels/flow/协议事件生产，旧调用路径零行为变化；`deliveryState` 只读投影，不写账本。
- 测试：`test/workgraph-step2.test.js` 9 项（字段持久化/显式去重/信封/requeue/折叠/42 格矩阵/
  宽限期/兼容默认值）；全量 2413 用例 2407 过 / 0 挂 / 6 跳过；`npm run verify` 16/16。

### DSH 吸收 Step 3 (2026-11-04) · 投递回执与执行/投递事件生产

- **协议**（`src/protocol/index.js`）：新增 `ASSIGNMENT_STARTED / PROGRESS / ENDED`、
  `DELIVERY_ACCEPTED / DELIVERED / FAILED / DEAD_LETTER`；`assignmentId` 进入顶层引用键，
  事件信封补 `schema_version: 1`。
- **执行事件**（`src/workgraph/service.js`）：`begin` 发 `assignment_started`；`progress`
  以 500ms 窗口合并发 `assignment_progress`（首条立即、后续合并后 `coalesced=true`，定时器 unref）；
  `complete/fail/cancel` 发恰好一条 `assignment_ended`。执行超时或取消且从未进入投递时，
  补 `delivery_dead_letter(attempt=0, reason=execution_timeout|cancelled)`。
- **投递回执**（新增 `src/channels/receipts.js`）：同步直发与异步队列共用同一字段实现；
  回执身份 `<assignmentId>:<attempt>:<state>`，`seq` 只排序。同步硬超时 30s，
  失败固定 `failed(willRetry=false) → dead_letter(delivery_timeout)` 并照常抛出。
- **队列接线**（`src/channels/delivery.js`）：入队 accepted、重试成功补 accepted、
  用尽 failed + `dead_letter(delivery_exhausted)`、TTL 丢弃 `delivery_timeout`；
  缺 `ticketId/assignmentId` 的广播/ANS 投递不产回执（Step 5 再建单）。
- **通道接线**（`src/channels/base.js`）：同步走 `sendSync`；异步结果经队列回投并携带
  `assignmentId`；话题直通由父进程 `onExecuted` 先收口执行、再由 `thread-bridge` 投递，
  worker 只回带 ID 的信封（I11/I12）；REPLAY 重发缓存结果不产新 delivery 事件。
- **测试**：`test/workgraph-step3.test.js` 12 项（协议常量/执行生命周期/500ms 合并/
  同步与队列回执/超时死信/三条路由/REPLAY 单终态/桥的顺序）；全量 2425 用例 2419 过 /
  0 挂 / 6 跳过；`npm run verify` 16/16；`npm run lint` 0 error。

### DSH 吸收 Step 4 (2026-11-04) · channels/flow 消费 delivery.v1 契约

- **契约解析**（新增 `src/flow/delivery-contract.js`）：按
  `01-delivery.v1.schema.json` 产出 `ticketId/route/origin/sink/execution/policy/dedupe`；
  解析顺序「显式 `trigger.delivery` > 通道默认 > flow 默认 > sync」，显式只能收紧
  sync→async，不能把 async/thread 改回 sync。显式只认进程内字段，不从 webhook body/meta 读。
- **内核接线**（`src/flow/kernel.js`）：sync/async/thread 计划携带契约；drop/replay/duplicate
  不产契约。`planIngress` 仍是纯决策，不发送/不执行。
- **账本绑定**（`src/workgraph/store.js`）：`assign` 落盘时把 `assignmentId` 写进契约快照，
  恒用新 ID（I7），不接受调用方预置 ID。
- **通道消费**（`src/channels/base.js`）：同步硬超时 =
  `min(policy.deadline_ms, 剩余 execution 预算)`（预算耗尽按 1ms 立即超时，不退化为无上限）；
  异步结果 job 携带 policy；线程 `forward_timeout_ms > 0` 才覆盖桥默认。
- **队列策略**（`src/channels/delivery.js`）：job 级 `max_attempts / backoff / ttl_ms / retry_on`；
  错误分类为 `timeout/network/rate_limit/server_error/client_error`（事件 `error.kind` 保持
  `timeout/send_error` 兼容），`retry_on` 之外的错误立即死信；无 policy 的旧 job 行为不变。
- **测试**：`test/workgraph-step4.test.js` 11 项（契约形状/收紧规则/默认叠加/预算截止/
  内核计划/账本绑定/job 级重试/TTL/retry_on/同步超时/异步入队）；全量 2436 用例 2430 过 /
  0 挂 / 6 跳过；`npm run verify` 16/16；`npm run lint` 0 error。


---

> ℹ️ **2026-11-08 精简**: 4.1.0 之前的版本记录 (4.0.0 及更早的 3.x 全部轮次, 以及 2026-11-03 的"未发布"批次) 不再随仓库携带 —— 完整历史见 git 提交记录与 GitHub Releases。此后 CHANGELOG 只保留最近若干个正式版本。

## 4.4.0 (2026-11-02) · 本地模型一键接入

### 模型配置 (`src/llm/local-discover.js`, `src/channels/http-api-settings.js`, `public/settings-ui.js`)

- **一处真实的连而不通**: 本地 LM Studio 配了 `model: gemma-4-e4b` (不是 `/v1/models` 返回的完整 id)、
  `max_output: 120` —— 健康探测通过, 对话却返回空内容: 推理型模型把 120 个 token 全花在
  `Thinking Process` 上, 正文一个字都没剩。配置模块不校验这个组合, 用户只能看到"模型没回答"。
- **一键接入本地模型**: 模型面板新增入口, 扫描 `127.0.0.1` 的 LM Studio(1234) / Ollama(11434) /
  vLLM(8000) / llama.cpp·LocalAI(8080) / Jan(1337) / text-generation-webui(5000), 读出模型名、
  实际加载窗口、输出上限、视觉能力; 点选后创建 provider → 设为默认 → 探测, 一步完成。
  LM Studio 新版要求 Key 时先返回「需要 Key」, 面板内粘贴后重新检测。
- **元数据不再手填**: LM Studio 走 `/api/v0/models` 取 `loaded_context_length` (实际加载窗口,
  通常远小于训练上限) 与 `vlm/embeddings` 类型; 嵌入模型不出现在对话模型列表里。
  「获取可用模型」也带回同样的元数据, 只补空字段, 不覆盖用户手填值。
- **只扫环回**: 发现逻辑固定 127.0.0.1 端口表 (最多 10 个), 拒绝任意主机 —— 不做内网端口扫描;
  先不带 Key 探测, 只有 401/403 才带用户 Key 重试, 密钥不会发给本机无关服务。
- **视觉标记一致**: `/api/llm` 的 provider 级 `vision` 现在读模型目录 `inputs`, 只配目录
  不配 `provider.vision` 时前端不再误标"不支持图片"。
- **本体设置补上模型模块** (`public/bot.js`): 顶栏齿轮进入的「本体设置」原来只有身份/规则/限额,
  看得到当前模型却改不了。新增「模型配置」段: 当前模型、各 provider 凭据状态、
  「管理模型」(完整面板) 与「接入本地模型」(直达一键扫描)。`/api/bot.state` 的 provider id
  此前恒为空 (LLMClient 主键叫 `providerId`, 快照只认 `id`) —— 一并修正, 服务列表也受此影响。
- 新接口 `POST /api/providers/discover-local {api_key?, ports?}`; 测试 `test/local-discover.test.js` 5 项
  (窗口→输出上限映射、原生元数据映射、401 三态、嵌入过滤、端口关停)。

## 4.3.0 (2026-11-02) · 结构自审 · 按需工具 · 桌面长运行 · 测试卫生

### 自审闭环 (`src/selfcode/graph.js`, `src/selfcode/audit.js`, `scripts/arch-map.js`)

- **一份静态依赖图**: 解析 import/require/动态 import/相对字符串路径 (含注释剥离),
  入口可达性区分 `reserved` (有测试的预留模块) 与 `unwired` (真死代码候选), 文件级环检测,
  反向影响 → 自改前自动选相关测试。`arch-map` 与自审、进化循环共用, 不再各写一套。
- **确定性自审**: 死代码/环/断链/巨石文件/静默 catch 热点 → 0–100 分 + 分级建议,
  同一棵源码树输出字节稳定。当前基线: 283 模块 / 558 边 / 277 可达 / 6 reserved / 0 环 / 0 断链, 72 分 (C)。
- **`self_audit` 工具** (只读): 对话内直接找优化目标, 与每日进化同一实现。
- **进化 Phase0**: `EvolutionLoop` 每轮先记审计快照, journal 可画结构健康趋势。
- **`self_edit` 自动选测**: 从补丁解析目标文件 → 反向影响图取相关测试, 替掉旧的启发式。

### 工具调用可靠性 (`src/core/policy.js`, `src/tools/*`)

- **默认 `tool_exposure:"core"`**: 31 个主干工具下发 schema, 其余按需; `tool_schema` 取过后
  该工具下一轮自动进入函数数组 (`catalog.expose` + 每轮工具 getter)。MCP 工具豁免收窄。
- **非法参数不静默执行**: tool_call `arguments` 非合法 JSON/非对象 → 明确错误 + 截断预览 + 用法提示,
  作为 tool 消息回给模型重试。
- **未知工具近邻建议**: 编辑距离 + 子串给 2 个候选。
- **执行纪律进 system prompt**: 取证优先 / 小步并行 / 读错误再改 / 连续失败两次换路 / 写入必验 / 结论带证据。

### Web UI (`public/`)

- **新手指引**: 首次访问三步卡片 (能做什么 → 模型就绪检查/深链设置 → 可点击起步任务);
  侧栏「新手指引」随时重放; `modelConfigured` 随 bootstrap 下发。
- **精简**: 抽屉只留 文件/目标/审查/工单 四个页签, 移除重复的模型/设置页与侧栏模型按钮;
  设置统一从独立弹窗进入; 移除内联 `style`, 新增 `.tree-filter`/`.guidebtn`。
- 门禁 `npm run web:check` 纳入 `onboarding.js/css` 与结构断言。

### 桌面长运行与优雅退出 (2026-11-02)

- **SSE 订阅不再泄漏**: `/events` 保存并调用 `eq.subscribe` 的退订函数, 断连统一清理
  (退订 + 移出广播集合 + 停心跳); 25s 注释帧保活。修复前实测 25 次连接留下 25 个僵尸订阅。
- **EQ 内存有界**: 只保留最近 5000 条事件, 更早的 `since` 从 WAL 回补; 长期运行不再线性吃内存。
- **桌面优雅退出**: 新增仅回环 + `PPX_DESKTOP_SECRET` 可用的 `POST /desktop/shutdown`;
  Electron 退出先请求它, 2.8s 超时才强制结束进程树 —— Windows 不再直接 `taskkill /F`,
  记忆落盘 / 军团回收 / 投递队列收口与 Ctrl+C 同一条链。
- **就绪判定加固**: 桌面 `waitReady` 必须通过 HMAC 挑战应答, 防止接上端口上的同名服务。
- **静态资源**: ETag/304 + Content-Length + 有界进程内缓存 (签名失效), 省掉重复读盘与整包传输。
- **隐藏页暂停轮询**: 30s/15s/5s 三路定时器在 `document.hidden` 时跳过, 回前台补一轮。

### 长运行第二轮: WAL 分段 · uploads 缓存 · 写盘批量化 · GUI 冒烟 (2026-11-02)

- **EQ WAL 分段归档** (`src/protocol/index.js`): 活跃文件满 8MB 改名为
  `eq.wal.<YYYYMMDD-HHmmss>-<pid>-<n>.jsonl`, 默认保留 24 段; 重启按活跃→最新归档恢复 seq;
  回放从最新段向前读, 读够 `limit` 即停。`PPX_EQ_WAL_MAX_BYTES` / `PPX_EQ_WAL_KEEP`
  (0 = 关闭轮转 / 不限保留)。轮转失败继续写原文件, 不丢事件。
- **`/uploads/*` 缓存**: 与 `public/` 共用 ETag/304 + Content-Length + 有界内容缓存,
  图片附件额外 `Cache-Control: private, max-age=86400`; 同名替换后 ETag 变化自然失效。
- **会话写盘批量化**: 生产 `SessionStore` 默认 `writeBehind` —— 普通 append/flush 合并到
  下一 tick 每 key 写一次, 内存日志先写; 压缩/重建用 `sync:true`, shutdown/dispose/exit 用
  `flushAll({ sync:true })` 收口。崩溃窗口最多一个 tick; 未改异步文件锁, 不是并行 I/O。
- **Electron 真实窗口 GUI 冒烟**: `npm run desktop:smoke` 在隔离 userData/data 与空闲端口上
  启动真实窗口, 断言关键 DOM、bootstrap、authToken、`/health`, 收集渲染错误, 截图并写
  `result.json`; Electron 未安装时 SKIP。产物在 `.ppxtest/desktop-smoke/latest/`。
- **架构文档**: 新增 [docs/ARCHITECTURE-OVERVIEW.md](docs/ARCHITECTURE-OVERVIEW.md)
  (进程→装配→请求→协议→记忆→工具→桌面→质量门的端到端阅读地图)。
- 回归: `desktop-longrun` 11/11, `skill-memory-drift` 42/42, 全量 2186 项 2182 通过 /
  4 网络跳过, `desktop:smoke` PASS。

---

### 补遗 (2026-11-02): 工单账本 — 入站受理跨重启可查可重跑

> 设计来源: DeepSeek《Super-agent 设计探索》的 Tickets/Assignments/Admission 语义 +
> `deepseek-ai/dsh-superagent-prototype` (MIT, 只读设计未复制源码)。
> 对照与边界见 [docs/SUPERAGENT-GAP.md](docs/SUPERAGENT-GAP.md) 第八节、
> [docs/WORK-GRAPH.md](docs/WORK-GRAPH.md)。

- **工单账本** (`src/workgraph/`, 新增): 每条被准入的入站输入落一张持久工单, 每次执行落一次
  指派 (worker/会话/轮次/工具/终态), append-only JSONL (`data/workgraph/tickets.jsonl`),
  跨重启折叠。解决四个缺口: 异步任务重启失联 / IM webhook 重试重复执行 / 无"处理到哪了"
  查询 / 中断任务无法显式重跑。
- **四条入站路径接线** (`channels/base.js`): 同步 / 异步受理 / 话题直通 / 异常全部登记工单;
  账本失败不阻断回复, `agent.work_graph.enabled=false` 整体旁路。
- **webhook 去重**: 同 source+from+messageId 复用原工单; 在途不受 30s 窗口限制; 已完成则
  重发缓存结果 (首次回复丢包时用户仍能收到答案)。
- **重启恢复只标记不重跑**: 上一实例遗留的 admitted/working 工单标为 failed/interrupted;
  `workRequeue` 显式重跑 failed/cancelled 工单 (成功工单不重放, 避免重复副作用)。
- **启动安全自动恢复 (默认关)**: `work_graph.resume_unstarted=true` 时只自动重跑 **admitted 且
  从未 begin** 的工单 (无执行事实 = 无工具副作用); `working/waiting`、超龄 (默认 6h) 或超限
  (默认 3 条) 仍标中断。`server.js` 在通道启动后经 `chatAsync` 重跑并回投原通道, 失败不阻断启动。
- **控制面**: `/work [show|cancel|requeue]` 隐藏命令 (内置 15 条名册不变) +
  `GET/POST /api/tickets` + `workList/workGet/workCancel/workRequeue` agent API。
- **事件**: `EventType` 新增 `ticket_created/assigned/waiting/completed/failed/cancelled/
  requeued/interrupted`; EQ 顶层引用键新增 `ticketId`。
- **Web UI 工单面板**: 抽屉「工单」页支持状态筛选 / 行内详情 (输入·结果·错误·工具·指派) /
  取消 / 重跑; 5s 自动刷新, 展开详情时暂停 — 不另存前端状态, 与 `/work`、`/api/tickets` 同源。
- **follow_thread 工具**: 订阅直通的模型侧入口 (attach/detach/list), 后续同会话消息直通
  长驻 worker, 不进 Router LLM; 已进核心曝光名单与 plan 模式阻断表。固定开销 +169 tok,
  ctx 预算 15150 → 15400 (账目写在 `scripts/ctx-profile.js`)。
- 配置 `agent.work_graph` (enabled/max_tickets/retention_days/compact_at/dedupe_ms/recover/
  resume_unstarted/resume_max_age_ms/resume_limit), 默认开; 38 项测试覆盖
  store/service/通道/agent/HTTP/follow_thread/启动自动恢复。

### 回合内提问 · 吸收 DeepSeek-Bot 的 ask_user_question (2026-11-02)

> 交互语义来自 [DeepSeek-Bot](https://github.com/rlaope/deepseek-bot) (MIT) 的
> `ask_user_question` 与终端输入区; 这里只吸收语义并在零依赖 JS 里重写, 不修改对方源码。
> 与 `clarify` 的分工: `clarify` 只让模型生成问题清单再自己猜; `ask_user` 真正暂停回合等人回答。

- **`ask_user` 工具** (`src/tools/methods.js`): 1–5 个问题, 每题 2–4 个短选项, 支持单选 /
  多选 / 自填; 答案格式化为结构化文本回到工具结果。无人通道时直接返回推进指引
  (按最合理假设继续), 不把回合反问死。已进核心曝光名单与 plan 模式只读面。
- **提问生命周期** (`src/agent/index.js`): `askQuestions` / `resolveQuestion` / `cancelQuestions` /
  `pendingQuestions`; 超时 (`agent.question_timeout_ms`, 默认 5min) 或 `interrupt()` 取消时
  明确告知模型"用户没有回答", 由模型按假设继续 (fail-open)。审批仍 fail-closed, 两套收口语义独立。
- **HTTP 面** (`src/channels/http.js`): SSE 新增 `question` / `question.close` 帧;
  `GET /api/questions/pending`、`POST /api/questions/:id` (answers 或 `{cancel:true}`);
  健康摘要新增 `pending_questions`。
- **Web 端** (`public/app.js`, `app.css`): 对话时间线内渲染提问卡 (选项/多选/自填,
  Enter 提交, Esc 跳过, 自动聚焦与滚动); 状态栏按阶段显示「思考中 / 运行 bash /
  正在写回答 / 等待你的回答」并计时; ↑/↓ 回翻输入历史 (草稿保留); Ctrl+O 一键折叠/展开
  全部工具结果。超时或中断时卡片收口并显示原因。
- **验证**: `test/ask-user-loop-2026-11-02.test.js` 4 项 (生命周期/中断/无通道指引/HTTP 往返);
  全量 2165 项 (2161 通过 / 4 网络跳过), verify 15/15, lint 0 error。
  固定开销 +332 tok, ctx 预算 15400 → 15700 (账目写在 `scripts/ctx-profile.js`)。
- README 数字锚点同步时发现测试总数散文句未被门禁覆盖 (整句加粗导致旧正则失配),
  已修 `scripts/readme-sync-check.js` 的正则并补登本次数字。

### 终端窗口 · DeepSeek-Bot 的 dsh (2026-11-02)

> 线协议来自 [DeepSeek-Bot](https://github.com/rlaope/deepseek-bot) (MIT) 的
> `tui/protocol.ts` 与 `transports/local.ts`; 这里只实现网关端, 不修改对方源码。

- **网关** (`src/channels/tui.js`, 新增): 在命名管道 (Windows) / unix socket 上实现
  dsh 的 newline-JSON 协议 —— hello/ready、message、typing、cancel、withdraw、
  sessions/history、usage/models、审批 question/answer, 并把发现文件写到
  `$DSH_HOME/run/deepbot-tui/ppxans.json`。终端会话 id 直接作为 PPXANS 的 sessionKey,
  Web 与终端共用同一个 agent 与会话日志。
- **轮次映射**: `chatStream` 的 delta/reasoning/tool 事件分别映射为
  `stream text|thinking|tool|tool.result`; 每次消息一次 typing-on、轮末一次 typing-off,
  排队消息可撤回且计数对齐; 没有增量输出的模型在轮末补一条 `post(answer:true)`。
- **审批闭环**: `approval/requested` → 终端 `question` (允许/拒绝), answer 回到
  `resolveApproval`; 无屏幕/断开/中断时按拒绝收口, 不让轮次空等超时。
- **启动**: `startServer({tui:true})` 与 `ppx-web` 默认开启 (`--no-tui` / `PPX_TUI=0` 关闭);
  `bin/ppx-bot.js` 先查活着的网关, 没有就就地起内核 + 网关, 再拉起 dsh;
  Windows 双击 `启动BOT窗口.bat`。
- 7 项协议测试 (`test/tui-gateway.test.js`) + 用 DeepSeek-Bot 真实 `Connection`/`discover`
  代码做的发现与收发冒烟; 全量测试 2161 通过。

### 全链自研化与溯源门禁 (2026-11-02)

- **入站内核抽层** (`src/flow/`, 新增): Trigger 归一 (`trigger.js`) / 两级准入 (`policy.js`) /
  纯决策内核 (`kernel.js`, `planIngress` 六动作 drop·replay·duplicate·thread·async·sync)。
  内核只产出计划, 通道层 (`channels/base.js`) 负责执行 —— 过滤/去重/直通/收发语义不再散落
  在传输代码里。`channels/trigger.js`、`channels/policy.js` 原文件移除, 调用方统一改指 `flow/`。
- **投递 outbox 自研增强** (`channels/delivery.js`): 指数退避加 ±10% 抖动 (防重连风暴)、
  死信账本 (完整载荷 + 原因, 内存环 + 可选 `data/channels/delivery.dead.jsonl`)、
  pending 级幂等键 (同 key 在途不重复入队)、per-channel 串行/跨通道并行不变。
  新配置 `channels.delivery.jitter_ratio` / `dead_letter` / `dead_letter_max`。
- **溯源注册表 + 门禁** (`config/native-provenance.json`, `scripts/native-guard.js`, `docs/PROVENANCE.md`):
  24 个设计来源逐项登记"来源 → 原生模块 → 自研优化点"; 门禁校验注册表完整性、模块与文档
  覆盖、禁止上游 import (`dsh` / `deepseek-harness` / `openclaw` / `claude-code` 等) 与
  vendored 版权标记。接入 `npm run verify`, 让"只借鉴设计、未复制源码"可执行、可回归。
- **文档与注释收口**: 架构快照补充 flow 层、死信账本与溯源规则; 若干头注释原先的
  "吸收/借鉴某文"改为"设计溯源 docs/PROVENANCE.md#<id>" + 原生职责描述。

## 4.2.0 (2026-11-01) · v4.2 雷仔对齐: 分层漏斗意图识别 + 多协议适配层 + 设置弹窗重做

> 学习来源: leizai-agent (github.com/zhuang3719/leizai-agent) 的三个成熟范式 —— Provider 能力位注册表 /
> 规则层纯函数打分注入提示不接管决策 / LLM 错误三态分类 + 文件即可观测性; 并落地视频
> 《Agent 意图识别怎么做》的分层漏斗架构 (规则层 → 上下文层 → 大模型工具兜底层)。

### 分层漏斗意图识别 (src/intent/, 新增)
- **L1 规则层** (`intent/funnel.js`): 高频/稳定/歧义极低指令白名单 (问候/时间/记住/读文件/列目录/帮助), 毫秒级直答或转工具, 零模型调用。吸收原 `_localIntent` 5 族正则; 铁律是做减法 —— 内置规则冻结, 用户扩展 `.ppx/intent-rules.json` 上限 64 条, 通配规则直接拒绝 (防规则黑洞)。
- **L2 上下文层**: 纯函数打分 (连续性信号 / matchSkill 技能命中 / 专家包 domain+近义词 / WorkStack 当前任务), 输出「分流提示块」注入本轮 user 消息尾部 —— **提示不接管决策** (雷仔范式), 最终决策权仍在模型。提示块随 `_persistTurn.historyText` 一并落会话历史: wire 与历史逐字节一致 (append-only 契约, cache-audit 门禁全绿), 记忆抽取仍用原文不进提示噪声。
- **L3 工具兜底层**: 即现有 mode 分发 (react 工具循环), 结构未动。理想状态 = 大部分流量在 L1/L2 消化, 进 LLM 层保持低比例。
- 会话状态与层统计 (`intent/state.js`): 每会话 lastUserMsg/lastIntent/turns (7 天 TTL, 200 条 LRU) + rule/context/llm 三层流量计数, 落盘 `<dataDir>/intent-state.json` / `intent-stats.json`; `GET /api/intent/stats` 暴露占比。开关 `config.agent.intent_funnel` (默认开, false 时退化为纯 LLM 兜底)。

### 多协议适配层 (src/llm/protocol.js, 新增)
- 三种线上协议, 对上收敛到内部规范 (OpenAI chat wire), agent/工具循环零改动: `openai-completions` (直通) / `openai-responses` (instructions 承载 system + 扁平 function 工具 + reasoning.effort) / `anthropic-messages` (原生 `/v1/messages`: system 分离 + content blocks + tool_use/tool_result 往返 + extended thinking 预算档位 + x-api-key 鉴权)。
- `provider.protocol` 决定线上格式 (缺省 openai-completions); 未知值回落不抛。Anthropic 预设改走原生协议 (不再依赖 OpenAI 兼容层 beta)。
- Provider schema v2 (`config/providers.js`): 新增 `protocol` / `display_name`; `models` 升级为结构化模型目录 `[{id, label, context_window, max_output, inputs:[text,image]}]` —— 旧格式 (字符串数组/model 单值) 读取时自动归一化, 无需迁移。LLMClient 按当前模型解析 per-model 元数据 (窗口/最大输出/视觉), 未配置逐级回退。
- `POST /api/providers/fetch-models`: "获取可用模型" —— 按协议 GET /models, 失败带三态分类。

### 错误三态 + 诊断落盘 (雷仔对齐)
- `classifyHttp` (llm/retry.js): 每次失败归类 `{reason, retryable, needsUserAction}` —— 401/402/403/404 = needsUserAction (提示用户处理而非无限重试), 429/5xx/超时 = 可重试。
- 失败请求脱敏落盘 `<dataDir>/logs/llm/last-error.json` (Bearer/x-api-key/sk- 打码, 保留 3 份轮转): 零依赖项目的"文件即可观测性"。

### 设置弹窗重做 (public/settings-ui.js + settings.css, 新增; 雷仔 UI 形态对齐)
- 独立「设置」弹窗 (居中 + 左侧导航): 通用设置 (审批/沙箱/外观/语音, 自抽屉迁入) + 模型服务两面板。
- 模型面板: 提供商卡片列表 (状态点/显示名称/默认标记/协议与目录徽标/编辑删除) + 「＋ 添加模型提供商」。
- 添加/编辑二级弹窗: 双 tab「第三方模型提供商 | 自定义模型 API」; API 协议下拉 (三种); **模型目录编辑器** (每行 模型ID/显示名称/上下文窗口/最大输出/文本图片输入类型) + 「获取可用模型」拉取合并 (保留手工目录项与已标注能力)。
- 抽屉「模型/设置」瘦身为摘要 + 打开设置入口; 底部模型胶囊直开弹窗。前端零依赖 ES5 风格不变; check-web.mjs 把 settings-ui.js/settings.css 纳入静态自检。


## 4.1.0 (2026-11-01) · Super-agent 二期 (dsh 推理框架吸收)

> 学习来源: DeepSeek 产品部《Super-agent 设计探索》 + DeepSeek Harness (dsh) 官方开源库
> (github.com/deepseek-ai/deepseek-harness) 的推理框架 (agent-loop inbox / spill / compaction /
> goal-round-driver / tool-execution-pipeline)。逐项对照与落地记录见
> [docs/SUPERAGENT-GAP.md](docs/SUPERAGENT-GAP.md) 第六节。dsh 三条设计公理的落地:
> 日志即真相 (裁剪原文不删) / 边界即时机 (合并挂会话锁收口, 无定时器) / 策略即事件 (EQ 引用字段)。

### Router 批处理 (二期②, dsh inbox claim 语义)
- 同会话忙时新到的普通文本输入不再各开一轮串行推理: 会话锁空出的那一刻整批 claim (≤ `agent.router_batch_max`, 默认 8),
  合并成一条注入, 一次推理回答全部; 执行期间新到的留下一批。被吸收调用共享同一回复。
- 旁路: 斜杠命令逐条原样执行; `agent.router_batching: false` 整体关闭 (默认开)。埋点 `router/batch_merge`。

### 链式召回 (二期③, dsh spill/output-retention 语义)
- 新增 `src/tools/spill.js` `SpillStore`: 超长工具结果全文归档 `<dataDir>/spill/`, 分页续读, TTL 14 天 + 容量 500 份淘汰。
- 工具循环裁剪告示牌升级为续读入口: `...全文已归档 spill_id=sp-x, 可调用 context_read 工具按 offset 分页续读` ——
  被裁内容从"只能重跑工具拿回"变为一次本地读档。
- 新增 `context_read` 工具 (readOnly, 常驻曝光名单); `agent.context_recall: false` 整体旁路 (默认开)。
- 上下文预算 15000 → 15150 (增量明细与削减路径记入 scripts/ctx-profile.js 总账)。

### thinking 通道 (二期②最小版)
- 流式 `reasoning_content` 不再静默丢弃 (`src/llm/client.js`): 增量经 `onReasoning` 回调透出, 全文随返回值带回;
  `runToolLoop`/`_llmWithFallback`/`_chatStreamCore` 全链透传, 轮内思考全文随中间草稿归档 (`_recordDraft.thinking`)。
  不进正文不落会话日志 (防污染决策权在调用方); worker 场景积累进 `agent._lastReasoning`。

### EQ 引用字段 + 过滤订阅 (二期①)
- `EventQueue.push` 支持顶层引用字段 `turnId/sessionKey/opId/cause/thread/ref` (原样落 WAL);
  TURN_*/TOOL_* 生产端已挂。`subscribe(fn, {since, types})`: 类型白名单 + seq 断点续订 (回放不丢中间事件), 旧签名全兼容。

### worker 结构化汇报信封 (二期⑤)
- worker 回包 `{type:"reply", reply}` → 附 `envelope:{status, rounds, steps, tools, thinking}`;
  `spawn_agent` 单任务回复尾附 `[汇报信封]` 摘要, 主 agent 可引用子 agent 执行证据。旧消费方零影响。

### Trigger thread 回投闭环 (二期⑥)
- `handleTrigger` 回发携带 `{thread, replyTo}` 元数据; 飞书 `send` 收到 `meta.replyTo` 走
  `/messages/:id/reply` 接口, 回复落在原消息/原话题下 (与一期 delivery meta 透传接通, 全链闭环)。

### 异步 ReAct + 结果回投 (二期④, 第二批)
- `PPXAgent.chatAsync(userMsg, opts)`: 立即返回 `{id, sessionKey}` 不阻塞调用方, chat 后台照常走
  同会话互斥/合并车道/工具循环; `bgTasks()` 清单 + `bgCancel(id)` 取消 + EQ
  `TASK_STARTED/TASK_COMPLETE/TASK_ABORTED` 事件 (三种零生产者事件类型自此有真实生产端)。
- channels 异步受理: `config.channels.<name>.async_reply=true` (或 `trigger.meta.async`) 时先回执
  "[已受理]", 结果经 delivery 队列 (重试/WAL 续投) 回投**来源通道**原话题 (带 thread/replyTo meta)。
- 隐藏命令 `/bg` (清单) / `/bg cancel <id>` (取消) —— 不破 15 条内置名册契约。投机执行深度形态
  ("静默复现修复") 需故障记忆+重放沙箱联动, 诚实列入后续。

### 多信道输出规范 (二期⑤, 第二批)
- 新增 `src/channels/output.js` `shapeForChannel` 纯函数: IM 信道 (feishu/wechat/log) 降噪
  (markdown 修饰剥离/空行折叠, `im_flatten:false` 关), 结构化信道保真; 长度截断默认关
  (`im_max_chars:0`), 开了才截且诚实标注。接线: `handleTrigger` 入站回复 + `broadcast` 主动推送。

### 订阅直通收口 (二期①, 第二批)
- `EventQueue.subscribe` 增 `thread` 过滤 + `limit` 回放上限 (默认 500)。
- SSE `/events` 支持 `?since=<seq>&types=&thread=` —— 浏览器断线重连补播错过事件, 帧附 seq/thread 水位。

### 三期第一批: 投机复现 / 长驻话题 worker / 端侧 daemon (2026-11-01)
- **投机复现修复** (`src/evolve/speculative.js`, §4.1 静默复现): 轮收口边界后台静默复现本轮
  工具失败 —— replay 模式 (默认) 幂等工具零成本重跑, 瞬态/稳定复现判定入**故障病历
  (FailureEpisodeStore 首个真实消费方)** + 经验库沉淀; full 模式追加 chatAsync 只读诊断。
  安全边界: 非幂等绝不重放 / 每轮 ≤3 条 / 中止轮不复现。`agent.speculative_repair` 默认开。
- **长驻 worker 话题编排** (`src/orchestrator/thread-bridge.js`, §3.2 订阅直通完整形态):
  `threadDelegate` 把话题/会话驻派给长驻军团 worker, 后续同话题消息程序直通 (不进 Router
  LLM), 回复经 delivery 回投原话题; `/bg` 附 worker 清单与 `/bg detach` 撤驻。新增
  `MESSAGE_RECEIVED` EQ 事件 (Trigger 不再是观测盲区)。模型侧 follow_thread 工具因 ctx
  预算余量不足 (84 tok < schema 成本) 未加, 诚实待预算腾挪。
- **端侧 daemon** (`src/services/daemon-control.js` + `ppx-daemon` bin, §5 第一步):
  start/status/stop/restart 全生命周期 (脱管 headless 常驻, 幂等启动, stale pid 自动清理,
  SIGTERM→超时强杀, Windows 兼容)。计算可关窗常驻, 客户端 HTTP attach; 完整存算分离
  (无状态副本+外置 DB) 的产品冲突如实记录未解。

### 测试
- 全量 **2075 项** (0 失败 / 4 网络跳过)。三批共新增 31 项:
  `test/superagent-phase2.test.js` 14 项
  (SpillStore 分页/淘汰/净化 / 告示牌与降级 / runToolLoop 归档集成 / context_read 分页 / 流式 reasoning 采集 /
  lastRun.toolNames / 合并轮×3 含同 tick 突发与双旁路 / EQ 引用字段与 since+types 订阅 / Trigger meta 回投);
  `test/superagent-phase3.test.js` 9 项 (chatAsync 受理/失败/取消 / TASK_* 真实生产者 / /bg 隐藏命令 /
  channels 异步受理→delivery 回投 / thread+limit 订阅 / shapeForChannel 全语义 / broadcast 整形 + manager 反向引用);
  `test/superagent-phase4.test.js` 8 项 (投机复现 全语义 + agent 集成病历落盘 / ThreadBridge 全语义 /
  agent 直通绕过 Router / daemon 真实脱管进程全生命周期 + stale pid 清理)。
  更新 capability-guard 只读豁免面快照 (显式评审: context_read 纯读归档); hardening-r5 会话锁测试
  关批处理保住 R5 锁语义回归。`npm run verify` 14/14, lint 0 error。

---

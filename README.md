# 🦐 PPXANS-Harness

**皮皮虾神经系（ANS）+ Harness 一体化智能体内核** —— 纯 Node.js、**零运行时依赖**的可审计自主智能体。

> 当前版本：**5.3.0** · 对话体验轮（思考链路收拢 + 个性化面板）+ 外观/像素身份系统 + 世界模型 + 覆盖率补全 · 2026-11-18

一个会自我修复、自我学习、自主迭代、可审计验证的超级 Agent：**126 个内置工具 · 能力边界护栏 · L0–L4 五层记忆 · SHA-256 审计哈希链 · 标准 MCP 服务端+客户端 · 多模型路由 · 自愈 7/7 · 可验证自改进闭环（self_improve） · 全量测试 2206 项 (2202 通过 / 4 跳过) · 桌面客户端**。

> ⚠️ 本节数字为 **2026-11-04 实测**（`node --test test/*.test.js`），请勿手改臆测值 —— 改完请重跑并同步本行。  
> 机读锚点由 `node scripts/readme-sync-check.js --fix` 维护，手改会被闸门拦下。  
<!-- readme-sync: {"tools":126,"skills":71,"core_schema":37,"ctx_tokens":6975,"mcp_tools":128,"tests":2206,"test_files":283,"offline_total":28,"offline_legacy_total":20,"verify_checks":17,"pass":2202,"skipped":4} -->
> 2026-10-25 评估修复轮后全量 0 失败（此前 1 项失败为测试断言过期，已随工具数 113→114 一并修正）；  
> 主干链路（启动 / 对话 / 记忆 / 审计 / 权限 / HTTP / MCP）全量通过。

自带标准 MCP 服务（`POST /mcp`），Claude Desktop / Cursor / 任何 MCP 客户端**开箱即用**；支持各大模型 API + 本地模型，自由回退。

> 🌍 **English**: [README.en.md](README.en.md) · [docs/QUICKSTART-EN.md](docs/QUICKSTART-EN.md) — English overview + quickstart (CLI output and the rest of the docs are Chinese-first).
> 🧭 **文档索引**: [docs/README.md](docs/README.md) — 按"先读这一段 / 配置 / 机制 / 发布 / 开发"排好，不用在 16 篇文档里瞎点。

> 🛡️ **自愈基准**：`node scripts/selfheal-bench.js` → **7/7 100%**（发布前门禁，`PPX_MIN_SELFHEAL` 可设阈值）  
> 🔗 **审计哈希链**：`npm run audit:verify` —— append-only + SHA-256 链式防篡改，篡改/删除可定位到行

---

## ⚡ 三分钟上手（桌面版）

> 给第一次用的人：只需要**模型名称**和**API Key**，别的都能用默认。

1. **装**：从 [Releases](https://github.com/chen6896qqwee/PPXANS-Harness/releases/latest) 下载
   `PPXANS-Harness-Setup-<版本>-x64.exe`，双击安装（无需预装 Node.js）。
2. **填**：首次启动只问两样 —— 模型名称（如 `deepseek-chat`、`gpt-4o`、`qwen-plus`）和 API Key。
   接口地址按模型名自动识别；**本地模型**（LM Studio / Ollama）留给你自己在「设置 → 模型」里配，
   这一步也可以**直接跳过** —— 不配模型也能打开界面，顶部会挂一条提示，随时回来补。
3. **跑**：点「读懂这个项目」这类现成任务，看它一步步做完。跑通一条就算上手。

界面只有四项一级导航：**对话 / 项目 / 任务 / 能力**。配置类的东西全部收在「能力」里，
看不到 `base_url`、`protocol`、工单、生命周期这些内部词 —— 它们不该由用户来理解。

## 📥 下载安装（普通用户）

从 [GitHub Releases](https://github.com/chen6896qqwee/PPXANS-Harness/releases/latest) 下载单个全量安装包：

**`PPXANS-Harness-Setup-<版本>-x64.exe`**（约 120MB）

- 系统要求：Windows 10/11 x64；**无需预装 Node.js**，运行时已内置
- 双击安装 → 选择目录 → 完成；默认按当前用户安装，不需要管理员权限
- 安装后从桌面/开始菜单“皮皮虾”启动，首次运行按向导填 **模型名称 + API Key**（可跳过，本地模型自行在设置里配）
- 程序与用户数据分离：程序在 `%LOCALAPPDATA%\Programs\PPXANS-Harness`，会话/记忆/审计在 `%LOCALAPPDATA%\PPXANS-Harness-Desktop`；卸载程序不会删除用户数据
- 卸载：Windows 设置 → 应用 → “皮皮虾 (PPXANS-Harness)”，或开始菜单里的 Uninstall

**校验安装包**（Release 同时提供 `SHA256SUMS.txt`）：

```powershell
certutil -hashfile PPXANS-Harness-Setup-5.3.0-x64.exe SHA256
```

> 当前安装包未做代码签名，首次运行 Windows SmartScreen 可能提示“未知发布者”，  
> 选择“更多信息 → 仍要运行”即可。校验和与源码可直接对照，介意者建议自行从源码构建。  
> 没有身份核验证书就无法生成受信任签名；免费开源签名（SignPath Foundation）、  
> OV 证书与自签测试的取舍见 [docs/SIGNING.md](docs/SIGNING.md)。  
> **Code signing policy**：[CODE\_SIGNING\_POLICY.md](CODE_SIGNING_POLICY.md)  
> （签名范围、团队角色与隐私说明；当前发布物未签名）。

**其他平台**（macOS / Linux）：安装包由 CI 在对应平台构建，同样在
[Releases](https://github.com/chen6896qqwee/PPXANS-Harness/releases/latest) 下载 ——
macOS 提供 `.dmg/.zip`（Intel 与 Apple Silicon），Linux 提供 `.AppImage/.deb`。
两者均未签名：macOS 首次打开需右键 →“打开”，Linux AppImage 需先 `chmod +x`。
也可以直接用源码运行（零运行时依赖）：`npm ci && npm start`。

**从源码构建**：Node.js ≥ 20（推荐 22 LTS）

```bash
npm ci
npm run desktop:pack     # → dist-desktop/PPXANS-Harness-Setup-<版本>-x64.exe + SHA256SUMS.txt
```

发布流程、签名与第三方许可见 [docs/PACKAGING.md](docs/PACKAGING.md)、  
[docs/SIGNING.md](docs/SIGNING.md) 与 [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md)。

---

## ✨ 核心特性

| 能力                                        | 说明                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| ----------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 🗣️ **语音闭环补全 (2026-11-14)**                    | ASR 本地兜底落地: `voice_transcribe` 云端失败自动切 `voice.asr_fallback` 本地 whisper (openai-whisper / whisper.cpp 双 flavor, 缺二进制诚实报错不编结果); 转写统一走 `transcribeAudio` (工具与 Web 端 `/api/voice/transcribe` 同一实现); 上传音频可回显 (uploads 补音频 mime) |
| 📱 **Telegram 渠道 (2026-11-14)**                   | long polling 接入 (getUpdates, 不需要公网 webhook, 凭据只要 botToken): Trigger 归一 + 四段式会话键 (群聊/论坛话题/回复串各自独立会话) + 两级准入 + 工单去重 + WAL 续投**全套继承**; 4096 字硬限分块; `allowed_chats` 渠道级白名单; `ppx channels test telegram` 真连通性探测; 诚实边界: edited_message 不重触发, 媒体消息只取 caption |
| 🧱 **code_act 容器沙箱 + 外部基准 (2026-11-14)**    | code_act 接入 shell seam —— `shell_provider="docker"` 时脚本**真在容器内执行** (临时脚本落挂载内, 回执注明 `[execEnv: docker 容器沙箱]`, 本地模式行为不变); 外部基准适配器 `external-bench` (GAIA 风格 JSONL + FINAL ANSWER 协议 + 可证伪判分器 + 离线负对照, 数据集不进仓库) |
| 🔥 **v5.0 打碎重铸 (2026-11-08)**                    | **前端**: Vue3+Vite 框架化重铸 (40+ 组件 + store 架构), 接入 /events 实时总线, 真双主题, 发布产物仍零运行时依赖。**核心**: Worker 热池 (spawn_agent 接管热进程免冷启动) · 信封 v2 (commands/artifacts 随工单落账可核) · 合并批逐条回信 ([[回复 #n]] 分段) · 链式召回二期 (被裁历史/压缩原文按 spill_id 续读) · 真 token 预算 (历史/工具结果随 provider 窗口自适应) · 新工具 browse (桌面 Chromium 渲染) / update_plan (回合内计划, 实时计划卡) / 5 段 cron |
| 🧠 **五层记忆 L0–L4**                         | L0 对话 → L1 原子（高斯衰减）→ L2 场景 → L3 画像 → L4 程序性（技能/流程，衰减仅 L1 的 1/4）；语义检索开箱即用（内置零依赖哈希向量兜底 + 向量落盘缓存，配云端 embedding 自动切换）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| 🧹 **记忆治理**                               | 软删可回滚 + 版本链 + TTL 归并 + 按层清理 + 导出/导入迁移 + **作用域分区**（`memory_add`/`memory_search` 的 `scope`：缺省全局、`"session"` 当前会话、自定义作用域名；委派可开 `delegate_memory_inject` 把跨会话关键信息随分派带给 worker，默认关）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| 🔗 **审计哈希链**                              | 工具调用 append-only 账本 + SHA-256 链式防篡改 + HMAC 链外密钥锚点（防"整链重算"伪造，密钥不落数据目录），篡改/删除定位到行，可隔离重放                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| 🛡️ **权限安全**                              | AskForApproval 四档审批 + SandboxPolicy 沙箱（工作区写含 realpath 符号链接复核）+ 命令守卫三层防线（shell 结构化解析：命令替换硬拦 / 逐段 argv0 白名单）+ SSRF 防护 + fail-open 钩子栅栏                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| 🩺 **自我修复**                               | 启动体检、损坏 JSON 修复、崩溃恢复、残留清理（自愈 7/7）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| 🔄 **自主迭代**                               | 可验证自改进闭环：失败测试 → LLM 诊断 → SEARCH/REPLACE 补丁 → 快照落盘 → 重跑验证 → 绿保留/红回滚（`self_improve` 工具 + `npm run selfiterate`，默认 propose 只出补丁，apply 需双重确认，全程审计链留痕）                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| 🖥️ **桌面客户端 · 本体形态（2026-10-27 / 2026-11-03）**           | 前端以「常驻本体」为中心，不再以「会话列表」为中心：**开工姿态类型卡并入对话空态**（选类型 = 换姿态并开新局，改名/头像/暂停走设置页）· **对话页**（对话·轨迹双页签，轨迹可按天回翻，合并工具调用与结构化事件两路来源）· **设置页**（运行状态 / 身份与头像 / 工作区 / 规则 / 后台执行 / 晨间简报 / 日程 / 限额 / 自主时间 / 权限 / 记忆 / 服务）。档案落 `data/bots/profile.json` —— 人肉可编辑；写坏自动退回默认并留 `.broken` 副本。接口 `/api/bot.state` 一次取全首屏，`/api/bot.manage` 单入口写、动作白名单                                                                                                                                                                                                                                 |
| 🫀 **身体：痛觉 / 记忆 / 工作内存 / 体征（2026-10-30）** | 四样以前没有的东西。**痛觉**：`npm run taskbench:offline` —— 20 个确定性判分任务 + 脚本化计划回放真实工具循环，离线零 LLM，量的是"harness 能不能把正确计划执行成结果"（现状 20/20，3.9s；首跑就抓出免疫闸门错误文案不可行动）。**记忆质量**：探针拆 dev/holdout 两套（只调 dev、只认 holdout，防对着考卷改答案），靠 40+ 概念簇 + 整词概念桥 + 逐条置信度融合把 holdout recall@1/@3 提到 **100%/100%**、dev recall@1 提到 **93%**（dev recall@3 47% → 100%）；BM25 与 256 维哈希向量**都是字面信号**，概念路是那条缺的语义桥。**工作内存**：`task_stack` 跨轮任务栈（落 `workstack.json`，上限 8 条，空栈零 token，渲染段不含时间戳且只走动态区）。**身体**：侧栏左上角入口 → 简笔躯干 + 四个器官点，状态靠**呼吸节奏**传达（ok 慢/ warn 快 / bad 急促抖动 / **unknown 不动 = 没量过**）；一句话判断按"先说坏的、再说没测的"排；每张卡给体感文案（"15 句换个说法全认得出"）而不是只给百分比；趋势 <2 个点不画线。没跑过一律 `unknown` 并给出怎么跑，**不编健康值** |
| 🪄 **自改代码（2026-10-27）**                   | 皮皮虾改自己的源码：SEARCH/REPLACE 补丁 → 边界校验 → 原子落盘 → 三关验证（语法/行为/边界）→ 绿保留/红整体回滚 → 记账 → 待生效清单。`self_edit` / `self_verify` / `self_rewind` / `self_ledger` 四个工具，账本 `data/selfcode/ledger.jsonl` append-only、改动前备份可回滚，默认 propose 只出 diff，apply 需 config 双开。ESM 无热替换，改完需重启才生效 —— 这段边界写在回执里，不谎称已生效                                                                                                                                                                                                                                                                                                                      |
| ⚡ **事件驱动 Trigger/Thread + Watchdog（2026-10-31）** | 对照 DeepSeek《Super-agent 设计探索》一期落地：**Trigger 结构化事件** —— 渠道入站不再退化成裸字符串，飞书完整读出 chat_id/root_id/parent_id/message_id 构造 Trigger（来源/群组/话题/发送者）；**Thread 会话归组** —— 复用四段式会话键，每群/每话题独立会话（互斥+记忆分区白拿），`session_mapping:"shared"` 可回退旧行为；**两级过滤** —— 程序级 Fast Path（渠道/群/发送者黑白名单，deny 恒胜，`mode:"all"` 行为不变）+ 可选 LLM 语义 Slow Path（fail-open）；**结果回投** —— broadcast meta 随 delivery WAL 持久透传；**Watchdog 控制回路** —— 独立定时心跳会话（`agent.watchdog`，默认 30min），看 SQ 死轮/工作栈阻塞/故障病历/工单停滞（working 且超 `stall_minutes` 无推进，只报告不自动重跑）头部，首行 OK/WARN/CRIT 分级，异常才广播，全量落账 `data/evolve/watchdog.jsonl`；**并发治理接线** —— Legion 挂上 ConcurrencyGovernor（`spawnAgents` 走配额，spawn 不再绕过治理，`spawn_agent` 普通并行路径同样整批走配额）。二期（订阅直通/Router 批处理/链式召回）已在后续批次落地 |
| 🧾 **工单账本 Work Graph（2026-11-02 / 2026-11-05 统一入站）** | 对照 Super-agent 的 Tickets/Assignments 落地（[docs/WORK-GRAPH.md](docs/WORK-GRAPH.md)）：每条被准入的入站输入落一张持久工单，每次执行落一次指派（worker/会话/轮次/工具/终态），append-only JSONL 跨重启折叠。**同步 / 异步受理 / 话题直通 / 异常 / 微信被动回包 / Web UI / MCP / CLI** 八条入站路径 (TUI 网关 2026-11-08 退役, dsh 走 HTTP/MCP) + **`spawn_agent` 委派**统一登记（直连路径共用三段式 `worklink`，MCP/CLI 无通道入口走 `chatTracked`，账本失败只降级不阻断回复）；**IM webhook 重试去重**（同 messageId 复用原工单，已完成重发缓存结果，在途回空体）；**重启恢复只标记不重跑**（可选 `resume_unstarted` 只自动恢复 admitted 且从未执行的子集），`/work requeue` 显式重跑失败/取消工单；`/work` 命令 + `GET/POST /api/tickets` + **桌面端工单面板**（筛选/详情/取消/重跑）+ **`follow_thread` 话题驻派工具** + 8 种 `ticket_*` 事件 + **审计链生命周期事件**（TICKET/ASSIGNMENT/DELIVERY 白名单字段进 SHA-256 哈希链） |
| 🧭 **Router 角色分层（2026-11-04）** | 对照 Super-agent 双层架构的 Router 侧补齐：`config.agent.router_role.enabled=true` 时主进程收缩为调度层 —— 工具面只留委派/检索/提问（11 个），文件读写/命令/改代码在**准入链硬拒**并提示改走 `spawn_agent`（不是只藏 schema）；装配期同时禁用其余工具省 token，启动后动态注册的 MCP 工具由同一道闸兜底；`agent-worker` 强制标记 worker 角色，防"路由器生路由器"；自定义 `allow` 只做追加，`spawn_agent` 不可移除；**委派治理**——普通并行路径也整批走 `spawnAgents` 配额，每次分派落工单（`cause:"delegate"`，信封回带工单号），Router 的分派在账本上可查；默认关闭，行为不变 |
| 🧭 **全链自研 + 溯源门禁（2026-11-02）** | 借鉴只停在设计层（[docs/PROVENANCE.md](docs/PROVENANCE.md)）：22 个设计来源登记于 `config/native-provenance.json`，对应实现全部自研。入站语义从通道层抽成 L2 内核 `src/flow/`（Trigger 归一 + 两级准入 + `planIngress` 六动作，内核只决策不发送）；投递 outbox 增加抖动退避、死信账本、幂等键与 per-channel 并行。`scripts/native-guard.js` 常驻校验：注册表完整、模块/文档覆盖、禁止上游 import 与 vendored 标记 —— "没抄源码"从声明变成可执行门禁 |
| 🙋 **回合内提问（2026-11-02）** | 吸收 [DeepSeek-Bot](https://github.com/rlaope/deepseek-bot)（MIT）`ask_user_question` 的交互语义（只读设计，未复制源码）：`ask_user` 工具把 1–5 个问题真正递到人面前并**暂停回合**，每题给短选项、可多选、可自填；答案以结构化文本回到工具结果，模型据此继续。**有审批面才提问** —— 无人通道时工具返回推进指引（按最合理假设继续），不会把回合反问死。桌面端实时渲染提问卡（选项/多选/自填、Enter 提交、Esc 跳过），超时/中断自动收口并明确告知模型；审批仍 fail-closed，提问 fail-open。状态栏按阶段显示「思考中 / 运行 bash / 正在写回答 / 等待你的回答」，↑/↓ 回翻输入历史，Ctrl+O 折叠/展开全部工具结果 |
| 🧬 **持续进化循环**                             | 每日自主进化编排：弱点聚类定向学习（同类故障病历 ≥N 先治）→ 失败沉淀经验/成功沉淀技能 → 代码自改进 → 进化度量落账 journal（`evolution_loop` 配置 + `npm run evolve:loop` + `evolution_status` 工具随时查看能力快照/弱点/进化曲线，「变强」有账可查）                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| 📚 **自我学习**                               | 经验库 + 画像/人格提炼 + refine 失败轨迹闭环 + refineSkill 成功沉淀技能；经验自动沉淀语境 Playbook（进化闭环），失败自动写故障病历并反哺提炼                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| 🤖 **多 Agent 军团**                         | 多进程并行 + DAG 编排 + legion 模式 + spawn_agent 自主协作（并行/差异化视角/仲裁聚合/SDD 审查循环），编排超时可配（`agent.legion.timeoutMs`）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| 🔌 **多渠道接入**                              | HTTP + 飞书（官方 encrypt_key 事件解密 + 签名校验 + 防重放）+ 微信（加解密 + 主动推送 + 加密回包）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| 📄 **文档 + RAG + OCR**                     | read_document（txt/md/pdf/html）+ ingest_document 分块入库 + ocr_image（本地 tesseract / 云回退）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| 💬 **CLI 交互**                             | readline 历史 + /stop 中断 + /reset 清会话 + Ctrl+C 单次中断                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| 🧩 **MCP 客户端 + 服务端**                      | 零依赖 MCP 客户端（stdio + HTTP Streamable）接外部工具；`POST /mcp` 暴露 128 工具 + 记忆/轨迹/统计/会话资源 + 方法型 prompts + ppx.* 管理工具                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| ✅ **任务面板**                                | 任务队列 + 步骤状态推进 + 结果回填 + 技能模板                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| ✅ **可观测**                                 | 工具轨迹 JSONL + 结构化事件流（traceId 贯穿）+ tool call result 大摘要                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| ✅ **场景系统**                                | 灵魂文件式场景，命中自动切换行为                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| ✅ **流式输出**                                | SSE 逐字流式（含工具轮次：增量 tool_call 累积，文本实时可见）+ 桌面端实时渲染；同会话并发互斥、/rewind 会话回卷（fork 分支）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| 🔐 **HTTP 认证**                            | Bearer Token，未配置自动生成随机 token 持久化                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |

**126 内置工具**（运行时实测，含 MCP 动态注册）：

- **126 内置**：文件/命令/搜索/HTTP/定时/记忆（读图/检索/入库，L1 事实 + L4 程序性记忆）/文档（加载/OCR/入库）/场景/技能（加载/创建/提炼）/重构 refine /回合内提问（`ask_user`：选项/多选/自填，等待真人回答）/子 agent spawn + 治理运维（repo_map/apply_patch/review_code/goal_board/audit_verify/persona/selfheal_run/self_improve/self_audit 等）
- **默认按需曝光**（2026-11-02）：只下发 37 个主干工具 schema（`agent.tool_exposure:"core"`），其余工具保留名字、用 `tool_schema` 按需取参数；取过后下一轮自动进入函数数组。全量模式仍可设 `"all"`。
- **22 × ppx.*****：** chat.send/stream、sessions.*、providers.(list/add/update/delete/test/reorder)、settings.get/update、task.(templates/create/list/update/step/delete/run)、session.reset

---

## 架构（v3.0 引入 codex 对齐, v4.0.0 沿用）

> 端到端阅读地图见 **[docs/PROJECT-OVERVIEW.md](docs/PROJECT-OVERVIEW.md)**；当前权威快照见 **[docs/ARCHITECTURE-CURRENT.md](docs/ARCHITECTURE-CURRENT.md)**（七段装配、全量子系统地图、入站/工单/事件数据流、分层守卫）；下文保留 v3.0/v4.2 的特性摘要。

v3.0 引入 codex 的 **EQ 事件流 + SQ 在轮账本 + Turn 模型**（详见 docs/ARCHITECTURE-CURRENT.md），把权限、钩子、编辑、审查、证据能力**分层独立为可替换模块**，并重制零依赖 Web UI：

| 模块             | 出处                       | 能力                                                                                                                                                                                                                                         |
| -------------- | ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `protocol/`    | codex                    | **EQ 事件流为主出口 + SQ 在轮账本**：EQ(WAL) 落盘结构化事件经 `/events` SSE 桥外发（TURN\_\*/APPROVAL\_\*/TOOL_CALLED/TOOL_OUTPUT 经 callId 配对）；SQ 承载在轮 USER_TURN op 与 INTERRUPT 控制 op（TTL 防腐烂，`/health` 可观测）。Turn 投影层（Session→Task→Turn 状态机）随轮更新，重启后 WAL seq 续读不撞号 |
| `permissions/` | codex + opencode + CASDK | **三合一权限引擎**：AskForApproval 四档 + SandboxPolicy 三档 + 通配符规则链(last-match-wins) + canUseTool 回调 + Bash/Edit/Plan 审批模板                                                                                                                           |
| `hooks/`       | claude-code              | **七事件钩子链**：PreToolUse(可否决/改参) / PostToolUse / PreCompact / PostCompact / SessionStart/Stop / SubagentStop，超时熔断，纯 JS                                                                                                                                      |
| `edit/`        | aider                    | **SEARCH/REPLACE 编辑块**（多候选/空白容错/失败回灌修复）+ 编辑前快照逐文件回滚                                                                                                                                                                                        |
| `repomap/`     | aider                    | **仓库地图**：def/ref 提取 → 引用图 → PageRank → token 预算内渲染，缓存 30s                                                                                                                                                                                  |
| `verify/review.js` | 分级审查流水线                  | plan→group→review→relocate→filter，输出 P0/P1/P2 静态规则报告（2026-11-12 迁入 verify/）                                                                                                                                                            |
| `evidence/`    | oh-my-hermes             | **证据边界**：prepared/observed 双层标记 + handoff manifest(哈希) + 目标看板                                                                                                                                                                              |
| `commands/`    | claude-code              | **斜杠命令统一模型**：内置 /init /plan /review /compact /new /resume /model /status /memory /skills /goal，用户命令从 `.ppx/commands/*.md` 加载                                                                                                               |

> **集成现状**：上述 9 模块中 8 个已装配进运行时（`agent/plugins/v3.js` + `tools/v3.js`，MCP 实测可调）；`session/` 的 **TurnProjection 投影层已接入主链路**（`agent/index.js` 每轮 begin/end + SQ/EQ 推 TURN\_* 事件，底层 `turn.js` 状态机由投影层直接引用），另有 `workstack.js`（跨轮任务栈）与 `plan-live.js`（回合内计划）参与装配；`rollout.js` / `parts.js` 已随 2026-11 精简移除。钩子链 7 个事件（PreToolUse/PostToolUse/PreCompact/PostCompact/SessionStart/SessionStop/SubagentStop）已全部接入 emit 点；语境 Playbook 已形成"经验 → delta → 门禁 → 注入"完整闭环（`evolve/delta-producer.js`）。

**Web UI（本体形态, `webapp/` Vue 3 + Vite 重铸，2026-11-07 换骨；2026-11-03 首页并入对话）**：主区域以对话为中心（空态首屏带开工姿态类型卡，切换即开新局；对话·轨迹双页签 / 设置），侧栏是本体条目 + 会话·空间·任务·能力，抽屉保留文件树、模型配置、目标看板、审查报告、工单账本与运行时设置；「新开一局」直接开新会话跳进对话；对话页仍是三栏事件时间线（用户/agent/工具卡/审批卡/计划卡/diff卡/提问卡）+ 斜杠命令面板 + 审批卡三类模板 + 工作区 Tab（文件树/目标看板/审查报告/设置）+ 子 agent 彩色徽标 + `@` 引用文件 + Esc 中断 + 亮暗主题；状态栏按阶段显示当前动作与已用时间，↑/↓ 回翻输入历史，Ctrl+O 折叠/展开全部工具结果。

**v4.2 架构新增（2026-11-01, leizai-agent 对齐）**：

- **分层漏斗意图识别（`src/intent/`）**：用户消息按「规则层 → 上下文层 → 大模型工具兜底层」漏斗处理 —— L1 高置信白名单正则毫秒级直答/转工具（零模型调用，规则做减法防"规则黑洞"）；L2 纯函数打分（连续性/技能/专家/当前任务）生成「分流提示块」注入 user 消息尾部，**提示不接管决策**；L3 即现有 react 工具循环。层流量统计落盘，`GET /api/intent/stats` 可观测，开关 `config.agent.intent_funnel`。
- **多协议适配层（`src/llm/protocol.js`）**：provider 按协议分发 —— `openai-completions`（缺省）/ `openai-responses` / `anthropic-messages`（原生 Messages：system 分离 + tool_use/tool_result 往返 + extended thinking）。对上收敛到内部规范格式，工具循环零改动。
- **独立「设置」弹窗**：居中大弹窗 + 左侧导航（通用设置/模型），模型面板为提供商卡片列表 + 双 tab 添加弹窗（第三方预设 | 自定义 API）+ 可视化模型目录编辑器（上下文窗口/最大输出/输入类型）+「获取可用模型」。

---

## 🚀 快速开始

### 桌面客户端（推荐）

普通用户：从 [Releases](https://github.com/chen6896qqwee/PPXANS-Harness/releases/latest) 下载
`PPXANS-Harness-Setup-<版本>-x64.exe`，双击安装后从桌面/开始菜单启动。
不需要浏览器、不需要记地址或端口，也不需要预装 Node.js。

源码运行（开发者）：

```bash
npm install            # 首次安装桌面运行时 (Electron)
npm start              # 打开桌面窗口（等价 npm run desktop；Windows 也可双击 启动皮皮虾.bat）

npm run desktop:pack   # 打包 Windows 全量安装包 + SHA256SUMS.txt → dist-desktop/
```

打包版首次启动会把内置代码播种到 `%LOCALAPPDATA%\PPXANS-Harness-Desktop\workspace` (自改代码需要可写根目录), 升级不覆盖工作副本。  
细节与排障见 [docs/DESKTOP.md](docs/DESKTOP.md)。

### 配置模型（首次启动向导，或命令行）

```bash
# 三选一, 约 1 分钟:
npm run setup                                              # 交互式向导: 选厂商 → 粘贴 Key → 自动探活
ppx setup --provider deepseek --key sk-xxx                 # 或一条命令 (--list 看全部厂商)
# 或启动本地 LM Studio / Ollama, 重启皮皮虾自动识别

ppx "帮我看看这个仓库的结构"                                  # 一发即走, 直答退出
ppx doctor                                                 # 配置/连通性体检 (加 --net 探模型连通)
```

> 零配置也能启动 —— 离线记忆模式下皮皮虾照常运行 (记忆/文件/技能), 只是缺对话模型;  
> 桌面首页会显示「配置模型」按钮, 点进去 1 分钟配好。

**开发者入口（非桌面端使用路径）**

```bash
npm run chat          # 终端对话 CLI (ppx / ppxans)
npm run web:check     # 界面静态自检 (图标/DOM id/语法解析/静态资源)
npm test              # 全量测试
```

### MCP 接入 (stdio / HTTP 双形态)

**stdio 宿主（2026-10-31 新增）**：`ppx mcp serve` —— Claude Code / ZCode / Cursor 等 MCP 客户端把皮皮虾作为
stdio 型 MCP 服务器直接接入，无需开端口与 token（`claude mcp add ppx -- ppx mcp serve`），细节见 [docs/MCP-STDIO.md](docs/MCP-STDIO.md)。

**HTTP 端点 (Streamable HTTP)**：`POST http://127.0.0.1:8899/mcp`（同 Bearer token 鉴权）。任何 MCP 客户端（Claude Desktop / Cursor / MCP Inspector 等）可直接接入：

- `tools/list` + `tools/call` — 128 工具全量暴露
- resources：`memory://` `traces://` `stats://` `sessions://`
- prompts：`humanize` / `plan` / `debug` / `verify` / `write_article`（方法型技能）
- `ppx.chat.send` / `ppx.chat.stream`（对话工具，驱动完整工具循环）

配置：`config/ppx.json` → `channels.http { port, auth_token }`

### 模型接入

任意 **OpenAI 兼容端点**，自动多 provider 回退：

```json
{
  "providers": [
    { "id": "openai",     "base_url": "https://api.openai.com/v1",           "api_key_env": "OPENAI_API_KEY",   "model": "gpt-4o-mini" },
    { "id": "deepseek",   "base_url": "https://api.deepseek.com/v1",          "api_key_env": "DEEPSEEK_API_KEY", "model": "deepseek-chat" },
    { "id": "dashscope",  "base_url": "https://dashscope.aliyuncs.com/compatible-mode/v1", "api_key_env": "DASHSCOPE_API_KEY", "model": "qwen-turbo" },
    { "id": "lmstudio",   "base_url": "http://127.0.0.1:1234/v1",             "api_key": "lm-studio",            "model": "<本地模型名>" }
  ]
}
```

v4.2 起每个 provider 可声明 `protocol`（`openai-completions` 缺省 / `openai-responses` / `anthropic-messages`）与结构化模型目录（`models: [{id, label, context_window, max_output, inputs}]`，兼容旧的字符串数组），LLM 客户端按模型解析上下文窗口/最大输出/视觉能力：

```json
{
  "id": "anthropic", "protocol": "anthropic-messages",
  "base_url": "https://api.anthropic.com/v1", "api_key_env": "ANTHROPIC_API_KEY",
  "models": [
    { "id": "claude-sonnet-4-5", "label": "Claude Sonnet 4.5",
      "context_window": 200000, "max_output": 64000, "inputs": ["text", "image"] }
  ]
}
```

**回退机制**：路由层选主模型，运行时负责失败切换 —— 选中 provider 连不上自动切下一个直到成功。默认本地优先，配了云端 key 自动云端优先。

### 前缀缓存优化（可选）

默认 system prompt 会写入工作目录的绝对路径（模型少问路径，进程内前缀缓存不退化）。  
如需跨机器/跨工作目录共享 provider 前缀缓存，可把 `agent.workspace_prompt_mode` 设为 `"neutral"`  
或设置环境变量 `PPX_PROMPT_WORKSPACE_MODE=neutral` —— 此时工作目录段使用稳定占位符，不写绝对路径；  
模型可通过 `pwd` / `list_dir` 自行确认实际路径。

命中率的合理预期（2026-11-14，评测 P2-4）：system 静态区与 tools 数组（按名字稳定序，契约见  
`test/prefix-cache-tool-order-2026-11-14.test.js`）在进程内逐字节稳定；**跨会话/跨天的 cache miss  
主要受 provider 缓存 TTL 约束**，不是本端可优化项。`neutral` 模式只影响"跨机器共享前缀"这一种场景；  
按需工具模式（`tool_exposure: "core"`）下 `tool_schema` 动态曝光会把新工具插回 tools 数组，属设计内的  
一次前缀换血。



---

## 🪄 自改代码（皮皮虾改自己的源码）

让 agent 能改自己的源码，同时保证**改得可验证、可回滚、有账可查**。

### 四个工具 + 两条现有出口

| 能力 | 权限 | 作用 |
|---|---|---|
| `self_audit` | low（只读） | 静态结构自审：死代码候选/依赖环/断链 import/巨石文件/静默 catch 热点 + 0–100 评分与优先建议。改前找目标、改后看趋势 |
| `self_edit` | high | 提交 SEARCH/REPLACE 补丁 → 边界校验 → 原子落盘 → 三关验证 → 绿保留/红整体回滚 → 记账 |
| `self_verify` | medium（只读） | 只验证不改：`node --check` 语法关 + `node --test` 行为关，改前摸底或改后复核 |
| `self_rewind` | high | 按账本 id 从备份恢复原文件（不传 id 则回滚最近一次），回滚本身也记账 |
| `evolution_status` | low（只读） | 已有的进化报告里多了「自改账本」段：累计/保留/回滚/退回 + 待生效清单 —— 不为查账单开一份 schema |
| `npm run selfcode` | — | 人也能用同一条路：`status` / `plan <patch>` / `apply <patch> --tests a,b` / `rewind [id]` / `ack` |

> 工具 schema 每个都要按 token 付钱，所以原本设计的 5 个自改工具压到了 3 个：账本并入 `evolution_status`，
> 待生效确认并进 CLI。2026-11-02 新增只读 `self_audit`（与每日进化审计同一实现），共 4 个。
> **同源** —— CLI 和工具调用跑的是同一个引擎，人跑通的结论模型直接可用。

```jsonc
// 调用示例 (走模型工具调用, 也可在 API/CLI 里直接调)
{
  "patch": "src/utils/text.js\n<<<<<<< SEARCH\nreturn s.trim();\n=======\nreturn s.trim().replace(/\\r\\n/g, \"\\n\");\n>>>>>>> REPLACE",
  "tests": ["test/text.test.js"],
  "mode": "apply",
  "reason": "统一换行, 修 CRLF 断言失败"
}
```

### 三关验证 + 红滚

1. **语法关** — `node --check`。`.js` 会先复制成同目录临时 `.mjs` 再检查：实测 `node --check x.js` 在含 `export` 但目录链缺 `type:"module"` 时**退出码为 0**（静默放行），不绕这一下语法关等于没有。
2. **行为关** — 只跑**指定的**测试文件并解析 TAP，不全量回归（受影响的才验，与 DeepInfer「只重算有界后缀」同一取舍）。
3. **边界关** — 目标必须在 root 内、扩展名白名单、禁 `node_modules`/`.git`、默认**不许改测试文件**（修代码不修考卷）。

任何一关红 → 从备份**整批**恢复（多块原子，不留半成品），账本记 `rolled_back`。

### 安全边界

- **双门**：`self_edit` 想真正落盘要同时满足「调用参数 `mode:"apply"`」+「`config.agent.self_code.mode:"apply"`」。单点误用改不坏东西。
- **账本活过重启**：`data/selfcode/ledger.jsonl` append-only，改动前原件存 `data/selfcode/backups/<id>/`。
- **不谎称已生效**：改完的源码写进 `data/selfcode/pending-reload.json`，回执明确说「重启后生效」（ESM 无热替换）。重启后跑 `npm run selfcode -- ack` 清账。

```jsonc
// config/ppx.json
"agent": {
  "self_code": { "mode": "propose", "syntax_timeout_ms": 5000, "test_timeout_ms": 120000 }
}
```

默认 `propose`：只出 diff 不动盘。要真改就把 `mode` 改成 `apply`，并接受「每次落盘前都留可回滚快照」这个代价。

---

## 🧪 测试 / 评测 / CI

```bash
npm test                # 全量测试
npm run verify          # 一键本地快检 (17 项, 离线, 无需 LLM; 含离线任务基准与记忆召回闸门)
npm run verify:full     # 一键快检 + 全量测试
npm run test:coverage   # 全量测试 + Node 内置覆盖率 (行覆盖 91.9%, 门禁 85%)
npm run coverage:gate   # 覆盖率门禁 (行覆盖 >= 85%, CI 用)
npm run eval            # 本地能力评测 (7 项, 无需 LLM)
npm run eval -- --llm   # LLM 端到端评测 (需 provider)
npm run bench           # 并发/长会话吞吐压测
npm run nightly         # 四基准一键跑分 → docs/bench/nightly-<date>.{json,md} (公开可复现报告)
npm run audit:verify    # 审计哈希链完整性校验 (含 HMAC 签名重放)
npm run selfiterate -- --list-failing   # 全量测试列出失败文件 (自主迭代入口)
npm run selfiterate -- test/x.test.js   # 对失败测试跑 诊断→补丁→验证→回滚 闭环 (默认只出补丁)
npm run evolve:loop                     # 手动一轮持续进化: 弱点学习→代码迭代→度量落账 (--status 看报告)
```

**GitHub Actions CI**：push/PR 自动跑全量测试 + Web 静态自检 + 本地评测。要启用 LLM 回归，在 Settings → Secrets 配置 `PPX_E2E_BASE_URL` / `PPX_E2E_API_KEY` / `PPX_E2E_MODEL`。

---

## 🧠 记忆架构（L0 → L4）

```
对话 → L0 原始对话(会话日志) → L1 原子记忆(高斯衰减) → L2 场景(关键词聚类) → L3 画像(persona)
                                                                           → L4 程序性记忆(技能/流程, 慢遗忘)
```

- **L0**：`data/sessions/*.jsonl` 全量承载 + MemoryTicker 滚动压缩
- **L1**：`facts.json`，score = score × exp(-λt²)，命中加分（λ = `decay_per_day`）
- **L2**：`scenes.json` 相关记忆聚类
- **L3**：`user.persona.md` + `agent.persona.md`
- **L4**：技能/流程程序性记忆，衰减率 0.005 仅为 L1 的 1/4 —— 技能长期留存

**记忆治理（可回滚的遗忘）**：软删(`memory_forget`) + 回滚(`memory_restore`) + 复核(`memory_list_deleted`) + 版本链 + TTL 归并 + 按层清理 + 导出/导入迁移。容量保护仍是硬删(`_prune` 裁最弱项)，治理管「想忘的」、`_prune` 管「装不下的」，两者分工不重叠。

**语义检索（开箱即用）**：`memory_search` 走 dense+BM25 双路 RRF 融合。未配置云端 embedding 时自动注入内置零依赖哈希 embedder（字符 n-gram 特征哈希 256 维，抓子词/词形/CJK 字面近义）；向量落盘缓存（`data/memory/vectors.json`，内容哈希失效键 + embedder 指纹换代作废），配云端/本地模型（`config.embedding`）自动切换且重启不重算。显式 `config.embedding.fallback: "off"` 恢复纯 BM25。

---

## 📂 目录结构

```
PPXANS-Harness/
├── config/         配置 (ppx.json + 人格)
├── src/
│   ├── agent/      Agent 引擎 (工具循环 + 多模型回退 + v3 插件装配)
│   ├── intent/     [v4.2] 分层漏斗意图识别 (L1 规则直答 / L2 上下文提示注入 / 层流量统计)
│   ├── protocol/   [v3] EQ 事件流(WAL) + SQ 在轮账本/控制 op
│   ├── session/    [v3] turn.js + projection.js 已接入主链路; workstack/plan-live 参与装配
│   ├── permissions/[v3] 审批 + 沙箱 + 规则链 + canUseTool
│   ├── hooks/      [v3] 六事件钩子链
│   ├── edit/       [v3] SR 编辑块 + 快照回滚
│   ├── selfcode/   自改代码闭环 (账本 + 三关验证 + 绿留红滚, 2026-10-27)
│   ├── web/        本体 (bot) 形态 Web 接口 (状态聚合 / 档案 / 轨迹, 2026-10-27)
│   ├── repomap/    [v3] 仓库地图 (PageRank)
│   ├── verify/     [v3] 校验域 (claims / path-evidence / postcondition + review.js 分级审查, 2026-11-12 迁入)
│   ├── evidence/   [v3] 证据边界 + 目标看板 + manifest
│   ├── commands/   [v3] 斜杠命令统一模型
│   ├── plugin/     DI 容器 (Context/compose/loadPlugins, 纯 L0; 2026-11-08 装配器归位 agent/)
│   ├── workgraph/  [2026-11-02] 工单账本 (Tickets/Assignments + 恢复/重跑)
│   ├── flow/       [2026-11-02] 入站流内核 (Trigger 归一 / 两级准入 / planIngress 六动作)
│   ├── tools/      工具系统 (126 个注册工具; MCP 另暴露 22 个 ppx.* 方法)
│   ├── core/  services/  memory/  audit/  ans/  selfheal/  channels/  orchestrator/  llm/  utils/
├── webapp/         Vue3+Vite 前端源码; dist/ 为预构建产物 (v5.0 重铸, 发布零运行时依赖)
├── bin/            ppx / ppxans 单一入口 (2026-11-08 收敛: 8 个 bin 合一)
├── data/           运行时数据 (不进 git)
├── references/     第三方项目来源登记
├── test/           测试 (283 文件, node --test; 总项数以机读锚点为准)
└── docs/           文档 (ARCHITECTURE-CURRENT / PROJECT-OVERVIEW / PROVENANCE / QUICKSTART / WORK-GRAPH 等)
```

---

## 📄 License

Apache License 2.0。再分发安装包或修改版时，请保留 [LICENSE](LICENSE)、[NOTICE](NOTICE)、
[THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md)，以及安装目录中的
`LICENSE.electron.txt` / `LICENSES.chromium.html`。

## 🙏 架构来源与致谢

- [openhanako (HanaAgent)](https://github.com/liliMozi/openhanako) — 记忆分层、自愈内核、人格系统
- [TencentDB-Agent-Memory](https://github.com/TencentCloud/TencentDB-Agent-Memory) — L0-L3 四层记忆架构
- **ppx-v2 (ppx Harness)** — 审计哈希链、记忆治理、L4 程序性记忆、治理工具
- [openai/codex](https://github.com/openai/codex) — v3.0 主轴架构参照 (SQ/EQ 队列、权限、仓库地图)
- [deepseek-ai/deepseek-harness](https://github.com/deepseek-ai/deepseek-harness) 与 [deepseek-ai/dsh-superagent-prototype](https://github.com/deepseek-ai/dsh-superagent-prototype) — Super-agent 设计吸收 (Router/Worker、Trigger/Thread、Tickets/Assignments、spill/compaction；**只读设计与语义，未复制源码**，见 references/THIRD-PARTY-SOURCES.md)。逐项"设计来源 → 原生实现"映射与可执行校验见 [docs/PROVENANCE.md](docs/PROVENANCE.md)
- [DeepSeek-Bot](https://github.com/rlaope/deepseek-bot)（MIT）— 终端 `dsh` 线协议与 `ask_user_question` 回合内提问语义（选项/多选/自填、阶段状态、输入历史、工具结果折叠；**只吸收交互语义，未复制源码**，见 references/THIRD-PARTY-SOURCES.md §2.2）
- [opencode](https://github.com/sst/opencode)、[claude-code](https://github.com/anthropics/claude-code)、[aider](https://aider.chat)、[OpenHands](https://github.com/All-Hands-AI/OpenHands)、[open-code-review](https://github.com/srikanth235/open-code-review)、[claude-agent-sdk-ts](https://github.com/anthropics/claude-agent-sdk-typescript)、[oh-my-hermes](https://github.com/wintermute-cell/oh-my-hermes) — v3.0 特性吸收来源（源码未直接纳，见 docs/ARCHITECTURE-CURRENT.md 与 references/THIRD-PARTY-SOURCES.md）
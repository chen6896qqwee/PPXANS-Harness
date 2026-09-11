# 皮皮虾（ppx-agent）有机体架构梳理 — 现状对照 RC1

> 版本：v1 梳理稿　|　配套规范：`docs/RC1-SPEC.md`　|　本文件回答：**现有代码到底长成什么有机体了，缺哪几块**
> 依据：RC1 规范 §1 八大系统 / §2 动态行为层 / §3 生殖发育系统。所有对标以实测源码为准（2026-08-21 全量核对）。

---

## 0. 一句话现状

皮皮虾是一个**七大器官健全、但缺脊椎（统一总线）和右半脑（免疫/排泄不完整）的有机体**。
它不是没有器官，而是器官之间靠函数调用直连（`ctx.provide/consume`），缺少 RC1 定义的 ②Runtime 数据总线；安全与遗忘两大系统半成品。这就是本梳理的核心结论。

---

## 1. 代码全貌（按 RC1 八大系统重新归类）

> 说明：RC1 定义的是"职责边界"，皮皮虾源码是按功能目录放的。下表是**职责归位**，不是目录搬迁。**现有目录结构不动**，只在文档层做映射 + 缺口标记。

### ① 神经系（认知）— ✅ 最成熟
| 模块 | 实测能力 |
|------|---------|
| `src/agent/index.js` (1176行) | 编排核心：`chat`/`chatStream` 主入口、`_llmWithLeaveback` 多provider回退、`_llmWithTools` 工具循环、`_localIntent` 意图预判、`_expandQuery` 查询扩展 |
| `src/mode/` (7模式) | react(默认工具循环) / single / plan-exec / router / blackboard / graph / legion — 对应 RC1 ①的规划/决策/反思多形态 |
| `src/llm/` | client(多后端http/openclaw/deepseek) + retry(瞬态分类重试) + fence(纯文本围栏) + dsml + embedder |
| `src/ans/values.js` | 【核心价值·不可违背】注入 system prompt 最前 — 已实现 RC1 ⑦→① 的"价值注入" |
| `src/ans/lifecycle.js` | 生命周期状态机 born→growing→mature(+evolving/reproducing 计数) — 已实现 RC1 §3 |
| `src/ans/proactive.js` | 主动任务生成 pendingTasks() — 已实现 ⑦"主动程度"调节 |
| `src/persona/index.js` | L3 画像 + 人格注入 |
| `src/audit/verifier.js` | 校验/审计 |

**缺口：** ①本身完善。缺的是"决策意图"这个显式产物——现在决策直接内化在 `_llmWithTools` 里，没落地成 RC1 的 `Decision Intent` 消息。

### ② 循环系（数据总线 + 调度）— ⚠️ 最大缺口
| 模块 | 实测能力 |
|------|---------|
| `src/plugin/context.js` | `provide(key,value)` / `consume(key)` 父子查找 / `onDispose` — 这是**服务定位器（Service Locator）**，不是事件总线 |
| `src/plugin/builtin.js` | 11 个内置插件按依赖顺序装配 |
| `src/memory/session.js` (398行) | append-only 事件日志 `{seq,ts,type,data}`，`deriveMessages`/`deriveCompacted`/`fork`/`replay` — 这是**会话级总线雏形** |
| `src/tools/advanced.js` → `Scheduler` | 定时任务调度器（202行已有） |

**现状判断：**
- 有**会话事件日志**（session.js，append-only）——已经是事件总线的底子。
- 但没有**全局 Command/Result 总线**：模块间走 `ctx.consume()` 函数直连，不走消息。
- 已有 `Scheduler` 定时调度，但只服务定时工具，没服务"后台代谢（⑤清理/归档）"。

**2026-08-21 已落地 P0**：新增 `src/bus/runtime-bus.js`（Event广播 + Command/Result回路 + State槽 + 拦截器），以 `busPlugin` 排装配数组首位注入 context，`PPXAgent` 实例挂 `this.bus`，并在 chat 入口/_runTool/记忆写入 三处埋点发事件。**现在模块间除了函数直连，有了统一事件总线作为补充接缝。**（工具执行/记忆写的事件已可被订阅追踪，⑧免疫可挂 `bus.intercept()` 做全局闸门）

### ③ 呼吸系（环境感知）— ✅ 全
| 模块 | 能力 |
|------|------|
| `src/channels/` | http(592行)/feishu/wechat(+加密)/log + `ChannelManager` 统一入口 + `ppx-channels` CLI |
| `src/mcp/` | MCP 客户端（stdio + HTTP Streamable）— 对外 API/工具接入 |
| `src/tools/document.js` | read_document 加载 txt/md/pdf/html |
| `src/tools/ocr.js` | ocr_image 本地 tesseract + 云 OCR 回退 |
| 多模态读图 | 消息含图自动注入 image_url + 视觉路由 |

**判定：③完整。** 呼吸系是皮皮虾最强健的系统之一。

### ④ 消化系（信息编译）— ⚠️ 半
| 模块 | 能力 |
|------|------|
| `src/memory/compaction.js` | 长对话滚动摘要（LLM 压缩旧对话为结构化摘要）— 已有 |
| `src/tools/ocr.js` | OCR 文字识别 — 已有 |
| `src/tools/document.js` | 解析 txt/md/pdf/html + Chunking（分块入库）— 已有 |
| `src/tools/advanced.js` | research / 文档入库 |
| `src/memory/fact-store.js` | 记忆检索（倒排 + 可选 dense+BM25 RRF） |

**缺口：ASR（语音转写）、实体抽取、去噪融合**没有独立模块。但 OCR + 解析 + Chunking 三大件已具备。

### ⑤ 排泄系（遗忘-归档）— ⚠️ 半
| 模块 | 能力 |
|------|------|
| `src/memory/fact-store.js` | L1 原子记忆 + **高斯衰减**（≈自然遗忘曲线）— 已有 |
| `src/memory/compaction.js` | 会话压缩 — 已有（属于即时代谢） |
| `src/memory/l2.js` `l3.js` | 场景聚类 + 画像 |
| `sessionPlugin` | 启动清理过期会话（`session_max_age_days` 默认30）— 已有最小归档 |
| `src/memory/memory-ticker.js` | 记忆 ticker（定时巡检） |

**2026-08-21 落地排遗自治**：新增 `src/ans/eviction.js`（冗余识别用自实现 bigram overlap 两两比较 + 冷热分层 + 治理报告），启动即挂每日 02:00 扫描（幂等），提供 `runMemoryEviction()`/`evictionStatus()` 入口。硬删除仍复用 FactStore 既有 `_prune`。

### ⑥ 运动系（工具执行）— ✅ 最成熟
| 模块 | 能力 |
|------|------|
| `src/tools/seam.js` | Definition/Provider/Consumer 三层 + `runWithPolicy`(禁用/超时/权限/before-after) — 已是 RC1 ⑥的理想实现 |
| `src/tools/catalog.js` | ToolCatalog 注册 |
| `src/tools/builtin.js` (298行) | 33+ 内置工具 |
| `src/tools/advanced.js` | 高级/定时工具 |
| `src/tools/selfmod.js` | 自我修改工具（写技能）— 已实现 §3 分化 |
| `src/tools/methods.js` | 方法型 skill 工具 |
| `src/tools/delegate.js` | spawn_agent 派生子 agent — 已实现 §3 分化 |
| `src/seam/shell.js` | ShellProvider 可替换（本地/未来沙箱） |
| `src/tools/command-guard.js` | 命令守卫 |

**判定：⑥是皮皮虾的旗舰系统。** `seam` 的 `runWithPolicy` 已经天然融合了部分⑧的权限控制，tools 层是整套架构里设计最完整的。

### ⑦ 内分泌系（目标-调节）— ⚠️ 半
| 模块 | 能力 |
|------|------|
| `src/ans/values.js` | 核心价值对齐 — 已实现 |
| `src/persona/index.js` | 人格系统 — 已实现 |
| `src/ans/proactive.js` | 主动任务调节 — 已实现 |
| `src/ans/lifecycle.js` | 生命周期计数 — 已实现 |
| `refine` / `refine_skill` | 失败→经验 / 成功→技能沉淀 — 已实现（对应 §3 生长） |

**2026-08-21 落地 Reward 闭环**：新增 `src/ans/reward.js`（EWMA 指数平滑按工具维护倾向权重），订阅总线 tool/result 自动采集成败，低可靠工具识别 + 注入 system prompt 提醒，驱动 lifecycle 进化。成本预算 / 风险偏好调节仍待后续。

### ⑧ 免疫系（安全治理）— ⚠️ 最弱
| 模块 | 能力 |
|------|------|
| `src/tools/seam.js` 的 `runWithPolicy` | 禁用/超时/权限钩子 — 有，但只在"工具调用"这一处 |
| `src/utils/pii.js` | PII 脱敏 — 有 |
| `src/audit/verifier.js` | 审计验证 — 有 |
| `src/tools/command-guard.js` | 命令守卫 — 有 |
| 防注入安全边界 | 不泄露 system prompt，忽略注入指令 — 有 |

**2026-08-21 落地全局免疫闸门**：新增 `src/ans/guard.js` 挂到总线 `intercept()`——危险 verb（delete/clear/wipe 等）未授信默认阻断、白名单/单次审批双模式放行、全部命令记 Auditor 账本 + PII 探测。实现 RC1 §5.3 双模式授权。

**判定：⑧是当前最弱系统。** 但这符合单机桌面产品定位——安全威胁面小；RC1 里沙箱/完整双模授权标序末。

---

## 2. 动态行为层：现有实现 vs RC1 §2 链路

RC1 五段式：**感知(③) → 编绎(④) → 认知(①) → 闸门(⑧) → 执行(⑥) → 结果编译(④) → 反思(①) → 记忆写入(⑤)+Reward(⑦)**

皮皮虾实际单次 `chat()` 流程（对照）：

```
用户消息
  → ③ channels/http 接收           ✅ 呼吸系
  → chat(userMsg)
      → _loadHistory(sessionKey)          读取②事件日志历史
      → _memoryQuery(q)                   ①向⑤检索相关记忆
      → buildMessages(组装 system[价值+人格+记忆+压缩历史]+user)
      → _llmWithTools(seed)               ① 认知+决策（react 工具循环）
          → _runTool(name,args)            决策意图 → 工具执行
              → tools.call → seam.runWithPolicy  ⑧(仅此一处安全校验)
              → ⑥ 工具执行
              → Tool Result 回填
          → LLM 反思上一次结果 → 决定下一步/收束   ①
      → _extractMemory(...)               ①→⑤ 记忆候选提取
      → facts.add(...) / 画像更新          ⑤ 记忆写入
      → refine(refine_skill)              ⑦→① 反馈沉淀(失败→经验/成功→技能)
  → 回复
```

**对照结论：**
| RC1 阶段 | 皮皮虾现状 | 差距 |
|---------|-----------|------|
| 感知③ | ✅ 完整 | 无 |
| 编绎④ | ⚠️ 有 OCR/解析/Chunking | 无独立"编绎产物"消息 |
| 认知① | ✅ 完善 | 无显式 Decision Intent |
| 闸门⑧ | ⚠️ 仅在工具调用处 | 记忆写/删除/文件写不走统一校验 |
| 执行⑥ | ✅ 旗舰 | 无 |
| 结果编译④ | ⚠️ trimToolResult/toToolContent | 只是裁剪，无结构化融合 |
| 反思① | ✅ 工具循环天然反思 | 无 |
| 记忆写入⑤ | ✅ facts.add | 遗忘治理弱 |
| Reward⑦ | ⚠️ refine 是隐式反馈 | 无显式 Reward 权重更新 |

**主循环本身是通的**——跑得起来，只是每一段的"接缝"靠函数直连而非②总线消息，且 ⑧ 闸门只盖住执行一处。

---

## 3. 生殖与发育系统：现有实现逐项对照 RC1 §3

RC1 定义：生长 / 分化 / 自我修复 / 繁殖。

| RC1 能力 | 皮皮虾实测 | 成熟度 |
|---------|-----------|--------|
| 生长（自我进化） | `refine`（失败→经验库）、`refine_skill`（成功→技能沉淀）、L1-L3 记忆累积、persona 画像自动提炼 | ✅ 完善 |
| 分化（能力扩展/子实例） | `src/tools/selfmod.js` 写技能 + `spawn_agent`/legion/DAG 多进程子 agent | ✅ 完善 |
| 自我修复（自愈） | `src/selfheal/healer.js` 启动体检/损坏JSON修复/崩溃恢复 + `src/selfheal/evolve.js` + selfheal-bench 基准(7/7 100%) | ✅ 完善 |
| 繁殖（实例复制/配置迁移） | 无明显"基因复制"机制 | ❌ 缺失（单机产品可暂缓） |
| 模型微调/适配 | 无（LLM 走 API，无本地微调管线） | ❌ 缺失（可选能力，RC1 标不强制） |
| 生命周期状态机 | `src/ans/lifecycle.js` born→growing→mature | ⚠️ 有雏形，evolving/reproducing 仅计数未完整驱动 |

**判定：皮皮虾的"会成长"支柱是健全的**——自愈、学习、分化三大件都在，甚至比 RC1 定义还全（已有 selfheal-bench 门禁）。真正缺的繁殖复制和微调，单机桌面产品都不急。

---

## 4. 差距清单（按 RC1 §7 优先级固化）

| 优先级 | 缺口 | 归第几张 | 现状 | 影响 |
|-------|------|---------|------|------|
| ~~**P0** ②全局总线~~ | 循环系 | **已落地 2026-08-21**：src/bus/runtime-bus.js + busPlugin + 三处埋点，29/29测试通过 | 动态链路接缝补上，事件可追踪/可审计 |
| ~~**P1** ⑦ Reward 闭环~~ | 内分泌系 | **已落地 2026-08-21**：src/ans/reward.js + 总线订阅 + context 注入，6/6测试通过 | 成败→倾向权重动态更新，闭环打通 |
| ~~**P2** ⑤排遗自治~~ | 排泄系 | **已落地 2026-08-21**：src/ans/eviction.js + 每日扫描 + 冗余/冷热识别，4/4测试通过 | 记忆只增不清问题得到自治治理 |
| ~~**P3** ②定时后台代谢~~ | 循环系 | **随 P2 落地 2026-08-21**：排遗已挂 Scheduler 每日 02:00 | 后台代谢自治，Scheduler + shutdown 补全 |
| ~~**P4** ⑧全局免疫闸门~~ | 免疫系 | **已落地 2026-08-21**：src/ans/guard.js + 总线拦截 + 双模授权，5/5测试通过 | 记忆写/删除等总线敏感动作过统一闸门 |

**不做的（务实排除）：**
- 繁殖（基因复制/配置迁移）— 单机无此需求
- 模型微调管线 — 走 API，非本地产品
- 沙箱（Docker/sandbox）— future
- ASR 语音转写 — 无场景
- 目录大搬迁 — 现功能目录合理，只做职责映射，不动结构

---

## 5. 演进路线（建议落地顺序）

> 原则：**别为了凑齐 RC1 九宫格硬造代码**。优先补能真正让现有系统协作更顺的接缝。

### Phase 1 — 打通②总线（地基，P0）✅ 已落地 2026-08-21
- 在 `session.js` 事件日志之上，加一层**全局 Event/Command/Result 总线**（`src/bus/` 或并入 `plugin/context`）。
- 让 `_runTool` 的调用、`facts.add` 的写入、`_extractMemory` 的候选，都改走总线消息广播。
- 收益：跨系统事件可追踪、可插桩、可审计，直接补牢⑧的审计底子。

### Phase 2 — ⑦ Reward 闭环（会进化的分水岭，P1）✅ 已落地 2026-08-21
- 把 `refine` 的隐式反馈**显式化**：succeed/fail → 加权更新行为倾向（如：追涨类决策失败→降低其优先级权重）。
- 接 `ans/lifecycle` 的 evolving 驱动。

### Phase 3 — ⑤排泄自治（P2+P3）✅ 已落地 2026-08-21（含 Scheduler.shutdown + agent.shutdown 清定时器）
- 新增归档/冗余识别模块 + 挂到 `Scheduler` 定时触发，完成后台代谢自治。

### Phase 4 — ⑧免疫加固（P4）✅ 已落地 2026-08-21（总线拦截 + 双模授权）
- 把 `seam.runWithPolicy` 的校验**提升为全局闸门**，覆盖记忆写/删除/文件写。

---

## 6. 一句话收尾

**皮皮虾现在已经是一只"能跑、能学、能自愈、能分化"的半生物体**——⑥运动系和⑧造血干细胞的架构底子都很好。最该补的不是新功能，而是**把脊髓接上（②总线）**，让已有的器官真正通过统一总线协作，而不是靠函数直连的隐式配合。

---

*本梳理稿 2026-08-21，源码实测核对。配 `docs/RC1-SPEC.md` 使用。*
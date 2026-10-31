# 皮皮虾 × Super-agent 架构对照与强化路线

> 来源: DeepSeek 产品部《Super-agent 设计探索: 迈向更自主的 Agent 系统》
> (mp.weixin.qq.com/s/zoS7GlReWPhfCjENGxXCdg, 2026-10)
> 本文是该文章五大模块与皮皮虾 (PPXANS-Harness) 现状的逐条对照、
> 一期 (2026-10-31) 已落地的改动, 以及二期/三期路线。

## 一、四大基础特征 × 皮皮虾现状

| 特征 | 文章含义 | 皮皮虾现状 | 判定 |
|---|---|---|---|
| 连续 | 跨信道同一 Agent, 无需想"Session X 里有没有 Y" | 常驻本体 (Web UI 本体首页) + 飞书/微信/HTTP 多渠道; 一期前渠道消息全混 default 会话 | 有底座, 一期补齐话题/群组归组 |
| 高效 | 并行多任务互不阻塞, 不等上一条完成 | legion 多进程并发 (8 背压) + 同会话互斥跨会话并行 | **已是最强一块** |
| 主动 | 持续观察环境事件, 不需 @ 才动 | proactive ticker (1h 扫记忆) + evolution_loop (每日 03:30) + watchdog (一期, 30min 心跳) | 定时驱动已有; 环境事件驱动一期补地基 |
| 持久 | 始终在线, 异常自动恢复 | selfheal 7/7 + 崩溃恢复 + delivery WAL 续投 | 单机持久已好; 云端存算分离未做 (三期) |

## 二、五大模块对照

### 1. 双层架构 (Router / Worker)

| 文章要点 | 皮皮虾现状 | 一期动作 | 缺口 |
|---|---|---|---|
| 常驻 Router 层只承接交互与分派, 不执行具体任务 | ppx-web 单 PPXAgent 常驻, 但既交互又干活; orchestrator/room.js 的 host 契约 ("主持人只调度不干活") 是最近似物, 仅房间级 | 未动 | 二期: room.js host 契约升格为主会话 Router 层 |
| Worker 上下文隔离并发, 强模型 | legion 子进程 = 完整 PPXAgent + 独立 dataDir (`src/orchestrator/legion.js`), SDD review/supervisor/班组拓扑齐备 | — | 无 (文章此项皮皮虾已达标) |
| Worker 只向 Router 汇报不直连用户 | 结构上被动成立 (worker 无通道, stdout 回父进程) | — | 汇报是纯文本 reply, 无结构化信封 (二期) |
| Router 批处理积压事件 | SQ 队列有载体 (`src/protocol/index.js`), 同会话消息排队但不合并 | 未动 | 二期: turn 收口时合并积压注入 |
| 并发治理 | **governor 写好了但没挂上** (`delegate.js:202`/`team-room.js:89` 的 `typeof L.spawnAgents === "function"` 恒 false) | **已接通**: `Legion.governor` + `spawnAgents([{name,opts}])`, spawn 纳入 acquire(1) 配额, 进程 exit/error 归还许可 | 无 |

### 2. 事件驱动 (Trigger / Thread / 过滤 / 直通)

| 文章要点 | 皮皮虾一期前 | 一期落地 |
|---|---|---|
| Trigger 结构化事件 (来源/群组/发送者/线程 ID) | 入站退化为裸字符串 `(from, text)`, 全部上下文在通道层丢弃 | **`src/channels/trigger.js`**: Trigger 对象 `{id, source, from, group, thread, messageId, text, ts, scope}`; 飞书 v2 事件完整读出 chat_id/chat_type/root_id/parent_id/message_id |
| Thread 归组 (同话题/同 PR 连续事件成串) | `orchestrator/session-key.js` 四段式会话键现成 (含 feishu/wechat surface) 但渠道零调用, 全部消息混 default | **`sessionKeyForTrigger`**: 群聊 session=chat_id, 话题回复=chat_id-root_id, 私聊=发送者; 会话互斥/记忆分区/审计分区全部按归组白拿; `session_mapping:"shared"` 可回退旧行为 |
| 两级过滤 (程序 Fast Path + LLM Slow Path) | 无任何事件级过滤 | **`src/channels/policy.js`**: `admitTrigger` 纯函数程序层 (mode all/whitelist/off + 黑白名单, deny 恒胜) + `admitSemantic` 可选 LLM 层 (fail-open) + `admitThroughPolicy` 全链 tracer 留痕 |
| 结果回投原话题 | delivery 队列 `enqueue` 有 meta 参数但 broadcast 恒传 null | **meta 透传**: `broadcast(text,{meta})` → delivery job (WAL 持久) → `channel.send(to,text,meta)` 第三参 |
| 订阅直通 (同 Thread 后续事件不经 Router) | EQ subscribe 骨架在, 语义分层无 | 二期: Trigger.id 已具备做引用图键 |

### 3. 面向人的交互

| 文章要点 | 皮皮虾现状 | 动作 |
|---|---|---|
| 异步 ReAct Loop (start/stop, 后台不阻塞前台) | 四套后台机制并存但无结果回投闭环; bot settings.worker 纯 UI 悬空 | 二期 (meta 回投通道一期已铺) |
| 多信道输出规范 (IM ≤100 词 / 异步信道结构化) | 无渠道定制 (飞书纯 text, 微信 CDATA 转义是唯一特判) | 二期 |
| 全双工: 用户在后台执行中可继续说话 | `_streamAborts` + queuedUserInputs 有雏形 | 二期 |

### 4. 计算、状态与环境分离

| 文章要点 | 皮皮虾现状 | 动作 |
|---|---|---|
| 计算与状态分离 (无状态计算 + DB) | 单机 Electron/Node 进程, 状态落 data/ | 三期 (与桌面形态冲突, 需先想清楚产品定位) |
| 执行环境解耦 + 端侧 daemon (BYOM) | 无 | 三期 |

### 5. Watchdog

| 文章要点 | 皮皮虾一期前 | 一期落地 |
|---|---|---|
| 主系统外独立 Control Loop | selfheal 是启动时体检, 无运行时任务级监控 | **`src/ans/watchdog.js`**: 定时心跳 (默认 30min, `agent.watchdog` 配置) → 采集体征 (SQ 死轮水位/工作栈阻塞/故障病历头部/内存) → 独立看门狗会话 (`ppx:cron:watchdog:dm`, 完整工具能力, 可自查深挖) → 首行 OK/WARN/CRIT 分级, 异常才广播, 全量落账 `data/evolve/watchdog.jsonl` |
| 用自然语言询问故障 | 无专门入口 | 看门狗会话本身可被追问 (sessionKey 隔离) |
| 在线修正主系统行为 | hooks/permissions 热更已有 | 看门狗会话具备全部工具 (谨慎依赖审批四档兜底) |

## 三、一期改动清单 (2026-10-31)

新建: `src/channels/trigger.js` · `src/channels/policy.js` · `src/ans/watchdog.js` ·
`test/trigger.test.js` · `test/trigger-policy.test.js` · `test/watchdog.test.js` · `test/legion-governor.test.js`

修改: `src/channels/{base,feishu,wechat,index,delivery}.js` · `src/orchestrator/legion.js` ·
`src/agent/index.js` (startWatchdog/stopWatchdog) · `src/server.js` · `src/config/index.js` · `config/ppx.json`

配置 (防御式读取, 无配置 = 行为不变):

```jsonc
// config/ppx.json → agent
"watchdog": { "enabled": true, "interval_minutes": 30 },
"trigger_policy": {
  "mode": "all",              // all | whitelist | off
  "semantic": false,          // LLM 语义层 (fail-open)
  "semantic_prompt": "",
  "session_mapping": "chat",  // chat=每群/每人独立会话(推荐) | shared=旧行为
  "deny_groups": [], "allow_groups": [], "deny_senders": [], "allow_senders": []
}
```

行为变化 (唯一): `session_mapping:"chat"` (新默认) 下飞书/微信每群/每人独立会话;
旧行为 (全混 default) 改回 `"shared"` 即可。

## 四、二期/三期路线 (按文章顺序)

1. **订阅直通**: EQ 事件加 cause/thread 引用字段; 订阅注册表让同一 Thread 的后续事件程序直通已订阅 Worker, 不经 Router LLM (文章 §3.2, 实测省 ~37% Router token)
2. **Router 批处理**: turn 收口时把积压的追打消息合并成一批注入 (queuedUserInputs + SQ 载体已在, 缺合并消费) (§2.1, 实测拥堵时分摊推理时间 6.4s→1.6s)
3. **链式召回**: 对象 ID 内联 (Trigger.id/fact.id/callId 已有) + `context_read` 按 ID 续读被裁内容 (把 trimToolResult 的告示牌变成续读入口); 需守 prefix-cache 静态区契约 (§3.3)
4. **异步 ReAct + 投机执行**: 后台 start/stop + 结果经 meta 回投原话题; "静默复现修复"策略 (§3.4/§4.1)
5. **多信道输出规范**: IM 短回复 / GitHub·邮件结构化 (§4.2)
6. **存算分离 + 端侧 daemon**: 与桌面形态冲突最大, 放三期 (§5)

## 五、验证

```bash
node --test test/trigger.test.js test/trigger-policy.test.js test/watchdog.test.js test/legion-governor.test.js
npm test && npm run selfheal && npm run taskbench:offline
node scripts/readme-sync-check.js
```

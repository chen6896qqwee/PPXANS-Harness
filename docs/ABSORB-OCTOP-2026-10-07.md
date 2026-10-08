# 吸收报告：TencentCloud/Octop → PPXANS-Harness

> 日期: 2026-10-07 ｜ 上游: [TencentCloud/Octop](https://github.com/TencentCloud/Octop) (MIT, Python, 7.5k★, 2026-07-08 建仓)
> 目标: 把 Octop 的能力吸收进 PPX —— **PPX 是零依赖纯 Node，Octop 是 Python**，因此只能是"吸收架构与契约，用零依赖 Node 复刻"，与当年吸收 deepseek-harness / Superpowers / codex 同一路子。

---

## 0. 一句话

Octop 最值钱的不是功能清单，是**三个把"多 Agent 协作"落成具体契约的设计**：
① 专家是**磁盘上的内容资产**（不是代码里的常量）；② 团队是**主持人 + 异步派工 + 回叫闭环**（不是一堆并行请求）；③ 人格是**结构化数据 + 追加式修剪**（不是一段可被覆盖的提示词）。

这三条 PPX 原本都没有，现在都有了。**代码 0 行来自上游**（Python ↔ Node，且上游 MIT 也无需抄），吸收的是设计与契约。

---

## 1. 吸收映射表

| Octop 的东西 | PPX 原状 | 吸收结果 |
|---|---|---|
| **专家包** `library/<id>/{manifest.json, SOUL.md}` + 启动扫描 `ExpertCatalog`<br>*"expert is metadata in manifest.json plus files on disk"* | 23 个专家**硬编码**在 `experts.js` 的 EXPERTS 对象里，加一个专家要改源码 + 改测试 + 发版 | `src/orchestrator/expert-pack.js`（目录册 + 多源扫描 + 校验 + 导入）+ `experts/` 内置库 **10 个包** |
| **专家市场**（分 15 个类目，可分享/导入） | 无 | `PACK_CATEGORIES` 9 个类目 + `expert_pack_list {market:true}` 市场视图 + `expert_pack_install` 导入通道（本地目录 → 用户库） |
| **团队 = 主持人(`kind=team`) + 成员 + 房间 + 真群聊上墙** | 班组（`teams.js`）只是"一组角色 + 一个拓扑"，一次性同步委派 | `src/orchestrator/room.js` `TeamRoom`：主持人/成员/时间线（带 speaker）/状态机 |
| **异步派工 inbox**（`queued/running/replying/done/failed/cancelled`，**按 callee 并发**：同成员串行、不同成员并行） | 无（`spawn_agent` 是同步等结果） | 同款六态状态机 + 每成员一条 promise 链 → 同成员串行、跨成员并行（`test/team-room.test.js` 用调用序断言） |
| **回叫闭环** `compose_followup` → 主持人收口 → `on_reply` | 无（只有一次性仲裁） | `composeFollowup()` 默认实现 + `processor.onReply` 出口，主持人侧串行 |
| **在途派工账本** `TeamJobTracker`（有在途 → `TEAM_MEMBER_BUSY`，不能移出成员） | 无 | `TeamJobTracker`：幂等 `close()`、`busyWith()`；`removeMember` 被账本拦（`force` 可强移并取消在途） |
| **人格模板** 16 型 MBTI + `_default`，`{agent_name}/{user_display}/{custom}`，persona 是骨架、system_prompt 是**追加** | `persona/index.js` 单一人格，无结构化维度 | `src/orchestrator/personas.js`：16 型 + default，四轴 + 六项行为映射，`renderPersona()` 严格追加 |
| **会话键编码** `<agent>:<surface>:<session>:<dm\|group>` | sessionKey 各处随手拼字符串 | `src/orchestrator/session-key.js`：四段编码 + 反解析 + 老键兼容归一 + 房间键 `房间~成员` |
| **团队成员列表**（主持人工作区 `.octop/manifest.json` 的 `kind` + `members`） | — | 房间快照落盘 `data/rooms/<id>.json`（含 members/timeline，**在途不落盘** —— 与上游一致） |
| **主持人权能收窄**（只 `agent_list`/`ask_agent`/记忆/时间，不挂文件系统/浏览器/MCP） | — | 主持人走 `makeHostExecutor`（主 agent 的 aux LLM + 收窄的调度系统提示），**不 spawn 子进程、不挂工具** |
| **成员被派工时视角收窄**（不能再往群里拉人） | — | `Room.peersOf()`：主持人看全部成员，成员只看同事且不含自己 |

---

## 2. 三个设计取舍（为什么没照抄）

### ① skills 不拷进包，只写引用
Octop 把 `skills/<name>/SKILL.md` 拷进每个专家包。PPX 已有 56 个内置技能 + 多源技能库（内置/用户/项目/附加）—— 包内再拷一份 = 同一份方法论两个真相源，升级必然漂移。因此 PPX 的 `manifest.skills` 只写**技能 id 引用**，内容仍归技能库管。

### ② 专家包不替换 EXPERTS 常量，而是叠在上面
`EXPERTS` 的 id 是 `spawn_agent.expert` 的既有契约（测试与文档都在引用），不能被同名专家包悄悄顶掉。解析顺序固定为 **EXPERTS 优先 → 专家包兜底**，且内置包的 id 刻意与 EXPERTS 不重名。两套并存：前者稳定，后者可增长可分发。

### ③ 房间是纯数据 + 可注入 executor
房间的正确性全在**状态机与并发契约**上（谁在跑、谁排队、回叫丢没丢、移人拦没拦住），与"子进程怎么起"无关。把 executor 注入进来（生产接 Legion，测试接桩），零依赖且可确定性验证 —— 把 LLM/子进程耦合进来就再也测不干净了。

---

## 3. 明确没吸收的（附理由）

| 上游能力 | 为什么不做 |
|---|---|
| **多用户 + JWT 隔离**（`infra/users/`） | PPX 定位是**个人 Agent**；多用户会牵动 HTTP 认证与数据目录两条核心链路，收益不匹配风险。（Octop 的卖点是"全家/团队共用一个实例"，PPX 不是这个场景） |
| **PostgreSQL / LDAP / S3 / COS 存储后端** | PPX 的核心约束是**零依赖本地优先**。引入外部数据库/对象存储直接违背这条，且与 SQLite/JSON 双后端已有的迁移成本不成比例 |
| **知识库 RAG 集合**（`infra/knowledge/`：chunk/embed/citations/jobs） | PPX 已有 `ingest_document` + 五层记忆 + 可选向量检索（`embedding`），覆盖度约 90%。真正缺的是"引用落点"（citations），属下一轮 |
| **连接器体系**（`infra/connectors/`：MCP 目录 / OAuth / 邮件服务器 / 探针） | PPX 已有零依赖 MCP 客户端 + 服务端 + 自定义工具目录。上游的增量在"OAuth 授权管理"与"连接器市场"，需要 HTTPS 回调面，超出本轮 |
| **Bridge 跨实例隧道**（`infra/bridge/`：crypto / http_tunnel / peer_auth） | 需要长期在线的对端与密钥协商，零依赖下自研 TLS 隧道不划算 |
| **ACP 双向集成**（把编码任务委派给 OpenCode / Claude Code） | 有价值但需对接外部 CLI 协议；PPX 的 `run_command` + `spawn_agent` 已能覆盖"起外部编码 agent 并收结果"的基本形态，正式 ACP 协议留待下轮 |
| **远程桌面 / Browser AI**（无头 Chromium + WebSocket 桌面控制） | 零依赖纯 Node 下要么引入 ws/chromium 依赖，要么自研 WebSocket 栈；后者成本远超收益 |
| **cron 自然语言排程** | PPX `Scheduler` 已支持 cron 表达式 + 持久化恢复；"自然语言 → cron"是薄薄一层 LLM 转换，价值有限，暂不做 |
| **i18n 双语 bundles** | PPX 是中文向导项目，单语是有意选择 |

---

## 4. 交付清单

**新增源码 (5 个)**
```
src/orchestrator/expert-pack.js    专家包目录册 (多源扫描 / 校验 / 市场 / 导入)
src/orchestrator/personas.js       MBTI 16 型 + default (四轴 + 六项行为 + 渲染)
src/orchestrator/room.js           团队房间运行时 (六态 inbox / 按 callee 并发 / 回叫 / 账本)
src/orchestrator/session-key.js    会话键四段编码 scheme
src/tools/expert-hub.js            专家库/人格/市场工具 (5 个)
src/tools/team-room.js             团队房间工具 (7 个) + Legion 成员 executor + 主持人 executor
```

**新增内容资产 (10 个专家包 = 20 个文件)**
```
experts/general-assistant/        通用助理            [meta/assistant]
experts/ai-coding-coach/          AI 编程实战导师      [code/engineering]
experts/ops-engineer/             运维工程师           [code/engineering]
experts/aigc-showrunner/          AIGC 内容总监        [content/content]
experts/prompt-engineer/          提示词工程师         [content/content]
experts/data-analyst/             数据分析官           [data/data]
experts/multi-agent-orchestrator/ 多智能体编排官       [collab/meta]
experts/legal-reviewer/           法务审阅官           [legal/risk]  只读 + 需人工
experts/financial-analyst/        金融分析官           [finance/risk] 只读 + 需人工
experts/parenting-companion/      育儿管家             [life/risk]   需人工
```

**新增测试 (2 个文件 / 40 项)**
```
test/expert-pack.test.js   15 项  人格数据完整性 / 渲染追加契约 / manifest 闸门 / 多源 first-wins / 导入安全 / 真实库零问题
test/team-room.test.js     25 项  按 callee 并发 / 回叫闭环 / 在途账本 / 状态机 / 快照恢复 / 会话键 / 工具全链路
```

**修改**
```
src/orchestrator/index.js   统一出口补新模块
src/tools/index.js          新工具与类出口
src/plugin/builtin.js       装配 expertPacks 目录册 + 注册 12 个新工具
src/agent/index.js          consume("expertPacks")
src/tools/delegate.js       resolveAnyExpert: EXPERTS 优先 → 专家包兜底 (spawn_agent 的 expert 参数现在认包 id)
src/config/index.js         + experts.{builtin,user_dir,project_dir,extra_dirs}
package.json                打包清单 + experts/
test/config-consistency.test.js / test/capability-guard.test.js  配置与只读面守卫同步
```

---

## 5. 证据

| 闸门 | 结果 |
|---|---|
| `npm test` | **1543 项 / 0 失败**（新增 40: expert-pack 15 + team-room 25） |
| 工具总数 | 73 → **85**（新增 12；核心 schema 仍 26，新工具全部走按需披露 → 固定开销不变） |
| 专家包 | 内置 **10 个**，`problems()` 为空（零校验问题） |
| 人格 | **17 档**（16 型 + default），四轴 + 六项行为齐全 |
| 房间契约 | 同成员串行 / 跨成员并行（调用序断言）；在途拒移（`TEAM_MEMBER_BUSY`）；回叫 `onReply` 到达 |
| 上游校验 | 仓库 `TencentCloud/Octop` 存在，MIT，7.5k★，最近推送 2026-10-06（吸收前核实过，非凭记忆） |

---

## 6. 怎么用

```js
// 1) 看专家库 / 市场
expert_pack_list { market: true }          // 9 个类目的包分布
expert_pack_show { id: "法务审阅官" }       // 元数据 + 渲染后的角色人格块

// 2) 用专家包当委派角色 (spawn_agent 的 expert 现在认包 id)
spawn_agent { task: "把这份合同的风险点列出来", expert: "legal-reviewer" }

// 3) 开常驻团队房间 (成员进程复用, 适合反复派活)
team_room_open { name: "研发小组", members: ["ops-engineer", "ai-coding-coach"] }
team_room_dispatch { room_id: "...", member: "运维工程师", task: "体检一下网关", wait: true }
team_room_history { room_id: "..." }        // 读上墙记录 (带说话人)
team_room_close { room_id: "..." }

// 4) 给智能体换人格 (与专家正交: 专家决定干什么, 人格决定怎么说话)
persona_preview { code: "INTJ", custom: "回答尽量短" }

// 5) 装第三方专家包 (本地目录 → 用户库, 不动内置库)
expert_pack_install { src_dir: "D:/packs/my-expert" }
```

配置（`config/ppx.json`）：
```json
{ "experts": { "builtin": true, "user_dir": "~/.ppx/experts", "project_dir": "", "extra_dirs": [] } }
```

---

## 7. to-dos for human

1. **专家包要不要继续扩**：现在 10 个。类目里 `office` / `knowledge` / `life` 还是空的 —— 这三个域的包需要你的实际场景（办公流程、行业情报、家庭事务）才写得实。
2. **多用户要不要补**：我判断 PPX 是个人 Agent，所以没做。如果你确实要"家人/同事共用一套"，说一声，那是一个独立批次（会动 HTTP 认证与数据目录）。
3. **上游人物名的合规**：`ai-coding-coach` 是 Octop 里有同名包，我按中文自研重写了内容（没抄它的正文）。如果你希望完全避开与上游同名的 id，可以改名。
4. **ACP / 连接器 / 远程桌面**：这三块我列在"未吸收"里。要做的话按 ACP → 连接器 → 远程桌面 排序（收益递减、成本递增）。

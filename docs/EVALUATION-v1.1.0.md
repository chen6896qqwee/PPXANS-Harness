# 第十轮评价报告 (v1.1.0)

本轮兑现第九轮报告「第六节·下一轮候选」的全部 6 项 (P1×3 + P2×3)。全面测试 **452 项 448 过 0 失败 4 网络跳过**，脚本实测 acceptance 23/23、bench 0 失败、eval 7/7。

---

## 一、配置键一致性 (第九轮建议 #1，P1) — 已落地

**新立规约**：`test/config-consistency.test.js` 读 `DEFAULT_CONFIG` → 递归收集所有叶子键 → 断言每个键要么被 `CONSUMED` 表**消费**、要么进 `RESERVED` 表**显式预留**。**新增任何配置键而不接消费点 / 不改注册表 → 该测试直接 FAIL**。

- 这从机制上终结了历轮反复出现的"配置写了对但静默失效"问题（`allow_all` camel/snake 不匹配、FactStore 衰减键死键等）。两张注册表兼作活文档。
- **审计补齐**：`security.deny`、`tools.disabled` 一直"被消费但从未在默认结构声明" → 已补进 `DEFAULT_CONFIG`；新增 `memory.context_window`/`context_window_ratio`、provider `context_window` 并登记消费点。
- **移除死配置** `selfheal.max_restart_attempts`（第九轮建议 #6，P2）——代码零消费，按"要么实现要么移除"移除（当前无进程监督架构，实现成本不成比例），`DEFAULT_CONFIG`/`config/ppx.json`/`docs/CONFIG.md` 三处清理干净。

## 二、上下文溢出兜底 (第九轮建议 #2，P1) — 已落地

针对实测过的 `Context size exceeded`（本地小模型 + 长会话）：

- **窗口感知历史预算**：`LLMClient.context_window`（未配回退 `memory.context_window=8192`）+ `_histTokenCap()` 反推历史 token 硬上限（窗口×60%），与 `history_token_budget` 取小——本地小模型即使预算配大也不会塞爆上下文。
- **强制硬裁剪（不依赖 LLM）**：`_ensureContextFit()` 在 `_trimHistory` 之上加绝对兜底（条数硬截 + 最近优先 token 裁剪、必保最后一条），`_getSession` 双保险。这就是报告建议的"溢出时不再死等 LLM 摘要"。
- **溢出检测 + 自动降档重试**：`_isOverflowError()` 识别 `maximum context length`/`too many tokens`/413 等措辞，**不误判 AbortError**（沿用 retry 不重试约定）；`_llmWithTools` 捕获溢出 → `_shrinkMessagesForOverflow` 保留 system + 最后 user 起完整单元（含 in-flight 工具配对，不剪成孤立 tool 消息）→ 重发，最多 2 档。
- 新增 `test/context-overflow.test.js`（7 用例）。

## 三、脚本数据隔离统一 (第九轮建议 #3，P1) — 已落地

- 新增 `scripts/lib/tmp-agent.js`：`makeTmpRoot`/`makeTmpAgent`/`makeAgentOnRoot`/`cleanupTmp`。**dataDir 强制落在临时根内**（覆盖 `PPX_DATA_DIR`），**清理必经安全护栏**（路径须在 `os.tmpdir()` 内，否则抛错绝不删）。
- 改造 bench/eval/acceptance/e2e-response-smoke/memory-benchmark/e2e-volcengine-smoke **6 个脚本**，消除各自手写 mkdtemp/dataDir/rmSync——从根上杜绝将来新脚本重蹈"压测误删生产数据"（第九轮 P0）的覆辙。

## 四、Web token 失效自动引导 (第九轮建议 #4，P2) — 后端持久化落地

- HTTP 自动生成的 token 原子写盘到 `data/http-token`，重启复用。优先级：**显式配置(env/config) > 持久化复用 > 新生成并落盘**。
- 效果：后端每次重启不再换 token → Web 前端 `localStorage` 无需每次重贴；现有 401 友好提示保留作兜底。无 Web 前端改动需求（`web/AGENTS.md` 的 Next.js 新规约无需触碰）。
- 新增 `test/http-token-persist.test.js`（`resolveAuthToken` 纯函数，5 用例）。

## 五、default 会话按天分片 (第九轮建议 #5，P2) — 已落地

- `SessionStore` 仅对 `default` 分片：`default-YYYY-MM-DD.jsonl`，单文件不再无限增长；非 default 会话保持单文件，改动面收敛。
- **关键正确性**：seq **跨天连续递增**（不每天重头数，compaction upToSeq / fork / replay 不错乱）；读取把多片合并为按 seq 升序单一事件流；兼容旧 `default.jsonl`；delete/set/fork 处理全部分片。
- 新增 `test/session-daily-shard.test.js`（11 用例），并修复其一条死断言。

## 六、验证与数字

- **全量测试**：425 → **452 项，448 过，0 失败，4 网络跳过**（+27：config-consistency 4 + context-overflow 7 + http-token-persist 5 + session-daily-shard 11）。
- **脚本实测**：acceptance 23/23、bench 0 失败、eval 7/7 —— 全部走统一数据隔离 helper。
- `node --check` 通过全部修改脚本与核心文件；无未使用 import 残留。

## 一言以蔽之

第九轮报告指出的两类"看不见的坑"——**配置静默失效**、**脚本触碰生产数据**——本轮从"机制"而非"个案"层面封死：配置一致性测试是硬闸，tmp-agent 安全护栏是硬闸。上下文溢出不再是本地小模型的死局（硬裁剪 + 自动降档），token 不再每次重启折腾用户，主会话文件不再单文件无限涨。主链路信任度再上一档。
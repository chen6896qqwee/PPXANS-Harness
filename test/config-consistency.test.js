// test/config-consistency.test.js - 配置键消费一致性测试 (v1.1.0)
// 目的: 防"配置写了对但代码没读"的静默死键 (第九轮发现 camel/snake 不匹配、衰减参数死键后立此规约)
// 规约: DEFAULT_CONFIG 每个叶子键要么被代码消费 (CONSUMED), 要么是显式预留 (RESERVED)。
//       新增配置键而不接消费点 / 不改 RESERVED, 此测试直接 FAIL — 强制开发者标注去向。
// CONSUMED/RESERVED 两张表同时充当活文档: 新人看这两处就知道每个键在哪生效、哪些是预留。
import { test } from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DEFAULT_CONFIG } from "../src/config/index.js";
import { FactStore } from "../src/memory/fact-store.js";

// ---- 递归收集 DEFAULT_CONFIG 所有叶子路径 ("agent.proactive.enabled") ----
function leafPaths(obj, prefix = "", out = []) {
  for (const [k, v] of Object.entries(obj)) {
    const p = prefix ? `${prefix}.${k}` : k;
    if (v && typeof v === "object" && !Array.isArray(v)) leafPaths(v, p, out);
    else out.push(p);
  }
  return out;
}

// ---- 被代码消费的键: path -> 消费模块/位置说明 ----
// 每次都对照 src/ 实际读取处更新; 与 CONFIG.md 同步维护
const CONSUMED = {
  // agent
  "agent.name": "src/config/settings.js sanitizeSettings + 默认笔名",
  "agent.localIntent": "src/agent/index.js chat/_localIntent 本地意图预判分支",
  "agent.mode": "src/mode/* 编排模式路由 + settings",
  "agent.citation_rule": "src/agent/index.js _context 引用规则注入",
  "agent.system_extra": "src/agent/index.js _context 追加 system",
  "agent.values": "src/agent/index.js _valuesPrompt (src/ans/values.js 价值对齐注入)",
  "agent.proactive.enabled": "src/agent/index.js startProactiveTicker + cli/server 主动提醒开关",
  "agent.proactive.interval_ms": "src/agent/index.js startProactiveTicker 间隔",
  // 2026-10-31 Super-agent 一期 (docs/SUPERAGENT-GAP.md)
  "agent.watchdog.enabled": "src/agent/index.js startWatchdog + src/ans/watchdog.js installWatchdog 控制回路开关",
  "agent.watchdog.interval_minutes": "src/agent/index.js startWatchdog 心跳间隔 (下限 5 分钟)",
  "agent.trigger_policy.mode": "src/channels/policy.js admitTrigger 程序层过滤模式 (all|whitelist|off)",
  "agent.trigger_policy.semantic": "src/channels/policy.js admitSemantic LLM 语义层开关 (fail-open)",
  "agent.trigger_policy.semantic_prompt": "src/channels/policy.js admitSemantic 语义层附加策略提示词",
  "agent.trigger_policy.session_mapping": "src/channels/policy.js admitThroughPolicy → trigger.js sessionKeyForTrigger 会话归组模式 (chat|shared)",
  "agent.trigger_policy.deny_groups": "src/channels/policy.js admitTrigger 群组黑名单 (deny 恒胜)",
  "agent.trigger_policy.allow_groups": "src/channels/policy.js admitTrigger 群组白名单 (whitelist 模式)",
  "agent.trigger_policy.deny_senders": "src/channels/policy.js admitTrigger 发送者黑名单 (deny 恒胜)",
  "agent.trigger_policy.allow_senders": "src/channels/policy.js admitTrigger 发送者白名单 (whitelist 模式)",
  "agent.max_tool_rounds": "src/core/policy.js ToolLoopPolicy 工具循环最大轮次",
  "agent.tool_result_budget": "src/core/policy.js trimToolResult 结果裁剪预算",
  "agent.max_tool_error_retry": "src/core/policy.js ToolLoopPolicy 工具错误重试次数",
  "agent.max_parallel_tools": "src/core/policy.js ToolLoopPolicy.maxParallelTools + mapBounded 同轮工具并发上限 (0=不限)",
  "agent.exhausted_finalize": "src/core/policy.js exhaustedFinalizeText 轮次耗尽后补一次无工具收口",
  "agent.tool_exposure": "src/agent/index.js _applyToolExposure → src/tools/catalog.js setExposure 工具曝光收窄 (all/core/自定义名单)",
  "agent.tool_timeout_ms": "src/tools/seam.js runWithPolicy 全局默认超时 (工具级 timeoutMs 优先) + src/agent/index.js _runTool 传参",
  "agent.model_preference": "src/llm/router.js orderProviders 本地/云端优先级(local 默认)",
  "agent.workspace_prompt_mode": "src/agent/prompts.js _workspacePrompt 工作目录段模式 (absolute=写绝对路径, neutral=跨机器缓存中立)",
  "agent.legion.max_concurrent_agents": "src/orchestrator/governor.js governorOptsFromConfig 军团全局并发上限",
  "agent.legion.max_concurrent_per_call": "src/orchestrator/governor.js 单次派发宽度上限 + src/tools/orchestration.js legion_set_concurrency 运行时热调",
  // user
  "user.name": "src/agent/index.js userName (persona 称呼)",
  // providers
  "providers": "src/plugin/builtin.js resolveAllLLMs + config/providers CRUD",
  // llm (运行时模型/思考强度选择, 2026-10-11 Web UI 模型胶囊/思考强度滑杆)
  "llm.provider": "src/llm/router.js explicitProvider 显式选定 provider + src/channels/http.js /api/llm 读写",
  "llm.reasoning": "src/llm/router.js reasoningOpts → src/llm/client.js _thinkParams 按厂商家族注入思考参数 + /api/llm",
  // network (2026-10-11 国内访问 GitHub 等被墙站点的代理)
  "network.proxy": "src/utils/http-proxy.js configuredProxy 显式代理地址 (http://127.0.0.1:7890)",
  "network.auto_proxy": "src/utils/http-proxy.js resolveProxy 未显式配置时自动探测本地常见代理端口",
  // memory (decay/importance/forget 由 src/memory/fact-store.js snake 兼容读取)
  "memory.decay_per_day": "src/memory/fact-store.js FactStore 衰减率",
  "memory.hit_bonus": "src/memory/fact-store.js 命中加分",
  "memory.base_importance": "src/memory/fact-store.js 基础重要性",
  "memory.forget_speed": "src/memory/fact-store.js 遗忘速度",
  "memory.max_facts": "src/memory/fact-store.js L1 总量上限裁剪",
  "memory.max_history_items": "src/agent/index.js _trimHistory 条数上限",
  "memory.history_token_budget": "src/agent/context.js _trimHistory/_maybeCompact token 预算",
  "memory.adaptive_budget": "src/agent/context.js _historyBudget 全局配额规划 (true=min(legacy,planned))",
  "memory.context_window": "src/agent/index.js _histTokenCap 上下文窗口兜底 (溢出防护)",
  "memory.context_window_ratio": "src/agent/index.js _histTokenCap 历史占用窗口安全比例",
  "memory.session_max_age_days": "src/plugin/builtin.js pruneOld 会话保留天数",
  "memory.session_archive_days": "src/plugin/builtin.js autoArchive 会话自动归档天数 (0=不归档)",
  // tools
  "tools.enabled": "src/plugin/builtin.js toolsEnabled",
  "tools.custom_dir": "src/plugin/builtin.js 自定义工具目录",
  "tools.disabled": "src/agent/index.js _applyDisabledTools + settings 启停",
  // plugins
  "plugins.dir": "src/agent/index.js 插件装配目录",
  // mcp
  "mcp.servers": "src/mcp/* + agent.connectMcp",
  "mcp.auto_connect": "src/agent/index.js 启动自动连接",
  // channels
  "channels.http.enabled": "src/channels/index.js 启停策略",
  "channels.http.port": "src/channels/http.js + settings",
  "channels.http.auth_token": "src/channels/http.js 认证 (env>config>持久化)",
  "channels.http.cors_origin": "src/channels/http.js CORS 白名单",
  "channels.feishu.enabled": "src/channels/index.js 启停",
  "channels.feishu.appId": "src/channels/feishu.js",
  "channels.feishu.appSecret": "src/channels/feishu.js",
  "channels.feishu.verifyToken": "src/channels/feishu.js",
  "channels.wechat.enabled": "src/channels/index.js 启停",
  "channels.wechat.path": "src/channels/wechat.js webhook 路径",
  "channels.wechat.token": "src/channels/wechat.js 验签 token",
  "channels.wechat.encodingAESKey": "src/channels/wechat-crypto.js 加解密",
  "channels.wechat.corpId": "src/channels/wechat.js 主动推送",
  "channels.wechat.corpSecret": "src/channels/wechat.js 主动推送",
  "channels.wechat.agentId": "src/channels/wechat.js 主动推送",
  "channels.log.enabled": "src/channels/index.js + channels/log.js",
  "channels.log.target": "src/channels/log.js 输出目标",
  // delivery (2026-10-31 队列⑦ 渠道投递队列)
  "channels.delivery.enabled": "src/channels/index.js broadcast 队列/直发分流",
  "channels.delivery.retry_max": "src/channels/index.js → createDeliveryQueue 最大重试次数",
  "channels.delivery.backoff_ms": "src/channels/index.js → createDeliveryQueue 首次退避 (指数 ×2)",
  "channels.delivery.ttl_ms": "src/channels/index.js → createDeliveryQueue 过期丢弃",
  "channels.delivery.max_queue": "src/channels/index.js → createDeliveryQueue 积压上限",
  "channels.delivery.wal": "src/channels/index.js WAL 落盘续投开关 (delivery.wal.jsonl)",
  // security (经 tools/builtin.js checkCommand 消费)
  "security.allow_all": "src/tools/builtin.js run_command/checkCommand (snake 兼容)",
  "security.shell_provider": "src/plugin/builtin.js toolsPlugin shell seam 选型 (local|docker)",
  "security.docker.image": "src/plugin/builtin.js → DockerShellProvider 容器镜像",
  "security.docker.network": "src/seam/shell.js buildDockerRunArgs --network (none=断网默认)",
  "security.docker.memory": "src/seam/shell.js buildDockerRunArgs --memory",
  "security.docker.cpus": "src/seam/shell.js buildDockerRunArgs --cpus",
  "security.docker.pids_limit": "src/seam/shell.js buildDockerRunArgs --pids-limit",
  "security.docker.user": "src/seam/shell.js buildDockerRunArgs -u (空=镜像默认)",
  "security.docker.env_pass": "src/seam/shell.js buildDockerRunArgs 环境变量透传白名单",
  "security.docker.missing": "src/seam/shell.js DockerShellProvider docker 不可用时回退/报错",
  "security.docker.bin": "src/seam/shell.js DockerShellProvider docker 可执行文件名",
  "security.command_timeout_ms": "src/seam/shell.js 命令执行超时",
  "security.code_act": "src/tools/builtin.js code_act 开关",
  "security.deny": "src/tools/builtin.js checkCommand 用户拒绝规则 (glob)",
  // hooks (2026-10-31 用户配置钩子, 事件数组由用户按需添加不进默认值, 故只有元键)
  "hooks.trust_project_roots": "src/hooks/user-hooks.js registerUserHooks 项目级 .ppx/settings.json 钩子信任白名单",
  // ---- 2026-11-16 离线对账补齐: 以下键在 v5.2.0 重构后消费点已迁址/新增, 逐个 grep 核实后登记 ----
  "agent.legion.pool_size": "src/agent/bootstrap.js worker 热池预热 + src/orchestrator/legion.js 池上限",
  "agent.watchdog.stall_minutes": "src/ans/watchdog.js 停滞判定窗口",
  "agent.watchdog.drift_repeat": "src/ans/watchdog.js 漂移重复阈值",
  "agent.watchdog.drift_rounds": "src/ans/watchdog.js 漂移观察轮数",
  "agent.work_graph.enabled": "src/agent/bootstrap.js installWorkGraph 开关",
  "agent.work_graph.max_tickets": "src/workgraph/store.js 单文件工单上限",
  "agent.work_graph.retention_days": "src/workgraph/store.js/服务维护保留天数",
  "agent.work_graph.compact_at": "src/workgraph/store.js 折叠阈值",
  "agent.work_graph.dedupe_ms": "src/workgraph/service.js 入站去重窗口",
  "agent.work_graph.recover": "src/agent/bootstrap.js 启动恢复策略",
  "agent.work_graph.resume_unstarted": "src/workgraph/service.js 未开始子集恢复",
  "agent.work_graph.resume_started": "src/workgraph/service.js working 工单安全重放",
  "agent.work_graph.resume_checkpoint": "src/workgraph/service.js 断点续执行",
  "agent.work_graph.resume_max_age_ms": "src/workgraph/service.js 恢复年龄上限",
  "agent.work_graph.resume_limit": "src/workgraph/service.js 单次恢复条数",
  "agent.work_graph.state_backend": "src/workgraph/journal.js jsonl/sqlite 后端选择",
  "agent.task_extract.enabled": "src/flow/extract.js 需求提炼通道开关",
  "agent.task_extract.semantic": "src/flow/extract.js LLM 语义层开关",
  "agent.task_extract.timeout_ms": "src/flow/extract.js 语义层超时",
  "agent.task_extract.max_chars": "src/flow/extract.js 提炼正文上限",
  "agent.lsp.enabled": "src/agent/plugins/builtin.js lsp 工具注册开关",
  "agent.lsp.timeout_ms": "src/tools/lsp.js JSON-RPC 超时",
  "agent.router_role.enabled": "src/agent/role.js + src/agent/tool-admit.js 角色闸",
  "agent.router_role.allow": "src/agent/role.js ROUTER 追加允许名单",
  "agent.delegate_memory_inject": "src/tools/delegate.js 派发前记忆检索注入",
  "agent.delegate_memory_writeback": "src/tools/delegate.js worker 结论回写 FactStore",
  "ans_lane.version": "src/config/ans-lane.js 车道配置版本",
  "ans_lane.enabled": "src/channels/ans-lane.js 车道总开关",
  "ans_lane.internal_only": "src/channels/ans-lane.js 内部消息限定",
  "ans_lane.origin": "src/channels/ans-lane.js 消息来源标识",
  "ans_lane.sources": "src/channels/ans-lane.js 允许来源",
  "ans_lane.mode": "src/channels/ans-lane.js 投递模式",
  "ans_lane.create_ticket": "src/channels/ans-lane.js 是否建工单",
  "ans_lane.targets": "src/channels/ans-lane.js 目标通道",
  "ans_lane.delivery.route": "src/channels/ans-lane.js delivery 路由",
  "ans_lane.delivery.max_attempts": "src/channels/ans-lane.js 重试次数",
  "ans_lane.delivery.backoff_ms": "src/channels/ans-lane.js 退避基数",
  "ans_lane.delivery.backoff_cap_ms": "src/channels/ans-lane.js 退避上限",
  "ans_lane.delivery.jitter_ratio": "src/channels/ans-lane.js 退避抖动",
  "ans_lane.delivery.ttl_ms": "src/channels/ans-lane.js 投递过期",
  "ans_lane.delivery.deadline_ms": "src/channels/ans-lane.js 投递截止",
  "ans_lane.dedupe.strategy": "src/channels/ans-lane.js 去重策略",
  "ans_lane.dedupe.bucket_ms": "src/channels/ans-lane.js 去重分桶",
  "ans_lane.dedupe.key_prefix": "src/channels/ans-lane.js 去重键前缀",
  "ans_lane.dedupe.window_ms": "src/channels/ans-lane.js 去重窗口",
  "ans_lane.rate_limit.min_interval_ms": "src/channels/ans-lane.js 最小间隔限流",
  "ans_lane.rate_limit.max_per_hour": "src/channels/ans-lane.js 小时限流",
  "ans_lane.security.inherit": "src/channels/ans-lane.js 继承全局安全策略",
  "ans_lane.security.extra_deny_tools": "src/agent/tool-admit.js 车道加严黑名单",
  "skills.disabled": "src/agent/bootstrap.js 停用技能过滤 + settings 启停",
  "channels.telegram.enabled": "src/channels/telegram.js 启停",
  "channels.telegram.botToken": "src/channels/telegram.js getUpdates/sendMessage 凭据",
  "channels.telegram.api_base": "src/channels/telegram.js API 基地址",
  "channels.telegram.poll_timeout_seconds": "src/channels/telegram.js 长轮询超时",
  "channels.telegram.poll_interval_ms": "src/channels/telegram.js 轮询间隔",
  "channels.telegram.allowed_chats": "src/channels/telegram.js 渠道级白名单",
  "channels.delivery.jitter_ratio": "src/channels/delivery.js 退避抖动",
  "channels.delivery.dead_letter": "src/channels/delivery.js 死信落盘开关",
  "channels.delivery.dead_letter_max": "src/channels/delivery.js 内存死信上限",
  "security.escalation_ttl_minutes": "src/permissions/index.js armEscalationRevert 提权自动回落",
  "budget.usd": "src/agent/usage.js 预算闸门美元上限",
  "budget.assume_price": "src/agent/usage.js 未知模型价格兜底",
};

// ---- 显式预留 (代码当前未读取, 保留以待未来实现 / 或纯标识) ----
// 改动这些需在注释注明原因 —— 它们是有意保留, 而非漏管的死键
const RESERVED = {
  "agent.yuan": "内部代号, 仅标识不参与逻辑",
  "memory.enabled": "预留: 记忆开关 (当前记忆常开)",
  "memory.token_budget": "预留: 记忆注入预算 (压缩注入口未实现)",
  "memory.compile_threshold": "预留: 场景聚类阈值 (compile 未实现)",
  "experience.enabled": "预留: 经验库开关 (经验库常开)",
  "selfheal.enabled": "兼容保留: 自愈由 selfheal 命令显式触发, 未接入配置",
  "selfheal.check_interval_ms": "预留: 自愈定时器间隔 (未接入配置定时器)",
};

test("config 一致性: 每个声明键必须消费或显式预留", () => {
  const leaves = leafPaths(DEFAULT_CONFIG);
  assert.ok(leaves.length > 0, "DEFAULT_CONFIG 应有叶子键");
  const unknown = leaves.filter((p) => !(p in CONSUMED) && !(p in RESERVED));
  assert.deepStrictEqual(
    unknown,
    [],
    `发现死配置键 (既未消费也未列为预留): ${unknown.join(", ")} — 请接入消费点或加入 RESERVED 注明`
  );
});

test("config 一致性: 注册表不残留已删/未声明的键", () => {
  const leaves = new Set(leafPaths(DEFAULT_CONFIG));
  const stale = Object.keys(CONSUMED).filter((p) => !leaves.has(p))
    .concat(Object.keys(RESERVED).filter((p) => !leaves.has(p)));
  assert.deepStrictEqual(stale, [], `注册表含 DEFAULT_CONFIG 不存在的键: ${stale.join(", ")}`);
});

test("config 一致性: memory 衰减/预算键确实在 FactStore 生效 (回归第九轮死键)", () => {
  // 直接在 FactStore 层验证 snake 键被消费: 传 snake 键应改变衰减/容量行为
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ppx-cfgconsis-"));
  try {
    const s = new FactStore(dir, { decay_per_day: 0.5, max_facts: 1 });
    assert.equal(s.opts.decayPerDay, 0.5, "decay_per_day(snake) 应映射到 decayPerDay");
    assert.equal(s.opts.maxFacts, 1, "max_facts(snake) 应映射到 maxFacts");
    s.add("a 1", { source: "test" });
    s.add("b 2", { source: "test" });
    assert.equal(s.count(), 1, "max_facts=1 时多条新增应触发 L1 裁剪");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("config 一致性: selfheal.max_restart_attempts 已移除 (死配置)", () => {
  // 保证死配置删除后不会再被声明 (v1.1.0 移除), 防止回退复活
  assert.equal("selfheal.max_restart_attempts" in leafPaths(DEFAULT_CONFIG).reduce((a, p) => (a[p] = 1, a), {}), false);
  assert.equal(!!((DEFAULT_CONFIG.selfheal || {}).max_restart_attempts), false, "DEFAULT_CONFIG.selfheal 不应再含 max_restart_attempts");
});
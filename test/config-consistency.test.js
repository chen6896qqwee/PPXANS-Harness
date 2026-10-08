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
import { fileURLToPath } from "node:url";
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
  "agent.max_tool_rounds": "src/core/policy.js ToolLoopPolicy 工具循环最大轮次",
  "agent.tool_result_budget": "src/core/policy.js trimToolResult 结果裁剪预算",
  "agent.max_tool_error_retry": "src/core/policy.js ToolLoopPolicy 工具错误重试次数",
  "agent.tool_timeout_ms": "src/tools/seam.js runWithPolicy 全局默认超时 (工具级 timeoutMs 优先) + src/agent/index.js _runTool 传参",
  "agent.model_preference": "src/llm/router.js orderProviders 本地/云端优先级(local 默认)",
  // user
  "user.name": "src/agent/index.js userName (persona 称呼)",
  // providers
  "providers": "src/plugin/builtin.js resolveAllLLMs + config/providers CRUD",
  // memory (decay/importance/forget 由 src/memory/fact-store.js snake 兼容读取)
  "memory.decay_per_day": "src/memory/fact-store.js FactStore 衰减率",
  "memory.backend": "src/plugin/builtin.js factsPlugin 存储后端选择 (json/sqlite/auto)",
  "memory.hit_bonus": "src/memory/fact-store.js 命中加分",
  "memory.base_importance": "src/memory/fact-store.js 基础重要性",
  "memory.forget_speed": "src/memory/fact-store.js 遗忘速度",
  "memory.max_facts": "src/memory/fact-store.js L1 总量上限裁剪",
  "memory.ttl_days": "src/agent/index.js sweepMemoryTtl -> FactStore.sweepExpired (每日 02:00 排泄治理)",
  "memory.max_history_items": "src/agent/index.js _trimHistory 条数上限",
  "memory.history_token_budget": "src/agent/index.js _trimHistory/_maybeCompact token 预算",
  "memory.context_window": "src/agent/index.js _histTokenCap 上下文窗口兜底 (溢出防护)",
  "memory.context_window_ratio": "src/agent/index.js _histTokenCap 历史占用窗口安全比例",
  "memory.session_max_age_days": "src/plugin/builtin.js pruneOld 会话保留天数",
  // tools
  "tools.enabled": "src/plugin/builtin.js toolsEnabled",
  "tools.custom_dir": "src/plugin/builtin.js 自定义工具目录",
  "tools.disabled": "src/agent/index.js _applyDisabledTools + settings 启停",
  "tools.progressive": "src/agent/index.js _applyToolExposure 渐进披露开关 (只把核心工具 schema 发给 LLM)",
  "tools.core": "src/agent/index.js _applyToolExposure 核心工具白名单 + src/agent/prompts.js _toolsPrompt 按需清单",
  // voice (ASR / TTS: 走 OpenAI 兼容端点, 零依赖)
  "voice.enabled": "src/tools/voice.js voiceStatus 语音能力总开关",
  "voice.asr.backend": "src/tools/voice.js resolveVoice/resolveLocalAsr 本地 whisper 分支开关 (=== local 才走本地)",
  "voice.asr.base_url": "src/tools/voice.js resolveVoice(asr) 转写端点",
  "voice.asr.api_key": "src/tools/voice.js resolveVoice(asr) 直接密钥 (与 api_key_env 二选一)",
  "voice.asr.api_key_env": "src/tools/voice.js resolveVoice(asr) 密钥环境变量",
  "voice.asr.model": "src/tools/voice.js resolveVoice(asr) 转写模型",
  "voice.asr.timeout_ms": "src/tools/voice.js resolveVoice(asr) 请求超时 (Number 兜底 120000)",
  "voice.tts.base_url": "src/tools/voice.js resolveVoice(tts) 合成端点",
  "voice.tts.api_key": "src/tools/voice.js resolveVoice(tts) 直接密钥 (与 api_key_env 二选一)",
  "voice.tts.api_key_env": "src/tools/voice.js resolveVoice(tts) 密钥环境变量",
  "voice.tts.model": "src/tools/voice.js resolveVoice(tts) 合成模型",
  "voice.tts.voice": "src/tools/voice.js resolveVoice(tts) 默认音色 (可被工具参数覆盖)",
  "voice.tts.format": "src/tools/voice.js resolveVoice(tts) 默认输出格式",
  "voice.tts.timeout_ms": "src/tools/voice.js resolveVoice(tts) 请求超时 (Number 兜底 120000)",
  // embedding (向量检索, 可选段; 整组传 src/llm/embedder.js createEmbedder)
  "embedding.backend": "src/llm/embedder.js createEmbedder (=== local 走 local-embedder.js, 其余走 OpenAI 兼容端点)",
  "embedding.base_url": "src/llm/embedder.js createEmbedder 端点 (空 = 不建 embedder, 纯 BM25)",
  "embedding.api_key": "src/llm/embedder.js createEmbedder 直接密钥 (与 api_key_env 二选一)",
  "embedding.api_key_env": "src/llm/embedder.js createEmbedder 密钥环境变量",
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
  // security (经 tools/builtin.js checkCommand 消费)
  "security.allow_all": "src/tools/builtin.js run_command/checkCommand (snake 兼容)",
  "security.command_timeout_ms": "src/seam/shell.js 命令执行超时",
  "security.code_act": "src/tools/builtin.js code_act 开关",
  "security.deny": "src/tools/builtin.js checkCommand 用户拒绝规则 (glob)",
  "security.allow_inline_exec": "src/tools/command-guard.js checkCommand 内联执行硬规则的显式放开开关",
  "security.allow_unauthenticated_webhooks": "src/channels/base.js _webhookSecretGate 无密钥 webhook 的 fail-closed 放行位",
  // ---- 2026-10-05 诚实回填: 以下键代码早就在读, 只是第一次进 DEFAULT_CONFIG ----
  // agent (审批链路)
  "agent.approval_mode": "src/plugin/v3.js permissionsPlugin 引擎创建 (|| on-request)",
  "agent.approval_timeout_ms": "src/agent/index.js _awaitApproval 等待人工裁决时限 (|| 120000)",
  "agent.approval_cache": "src/agent/index.js 会话内同命令批准缓存开关 (!== false)",
  "agent.approval_headless_wait": "src/agent/index.js:847 无审批入口时是否继续等待 (!== true, false=立即拒绝)",
  "agent.sandbox": "src/plugin/v3.js permissionsPlugin (|| workspace-write)",
  "agent.network_access": "src/plugin/v3.js permissionsPlugin (!== false)",
  "agent.permission_rules": "src/plugin/v3.js permissionsPlugin 用户自定义规则链 (Array 兜底 [])",
  "agent.capability_gate": "src/agent/index.js permissions.capabilityGate (!== false)",
  "agent.auto_approve_high_risk": "src/agent/index.js permissions.autoApproveHighRisk (!!)",
  "agent.guardAllowList": "src/agent/index.js installGuard 豁免名单 (|| [])",
  "agent.turn_projection": "src/agent/index.js 每轮生命周期投影开关 (!== false)",
  // agent (工具循环阈值, 经 policy.js: new ToolLoopPolicy(config.agent))
  "agent.explore_break_limit": "src/core/policy.js ToolLoopPolicy 探索连击熔断 (|| DEFAULT_EXPLORE_BREAK=3)",
  "agent.repeat_flag_limit": "src/core/policy.js ToolLoopPolicy 重复命令告警 (|| DEFAULT_REPEAT_FLAG=2)",
  "agent.parallel_tool_calls": "src/core/policy.js ToolLoopPolicy 同轮独立工具并发 (!== false)",
  // agent (缓存 TTL / 自进化)
  "agent.health_cache_ms": "src/agent/index.js provider 健康探测 TTL 缓存 (?? 30000, 0=关)",
  "agent.stats_cache_ms": "src/agent/index.js stats() 聚合 TTL 缓存 (?? 2000, 0=关)",
  "agent.evolve.enabled": "src/selfheal/evolve.js EvolutionEngine (!== false)",
  "agent.evolve.every_calls": "src/selfheal/evolve.js 每 N 次工具调用触发提炼 (|| 20)",
  "agent.evolve.min_interval_ms": "src/selfheal/evolve.js 两次提炼最小间隔 (|| 30000)",
  "agent.evolve.upgrade_uses": "src/selfheal/evolve.js 技能用满 N 次自动升级 (|| 3)",
  // agent (军团并发治理, 2026-10-07; 消费点 src/orchestrator/governor.js governorOptsFromConfig
  //   + src/orchestrator/legion.js + src/mode/legion.js + src/tools/delegate.js)
  "agent.legion.default_size": "src/mode/legion.js 军团默认规模 (旧 config.orchestrator.size 的继承者, || 2)",
  "agent.legion.max_concurrent_agents": "src/orchestrator/governor.js 进程级子 agent 并发硬上限 (legion_set_concurrency 可运行期调)",
  "agent.legion.max_concurrent_per_call": "src/orchestrator/governor.js 单次派发宽度上限 (Legion.maxConcurrent 缺省值来源)",
  "agent.legion.queue_timeout_ms": "src/orchestrator/governor.js acquire() 排队等槽位超时",
  "agent.legion.delegate_timeout_ms": "src/tools/delegate.js 单个子任务最长等待 (DELEGATE_TIMEOUT_MS 兜底)",
  "agent.legion.kill_on_finish": "src/tools/delegate.js 委派结束是否回收子进程 (!== false)",
  "agent.legion.cross_process_quota": "src/orchestrator/governor.js 跨进程配额账本开关 (=== true 时挂 quota-file.js, 子 agent 是真子进程)",
  // agent (能力边界与人类监督, 2026-10-07; 消费点 src/ans/boundary.js)
  "agent.boundary.enabled": "src/ans/boundary.js boundaryPrompt/riskDirective 总开关 (=== false 才关)",
  "agent.boundary.high_risk_domains": "src/ans/boundary.js detectHighRisk 白名单 (命中即要求人类监督)",
  "agent.boundary.require_human_review": "src/ans/boundary.js 关键决策交回人类的强制提示 (!== false)",
  "agent.boundary.weak_risk": "src/ans/boundary.js 弱信号护栏开关 (detectWeakRisk, === false 才关)",
  "agent.boundary.extra_limits": "src/ans/boundary.js 用户自定义追加边界条款 (逐条注入静态区)",
  // skills (内置技能层 v2, 2026-10-07; 消费点 src/skills/registry.js + src/agent/prompts.js)
  "skills.builtin": "src/skills/registry.js skillRootsFromConfig 内置技能根开关 (!== false)",
  "skills.user_dir": "src/skills/registry.js userSkillsDir 用户级技能根 (expanding ~; 空串=关闭)",
  "skills.project_dir": "src/skills/registry.js 项目级技能根 (空=关闭)",
  "skills.extra_dirs": "src/skills/registry.js 附加技能根 (团队盘/GitHub 技能包)",
  "skills.max_depth": "src/skills/registry.js createSkillLoader -> SkillLoader.maxDepth (2=支持领域二级目录)",
  "skills.prompt_hot_shown": "src/agent/prompts.js _skillsPrompt 附描述的常用技能条数 (名册全量列出)",
  "skills.prompt_desc_cap": "src/agent/prompts.js _skillsPrompt 单条 description 截断长度",
  // experts (专家库, 2026-10-07 吸收 TencentCloud/Octop; 消费点 src/orchestrator/expert-pack.js
  //   packRootsFromConfig + src/plugin/builtin.js expertPacks 装配)
  "experts.builtin": "src/orchestrator/expert-pack.js packRootsFromConfig 内置专家库开关 (!== false)",
  "experts.user_dir": "src/orchestrator/expert-pack.js userExpertsDir 用户级专家库根 (展开 ~; 空串=关闭)",
  "experts.project_dir": "src/orchestrator/expert-pack.js 项目级专家库根 (空=关闭)",
  "experts.extra_dirs": "src/orchestrator/expert-pack.js 附加专家库根 (团队共享盘)",
  // memory (WAL, 经 builtin.js: new FactStore(dataDir, { wal: true, walThreshold: 50, ...config.memory }))
  "memory.wal": "src/plugin/builtin.js factsPlugin -> FactStore 增量追加落盘开关",
  "memory.walThreshold": "src/plugin/builtin.js -> FactStore compact 阈值 (camel 键)",
  // channels 补充
  "channels.http.host": "src/channels/http.js HttpChannel 监听地址 (构造默认 127.0.0.1, manager 展开 cfg 传入)",
  "channels.http.mcp.enabled": "src/channels/http.js MCP 标准端点开关 (!== false)",
  "channels.http.mcp.path": "src/channels/http.js MCP 端点路径 (|| /mcp)",
  "channels.http.mcp.legacy_rest": "src/channels/http.js 是否保留 REST 兼容 (false=退役 /api/*)",
  "channels.feishu.webhookPath": "src/channels/feishu.js 事件订阅回调路径 (构造默认 /feishu/webhook)",
  // 新声明组
  "budget.usd": "src/agent/index.js 进程累计支出闸门 (Number 兜底, 0=不限)",
  "model_routing.aux": "src/agent/index.js 辅助任务 provider 选择 (空=跟随主模型)",
  "audit.enabled": "src/plugin/builtin.js 审计哈希链注册 (=== false 才关)",
  "protocol.wal_enabled": "src/plugin/v3.js protocolPlugin 协议总线 WAL (!== false)",
  "ocr.tesseract": "src/tools/document.js ocr_image 可执行文件名 (|| tesseract)",
  "ocr.lang": "src/tools/document.js ocr_image 默认语言 (args.lang 优先, 兜底 chi_sim)",
  "ocr.cloud": "src/tools/document.js ocr_image 云 OCR 配置 (|| null = 只用本地 tesseract)",
};

// ---- 显式预留 (代码当前未读取, 保留以待未来实现 / 或纯标识) ----
// 改动这些需在注释注明原因 —— 它们是有意保留, 而非漏管的死键
const RESERVED = {
  "agent.yuan": "内部代号, 仅标识不参与逻辑",
  // memory.enabled / token_budget / compile_threshold 已从 DEFAULT_CONFIG 移除 (代码始终未读取,
  //   记忆常开、token 预算走 history_token_budget、场景聚类 compile 未实现) —— 见 config/index.js 注释。
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

// =====================================================================================
// 反向守卫: "代码读了但没人声明" 的漂移 (正向检查的盲区, 2026-10-05 补)
// 正向守卫只遍历 DEFAULT_CONFIG 叶子, 所以 agent.approval_headless_wait /
// agent.stats_cache_ms 这类"读取处早就存在、DEFAULT_CONFIG 里查无此键"的配置能长期隐身。
// 本守卫静态扫描 src/ skills/ scripts/ 的 .js/.mjs, 正则抽取配置读取路径, 要求每条路径
// 要么落在 DEFAULT_CONFIG 树上 (叶子或中间节点 —— 整组读取如 agent.proactive 合法),
// 要么出现在 EXTERNAL_OK 里并写明"为什么不是声明配置" —— 与正向守卫同款纪律:
// 新增读取键, 要么去 DEFAULT_CONFIG 声明, 要么来这张表登记去向, 否则 FAIL。
//
// 匹配形式 (刻意收紧, 宁缺毋噪):
//   \b(?:config|cfg)\b 后紧跟 1~3 段 (\??\.[A-Za-z_]\w*), 且剥离注释/字符串后 ≥2 段才算数。
//   覆盖: this.config.agent?.X / config?.channels?.http?.mcp / cfg.memory.z / agent.config.user?.name。
// 匹配前会剥离: 双引号/单引号字符串、模板字符串、块注释、行注释
//   (报错文案如 "请配置 config.channels.wechat.agent_id" 不是代码读取)。
// 刻意不抓的形式 (已知盲区, 改这些消费者时请自觉同步声明):
//   1) 单段整组读取: config.embedding / agent.config.ocr / config.orchestrator —— 与任意对象
//      属性访问同形, 收紧为 ≥2 段就是为了避开海量局部 config 变量误报;
//   2) 段落别名/解构后的读取: const cfg = config.agent 之后的 cfg.size、const c = cfg || {}
//      之后的 c.explore_break_limit (policy.js)、agentCfg.approval_mode (v3.js)、
//      mcpCfg.enabled (http.js)、sec.backend (voice.js)、embedder/document 里形参名 config 的
//      config.model —— 变量别名在静态层无法可靠归根;
//   3) 动态键: this.config[name] (channels/index.js 按通道名取段);
//   4) 数组项字段: providers[].timeout_ms/retry_max/context_window、mcp.servers[].command ——
//      数组项没有 DEFAULT_CONFIG 路径, 其 schema 文档在 docs/CONFIG.md 对应表格;
//   5) 模板字符串整体被剥离, 若把真实读取写进 ${...} 插值表达式会连带漏掉 (极罕见写法, 别这么写)。
// =====================================================================================

const GUARD_SCAN_DIRS = ["src", "skills", "scripts"];

// 属性链上遇到这些名字即截断 —— 它们是数组方法/内建属性, 不是配置键 (如 cfg.providers.filter)
const GUARD_ARRAY_MEMBERS = new Set([
  "length", "filter", "map", "forEach", "find", "findIndex", "some", "every", "reduce",
  "slice", "splice", "push", "pop", "shift", "unshift", "join", "concat", "includes",
  "indexOf", "sort", "reverse", "flat", "flatMap", "at", "entries", "keys", "values",
]);

// 读取了、但有意不进 DEFAULT_CONFIG 的路径 -> 原因 (每条都要能被反向守卫"仍在读"回归, 防表腐烂)
const EXTERNAL_OK = {
  // 2026-10-07: "agent.legion" 曾在此豁免 (理由: 声明后会恒真并遮蔽 config.orchestrator 别名)。
  //   该笔债务已按当初写下的处置方案还清 —— src/mode/legion.js 现在显式合并两边
  //   ({ ...legacy, ...modern }), 遮蔽问题不再存在, agent.legion 已正式进 DEFAULT_CONFIG。
  "agent.workflow": "src/mode/graph.js:21 兜底是当前消息 [userMsg], 不是常量; 声明 [] 会因空数组为真值直接改变图构建行为。"
    + "需要常量默认语义才能声明 (已上报路由), 此前此条保留",
};

// ---- 剥离注释与字符串 (顺序: 先字符串后注释, 避免注释里的 ' 破坏配对; 纯静态, 无 spawn) ----
function stripCommentsAndStrings(code) {
  return code
    .replace(/"(?:[^"\\\n]|\\.)*"/g, '""')
    .replace(/'(?:[^'\\\n]|\\.)*'/g, "''")
    .replace(/`(?:[^\\`]|\\.)*`/gs, "``")
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/\/\/[^\n]*/g, "");
}

// ---- 抽取 config./cfg. 根上的 ≥2 段读取路径 ----
function extractReadPaths(code) {
  const out = new Set();
  const re = /\b(?:config|cfg)\b((?:\??\.[A-Za-z_]\w*){1,3})/g;
  let m;
  while ((m = re.exec(code))) {
    const segs = m[1].match(/\.[A-Za-z_]\w*/g).map((s) => s.slice(1));
    const parts = [];
    for (const s of segs) {
      if (GUARD_ARRAY_MEMBERS.has(s)) break; // 方法调用截断
      parts.push(s);
    }
    if (parts.length >= 2) out.add(parts.join("."));
  }
  return out;
}

// ---- DEFAULT_CONFIG 全部路径 (含中间节点): 整组读取 (agent.proactive) 视为已声明 ----
function allConfigPaths(obj, prefix = "", out = new Set()) {
  for (const [k, v] of Object.entries(obj)) {
    const p = prefix ? `${prefix}.${k}` : k;
    out.add(p);
    if (v && typeof v === "object" && !Array.isArray(v)) allConfigPaths(v, p, out);
  }
  return out;
}

function collectScanFiles(dir) {
  const res = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const fp = path.join(dir, e.name);
    if (e.isDirectory()) res.push(...collectScanFiles(fp));
    else if (/\.(js|mjs)$/.test(e.name)) res.push(fp);
  }
  return res;
}

const GUARD_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const GUARD_SCAN_FILES = GUARD_SCAN_DIRS.flatMap((d) => collectScanFiles(path.join(GUARD_ROOT, d)));
// 同一棵配置树上抽取一次, 三条断言共用 (确定性, 纯正则, 零 spawn 零网络)
const GUARD_READS = (() => {
  const hit = new Map(); // path -> first file (报错定位用)
  for (const f of GUARD_SCAN_FILES) {
    for (const p of extractReadPaths(stripCommentsAndStrings(fs.readFileSync(f, "utf8")))) {
      if (!hit.has(p)) hit.set(p, path.relative(GUARD_ROOT, f));
    }
  }
  return hit;
})();

test("反向守卫: 代码读取的配置路径必须已声明或在 EXTERNAL_OK 登记 (防读取-未声明漂移)", () => {
  const declared = allConfigPaths(DEFAULT_CONFIG);
  const offenders = [];
  for (const [p, where] of GUARD_READS) {
    if (declared.has(p) || p in EXTERNAL_OK) continue;
    offenders.push(`${p} (首个命中 ${where})`);
  }
  assert.deepStrictEqual(
    offenders,
    [],
    `发现读取但未声明的配置键: ${offenders.join(", ")} — 去 DEFAULT_CONFIG 声明 (默认值=现行硬兜底) 或入 EXTERNAL_OK 写明原因`
  );
});

test("反向守卫: EXTERNAL_OK 不残留已声明/已不再读取的路径 (防豁免表腐烂)", () => {
  const declared = allConfigPaths(DEFAULT_CONFIG);
  const stale = [];
  for (const p of Object.keys(EXTERNAL_OK)) {
    if (declared.has(p)) stale.push(`${p} (已在 DEFAULT_CONFIG 声明, 应从 EXTERNAL_OK 删除)`);
    else if (!GUARD_READS.has(p)) stale.push(`${p} (代码已不再读取, 应删除该豁免)`);
  }
  assert.deepStrictEqual(stale, [], `EXTERNAL_OK 存在陈旧条目: ${stale.join(", ")}`);
});

test("反向守卫: 抽取器自检: 合成漂移键必被抓住, 注释/字符串/数组方法不误报", () => {
  const sample = [
    "const a = this.config.brand_new?.tunable_x;",
    "const b = cfg.someSection?.field_y?.z;",
    "// config.dead?.comment_key 只是注释",
    "/* config blk?.dead_key */",
    "const msg = \"请配置 config.fake?.string_key\";",
    "const t = `模板 ${x} config.tpl?.backtick_key`;",
    "const arr = cfg.providers.filter((p) => p.ok);",
  ].join("\n");
  const found = extractReadPaths(stripCommentsAndStrings(sample));
  assert.ok(found.has("brand_new.tunable_x"), "≥2 段真实读取必须被抓到");
  assert.ok(found.has("someSection.field_y.z"), "三段链式读取应被抓全");
  assert.ok(!found.has("providers.filter"), "数组方法应被截断, 不算配置键 (截断后只剩 1 段, 整组读取不进候选)");
  for (const ghost of ["dead.comment_key", "blk.dead_key", "fake.string_key", "tpl.backtick_key"]) {
    assert.ok(!found.has(ghost), `注释/字符串里的 ${ghost} 不应被当成读取`);
  }
});

test("反向守卫: 已知历史漂移键已收编为声明配置 (回归 2026-10-05 三例)", () => {
  for (const p of [
    "agent.approval_headless_wait", "agent.stats_cache_ms", "agent.health_cache_ms",
    "agent.approval_timeout_ms", "model_routing.aux", "budget.usd", "audit.enabled",
    "protocol.wal_enabled", "memory.wal", "channels.http.host", "channels.feishu.webhookPath",
  ]) {
    assert.ok(allConfigPaths(DEFAULT_CONFIG).has(p), `${p} 应已在 DEFAULT_CONFIG 声明`);
  }
  // provider 数组项字段维持文档化 schema (docs/CONFIG.md providers 表), 不进 DEFAULT_CONFIG:
  assert.ok(!("provider" in DEFAULT_CONFIG), "provider.* 是数组项字段, 不应伪造成全局组");
});

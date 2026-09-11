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
  "agent.max_tool_rounds": "src/agent/index.js 工具循环最大轮次",
  "agent.tool_result_budget": "src/agent/index.js trimToolResult 结果裁剪预算",
  "agent.max_tool_error_retry": "src/agent/index.js 工具错误重试次数",
  "agent.model_preference": "src/llm/router.js orderProviders 本地/云端优先级(local 默认)",
  // user
  "user.name": "src/agent/index.js userName (persona 称呼)",
  // providers
  "providers": "src/plugin/builtin.js resolveAllLLMs + config/providers CRUD",
  // memory (decay/importance/forget 由 src/memory/fact-store.js snake 兼容读取)
  "memory.decay_per_day": "src/memory/fact-store.js FactStore 衰减率",
  "memory.hit_bonus": "src/memory/fact-store.js 命中加分",
  "memory.base_importance": "src/memory/fact-store.js 基础重要性",
  "memory.forget_speed": "src/memory/fact-store.js 遗忘速度",
  "memory.max_facts": "src/memory/fact-store.js L1 总量上限裁剪",
  "memory.max_history_items": "src/agent/index.js _trimHistory 条数上限",
  "memory.history_token_budget": "src/agent/index.js _trimHistory/_maybeCompact token 预算",
  "memory.context_window": "src/agent/index.js _histTokenCap 上下文窗口兜底 (溢出防护)",
  "memory.context_window_ratio": "src/agent/index.js _histTokenCap 历史占用窗口安全比例",
  "memory.session_max_age_days": "src/plugin/builtin.js pruneOld 会话保留天数",
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
  // security (经 tools/builtin.js checkCommand 消费)
  "security.allow_all": "src/tools/builtin.js run_command/checkCommand (snake 兼容)",
  "security.command_timeout_ms": "src/seam/shell.js 命令执行超时",
  "security.code_act": "src/tools/builtin.js code_act 开关",
  "security.deny": "src/tools/builtin.js checkCommand 用户拒绝规则 (glob)",
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
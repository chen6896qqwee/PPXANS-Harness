// src/config/ans-lane.js - ANS 车道配置归一化 (docs/dsh-absorb/04-ans-lane.schema.json 的唯一运行时实现)
// Step 5a: "读配置 + 归一化"; Step 5b: src/channels/ans-lane.js 与 server.js 消费本模块结果。
//   enabled=false (默认) 时运行路径完全不进入车道, 行为与之前逐字一致。
// 契约要点:
//   - 默认关闭; enabled=true 必须显式给出非空 targets (不做隐式全通道广播)。
//   - internal_only / origin 恒为 true / "ans", 不接受用户改写 (防止外部伪造来源)。
//   - mode=notify → create_ticket=false; mode=submit → create_ticket=true, 由本模块强制, 不信用户值。
//   - 所有数值字段夹到 schema 区间; 非法值告警后回落默认, 绝不抛错拖垮启动。
//   - 任一硬条件不满足 → enabled=false 并给出 disabledReason, 宁可不开也不半开。
// 分层约束: config 是 L1, ans 是 L2, 所以归一化必须住在这里 (src/ans 不能反向被 config 依赖)。
export const ANS_LANE_VERSION = "ans_lane.v1";
const ANS_LANE_SOURCES = Object.freeze(["proactive", "watchdog"]);
const ANS_LANE_MODES = Object.freeze(["notify", "submit"]);
const ANS_LANE_DEDUPE_STRATEGIES = Object.freeze(["period_bucket", "explicit", "none"]);
const ANS_LANE_DELIVERY_ROUTES = Object.freeze(["async", "sync"]);

const MAX = Number.MAX_SAFE_INTEGER;
// 数值字段 spec: [键, 默认, 下限, 上限]; 集中成表, 避免每个字段复制一段校验
const DELIVERY_NUMBERS = [
  ["max_attempts", 4, 1, 10],
  ["backoff_ms", 2000, 0, MAX],
  ["backoff_cap_ms", 60000, 0, MAX],
  ["ttl_ms", 3600000, 0, MAX],
  ["deadline_ms", 15000, 1, MAX],
];
const DEDUPE_NUMBERS = [
  ["bucket_ms", 3600000, 1000, MAX],
  ["window_ms", 30000, 0, MAX],
];
const RATE_LIMIT_NUMBERS = [
  ["min_interval_ms", 60000, 0, MAX],
  ["max_per_hour", 12, 1, MAX],
];

function defaultLane() {
  return {
    version: ANS_LANE_VERSION,
    enabled: false,
    internal_only: true,
    origin: "ans",
    sources: [...ANS_LANE_SOURCES],
    mode: "notify",
    create_ticket: false,
    targets: [],
    delivery: { route: "async", max_attempts: 4, backoff_ms: 2000, backoff_cap_ms: 60000, jitter_ratio: 0.1, ttl_ms: 3600000, deadline_ms: 15000 },
    dedupe: { strategy: "period_bucket", bucket_ms: 3600000, key_prefix: "ans", window_ms: 30000 },
    rate_limit: { min_interval_ms: 60000, max_per_hour: 12 },
    security: { inherit: true, extra_deny_tools: [] },
  };
}

function deepFreeze(obj) {
  for (const v of Object.values(obj)) {
    if (v && typeof v === "object") deepFreeze(v);
  }
  return Object.freeze(obj);
}

// DEFAULT_CONFIG.ans_lane 直接引用这份冻结默认值, 避免默认值两处漂移
export const ANS_LANE_DEFAULTS = deepFreeze(defaultLane());

const isPlainObject = (v) => !!v && typeof v === "object" && !Array.isArray(v);

function warnUnknownKeys(obj, known, prefix, warn) {
  for (const k of Object.keys(obj)) {
    if (!known.includes(k)) warn(`${prefix}.${k} 不是 ans_lane.v1 字段 — 已忽略`);
  }
}

// 整数夹取: 非整数告警回落默认; 越界告警后夹到边界
function intIn(value, def, min, max, name, warn) {
  if (value === undefined) return def;
  if (typeof value !== "number" || !Number.isInteger(value)) {
    warn(`${name}=${JSON.stringify(value)} 必须是整数 — 已用默认 ${def}`);
    return def;
  }
  if (value < min || value > max) {
    const clamped = Math.min(max, Math.max(min, value));
    warn(`${name}=${value} 超出区间 [${min}, ${max}] — 已夹到 ${clamped}`);
    return clamped;
  }
  return value;
}

function ratioIn(value, def, name, warn) {
  if (value === undefined) return def;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    warn(`${name}=${JSON.stringify(value)} 必须是数字 — 已用默认 ${def}`);
    return def;
  }
  if (value < 0 || value > 1) {
    const clamped = Math.min(1, Math.max(0, value));
    warn(`${name}=${value} 超出区间 [0, 1] — 已夹到 ${clamped}`);
    return clamped;
  }
  return value;
}

function enumIn(value, allowed, def, name, warn) {
  if (value === undefined) return def;
  if (!allowed.includes(value)) {
    warn(`${name}=${JSON.stringify(value)} 不是合法值 (${allowed.join("|")}) — 已用默认 ${def}`);
    return def;
  }
  return value;
}

function normalizeNumbers(src, defaults, specs, prefix, warn) {
  const out = { ...defaults };
  for (const [key, def, min, max] of specs) out[key] = intIn(src[key], def, min, max, `${prefix}.${key}`, warn);
  return out;
}

function optionalString(value, name, warn) {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") {
    warn(`${name}=${JSON.stringify(value)} 必须是字符串或 null — 已置 null`);
    return null;
  }
  return value.trim() || null;
}

function normalizeTarget(raw, i, warn) {
  if (!isPlainObject(raw)) {
    warn(`ans_lane.targets[${i}] 不是对象 — 已丢弃`);
    return null;
  }
  warnUnknownKeys(raw, ["channel", "to", "thread", "replyTo"], `ans_lane.targets[${i}]`, warn);
  const channel = typeof raw.channel === "string" ? raw.channel.trim() : "";
  const to = typeof raw.to === "string" ? raw.to.trim() : "";
  if (!channel || !to) {
    warn(`ans_lane.targets[${i}] 缺 channel/to (非空字符串) — 已丢弃`);
    return null;
  }
  return {
    channel,
    to,
    thread: optionalString(raw.thread, `ans_lane.targets[${i}].thread`, warn),
    replyTo: optionalString(raw.replyTo, `ans_lane.targets[${i}].replyTo`, warn),
  };
}

function normalizeObjectSection(raw, known, prefix, warn) {
  if (raw === undefined) return null;
  if (!isPlainObject(raw)) {
    warn(`${prefix} 必须是对象 — 已忽略`);
    return null;
  }
  warnUnknownKeys(raw, known, prefix, warn);
  return raw;
}

function normalizeSources(raw, warn) {
  if (raw === undefined) return [...ANS_LANE_SOURCES];
  if (!Array.isArray(raw)) {
    warn("ans_lane.sources 必须是数组 — 已置空 (enabled=true 时车道将禁用)");
    return [];
  }
  const kept = [];
  for (const s of raw) {
    const v = typeof s === "string" ? s.trim() : "";
    if (!ANS_LANE_SOURCES.includes(v)) {
      warn(`ans_lane.sources 含未知来源 ${JSON.stringify(s)} — 已忽略`);
      continue;
    }
    if (!kept.includes(v)) kept.push(v);
  }
  return kept;
}

// 把任意 raw.ans_lane 归一化为 canonical v1 配置。
// 返回 { config, warnings, disabledReason }; disabledReason 仅在"请求开启但被拒"时非空。
export function resolveAnsLaneConfig(raw) {
  const warnings = [];
  const warn = (m) => warnings.push(m);
  const lane = defaultLane();
  let disabledReason = null;

  if (raw === undefined || raw === null) return { config: lane, warnings, disabledReason };
  if (!isPlainObject(raw)) {
    warn(`ans_lane 必须是对象, 实际 ${Array.isArray(raw) ? "array" : typeof raw} — 已按默认关闭处理`);
    return { config: lane, warnings, disabledReason: "invalid_type" };
  }

  const requested = raw.enabled === true;
  if (raw.enabled !== undefined && typeof raw.enabled !== "boolean") {
    warn(`ans_lane.enabled=${JSON.stringify(raw.enabled)} 必须是布尔值 — 已按 false 处理`);
  }
  warnUnknownKeys(raw, ["version", "enabled", "internal_only", "origin", "sources", "mode", "create_ticket", "targets", "delivery", "dedupe", "rate_limit", "security"], "ans_lane", warn);

  if (raw.version !== undefined && raw.version !== ANS_LANE_VERSION) {
    warn(`ans_lane.version=${JSON.stringify(raw.version)} 不受支持 (仅 ${ANS_LANE_VERSION})${requested ? " — 车道已禁用" : ""}`);
    if (requested) disabledReason = "unsupported_version";
  }

  // 安全不变量: 不允许用户关闭
  if (raw.internal_only !== undefined && raw.internal_only !== true) {
    warn("ans_lane.internal_only 恒为 true (v1 不支持进程外来源) — 已强制 true");
  }
  if (raw.origin !== undefined && raw.origin !== "ans") {
    warn(`ans_lane.origin 恒为 "ans" — 已忽略 ${JSON.stringify(raw.origin)}`);
  }

  lane.sources = normalizeSources(raw.sources, warn);

  lane.mode = enumIn(raw.mode, ANS_LANE_MODES, "notify", "ans_lane.mode", warn);
  // mode 决定 create_ticket, 用户值不参与 (schema allOf 的硬约束)
  if (lane.mode === "submit") {
    if (raw.create_ticket !== true) warn("ans_lane.mode=submit 要求 create_ticket=true — 已强制开启");
    lane.create_ticket = true;
  } else if (raw.create_ticket === true) {
    warn("ans_lane.mode=notify 不允许 create_ticket=true — 已强制 false");
  }

  if (raw.targets !== undefined) {
    if (!Array.isArray(raw.targets)) {
      warn("ans_lane.targets 必须是数组 — 已置空 (enabled=true 时车道将禁用)");
    } else {
      lane.targets = raw.targets.map((t, i) => normalizeTarget(t, i, warn)).filter(Boolean);
    }
  }

  const delivery = normalizeObjectSection(raw.delivery, ["route", "max_attempts", "backoff_ms", "backoff_cap_ms", "jitter_ratio", "ttl_ms", "deadline_ms"], "ans_lane.delivery", warn);
  if (delivery) {
    lane.delivery = normalizeNumbers(delivery, lane.delivery, DELIVERY_NUMBERS, "ans_lane.delivery", warn);
    lane.delivery.route = enumIn(delivery.route, ANS_LANE_DELIVERY_ROUTES, "async", "ans_lane.delivery.route", warn);
    lane.delivery.jitter_ratio = ratioIn(delivery.jitter_ratio, 0.1, "ans_lane.delivery.jitter_ratio", warn);
  }

  const dedupe = normalizeObjectSection(raw.dedupe, ["strategy", "bucket_ms", "key_prefix", "window_ms"], "ans_lane.dedupe", warn);
  if (dedupe) {
    lane.dedupe = normalizeNumbers(dedupe, lane.dedupe, DEDUPE_NUMBERS, "ans_lane.dedupe", warn);
    lane.dedupe.strategy = enumIn(dedupe.strategy, ANS_LANE_DEDUPE_STRATEGIES, "period_bucket", "ans_lane.dedupe.strategy", warn);
    if (dedupe.key_prefix !== undefined) {
      if (typeof dedupe.key_prefix !== "string" || !dedupe.key_prefix.trim()) {
        warn("ans_lane.dedupe.key_prefix 必须是非空字符串 — 已用默认 ans");
      } else {
        lane.dedupe.key_prefix = dedupe.key_prefix.trim();
      }
    }
  }

  const rateLimit = normalizeObjectSection(raw.rate_limit, ["min_interval_ms", "max_per_hour"], "ans_lane.rate_limit", warn);
  if (rateLimit) {
    lane.rate_limit = normalizeNumbers(rateLimit, lane.rate_limit, RATE_LIMIT_NUMBERS, "ans_lane.rate_limit", warn);
  }

  const security = normalizeObjectSection(raw.security, ["inherit", "extra_deny_tools"], "ans_lane.security", warn);
  if (security) {
    if (security.inherit !== undefined && security.inherit !== true) {
      warn("ans_lane.security.inherit 恒为 true (ANS 与入站共用权限判定) — 已强制 true");
    }
    const deny = [];
    if (security.extra_deny_tools !== undefined) {
      if (!Array.isArray(security.extra_deny_tools)) {
        warn("ans_lane.security.extra_deny_tools 必须是字符串数组 — 已忽略");
      } else {
        for (const t of security.extra_deny_tools) {
          if (typeof t !== "string" || !t.trim()) {
            warn(`ans_lane.security.extra_deny_tools 含非法项 ${JSON.stringify(t)} — 已忽略`);
            continue;
          }
          const v = t.trim();
          if (!deny.includes(v)) deny.push(v);
        }
      }
    }
    lane.security = { inherit: true, extra_deny_tools: deny };
  }

  if (requested && disabledReason === null) {
    if (lane.sources.length === 0) {
      disabledReason = "no_sources";
      warn("ans_lane.enabled=true 但 sources 为空 — 车道已禁用");
    } else if (lane.targets.length === 0) {
      disabledReason = "no_targets";
      warn("ans_lane.enabled=true 但 targets 为空 — 车道已禁用 (不做隐式全通道广播)");
    }
  }
  lane.enabled = requested && disabledReason === null;

  return { config: lane, warnings, disabledReason };
}

// Step 5b 的路由判据: 只有车道开启且来源在白名单内才走新链路, 否则继续旧 broadcast
export function ansLaneAllowsSource(lane, source) {
  if (!lane || lane.enabled !== true) return false;
  return Array.isArray(lane.sources) && lane.sources.includes(String(source));
}

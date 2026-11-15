// webapp/src/stores/errors.js - 错误分级与"下一步做什么"
//
// 问题: 以前错误统一走 toast + 一张红框卡片, 直接把底层原文倒给用户 ——
//   `TypeError: Failed to fetch` / `401 Unauthorized` / `ECONNREFUSED 127.0.0.1:8899`
//   用户看不懂, 也不知道该不该做点什么。
// 现在把错误分三级, 每级给一句人话的下一步:
//   self-heal  自己会好（网络抖动、服务重启中）—— 什么都不用做
//   action     需要你动手（Key/额度/模型名/路径）—— 给一条明确路径
//   report     需要上报（其余没见过的问题）—— 告诉用户去哪儿反馈
// 纯函数, 可单测; 不改动错误原文, 原文永远保留在卡片里。

export const TIER = { selfHeal: "self-heal", action: "action", report: "report" };

const RULES = [
  {
    tier: TIER.action,
    re: /(401|403|unauthorized|invalid[_ ]?api[_ ]?key|api key|鉴权|认证失败)/i,
    hint: "模型的 Key 不对或没生效 —— 打开「设置 → 模型」重新粘贴一次 Key，那里有「测试」可以当场验证。",
  },
  {
    tier: TIER.action,
    re: /(429|rate limit|quota|insufficient|余额|额度|欠费|超出限额)/i,
    hint: "被限流或余额不足 —— 稍等几分钟；仍然失败就去模型厂商控制台看额度。",
  },
  {
    tier: TIER.action,
    re: /(404|model.{0,12}not.{0,6}found|no such model|模型不存在)/i,
    hint: "模型名或接口地址可能不对 —— 打开「设置 → 模型」核对模型 ID（例如 deepseek-chat 不能写成 deepseek）。",
  },
  {
    tier: TIER.action,
    re: /(ENOENT|EACCES|permission denied|command not found|不是内部或外部命令)/i,
    hint: "命令或路径不可用 —— 看上面给出的具体路径；确认它在这个项目目录里存在。",
  },
  {
    tier: TIER.action,
    re: /(context.{0,12}(length|window)|too long|上下文.{0,6}(超|长))/i,
    hint: "这轮内容太长，超出模型的上下文窗口 —— 开一个新对话，或让它先总结再继续。",
  },
  {
    tier: TIER.selfHeal,
    re: /(ECONNREFUSED|ECONNRESET|ETIMEDOUT|EPIPE|socket hang up|Failed to fetch|network ?error|networkerror|fetch failed)/i,
    hint: "本地服务或网络抖了一下 —— 通常下一条就恢复；连续失败的话重启一下皮皮虾。",
  },
  {
    tier: TIER.selfHeal,
    re: /(timeout|timed out|超时|aborted|已中断|AbortError)/i,
    hint: "这一轮等待超时或被中断 —— 内容已经保留，可以直接重发。",
  },
];

/**
 * 给一条错误原文定性。
 * @returns {{tier:string, hint:string}}
 */
export function explain(raw) {
  const text = String(raw == null ? "" : raw);
  for (const r of RULES) {
    if (r.re.test(text)) return { tier: r.tier, hint: r.hint };
  }
  return {
    tier: TIER.report,
    hint: "这个问题不在已知范围里 —— 如果反复出现，把上面这段原文发给开发者（它已经写进日志）。",
  };
}

/** 三级对应的一行短标签 (卡片顶部/徽标用) */
export function tierLabel(tier) {
  if (tier === TIER.selfHeal) return "会自动恢复";
  if (tier === TIER.action) return "需要你处理";
  if (tier === TIER.report) return "需要上报";
  return "";
}

/** 用户是否必须做点什么 (toast 是否要标红/拦截后续操作时用) */
export function needsUserAction(tier) {
  return tier === TIER.action || tier === TIER.report;
}

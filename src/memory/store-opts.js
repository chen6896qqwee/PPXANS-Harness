// src/memory/store-opts.js - 记忆存储构造参数的单源 (JSON 后端 fact-store 与 SQLite 后端共用)
//
// 2026-11-03 重复消除: 此前 snake→camel 归一化表 + 七个默认值在两个后端构造器里各写一份,
// 靠注释互指"与对方同口径"保活 —— 那正是会漂移的写法 (改一处漏一处的温床)。
// 现在两个后端都调 normalizeStoreOpts, 口径只有这一份。
//
// v1.0.9: 兼容 snake 配置键 (config.memory 是 snake_case, 原只认 camel 导致衰减/容量配置全部死键不生效)
export const SNAKE_TO_CAMEL = {
  decay_per_day: "decayPerDay", hit_bonus: "hitBonus", base_importance: "baseImportance",
  forget_speed: "forgetSpeed", max_facts: "maxFacts",
};

const STORE_DEFAULTS = {
  decayPerDay: 0.02,   // lambda
  hitBonus: 5,
  baseImportance: 10,
  forgetSpeed: 1.0,
  maxFacts: 1000,      // L1 事实总量上限, 超限按「衰减分×重要性」裁剪最弱 (0/负数=不裁剪)
  // F4 (2026-10-04) 墓碑治理默认值:
  //   purgeGraceDays: 墓碑保留期 (天)。超过即被每日时效扫描物理回收; 0 = 关闭年龄回收
  //     (仍受 maxTombstones 行数上限兜底)。保留期内的最近删除可 restore/审计。
  //   maxTombstones: 墓碑行数上限 (0/缺省 = 按 maxFacts × TOMBSTONE_FACTOR 推导)。
  //   软删/归档行不占 maxFacts 名额, 但同样要落盘 —— 无上限时"遗忘越勤, 文件越大"。
  purgeGraceDays: 30,
  maxTombstones: 0,
};

export function normalizeStoreOpts(opts, snakeToCamel = SNAKE_TO_CAMEL, defaults = STORE_DEFAULTS) {
  const norm = {};
  for (const [k, v] of Object.entries(opts || {})) norm[snakeToCamel[k] || k] = v;
  return { ...defaults, ...norm };
}

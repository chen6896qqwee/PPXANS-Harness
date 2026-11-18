// src/memory/fact-store-normalize.js - FactStore 的数据模型与存储卫生 (mixin, 从 fact-store.js 拆出)
// 职责: 层级/衰减常量、内容归一化与查重键 (_norm/_normKey)、导入条目补全 (_normalizeFact)、
//   倒排/去重索引 (_indexFact/rebuildIndex)、容量治理 (_prune/_tombstoneCap/_purgeTombstones)。
// 全部是挂回 FactStore.prototype 的方法, 对外接口不变。
// 依赖约束: 只允许 import utils/* 与 provenance, 不得 import fact-store.js —— 否则与宿主成环。
import crypto from "node:crypto";
import { nowISO } from "../utils/store.js";
import { scrubPII } from "../utils/pii.js";
import { tierOfRecord, isQuarantined, stripTierTags, matchesTierSelector } from "./provenance.js";

// 记忆动词前缀: 去重时剔除, 让"记住：X"与"X"视为同一条 (防 LLM 提炼版与原文冗余)
const MEMORY_VERB_PREFIXES = [
  /^(请记住|请记得|记得要|记住要|要记住|请牢记|别忘了|记住|记得|用户说|用户提到|提醒你)[:：\s，,、]*/,
];

// 记忆层级 (承接自 ppx-v2 的 L4 程序性记忆): L1=事实/用户记忆, L4=程序性记忆(技能/流程/方法论)
// L4 衰减远慢于 L1 —— 技能与流程应当长期留存, 而非像闲聊事实一样快速遗忘
export const L4_DECAY_PER_DAY = 0.005;
export const LAYER_L1 = 1;
export const LAYER_L4 = 4;

// 检索/写入共用的 id 生成 (v2.6.1: 改用 Node 内置 crypto.randomUUID(), 加密安全随机源)。
// 由本模块导出, 宿主 add() 与 governance update() 直接 import (不挂 prototype)。
export function cryptoRandomId() {
  return "f_" + crypto.randomUUID();
}

export const factStoreNormalizeMethods = {
  // 高斯衰减: score = score * exp(-lambda * t^2), t = days since last access
  // layer 感知 (承接自 ppx-v2 五层记忆): L4 程序性记忆衰减极慢 (lambda 0.005), 技能/流程应当长期留存
  _decay(score, days, layer = 1) {
    if (days <= 0) return score;
    const base = Number(layer) === 4 ? L4_DECAY_PER_DAY : this.opts.decayPerDay;
    const lambda = base * this.opts.forgetSpeed;
    return score * Math.exp(-lambda * days * days);
  },

  // 该条记忆的实际衰减率 (按 layer)
  _lambdaOf(f) {
    const base = Number(f?.layer) === 4 ? L4_DECAY_PER_DAY : this.opts.decayPerDay;
    return base * this.opts.forgetSpeed;
  },

  // 有效记忆集: 排除软删 (status='deleted') 与版本链归档 (status='archived')
  // 软删是 ppx-v2 记忆治理的核心语义: 遗忘可回滚, 不是不可逆的物理删除
  _live(scope = null) {
    const base = scope == null ? this.facts : this.facts.filter((f) => f.scope === scope);
    return base.filter((f) => f.status !== "deleted" && f.status !== "archived");
  },

  // 内容归一化: 去首尾空白 + 折叠连续空白, 用于去重比对
  _norm(s) {
    return String(s || "").trim().replace(/\s+/g, " ");
  },

  // 查重键: 在 _norm 基础上去掉"记忆动词前缀"和尾部标点, 让
  // 原文「记住：老板的生日是 10 月 1 日」与 LLM 提炼的「老板的生日是 10 月 1 日」判定为同一条, 防冗余
  // 只去记忆类动词, 不碰普通句子, 避免误合并
  _normKey(s) {
    let k = this._norm(s);
    for (const re of MEMORY_VERB_PREFIXES) k = k.replace(re, "");
    return k.replace(/[。！？!?；;，,]+$/, "");
  },

  // 事实有效期窗口 (v3.1, 设计溯源 docs/PROVENANCE.md#zep-graphiti 思想):
  // 动机: 只有衰减没有时效的事实会在"用户改主意"后继续命中 —— 检索器分不清
  // 「曾经为真」与「现在为真」。每条事实可带 validFrom/validTo (ISO 或可解析时间),
  // 缺省 = 永久有效 (完全向后兼容旧数据)。
  _normTime(v) {
    if (v == null || v === "") return null;
    const t = v instanceof Date ? v.getTime() : new Date(v).getTime();
    return Number.isFinite(t) ? new Date(t).toISOString() : null;
  },

  _isCurrent(f, nowMs = Date.now()) {
    if (f.validFrom) {
      const t = new Date(f.validFrom).getTime();
      if (Number.isFinite(t) && nowMs < t) return false; // 尚未生效
    }
    if (f.validTo) {
      const t = new Date(f.validTo).getTime();
      if (Number.isFinite(t) && nowMs >= t) return false; // 已失效
    }
    return true;
  },

  // 导入条目 → 完整事实对象 (importAll merge/replace 两分支共用, 2026-09-18 重构去重);
  // content 归一化后为空返回 null。补全对象字段 —— 缺失 lastAccess/importance 会让
  // 衰减/recency 计算出 NaN, 检索永远返回空 (v2.7.0 修复语义保持)。
  _normalizeFact(it) {
    // 导入路径同样脱密 (与 add 对称): 外部 JSON / 其他 backend 导出可能夹带凭证
    // 也同样剥伪装来源标签 (与 add 对称): 导入是攻击者可控面最大的写入路径 (governance memory_import)
    const norm = this._norm(stripTierTags(scrubPII(String(it?.content ?? ""), { keep: ["email", "phone"] }).cleaned));
    if (!norm) return null;
    const now = nowISO();
    return {
      id: it.id || cryptoRandomId(),
      content: norm,
      type: it.type || "general",
      source: it.source || "import",
      // 来源分级: 迁移/导入带来的 provenance 逐字保留 (两端后端互切不得洗白或降级);
      //   没有该字段的旧条目按 source 登记表算, 登记表外 (含 source 缺失 = "import") → unknown 隔离。
      provenance: tierOfRecord({ provenance: it.provenance, source: it.source || "import" }),
      importance: it.importance ?? this.opts.baseImportance,
      score: it.score ?? (it.importance ?? this.opts.baseImportance),
      created: it.created || now,
      lastAccess: it.lastAccess || now,
      hits: it.hits || 0,
      scope: it.scope ?? null,
      layer: Number(it.layer) === LAYER_L4 ? LAYER_L4 : LAYER_L1,
      // v2026-10-04 (sqlite parity): archived 一并保留 (原只认 deleted, 后端切换迁移会把
      // 版本链旧版错误复活为 active); deletedAt/deleteReason 随行携带, 保证软删可审计可回滚
      status: it.status === "deleted" || it.status === "archived" ? it.status : "active",
      ...(it.deletedAt ? { deletedAt: it.deletedAt } : {}),
      ...(it.deleteReason ? { deleteReason: it.deleteReason } : {}),
      // 2026-11-12: 归档时钟与版本链指针随行保留 —— 迁移/后端切换后 _purgeTombstones 才有真实
      // 归档时间可排序 (原实现丢失后回退 lastAccess/created, 老墓碑会被当成"最近归档"逃过回收)
      ...(it.archivedAt ? { archivedAt: it.archivedAt } : {}),
      ...(it.supersededBy ? { supersededBy: it.supersededBy } : {}),
      prevId: it.prevId ?? null,
      ...(it.ttlDays ? { ttlDays: Number(it.ttlDays) } : {}),
      ...(this._normTime(it.validFrom) ? { validFrom: this._normTime(it.validFrom) } : {}),
      ...(this._normTime(it.validTo) ? { validTo: this._normTime(it.validTo) } : {}),
      ...(it.meta ? { meta: it.meta } : {}),
    };
  },

  // 软删公共实现 (forget / sweepExpired / clearLayer 共用): 标记 status='deleted' + 时间/原因
  _softDelete(f, reason) {
    f.status = "deleted";
    f.deletedAt = nowISO();
    f.deleteReason = reason ? String(reason).slice(0, 200) : null;
  },

  // 倒排索引: 把一条事实的字符 key 挂到索引 (key -> factId)
  _indexFact(fact) {
    for (const k of this._charKeys(fact.content)) {
      if (!this._index.has(k)) this._index.set(k, new Set());
      this._index.get(k).add(fact.id);
    }
    // 去重键索引 (2026-10-30, L2): 与倒排索引同生命周期 (只在 _live 集合上建),
    //   供 add() 的 O(1) 去重查找; 软删/归档不在其中 = 与"去重跳过墓碑"的语义一致。
    if (!this._byKey) this._byKey = new Map();
    const dk = this._dedupeKey(fact);
    const bucket = this._byKey.get(dk);
    if (bucket) bucket.push(fact);
    else this._byKey.set(dk, [fact]);
  },

  // 去重键: scope + 归一化内容键 (与 add() 里原线性查找的判定条件逐项对齐)
  _dedupeKey(fact) {
    return (fact.scope ?? "\u0000") + "\u0001" + this._normKey(fact.content);
  },

  // O(1) 去重查找: 归一化键命中后仍按 status 过滤 (与原 facts.find 完全同语义)
  _findLiveByKey(scope, normKey) {
    const bucket = this._byKey && this._byKey.get((scope ?? "\u0000") + "\u0001" + normKey);
    if (!bucket) return null;
    for (const f of bucket) {
      if (f.status !== "deleted" && f.status !== "archived") return f;
    }
    return null;
  },

  // 重建索引 (facts 外部变更后调用)
  // F4 (2026-10-04): 墓碑 (status=deleted/archived) 不进倒排索引 —— 索引规模只由活跃集决定,
  //   否则"遗忘越勤, 索引越大", 检索还得从墓碑里筛。软删后索引里一个 key 都不该留下。
  rebuildIndex() {
    this._index = new Map();
    this._byKey = new Map(); // 去重键索引同步重建 (与倒排索引同生命周期)
    this._statsCache.clear();
    for (const fact of this._live()) this._indexFact(fact);
    return this._index.size;
  },

  // L1 总量裁剪: 超 maxFacts 时, 按「衰减后有效分 × 重要性」排序, 删除最弱事实。
  // 补齐「衰减只在查询层生效、不删数据」的缺口 -> 这里做存储层硬清理。
  // 只在 add 新增时触发; 去重命中/加分(hit) 不增条数, 无需裁剪。
  // 只统计/裁剪活跃事实 (2026-10-04 修复, 与 sqlite 后端 status='active' 同口径):
  //   原先把软删/归档条目一起评分, 它们与活跃事实争夺 maxFacts 名额 —— 遗忘链条越长
  //   (sweepExpired 软删 + update 归档), 越会把真正在用的记忆当成"最弱"硬删掉。
  _prune() {
    const max = this.opts.maxFacts;
    let dropped = 0;
    // 活跃行容量裁剪 (maxFacts=0/负数 时跳过; 墓碑上限独立于它, 见下)
    if (max && max > 0) {
      const live = this._live();
      if (live.length > max) {
        const nowD = this._nowDays();
        const scored = live.map((f) => {
          const days = Math.max(0, nowD - new Date(f.lastAccess).getTime() / 86400000);
          const recency = Math.exp(-this._lambdaOf(f) * days * days); // 0~1 (L4 程序性记忆衰减更慢, 更抗裁剪)
          const imp = Math.min(f.importance || 0, 20) / 20; // 0~1
          // 来源分级 (v2026-10-XX): 隔离带记录先出局 —— 一次抓回上千条噪声不该把用户事实挤掉。
          //   同一大类内部仍按原「衰减分×重要性」降序, 所以现有单来源测试的淘汰次序逐字不变。
          const quarantineFirst = isQuarantined(tierOfRecord(f)) ? 0 : 1;
          return { id: f.id, key: (f.score * (0.4 + 0.6 * recency)) * (0.5 + 0.5 * imp), promotable: quarantineFirst };
        });
        scored.sort((a, b) => (b.promotable - a.promotable) || (b.key - a.key));
        const keep = new Set(scored.slice(0, max).map((x) => x.id));
        const liveIds = new Set(live.map((f) => f.id));
        const removedIds = [...liveIds].filter((id) => !keep.has(id));
        this.facts = this.facts.filter((f) => !liveIds.has(f.id) || keep.has(f.id));
        this.rebuildIndex(); // 重建倒排索引 (内部已清 _statsCache)
        for (const id of removedIds) this._embedCache.delete(id); // 事实已不在, 缓存向量作废
        if (removedIds.length) this._markRemoved(removedIds);
        dropped += removedIds.length;
      }
    }
    // 墓碑行数上限 (F4): 与 maxFacts 解耦 —— 显式 maxTombstones 优先, 否则按 maxFacts × K 推导。
    //   只保留"最近的删除" (按删除/归档时钟升序淘汰最老), 与 sqlite 后端 _prune 同口径。
    const cap = this._tombstoneCap();
    if (cap > 0) {
      const purged = this._purgeTombstones({ cap });
      if (purged.length) dropped += purged.length;
    }
    return dropped;
  },

  // 墓碑行数上限: 显式 maxTombstones 优先 (0/缺省则按 maxFacts × TOMBSTONE_FACTOR 推导)。
  //   返回 0 = 不设上限 (旧形状, 供测试对照与 opt-out)。
  // 注意用 this.constructor 而非 FactStore: mixin 文件不得 import 宿主 (成环)。
  _tombstoneCap() {
    const explicit = Number(this.opts.maxTombstones);
    if (Number.isFinite(explicit) && explicit > 0) return explicit;
    // 显式传 0 = 关闭墓碑上限 (与 maxFacts=0 的 opt-out 语义一致, 测试对照用)
    const max = Number(this.opts.maxFacts);
    if (!max || max <= 0) return 0;
    return max * this.constructor.TOMBSTONE_FACTOR;
  },

  // 墓碑物理回收 (F4, 与 sqlite-store.js _purgeTombstones 同口径):
  //   cap > 0          = 只留最近的 cap 条墓碑 (容量口径, 淘汰最老的)
  //   olderThanMs > 0  = 只删"早于该时间戳"的墓碑 (年龄口径, 供 sweepExpired 挂年龄回收)
  //   limit > 0        = 只删最老的 limit 条
  //   tier             = 来源分级选择器 (缺省 null = 不分档); 传 "quarantined" 时只碰隔离带
  // 删除/归档时钟: deletedAt 优先, 归档行退到 archivedAt, 再退到 lastAccess/created。
  // 返回被回收的 id 列表。调用方需已持锁 (或由 add 的锁内路径调用)。
  _purgeTombstones({ cap = 0, olderThanMs = 0, limit = 0, tier = null } = {}) {
    const clockOf = (f) => {
      const t = f.deletedAt || f.archivedAt || f.lastAccess || f.created;
      const ms = t ? new Date(t).getTime() : 0;
      return Number.isFinite(ms) ? ms : 0;
    };
    let doomed = this.facts
      .filter((f) => f.status === "deleted" || f.status === "archived")
      .filter((f) => matchesTierSelector(tierOfRecord(f), tier));
    if (olderThanMs > 0) doomed = doomed.filter((f) => clockOf(f) <= olderThanMs);
    // 2026-11-16: 容量上界是硬约束, 宽限期不得把它架空。
    //   2026-11-06 曾让 purgeGraceDays 把保留期内的墓碑整体排除出容量淘汰 (保护 restore),
    //   但没有给"保护期内的总量"设上限 —— 600 次遗忘风暴后 live=0 而盘上 600 行,
    //   每次 add 的锁内重载重新变回 O(累计删除数), F4 的不变量被悄悄推翻。
    //   现在的口径: 容量淘汰仍**优先保留最近的墓碑** (排序后淘汰最老), 宽限期语义只作用在
    //   年龄回收路径 (sweepExpired → olderThanMs); 想延长 restore 窗口就调大 maxTombstones,
    //   而不是让文件无限长。
    if (!doomed.length) return [];
    // 容量口径未超限 = 无一条要回收, 不必排序。add() 每次都会走到这里,
    //   而墓碑总量通常远低于 maxFacts×K —— 原实现无条件 O(T log T) 是纯浪费。
    if (cap > 0 && doomed.length <= cap) return [];
    if (doomed.length > 1) {
      // 时钟现算一次, 避免比较器里反复 new Date (排序是 O(T log T) 次比较)
      doomed = doomed.map((f) => ({ f, t: clockOf(f) })).sort((a, b) => a.t - b.t).map((x) => x.f);
    }
    if (cap > 0) doomed = doomed.slice(0, Math.max(0, doomed.length - cap));
    else if (limit > 0) doomed = doomed.slice(0, limit);
    if (!doomed.length) return [];
    const ids = new Set(doomed.map((f) => f.id));
    this.facts = this.facts.filter((f) => !ids.has(f.id));
    for (const id of ids) this._embedCache.delete(id);
    this.rebuildIndex();
    this._markRemoved([...ids]);
    return [...ids];
  },
};

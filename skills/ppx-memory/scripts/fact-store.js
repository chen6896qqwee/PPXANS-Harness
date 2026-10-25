// src/memory/fact-store.js - 记忆存储 (高斯衰减遗忘)
// 架构参考 openhanako: 每条记忆有 importance, 高斯衰减, 命中加分
import path from "node:path";
import crypto from "node:crypto";
import { ensureDir, readJson, readJsonGuarded, writeJson, nowISO, withFileLock } from "./store.js";
import { migrateData, writeSchema } from "./schema.js";
import { setJaccard, setOverlap } from "./similarity.js";
import { scrubPII } from "./pii.js";
import { walFileOf, appendWal, readWal, truncateWal, walSizeBytes } from "./wal.js";
// v2026-10-04 (同步 src 2026-10-04 治理批次): 独立版刻意不依赖主项目 ——
//   src/memory/backend-migrate.js (sqlite→json 一次性导入, 需 node:sqlite) 与 utils/logger.js
//   都不在扁平化范围内, 故此处不导入 importSqliteIntoJson, warn 降级为 console.warn。
const warn = (...a) => console.warn(...a);
// v2026-10-XX (同步 src 来源分级批次, 2026-10-05): 写入 tier 的判定规则集中在 provenance.js
//   (零依赖、与 src/memory/provenance.js 逐字同源), 满足"技能副本整体可拷出"约束
//   —— 见 test/skill-memory-drift.test.js 的副本漂移守卫。
import {
  resolveWriteTier, tierOfRecord, rankOf, canSupersede, normalizeTier, isQuarantined, stripTierTags,
  matchesTierSelector,
} from "./provenance.js";

// 记忆动词前缀: 去重时剔除, 让"记住：X"与"X"视为同一条 (防 LLM 提炼版与原文冗余)
const MEMORY_VERB_PREFIXES = [
  /^(请记住|请记得|记得要|记住要|要记住|请牢记|别忘了|记住|记得|用户说|用户提到|提醒你)[:：\s，,、]*/,
];

// 记忆层级 (吸收自 ppx-v2 的 L4 程序性记忆): L1=事实/用户记忆, L4=程序性记忆(技能/流程/方法论)
// L4 衰减远慢于 L1 —— 技能与流程应当长期留存, 而非像闲聊事实一样快速遗忘
export const L4_DECAY_PER_DAY = 0.005;
export const LAYER_L1 = 1;
export const LAYER_L4 = 4;
// facts.json 当前 schema 版本 (纯数组基线 = 1); 未来数据结构变更时 +1 并注册迁移 (见 src/utils/schema.js)
export const FACTS_SCHEMA_VERSION = 1;

export class FactStore {
  // facts.json.wal 的字节水位 (F7, 2026-10-05, 与 src/memory/fact-store.js 同值同语义):
  // 条数阈值数的是"条", 一条 {op:"replace"} 事件却能把整库序列化进同一行 —— "没到阈值"
  // 不等于"有上限"。水位默认 2MiB: 正常 add 路径峰值 18KB 永远碰不到它, 批量整库替换被钉死。
  // 0/负数 = 关闭字节水位 (退回纯条数阈值的旧行为)。
  static WAL_MAX_BYTES = 2 * 1024 * 1024;

  // 墓碑行数与容量上限的倍数 (F4, 2026-10-04; 与 sqlite-store.js 同值同口径):
  // 软删/归档行不占 maxFacts 名额, 但同样要落盘 —— 无上限时"遗忘越勤, 文件越大,
  // 每次操作越贵"(实测 600 次 add+forget 后 live=0 而盘上 600 行)。总行数上界 =
  // maxFacts × (TOMBSTONE_FACTOR + 1): 活跃行 + 墓碑行各自有界。
  static TOMBSTONE_FACTOR = 4;

  constructor(dataDir, opts = {}) {
    this.dir = path.join(dataDir, "memory");
    ensureDir(this.dir);
    this.file = path.join(this.dir, "facts.json");
    // v1.0.9: 兼容 snake 配置键 (config.memory 是 snake_case, 原只认 camel 导致衰减/容量配置全部死键不生效)
    const SNAKE_TO_CAMEL = {
      decay_per_day: "decayPerDay", hit_bonus: "hitBonus", base_importance: "baseImportance",
      forget_speed: "forgetSpeed", max_facts: "maxFacts",
    };
    const normOpts = {};
    for (const [k, v] of Object.entries(opts || {})) normOpts[SNAKE_TO_CAMEL[k] || k] = v;
    this.opts = {
      decayPerDay: 0.02,   // lambda
      hitBonus: 5,
      baseImportance: 10,
      forgetSpeed: 1.0,
      maxFacts: 1000,      // L1 事实总量上限, 超限按「衰减分×重要性」裁剪最弱 (0/负数=不裁剪)
      // F4 (2026-10-04) 墓碑治理默认值 (与 sqlite-store 同口径):
      //   purgeGraceDays: 墓碑保留期 (天)。超过即被每日时效扫描物理回收; 0 = 关闭年龄回收
      //     (仍受 maxTombstones 行数上限兜底)。保留期内的最近删除可 restore/审计。
      //   maxTombstones: 墓碑行数上限 (0/缺省 = 按 maxFacts × TOMBSTONE_FACTOR 推导)。
      purgeGraceDays: 30,
      maxTombstones: 0,
      ...normOpts,
    };
    // WAL 增量落盘: 默认关闭 (= 旧行为每次变更全量原子写); 开启后变更走追加日志 (facts.json.wal),
    // 达阈值 (walThreshold) 才 compact 全量写, 高频写场景显著减少磁盘写放大。
    // 数据文件本身保持纯数组格式, 读取方无感; 崩溃时启动重放 WAL 恢复。
    this.wal = !!this.opts.wal;
    this.walThreshold = Math.max(1, Number(this.opts.walThreshold) || 50);
    // 字节水位 (F7): 未配置 = 类常量默认; 显式 0/负数 = 关闭 (退回旧的纯条数阈值行为)
    this.walMaxBytes = this.opts.walMaxBytes == null
      ? FactStore.WAL_MAX_BYTES
      : Math.max(0, Number(this.opts.walMaxBytes) || 0);
    this.walFile = walFileOf(this.file);
    this._walPending = 0;
    // v3.0.1 (P0#1): 读入时区分「文件不存在」与「文件损坏」。
    // 损坏时文件原地保留 (healer 启动体检会改名 .corrupt-<ts> 备份后重建),
    // 此处必须跳过立即覆盖写回空数组, 否则损坏现场被清 → 数据不可恢复。
    const guarded = readJsonGuarded(this.file, []);
    this.facts = guarded.data;
    if (guarded.parseFailed) {
      if (this.wal) {
        // WAL 模式: 快照损坏但追加日志可能完好, 重放后可恢复大部分状态
        warn(`[memory/fact-store] facts.json 损坏 (文件保留), 尝试从 WAL 重放恢复 (${this.walFile})`);
      } else {
        warn(`[memory/fact-store] facts.json 损坏 (文件保留), 本次启动跳过立即落盘以保护现场; 等待 healer 恢复或人工处理`);
      }
    }
    // schema 版本迁移 (旁挂 .schema 文件; 数据文件保持纯数组, healer/外部读取者无感)
    const mig = migrateData({
      file: this.file,
      name: "facts",
      data: this.facts,
      currentVersion: FACTS_SCHEMA_VERSION,
    });
    this.facts = mig.data;
    // 倒排索引: token -> Set<factId>, 检索 O(n) -> O(候选)
    this._index = new Map();
    // BM25 作用域统计缓存 (facts 内容不可变, add 时失效即可), 避免每查询 O(N) 重算
    this._statsCache = new Map();
    // 可插拔 embedder (dense 语义检索, 默认 null = 纯 BM25); _embedCache 内存缓存不落盘
    this.embedder = null;
    this._embedCache = new Map();
    this._embedCacheMax = 1000; // LRU 上限: 超过淘汰最旧插入项, 防长跑会话内存无界增长
    for (const fact of this.facts) this._indexFact(fact);
    if (this.wal) this._replayWal(); // 重放 WAL 增量 (崩溃恢复: 快照 + 追加日志 = 完整状态)
    // v3.0.1 (P0#1): 非 WAL 模式下若快照损坏, 跳过构造期立即落盘 (保护现场, 防空数组覆盖);
    // 后续任何显式 add/update 仍会正常落盘, 届时内存状态即事实源
    if (!(guarded.parseFailed && !this.wal)) this.save();
    // 独立版差异: 不做 sqlite→json 后端迁移 (src/memory/backend-migrate.js 需 node:sqlite,
    // 且属于主项目后端选择, 与扁平化技能无关)
  }

  // 全量落盘。非 WAL 模式: 直接原子写 (兼容旧行为, 调用方通常在锁内)。
  // WAL 模式: 加锁 flush (全量写 + 清 WAL), 与追加互斥防丢事件。
  save() {
    if (!this.wal) {
      writeJson(this.file, this.facts);
      writeSchema(this.file, "facts", FACTS_SCHEMA_VERSION);
      return;
    }
    this.flush();
  }

  // 公开 flush: 加锁全量落盘 + 清 WAL (外部显式落盘点)
  flush() {
    withFileLock(this.file, () => this._flushLocked());
  }

  // 锁内重读最新状态。WAL 模式下磁盘快照滞后, 必须重放 WAL 增量才是完整状态
  // (非 WAL 模式: 每次变更已落盘, 磁盘即最新, 保持旧行为)
  _reload() {
    this.facts = readJson(this.file, []);
    if (this.wal) this.facts = this._applyWalTo(this.facts);
    // 来源分级: 磁盘/他进程写来的行可能没 provenance 字段 (旧版本写入或外部手改),
    //   每次重读就地补齐 —— 让 add/forget/update/_prune 的判定永远读到一个已归一化的闭集值,
    //   而不是在若干处各写一遍回退逻辑。纯内存补齐, 不额外写盘 (落盘由调用方的变更顺带完成)。
    this._stampProvenance();
    this.rebuildIndex();
    return this.facts;
  }

  // 给缺 provenance 字段的行按 source 登记表补上 tier (幂等, 全同步)
  _stampProvenance() {
    let n = 0;
    for (const f of this.facts) {
      const t = tierOfRecord(f);
      if (f.provenance !== t) { f.provenance = t; n++; }
    }
    return n;
  }

  /**
   * 存量库的来源分级回灌 (迁移入口, 与 src/memory/fact-store.js 同名 API 同口径)。
   * 取舍 (为什么按 source 登记表回灌而不是统一 unknown):
   *   ① 统一 unknown = 把"用户说过的话"也隔离掉 —— 画像/关键事实当场清空, 升级即失忆 (行为倒退,
   *      且不可由用户恢复: 用户不会重述历史上说过的每一句)。登记表能确定地复原绝大多数行的来源,
   *      因为 source 本来就是各调用点显式声明的字符串。
   *   ② 代价是诚实性边界: 登记表之外的 source (自定义/手改/未来的新值) 一律 unknown → 隔离。
   *   ③ 不猜内容: 判定只看 source/provenance 字段, 绝不做文本启发式 (见 provenance.js 约束①)。
   * 注意: 副本版不含 sqlite 后端迁移, 语义与 src 版一致。
   * @param {{dryRun?: boolean}} [opts]
   * @returns {{total:number, stamped:number, byTier:Object, quarantined:number, dryRun:boolean}}
   */
  backfillProvenance({ dryRun = false } = {}) {
    const tally = (arr) => {
      const byTier = {};
      let q = 0;
      for (const f of arr) {
        const t = tierOfRecord(f);
        byTier[t] = (byTier[t] || 0) + 1;
        if (isQuarantined(t)) q++;
      }
      return { byTier, q };
    };
    if (dryRun) {
      const { byTier, q } = tally(this.facts);
      return { total: this.facts.length, stamped: 0, byTier, quarantined: q, dryRun: true };
    }
    if (!this.facts.length) {
      return { total: 0, stamped: 0, byTier: {}, quarantined: 0, dryRun: false };
    }
    return withFileLock(this.file, () => {
      this._reload();
      const { byTier, q } = tally(this.facts);
      const stamped = this._stampProvenance();
      if (stamped) this.save();
      return { total: this.facts.length, stamped, byTier, quarantined: q, dryRun: false };
    });
  }

  // 把 WAL 增量事件按序应用到磁盘快照 (幂等: upsert 按 id 覆盖, remove 删 id, replace 整体替换)
  _applyWalTo(diskFacts) {
    const events = readWal(this.walFile);
    if (!events.length) return diskFacts;
    const byId = new Map(diskFacts.map((f) => [f.id, f]));
    for (const evt of events) {
      if (evt.op === "upsert" && evt.fact && evt.fact.id) byId.set(evt.fact.id, evt.fact);
      else if (evt.op === "replace" && Array.isArray(evt.facts)) { byId.clear(); for (const f of evt.facts) byId.set(f.id, f); }
      else if (evt.op === "remove" && Array.isArray(evt.ids)) for (const id of evt.ids) byId.delete(id);
    }
    return [...byId.values()];
  }

  // 锁内全量落盘 (调用方必须已持有文件锁)。
  // 非 WAL 模式: 内存即真相, 直接原子写 (每次变更已落盘, 无滞后快照可合并)。
  // WAL 模式: 合并磁盘快照+WAL+内存 (内存优先) 后原子写 + 清 WAL, 防丢其他进程的增量事件。
  _flushLocked() {
    if (!this.wal) {
      writeJson(this.file, this.facts);
      writeSchema(this.file, "facts", FACTS_SCHEMA_VERSION);
      return;
    }
    const disk = readJson(this.file, []);
    const merged = this._applyWalTo(disk);
    const byId = new Map(merged.map((f) => [f.id, f]));
    for (const f of this.facts) byId.set(f.id, f); // 内存优先: 本进程全部变更
    this.facts = [...byId.values()];
    this.rebuildIndex(); // facts 可能被合并变更, 同步重建索引
    writeJson(this.file, this.facts);
    truncateWal(this.walFile);
    this._walPending = 0;
    writeSchema(this.file, "facts", FACTS_SCHEMA_VERSION);
  }

  // 单条事件变更记录 (调用方必须已持有文件锁):
  //   非 WAL: 立即全量落盘 (旧行为); WAL: 追加事件, 达阈值自动 compact
  // 四个变体 (_change/_markMutated/_markRemoved/_markReplace) 共享此追加逻辑 (2026-09-18 重构收敛)
  _walAppend(evt, count = 1) {
    appendWal(this.walFile, evt);
    this._walPending += count;
    if (this._walPending >= this.walThreshold) { this._flushLocked(); return; }
    // 字节水位 (F7): 见 src/memory/fact-store.js 同名方法注释 —— 条数阈值封顶不了"一条巨型事件",
    // 达到水位就地 compact 走既有"快照∪WAL∪内存 → 全量原子写 → 清 WAL"路径, 不删未 compact 事件,
    // 重放结果与裁剪前等价; 全程在调用方已持有的文件锁内, 天然串行。
    if (this.walMaxBytes > 0 && walSizeBytes(this.walFile) >= this.walMaxBytes) this._flushLocked();
  }

  _change(evt) {
    if (!this.wal) { this._flushLocked(); return; }
    this._walAppend(evt);
  }

  // upsert 变体 (携带完整对象快照, 重放幂等)
  _markMutated(...facts) {
    if (!this.wal) { this._flushLocked(); return; }
    for (const f of facts) this._walAppend({ op: "upsert", fact: f }, 1);
  }

  // remove 变体 (批量删除 id)
  _markRemoved(ids) {
    if (!this.wal) { this._flushLocked(); return; }
    this._walAppend({ op: "remove", ids });
  }

  // replace 变体 (整体替换, 供 importAll replace)
  _markReplace(facts) {
    if (!this.wal) { this._flushLocked(); return; }
    this._walAppend({ op: "replace", facts });
  }

  // 启动重放: WAL 增量按序应用到内存 (幂等); 磁盘落盘由构造末尾 save() 统一完成
  _replayWal() {
    this.facts = this._applyWalTo(this.facts);
    this.rebuildIndex();
    this._walPending = 0;
  }

  // 高斯衰减: score = score * exp(-lambda * t^2), t = days since last access
  // layer 感知 (吸收自 ppx-v2 五层记忆): L4 程序性记忆衰减极慢 (lambda 0.005), 技能/流程应当长期留存
  _decay(score, days, layer = 1) {
    if (days <= 0) return score;
    const base = Number(layer) === 4 ? L4_DECAY_PER_DAY : this.opts.decayPerDay;
    const lambda = base * this.opts.forgetSpeed;
    return score * Math.exp(-lambda * days * days);
  }

  // 该条记忆的实际衰减率 (按 layer)
  _lambdaOf(f) {
    const base = Number(f?.layer) === 4 ? L4_DECAY_PER_DAY : this.opts.decayPerDay;
    return base * this.opts.forgetSpeed;
  }

  // 有效记忆集: 排除软删 (status='deleted') 与版本链归档 (status='archived')
  // 软删是 ppx-v2 记忆治理的核心语义: 遗忘可回滚, 不是不可逆的物理删除
  _live(scope = null) {
    const base = scope == null ? this.facts : this.facts.filter((f) => f.scope === scope);
    return base.filter((f) => f.status !== "deleted" && f.status !== "archived");
  }

  _nowDays() {
    return Date.now() / 86400000;
  }

  // ---- 事实有效期窗口 (v3.1, 吸收 Zep/Graphiti 思想) ----
  // 动机: 只有衰减没有时效的事实会在"用户改主意"后继续命中 —— 检索器分不清
  // 「曾经为真」与「现在为真」。每条事实可带 validFrom/validTo (ISO 或可解析时间),
  // 缺省 = 永久有效 (完全向后兼容旧数据)。
  _normTime(v) {
    if (v == null || v === "") return null;
    const t = v instanceof Date ? v.getTime() : new Date(v).getTime();
    return Number.isFinite(t) ? new Date(t).toISOString() : null;
  }

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
  }

  // 更新事实有效期 (治理 API): 典型用法 = 新事实入库时把被取代的旧事实 validTo 收口到当前
  setValidity(id, { validFrom = undefined, validTo = undefined } = {}) {
    return withFileLock(this.file, () => {
      this._reload();
      const f = this.facts.find((x) => x.id === id);
      if (!f) return null;
      if (validFrom !== undefined) f.validFrom = this._normTime(validFrom);
      if (validTo !== undefined) f.validTo = this._normTime(validTo);
      // 时效只影响检索可见性, 不改 status (治理面仍可见, 软删/归档另有语义)
      this._markMutated(f);
      return { id: f.id, validFrom: f.validFrom ?? null, validTo: f.validTo ?? null };
    });
  }

  // 列出时效窗口已过 (或未到) 的事实 (治理/体检用, 检索默认不可见)
  listOutOfWindow(scope = null) {
    return this._live(scope).filter((f) => !this._isCurrent(f));
  }

  // 内容归一化: 去首尾空白 + 折叠连续空白, 用于去重比对
  _norm(s) {
    return String(s || "").trim().replace(/\s+/g, " ");
  }

  // 查重键: 在 _norm 基础上去掉"记忆动词前缀"和尾部标点, 让
  // 原文「记住：老板的生日是 10 月 1 日」与 LLM 提炼的「老板的生日是 10 月 1 日」判定为同一条, 防冗余
  // 只去记忆类动词, 不碰普通句子, 避免误合并
  _normKey(s) {
    let k = this._norm(s);
    for (const re of MEMORY_VERB_PREFIXES) k = k.replace(re, "");
    return k.replace(/[。！？!?；;，,]+$/, "");
  }

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
      prevId: it.prevId ?? null,
      ...(it.ttlDays ? { ttlDays: Number(it.ttlDays) } : {}),
      ...(this._normTime(it.validFrom) ? { validFrom: this._normTime(it.validFrom) } : {}),
      ...(this._normTime(it.validTo) ? { validTo: this._normTime(it.validTo) } : {}),
      ...(it.meta ? { meta: it.meta } : {}),
    };
  }

  // 软删公共实现 (forget / sweepExpired / clearLayer 共用): 标记 status='deleted' + 时间/原因
  _softDelete(f, reason) {
    f.status = "deleted";
    f.deletedAt = nowISO();
    f.deleteReason = reason ? String(reason).slice(0, 200) : null;
  }

  // 去重命中时的跨 tier 规则 (add 的内容去重与语义相似去重共用; 调用方必须已持锁, 全同步):
  //   rank(写入) <  rank(存量) → 隔离带写入撞上一条可晋级记录: 只回"已存在", 不改 hits/score。
  //     否则反复抓取同一页就能抬高某条用户事实的检索分 —— 排序被外部内容影响是另一种注入,
  //     而且给了攻击者"这条确实写进去了"的可观测反馈。
  //   rank(写入) >= rank(存量) → 照旧加分; 严格更高时把记录**晋级** (用户后来亲口说过同一件事,
  //     来源就升回来了)。晋级只能向上 (canSupersede 已挡向下), 任何写入都不会把记录降级成 unknown。
  _onDedupeHit(existing, tier, now) {
    if (!canSupersede(tier, tierOfRecord(existing))) return existing;
    existing.hits += 1;
    existing.lastAccess = now;
    existing.score += this.opts.hitBonus;
    if (rankOf(tier) > rankOf(tierOfRecord(existing))) existing.provenance = tier;
    this._markMutated(existing);
    return existing;
  }

  add(content, { importance = this.opts.baseImportance, type = "general", source = "manual", dedupe = true, scope = null, meta = null, similarThreshold = 0, layer = LAYER_L1, ttlDays = null, validFrom = null, validTo = null, supersedeId = null, provenance = null } = {}) {
    // P0 (2026-10-04) 单点脱密: add 是唯一持久化入口。记忆长期驻留、逐轮注入 system prompt、
    //   还会发给云端 provider —— 凭证/密钥一旦进来就等于外泄。
    //   保留 email/phone: 用户主动要求记住的联系方式是记忆的正常用途, 不是泄漏; 其余 PII 一律脱。
    // 来源分级 (v2026-10-XX): 未声明 provenance 且 source 不在登记表 → unknown (隔离),
    //   绝不因"没写"而继承 user-stated —— 与 src/tools/catalog.js 当年 {readOnly:true} 兜底同类的
    //   "未声明=给最大权限"反模式在此废止 (默认拒绝)。
    const tier = resolveWriteTier({ provenance, source });
    // 伪装标签剥离必须在**写入侧**: 抓来的页面里若写着「(来源: 用户原话)」, 任何下游渲染路径
    //   (本层的"关键事实", 以及 memory_search / "我记得:") 都无法分辨它 ——
    //   在入库前剥掉, 所有渲染者一起安全 (标签文本只来自 provenance.js 的闭集常量)。
    const safe = stripTierTags(scrubPII(String(content ?? ""), { keep: ["email", "phone"] }).cleaned);
    const norm = this._norm(safe);
    if (!norm) return null;
    // 跨进程/多 agent 共享 dataDir 时的写保护: 锁内读-改-写, 防并发覆盖丢更新 (与 Experience 对称)
    // add 是唯一写入口, 锁内重读磁盘最新 facts (防基于过期内存操作), 操作后落盘
    return withFileLock(this.file, () => {
      // 锁内重读: 拿最新状态再操作 (WAL 模式 = 磁盘快照 + 重放 WAL, 防内存回退丢未 flush 变更)
      this._reload();
      const now = nowISO();
      if (dedupe) {
        // 内容去重: 归一化后相同 (含"记住："等前缀差异) 已存在则命中加分, 不新增
        // 排除软删与归档记忆 (2026-09-18 修复: 原只排除 deleted, archived 旧版本也能命中,
        //   命中加分落在不可见副本上, 活跃记忆不新增)
        // scope 参与判定 (2026-10-04 修复, 与 sqlite 后端同口径): 原先忽略 scope,
        //   给 scope="sA" 加已有全局内容时会命中那条全局事实并"加分" —— 但检索走
        //   _live(scope) 精确匹配作用域, 那条全局事实对 sA 根本不可见。结果既没建起
        //   sA 的记忆, 又莫名抬高了另一作用域的分数。同语义检索去重 (findSimilar) 的口径。
        const normKey = this._normKey(safe);
        const existing = this.facts.find((f) =>
          f.status !== "deleted" && f.status !== "archived"
          && (f.scope ?? null) === (scope ?? null)
          && this._normKey(f.content) === normKey);
        if (existing) return this._onDedupeHit(existing, tier, now);
        // 语义相似去重: similarThreshold>0 时, 与现有事实相似度达标则命中加分
        // 双保险: 先 Jaccard (模板类变体), 未命中再 overlap (词序变化大的松散变体)
        if (similarThreshold > 0) {
          const similar = this.findSimilar(norm, { threshold: similarThreshold, scope })
            || this.findSimilar(norm, { threshold: similarThreshold, scope, method: "overlap" });
          if (similar) return this._onDedupeHit(similar, tier, now);
        }
      }
      const fact = {
        id: cryptoRandomId(),
        content: norm,
        type,
        source,
        // 来源分级 (闭集枚举, 落盘 = 可审计): 决定能否被提炼进静态提示区、能否取代别的记录
        provenance: tier,
        importance,
        score: importance,
        created: now,
        lastAccess: now,
        hits: 0,
        scope,
        // 记忆治理字段 (吸收自 ppx-v2 mem-store): 层级 / 状态 / 版本链 / TTL
        layer: Number(layer) === LAYER_L4 ? LAYER_L4 : LAYER_L1,
        status: "active",
        prevId: null,
        ...(ttlDays ? { ttlDays: Number(ttlDays) } : {}),
        // 事实有效期窗口 (v3.1): 缺省字段 = 永久有效 (旧数据/调用方零影响)
        ...(this._normTime(validFrom) ? { validFrom: this._normTime(validFrom) } : {}),
        ...(this._normTime(validTo) ? { validTo: this._normTime(validTo) } : {}),
        ...(meta ? { meta } : {}),
      };
      this.facts.push(fact);
      this._indexFact(fact);
      // v3.1 (Graphiti 思想): supersedeId 指定被本条取代的旧事实, 其 validTo 收口到当前时刻
      // —— 旧事实不删除 (可审计"当时为真"), 只是从此不再被检索命中
      // 跨 tier 取代规则 (v2026-10-XX): 低权限写入**不得**收口高权限记录 —— 抓一次网页就能让
      //   "用户说过的话"从检索里静默消失, 这比注入更难发现。同权或更高才允许取代。
      if (supersedeId) {
        const old = this.facts.find((x) => x.id === supersedeId);
        if (old && old.id !== fact.id && !old.validTo && canSupersede(tier, tierOfRecord(old))) {
          old.validTo = now;
          this._markMutated(old);
        }
      }
      this._statsCache.clear(); // 新增事实 -> 作用域统计失效
      // 新增先记 upsert 再裁剪 (2026-09-18 修复 WAL 事件序): 原先 _prune 先写 remove、
      //   _markMutated 后补 upsert, WAL 重放时 upsert 在 remove 之后 → 被裁剪的事实"复活"。
      //   改为 upsert → remove 顺序, 重放结果与内存一致。
      this._markMutated(fact);
      // 总量裁剪: 超 maxFacts 时删除最弱事实 (防记忆膨胀)
      this._prune();
      return fact;
    });
  }

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
  }

  // 墓碑行数上限: 显式 maxTombstones 优先 (0/缺省则按 maxFacts × TOMBSTONE_FACTOR 推导)。
  //   返回 0 = 不设上限 (旧形状, 供测试对照与 opt-out)。
  _tombstoneCap() {
    const explicit = Number(this.opts.maxTombstones);
    if (Number.isFinite(explicit) && explicit > 0) return explicit;
    // 显式传 0 = 关闭墓碑上限 (与 maxFacts=0 的 opt-out 语义一致, 测试对照用)
    const max = Number(this.opts.maxFacts);
    if (!max || max <= 0) return 0;
    return max * FactStore.TOMBSTONE_FACTOR;
  }

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
    doomed.sort((a, b) => clockOf(a) - clockOf(b)); // 最老的在前
    if (olderThanMs > 0) doomed = doomed.filter((f) => clockOf(f) <= olderThanMs);
    if (cap > 0) doomed = doomed.slice(0, Math.max(0, doomed.length - cap));
    else if (limit > 0) doomed = doomed.slice(0, limit);
    if (!doomed.length) return [];
    const ids = new Set(doomed.map((f) => f.id));
    this.facts = this.facts.filter((f) => !ids.has(f.id));
    for (const id of ids) this._embedCache.delete(id);
    this.rebuildIndex();
    this._markRemoved([...ids]);
    return [...ids];
  }

  // 字符级索引 key: 中文拆单字 + 英文按 token (对中文检索才有效)
  // 索引层用单字(宽召回), 精排用 bigram(准匹配)
  _charKeys(s) {
    const chars = (String(s).match(/[\u4e00-\u9fff]/g) || []); // 中文单字
    const en = (String(s).toLowerCase().match(/[a-z0-9]+/g) || []); // 英文/数字 token
    return new Set([...chars, ...en]);
  }

  // 倒排索引: 把一条事实的字符 key 挂到索引 (key -> factId)
  _indexFact(fact) {
    for (const k of this._charKeys(fact.content)) {
      if (!this._index.has(k)) this._index.set(k, new Set());
      this._index.get(k).add(fact.id);
    }
  }

  // 重建索引 (facts 外部变更后调用)
  // F4 (2026-10-04): 墓碑 (status=deleted/archived) 不进倒排索引 —— 索引规模只由活跃集决定,
  //   否则"遗忘越勤, 索引越大", 检索还得从墓碑里筛。软删后索引里一个 key 都不该留下。
  rebuildIndex() {
    this._index = new Map();
    this._statsCache.clear();
    for (const fact of this._live()) this._indexFact(fact);
    return this._index.size;
  }

  // ==== BM25 检索 (升级版) ====

  // 精排分词: 中文 bigram + 英文 token (解决"止损"匹配"止损规则"的长段问题)
  _bigramSet(s) {
    const out = new Set();
    const low = String(s || "").toLowerCase();
    const cjk = low.match(/[\u4e00-\u9fff]+/g) || [];
    for (const seg of cjk) {
      if (seg.length === 1) { out.add(seg); continue; }
      for (let i = 0; i < seg.length - 1; i++) out.add(seg.slice(i, i + 2));
    }
    const en = low.match(/[a-z0-9]+/g) || [];
    for (const tk of en) out.add("en:" + tk);
    return out;
  }

  // 在作用域内统计 bigram 文档频率 / 平均长度 (BM25 参数)
  // 关键: df 用 bigram token 统计 (而非单字索引), 否则 IDF 恒为常数, 失去"罕见词权重高"的灵魂
  // 同时在 scoped 内计算, 保证 scope (AML 多租户) 统计隔离
  _queryStats(scoped) {
    const N = scoped.length;
    const df = new Map();
    let totalLen = 0;
    for (const f of scoped) {
      const bg = this._bigramSet(f.content);
      totalLen += bg.size;
      for (const t of bg) df.set(t, (df.get(t) || 0) + 1);
    }
    return { N, avgdl: N ? totalLen / N : 1, df };
  }

  // 单查询词 IDF: ln(1 + (N - df + 0.5)/(df + 0.5))
  // df 来自作用域内 bigram 文档频率 (见 _queryStats), 罕见词高分、常见词低分
  _idf(tok, stats) {
    const df = stats.df.get(tok) || 0;
    return Math.log(1 + (stats.N - df + 0.5) / (df + 0.5));
  }

  // BM25 打分 (简化 tf=1, 因 tokenize 去重为 set)
  _bm25Score(fact, qAll, stats) {
    const fAll = this._bigramSet(fact.content);
    if (!fAll.size) return 0;
    const docLen = fAll.size;
    const k1 = 1.5;
    const b = 0.75;
    let s = 0;
    for (const t of qAll) {
      if (!fAll.has(t)) continue;
      const idf = this._idf(t, stats);
      const tf = 1;
      s += idf * ((tf * (k1 + 1)) / (tf + k1 * (1 - b + b * (docLen / stats.avgdl))));
    }
    return s;
  }

  // bigram Jaccard 相似度 (0~1): 两段文本的 bigram 集合重合度
  // 用于语义相似去重 (LLM 提炼变体字面不同但语义相同), 阈值通常 0.5+
  // (集合运算收敛到 utils/similarity, 分词仍用本类的 scope 感知 _bigramSet)
  _jaccard(a, b) {
    return setJaccard(this._bigramSet(a), this._bigramSet(b));
  }

  // bigram overlap 系数 (0~1): 交集 / 较短集合, 对「词序变化但共享核心词」的松散同义改写更敏感
  // 比 Jaccard 更宽松: LLM 提炼变体词序/措辞大变时 Jaccard 可能 <0.6, 但核心词重合度高, overlap 能捕获
  _overlap(a, b) {
    return setOverlap(this._bigramSet(a), this._bigramSet(b));
  }

  // 查找与给定内容最相似的现有事实 (相似度 >= threshold 才返回, 默认 null)
  // method: "jaccard" (默认) 或 "overlap" (词序变化容错)
  // 供 add(similarThreshold) / 提炼去重使用; 中文 bigram 变体通常 >0.6
  findSimilar(content, { threshold = 0.6, scope = null, method = "jaccard" } = {}) {
    const c = this._norm(content);
    if (!c) return null;
    const scoped = this._live(scope);
    const fn = method === "overlap" ? (a, b) => this._overlap(a, b) : (a, b) => this._jaccard(a, b);
    let best = null;
    let bestScore = 0;
    for (const f of scoped) {
      const s = fn(c, f.content);
      if (s > bestScore) { bestScore = s; best = f; }
    }
    return bestScore >= threshold ? best : null;
  }

  // 检索: BM25 主导 (IDF 区分常见/罕见词 + 长度归一) + 子串强信号 + 高斯衰减(乘性时效) + 命中权重
  query(q, { limit = 5, minScore = 1, scope = null, includeExpired = false } = {}) {
    const nowD = this._nowDays();
    const ql = (q || "").toLowerCase();
    const qAll = this._bigramSet(ql);
    // scope 过滤基底 (检索隔离: 只查指定 scope 的事实); 软删条目一律不进检索
    // v3.1: 时效窗口过滤 —— 已失效/未生效的事实默认不命中 (includeExpired=true 供治理检视)
    const liveAll = this._live(scope);
    const scoped = includeExpired ? liveAll : liveAll.filter((f) => this._isCurrent(f));
    // 空查询: 按衰减分返回全部 (保持旧行为, 供 memory-ticker 取 top facts)
    if (qAll.size === 0) {
      return scoped
        .map((f) => ({ ...f, effectiveScore: this._decay(f.score, Math.max(0, nowD - new Date(f.lastAccess).getTime() / 86400000), f.layer) }))
        .sort((a, b) => b.effectiveScore - a.effectiveScore)
        .slice(0, limit);
    }
    // 倒排候选集 (至少命中一个查询字符 key; 阈值保护防常见字退化)
    let candidates = scoped;
    const qKeys = this._charKeys(q);
    if (qKeys.size > 0 && this._index && this._index.size) {
      const candIds = new Set();
      for (const k of qKeys) {
        const ids = this._index.get(k);
        if (ids) for (const id of ids) candIds.add(id);
      }
      if (candIds.size > 0 && candIds.size <= scoped.length * 0.9) {
        candidates = scoped.filter((f) => candIds.has(f.id));
      }
    }
    // BM25 参数在作用域内计算, 按 scope 缓存 (facts 不可变, add 时失效)
    const scopeKey = scope == null ? "__all__" : "s:" + scope;
    let stats = this._statsCache.get(scopeKey);
    if (!stats) { stats = this._queryStats(scoped); this._statsCache.set(scopeKey, stats); }
    const scored = [];
    for (const f of candidates) {
      const days = Math.max(0, nowD - new Date(f.lastAccess).getTime() / 86400000);
      const fc = f.content.toLowerCase();
      // BM25 主导
      const bm = this._bm25Score(f, qAll, stats);
      // 无交集(词未命中且无整句子串)则跳过, 避免返回无关噪声
      if (bm === 0 && !(ql && fc.includes(ql))) continue;
      // 时效+命中权重做成"乘性因子": 越新越接近 1, 越旧最多折到 0.4 倍
      // 避免旧记忆(短)靠微弱加法反超新记忆(长), 保证新旧事实冲突时返回新事实
      const recency = Math.exp(-this._lambdaOf(f) * days * days); // 0~1, 越新越大 (L4 衰减更慢)
      let s = bm * 10 * (0.4 + 0.6 * recency);
      // 子串强信号 (整句命中)
      if (ql && fc.includes(ql)) s += 5;
      // 命中权重 (辅助)
      s += (f.hits > 0 ? Math.min(f.hits, 5) : 0);
      // 重要性因子 (补齐 CrewAI 三因子: 语义×时效×重要性); 默认 importance=10 -> +1.5, 不喧宾夺主
      s += Math.min(f.importance || 0, 20) / 20 * 3;
      if (s >= minScore) scored.push({ ...f, effectiveScore: s, bm25: bm });
    }
    scored.sort((a, b) => b.effectiveScore - a.effectiveScore);
    return scored.slice(0, limit);
  }

  // 多查询变体检索 + RRF 融合 (供 LLM 查询扩展等场景: 每个变体各查一遍再融合)
  queryMulti(queries, { limit = 5, scope = null, minScore = 1, includeExpired = false } = {}) {
    const lists = [];
    for (const q of queries) {
      const r = this.query(q, { limit: Math.max(limit * 2, 10), scope, minScore, includeExpired });
      if (r.length) lists.push(r);
    }
    if (!lists.length) return [];
    if (lists.length === 1) return lists[0].slice(0, limit);
    return rrfFuse(lists).slice(0, limit);
  }

  // ---- 可插拔 embedder (dense 语义检索, 零依赖默认关闭) ----
  // 用户注入: ctx.consume("facts").setEmbedder(async (text, role) => number[])
  //   role = "query" | "passage" (非对称模型用; 忽略第二参数的实现照常工作)
  setEmbedder(fn) {
    this.embedder = typeof fn === "function" ? fn : null;
    this._embedCache.clear();
    return this;
  }

  async _embed(text, role = "query") {
    if (!this.embedder) throw new Error("未配置 embedder");
    // role ("query"|"passage") 透传给 embedder: 非对称模型 (e5) 的 query/passage 前缀不同,
    //   只给一个入口参数就退化成"全按查询编码"。忽略第二参数的实现 (云端 OpenAI 兼容) 无影响。
    const v = await this.embedder(String(text), role);
    return Array.isArray(v) && v.length ? v : null;
  }

  // 向量缓存 LRU 读 (2026-10-04): Map 迭代序 = 插入序, 旧实现只在超限时删"最早插入"那条,
  //   于是热点事实的向量也可能被淘汰、而再没被查过的冷数据永久占位 (FIFO 冒充 LRU)。
  //   命中时 delete+set 把它挪到队尾 = 真正的最近使用序。
  _embedCacheGet(id) {
    if (!this._embedCache.has(id)) return undefined;
    const v = this._embedCache.get(id);
    this._embedCache.delete(id);
    this._embedCache.set(id, v);
    return v;
  }

  _embedCacheSet(id, vec) {
    this._embedCache.delete(id);
    this._embedCache.set(id, vec);
    while (this._embedCache.size > this._embedCacheMax) {
      const oldest = this._embedCache.keys().next();
      if (oldest.done) break;
      this._embedCache.delete(oldest.value);
    }
    return vec;
  }

  // 取一条事实的向量 (缓存命中优先); 失败也缓存 null 占位, 防每次查询重投同一个坏 embedder
  // 事实一律按 "passage" 编码 (与查询的 "query" 侧对称配对)
  async _embedFor(fact) {
    if (this._embedCache.has(fact.id)) return this._embedCacheGet(fact.id);
    let ev = null;
    try { ev = await this._embed(fact.content, "passage"); } catch { ev = null; }
    return this._embedCacheSet(fact.id, ev || null);
  }

  // 余弦相似度 (零依赖)
  _cosine(a, b) {
    if (!a || !b || a.length !== b.length) return 0;
    let dot = 0, na = 0, nb = 0;
    for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
    if (!na || !nb) return 0;
    return dot / (Math.sqrt(na) * Math.sqrt(nb));
  }

  // 语义检索: embedder 有则 dense cosine 排序 + 与 BM25 RRF 融合; 无则退化为 BM25
  async querySemantic(q, { limit = 5, scope = null, includeExpired = false } = {}) {
    if (!this.embedder) return this.query(q, { limit, scope, includeExpired });
    const liveAll = this._live(scope);
    const scoped = includeExpired ? liveAll : liveAll.filter((f) => this._isCurrent(f)); // v3.1 时效过滤
    const qv = await this._embed(q, "query").catch(() => null);
    if (!qv) return this.query(q, { limit, scope });
    // 懒加载每条事实的 embedding (内存缓存, 不落盘避免 facts.json 膨胀)
    const dense = [];
    for (const f of scoped) {
      const ev = await this._embedFor(f);
      if (ev) dense.push({ ...f, dense: this._cosine(qv, ev) });
    }
    dense.sort((a, b) => b.dense - a.dense);
    // dense 与 BM25 双路 RRF 融合
    const bm25 = this.query(q, { limit, scope });
    return rrfFuse([dense, bm25]).slice(0, limit);
  }

  hit(id) {
    return withFileLock(this.file, () => {
      this._reload();
      const f = this.facts.find((x) => x.id === id);
      if (!f) return;
      f.hits += 1;
      f.lastAccess = nowISO();
      f.score += this.opts.hitBonus;
      this._markMutated(f);
      return f;
    });
  }

  addMemory(message) {
    // 从对话中提取记忆: 简单启发式, 过滤掉问候/无信息量
    // v1.0.7 治理: 子串/开头匹配拦"你好皮皮虾"类 (旧版精确匹配逃逸), 加长度上限防长文污染
    const STOP = ["你好", "您好", "在吗", "谢谢", "感谢", "辛苦了", "收到", "哈喽", "hello", "hi", "再见", "拜拜", "好的", "嗯", "ok", "好的好的"];
    const clean = (message || "").trim();
    // 太短 (<4) 无信息量, 太长 (>200) 不适合当原子事实 (整段对话原文不应入库)
    if (!clean || clean.length < 4 || clean.length > 200) return null;
    const lower = clean.toLowerCase();
    // 整句就是寒暄词 (精确)
    if (STOP.some((s) => lower === s)) return null;
    // 短句以寒暄词开头 (如 "你好皮皮虾", "好的没问题") → 不作为长期事实
    if (clean.length <= 12 && STOP.some((s) => lower.startsWith(s))) return null;
    // 疑问/指令句式 → 临时查询, 不作长期事实
    // v1.0.8 修复 (P1-1): 原实现写作 `clean.length <= 8 && /.../.test(clean)`,
    //   长度前置条件把整条过滤器架空了 —— 只要超过 8 字, 任何疑问句/指令都照样入库
    //   (实测污染率 40%: "今天几号了现在"、"帮我看看这个文件里写了什么内容" 全成了长期事实)。
    //   现改为按"句式特征"判定, 与长度完全解耦, 且只认句首/句尾标记, 不动句中的陈述性内容,
    //   保证 "我习惯用 Node 22 跑测试" 这类真事实不受影响。
    // 判据 1: 问号/疑问助词/回忆口吻收尾 ("来着" 是典型的"我在问你"信号)
    if (/[?？]\s*$|(吗|呢|来着)[?？]?$/.test(clean)) return null;
    // 判据 2: 疑问词起手 (允许"现在/今天"等时间前缀, 覆盖 "现在几点" "今天几号")
    if (/^(现在|今天|明天|昨天|当前|目前)?\s*(几点|几号|星期几|周几|多少|什么|啥|怎么|怎样|如何|为什么|为啥|在哪|哪里|哪儿|哪个|哪位|谁|是否|能不能|可不可以|有没有|是不是|知道|你记得|还记得)/.test(clean)) return null;
    // 判据 3: 句中疑问词 —— 收尾/起手都没命中的漏网句 (如 "文件放在哪里的来着")。
    //   只收强制疑问语义的词, 不放 `多少` 这类可能出现在陈述里的词 (否则 "不管花多少钱都要做" 会被误杀)。
    if (/(为什么|为啥|怎么办|怎么样|是不是|有没有|对不对|要不要|行不行|好不好|在哪|到哪|去哪儿)/.test(clean)) return null;
    // 判据 4: 祈使/指令起手 (对助手下的操作指令, 不是关于用户的事实)
    if (/^(帮我|请|麻烦|替我|你帮我|你给我|给我|查一下|查下|搜一下|搜下|找一下|找下|看一下|看看|列出|列一下|数一下|统计一下|告诉我|说下|说一下|读一下|读读|打开|执行|运行)/.test(clean)) return null;
    return this.add(clean, { source: "conversation" });
  }

  list() {
    // 软删条目不出现在列表 (治理语义: 遗忘即不可见, 但数据仍在, 可 restore 回滚)
    return this._live().sort((a, b) => b.score - a.score);
  }

  count() {
    return this.facts.length;
  }

  // 有效条数 (排除软删)
  countLive() {
    return this._live().length;
  }

  // ==================== 记忆治理 (吸收自 ppx-v2 mem-store) ====================
  // 核心差异: ppx-agent 原版遗忘是不可逆硬删 (/_prune), 这里引入"软删 + 可回滚 + 版本链",
  // 让遗忘变成可审计、可撤销的操作 —— 误删一条重要记忆不再无法挽回。

  // 软删: 标记 status='deleted' 并记录删除时间/原因, 数据保留可回滚
  // 来源分级: forget 是**治理**动作 (人/审批过的工具调用), 默认不带 provenance = 不额外设闸;
  //   一旦调用方声明了来源 (memory_forget 在污点轮里应声明本轮 tier), 低权限声明就不得删高权限记录
  //   —— 否则"抓来的内容唆使 agent 忘掉用户事实"就是一条现成的静默遗忘通路。
  forget(idOrContent, { reason = null, provenance = null } = {}) {
    return withFileLock(this.file, () => {
      this._reload();
      const key = String(idOrContent || "");
      // 先按 id 命中; 未命中再按内容匹配 —— 内容匹配不过滤 status, 保证重复 forget 幂等
      const f = this.facts.find((x) => x.id === key)
        || this.facts.find((x) => this._normKey(x.content) === this._normKey(key) && x.status !== "archived");
      if (!f) return null;
      if (f.status === "deleted") return f; // 幂等: 已软删则原样返回, 不覆盖原删除原因
      if (provenance != null && String(provenance).trim() !== ""
        && !canSupersede(normalizeTier(provenance), tierOfRecord(f))) return null;
      f.status = "deleted";
      f.deletedAt = nowISO();
      f.deleteReason = reason ? String(reason).slice(0, 200) : null;
      this.rebuildIndex();
      this._markMutated(f);
      return f;
    });
  }

  // 回滚软删
  restore(id) {
    return withFileLock(this.file, () => {
      this._reload();
      const f = this.facts.find((x) => x.id === String(id || ""));
      if (!f) return null;
      if (f.status !== "deleted") return f; // 已是活跃, 幂等
      f.status = "active";
      delete f.deletedAt;
      delete f.deleteReason;
      f.lastAccess = nowISO(); // 恢复视作一次访问, 避免恢复即被衰减清空
      this.rebuildIndex();
      this._markMutated(f);
      return f;
    });
  }

  // 列出已软删的记忆 (供人工/审计复核)
  deletedList() {
    return this.facts.filter((f) => f.status === "deleted").sort((a, b) => String(b.deletedAt || "").localeCompare(String(a.deletedAt || "")));
  }

  // 更新内容: 保留旧版为 prevId 版本链 (记忆演化可追溯), 新条继承 id/分数
  // 跨 tier 取代规则: 低权限写入不得改写高权限记录 (update = 覆盖内容 + 归档旧版, 是最强的
  //   "取代"形态)。未声明 provenance 时按 source (或记录现有 source) 登记表定级; 登记不上 = unknown
  //   → 只能改隔离带记录。返回 null = 被闸门拒绝, 调用方 (工具/治理) 会看到"没改成"。
  update(id, content, { importance, layer, source, provenance } = {}) {
    return withFileLock(this.file, () => {
      this._reload();
      const f = this.facts.find((x) => x.id === String(id || ""));
      if (!f) return null;
      const tier = resolveWriteTier({ provenance, source: source ?? f.source });
      if (!canSupersede(tier, tierOfRecord(f))) return null;
      const norm = this._norm(stripTierTags(scrubPII(String(content ?? ""), { keep: ["email", "phone"] }).cleaned));
      if (!norm) return null;
      // 旧版快照入链 (只保留一层历史, 防无限膨胀)
      const archived = {
        ...f,
        id: cryptoRandomId(),
        status: "archived",
        archivedAt: nowISO(),
        supersededBy: f.id,
      };
      f.content = norm;
      f.prevId = archived.id;
      f.updatedAt = nowISO();
      // 内容变了, 旧向量必须作废: 缓存以 id 为键, 不清就是"用上一条内容的相似度排这一条"
      this._embedCache.delete(f.id);
      if (importance != null) { f.importance = importance; f.score = Math.max(f.score, importance); }
      if (layer != null) f.layer = Number(layer) === LAYER_L4 ? LAYER_L4 : LAYER_L1;
      if (source != null) f.source = source;
      // 晋级只向上 (canSupersede 已保证 tier 不低于现值); 同权保留原声明, 避免无谓 churn
      if (rankOf(tier) > rankOf(tierOfRecord(f))) f.provenance = tier;
      this.facts.push(archived);
      this.rebuildIndex();
      this._markMutated(archived, f);
      return f;
    });
  }

  // TTL 扫描: 超过 ttlDays 未访问的条目软归档 (非硬删)
  // 与 /_prune 的分工: _prune 是容量保护的硬删, sweepExpired 是时效治理的软归档 (可回滚)
  // 来源分级 (v2026-10-XX) 新增可选 tier 选择器 (与 sqlite 后端同参数同口径): 只扫该档的记录,
  //   墓碑年龄回收同样按档过滤 —— 语义闭合: sweepExpired({tier:"quarantined"}) 只动隔离带,
  //   用户事实 (含其墓碑) 一律不碰。缺省 null = 全量, 旧调用方逐字同行为。
  sweepExpired({ ttlDays = 90, layer = null, dryRun = false, tier = null } = {}) {
    // F4: 计划阶段必须基于**磁盘真相** —— 墓碑的删除时钟可能被外部/他进程改过
    //   (测试用 backdate 直接改盘模拟"躺了 N 天"), dryRun 要报的数也必须与真跑一致。
    this._reload();
    const nowD = this._nowDays();
    const targets = [];
    for (const f of this.facts) {
      if (f.status === "deleted") continue;
      if (layer != null && Number(f.layer || LAYER_L1) !== Number(layer)) continue;
      if (!matchesTierSelector(tierOfRecord(f), tier)) continue;
      const ttl = Number(f.ttlDays || ttlDays);
      if (!ttl || ttl <= 0) continue;
      const days = Math.max(0, nowD - new Date(f.lastAccess).getTime() / 86400000);
      if (days >= ttl) targets.push(f.id);
    }
    // F4 (2026-10-04) 墓碑年龄回收: 挂在**同一次**扫描里 (不新起定时器)。
    //   purgeGraceDays>0 = 超过保留期的墓碑物理回收 (保留期内的最近删除仍可 restore/审计)。
    //   判据只看删除/归档时钟, 与 validFrom/validTo 窗口无关 (窗口只管检索可见性)。
    const graceDays = Number(this.opts.purgeGraceDays) || 0;
    const graceCutoff = graceDays > 0 ? Date.now() - graceDays * 86400000 : 0;
    const purgePlan = graceCutoff > 0
      ? this.facts.filter((f) => (f.status === "deleted" || f.status === "archived")
          && matchesTierSelector(tierOfRecord(f), tier)
          && (() => {
            const t = f.deletedAt || f.archivedAt || f.lastAccess || f.created;
            const ms = t ? new Date(t).getTime() : 0;
            return Number.isFinite(ms) && ms <= graceCutoff;
          })())
      : [];
    if (dryRun) {
      return {
        swept: targets.length, ids: targets, dryRun: true,
        purged: purgePlan.length, purgedIds: purgePlan.map((f) => f.id),
      };
    }
    return withFileLock(this.file, () => {
      this._reload();
      const touched = [];
      let n = 0;
      for (const id of targets) {
        const f = this.facts.find((x) => x.id === id);
        if (f && f.status !== "deleted") {
          this._softDelete(f, `TTL ${ttlDays} 天未访问自动归档`);
          n++;
          touched.push(f);
        }
      }
      if (touched.length) this.rebuildIndex();
      if (touched.length) this._markMutated(...touched);
      // 墓碑年龄回收 (锁内重读后按同一 graceCutoff 再算一次, 用磁盘真相而非过期计划)
      let purgedIds = [];
      if (graceCutoff > 0) purgedIds = this._purgeTombstones({ olderThanMs: graceCutoff, tier });
      return { swept: n, ids: targets, dryRun: false, purged: purgedIds.length, purgedIds };
    });
  }

  // 按层清空 (L4 程序性记忆 / L1 事实), 默认软删, hard=true 才真删
  clearLayer(layer = LAYER_L1, { hard = false } = {}) {
    return withFileLock(this.file, () => {
      this._reload();
      const target = Number(layer);
      const hits = this.facts.filter((f) => Number(f.layer || LAYER_L1) === target);
      let removedIds = [];
      const touched = [];
      if (hard) {
        removedIds = hits.map((f) => f.id);
        this.facts = this.facts.filter((f) => Number(f.layer || LAYER_L1) !== target);
      } else {
        for (const f of hits) {
          if (f.status === "deleted") continue;
          f.status = "deleted";
          f.deletedAt = nowISO();
          f.deleteReason = `clearLayer(${target})`;
          touched.push(f);
        }
      }
      this.rebuildIndex();
      if (hard) this._markRemoved(removedIds); else this._markMutated(...touched);
      return { layer: target, affected: hits.length, hard: !!hard };
    });
  }

  // 导出全量记忆 (含软删/归档, 供备份与迁移)
  exportAll({ includeDeleted = true } = {}) {
    const items = includeDeleted ? this.facts : this._live();
    return {
      version: 1,
      exportedAt: nowISO(),
      count: items.length,
      items: items.map((f) => ({ ...f })),
    };
  }

  // 导入记忆: merge(默认, 按内容去重跳过重复) 或 replace(整体替换)
  importAll(payload, { mode = "merge" } = {}) {
    const items = Array.isArray(payload) ? payload : (payload && Array.isArray(payload.items) ? payload.items : null);
    if (!items) return { ok: false, reason: "导入数据格式非法 (需数组或 {items:[]})" };
    return withFileLock(this.file, () => {
      this._reload();
      if (mode === "replace") {
        // v2.7.0: 补全对象字段 (与 merge 分支一致, 见 _normalizeFact) —— 旧版只留 id/content,
        // lastAccess/importance 缺失导致衰减/recency 计算 NaN, 检索永远返回空
        this.facts = items.map((it) => this._normalizeFact(it)).filter(Boolean);
        this.rebuildIndex();
        this._markReplace(this.facts);
        return { ok: true, mode, imported: this.facts.length, skipped: 0 };
      }
      let imported = 0, skipped = 0;
      const seen = new Set(this.facts.map((f) => this._normKey(f.content)));
      const added = [];
      for (const it of items) {
        const factObj = this._normalizeFact(it);
        if (!factObj) { skipped++; continue; }
        const k = this._normKey(factObj.content);
        if (seen.has(k)) { skipped++; continue; }
        seen.add(k);
        this.facts.push(factObj);
        imported++;
        added.push(factObj);
      }
      this.rebuildIndex();
      this._markMutated(...added);
      return { ok: true, mode, imported, skipped };
    });
  }

  // 可观测: L1 原子记忆统计 (总量/来源分布/类型分布), 供 agent.stats() 聚合
  stats() {
    const bySource = {};
    const byType = {};
    const byLayer = {};
    const byProvenance = {};
    let quarantined = 0;
    let deleted = 0, archived = 0;
    for (const f of this.facts) {
      const s = f.source || "unknown";
      const t = f.type || "general";
      const l = Number(f.layer || LAYER_L1);
      const p = tierOfRecord(f);
      bySource[s] = (bySource[s] || 0) + 1;
      byType[t] = (byType[t] || 0) + 1;
      byLayer[l] = (byLayer[l] || 0) + 1;
      byProvenance[p] = (byProvenance[p] || 0) + 1;
      if (isQuarantined(p)) quarantined++;
      if (f.status === "deleted") deleted++;
      if (f.status === "archived") archived++;
    }
    return {
      total: this.facts.length,
      live: this.facts.length - deleted - archived,
      deleted,
      archived,
      // F4 (2026-10-04): 把"盘上行数"与"还能用的条数"分开说清楚 —— 此前工具/UI 只看到
      // count() (行数), 遗忘链条越长越像"记忆还在涨"。rows=行数, tombstones=行数-活跃。
      rows: this.facts.length,
      tombstones: deleted + archived,
      max_facts: this.opts.maxFacts || 0,
      max_tombstones: this._tombstoneCap(),
      purge_grace_days: Number(this.opts.purgeGraceDays) || 0,
      by_source: bySource,
      by_type: byType,
      by_layer: byLayer,
      // 来源分级可观测 (与 sqlite 后端同键名): 隔离带占比是"投毒是否在被吸收"的第一读数
      by_provenance: byProvenance,
      quarantined,
    };
  }
}

function cryptoRandomId() {
  // v2.6.1: Math.random() 名实不符且非加密安全 (碰撞风险随条目数增长)
  // 改用 Node 内置 crypto.randomUUID() (UUID v4, 加密安全随机源)
  return "f_" + crypto.randomUUID();
}

// RRF (Reciprocal Rank Fusion): 融合多个排序列表 (每项按 rank 倒数加权求和)。
// 用于多查询变体/多信号检索的融合, 纯函数零依赖。
export function rrfFuse(lists, { k = 60 } = {}) {
  const score = new Map(); // id -> fused score
  const items = new Map(); // id -> item (保留首个出现的对象)
  for (const list of lists) {
    list.forEach((item, rank) => {
      const id = item && item.id;
      if (id == null) return;
      if (!items.has(id)) items.set(id, item);
      score.set(id, (score.get(id) || 0) + 1 / (k + rank + 1));
    });
  }
  return [...score.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([id]) => items.get(id));
}
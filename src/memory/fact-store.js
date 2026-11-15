// src/memory/fact-store.js - 记忆存储 (高斯衰减遗忘)
// 设计溯源 docs/PROVENANCE.md#hanaagent; 自研记忆存储: 每条记忆有 importance, 高斯衰减, 命中加分
//
// 2026-11-03 巨石拆分 (保持对外接口不变): 本文件只保留「类身份 + 构造 + 唯一写入口 add」,
//   其余方法按域拆成五个 mixin 挂回 FactStore.prototype (调用方 this.xxx 与拆分前完全一致):
//     fact-store-wal.js        落盘/重读/磁盘签名/WAL 增量与重放 (SIG_SETTLE_MS/FACTS_SCHEMA_VERSION 在此)
//     fact-store-normalize.js  数据模型常量 + 归一化/去重索引/容量裁剪 (含 _decay/_live)
//     fact-store-embed.js      dense 语义检索 (embedder/向量缓存/概念路/querySemantic)
//     fact-store-governance.js 治理门面 (软删/版本链/TTL/导入导出/stats)
//     fact-store-retrieval.js  词法检索 (BM25/相似度/RRF) —— 此前已拆出
//   纪律: 所有 mixin 不得 import 本文件 (成环); 宿主 import mixin 是允许的单向依赖。
import path from "node:path";
import { ensureDir, readJsonGuarded, withFileLock, nowISO } from "../utils/store.js";
import { normalizeStoreOpts } from "./store-opts.js";
import { migrateData } from "../utils/schema.js";
import { walFileOf } from "../utils/wal.js";
import { scrubPII } from "../utils/pii.js";
// 词法检索/打分 (分词、BM25、相似度、RRF 融合) 在 retrieval; 只做单向依赖, 避免成环。
import { factStoreRetrievalMethods, rrfFuse } from "./fact-store-retrieval.js";
export { rrfFuse };
// 2026-11-08 精简: sqlite 记忆后端族 (含 backend-migrate 一次性导入) 归档至 git 历史,
//   默认后端 JSON 从未变更; skills/ppx-memory 扁平化副本本就不含这一支。
// v2026-10-04 (同步 src 2026-10-04 治理批次): 独立版刻意不依赖主项目 ——
//   utils/logger.js 不在扁平化范围内, warn 降级为 console.warn。
const warn = (...a) => console.warn(...a);
// v2026-10-XX (同步 src 来源分级批次, 2026-10-05): 写入 tier 的判定规则集中在 provenance.js
//   (零依赖、与 src/memory/provenance.js 逐字同源), 满足"技能副本整体可拷出"约束
//   —— 见 test/skill-memory-drift.test.js 的副本漂移守卫。
import { resolveWriteTier, canSupersede, stripTierTags, tierOfRecord } from "./provenance.js";
// 五个 mixin + 数据模型常量 (常量真实定义在 wal/normalize, 宿主 re-export 保持既有 import 路径不变)
import { factStoreWalMethods, FACTS_SCHEMA_VERSION } from "./fact-store-wal.js";
import { factStoreNormalizeMethods, cryptoRandomId, LAYER_L1, LAYER_L4, L4_DECAY_PER_DAY } from "./fact-store-normalize.js";
import { factStoreEmbedMethods } from "./fact-store-embed.js";
import { factStoreGovernanceMethods } from "./fact-store-governance.js";
export { L4_DECAY_PER_DAY, LAYER_L1, LAYER_L4, FACTS_SCHEMA_VERSION };

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
    // snake 兼容键 + 衰减/容量/墓碑默认值: 与 sqlite-store 同一份口径 (store-opts.js 单源)
    this.opts = normalizeStoreOpts(opts);
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
    // 去重键索引 (2026-10-30, L2): 归一化内容键 (含 scope) -> fact[]。
    //   add() 的去重原本对全部 facts 线性跑 _normKey (每条一次正则), 260 条库 × 每轮 = 每轮
    //   260 次归一化; 换成 Map 后是 O(1)。语义与原线性 find 完全一致 (仍按 status 过滤)。
    this._byKey = new Map();
    // 磁盘签名 (mtimeNs:size): 锁内 _reload 先校验再决定要不要重读。null = 未知, 必须重读。
    this._diskSig = null;
    // BM25 作用域统计缓存 (facts 内容不可变, add 时失效即可), 避免每查询 O(N) 重算
    this._statsCache = new Map();
    // 可插拔 embedder (dense 语义检索, 默认 null = 纯 BM25); _embedCache 内存缓存不落盘
    this.embedder = null;
    this._embedCache = new Map();
    this._embedCacheMax = 1000; // LRU 上限: 超过淘汰最旧插入项, 防长跑会话内存无界增长
    // 2026-10-24: 向量落盘缓存句柄 (setEmbedder 带 identity 时创建 VectorDiskCache)
    this._vecDisk = null;
    for (const fact of this.facts) this._indexFact(fact);
    if (this.wal) this._replayWal(); // 重放 WAL 增量 (崩溃恢复: 快照 + 追加日志 = 完整状态)
    // v3.0.1 (P0#1): 非 WAL 模式下若快照损坏, 跳过构造期立即落盘 (保护现场, 防空数组覆盖);
    // 后续任何显式 add/update 仍会正常落盘, 届时内存状态即事实源
    if (!(guarded.parseFailed && !this.wal)) this.save();
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
        // 2026-10-30 (L2): 走 _byKey 索引 O(1) 查找 (原实现对全部 facts 线性跑 _normKey)。
        //   语义不变: 仍要求同 scope、且跳过 deleted/archived。
        const existing = (this._byKey && this._byKey.size ? this._findLiveByKey(scope, normKey) : null)
          || this.facts.find((f) =>
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
        // 记忆治理字段 (承接自 ppx-v2 mem-store): 层级 / 状态 / 版本链 / TTL
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
      let superseded = false;
      if (supersedeId) {
        const old = this.facts.find((x) => x.id === supersedeId);
        if (old && old.id !== fact.id && !old.validTo && canSupersede(tier, tierOfRecord(old))) {
          old.validTo = now;
          superseded = true;
          this._markMutated(old);
        }
      }
      // 新增一条事实只需增量更新统计; 但若同时收口了旧事实的时效窗口,
      //   作用域可见集变了, 仍整体失效 (低频)。
      if (superseded) this._statsCache.clear(); else this._trackStats(fact);
      // 新增先记 upsert 再裁剪 (2026-09-18 修复 WAL 事件序): 原先 _prune 先写 remove、
      //   _markMutated 后补 upsert, WAL 重放时 upsert 在 remove 之后 → 被裁剪的事实"复活"。
      //   改为 upsert → remove 顺序, 重放结果与内存一致。
      this._markMutated(fact);
      // 总量裁剪: 超 maxFacts 时删除最弱事实 (防记忆膨胀)
      this._prune();
      return fact;
    });
  }
}

// 方法组挂在 prototype 上: 调用方 (this.query/save/_prune/...) 与拆分前完全一致。
// 五个 mixin 无同名方法 (见文件头拆分清单), Object.assign 顺序不影响行为。
Object.assign(FactStore.prototype,
  factStoreWalMethods,
  factStoreNormalizeMethods,
  factStoreEmbedMethods,
  factStoreGovernanceMethods,
  factStoreRetrievalMethods);

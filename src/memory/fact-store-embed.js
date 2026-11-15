// src/memory/fact-store-embed.js - FactStore 的 dense 语义检索 (mixin, 从 fact-store.js 拆出)
// 职责: 可插拔 embedder 注入 (setEmbedder)、向量三级缓存 (内存 LRU → 磁盘 VectorDiskCache → 现算)、
//   余弦相似度、概念路打分 (_conceptRank)、三路 RRF 融合检索入口 (querySemantic)。
// 全部是挂回 FactStore.prototype 的方法, 对外接口不变。
// 依赖约束: 不得 import fact-store.js —— 否则与宿主成环 (import retrieval 是允许的单向依赖)。
import path from "node:path";
import crypto from "node:crypto";
import { noteCatch } from "../utils/catch-log.js";
import { VectorDiskCache } from "./vector-disk.js";
import { expandedTermWords } from "./lexicon.js";
import { rrfFuse } from "./fact-store-retrieval.js";

export const factStoreEmbedMethods = {
  // ---- 可插拔 embedder (dense 语义检索) ----
  // 用户注入: ctx.consume("facts").setEmbedder(async (text, role) => number[])
  //   role = "query" | "passage" (非对称模型用; 忽略第二参数的实现照常工作)
  // 2026-10-24: setEmbedder 可带 { identity } 指纹 —— 向量落盘缓存 (VectorDiskCache) 以它
  //   作失效键, 换 embedder 模型自动作废旧向量。提供 identity 即启用磁盘缓存。
  setEmbedder(fn, { identity = null, vectorDisk = null } = {}) {
    this.embedder = typeof fn === "function" ? fn : null;
    this._embedCache.clear();
    this._vecDisk = null;
    if (this.embedder && (identity || vectorDisk)) {
      try {
        this._vecDisk = new VectorDiskCache(path.dirname(this.file), {
          fingerprint: String(identity || "custom"),
        });
      } catch (e) { noteCatch(e); /* 磁盘缓存不可用时退回纯内存 */ }
    }
    return this;
  },

  async _embed(text, role = "query") {
    if (!this.embedder) throw new Error("未配置 embedder");
    // role ("query"|"passage") 透传给 embedder: 非对称模型 (e5) 的 query/passage 前缀不同,
    //   只给一个入口参数就退化成"全按查询编码"。忽略第二参数的实现 (云端 OpenAI 兼容) 无影响。
    const v = await this.embedder(String(text), role);
    return Array.isArray(v) && v.length ? v : null;
  },

  // 向量缓存 LRU 读 (2026-10-04): Map 迭代序 = 插入序, 旧实现只在超限时删"最早插入"那条,
  //   于是热点事实的向量也可能被淘汰、而再没被查过的冷数据永久占位 (FIFO 冒充 LRU)。
  //   命中时 delete+set 把它挪到队尾 = 真正的最近使用序。
  _embedCacheGet(id) {
    if (!this._embedCache.has(id)) return undefined;
    const v = this._embedCache.get(id);
    this._embedCache.delete(id);
    this._embedCache.set(id, v);
    return v;
  },

  _embedCacheSet(id, vec) {
    this._embedCache.delete(id);
    this._embedCache.set(id, vec);
    while (this._embedCache.size > this._embedCacheMax) {
      const oldest = this._embedCache.keys().next();
      if (oldest.done) break;
      this._embedCache.delete(oldest.value);
    }
    return vec;
  },

  // 取一条事实的向量 (缓存命中优先); 失败也缓存 null 占位, 防每次查询重投同一个坏 embedder
  // 事实一律按 "passage" 编码 (与查询的 "query" 侧对称配对)
  // 2026-10-24: 三级查找 内存 LRU → 磁盘缓存 (内容哈希一致才命中) → embedder 现算
  async _embedFor(fact) {
    if (this._embedCache.has(fact.id)) return this._embedCacheGet(fact.id);
    const disk = this._vecDisk;
    if (disk) {
      // 内容哈希作失效键: 内容变 = 自动重算 (哈希在锁外现算, sha1 于短文本开销可忽略)
      const ch = crypto.createHash("sha1").update(String(fact.content || ""), "utf8").digest("hex");
      const v = disk.get(fact.id, ch);
      if (v) return this._embedCacheSet(fact.id, v);
      let ev = null;
      try { ev = await this._embed(fact.content, "passage"); } catch { ev = null; /* swallowed-ok(2026-11-03): 无向量则该条不参与向量召回 */ }
      const out = this._embedCacheSet(fact.id, ev || null);
      if (ev) disk.set(fact.id, ch, ev);
      return out;
    }
    let ev = null;
    try { ev = await this._embed(fact.content, "passage"); } catch { ev = null; /* swallowed-ok(2026-11-03): 无向量则该条不参与向量召回 */ }
    return this._embedCacheSet(fact.id, ev || null);
  },

  // 余弦相似度 (零依赖)
  _cosine(a, b) {
    if (!a || !b || a.length !== b.length) return 0;
    let dot = 0, na = 0, nb = 0;
    for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
    if (!na || !nb) return 0;
    return dot / (Math.sqrt(na) * Math.sqrt(nb));
  },

  // 概念路 (2026-10-30, 2026-11-12 改整词口径): 用 lexicon 的"概念簇"把查询扩成一组同族词, 再按命中度排序。
  //   这一路存在的理由: dense (字符 n-gram 余弦) 和 BM25 (bigram) **都是字面信号**,
  //   查询与事实字面零交集时两路全空 —— "什么操作系统" 找不到 "用户用 Windows 11"。
  //   概念路补的就是这一段。它只提供弱信号, 由 RRF 与另两路融合。
  //
  // 打分: 命中的扩展词按 IDF 加权求和 (同一簇被查询多个词命中时加权), 再按扩展集权重和开方归一。
  //   2026-11-12: 从 bigram 交集改为**整词子串**匹配。bigram 会跨词切分 ("同步会"→"同步"),
  //   而 "同步" 本身是「锁/并发」簇的词, 于是"什么时候开会"会误命中"同步文件锁"事实 ——
  //   这是概念路最主要的噪声来源。整词口径下只有事实里真的出现成员词才算桥。
  _conceptRank(q, scoped, stats, limit) {
    const words = expandedTermWords(q);
    if (!words.length || !scoped.length) return [];
    const isLatin = (t) => /^[a-z0-9][a-z0-9._-]*$/.test(t);
    // 扩展词的 document frequency (整词口径)。只对扩展词统计, 不对每条事实的每个 bigram 重算。
    const dfOf = new Map();
    for (const { term } of words) {
      let df = 0;
      if (isLatin(term)) {
        const token = "en:" + term;
        for (const f of scoped) {
          const fg = (stats.grams && stats.grams.get(f.id)) || this._bigramSet(f.content);
          if (fg.has(token)) df += 1;
        }
      } else {
        for (const f of scoped) if (String(f.content).toLowerCase().includes(term)) df += 1;
      }
      dfOf.set(term, df);
    }
    const idfOf = (df) => Math.log(1 + (stats.N - df + 0.5) / (df + 0.5));
    const norm = Math.sqrt(words.reduce((n, w) => n + w.weight, 0));
    const out = [];
    for (const f of scoped) {
      const fc = String(f.content).toLowerCase();
      const fg = (stats.grams && stats.grams.get(f.id)) || this._bigramSet(f.content);
      let s = 0;
      let hitN = 0;
      let minDf = Infinity;
      for (const { term, weight } of words) {
        const hit = isLatin(term) ? fg.has("en:" + term) : fc.includes(term);
        if (!hit) continue;
        hitN += 1;
        const df = dfOf.get(term) || 0;
        s += weight * idfOf(df);
        if (df < minDf) minDf = df;
      }
      if (!hitN) continue;
      // 准入门槛: 只命中 1 个扩展词时, 它必须是**稀有词**才算信号 ——
      //   "windows" 命中一次是强证据, "系统" 命中一次只是巧合。
      //   判据用 df 而不是绝对 IDF 阈值: 小库 (N=2) 时 df=1 的 idf 只有 0.69,
      //   用绝对阈值 (如 2.0) 会把真正的强命中一起误杀。
      const rareLimit = Math.max(1, Math.floor(stats.N * 0.2));
      if (hitN < 2 && minDf > rareLimit) continue;
      // 单命中降权 (2026-11-12): 一个扩展词命中常常是宽簇带来的巧合 ("目录"簇里的"文件"
      //   命中"同步文件锁"事实)。保留它 (仍然可能救场), 但只按半票参与融合。
      const score = (s / norm) * (hitN < 2 ? 0.5 : 1);
      out.push({ ...f, concept: score, conceptHits: hitN });
    }
    out.sort((a, b) => b.concept - a.concept);
    return out.slice(0, limit);
  },

  // 批量取向量 (2026-11-12, 审计 #5): 原 querySemantic 对每条未缓存事实 for-await 串行编码,
  //   N 条 = N 次 RTT 叠加 (远程 embedder 时单次查询可达秒级)。改为有界并发 (默认 8, 防打爆
  //   速率限制), 结果按输入顺序回填 —— 排序与串行实现逐位一致。
  async _embedMany(facts, concurrency = 8) {
    const out = new Array(facts.length);
    let next = 0;
    const workers = Math.max(1, Math.min(concurrency, facts.length));
    await Promise.all(Array.from({ length: workers }, async () => {
      for (;;) {
        const i = next++;
        if (i >= facts.length) return;
        out[i] = await this._embedFor(facts[i]);
      }
    }));
    return out;
  },

  // 语义检索: dense + BM25 + 概念 三路 RRF 加权融合; 无 embedder 时 BM25 + 概念两路
  async querySemantic(q, { limit = 5, scope = null, includeExpired = false } = {}) {
    const liveAll = this._live(scope);
    const scoped = includeExpired ? liveAll : liveAll.filter((f) => this._isCurrent(f)); // v3.1 时效过滤
    // 统计 (含每条文档的 bigram 集合) 在作用域内只算一次, 三路共用
    const scopeKey = (scope == null ? "__all__" : "s:" + scope) + (includeExpired ? "|exp" : "");
    let stats = this._statsCache.get(scopeKey);
    if (!stats || !stats.grams) { stats = this._queryStats(scoped); this._statsCache.set(scopeKey, stats); }
    const concept = this._conceptRank(q, scoped, stats, Math.max(limit * 3, 12));
    const bm25 = this.query(q, { limit, scope, includeExpired });
    // 逐条置信度 (2026-11-12): BM25 按**查询词覆盖率**打折 —— 查询 8 个二字组只命中 1 个
    //   的首名, 证据强度远低于全命中; 概念/向量路按各自分数的相对强度 (相对本路首名)。
    const qAll = this._bigramSet(String(q || "").toLowerCase());
    const cover = (f) => {
      if (!qAll.size) return 1;
      const fg = stats.grams && stats.grams.get(f.id);
      if (!fg) return 0;
      let n = 0;
      for (const t of qAll) if (fg.has(t)) n += 1;
      return n / qAll.size;
    };
    const bm25Conf = (f) => 0.1 + 0.9 * cover(f);
    // 概念路置信度按**证据条数**给票: 1 个扩展词命中常常是宽簇巧合 → 半票; 2 个 → 0.85;
    //   3 个以上才视为强桥。用绝对条数而不是"相对本路最高分", 否则列表整体是噪声时
    //   噪声首名也会拿到满票。
    const conceptConf = (f) => ((f.conceptHits || 1) >= 2 ? 1 : 0.35);
    if (!this.embedder) {
      // 无 embedder: BM25 + 概念 两路 (旧行为是纯 BM25)
      if (!concept.length) return bm25;
      return rrfFuse([bm25, concept], { weights: [1.0, 0.9], confidence: [bm25Conf, conceptConf] }).slice(0, limit);
    }
    const qv = await this._embed(q, "query").catch(() => null);
    if (!qv) {
      return concept.length
        ? rrfFuse([bm25, concept], { weights: [1.0, 0.9], confidence: [bm25Conf, conceptConf] }).slice(0, limit)
        : bm25;
    }
    // 懒加载每条事实的 embedding (内存缓存, 不落盘避免 facts.json 膨胀)
    const vecs = await this._embedMany(scoped);
    const dense = [];
    for (let i = 0; i < scoped.length; i++) {
      const f = scoped[i];
      const ev = vecs[i];
      if (!ev) continue;
      const sim = this._cosine(qv, ev);
      // dense 准入门槛 (2026-10-30 实测): 12 组"查询×事实"对上量了内置哈希向量的余弦分布 ——
      //   真正的弱语义命中落在 0.088~0.275 ("什么操作系统"×"Windows 11" 仅 0.088),
      //   无关噪声落在 0~0.074。阈值取 0.08: margin 很薄, 但宁可多放一条噪声 (权重 0.25 压着),
      //   也不要误杀唯一的弱语义桥 (取 0.12 会把 0.088 那条直接丢掉)。
      if (sim >= 0.08) dense.push({ ...f, dense: sim });
    }
    dense.sort((a, b) => b.dense - a.dense);
    const maxDense = dense.length ? dense[0].dense || 1 : 1;
    const denseConf = (f) => 0.6 + 0.4 * (Math.max(0, f.dense || 0) / maxDense);
    // 三路权重: BM25 是可靠的字面信号 → 1.0; 概念是可靠的语义桥 (词典受控) → 0.9;
    //   dense 是兜底通道 (哈希向量, 噪声大) → 0.25, 只用来在另两路全空时救场。
    //   旧实现三路等权, 结果是 dense 的噪声与 BM25 的准确命中同票 —— 那是召回上不去的直接原因。
    //   2026-11-12: 0.45 → 0.25。字符 n-gram 余弦对无关中文文本普遍有 0.15~0.25 的底噪,
    //   0.45 权重足以让纯噪声在多路投票里压过概念路的强命中 (实测"上线之前要做什么检查")。
    return rrfFuse([bm25, concept, dense], {
      weights: [1.0, 0.9, 0.25],
      confidence: [bm25Conf, conceptConf, denseConf],
    }).slice(0, limit);
  },
};

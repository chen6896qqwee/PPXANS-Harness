// src/memory/fact-store-retrieval.js - FactStore 的词法检索与打分 (mixin, 从 fact-store.js 拆出)
// 职责: 分词 (单字索引 key / bigram 精排 token) + BM25 统计与打分 + 相似度 + 多查询 RRF 融合。
// 全部是"无持久化副作用"的纯读路径方法, 挂回 FactStore.prototype 后对外接口完全不变。
// 依赖约束: 只允许 import 工具层 (utils/*), 不得 import fact-store.js —— 否则与宿主成环。
import { setJaccard, setOverlap } from "../utils/similarity.js";

export const factStoreRetrievalMethods = {
  _nowDays() {
    return Date.now() / 86400000;
  },

  // 字符级索引 key: 中文拆单字 + 英文按 token (对中文检索才有效)
  // 索引层用单字(宽召回), 精排用 bigram(准匹配)
  _charKeys(s) {
    const chars = (String(s).match(/[\u4e00-\u9fff]/g) || []); // 中文单字
    const en = (String(s).toLowerCase().match(/[a-z0-9]+/g) || []); // 英文/数字 token
    return new Set([...chars, ...en]);
  },

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
  },

  // 在作用域内统计 bigram 文档频率 / 平均长度 (BM25 参数)
  // 关键: df 用 bigram token 统计 (而非单字索引), 否则 IDF 恒为常数, 失去"罕见词权重高"的灵魂
  // 同时在 scoped 内计算, 保证 scope (AML 多租户) 统计隔离
  _queryStats(scoped) {
    const N = scoped.length;
    const df = new Map();
    // 每条文档的 bigram 集合一并缓存 (2026-10-30): BM25 打分与概念路都要它,
    //   原先每次打分各算一遍 (同一个事实在一轮里被算 3 次), 现在一轮算一次。
    const grams = new Map();
    let totalLen = 0;
    for (const f of scoped) {
      const bg = this._bigramSet(f.content);
      grams.set(f.id, bg);
      totalLen += bg.size;
      for (const t of bg) df.set(t, (df.get(t) || 0) + 1);
    }
    return { N, avgdl: N ? totalLen / N : 1, totalLen, df, grams };
  },

  // 增量维护作用域统计 (add 新增一条时调用), 避免整库重建:
  //   _statsCache 原先是 add 后 clear() —— 下一轮第一次 query 要重扫全部事实重新分词,
  //   实测 900 条库每轮多付 ~1.7ms。新增一条只会改变 grams/df/totalLen, 就地加即可;
  //   删除/改写等会减少条目的操作仍走 rebuildIndex() 全量重建 (低频)。
  _trackStats(fact) {
    const bg = this._bigramSet(fact.content);
    const bases = new Set([fact.scope == null ? "__all__" : "s:" + fact.scope, "__all__"]);
    for (const base of bases) {
      for (const key of [base, base + "|exp"]) {
        const st = this._statsCache.get(key);
        if (!st || !st.grams || st.grams.has(fact.id)) continue;
        st.grams.set(fact.id, bg);
        st.N += 1;
        st.totalLen += bg.size;
        st.avgdl = st.N ? st.totalLen / st.N : 1;
        for (const t of bg) st.df.set(t, (st.df.get(t) || 0) + 1);
      }
    }
  },

  // 单查询词 IDF: ln(1 + (N - df + 0.5)/(df + 0.5))
  // df 来自作用域内 bigram 文档频率 (见 _queryStats), 罕见词高分、常见词低分
  _idf(tok, stats) {
    const df = stats.df.get(tok) || 0;
    return Math.log(1 + (stats.N - df + 0.5) / (df + 0.5));
  },

  // BM25 打分 (简化 tf=1, 因 tokenize 去重为 set)
  // grams 取自 _queryStats 的作用域缓存 —— 同一事实在一轮里会被 BM25/概念路各算一次,
  //   重复分词是这条热路径最大的浪费 (2026-11-03 实测 800 条库单查询省 ~45%)。
  _bm25Score(fact, qAll, stats) {
    const fAll = (stats.grams && stats.grams.get(fact.id)) || this._bigramSet(fact.content);
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
  },

  // bigram Jaccard 相似度 (0~1): 两段文本的 bigram 集合重合度
  // 用于语义相似去重 (LLM 提炼变体字面不同但语义相同), 阈值通常 0.5+
  // (集合运算收敛到 utils/similarity, 分词仍用本类的 scope 感知 _bigramSet)
  _jaccard(a, b) {
    return setJaccard(this._bigramSet(a), this._bigramSet(b));
  },

  // bigram overlap 系数 (0~1): 交集 / 较短集合, 对「词序变化但共享核心词」的松散同义改写更敏感
  // 比 Jaccard 更宽松: LLM 提炼变体词序/措辞大变时 Jaccard 可能 <0.6, 但核心词重合度高, overlap 能捕获
  _overlap(a, b) {
    return setOverlap(this._bigramSet(a), this._bigramSet(b));
  },

  // 查找与给定内容最相似的现有事实 (相似度 >= threshold 才返回, 默认 null)
  // method: "jaccard" (默认) 或 "overlap" (词序变化容错)
  // 供 add(similarThreshold) / 提炼去重使用; 中文 bigram 变体通常 >0.6
  findSimilar(content, { threshold = 0.6, scope = null, method = "jaccard" } = {}) {
    const c = this._norm(content);
    if (!c) return null;
    const scoped = this._live(scope);
    // 作用域内每条事实的 bigram 集合复用检索统计缓存 (独立 key: findSimilar 含过期条目,
    //   与 query 的 scoped 集合可能不同, 不能共用 "s:<scope>" 键)。
    //   add() 的相似去重会对每条新事实调用本函数, 原实现每次全库重新分词 = O(N) 重复计算。
    const key = "sim:" + (scope == null ? "__all__" : "s:" + scope);
    let stats = this._statsCache.get(key);
    if (!stats || !stats.grams || stats.grams.size !== scoped.length) {
      stats = this._queryStats(scoped);
      this._statsCache.set(key, stats);
    }
    const cg = this._bigramSet(c);
    const overlap = method === "overlap";
    let best = null;
    let bestScore = 0;
    for (const f of scoped) {
      const fg = stats.grams.get(f.id) || this._bigramSet(f.content);
      const s = overlap ? setOverlap(cg, fg) : setJaccard(cg, fg);
      if (s > bestScore) { bestScore = s; best = f; }
    }
    return bestScore >= threshold ? best : null;
  },

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
    const scopeKey = (scope == null ? "__all__" : "s:" + scope) + (includeExpired ? "|exp" : "");
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
  },

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
  },
};

// RRF (Reciprocal Rank Fusion): 融合多个排序列表 (每项按 rank 倒数加权求和)。
// 用于多查询变体/多信号检索的融合, 纯函数零依赖。
// weights (2026-10-30): 每路的可信度系数, 与该路的 1/(k+rank) 相乘。
//   加它的原因: 三路等权时, 噪声大的那一路 (字符 n-gram 哈希 dense) 与准确的路 (BM25)
//   同票, 融合结果被噪声拉平 —— "多路融合反而更差"的典型成因。
//   缺省全 1 = 旧行为, 不改变既有调用方语义。
// confidence (2026-11-12): 每路的**逐条**置信度函数 (item, rank) -> 0..1, 与列表权重相乘。
//   RRF 只看名次, 会丢掉"这条命中有多强": 查询 8 个二字组只命中 1 个的 BM25 首名,
//   与命中全部查询词的首名同票; 概念路/向量路内部也有强弱之分 (余弦 0.34 vs 0.17)。
//   逐条置信度让融合按证据强度投票, 而不是把一条弱命中当强命中。
//   缺省 null = 旧行为。
export function rrfFuse(lists, { k = 60, weights = null, confidence = null } = {}) {
  const score = new Map(); // id -> fused score
  const items = new Map(); // id -> item (保留首个出现的对象)
  lists.forEach((list, li) => {
    const w = weights && weights[li] != null ? Number(weights[li]) : 1;
    if (!w || !Array.isArray(list)) return;
    list.forEach((item, rank) => {
      const id = item && item.id;
      if (id == null) return;
      let c = 1;
      if (confidence && typeof confidence[li] === "function") {
        const raw = Number(confidence[li](item, rank));
        c = Number.isFinite(raw) ? Math.min(1, Math.max(0, raw)) : 1;
      }
      if (!items.has(id)) items.set(id, item);
      score.set(id, (score.get(id) || 0) + (w * c) / (k + rank + 1));
    });
  });
  return [...score.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([id]) => items.get(id));
}

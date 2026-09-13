// src/memory/fact-store.js - 记忆存储 (高斯衰减遗忘)
// 架构参考 openhanako: 每条记忆有 importance, 高斯衰减, 命中加分
import path from "node:path";
import { ensureDir, readJson, writeJson, nowISO, logicalDay, withFileLock } from "../utils/store.js";

// 记忆动词前缀: 去重时剔除, 让"记住：X"与"X"视为同一条 (防 LLM 提炼版与原文冗余)
const MEMORY_VERB_PREFIXES = [
  /^(请记住|请记得|记得要|记住要|要记住|请牢记|别忘了|记住|记得|用户说|用户提到|提醒你)[:：\s，,、]*/,
];

export class FactStore {
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
      ...normOpts,
    };
    this.facts = readJson(this.file, []);
    // 倒排索引: token -> Set<factId>, 检索 O(n) -> O(候选)
    this._index = new Map();
    // BM25 作用域统计缓存 (facts 内容不可变, add 时失效即可), 避免每查询 O(N) 重算
    this._statsCache = new Map();
    // 可插拔 embedder (dense 语义检索, 默认 null = 纯 BM25); _embedCache 内存缓存不落盘
    this.embedder = null;
    this._embedCache = new Map();
    for (const fact of this.facts) this._indexFact(fact);
    this.save();
  }

  save() {
    writeJson(this.file, this.facts);
  }

  // 高斯衰减: score = score * exp(-lambda * t^2), t = days since last access
  _decay(score, days) {
    if (days <= 0) return score;
    const lambda = this.opts.decayPerDay * this.opts.forgetSpeed;
    return score * Math.exp(-lambda * days * days);
  }

  _nowDays() {
    return Date.now() / 86400000;
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

  add(content, { importance = this.opts.baseImportance, type = "general", source = "manual", dedupe = true, scope = null, meta = null, similarThreshold = 0 } = {}) {
    const norm = this._norm(content);
    if (!norm) return null;
    // 跨进程/多 agent 共享 dataDir 时的写保护: 锁内读-改-写, 防并发覆盖丢更新 (与 Experience 对称)
    // add 是唯一写入口, 锁内重读磁盘最新 facts (防基于过期内存操作), 操作后落盘
    return withFileLock(this.file, () => {
      // 锁内重读: 拿最新磁盘状态再操作 (多进程共享 dataDir 时不丢别的进程刚写入的事实)
      this.facts = readJson(this.file, []);
      this.rebuildIndex();
      const now = nowISO();
      if (dedupe) {
        // 内容去重: 归一化后相同 (含"记住："等前缀差异) 已存在则命中加分, 不新增
        const normKey = this._normKey(content);
        const existing = this.facts.find((f) => this._normKey(f.content) === normKey);
        if (existing) {
          existing.hits += 1;
          existing.lastAccess = now;
          existing.score += this.opts.hitBonus;
          this.save();
          return existing;
        }
        // 语义相似去重: similarThreshold>0 时, 与现有事实相似度达标则命中加分
        // 双保险: 先 Jaccard (模板类变体), 未命中再 overlap (词序变化大的松散变体)
        if (similarThreshold > 0) {
          const similar = this.findSimilar(norm, { threshold: similarThreshold, scope })
            || this.findSimilar(norm, { threshold: similarThreshold, scope, method: "overlap" });
          if (similar) {
            similar.hits += 1;
            similar.lastAccess = now;
            similar.score += this.opts.hitBonus;
            this.save();
            return similar;
          }
        }
      }
      const fact = {
        id: cryptoRandomId(),
        content: norm,
        type,
        source,
        importance,
        score: importance,
        created: now,
        lastAccess: now,
        hits: 0,
        scope,
        ...(meta ? { meta } : {}),
      };
      this.facts.push(fact);
      this._indexFact(fact);
      this._statsCache.clear(); // 新增事实 -> 作用域统计失效
      // 总量裁剪: 超 maxFacts 时删除最弱事实 (防记忆膨胀); 未裁剪时正常落盘
      const pruned = this._prune();
      if (!pruned) this.save();
      return fact;
    });
  }

  // L1 总量裁剪: 超 maxFacts 时, 按「衰减后有效分 × 重要性」排序, 删除最弱事实。
  // 补齐「衰减只在查询层生效、不删数据」的缺口 -> 这里做存储层硬清理。
  // 只在 add 新增时触发; 去重命中/加分(hit) 不增条数, 无需裁剪。
  _prune() {
    const max = this.opts.maxFacts;
    if (!max || max <= 0 || this.facts.length <= max) return 0;
    const nowD = this._nowDays();
    const scored = this.facts.map((f) => {
      const days = Math.max(0, nowD - new Date(f.lastAccess).getTime() / 86400000);
      const recency = Math.exp(-this.opts.decayPerDay * this.opts.forgetSpeed * days * days); // 0~1
      const imp = Math.min(f.importance || 0, 20) / 20; // 0~1
      return { id: f.id, key: (f.score * (0.4 + 0.6 * recency)) * (0.5 + 0.5 * imp) };
    });
    scored.sort((a, b) => b.key - a.key);
    const keep = new Set(scored.slice(0, max).map((x) => x.id));
    const before = this.facts.length;
    this.facts = this.facts.filter((f) => keep.has(f.id));
    this.rebuildIndex(); // 重建倒排索引 (内部已清 _statsCache)
    this.save();
    return before - this.facts.length;
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
  rebuildIndex() {
    this._index = new Map();
    this._statsCache.clear();
    for (const fact of this.facts) this._indexFact(fact);
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
  _jaccard(a, b) {
    const A = this._bigramSet(a);
    const B = this._bigramSet(b);
    if (!A.size || !B.size) return 0;
    let inter = 0;
    for (const t of A) if (B.has(t)) inter++;
    const union = A.size + B.size - inter;
    return union ? inter / union : 0;
  }

  // bigram overlap 系数 (0~1): 交集 / 较短集合, 对「词序变化但共享核心词」的松散同义改写更敏感
  // 比 Jaccard 更宽松: LLM 提炼变体词序/措辞大变时 Jaccard 可能 <0.6, 但核心词重合度高, overlap 能捕获
  _overlap(a, b) {
    const A = this._bigramSet(a);
    const B = this._bigramSet(b);
    if (!A.size || !B.size) return 0;
    let inter = 0;
    for (const t of A) if (B.has(t)) inter++;
    return inter / Math.min(A.size, B.size);
  }

  // 查找与给定内容最相似的现有事实 (相似度 >= threshold 才返回, 默认 null)
  // method: "jaccard" (默认) 或 "overlap" (词序变化容错)
  // 供 add(similarThreshold) / 提炼去重使用; 中文 bigram 变体通常 >0.6
  findSimilar(content, { threshold = 0.6, scope = null, method = "jaccard" } = {}) {
    const c = this._norm(content);
    if (!c) return null;
    const scoped = scope == null ? this.facts : this.facts.filter((f) => f.scope === scope);
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
  query(q, { limit = 5, minScore = 1, scope = null } = {}) {
    const nowD = this._nowDays();
    const ql = (q || "").toLowerCase();
    const qAll = this._bigramSet(ql);
    // scope 过滤基底 (检索隔离: 只查指定 scope 的事实)
    const scoped = scope == null ? this.facts : this.facts.filter((f) => f.scope === scope);
    // 空查询: 按衰减分返回全部 (保持旧行为, 供 memory-ticker 取 top facts)
    if (qAll.size === 0) {
      return scoped
        .map((f) => ({ ...f, effectiveScore: this._decay(f.score, Math.max(0, nowD - new Date(f.lastAccess).getTime() / 86400000)) }))
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
      const recency = Math.exp(-this.opts.decayPerDay * days * days); // 0~1, 越新越大
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
  queryMulti(queries, { limit = 5, scope = null, minScore = 1 } = {}) {
    const lists = [];
    for (const q of queries) {
      const r = this.query(q, { limit: Math.max(limit * 2, 10), scope, minScore });
      if (r.length) lists.push(r);
    }
    if (!lists.length) return [];
    if (lists.length === 1) return lists[0].slice(0, limit);
    return rrfFuse(lists).slice(0, limit);
  }

  // ---- 可插拔 embedder (dense 语义检索, 零依赖默认关闭) ----
  // 用户注入: ctx.consume("facts").setEmbedder(async (text) => number[])
  setEmbedder(fn) {
    this.embedder = typeof fn === "function" ? fn : null;
    this._embedCache.clear();
    return this;
  }

  async _embed(text) {
    if (!this.embedder) throw new Error("未配置 embedder");
    const v = await this.embedder(String(text));
    return Array.isArray(v) && v.length ? v : null;
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
  async querySemantic(q, { limit = 5, scope = null } = {}) {
    if (!this.embedder) return this.query(q, { limit, scope });
    const scoped = scope == null ? this.facts : this.facts.filter((f) => f.scope === scope);
    const qv = await this._embed(q).catch(() => null);
    if (!qv) return this.query(q, { limit, scope });
    // 懒加载每条事实的 embedding (内存缓存, 不落盘避免 facts.json 膨胀)
    const dense = [];
    for (const f of scoped) {
      let ev = this._embedCache.get(f.id);
      if (!ev) {
        try { ev = await this._embed(f.content); } catch { ev = null; }
        this._embedCache.set(f.id, ev);
      }
      if (ev) dense.push({ ...f, dense: this._cosine(qv, ev) });
    }
    dense.sort((a, b) => b.dense - a.dense);
    // dense 与 BM25 双路 RRF 融合
    const bm25 = this.query(q, { limit, scope });
    return rrfFuse([dense, bm25]).slice(0, limit);
  }

  hit(id) {
    return withFileLock(this.file, () => {
      this.facts = readJson(this.file, []);
      this.rebuildIndex();
      const f = this.facts.find((x) => x.id === id);
      if (!f) return;
      f.hits += 1;
      f.lastAccess = nowISO();
      f.score += this.opts.hitBonus;
      this.save();
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
    // 疑问/指令短句 (如 "现在几点", "文件在哪") → 临时查询, 不作长期事实
    if (clean.length <= 8 && /[?？]|几点|多少|什么|怎么|为什么|在哪|帮我|请|查一下/.test(clean)) return null;
    return this.add(clean, { source: "conversation" });
  }

  list() {
    return [...this.facts].sort((a, b) => b.score - a.score);
  }

  count() {
    return this.facts.length;
  }

  // 可观测: L1 原子记忆统计 (总量/来源分布/类型分布), 供 agent.stats() 聚合
  stats() {
    const bySource = {};
    const byType = {};
    for (const f of this.facts) {
      const s = f.source || "unknown";
      const t = f.type || "general";
      bySource[s] = (bySource[s] || 0) + 1;
      byType[t] = (byType[t] || 0) + 1;
    }
    return {
      total: this.facts.length,
      max_facts: this.opts.maxFacts || 0,
      by_source: bySource,
      by_type: byType,
    };
  }
}

function cryptoRandomId() {
  return "f_" + Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
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
// src/memory/fact-store-governance.js - FactStore 的治理与查询门面 (mixin, 从 fact-store.js 拆出)
// 职责: 软删/回滚/版本链 (forget/restore/update)、TTL 扫描与墓碑年龄回收入口 (sweepExpired)、
//   按层清空、导入导出、来源分级回灌 (backfillProvenance)、时效窗口治理 (setValidity)、
//   观测与列表 (stats/list/hit/addMemory)。
// 全部是挂回 FactStore.prototype 的方法, 对外接口不变。
// 依赖约束: 不得 import fact-store.js —— 否则与宿主成环 (数据模型常量取自 normalize 模块)。
import { withFileLock, nowISO } from "../utils/store.js";
import { scrubPII } from "../utils/pii.js";
import {
  resolveWriteTier, tierOfRecord, rankOf, canSupersede, normalizeTier, isQuarantined, stripTierTags,
  matchesTierSelector,
} from "./provenance.js";
import { cryptoRandomId, LAYER_L1, LAYER_L4 } from "./fact-store-normalize.js";

export const factStoreGovernanceMethods = {
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
  },

  // 列出时效窗口已过 (或未到) 的事实 (治理/体检用, 检索默认不可见)
  listOutOfWindow(scope = null) {
    return this._live(scope).filter((f) => !this._isCurrent(f));
  },

  // 去重命中时的跨 tier 规则 (add 的内容去重与语义相似去重共用; 调用方必须已持锁, 全同步):
  //   rank(写入) <  rank(存量) → 隔离带写入撞上一条可晋级记录: 只回"已存在", 不改 hits/score。
  //     否则反复抓取同一页就能抬高某条用户事实的检索分 —— 排序被外部内容影响是另一种注入,
  //     而且给了攻击者"这条确实写进去了"的可观测反馈。
  //   rank(写入) >= rank(存量) → 照旧加分; 严格更高时把记录**晋级** (用户后来亲口说过同一件事,
  //     来源就升回来了)。晋级只能向上 (canSupersede 已挡向下), 任何写入都不会把记录降级成 unknown。
  _onDedupeHit(existing, tier, now) {
    // hits/lastAccess = "这条事实又被观察到一次"的**遥测**, 与写入方权限无关, 恒记 (2026-10-10 修):
    //   原实现把整个函数体都挂在 canSupersede 闸下 —— 低权限来源 (如 extract) 命中高权限记录
    //   (如 user-stated) 时连 hits 都不加, "同一件事反复被提起"这个信号直接丢失, 检索排序失准。
    // 防操纵闸门只保留在**能改变排序/权威性**的两处: 加分与 provenance 变更 (低权限不得抬高别人)。
    existing.hits += 1;
    existing.lastAccess = now;
    if (canSupersede(tier, tierOfRecord(existing))) {
      existing.score += this.opts.hitBonus;
      if (rankOf(tier) > rankOf(tierOfRecord(existing))) existing.provenance = tier;
    }
    this._markMutated(existing);
    return existing;
  },

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
  },

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
  },

  list() {
    // 软删条目不出现在列表 (治理语义: 遗忘即不可见, 但数据仍在, 可 restore 回滚)
    return this._live().sort((a, b) => b.score - a.score);
  },

  count() {
    return this.facts.length;
  },

  // 有效条数 (排除软删)
  countLive() {
    return this._live().length;
  },

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
  },

  // ==================== 记忆治理 (承接自 ppx-v2 mem-store) ====================
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
  },

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
  },

  // 列出已软删的记忆 (供人工/审计复核)
  deletedList() {
    return this.facts.filter((f) => f.status === "deleted").sort((a, b) => String(b.deletedAt || "").localeCompare(String(a.deletedAt || "")));
  },

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
  },

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
  },

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
  },

  // 导出全量记忆 (含软删/归档, 供备份与迁移)
  exportAll({ includeDeleted = true } = {}) {
    const items = includeDeleted ? this.facts : this._live();
    return {
      version: 1,
      exportedAt: nowISO(),
      count: items.length,
      items: items.map((f) => ({ ...f })),
    };
  },

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
      // 2026-11-12 (审计 #6): 去重键改为 scope + 归一化内容, 且墓碑 (deleted/archived) 不挡内容去重 ——
      //   原实现只比内容: ① 同内容导入到另一 scope 被误判重复 (add() 允许, 导入却吞掉);
      //   ② 已被遗忘/归档的内容再次导入被静默跳过 (与 add() 跳过墓碑的语义相反, 遗忘无法回填)。
      //   墓碑行本身按 id 幂等 (重复导入同一份备份不产生平行墓碑), 与 add()/_findLiveByKey 同口径。
      const seenLive = new Set(this._live().map((f) => this._dedupeKey(f)));
      const tombIds = new Set(this.facts.filter((f) => f.status !== "active").map((f) => String(f.id)));
      const added = [];
      for (const it of items) {
        const factObj = this._normalizeFact(it);
        if (!factObj) { skipped++; continue; }
        if (factObj.status === "active") {
          const k = this._dedupeKey(factObj);
          if (seenLive.has(k)) { skipped++; continue; }
          seenLive.add(k);
        } else {
          const id = String(factObj.id);
          if (tombIds.has(id)) { skipped++; continue; }
          tombIds.add(id);
        }
        this.facts.push(factObj);
        imported++;
        added.push(factObj);
      }
      this.rebuildIndex();
      this._markMutated(...added);
      return { ok: true, mode, imported, skipped };
    });
  },

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
  },
};

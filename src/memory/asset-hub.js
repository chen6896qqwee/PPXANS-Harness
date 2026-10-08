// src/memory/asset-hub.js - 记忆资产中枢 (P3⑩)
// 吸收 TencentDB-Agent-Memory 的"记忆资产 (Memory Asset) / 装备 (Loadout)"设计思想 (仅思想, 无源码复制):
//   - 资产: 可管理的知识单元 (文档库 / 技能 / 经验), 有 owner / visibility / 版本 / 用途计数
//   - 装备 (loadout): 绑定到某 agent 的资产集合, 检索时只注入已装备的资产
//   - 检索隔离: 私有资产仅 owner 可检索; 团队资产共享 (简化: 全局可见)
// 皮皮虾自研实现, 构建在现有 facts (带 scope) 之上: 资产 = 一组带 scope 的 facts + 元数据登记。
// 纯代码可测, 无 LLM。
import path from "node:path";
import fs from "node:fs";
import { ensureDir, readJsonGuarded, writeJson, withFileLock } from "../utils/store.js";
import { warn } from "../utils/logger.js";
import { shortId } from "../utils/id.js";

export const VISIBILITY = { PRIVATE: "private", TEAM: "team" };

// 规范化可见性输入: "team"/"TEAM"/VISIBILITY.TEAM 都归一到 "team"; 其余默认 private
function normalizeVisibility(v) {
  const s = String(v || "").toLowerCase();
  return s === VISIBILITY.TEAM ? VISIBILITY.TEAM : VISIBILITY.PRIVATE;
}

export class AssetHub {
  constructor(dataDir) {
    this.dir = path.join(dataDir, "memory", "assets");
    ensureDir(this.dir);
    this.file = path.join(this.dir, "registry.json");
    // 2026-10-04 (F3): 与 SceneStore/FactStore 同口径 —— 损坏文件原地保留并打标记,
    //   第一次写盘前改名 .corrupt-<ts> 留档 (旧实现"解析失败→空数组→全量覆盖"会抹掉资产登记)。
    const guarded = readJsonGuarded(this.file, []);
    this._assets = Array.isArray(guarded.data) ? guarded.data : [];
    this._corruptPending = guarded.parseFailed;
  }

  // 锁内重读用的磁盘态读取 (调用方必须已持有文件锁)
  _load() {
    const d = readJsonGuarded(this.file, []);
    if (d.parseFailed) this._corruptPending = true;
    return Array.isArray(d.data) ? d.data : [];
  }

  // 磁盘态 ∪ 内存态 (按 id 取并集, 同 id 取 updatedAt 较新的一份; **平局时磁盘胜出**)
  // 为什么必须合并: registry.json 由 CLI + Web 服务共用, "读一次 + 全量重写" 会把
  //   别的进程刚登记的资产整段抹掉 (与 episodes.json 同一类丢数据缺陷, 见 F3)。
  // 平局给磁盘的原因: 本进程是全量原子写, 盘上不会落后于自己的内存态;
  //   内存里同 updatedAt 而内容不同 = 别的进程同一毫秒内改过同一条 (equip 的 uses++),
  //   此时内存胜出就会丢增量计数。
  static mergeAssets(disk, mem) {
    const byId = new Map();
    const put = (a) => {
      if (!a || !a.id) return;
      const cur = byId.get(a.id);
      byId.set(a.id, !cur || Number(a.updatedAt || 0) > Number(cur.updatedAt || 0) ? a : cur);
    };
    for (const a of Array.isArray(disk) ? disk : []) put(a);
    for (const a of Array.isArray(mem) ? mem : []) put(a); // 内存后入 = 本进程变更优先
    return [...byId.values()];
  }

  // 纯写盘 (调用方必须已持有文件锁)。临界区全同步 (reload → merge → write, 不 await),
  // 因为 withFileLock 的 fn 一旦 await 就会提前释放锁 (utils/store.js 已知缺陷)。
  _writeLocked() {
    if (this._corruptPending) {
      try {
        fs.renameSync(this.file, `${this.file}.corrupt-${new Date().toISOString().replace(/[:.]/g, "")}`);
      } catch (e) { warn(`[memory/asset-hub] 损坏文件留档失败 (照常写盘): ${e && e.message ? e.message : e}`); }
      this._corruptPending = false;
    }
    writeJson(this.file, this._assets);
  }

  // 整体落盘 (锁内先并入磁盘最新态) —— 兼容旧调用点
  _save() {
    try {
      withFileLock(this.file, () => {
        this._assets = AssetHub.mergeAssets(this._load(), this._assets);
        this._writeLocked();
      });
    } catch (e) {
      warn(`[memory/asset-hub] 资产登记写盘失败 (内存态保留, 不阻断调用方): ${e && e.message ? e.message : e}`);
    }
  }

  // 登记一个资产 (关联到 facts scope)
  // { name, kind: 'document'|'skill'|'experience', scope, owner, visibility, source, description }
  register(asset) {
    if (!asset || !asset.name) throw new Error("资产需 name");
    const id = shortId("as", 5);
    const a = {
      id,
      name: asset.name,
      kind: asset.kind || "document",
      scope: asset.scope || null,
      owner: asset.owner || "local",
      // 规范化可见性: 接受 team/private 或 TEAM/PRIVATE
      visibility: normalizeVisibility(asset.visibility),
      source: asset.source || null,
      description: String(asset.description || "").slice(0, 200),
      version: 1,
      uses: 0,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    // 读-改-写全在锁内 (F3)
    try {
      return withFileLock(this.file, () => {
        this._assets = AssetHub.mergeAssets(this._load(), [...this._assets, a]);
        this._writeLocked();
        return a;
      });
    } catch (e) {
      warn(`[memory/asset-hub] 资产登记写入失败, 本次登记未落盘: ${e && e.message ? e.message : e}`);
      return a;
    }
  }

  // 删除资产 (软删: 标记 deleted, 数据保留可恢复)
  remove(id) {
    return this._mutate(id, (a) => {
      a.deleted = true;
      a.deletedAt = Date.now();
    });
  }

  restore(id) {
    return this._mutate(id, (a) => {
      a.deleted = false;
      delete a.deletedAt;
    }, { require: (a) => !!a.deleted });
  }

  // 装备: 把资产绑定到 agent (recorded in uses), 返回可用资产列表
  equip(id, { by = "local" } = {}) {
    let out = null;
    try {
      withFileLock(this.file, () => {
        this._assets = AssetHub.mergeAssets(this._load(), this._assets);
        const a = this._assets.find((x) => x.id === id && !x.deleted);
        if (!a) return;
        a.uses++;
        a.updatedAt = Date.now();
        this._writeLocked();
        out = a;
      });
    } catch (e) {
      warn(`[memory/asset-hub] 装备写入失败 (uses 未落盘): ${e && e.message ? e.message : e}`);
    }
    return out;
  }

  // 单条资产的读-改-写 (锁内重读 → 按 id 命中 → 变更 → 原子写); 命中不到返回 false
  _mutate(id, apply, { require = null } = {}) {
    let ok = false;
    try {
      withFileLock(this.file, () => {
        this._assets = AssetHub.mergeAssets(this._load(), this._assets);
        const a = this._assets.find((x) => x.id === id && (!require || require(x)));
        if (!a) return;
        apply(a);
        a.updatedAt = Date.now();
        this._writeLocked();
        ok = true;
      });
    } catch (e) {
      warn(`[memory/asset-hub] 资产变更写入失败 (id=${id}): ${e && e.message ? e.message : e}`);
    }
    return ok;
  }

  // 只读刷新 (F3): 读路径先看一眼盘, 别的进程登记的资产不该对本进程永久隐形。
  // 不需要锁: atomicWrite = 临时文件 + rename, 读到的必是完整的旧版或新版。
  _refresh() {
    try {
      this._assets = AssetHub.mergeAssets(this._load(), this._assets);
    } catch (e) {
      warn(`[memory/asset-hub] 读盘刷新失败 (沿用内存态): ${e && e.message ? e.message : e}`);
    }
    return this._assets;
  }

  // 列出资产 (按可见性过滤; deleted 默认隐藏)
  list({ includeDeleted = false, kind = null, visibility = null } = {}) {
    return this._refresh().filter((a) => {
      if (!includeDeleted && a.deleted) return false;
      if (kind && a.kind !== kind) return false;
      if (visibility && a.visibility !== visibility) return false;
      return true;
    });
  }

  get(id) { return this._refresh().find((x) => x.id === id) || null; }

  // 检索某 agent 可用的资产 (装备过的 + 团队可见), 供注入上下文
  availableFor({ owner = "local" } = {}) {
    return this._refresh().filter((a) => !a.deleted && (a.owner === owner || a.visibility === VISIBILITY.TEAM));
  }

  // 统计
  stats() {
    const active = this._refresh().filter((a) => !a.deleted);
    return {
      total: this._assets.length,
      active: active.length,
      byKind: active.reduce((m, a) => { m[a.kind] = (m[a.kind] || 0) + 1; return m; }, {}),
      byVisibility: active.reduce((m, a) => { m[a.visibility] = (m[a.visibility] || 0) + 1; return m; }, {}),
      totalUses: active.reduce((s, a) => s + a.uses, 0),
    };
  }

  // 渲染资产清单 (注入上下文用, 空则空串)
  renderAvailable({ owner = "local" } = {}) {
    const list = this.availableFor({ owner });
    if (!list.length) return "";
    return `\n# 记忆资产 (可装备)\n` + list.map((a) => `- [${a.kind}] ${a.name}${a.description ? ` — ${a.description}` : ""} (${a.scope ? "scope:" + a.scope : "无scope"})`).join("\n") + "\n";
  }
}

export default AssetHub;

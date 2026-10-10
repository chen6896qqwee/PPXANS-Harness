// src/memory/asset-hub.js - 记忆资产中枢 (P3⑩)
// 吸收 TencentDB-Agent-Memory 的"记忆资产 (Memory Asset) / 装备 (Loadout)"设计思想 (仅思想, 无源码复制):
//   - 资产: 可管理的知识单元 (文档库 / 技能 / 经验), 有 owner / visibility / 版本 / 用途计数
//   - 装备 (loadout): 绑定到某 agent 的资产集合, 检索时只注入已装备的资产
//   - 检索隔离: 私有资产仅 owner 可检索; 团队资产共享 (简化: 全局可见)
// 皮皮虾自研实现, 构建在现有 facts (带 scope) 之上: 资产 = 一组带 scope 的 facts + 元数据登记。
// 纯代码可测, 无 LLM。
import path from "node:path";
import { ensureDir, readJson, mutateJsonCollection, withFileLock, unionById } from "../utils/store.js";
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
    this._assets = this._load();
  }

  _load() {
    // 构造期只读不写 (仅实例化不得产生磁盘副作用)
    const d = readJson(this.file, null);
    return Array.isArray(d) ? d : [];
  }

  // 带锁的读-改-写 (2026-10-10 修复 F3): 与病历库同一根因 ——
  //   CLI/Web 共写同一 registry.json, 旧的"构造读一次 + 全量重写"会让后写者覆盖对手登记。
  //   mutateJsonCollection 保证: 取锁 → 锁内重读磁盘 → 与内存态按 id 并集 → 原子全量写。
  _mutate(fn) {
    const r = mutateJsonCollection(
      this.file,
      () => [],
      (disk) => fn(disk) || disk,
      { warnTag: "asset-hub", memory: this._assets },
    );
    this._assets = r.data;
    return r;
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
    this._mutate((disk) => {
      disk.push(a);
      return disk;
    });
    return a;
  }

  // 删除资产 (软删: 标记 deleted, 数据保留可恢复)
  remove(id) {
    let found = false;
    this._mutate((disk) => {
      const a = disk.find((x) => x.id === id);
      if (!a) return disk;
      a.deleted = true;
      a.deletedAt = Date.now();
      found = true;
      return disk;
    });
    return found;
  }

  restore(id) {
    let found = false;
    this._mutate((disk) => {
      const a = disk.find((x) => x.id === id && x.deleted);
      if (!a) return disk;
      a.deleted = false;
      delete a.deletedAt;
      found = true;
      return disk;
    });
    return found;
  }

  // 装备: 把资产绑定到 agent (recorded in uses), 返回可用资产列表
  equip(id, { by = "local" } = {}) {
    let out = null;
    this._mutate((disk) => {
      const a = disk.find((x) => x.id === id && !x.deleted);
      if (!a) return disk;
      // 增量语义: 在**盘上最新那条**上自增, 而不是用内存里的旧计数盖回
      a.uses = (a.uses || 0) + 1;
      a.updatedAt = Date.now();
      out = a;
      return disk;
    });
    return out;
  }

  // 读前对齐 (2026-10-10): 另一实例/进程可能已写盘, 内存快照可能落后。
  //   list/get/stats/availableFor 前先在锁内重读并入, 保证"另一实例的登记对本实例可见"。
  _reload() {
    try {
      withFileLock(this.file, () => {
        const g = readJson(this.file, null);
        const disk = Array.isArray(g) ? g : [];
        this._assets = unionById(disk, this._assets);
      });
    } catch {
      // 锁竞争超时不阻断读 (读不写盘, 退化用内存快照)
    }
    return this._assets;
  }

  // 列出资产 (按可见性过滤; deleted 默认隐藏)
  list({ includeDeleted = false, kind = null, visibility = null } = {}) {
    this._reload();
    return this._assets.filter((a) => {
      if (!includeDeleted && a.deleted) return false;
      if (kind && a.kind !== kind) return false;
      if (visibility && a.visibility !== visibility) return false;
      return true;
    });
  }

  get(id) { this._reload(); return this._assets.find((x) => x.id === id) || null; }

  // 检索某 agent 可用的资产 (装备过的 + 团队可见), 供注入上下文
  availableFor({ owner = "local" } = {}) {
    this._reload();
    return this._assets.filter((a) => !a.deleted && (a.owner === owner || a.visibility === VISIBILITY.TEAM));
  }

  // 统计
  stats() {
    this._reload();
    const active = this._assets.filter((a) => !a.deleted);
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

// src/memory/asset-hub.js - 记忆资产中枢 (P3⑩)
// 吸收 TencentDB-Agent-Memory 的"记忆资产 (Memory Asset) / 装备 (Loadout)"设计思想 (仅思想, 无源码复制):
//   - 资产: 可管理的知识单元 (文档库 / 技能 / 经验), 有 owner / visibility / 版本 / 用途计数
//   - 装备 (loadout): 绑定到某 agent 的资产集合, 检索时只注入已装备的资产
//   - 检索隔离: 私有资产仅 owner 可检索; 团队资产共享 (简化: 全局可见)
// 皮皮虾自研实现, 构建在现有 facts (带 scope) 之上: 资产 = 一组带 scope 的 facts + 元数据登记。
// 纯代码可测, 无 LLM。
import path from "node:path";
import { ensureDir, readJson, writeJson } from "../utils/store.js";
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
    const d = readJson(this.file, null);
    return Array.isArray(d) ? d : [];
  }

  _save() { writeJson(this.file, this._assets); }

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
    this._assets.push(a);
    this._save();
    return a;
  }

  // 删除资产 (软删: 标记 deleted, 数据保留可恢复)
  remove(id) {
    const a = this._assets.find((x) => x.id === id);
    if (!a) return false;
    a.deleted = true;
    a.deletedAt = Date.now();
    this._save();
    return true;
  }

  restore(id) {
    const a = this._assets.find((x) => x.id === id && x.deleted);
    if (!a) return false;
    a.deleted = false;
    delete a.deletedAt;
    this._save();
    return true;
  }

  // 装备: 把资产绑定到 agent (recorded in uses), 返回可用资产列表
  equip(id, { by = "local" } = {}) {
    const a = this._assets.find((x) => x.id === id && !x.deleted);
    if (!a) return null;
    a.uses++;
    a.updatedAt = Date.now();
    this._save();
    return a;
  }

  // 列出资产 (按可见性过滤; deleted 默认隐藏)
  list({ includeDeleted = false, kind = null, visibility = null } = {}) {
    return this._assets.filter((a) => {
      if (!includeDeleted && a.deleted) return false;
      if (kind && a.kind !== kind) return false;
      if (visibility && a.visibility !== visibility) return false;
      return true;
    });
  }

  get(id) { return this._assets.find((x) => x.id === id) || null; }

  // 检索某 agent 可用的资产 (装备过的 + 团队可见), 供注入上下文
  availableFor({ owner = "local" } = {}) {
    return this._assets.filter((a) => !a.deleted && (a.owner === owner || a.visibility === VISIBILITY.TEAM));
  }

  // 统计
  stats() {
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

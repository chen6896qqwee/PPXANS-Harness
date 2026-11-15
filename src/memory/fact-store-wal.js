// src/memory/fact-store-wal.js - FactStore 的落盘/重读/WAL 增量 (mixin, 从 fact-store.js 拆出)
// 职责: 全量落盘 (save/flush)、锁内重读 (_reload, 磁盘签名跳读)、磁盘签名、
//   WAL 增量追加与阈值 compact、崩溃重放 (_replayWal/_applyWalTo)。
// 全部是挂回 FactStore.prototype 的方法, 对外接口不变。
// 依赖约束: 只允许 import utils/* 与常量层, 不得 import fact-store.js —— 否则与宿主成环。
import fs from "node:fs";
import { readJson, writeJson, withFileLock } from "../utils/store.js";
import { writeSchema } from "../utils/schema.js";
import { appendWal, readWal, truncateWal, walSizeBytes } from "../utils/wal.js";
import { tierOfRecord } from "./provenance.js";
// facts.json 当前 schema 版本 (纯数组基线 = 1); 未来数据结构变更时 +1 并注册迁移 (见 src/utils/schema.js)
export const FACTS_SCHEMA_VERSION = 1;

// 文件时间戳粒度 (Windows NTFS 约 16ms, FAT 可达 2s): 同一 tick 内两次同大小写入的
//   mtimeNs 完全相同。签名相等只在戳已落定 (距今超过该窗口) 时才可作为"未变"的证据。
const SIG_SETTLE_MS = 250;

export const factStoreWalMethods = {
  // 全量落盘。非 WAL 模式: 直接原子写 (兼容旧行为, 调用方通常在锁内)。
  // WAL 模式: 加锁 flush (全量写 + 清 WAL), 与追加互斥防丢事件。
  save() {
    if (!this.wal) {
      writeJson(this.file, this.facts);
      writeSchema(this.file, "facts", FACTS_SCHEMA_VERSION);
      // 写盘后刷新磁盘签名 (2026-10-30, L2): 否则下一次 _reload 会把"自己的写"误判成
      //   "磁盘变了"而白读一遍 —— 优化就退化回原样。
      const d = this._diskSignature();
      this._diskSig = d ? d.sig : null;
      return;
    }
    this.flush();
  },

  // 公开 flush: 加锁全量落盘 + 清 WAL (外部显式落盘点)
  flush() {
    withFileLock(this.file, () => this._flushLocked());
  },

  // 锁内重读最新状态。WAL 模式下磁盘快照滞后, 必须重放 WAL 增量才是完整状态
  // (非 WAL 模式: 每次变更已落盘, 磁盘即最新, 保持旧行为)
  _reload() {
    // 2026-10-30 (L2): 先看磁盘签名, 没变就不重读 —— 锁内串行已保证"读到的是最新",
    //   而同进程刚写完时内存就是那份内容, 再解析一遍 185KB JSON + 全量重建索引纯属浪费。
    //   实测: 260 条库、20 会话 60 请求, 跳过这一步省 7%; 与去重索引合计省 40%+。
    //   安全性 (2026-10-31 修): mtimeNs+size 并不足以判定"未变" —— Windows NTFS 的时间戳
    //   粒度约 16ms, 同一 tick 内的两次同大小写入签名完全相同 (实测 10 次里 2 次误判)。
    //   现在: 应用写入靠 ino 变化识别 (每次 rename 换 inode), 原地手改靠"戳未落定就重读"兜住。
    const cur = this._diskSignature();
    if (cur && cur.sig === this._diskSig && Date.now() - cur.mtimeMs > SIG_SETTLE_MS) return this.facts;
    this.facts = readJson(this.file, []);
    if (this.wal) this.facts = this._applyWalTo(this.facts);
    // 来源分级: 磁盘/他进程写来的行可能没 provenance 字段 (旧版本写入或外部手改),
    //   每次重读就地补齐 —— 让 add/forget/update/_prune 的判定永远读到一个已归一化的闭集值,
    //   而不是在若干处各写一遍回退逻辑。纯内存补齐, 不额外写盘 (落盘由调用方的变更顺带完成)。
    this._stampProvenance();
    this.rebuildIndex();
    this._diskSig = cur ? cur.sig : null;
    return this.facts;
  },

  // 当前磁盘签名 (ino + mtimeNs + size + WAL 同名签名)。文件不存在 → null (= 必须重读)。
  // ino 是关键: writeJson 走「临时文件 + rename」, 每次应用内写入都会换 inode, 即使落在
  //   同一时间戳 tick、字节数也相同也能识别; 原地手改则由 mtimeMs 落定窗口兜住。
  // 返回 mtimeMs 供 _reload 判断戳是否落定 (见 SIG_SETTLE_MS)。
  _diskSignature() {
    try {
      const st = fs.statSync(this.file, { bigint: true });
      let sig = String(st.ino) + ":" + String(st.mtimeNs) + ":" + String(st.size);
      if (this.wal) {
        try {
          const ws = fs.statSync(this.walFile, { bigint: true });
          sig += "|" + String(ws.ino) + ":" + String(ws.mtimeNs) + ":" + String(ws.size);
        } catch { sig += "|0:0:0"; /* swallowed-ok(2026-11-03): WAL 附属文件不存在 → 零签名 */ }
      }
      return { sig, mtimeMs: Number(st.mtimeNs) / 1e6 };
    } catch { return null; /* swallowed-ok(2026-11-03): 文件不存在 → null 强制重读 */ }
  },

  // 给缺 provenance 字段的行按 source 登记表补上 tier (幂等, 全同步)
  _stampProvenance() {
    let n = 0;
    for (const f of this.facts) {
      const t = tierOfRecord(f);
      if (f.provenance !== t) { f.provenance = t; n++; }
    }
    return n;
  },

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
  },

  // 锁内全量落盘 (调用方必须已持有文件锁)。
  // 非 WAL 模式: 内存即真相, 直接原子写 (每次变更已落盘, 无滞后快照可合并)。
  // WAL 模式: 合并磁盘快照+WAL+内存 (内存优先) 后原子写 + 清 WAL, 防丢其他进程的增量事件。
  _flushLocked() {
    if (!this.wal) {
      writeJson(this.file, this.facts);
      writeSchema(this.file, "facts", FACTS_SCHEMA_VERSION);
      const d = this._diskSignature(); // 与 save() 同款: 写后刷新签名, 免得下次白读
      this._diskSig = d ? d.sig : null;
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
    const d = this._diskSignature();
    this._diskSig = d ? d.sig : null;
  },

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
  },

  _change(evt) {
    if (!this.wal) { this._flushLocked(); return; }
    this._walAppend(evt);
  },

  // upsert 变体 (携带完整对象快照, 重放幂等)
  _markMutated(...facts) {
    if (!this.wal) { this._flushLocked(); return; }
    for (const f of facts) this._walAppend({ op: "upsert", fact: f }, 1);
  },

  // remove 变体 (批量删除 id)
  _markRemoved(ids) {
    if (!this.wal) { this._flushLocked(); return; }
    this._walAppend({ op: "remove", ids });
  },

  // replace 变体 (整体替换, 供 importAll replace)
  _markReplace(facts) {
    if (!this.wal) { this._flushLocked(); return; }
    this._walAppend({ op: "replace", facts });
  },

  // 启动重放: WAL 增量按序应用到内存 (幂等); 磁盘落盘由构造末尾 save() 统一完成
  _replayWal() {
    this.facts = this._applyWalTo(this.facts);
    this.rebuildIndex();
    this._walPending = 0;
  },
};

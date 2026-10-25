// src/memory/l2.js - L2 场景记忆 (腾讯风格 scene extraction)
// 把相关记忆归档成场景: { name, keywords, facts[], lastUpdated }
// 零依赖: 用关键词聚类 + 时间窗聚合
import path from "node:path";
import fs from "node:fs";
import { ensureDir, readJson, readJsonGuarded, writeJson, logicalDay, withFileLock } from "../utils/store.js";
import { migrateData, writeSchema } from "../utils/schema.js";
import { shortId } from "../utils/id.js";

// scenes.json 当前 schema 版本 (纯数组基线 = 1); 未来数据结构变更时 +1 并注册迁移
export const SCENES_SCHEMA_VERSION = 1;

// 中文简单分词: 提取有意义的词 (2字以上连续片段 + 已知高频概念)
const STOP = new Set(["这个","那个","我们","你们","他们","什么","怎么","可以","一个","就是","知道","没有","如果","因为","所以","但是","然后","现在","今天","昨天","明天","已经","还有","所有","这样","那样","自己","的时候","一下","一点","一些","这些","那些","东西","事情","问题","觉得","应该","需要","开始","继续","大家","真的","只是","可能","不是","都是","一直","非常","其实","最后","主要","联系","关系"]);

function tokenize(text) {
  const clean = String(text || "").replace(/[^\u4e00-\u9fa5a-zA-Z0-9]/g, " ");
  const words = clean.split(/\s+/).filter(Boolean);
  const cjk = clean.match(/[\u4e00-\u9fa5]{2,4}/g) || [];
  return [...new Set([...words, ...cjk.map((w) => w.toLowerCase())].filter((w) => !STOP.has(w) && w.length >= 2))];
}

// 同一场景的两个版本合并 (磁盘 vs 内存): facts 按 id/内容去重保序并保留最近 50 条,
// keywords 取并集 (上限 30), 其余标量字段以 lastUpdated 较新的那份为准。
function mergeOne(a, b) {
  const facts = [];
  const seen = new Set();
  for (const f of [...(a.facts || []), ...(b.facts || [])]) {
    const key = f && (f.id || f.content);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    facts.push(f);
  }
  const newer = String(a.lastUpdated || "") >= String(b.lastUpdated || "") ? a : b;
  return {
    ...newer,
    facts: facts.slice(-50),
    keywords: [...new Set([...(a.keywords || []), ...(b.keywords || [])])].slice(-30),
  };
}

// F8 (2026-10-04): 无 id 场景的**内容签名** —— 只取 name + facts 的 id/内容, 刻意不含 keywords /
//   description 等会被规范化改写的字段, 保证"同一条 v1 场景"在原始形态与规范化形态下签名一致。
function sceneSig(s) {
  const facts = Array.isArray(s && s.facts)
    ? s.facts.map((f) => (f && (f.id || f.content)) || "").join(",")
    : "";
  return `${String((s && s.name) || "")}|${facts}`;
}

// FNV-1a 32-bit → 定长 7 位 base36 (恒 [0-9a-z]{7})。选内容哈希而非随机短号的原因:
//   两个进程各自给同一条无 id 场景补号必须**一致**, 否则"按 id 取并集"会把一条场景裂成两条
//   (随机号只是把丢更新换成了丢重复)。
function fnv1a(str) {
  let h = 0x811c9dc5;
  const s = String(str);
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}
function derivedSceneId(sig) {
  return "s_h" + fnv1a(sig).toString(36).padStart(7, "0");
}

export class SceneStore {
  constructor(dataDir) {
    this.dir = path.join(dataDir, "memory", "l2");
    ensureDir(this.dir);
    this.file = path.join(this.dir, "scenes.json");
    // 2026-10-04: 与 FactStore 同口径改用 readJsonGuarded。旧实现用 readJson,
    //   scenes.json 一旦损坏 (半截写/断电) 就静默退化成空数组, 而随后的任何一次写盘
    //   会把空状态整体覆盖回文件 —— 现场消失, 旧场景永久丢失。
    //   现在损坏时先读成空态但打 _corruptPending 标记, 第一次写盘前把损坏文件改名
    //   .corrupt-<ts> 留档 (healer 的体检清单不含本文件, 只能自己保现场)。
    const guarded = readJsonGuarded(this.file, []);
    this.scenes = Array.isArray(guarded.data) ? guarded.data : [];
    this._corruptPending = guarded.parseFailed;
    // schema 版本迁移 (旁挂 .schema 文件; 数据文件保持纯数组)
    const mig = migrateData({
      file: this.file,
      name: "scenes",
      data: this.scenes,
      currentVersion: SCENES_SCHEMA_VERSION,
    });
    this.scenes = Array.isArray(mig.data) ? mig.data : [];
    // F8 一次性迁移 (2026-10-04): SCENES_SCHEMA_VERSION=1 的"纯数组"基线里从没补过 id,
    //   旧 mergeScenes 直接把无 id 场景跳过 —— 一次普通 assign() 之后, 它连同承载的 facts
    //   就从 scenes.json 消失。构造期补号并落盘; 常态 (全部有 id) 一个字节都不写。
    if (this.scenes.some((s) => !s || !s.id)) {
      try { this._save(); } catch { /* 落盘失败不阻断构造, 下次真实写入会再迁移 */ }
    }
  }

  // 磁盘态与内存态合并 (按 id 取并集): 军团多进程共享 dataDir 时,
  // 锁外基于过期内存做增删再整体写盘会覆盖掉别的进程已落盘的场景 (丢更新)。
  // F8 (2026-10-04): 无 id 场景不再被静默跳过 —— 确定性补号 (s_h + 内容哈希) 后再并集。
  //   同内容 ⟹ 同签名 ⟹ 同号 ⟹ 并成一条 (不裂); 仅"真撞号且异内容"才加 _2 后缀消歧。
  static mergeScenes(disk, mem) {
    const byId = new Map();
    const sigToId = new Map(); // 内容签名 -> 补号 (保证同内容拿到同一个号)
    const put = (raw) => {
      if (!raw || typeof raw !== "object") return;
      let id;
      if (raw.id) {
        // 显式 id = 它就是那条场景 (磁盘/内存两个版本): 永远合并, 绝不因内容差异加后缀。
        //   (内存里的副本可能比磁盘旧 —— 补号后磁盘被别的进程追加了 facts, 签名就会不同;
        //    此时若照加后缀, 同一条场景会裂成 id 与 id_2 两条。)
        id = String(raw.id);
      } else {
        const sig = sceneSig(raw);
        id = sigToId.get(sig) || derivedSceneId(sig);
        // 真撞号: 该补号已被**异内容**场景占用 → 后来者加后缀消歧 (不并掉任何一条)。
        if (byId.has(id) && sceneSig(byId.get(id)) !== sig) {
          let n = 2;
          while (byId.has(id + "_" + n)) n++;
          id = id + "_" + n;
        }
        sigToId.set(sig, id); // 同内容重复喂入 → 都落到同一个 (可能是加过后缀的) 号
      }
      const cur = byId.get(id);
      const merged = cur ? mergeOne(cur, raw) : {
        ...raw,
        facts: Array.isArray(raw.facts) ? [...raw.facts] : [],
        keywords: Array.isArray(raw.keywords) ? [...raw.keywords] : [],
      };
      merged.id = id; // mergeOne 可能以无 id 的 raw 那份为准, 补号必须落在结果上
      byId.set(id, merged);
    };
    for (const s of disk || []) put(s);
    for (const s of mem || []) put(s);   // 内存后入 = 本进程变更优先
    return [...byId.values()];
  }

  // 锁内重读: 拿磁盘最新态 + 合并内存未落盘变更
  _reload() {
    this.scenes = SceneStore.mergeScenes(readJson(this.file, []), this.scenes);
    return this.scenes;
  }

  // 关键词命中数最高的场景。命中数 0 不会成为候选, 故返回的 scene 非空 ⟺ 至少命中 1 个关键词。
  _bestScene(tokens) {
    let best = null, bestScore = 0;
    for (const s of this.scenes) {
      let score = 0;
      for (const t of tokens) if ((s.keywords || []).includes(t)) score++;
      if (score > bestScore) { bestScore = score; best = s; }
    }
    return { scene: best, score: bestScore };
  }

  // 把一条事实归入最匹配的场景 (或新建)
  // 2026-10-04: 整个"读-改-写"移进文件锁内。旧实现先在锁外基于内存里的旧场景做归并,
  //   锁内只写盘 —— 另一个进程刚写过的场景这边看不到, 新建重复场景 / 覆盖对方更新 (丢更新)。
  assign(fact) {
    const tokens = tokenize(fact.content);
    if (!tokens.length) return null;

    return withFileLock(this.file, () => {
      this._reload();
      let best = this._bestScene(tokens).scene;

      if (best) {
        if (!Array.isArray(best.facts)) best.facts = [];
        if (!Array.isArray(best.keywords)) best.keywords = [];
        if (!best.facts.some((x) => x && x.id === fact.id)) {
          best.facts.push({ id: fact.id, content: fact.content, ts: fact.created });
        }
        if (best.facts.length > 50) best.facts = best.facts.slice(-50);
        best.lastUpdated = logicalDay();
        // 合并新关键词
        for (const t of tokens) if (!best.keywords.includes(t)) best.keywords.push(t);
        if (best.keywords.length > 30) best.keywords = best.keywords.slice(-30);
      } else {
        best = {
          id: shortId("s_", 8),
          name: tokens.slice(0, 3).join("·"),
          keywords: tokens.slice(0, 10),
          facts: [{ id: fact.id, content: fact.content, ts: fact.created }],
          mode: "auto",
          description: tokens.slice(1, 4).join("、") || "自动场景",
          canHelp: "基于该话题的对话与记忆提供帮助",
          created: logicalDay(),
          lastUpdated: logicalDay(),
        };
        this.scenes.push(best);
      }
      this._writeLocked();
      return best;
    });
  }

  // 手动创建场景 (用户设定人设/能力, 类似灵魂文件)
  create({ name, description, canHelp, keywords = [] }) {
    const scene = {
      id: shortId("s_", 8),
      name: String(name || "").slice(0, 50),
      keywords: keywords.slice(0, 15),
      facts: [],
      mode: "manual",
      description: String(description || "").slice(0, 300),
      canHelp: String(canHelp || "").slice(0, 300),
      created: logicalDay(),
      lastUpdated: logicalDay(),
    };
    return withFileLock(this.file, () => {
      this._reload();
      this.scenes.push(scene);
      this._writeLocked();
      return scene;
    });
  }

  // 列出所有场景 (含介绍)
  listWithDesc() {
    return this.scenes.map((s) => ({
      id: s.id, name: s.name, mode: s.mode || "auto",
      description: s.description || "", canHelp: s.canHelp || "",
      facts: (s.facts || []).length, lastUpdated: s.lastUpdated,
    }));
  }

  // 按文本匹配激活场景 (关键词命中)
  findMatch(text) {
    const tokens = tokenize(text);
    if (!tokens.length) return null;
    return this._bestScene(tokens).scene;
  }

  // 激活场景的上下文块 (人设 + 能力)
  activeContext(text) {
    const s = this.findMatch(text);
    if (!s) return "";
    return [
      `【当前场景:${s.name}】`,
      s.description ? `场景介绍: ${s.description}` : "",
      s.canHelp ? `你可以帮用户: ${s.canHelp}` : "",
      s.mode === "manual" ? "(用户手动设定, 请遵循此场景行为)" : "",
    ].filter(Boolean).join("\n");
  }  // 按记忆 id 找回场景
  findByFactId(id) {
    return this.scenes.find((s) => s.facts.some((f) => f.id === id));
  }

  context(limit = 5) {
    return this.scenes.slice(-limit).map((s) =>
      `【场景:${s.name}】\n${s.facts.slice(-5).map((f) => `  - ${f.content}`).join("\n")}`
    ).join("\n");
  }

  count() { return this.scenes.length; }

  // v1.0.9: _save 加锁 (create/scene_describe 等写盘路径)
  // 2026-10-04: 锁内先合并磁盘最新态再整体写 (内存为本进程真相, 但不丢别人新增的场景)
  _save() {
    withFileLock(this.file, () => {
      this._reload();
      this._writeLocked();
    });
  }

  // 纯写盘 (调用方必须已持有文件锁)
  _writeLocked() {
    // 损坏现场保护 (2026-10-04): healer 的体检清单不含 memory/l2/scenes.json,
    // 若不先留档, "解析失败 -> 空数组 -> 第一次写盘" 就把旧场景永久抹掉。
    // 这里在覆盖前把损坏文件改名 .corrupt-<ts>, 数据仍可人工恢复。
    if (this._corruptPending) {
      try {
        fs.renameSync(this.file, `${this.file}.corrupt-${new Date().toISOString().replace(/[:.]/g, "")}`);
      } catch { /* 文件已被人工处理/不存在, 照常写 */ }
      this._corruptPending = false;
    }
    writeJson(this.file, this.scenes);
    writeSchema(this.file, "scenes", SCENES_SCHEMA_VERSION);
  }
}
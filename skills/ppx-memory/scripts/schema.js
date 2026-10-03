// src/utils/schema.js - 数据文件 schema 版本 + 迁移钩子
// 目标: 记忆数据文件 (facts.json / scenes.json) 保持纯数组格式不变 (现有读取者 healer/测试全部无感),
//       版本号写在旁挂的 <file>.schema 小文件中; 数据结构升级时注册迁移函数, 启动自动迁移。
// 设计:
//   - 无 .schema 文件的历史数据一律视为 v1 (基线, 纯数组格式)
//   - registerMigration(name, from, to, fn) 注册迁移链, 不允许跳级, 不允许覆盖
//   - migrateData() 读当前版本 -> 沿迁移链推进 -> 原子写回数据 + 更新 .schema 文件
//   - 崩溃安全: 迁移在原子写回后版本才推进, 中断重跑幂等
import path from "node:path";
import { atomicWrite, ensureDir, readJson } from "./store.js";

// 基线版本: 无 .schema 文件 (历史纯数组格式) 一律视为 v1
export const SCHEMA_BASE_VERSION = 1;

// name -> Map<fromVersion, { to, fn }>
const MIGRATIONS = new Map();

// 注册迁移: from 版本 -> to 版本 (to 必须 > from)
// fn(data, { from, to }) => 迁移后的 data
export function registerMigration(name, from, to, fn) {
  if (!Number.isInteger(from) || !Number.isInteger(to) || to <= from) {
    throw new Error(`非法迁移版本: ${name} ${from}->${to}`);
  }
  if (typeof fn !== "function") throw new Error(`迁移函数缺失: ${name} v${from}`);
  let chain = MIGRATIONS.get(name);
  if (!chain) { chain = new Map(); MIGRATIONS.set(name, chain); }
  if (chain.has(from)) throw new Error(`迁移冲突: ${name} v${from} 已注册`);
  chain.set(from, { to, fn });
  return { name, from, to };
}

function schemaFileOf(file) {
  return file + ".schema";
}

// 读当前数据文件版本 (无 .schema 文件视为基线 v1)
export function readSchema(file) {
  const meta = readJson(schemaFileOf(file), null);
  if (!meta || !Number.isInteger(meta.version)) return SCHEMA_BASE_VERSION;
  return meta.version;
}

// 写版本 (原子)
export function writeSchema(file, name, version) {
  const p = schemaFileOf(file);
  ensureDir(path.dirname(p));
  atomicWrite(p, JSON.stringify({ name, version, updatedAt: new Date().toISOString() }, null, 2));
}

// 把数据文件迁移到 currentVersion: 沿注册链逐级推进, 无迁移函数则安全跳过 (版本直接标记到目标, 数据不动)。
// 返回 { from(初始版本), to(最终版本), applied, data } —— applied 为实际执行的迁移步骤列表
export function migrateData({ file, name, data, currentVersion, logger = null }) {
  const chain = MIGRATIONS.get(name) || new Map();
  const start = readSchema(file);
  let from = start;
  let d = data;
  const applied = [];
  let guard = 0;
  while (from < currentVersion) {
    if (++guard > 20) throw new Error(`迁移链疑似死循环: ${name} v${from}`);
    const step = chain.get(from);
    if (!step) {
      // 没有迁移函数但仍落后于目标: 记录说明并直接标记版本 (数据保持原样)
      if (logger) logger(`schema ${name}: v${from} -> v${currentVersion} 无迁移函数, 数据保持原样`);
      applied.push({ from, to: currentVersion, note: "no-migration" });
      from = currentVersion;
      break;
    }
    if (step.to > currentVersion) throw new Error(`迁移越界: ${name} v${from}->v${step.to} 超过目标 v${currentVersion}`);
    d = step.fn(d, { from, to: step.to });
    applied.push({ from, to: step.to });
    from = step.to;
  }
  if (applied.length) {
    // 迁移产生新数据: 原子写回 (rename 覆盖, 崩溃安全), 版本随 .schema 文件推进
    atomicWrite(file, JSON.stringify(d, null, 2));
  }
  writeSchema(file, name, from);
  return { from: start, to: from, applied, data: d };
}

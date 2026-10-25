// scripts/bench-store.js - 记忆存储后端对比基准 (JSON 文件 vs SQLite 内嵌库)
// 用法: npm run bench:store
// 对比维度: 批量写入 / 检索延迟 / 磁盘体积 / 崩溃安全 (WAL)
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { FactStore } from '../src/memory/fact-store.js';
import { SqliteFactStore } from '../src/memory/sqlite-store.js';

const N_WRITE = 800;   // 写入条数
const N_QUERY = 200;   // 查询次数
const CORPUS = [
  '用户偏好深色主题与极简界面',
  '项目采用零依赖纯 Node 实现',
  '记忆分层 L0 到 L4 各有衰减率',
  '审计链使用 SHA-256 防篡改',
  '工具调用需要参数校验与重试',
  '军团模式支持多进程并行编排',
  '上下文工程要控制固定开销',
  '失败归因分为八类根因',
  '技能入库需要经过验证闸门',
  '配置合并必须深拷贝避免污染',
];
const QUERIES = ['主题偏好', '零依赖', '衰减率', '审计链', '参数校验', '军团', '上下文开销', '归因', '技能闸门', '深拷贝'];

function timed(fn) {
  const t = process.hrtime.bigint();
  const r = fn();
  return { ms: Number(process.hrtime.bigint() - t) / 1e6, r };
}

function dirSize(d) {
  let n = 0;
  const walk = (p) => {
    if (!fs.existsSync(p)) return;
    for (const e of fs.readdirSync(p, { withFileTypes: true })) {
      const q = path.join(p, e.name);
      if (e.isDirectory()) walk(q);
      else n += fs.statSync(q).size;
    }
  };
  walk(d);
  return n;
}

async function run(name, make) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `ppx-store-${name}-`));
  const store = make(dir);

  const w = timed(() => {
    for (let i = 0; i < N_WRITE; i++) {
      store.add(`${CORPUS[i % CORPUS.length]} #${i}`, { source: 'bench', dedupe: false });
    }
  });

  let hits = 0;
  const q = timed(() => {
    for (let i = 0; i < N_QUERY; i++) {
      hits += store.query(QUERIES[i % QUERIES.length], { limit: 5 }).length;
    }
  });

  const bytes = dirSize(dir);
  const stats = store.stats();
  if (typeof store.close === 'function') store.close();
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}

  return {
    name,
    writeMs: w.ms,
    writePerOp: w.ms / N_WRITE,
    queryMs: q.ms,
    queryPerOp: q.ms / N_QUERY,
    totalHits: hits,
    bytes,
    backend: stats.backend || 'json',
  };
}

const results = [];
results.push(await run('json', (d) => new FactStore(d, {})));
results.push(await run('sqlite', (d) => new SqliteFactStore(d, {})));
try {
  results.push(await run('json+wal', (d) => new FactStore(d, { wal: true, walThreshold: 50 })));
} catch (e) {
  console.log('(json+wal 跳过: ' + e.message + ')');
}

const pad = (s, n) => String(s).padEnd(n);
const num = (x, n = 2) => Number(x).toFixed(n);

console.log(`\n记忆存储后端对比 (写 ${N_WRITE} 条 / 查 ${N_QUERY} 次)`);
console.log('─'.repeat(74));
console.log(pad('后端', 12) + pad('写入总耗时', 14) + pad('单条写', 12) + pad('查询总耗时', 14) + pad('单次查', 12) + pad('体积', 12));
console.log('─'.repeat(74));
for (const r of results) {
  console.log(
    pad(r.name, 12) +
    pad(num(r.writeMs) + ' ms', 14) +
    pad(num(r.writePerOp, 3) + ' ms', 12) +
    pad(num(r.queryMs) + ' ms', 14) +
    pad(num(r.queryPerOp, 3) + ' ms', 12) +
    pad((r.bytes / 1024).toFixed(0) + ' KB', 12),
  );
}
console.log('─'.repeat(74));

const json = results.find((r) => r.name === 'json');
const sq = results.find((r) => r.name === 'sqlite');
if (json && sq) {
  console.log(`\nSQLite vs JSON:`);
  console.log(`  写入: ${num(json.writeMs / sq.writeMs)}x 更快 (${num(json.writeMs)} ms → ${num(sq.writeMs)} ms)`);
  console.log(`  查询: ${num(json.queryMs / sq.queryMs)}x 更快 (${num(json.queryMs)} ms → ${num(sq.queryMs)} ms)`);
  console.log(`  命中一致性: json ${json.totalHits} 次 vs sqlite ${sq.totalHits} 次`);
}
console.log(`\n注: JSON 版每次 add 触发全量读盘+重建索引+全量原子写; SQLite 版为增量写 + FTS5 索引 + WAL。`);

// 审计链 append 性能基准: 验证 lastHash() 是否退回全量读盘 (O(N^2))
// 用法: npm run bench:audit
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AuditLog } from '../src/audit/audit-chain.js';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ppx-audit-bench-'));
const log = new AuditLog(dir);

const N = 2000;
const t0 = process.hrtime.bigint();
for (let i = 0; i < N; i++) {
  log.append({ tool: 'run_command', args: { command: 'echo ' + i, path: '/tmp/x' }, ok: true, ms: 3 });
}
const t1 = process.hrtime.bigint();
const ms = Number(t1 - t0) / 1e6;
const size = fs.statSync(log.file).size;

console.log('append 次数: ' + N);
console.log('总耗时: ' + ms.toFixed(1) + ' ms');
console.log('单次均耗: ' + (ms / N).toFixed(3) + ' ms');
console.log('日志大小: ' + (size / 1024).toFixed(0) + ' KB');
console.log('链完整性: ' + JSON.stringify(log.verify().ok));

// 分段测: 前 500 条 vs 后 500 条, 若明显变慢即为 O(N^2) 特征
const log2 = new AuditLog(dir);
const seg = (from, to) => {
  const a = process.hrtime.bigint();
  for (let i = from; i < to; i++) log2.append({ tool: 't', args: { i }, ok: true, ms: 1 });
  return Number(process.hrtime.bigint() - a) / 1e6;
};
const s1 = seg(0, 500);
const s2 = seg(1500, 2000);
console.log('前 500 条: ' + s1.toFixed(1) + ' ms | 后 500 条: ' + s2.toFixed(1) + ' ms');
console.log('后/前 倍率: ' + (s2 / s1).toFixed(2) + '  (>3 即确认 O(N^2) 特征)');

fs.rmSync(dir, { recursive: true, force: true });

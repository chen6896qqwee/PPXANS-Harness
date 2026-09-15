// test/skill-upgrade.test.js - 技能用中自进化 (src/skills/verify.js + agent.upgradeSkill + evolve 触发)
// 来源: Hermes "skill self-improves during use" — 高频技能自动升级, 防退化
import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { verifyUpgradeSkill } from '../src/skills/verify.js';

function goodSkill(pad=0) {
  const steps = Array.from({length: 5+pad}, (_,i)=>(i+1)+'. step'+i).join('\n');
  return '## 流程\n'+steps+'\n\n## 反合理化\n不偷懒\n\n## 验证\n输出结果';
}

test('verifyUpgradeSkill: 达标升级版放行 (含流程+验证, 不缩水)', () => {
  const v = verifyUpgradeSkill({ content: goodSkill(), prevContent: '# old\n## 流程\n1. x\n## 验证\ny' });
  assert.equal(v.ok, true);
  assert.equal(v.changed, true);
});

test('verifyUpgradeSkill: 升级版缺段落 → 拦', () => {
  const v = verifyUpgradeSkill({ content: '## 流程\n缺口了验证段\n1. x', prevContent: '## 流程\n1. x\n## 验证\ny' });
  assert.equal(v.ok, false);
  assert.match(String(v.reason), /流程|验证/);
});

test('verifyUpgradeSkill: 正文缩水(退化) → 拦', () => {
  const bad = '## 流程\n1. \u8bfb\u6587\u4ef6\n2. \u8f93\u51fa\n\u6ce8\u610f\u6b64\u6587\u672c\u660e\u663e\u7f29\u6c34\u4e86\u4f46\u957f\u5ea6\u8d85\u8fc720\u5b57\u907f\u514d\u89e6\u53d1\u592a\u77ed\u68c0\u67e5\n## \u9a8c\u8bc1\n\u8fd4\u56de';
  const prev = goodSkill(10);                          // 长很多
  const v = verifyUpgradeSkill({ content: bad, prevContent: prev });
  assert.equal(v.ok, false);
  assert.match(String(v.reason), /缩水/);
});

test('verifyUpgradeSkill: 正文太短 → 拦', () => {
  const v = verifyUpgradeSkill({ content: '## 流程\nhi\n## 验证\nyo', prevContent: 'x' });
  assert.equal(v.ok, false);
});
// === agent 级集成: upgradeSkill 全链路 ===
import { PPXAgent } from '../src/agent/index.js';
import { SkillLoader } from '../src/skills/loader.js';

function makeAgent() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ppx-upg-'));
  return new PPXAgent({ root, configFile: null });
}

test('upgradeSkill 集成: 用满次数→LLM升级→过闸门→写回→reset', async () => {
  const a = makeAgent();
  // 建一个真实技能供 loader 读取
  const sdir = path.join(a.root, 'skills', 'file-reader');
  fs.mkdirSync(sdir, { recursive: true });
  fs.writeFileSync(path.join(sdir, 'SKILL.md'), '---\nname: file-reader\ndescription: 批量读文件\n---\n\n## 流程\n1. 读文件\n2. 验证\n\n## 验证\n返回内容', 'utf8');
  // 重新初始化 skills loader 指向同目录
  a.skills = new SkillLoader(path.join(a.root, 'skills'));
  // 攒够使用次数
  for (let i=0;i<5;i++) a.skills.trackUse('file-reader');
  assert.equal(a.skills.useOf('file-reader').uses, 5, '应先用满5次');
  // mock LLM 返回升级版 (更长更完整, 引用工具)
  a.llm = { chat: async () => ({ content: '## 流程\n1. 读文件\n2. 校验编码\n3. 输出\n\n## 反合理化\n不要跳过校验\n\n## 验证\n返回完整内容' }) };
  a.traces.read = () => [ { ok: true, tool: 'read_file', result: 'a' } ];
  // 让 create_skill 走真实写入
  const r = await a.upgradeSkill('file-reader', { minUses: 3 });
  assert.equal(r.upgraded, 1, '应该升级成功');
  const after = fs.readFileSync(path.join(sdir, 'SKILL.md'), 'utf8');
  assert.ok(after.includes('校验编码'), 'SKILL.md 应写入升级版');
  assert.ok(after.includes('---'), '应保留 frontmatter');
  assert.equal(a.skills.useOf('file-reader').uses, 0, '升级后应重置计数防连跑');
  a.shutdown();
  fs.rmSync(a.root, { recursive: true, force: true });
});

test('upgradeSkill 集成: 使用次数不足→跳过', async () => {
  const a = makeAgent();
  const sdir = path.join(a.root, 'skills', 'file-reader');
  fs.mkdirSync(sdir, { recursive: true });
  fs.writeFileSync(path.join(sdir, 'SKILL.md'), '---\nname: file-reader\ndescription: x\n---\n\n## 流程\n1. 读\n\n## 验证\ny', 'utf8');
  a.skills = new SkillLoader(path.join(a.root, 'skills'));
  a.skills.trackUse('file-reader'); // 只用 1 次
  a.llm = { chat: async () => ({ content: '升级版\n## 流程\n1. 读\n2. 写\n## 验证\nz'  }) };
  const r = await a.upgradeSkill('file-reader', { minUses: 3 });
  assert.equal(r.upgraded, 0, '次数不足不应升级');
  assert.match(String(r.reason||''), /使用不足/);
  a.shutdown();
  fs.rmSync(a.root, { recursive: true, force: true });
});

test('upgradeSkill 集成: LLM 产出退化版→被闸门拦, 不写回', async () => {
  const a = makeAgent();
  const sdir = path.join(a.root, 'skills', 'file-reader');
  fs.mkdirSync(sdir, { recursive: true });
  const good = '---\nname: file-reader\ndescription: x\n---\n\n## 流程\n1. 读文件并解析内容逐行输出检查编码正确性\n2. 校验行尾\n3. 验证\n\n## 反合理化\n别偷懒\n\n## 验证\n返回完整内容';
  fs.writeFileSync(path.join(sdir, 'SKILL.md'), good, 'utf8');
  a.skills = new SkillLoader(path.join(a.root, 'skills'));
  for (let i=0;i<5;i++) a.skills.trackUse('file-reader');
  // mock LLM 返回缺"验证"段 → 应被拦
  a.llm = { chat: async () => ({ content: '## 流程\n1. 读\n' }) };
  a.traces.read = () => [ { ok: true, tool: 'read_file', result: 'a' } ];
  const r = await a.upgradeSkill('file-reader', { minUses: 3 });
  assert.equal(r.upgraded, 0, '退化版应被拦截');
  assert.ok(r.rejected, '应标记 rejected');
  const after = fs.readFileSync(path.join(sdir, 'SKILL.md'), 'utf8');
  assert.ok(after.includes('校验行尾'), '原技能不应被覆盖');
  a.shutdown();
  fs.rmSync(a.root, { recursive: true, force: true });
});
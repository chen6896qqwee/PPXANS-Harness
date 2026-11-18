// test/skill-usage.test.js - 技能使用追踪 (src/skills/loader.js + load_skill 集成)
// 来源: Hermes "skill self-improves during use" 地基 — 用中自进化前提是知道谁在用、谁闲置
import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SkillLoader } from '../src/skills/loader.js';
import { ToolCatalog } from '../src/tools/index.js';
import { registerSelfmodTools } from '../src/tools/selfmod.js';

function tmpSkills() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ppx-susage-'));
  const dir = path.join(root, 'skills');
  fs.mkdirSync(dir, { recursive: true });
  const skillDir = path.join(dir, 'my-skill');
  fs.mkdirSync(skillDir, { recursive: true });
  fs.writeFileSync(path.join(skillDir, 'SKILL.md'), '---\nname: my-skill\ndescription: 测试技能\n---\n\n## 流程\n读文件\n## 验证\n返回内容', 'utf8');
  return { root, dir };
}

test('trackUse: 累加使用次数 + 落盘可读回', () => {
  const { root, dir } = tmpSkills();
  const L = new SkillLoader(dir);
  L.trackUse('my-skill');
  L.trackUse('my-skill');
  const L2 = new SkillLoader(dir);
  const got = L2.useOf('my-skill');
  assert.equal(got.uses, 2, '应累计 2 次');
  assert.ok(got.lastUsed, '应有 lastUsed 时间戳');
  fs.rmSync(root, { recursive: true, force: true });
});

test('useOf: 从未使用返回默认 0, 不崩溃', () => {
  const { root, dir } = tmpSkills();
  const L = new SkillLoader(dir);
  assert.deepEqual(L.useOf('nope'), { uses: 0, lastUsed: null });
  fs.rmSync(root, { recursive: true, force: true });
});

test('usageAll: 汇总全部技能使用', () => {
  const { root, dir } = tmpSkills();
  const L = new SkillLoader(dir);
  L.trackUse('my-skill');
  const all = L.usageAll();
  assert.equal(Object.keys(all).length >= 1, true);
  assert.equal(all['my-skill'].uses, 1);
  fs.rmSync(root, { recursive: true, force: true });
});

test('load_skill 集成: 调用时自动计数', async () => {
  const { root, dir } = tmpSkills();
  const loader = new SkillLoader(dir);
  const catalog = new ToolCatalog();
  registerSelfmodTools(catalog, { skillsDir: dir });
  const r1 = await catalog.call('load_skill', { id: 'my-skill' });
  assert.ok(String(r1).includes('## 流程'), '应返回 SKILL.md 内容');
  const got = loader.useOf('my-skill');
  assert.equal(got.uses, 1, 'load_skill 应自动计数一次');
  fs.rmSync(root, { recursive: true, force: true });
});
import test from 'node:test';
import assert from 'node:assert/strict';
import { promptMethods } from '../src/agent/prompts.js';

test('disabled tools advertise text-only capabilities without file or skill invocation instructions', () => {
  const ctx = { toolsEnabled: false, root: '/synthetic', skills: { list() { throw new Error('disabled catalog must not be loaded'); } } };
  const workspace = promptMethods._workspacePrompt.call(ctx);
  assert.match(workspace, /所有工具已关闭/);
  assert.match(workspace, /不得声称已执行/);
  assert.doesNotMatch(workspace, /read_file|write_file|load_skill|skill_search/);
  assert.equal(promptMethods._skillsPrompt.call(ctx), '');
});

test('enabled tools retain workspace and skill guidance', () => {
  const ctx = { toolsEnabled: true, root: '/synthetic', config: {}, skills: { list: () => [{ id: 'test/fixture', description: 'synthetic' }] } };
  assert.match(promptMethods._workspacePrompt.call(ctx), /read_file/);
  assert.match(promptMethods._skillsPrompt.call(ctx), /load_skill/);
});

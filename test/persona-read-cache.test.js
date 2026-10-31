// test/persona-read-cache.test.js — L3 画像正文读缓存 (2026-10-30 热路径优化) 的回归守卫
//
// 背景: agent._context() → _l3Context() 每轮 system prompt 都读 user/agent 两份画像 (.md)。
//   实测 2 次整文件读 ≈1.2ms/轮, 而画像一天才变一次 —— 于是按 stat(mtimeMs:size) 做了
//   读缓存。缓存的风险面只有一个: **读旧值**(外部编辑器改画像 / 重建画像后仍返回旧文本)。
//   本测试就钉这三件事:
//     ① 命中缓存时不再发生整文件读 (省的是真 I/O, 不是"看起来快了");
//     ② 外部改写文件后立刻读到新内容 (指纹变化 → 失效);
//     ③ 文件被删除后读到空串 (不返回缓存残影), 且重建画像 (build*Persona) 后立即可见。
import test from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PersonaStore } from "../src/memory/l3.js";
import { cleanupTmp } from "../scripts/lib/tmp-agent.js";

function mk() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ppx-persona-cache-"));
  return { dir, ps: new PersonaStore(dir, { userName: "测试" }) };
}

// 统计目标文件的整文件读次数 (模块里 import 的是同一个 fs 对象, 直接包一层即可)
function countReads(targetFile) {
  const orig = fs.readFileSync;
  let n = 0;
  fs.readFileSync = function (file, ...rest) {
    if (String(file) === String(targetFile)) n++;
    return orig.call(fs, file, ...rest);
  };
  return {
    get: () => n,
    restore: () => { fs.readFileSync = orig; },
  };
}

test("命中缓存后不再整文件读画像, 但外部改写后的内容必须立即可见", () => {
  const { dir, ps } = mk();
  try {
    const facts = [{ content: "喜欢用 Node 写零依赖工具", source: "conversation" }];
    ps.buildUserPersona(facts, { force: true });

    // 预热一次 (首次读不进缓存或刚建好), 之后连续 5 次应零整文件读
    ps.userPersona();
    const c = countReads(ps.userFile);
    try {
      for (let i = 0; i < 5; i++) ps.userPersona();
    } finally {
      c.restore();
    }
    assert.equal(c.get(), 0, "缓存命中期间不应再发生整文件读 (省 I/O 才是优化的本体)");

    // 外部改写 (模拟人工编辑 / 另一进程重建): 指纹变化 → 必须读到新内容
    fs.writeFileSync(ps.userFile, "# 改写后的画像\n- 新事实\n", "utf8");
    const text = ps.userPersona();
    assert.ok(text.includes("改写后的画像"), "文件被外部改写后仍返回了旧缓存");
    assert.ok(!text.includes("喜欢用 Node 写零依赖工具"), "旧画像内容应已被替换");
  } finally {
    cleanupTmp(dir);
  }
});

test("画像文件被删除后读到空串 (不返回缓存残影), 重建后立即可见", () => {
  const { dir, ps } = mk();
  try {
    ps.buildUserPersona([{ content: "临时事实", source: "conversation" }], { force: true });
    assert.ok(ps.userPersona().includes("临时事实"));

    fs.rmSync(ps.userFile, { force: true });
    assert.equal(ps.userPersona(), "", "文件已删除, 不得返回缓存残影");

    // 重建 (force) → 新内容, 且缓存随之更新
    const md = ps.buildUserPersona([{ content: "重建后的事实", source: "conversation" }], { force: true });
    assert.ok(md.includes("重建后的事实"));
    assert.ok(ps.userPersona().includes("重建后的事实"));
  } finally {
    cleanupTmp(dir);
  }
});

test("agent 画像缓存独立于 user 画像 (互不串味)", () => {
  const { dir, ps } = mk();
  try {
    ps.buildUserPersona([{ content: "用户事实A", source: "conversation" }], { force: true });
    ps.buildAgentPersona([{ lesson: "经验B" }], { force: true });
    assert.ok(ps.userPersona().includes("用户事实A"));
    assert.ok(!ps.userPersona().includes("经验B"));
    assert.ok(ps.agentPersona().includes("经验B"));
    assert.ok(!ps.agentPersona().includes("用户事实A"));
  } finally {
    cleanupTmp(dir);
  }
});

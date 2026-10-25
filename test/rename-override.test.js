import test from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { SessionStore } from "../src/memory/session.js";

function tmp(){ return fs.mkdtempSync(path.join(os.tmpdir(), "ppx-rename-over-")); }

test("复审P1: rename 到已存在 key 拒绝覆盖, 数据不丢失", () => {
  const s = new SessionStore(tmp());
  s.append("a", "user/message", { content: "A 的内容" });
  s.append("b", "user/message", { content: "B 的原始内容" });
  // 尝试把 a 重命名为已存在的 b -> 应返回 false, 且 b 内容不被覆盖
  assert.equal(s.rename("a", "b"), false, "目标已存在应拒绝");
  assert.equal(s.has("a"), true, "a 应保留");
  assert.equal(s.has("b"), true, "b 应保留");
  assert.deepEqual(s.deriveMessages("b").map((m) => m.content), ["B 的原始内容"], "b 内容未被覆盖");
  assert.deepEqual(s.deriveMessages("a").map((m) => m.content), ["A 的内容"], "a 内容未被改动");
});

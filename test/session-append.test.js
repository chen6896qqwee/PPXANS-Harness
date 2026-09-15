import test from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { SessionStore } from "../src/memory/session.js";

function tmp() { return fs.mkdtempSync(path.join(os.tmpdir(), "ppx-sess-")); }

test("P1#5: 增量落盘 - 多次 append 文件无重复且顺序正确", () => {
  const d = tmp();
  const s = new SessionStore(d);
  for (let i = 1; i <= 5; i++) s.append("t", "user/message", { content: "msg" + i });
  const file = path.join(d, "sessions", "t.jsonl");
  const lines = fs.readFileSync(file, "utf8").split("\n").filter(Boolean);
  assert.equal(lines.length, 5, "5 条事件全部落盘");
  const seqs = lines.map((l) => JSON.parse(l).seq);
  assert.deepEqual(seqs, [1, 2, 3, 4, 5], "seq 顺序正确无重复");
});

test("P1#5: 增量落盘 - 跨实例恢复一致", () => {
  const d = tmp();
  const s1 = new SessionStore(d);
  s1.append("k", "user/message", { content: "a" });
  s1.append("k", "assistant/message", { content: "b" });
  const s2 = new SessionStore(d); // 重启
  const msgs = s2.deriveMessages("k");
  assert.deepEqual(msgs.map((m) => m.content), ["a", "b"]);
  // 继续在 s2 上追加, 再重启验证
  s2.append("k", "user/message", { content: "c" });
  const s3 = new SessionStore(d);
  assert.deepEqual(s3.deriveMessages("k").map((m) => m.content), ["a", "b", "c"]);
});

test("P1#5: set() 重建后增量正常", () => {
  const d = tmp();
  const s = new SessionStore(d);
  s.set("r", [{ role: "user", content: "x" }, { role: "assistant", content: "y" }]);
  s.append("r", "user/message", { content: "z" });
  const s2 = new SessionStore(d);
  assert.deepEqual(s2.deriveMessages("r").map((m) => m.content), ["x", "y", "z"]);
});

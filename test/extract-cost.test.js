import test from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { MemoryTicker } from "../src/memory/memory-ticker.js";
import { FactStore } from "../src/memory/fact-store.js";
import { SessionStore } from "../src/memory/session.js";

function tmp(){ return fs.mkdtempSync(path.join(os.tmpdir(), "ppx-extract-cost-")); }

test("复审P1#9: 60字无信号关键词的普通闲聊不触发 LLM 提炼 (成本收紧)", async () => {
  const d = tmp();
  const facts = new FactStore(d, {});
  const sess = new SessionStore(d);
  const mt = new MemoryTicker(d, facts, null, sess);
  let extracted = 0;
  mt.setExtractor(async () => { extracted++; return ["x"]; });
  // 60 字、无 SIGNAL 关键词、非寒暄 -> 不应触发 LLM 提炼
  const long = "今天天气不错适合出去走走顺便买点菜回家做饭周末再安排个短途旅行放松放松";
  await mt.recordTurn(long, "嗯，听起来不错");
  assert.equal(extracted, 0, "无关键词长对话不应触发 LLM 提炼");
});

import test from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { SceneStore } from "../src/memory/l2.js";

function tmp(){ return fs.mkdtempSync(path.join(os.tmpdir(),"ppx-act-")); }

test("场景激活: 关键词命中注入人设/能力", () => {
  const s = new SceneStore(tmp());
  s.create({ name: "A股交易助手", description: "帮兄弟盯A股行情", canHelp: "分析板块/选股/看资金流", keywords: ["A股","股票","资金流","板块"] });
  const ctx = s.activeContext("帮我看看 A股 的板块资金流");
  assert.ok(ctx.includes("A股交易助手"), "命中场景名");
  assert.ok(ctx.includes("帮兄弟盯A股行情"), "注入介绍");
  assert.ok(ctx.includes("分析板块/选股/看资金流"), "注入能力");
  assert.ok(ctx.includes("手动设定"), "手动场景标记");
});

test("场景激活: 未命中返回空", () => {
  const s = new SceneStore(tmp());
  s.create({ name: "A股交易助手", description: "x", canHelp: "y", keywords: ["A股"] });
  assert.equal(s.activeContext("今天天气怎么样"), "");
});

test("场景激活: 自动场景无手动标记", () => {
  const s = new SceneStore(tmp());
  s.create({ name: "闲聊", description: "d", canHelp: "c", keywords: ["聊天"] });
  const ctx = s.activeContext("来聊聊家常");
  assert.ok(!ctx.includes("手动设定"), "auto 场景不下指令");
});

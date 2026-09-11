import test from "node:test";
import assert from "node:assert";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { PPXAgent } from "../src/agent/index.js";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
function tmpRoot(n){ return fs.mkdtempSync(path.join(os.tmpdir(),`ppx-${n}-`)); }

test("场景系统: 手动创建场景含人设/介绍/能力", () => {
  const a = new PPXAgent({ root: tmpRoot("scene") });
  const s = a.scenes.create({ name: "A股交易助手", description: "帮兄弟盯A股行情", canHelp: "分析板块/选股/看资金流" });
  assert.equal(s.mode, "manual");
  assert.equal(s.description, "帮兄弟盯A股行情");
  assert.equal(s.canHelp, "分析板块/选股/看资金流");
  const list = a.scenes.listWithDesc();
  assert.equal(list.length, 1);
  assert.equal(list[0].mode, "manual");
  a.shutdown();
});

test("场景系统: 自动场景有默认人设/能力", () => {
  const a = new PPXAgent({ root: tmpRoot("scene2") });
  const f = a.facts.add("用户关注 A股 量化交易", { type: "conversation" });
  a.scenes.assign(f);
  const list = a.scenes.listWithDesc();
  assert.equal(list.length, 1);
  assert.equal(list[0].mode, "auto");
  assert.ok(list[0].description, "自动场景有默认介绍");
  assert.ok(list[0].canHelp, "自动场景有默认能力");
  a.shutdown();
});

test("场景系统: scene工具已注册", () => {
  const a = new PPXAgent({ root: tmpRoot("scene3") });
  const names = a.tools.list();
  assert.ok(names.includes("scene_create"), "scene_create 注册");
  assert.ok(names.includes("scene_list"), "scene_list 注册");
  assert.ok(names.includes("scene_describe"), "scene_describe 注册");
  a.shutdown();
});

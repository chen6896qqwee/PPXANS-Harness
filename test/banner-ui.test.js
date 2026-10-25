// test/banner-ui.test.js - 启动横幅模块回归 (UI 轮)
// 锁死: 面板混合内容对齐 (CJK 双列宽) / NO_COLOR 降级 / 可见宽度计算
import test from "node:test";
import assert from "node:assert";
import { panel, visibleWidth, kv, cliBanner, webBanner } from "../src/utils/banner.js";

test("banner: 可见宽度 —— CJK 按 2 列, ASCII 按 1 列, ANSI 转义不计宽", () => {
  assert.equal(visibleWidth("abc"), 3);
  assert.equal(visibleWidth("中文"), 4);
  assert.equal(visibleWidth("混合ab中"), 8, "混(2)合(2)a b(2)中(2)");
  assert.equal(visibleWidth("\x1b[38;2;217;119;87m中文\x1b[0m"), 4, "ANSI 码剥除");
});

test("banner: 面板混合中英文逐行严格对齐", () => {
  const p = panel(["中文宽度测试", "ascii", "混排 line 42"]);
  const lines = p.split("\n");
  const w = visibleWidth(lines[0]);
  for (const l of lines) assert.equal(visibleWidth(l), w, `行不对齐: ${JSON.stringify(l)}`);
});

test("banner: NO_COLOR 下输出无 ANSI 转义", () => {
  const prev = process.env.NO_COLOR;
  process.env.NO_COLOR = "1";
  try {
    // 动态 import 保证读到当前 env (colorEnabled 每次调用时判定)
    return import("../src/utils/banner.js").then(({ paint, colors }) => {
      assert.equal(paint(colors.accent, "x"), "x", "无色环境 paint 原样返回");
    });
  } finally {
    if (prev === undefined) delete process.env.NO_COLOR; else process.env.NO_COLOR = prev;
  }
});

test("banner: kv 标签按可见列对齐 (JS 字符索引 ≠ 可见列, 用可见宽度断言)", () => {
  const a = kv("界面", "URL");
  const b = kv("根目录", "D:/x");
  const strip = (s) => s.replace(/\x1b\[[0-9;]*m/g, "");
  const colOf = (s, needle) => visibleWidth(strip(s).slice(0, strip(s).indexOf(needle)));
  assert.equal(colOf(a, "URL"), colOf(b, "D:/x"), "两个键值行的值起始可见列一致");
});

test("banner: cliBanner / webBanner 输出含关键信息且逐行对齐", () => {
  const strip = (s) => s.replace(/\x1b\[[0-9;]*m/g, "");
  const cli = cliBanner({ version: "9.9.9", memory: 1, experience: 2, modelReady: true, tools: 3 });
  assert.ok(strip(cli).includes("PPXANS-Harness") && strip(cli).includes("v9.9.9"));
  for (const l of strip(cli).split("\n")) assert.equal(visibleWidth(l), visibleWidth(strip(cli).split("\n")[0]));
  const web = webBanner({ version: "9.9.9", url: "http://x:1", root: "R" });
  assert.ok(strip(web).includes("http://x:1"));
  for (const l of strip(web).split("\n")) assert.equal(visibleWidth(l), visibleWidth(strip(web).split("\n")[0]));
});

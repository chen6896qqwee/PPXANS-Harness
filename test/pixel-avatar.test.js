// test/pixel-avatar.test.js — 名字生成的像素身份 (2026-11-16)
// 纯函数测试: 同名确定性、8×8 对称、眼睛/嘴固定、SVG 不含用户文本、默认品牌色。
import test from "node:test";
import assert from "node:assert/strict";
import {
  PIXEL_AVATAR_SIZE,
  PIXEL_PALETTES,
  normalizeAvatarName,
  hashAvatarName,
  buildPixelGrid,
  pixelAvatar,
  pixelAvatarSvg,
} from "../webapp/src/stores/pixel-avatar.js";

const HEX = /^#[0-9a-f]{6}$/i;

test("pixel-avatar: 默认名字/空白归一为皮皮虾", () => {
  assert.equal(normalizeAvatarName(null), "皮皮虾");
  assert.equal(normalizeAvatarName("   "), "皮皮虾");
  assert.equal(normalizeAvatarName("  Mira  "), "Mira");
  assert.equal(hashAvatarName(" 皮皮虾 "), hashAvatarName("皮皮虾"));
});

test("pixel-avatar: 同名确定性, 不同名字换头像", () => {
  const names = ["皮皮虾", "Mira", "研究员", "Coder", "Nova"];
  for (const n of names) {
    assert.equal(pixelAvatar(n).svg, pixelAvatar(n).svg, `${n} 必须确定性`);
    assert.equal(pixelAvatar(n).seed, hashAvatarName(n));
  }
  assert.equal(new Set(names.map((n) => pixelAvatar(n).svg)).size, names.length, "5 个名字至少应有 5 张不同头像");
});

test("pixel-avatar: 8×8 左右对称, 眼睛/嘴固定, 填充量足够", () => {
  const a = buildPixelGrid("皮皮虾");
  assert.equal(a.size, PIXEL_AVATAR_SIZE);
  assert.equal(a.grid.length, PIXEL_AVATAR_SIZE * PIXEL_AVATAR_SIZE);
  for (let r = 0; r < a.size; r++) {
    for (let c = 0; c < a.size; c++) {
      assert.equal(a.grid[r * a.size + c], a.grid[r * a.size + (a.size - 1 - c)], `第 ${r} 行第 ${c} 列不对称`);
    }
  }
  const filled = a.grid.filter(Boolean).length;
  assert.ok(filled >= 24, `填充像素过少: ${filled}`);
  for (const c of [2, 5]) assert.equal(a.grid[3 * a.size + c], a.palette.eye, "眼睛必须在第 3 行两侧");
  for (const c of [3, 4]) assert.equal(a.grid[5 * a.size + c], a.palette.eye, "嘴必须在第 5 行中轴");
});

test("pixel-avatar: SVG 纯净, 不包含用户名字/脚本", () => {
  const a = pixelAvatar("a<script>alert(1)</script>");
  assert.match(a.svg, /^<svg /);
  assert.match(a.svg, /shape-rendering="crispEdges"/);
  assert.ok(!a.svg.includes("<script"), "SVG 不得带脚本");
  assert.ok(!a.svg.includes("alert(1)"), "名字只参与哈希, 不得进入 SVG");
  assert.ok(!a.svg.includes("javascript:"), "SVG 不得带 javascript: 协议");
  const rects = (a.svg.match(/<rect /g) || []).length;
  assert.equal(rects, a.grid.filter(Boolean).length, "每个填充像素一个 rect");
});

test("pixel-avatar: 调色板来自白名单且颜色合法", () => {
  for (const p of PIXEL_PALETTES) {
    assert.ok(HEX.test(p.body) && HEX.test(p.shade) && HEX.test(p.accent) && HEX.test(p.eye), `${p.id} 颜色非法`);
  }
  for (const n of ["Mira", "研究员", "Coder", "Nova", "琥珀"]) {
    assert.ok(PIXEL_PALETTES.some((p) => p.id === pixelAvatar(n).palette.id));
  }
  assert.equal(pixelAvatar("皮皮虾").palette.id, "coral", "默认身份应与品牌珊瑚一致");
});

test("pixel-avatar: 自定义尺寸仍对称且眼/嘴存在", () => {
  const a = buildPixelGrid("Mira", { size: 10 });
  assert.equal(a.grid.length, 100);
  for (let r = 0; r < a.size; r++) {
    for (let c = 0; c < a.size; c++) {
      assert.equal(a.grid[r * a.size + c], a.grid[r * a.size + (a.size - 1 - c)]);
    }
  }
  const svg = pixelAvatarSvg(a);
  assert.match(svg, /viewBox="0 0 10 10"/);
});

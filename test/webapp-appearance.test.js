// test/webapp-appearance.test.js — 前端外观 v2 的纯数据/首屏/CSS 契约 (2026-11-16)
// 不启动浏览器: 钉住 ID 白名单、本地存储容错、首屏 theme.js 与 CSS 变量的覆盖关系。
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  APPEARANCE_KEY,
  DEFAULT_APPEARANCE,
  PALETTES,
  WALLPAPERS,
  MATERIALS,
  defaultAppearance,
  normalizeAppearance,
  clampWallpaperOpacity,
  appearanceAttrs,
  paletteById,
} from "../webapp/src/stores/appearance-data.js";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8");

test("appearance: 默认值保持品牌珊瑚 + 无壁纸 + 实色", () => {
  assert.deepEqual(defaultAppearance(), DEFAULT_APPEARANCE);
  assert.equal(APPEARANCE_KEY, "ppx_appearance_v1");
  assert.equal(PALETTES[0].id, "coral");
  assert.equal(WALLPAPERS[0].id, "none");
  assert.equal(MATERIALS[0].id, "solid");
});

test("appearance: 非法 JSON/空值/未知 ID 全量回落默认", () => {
  assert.deepEqual(normalizeAppearance("not-json"), DEFAULT_APPEARANCE);
  assert.deepEqual(normalizeAppearance(null), DEFAULT_APPEARANCE);
  assert.deepEqual(normalizeAppearance({ palette: "neon", wallpaper: "photo", material: "glass" }), DEFAULT_APPEARANCE);
  assert.deepEqual(normalizeAppearance('{"palette":"blue"'), DEFAULT_APPEARANCE, "截断 JSON 不能半生效");
});

test("appearance: 合法部分字段合并, 透明度夹在 0.15-0.9", () => {
  assert.deepEqual(
    normalizeAppearance({ palette: "blue", wallpaper: "grid", material: "translucent", wallpaperOpacity: 0.62 }),
    { palette: "blue", wallpaper: "grid", material: "translucent", wallpaperOpacity: 0.62 },
  );
  assert.equal(clampWallpaperOpacity(2), 0.9);
  assert.equal(clampWallpaperOpacity(-1), 0.15);
  assert.equal(clampWallpaperOpacity("0.333"), 0.33);
  assert.equal(clampWallpaperOpacity("NaN"), DEFAULT_APPEARANCE.wallpaperOpacity);
});

test("appearance: 首屏属性映射与 CSS 变量", () => {
  const attrs = appearanceAttrs({ palette: "forest", wallpaper: "dusk", material: "translucent", wallpaperOpacity: 0.4 });
  assert.equal(attrs["data-palette"], "forest");
  assert.equal(attrs["data-wallpaper"], "dusk");
  assert.equal(attrs["data-material"], "translucent");
  assert.equal(attrs["--wallpaper-opacity"], "0.4");
});

test("appearance: paletteById 未命中回落珊瑚", () => {
  assert.equal(paletteById("violet").id, "violet");
  assert.equal(paletteById("nope").id, "coral");
});

test("appearance: 首屏 theme.js 覆盖全部 ID 与存储键", () => {
  const boot = read("webapp/public/theme.js");
  assert.ok(boot.includes(APPEARANCE_KEY), "首屏脚本读同一存储键");
  for (const p of PALETTES) assert.ok(boot.includes(p.id), `首屏缺配色 ${p.id}`);
  for (const w of WALLPAPERS) assert.ok(boot.includes(w.id), `首屏缺壁纸 ${w.id}`);
  for (const m of MATERIALS) assert.ok(boot.includes(m.id), `首屏缺材质 ${m.id}`);
  assert.ok(boot.includes('setAttribute("data-palette"'));
  assert.ok(boot.includes('setAttribute("data-wallpaper"'));
  assert.ok(boot.includes('setAttribute("data-material"'));
});

test("appearance: CSS 有对应配色/壁纸/材质/壁纸层规则", () => {
  const tokens = read("webapp/src/styles/tokens.css");
  const base = read("webapp/src/styles/base.css");
  for (const p of PALETTES.filter((x) => x.id !== "coral")) {
    assert.ok(tokens.includes(`[data-palette="${p.id}"]`), `tokens 缺配色 ${p.id}`);
  }
  for (const w of WALLPAPERS) {
    assert.ok(tokens.includes(`[data-wallpaper="${w.id}"]`), `tokens 缺壁纸 ${w.id}`);
  }
  assert.ok(tokens.includes('[data-material="translucent"]'), "tokens 缺通透材质");
  assert.ok(base.includes("body::before"), "base 缺壁纸层");
  assert.ok(base.includes("var(--wp-image"), "壁纸层必须消费 --wp-image");
});

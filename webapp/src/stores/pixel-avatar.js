// webapp/src/stores/pixel-avatar.js - 名字生成的对称像素头像 (2026-11-16 身份轮)
//
// 设计参考 Tobs (BotHarness/DeepSeekBot, MIT) 的"每个 Bot 一张像素头像 + 工作状态"思路;
// 实现为自研的确定性生成器: 名字 → FNV-1a 哈希 → mulberry32 → 左右对称 8×8 网格。
// 零依赖、零网络、不包含任何用户文本 (名字只参与哈希, 不进 SVG)。
export const PIXEL_AVATAR_SIZE = 8;

export const PIXEL_PALETTES = Object.freeze([
  { id: "coral", body: "#f0653c", shade: "#b84322", accent: "#ffd166", eye: "#211a1a" },
  { id: "blue", body: "#5b9df0", shade: "#2e6fd0", accent: "#9be7ff", eye: "#101a2b" },
  { id: "violet", body: "#9b6dd6", shade: "#6a45a8", accent: "#f2c6ff", eye: "#1b1430" },
  { id: "forest", body: "#3ecf8e", shade: "#1f8a5c", accent: "#d6ffb0", eye: "#10241b" },
  { id: "amber", body: "#e8b33e", shade: "#a8761a", accent: "#fff0b8", eye: "#2a1d0b" },
  { id: "teal", body: "#4bb3bd", shade: "#257a83", accent: "#b8fbff", eye: "#0e2226" },
  { id: "rose", body: "#e05fa8", shade: "#a53873", accent: "#ffd0e8", eye: "#2a1020" },
  { id: "slate", body: "#8a93a8", shade: "#5a6274", accent: "#e3e8f5", eye: "#151922" },
]);

// 中段宽、上下窄的对称轮廓 (半宽, 左半列 0..3)
const HALF_WIDTHS = [1, 2, 3, 4, 4, 4, 3, 2];

export function normalizeAvatarName(name) {
  const s = String(name ?? "").trim();
  return s || "皮皮虾";
}

export function hashAvatarName(name) {
  let h = 0x811c9dc5;
  for (const ch of normalizeAvatarName(name)) {
    h ^= ch.codePointAt(0);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

function mulberry32(seed) {
  let a = seed >>> 0;
  return function next() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function buildPixelGrid(name, { size = PIXEL_AVATAR_SIZE } = {}) {
  const n = normalizeAvatarName(name);
  const seed = hashAvatarName(n);
  const rnd = mulberry32(seed);
  const palette = n === "皮皮虾"
    ? PIXEL_PALETTES[0]
    : PIXEL_PALETTES[seed % PIXEL_PALETTES.length];
  const grid = new Array(size * size).fill(null);
  const half = Math.ceil(size / 2);

  const set = (r, c, color) => {
    if (r >= 0 && r < size && c >= 0 && c < size) grid[r * size + c] = color;
  };

  for (let r = 0; r < size; r++) {
    const base = size === PIXEL_AVATAR_SIZE
      ? HALF_WIDTHS[r]
      : Math.max(1, Math.round(half * (0.45 + 0.55 * Math.sin(((r + 1) / (size + 1)) * Math.PI))));
    const jitter = rnd() < 0.32 ? -1 : 0;
    const width = Math.max(1, Math.min(half, base + jitter));
    for (let c = 0; c < width; c++) {
      const roll = rnd();
      const color = roll < 0.18 ? palette.accent : roll < 0.42 ? palette.shade : palette.body;
      set(r, c, color);
      set(r, size - 1 - c, color);
    }
  }

  // 触角: 顶部两格外侧; 眼睛与嘴固定在中轴两侧, 保证每张脸都可辨认。
  const eyeRow = size >= 8 ? 3 : Math.max(1, Math.floor(size * 0.4));
  const mouthRow = size >= 8 ? 5 : Math.max(2, Math.floor(size * 0.65));
  const eyeL = Math.max(1, Math.floor(size * 0.25));
  const eyeR = size - 1 - eyeL;
  set(0, 2, palette.accent);
  set(0, size - 3, palette.accent);
  for (const c of [eyeL, eyeR]) {
    if (grid[eyeRow * size + c] == null) {
      set(eyeRow, c, palette.body);
      set(eyeRow, size - 1 - c, palette.body);
    }
    set(eyeRow, c, palette.eye);
  }
  for (const c of [Math.floor(size / 2) - 1, Math.floor(size / 2)]) {
    if (grid[mouthRow * size + c] == null) {
      set(mouthRow, c, palette.shade);
      set(mouthRow, size - 1 - c, palette.shade);
    }
    set(mouthRow, c, palette.eye);
  }

  return { name: n, seed, size, palette, grid };
}

export function pixelAvatarSvg({ grid, size = PIXEL_AVATAR_SIZE }) {
  const rects = [];
  for (let i = 0; i < grid.length; i++) {
    const color = grid[i];
    if (!color) continue;
    rects.push(`<rect x="${i % size}" y="${Math.floor(i / size)}" width="1" height="1" fill="${color}"/>`);
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" shape-rendering="crispEdges" aria-hidden="true" focusable="false">${rects.join("")}</svg>`;
}

export function pixelAvatar(name, opts = {}) {
  const avatar = buildPixelGrid(name, opts);
  return { ...avatar, svg: pixelAvatarSvg(avatar) };
}

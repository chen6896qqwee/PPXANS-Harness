#!/usr/bin/env node
// scripts/make-icon.mjs — 由 electron/icon.png 生成 electron/icon.ico
//
// 用小尺寸 BMP 条目 + 256 PNG 条目: NSIS / rcedit / 资源管理器都稳定识别。
// 必须用 Electron 运行时跑 (借 nativeImage 做缩放与像素读取):
//   electron scripts/make-icon.mjs
//
// 说明: 改图标只替换 electron/icon.png 后重跑本脚本, 不要手改 .ico。
import { app, nativeImage } from "electron";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const SRC = path.join(ROOT, "electron", "icon.png");
const OUT = path.join(ROOT, "electron", "icon.ico");
const SIZES = [16, 24, 32, 48, 64, 128];

function bmpEntry(image, size) {
  const raw = image.toBitmap(); // Windows 下为 BGRA, 但不同平台/版本不保证, 下面按品牌蓝自检
  const sx = Math.floor(size * 0.25);
  const sy = Math.floor(size * 0.5);
  const c = (sx + sy * size) * 4;
  const bgra = raw[c] > raw[c + 2]; // 品牌蓝 #4d6bfe: BGRA 首字节 FE > 第三字节 4D
  const px = (x, y) => {
    const i = (y * size + x) * 4;
    return bgra ? [raw[i + 2], raw[i + 1], raw[i], raw[i + 3]] : [raw[i], raw[i + 1], raw[i + 2], raw[i + 3]];
  };
  const andStride = Math.ceil(size / 32) * 4;
  const xorSize = size * size * 4;
  const andSize = andStride * size;
  const buf = Buffer.alloc(40 + xorSize + andSize);
  buf.writeUInt32LE(40, 0);
  buf.writeInt32LE(size, 4);
  buf.writeInt32LE(size * 2, 8);
  buf.writeUInt16LE(1, 12);
  buf.writeUInt16LE(32, 14);
  buf.writeUInt32LE(xorSize + andSize, 20);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const [r, g, b, a] = px(x, size - 1 - y); // DIB 行序自下而上
      const o = 40 + (y * size + x) * 4;
      buf[o] = b;
      buf[o + 1] = g;
      buf[o + 2] = r;
      buf[o + 3] = a;
    }
  }
  return buf;
}

function ico(entries) {
  const head = Buffer.alloc(6);
  head.writeUInt16LE(0, 0);
  head.writeUInt16LE(1, 2);
  head.writeUInt16LE(entries.length, 4);
  const dir = Buffer.alloc(16 * entries.length);
  let offset = 6 + dir.length;
  entries.forEach((e, i) => {
    const o = i * 16;
    dir[o] = e.size >= 256 ? 0 : e.size;
    dir[o + 1] = e.size >= 256 ? 0 : e.size;
    dir.writeUInt16LE(1, o + 4);
    dir.writeUInt16LE(32, o + 6);
    dir.writeUInt32LE(e.data.length, o + 8);
    dir.writeUInt32LE(offset, o + 12);
    offset += e.data.length;
  });
  return Buffer.concat([head, dir, ...entries.map((e) => e.data)]);
}

app.whenReady().then(() => {
  if (!fs.existsSync(SRC)) {
    console.error(`[make-icon] 缺少源图: ${SRC}`);
    app.exit(1);
    return;
  }
  const src = nativeImage.createFromPath(SRC);
  if (src.isEmpty()) {
    console.error("[make-icon] 源图读取失败");
    app.exit(1);
    return;
  }
  const entries = SIZES.map((size) => ({ size, data: bmpEntry(src.resize({ width: size, height: size, quality: "best" }), size) }));
  entries.push({ size: 256, data: src.resize({ width: 256, height: 256, quality: "best" }).toPNG() });
  fs.writeFileSync(OUT, ico(entries));
  console.log(`[make-icon] 已生成 ${OUT} (${SIZES.length} BMP + 256 PNG, ${fs.statSync(OUT).size} bytes)`);
  app.exit(0);
});

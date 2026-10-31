// scripts/checksums.js — 生成 SHA256SUMS.txt (GNU coreutils 兼容格式)
//
// 用法:
//   node scripts/checksums.js dist-desktop
//   node scripts/checksums.js dist-desktop/PPXANS-Harness-Setup-4.0.0-x64.exe
//   node scripts/checksums.js dist-desktop --pattern "Setup.*\\.exe$" --out dist-desktop/SHA256SUMS.txt
//
// 默认: 扫描目录下 PPXANS-Harness-Setup-*.exe, 输出到该目录 SHA256SUMS.txt。
// 开源发布时把安装包与 SHA256SUMS.txt 一起上传, 用户可用 certutil/sha256sum 校验。
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const args = process.argv.slice(2);
const inputs = [];
let out = "";
let pattern = "";
for (let i = 0; i < args.length; i++) {
  if (args[i] === "--out") out = args[++i] || "";
  else if (args[i] === "--pattern") pattern = args[++i] || "";
  else inputs.push(args[i]);
}
if (!inputs.length) inputs.push("dist-desktop");

const re = pattern ? new RegExp(pattern) : /^PPXANS-Harness-Setup-.*\.exe$/i;
const files = [];
let baseDir = "";
for (const input of inputs) {
  const abs = path.resolve(input);
  if (!fs.existsSync(abs)) {
    console.error(`[checksums] 找不到: ${input}`);
    process.exit(1);
  }
  if (fs.statSync(abs).isDirectory()) {
    baseDir ||= abs;
    for (const name of fs.readdirSync(abs)) {
      const f = path.join(abs, name);
      if (fs.statSync(f).isFile() && re.test(name)) files.push(f);
    }
  } else {
    baseDir ||= path.dirname(abs);
    files.push(abs);
  }
}
if (!files.length) {
  console.log("[checksums] 没有匹配的发布文件, 跳过");
  process.exit(0);
}
files.sort((a, b) => path.basename(a).localeCompare(path.basename(b)));
const lines = files.map((f) => {
  const hash = crypto.createHash("sha256").update(fs.readFileSync(f)).digest("hex");
  return `${hash}  ${path.basename(f)}`;
});
const target = path.resolve(out || path.join(baseDir, "SHA256SUMS.txt"));
fs.writeFileSync(target, lines.join("\n") + "\n", "utf8");
console.log(`[checksums] 已写入 ${target}`);
for (const line of lines) console.log(`  ${line}`);

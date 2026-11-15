// scripts/lib/readme-version-refs.js - 抽取 README 正文里的安装包文件名版本号 (纯函数, 便于测试)
//
// 动机 (2026-11-09): readme-sync 只守数字锚点与散文数字, 正文里的
//   "certutil -hashfile PPXANS-Harness-Setup-4.0.0-x64.exe" 在 package version=5.0.0 时
//   漂了一整个大版本, 闸门仍 16/16 全绿。安装包文件名同样是对外承诺, 必须进闸门。
const INSTALLER_RE = /PPXANS-Harness-Setup-(\d+\.\d+\.\d+)-/g;

export function installerVersionRefs(md) {
  return [...String(md).matchAll(INSTALLER_RE)].map((m) => m[1]);
}

export function mismatchedInstallerRefs(md, version) {
  return installerVersionRefs(md).filter((v) => v !== version);
}

// sandbox-probe/calc.js - 自修闭环探针模块 (2026-10-31)
// 故意带一个缺陷 (add 写成了减法), 供 selfiterate 自主修复演示; mul 正常。
export function add(a, b) {
  return a + b;
}

export function mul(a, b) {
  return a * b;
}

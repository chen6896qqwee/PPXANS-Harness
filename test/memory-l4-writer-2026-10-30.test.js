// test/memory-l4-writer-2026-10-30.test.js - 程序性记忆 (L4) 生产写入路径回归
//
// 背景: 存储层 (fact-store / sqlite-store) 与治理工具 (memory_clear_layer / stats.by_layer)
//   早就支持 L4, 但生产写入路径只有 L1 —— 文档里的"技能/流程长期留存"没有入口。
//   本文件锁住 memory_add 的 layer 选项: 默认 L1 不变, 显式 layer=4 才写程序性记忆,
//   且空内容/去重命中都必须给出可判读结果而不是抛异常。
import { test } from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PPXAgent } from "../src/agent/index.js";

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "ppx-mem-l4-"));

function makeAgent(root) {
  fs.mkdirSync(path.join(root, "config"), { recursive: true });
  fs.writeFileSync(path.join(root, "config", "ppx.json"),
    JSON.stringify({ channels: { http: { mcp: { enabled: false } } } }));
  return new PPXAgent({ root, dataDir: path.join(root, "data") });
}

test("memory_add: 默认写 L1, layer=4 写程序性记忆", async () => {
  const root = tmp();
  const agent = makeAgent(root);
  try {
    const a = JSON.parse(await agent.tools.call("memory_add", { content: "用户偏好浅色主题 L4-T1" }));
    assert.equal(a.ok, true);
    assert.equal(a.layer, 1, "缺省层必须是 L1 (既有调用零变化)");

    const b = JSON.parse(await agent.tools.call("memory_add", {
      content: "发布流程: 先跑 verify:full, 再打桌面包, 最后冒烟截图 L4-T2",
      layer: 4,
    }));
    assert.equal(b.ok, true);
    assert.equal(b.layer, 4, "显式 layer=4 必须落成程序性记忆");

    const stats = agent.facts.stats();
    assert.ok((stats.by_layer?.[4] || 0) >= 1, "统计数据里应出现 L4 计数");
    assert.ok((stats.by_layer?.[1] || 0) >= 1, "L1 事实仍正常写入");
  } finally {
    agent.shutdown();
  }
});

test("memory_add: 空内容与重复写入都返回可判读结果", async () => {
  const root = tmp();
  const agent = makeAgent(root);
  try {
    const empty = await agent.tools.call("memory_add", { content: "   " });
    // 参数校验层会把纯空白视为缺失, 返回 [工具错误] 文本而不是抛异常/写空记忆
    assert.match(String(empty), /工具错误|content|参数/, "空内容应返回可判读错误");

    const first = JSON.parse(await agent.tools.call("memory_add", { content: "同一条流程 L4-T3", layer: 4 }));
    assert.equal(first.layer, 4);
    const again = JSON.parse(await agent.tools.call("memory_add", { content: "同一条流程 L4-T3", layer: 4 }));
    assert.equal(again.ok, true);
    assert.equal(again.id, first.id, "去重命中应返回原记录");
    assert.equal(again.layer, 4, "不重复落条且保留原层级");
  } finally {
    agent.shutdown();
  }
});

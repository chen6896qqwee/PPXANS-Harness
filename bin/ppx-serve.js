#!/usr/bin/env node
// bin/ppx-serve.js - `ppx-serve` npm bin 入口 (纯 shebang 包装, 真正逻辑在 src/server.js)
import { runServer } from "../src/server.js";

// 以当前目录为项目根, 端口可用环境变量 PPX_PORT 覆盖 (默认 8899)
await runServer({ root: process.cwd() });
// src/memory/persona.js - 人格系统 (2026-11-12 从独立模块并入记忆域)
// 从 identity.md + ishiki.md 组装人格 prompt (设计溯源 docs/PROVENANCE.md#hanaagent)
import path from "node:path";
import { readText } from "../utils/store.js";

export class Persona {
  constructor(rootDir) {
    this.configDir = path.join(rootDir, "config");
    this.identity = readText(path.join(this.configDir, "identity.md"), "皮皮虾");
    this.ishiki = readText(path.join(this.configDir, "ishiki.md"), "- 直接、务实");
  }

  // 组装 system prompt
  systemPrompt(userName = "兄弟") {
    return `${this.identity}

## 人格定义
${this.ishiki}

## 你面对的用户
${userName}`;
  }

  reload() {
    this.identity = readText(path.join(this.configDir, "identity.md"), "皮皮虾");
    this.ishiki = readText(path.join(this.configDir, "ishiki.md"), "- 直接、务实");
  }
}

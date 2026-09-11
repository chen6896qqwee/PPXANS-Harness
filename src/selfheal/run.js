// src/selfheal/run.js - 自愈命令行入口
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Healer } from "./healer.js";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const healer = new Healer(root);
const report = healer.heal();
console.log(JSON.stringify(report, null, 2));

// src/utils/logger.js - 分级日志
const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };

let minLevel = LEVELS.info;

export function setLevel(lv) {
  if (lv in LEVELS) minLevel = LEVELS[lv];
}

function ts() {
  return new Date().toISOString();
}

export function debug(...a) { if (minLevel <= LEVELS.debug) console.log(`[${ts()}] [debug]`, ...a); }
export function info(...a)  { if (minLevel <= LEVELS.info)  console.log(`[${ts()}] [info]`, ...a); }
export function warn(...a)  { if (minLevel <= LEVELS.warn)  console.log(`[${ts()}] [warn]`, ...a); }
export function error(...a) { if (minLevel <= LEVELS.error) console.error(`[${ts()}] [error]`, ...a); }

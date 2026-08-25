import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { configFile } from "./paths.js";

/** 日志级别 → 数字，数字越大越详细 */
export const LOG_LEVELS = {
  error: 0,
  warn: 1,
  info: 2,
  debug: 3,
};

const DEFAULTS = {
  /** 自动禁用后最多重启几次（超过则放弃） */
  retryLimit: 3,
  /** 日志保留条数上限 */
  logRetention: 1000,
  /** 日志级别：error | warn | info | debug */
  logLevel: "info",
};

/**
 * 读取启动器配置，缺失字段回落到默认值。
 * @param {string} home
 * @returns {object}
 */
export function loadConfig(home) {
  const file = configFile(home);
  let stored = {};
  try {
    stored = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    // 文件不存在或损坏，用默认值
  }
  return { ...DEFAULTS, ...stored };
}

/**
 * 写回启动器配置。
 * @param {string} home
 * @param {object} config
 */
export function saveConfig(home, config) {
  const file = configFile(home);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(config, null, 2) + "\n");
}

/** 校验并规范化一个配置键值，返回 { ok, value?, error? } */
export function coerceConfigValue(key, raw) {
  if (key === "retryLimit" || key === "logRetention") {
    const n = Number(raw);
    if (!Number.isInteger(n) || n < 0) {
      return { ok: false, error: `${key} 必须是非负整数` };
    }
    return { ok: true, value: n };
  }
  if (key === "logLevel") {
    if (!(raw in LOG_LEVELS)) {
      return { ok: false, error: `logLevel 必须是 ${Object.keys(LOG_LEVELS).join(" | ")}` };
    }
    return { ok: true, value: raw };
  }
  return { ok: false, error: `未知配置项 ${key}` };
}

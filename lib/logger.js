import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { loadConfig, LOG_LEVELS } from "./config.js";
import { logFile } from "./paths.js";

/**
 * 写一条日志到启动器日志文件，并按保留上限截断。
 * @param {string} home
 * @param {string} level error | warn | info | debug
 * @param {string} message
 */
export function log(home, level, message) {
  const config = loadConfig(home);
  const threshold = LOG_LEVELS[config.logLevel] ?? LOG_LEVELS.info;
  if ((LOG_LEVELS[level] ?? 1) > threshold) return;

  const file = logFile(home);
  mkdirSync(dirname(file), { recursive: true });
  const line = `${new Date().toISOString()} [${level}] ${message}\n`;
  appendFileSync(file, line);
  trimLog(file, config.logRetention);
}

/** 截断日志文件到最多 maxLines 行（保留最新）。 */
function trimLog(file, maxLines) {
  if (!Number.isFinite(maxLines) || maxLines <= 0) return;
  let content;
  try {
    content = readFileSync(file, "utf8");
  } catch {
    return;
  }
  const lines = content.split(/\r?\n/).filter((l) => l.length > 0);
  if (lines.length <= maxLines) return;
  writeFileSync(file, lines.slice(-maxLines).join("\n") + "\n");
}

/**
 * 读取最近 N 条日志（从新到旧）。
 * @param {string} home
 * @param {number} count
 * @returns {string[]}
 */
export function readLogs(home, count = 50) {
  let content;
  try {
    content = readFileSync(logFile(home), "utf8");
  } catch {
    return [];
  }
  const lines = content.split(/\r?\n/).filter((l) => l.length > 0);
  return lines.slice(-count).reverse();
}

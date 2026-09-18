import { readdirSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { loadConfig } from "./config.js";
import { log } from "./logger.js";
import { hooksDir } from "./paths.js";

/** hook 文件扩展名：强制 ESM，避免 .js 被 Node 当成 CommonJS 解析 */
export const HOOK_EXTENSION = ".mjs";

/** 支持的事件名 */
export const HOOK_EVENTS = [
  "beforeLaunch",
  "afterExit",
  "pluginDisabled",
  "restartRequested",
];

/** config.hooks.timeoutMs 缺失时的默认超时 */
const DEFAULT_TIMEOUT_MS = 10000;

/**
 * 扫描 hooks 目录下的 hook 文件（含被禁用的），按文件名自然排序，
 * 让 2-x.mjs 排在 10-y.mjs 前面（纯字典序会反过来）。
 * 目录不存在时返回 []（等于「没有 hook」）。
 * @param {string} home
 * @param {object} [config]
 * @returns {{name: string, file: string, enabled: boolean}[]}
 */
export function scanHooks(home, config) {
  let names;
  try {
    names = readdirSync(hooksDir(home));
  } catch {
    return [];
  }
  const disabled = new Set(config?.hooks?.disabled ?? []);
  return names
    .filter((name) => name.endsWith(HOOK_EXTENSION))
    .sort((a, b) => a.localeCompare(b, "en", { numeric: true }))
    .map((name) => ({
      name,
      file: join(hooksDir(home), name),
      enabled: !disabled.has(name),
    }));
}

/**
 * 只返回启用的 hook（emitHooks 使用）。
 * 每次 emit 时重新 readdir：微秒级开销，换来「运行中丢个文件即生效」。
 * @param {string} home
 * @param {object} [config]
 * @returns {{name: string, file: string, enabled: boolean}[]}
 */
export function discoverHooks(home, config) {
  return scanHooks(home, config).filter((hook) => hook.enabled);
}

/**
 * 取某个事件的处理函数：hooks[event] 优先，default 只服务 beforeLaunch。
 * @param {object} mod 已 import 的 hook 模块
 * @param {string} event
 * @returns {Function|undefined}
 */
export function selectHandler(mod, event) {
  if (typeof mod?.hooks?.[event] === "function") return mod.hooks[event];
  if (event === "beforeLaunch" && typeof mod?.default === "function") return mod.default;
  return undefined;
}

/**
 * 加载一个 hook 文件，读出它注册了哪些事件（CLI 列表用）。
 * @param {string} file
 * @returns {Promise<{events: string[]}>}
 */
export async function inspectHook(file) {
  const mod = await import(pathToFileURL(file).href);
  return {
    events: HOOK_EVENTS.filter((event) => selectHandler(mod, event) !== undefined),
  };
}

/**
 * 跑一个 hook，带超时（超时只能放弃等待，hook 可能仍在后台跑）。
 * @returns {Promise<"ok"|"skipped">}
 */
async function runOne(home, hook, event, ctx, timeoutMs) {
  const mod = await import(pathToFileURL(hook.file).href);
  const handler = selectHandler(mod, event);
  if (handler === undefined) return "skipped";

  // 已带 [hook:<文件名>] 前缀，写进 dsh-safe 日志；hook 不要自己写 stdout
  const logger = (level, message) => log(home, level, `[hook:${hook.name}] ${message}`);

  let timer;
  try {
    await Promise.race([
      handler({ ...ctx, logger }),
      new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`hook ${hook.name} 超时（${timeoutMs}ms）`)),
          timeoutMs,
        );
        timer.unref();
      }),
    ]);
    return "ok";
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 按事件触发所有 hook（串行，顺序 = 自然排序）。
 *
 * 失败默认只记日志 + stderr 一行；仅当 hooks.failure === "abort" 且事件为
 * beforeLaunch 时抛出，由 launcher 捕获并中止启动（afterExit / pluginDisabled
 * 一律只警告）。
 *
 * @param {string} home
 * @param {string} event beforeLaunch | afterExit | pluginDisabled
 * @param {object} [ctx] 传给 hook 的上下文（缺 config 时现场 loadConfig）
 * @returns {Promise<{ran: number, failed: number}>}
 */
export async function emitHooks(home, event, ctx = {}) {
  const config = ctx.config ?? loadConfig(home);
  if (config.hooks?.enabled === false) return { ran: 0, failed: 0 };

  const timeoutMs = config.hooks?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const failures = [];
  let ran = 0;

  for (const hook of discoverHooks(home, config)) {
    try {
      const outcome = await runOne(home, hook, event, { ...ctx, event }, timeoutMs);
      if (outcome === "ok") {
        ran += 1;
        log(home, "debug", `[hook:${hook.name}] ${event} 完成`);
      }
    } catch (error) {
      failures.push({ name: hook.name, error });
      log(home, "warn", `[hook:${hook.name}] ${event} 失败：${error.message}`);
      process.stderr.write(`dsh-safe: hook ${hook.name} 失败：${error.message}\n`);
    }
  }

  if (
    failures.length > 0 &&
    config.hooks?.failure === "abort" &&
    event === "beforeLaunch"
  ) {
    throw new Error(`${failures.length} 个 hook 失败（hooks.failure=abort）`);
  }

  return { ran, failed: failures.length };
}

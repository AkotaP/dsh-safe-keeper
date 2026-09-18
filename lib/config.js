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
  /** 重启（DSH 自己请求、dsh-safe 在父进程执行，见 lib/restart.js / lib/control.js） */
  restart: {
    /** 总开关；false 时既不监听控制端口也不看请求文件 */
    enabled: true,
    /** 文件通道的轮询间隔（毫秒） */
    pollIntervalMs: 500,
    /** POSIX 上 SIGTERM 后等多久再 SIGKILL（毫秒） */
    graceMs: 5000,
    /** 重启前等待旧进程彻底退出、释放端口的时间（毫秒） */
    settleMs: 500,
    /** 单次 dsh-safe 生命周期内允许的重启次数上限；0 = 不限制 */
    maxPerSession: 0,
    /**
     * 会话内触发重启是否必须提权（默认 true）。
     *
     * 开着时：不启动控制端口、也不把 token 落盘，只能往
     * $DSH_HOME/dsh-safe/runs/<runId>/restart.request.json 写请求——而该路径在
     * DSH 工具沙箱里不可写，所以 agent 必须用 danger-full-access 申请一次批准，
     * 重启就永远过用户的明示同意。
     * 关掉后：走 loopback 控制端口，会话内可直接重启、无需批准（见 control.js）。
     */
    requireEscalation: true,
    /**
     * 重启 web profile 时追加 --no-open：GUI 页面已经在浏览器里开着，
     * 重启没必要再弹一个新窗口。首次启动不受影响；非 web profile 不追加。
     */
    noOpen: true,
  },
  /** 启动 hooks（$DSH_HOME/dsh-safe/hooks/*.mjs，见 lib/hooks.js） */
  hooks: {
    /** 总开关；false 时一个 hook 都不跑 */
    enabled: true,
    /** 单个 hook 的超时（毫秒）；超时只能放弃等待，无法取消 */
    timeoutMs: 10000,
    /** hook 失败时的行为：warn（只记日志）| abort（beforeLaunch 失败则拒绝启动） */
    failure: "warn",
    /** 被禁用的 hook 文件名（basename）列表 */
    disabled: [],
  },
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
  const merged = { ...DEFAULTS, ...stored };
  // hooks / restart 是对象：顶层浅合并会整体覆盖，这里补上缺失字段
  // （CLI 不管理这两个对象，直接编辑 JSON）
  for (const key of ["hooks", "restart"]) {
    const value = stored[key];
    if (value !== null && typeof value === "object" && !Array.isArray(value)) {
      merged[key] = { ...DEFAULTS[key], ...value };
    } else if (value !== undefined) {
      // 类型不对（字符串 / 数组 / null）时回落到完整默认值，避免下游读到脏配置
      merged[key] = { ...DEFAULTS[key] };
    }
  }
  return merged;
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

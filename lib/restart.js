import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { restartRequestFile, runDir, runRecordFile, runsDir } from "./paths.js";

/** lib/ 目录，用于推算 bin/dsh-safe.js 的位置 */
const LIB_DIR = dirname(fileURLToPath(import.meta.url));

/** 传给 DSH 的环境变量：本次运行实例 id */
export const RUN_ID_ENV = "DSH_SAFE_RUN_ID";
/** 传给 DSH 的环境变量：dsh-safe CLI 入口绝对路径（未全局安装时也能调用） */
export const BIN_ENV = "DSH_SAFE_BIN";
/**
 * DSH 自己注册进 shellEnv 的会话 id 变量名。
 * agent 的 shell 里能读到（如 `session-<uuid>`），CLI 用它给唤醒消息定位会话。
 */
export const SESSION_ID_ENV = "DSH_SESSION_ID";

/**
 * dsh-safe CLI 入口的绝对路径。
 * 通过 DSH_SAFE_BIN 传给 DSH，这样即使只是 `node bin/dsh-safe.js` 跑的，
 * 会话里的 agent 也能找到同一个 CLI。
 * @returns {string}
 */
export function dshSafeBin() {
  return resolve(join(LIB_DIR, "..", "bin", "dsh-safe.js"));
}

/** 生成一个新的运行实例 id */
export function newRunId() {
  return randomUUID();
}

/** 等待若干毫秒（不 unref：调用方正在等它，unref 会让进程提前退出） */
export function sleep(ms) {
  return new Promise((done) => setTimeout(done, ms));
}

/**
 * 开始一次运行实例记录：写 $DSH_HOME/dsh-safe/runs/<runId>/run.json。
 * 同时顺手清理已经死掉的历史实例目录（best-effort）。
 * @param {string} home
 * @param {string} runId
 * @param {{profile: string, args: string[], safe: boolean}} info
 * @returns {object} 运行记录
 */
export function beginRun(home, runId, info) {
  pruneRuns(home);
  mkdirSync(runDir(home, runId), { recursive: true });
  const record = {
    runId,
    // 记录 dsh-safe（父进程）自己的 pid：它活着，运行实例就活着
    pid: process.pid,
    startedAt: new Date().toISOString(),
    ...info,
  };
  writeFileSync(runRecordFile(home, runId), JSON.stringify(record, null, 2) + "\n");
  return record;
}

/**
 * 结束运行实例：删除运行目录（含可能残留的重启请求）。
 * @param {string} home
 * @param {string} runId
 */
export function endRun(home, runId) {
  try {
    rmSync(runDir(home, runId), { recursive: true, force: true });
  } catch {
    // 清不掉也无所谓，下次 beginRun 会 prune
  }
}

/**
 * 读取一个运行记录。
 * @param {string} home
 * @param {string} runId
 * @returns {object|null}
 */
export function readRunRecord(home, runId) {
  try {
    const parsed = JSON.parse(readFileSync(runRecordFile(home, runId), "utf8"));
    return parsed !== null && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * 列出所有运行记录（按启动时间排序）。
 * @param {string} home
 * @returns {object[]}
 */
export function listRuns(home) {
  let entries;
  try {
    entries = readdirSync(runsDir(home), { withFileTypes: true });
  } catch {
    return [];
  }
  const runs = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const record = readRunRecord(home, entry.name);
    if (record !== null) runs.push(record);
  }
  return runs.sort((a, b) => String(a.startedAt).localeCompare(String(b.startedAt)));
}

/**
 * 判断进程是否存活。pid 复用是已知限制：只用于「这个 dsh-safe 还在不在」的粗判。
 * @param {number} pid
 * @returns {boolean}
 */
export function isProcessAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error !== null && typeof error === "object" && error.code === "EPERM";
  }
}

/**
 * 把控制端口信息写进运行记录。
 *
 * 为什么必须落盘：DSH 的工具沙箱**不会**把父进程的环境变量透传给 shell 进程
 * （实测 pwsh 里只有 DSH 自己注册进 shellEnv 的 DSH_HOME / DSH_SESSION_ID /
 * DSH_SHELL / DSH_WEB_URL），所以会话内的 dsh-safe CLI 拿不到
 * DSH_SAFE_CONTROL_PORT/TOKEN，只能读这个文件。
 * @param {string} home
 * @param {string} runId
 * @param {{port: number, token: string}} control
 * @returns {object|null} 更新后的运行记录
 */
export function updateRunControl(home, runId, control) {
  const record = readRunRecord(home, runId);
  if (record === null) return null;
  record.control = { port: control.port, token: control.token };
  writeFileSync(runRecordFile(home, runId), JSON.stringify(record, null, 2) + "\n");
  return record;
}

/**
 * 读运行记录里的控制端口信息（沙箱里读文件是允许的，写才被拒）。
 * @param {string} home
 * @param {string} runId
 * @returns {{port: number, token: string}|null}
 */
export function readRunControl(home, runId) {
  const control = readRunRecord(home, runId)?.control;
  if (control === null || control === undefined || typeof control !== "object") return null;
  const port = Number(control.port);
  if (!Number.isInteger(port) || port <= 0) return null;
  if (typeof control.token !== "string" || control.token.length === 0) return null;
  return { port, token: control.token };
}

/**
 * 清理 pid 已消失的运行实例目录（best-effort）。
 * @param {string} home
 * @param {string|null} [keepRunId] 不清理这个实例
 */
export function pruneRuns(home, keepRunId = null) {
  for (const run of listRuns(home)) {
    if (run.runId === keepRunId) continue;
    if (isProcessAlive(run.pid)) continue;
    try {
      rmSync(runDir(home, run.runId), { recursive: true, force: true });
    } catch {
      // ignore
    }
  }
}

/**
 * 找出可作为重启目标的运行实例。
 * - 给定 runId 时精确匹配（不论存活）；
 * - 否则按 profile（可选）过滤，默认只要存活的。
 * @param {string} home
 * @param {{runId?: string|null, profile?: string|null, includeDead?: boolean}} [options]
 * @returns {object[]}
 */
export function findTargetRuns(home, options = {}) {
  const { runId = null, profile = null, includeDead = false } = options;
  const runs = listRuns(home);
  if (runId !== null) {
    const found = runs.find((run) => run.runId === runId);
    return found === undefined ? [] : [found];
  }
  return runs.filter(
    (run) =>
      (includeDead || isProcessAlive(run.pid)) &&
      (profile === null || run.profile === profile),
  );
}

/**
 * 写入一个重启请求文件（文件通道，供外部终端使用）。
 * @param {string} home
 * @param {string} runId
 * @param {{reason?: string|null, requester?: object}} [request]
 * @returns {object} 实际写入的内容
 */
export function writeRestartRequest(home, runId, request = {}) {
  const file = restartRequestFile(home, runId);
  mkdirSync(dirname(file), { recursive: true });
  const payload = { requestedAt: new Date().toISOString(), ...request };
  writeFileSync(file, JSON.stringify(payload, null, 2) + "\n");
  return payload;
}

/**
 * 原子取走重启请求（先 rename 再解析，避免「读到一半被写」和重复消费）。
 * @param {string} home
 * @param {string} runId
 * @returns {object|null}
 */
export function consumeRestartRequest(home, runId) {
  const file = restartRequestFile(home, runId);
  if (!existsSync(file)) return null;
  const staging = `${file}.consuming`;
  try {
    renameSync(file, staging);
  } catch {
    return null; // 已被另一个消费者取走，或文件正被写入
  }
  let parsed = null;
  try {
    parsed = JSON.parse(readFileSync(staging, "utf8"));
  } catch {
    parsed = null;
  }
  try {
    rmSync(staging, { force: true });
  } catch {
    // ignore
  }
  return parsed !== null && typeof parsed === "object" ? parsed : null;
}

/**
 * 是否已有待处理的重启请求（只判断存在性）。
 * @param {string} home
 * @param {string} runId
 * @returns {boolean}
 */
export function hasRestartRequest(home, runId) {
  return existsSync(restartRequestFile(home, runId));
}

/**
 * 轮询监听重启请求文件，每次发现都消费并回调，**持续**监听直到调用方停止。
 *
 * 必须是持续的：默认配置（restart.requireEscalation=true）下请求文件是唯一通道，
 * 同一个 dsh-safe 进程要能响应多次重启（插件开发一天重启十几次很正常）。
 * 早期版本「第一次发现就自动停止」会导致第二次重启请求没人接、DSH 永远挂着。
 *
 * 用轮询而不是 fs.watch：Windows 上 watch 对「先写后 rename」的原子写不总是可靠。
 * @param {string} home
 * @param {string} runId
 * @param {{intervalMs?: number, onRequest?: (request: object) => void}} [options]
 * @returns {() => void} 停止函数
 */
export function watchRestartRequest(home, runId, options = {}) {
  const { intervalMs = 500, onRequest } = options;
  const interval = Number.isFinite(intervalMs) ? Math.max(50, intervalMs) : 500;
  let stopped = false;
  let timer = null;

  const tick = () => {
    if (stopped) return;
    const request = consumeRestartRequest(home, runId);
    if (request !== null) onRequest?.(request);
    if (stopped) return; // onRequest 里可能已经调了停止函数
    timer = setTimeout(tick, interval);
    timer.unref?.();
  };

  timer = setTimeout(tick, interval);
  timer.unref?.();
  return () => {
    stopped = true;
    if (timer !== null) clearTimeout(timer);
  };
}

/**
 * 结束 DSH 子进程（含它派生的整棵进程树）。
 *
 * Windows：`shell: true` 时 child 是 cmd.exe，只 kill 它会留下 dsh 孤儿，
 * 所以用 `taskkill /T /F` 结束整棵树（强制；DSH 会话按消息持久化，最多丢正在写的一条）。
 * 其它平台：先 SIGTERM，宽限期后再 SIGKILL。
 * @param {import("node:child_process").ChildProcess|null} child
 * @param {{graceMs?: number}} [options]
 * @returns {boolean} 是否发出了终止动作
 */
export function terminateChild(child, options = {}) {
  const { graceMs = 5000 } = options;
  if (child === null || child === undefined) return false;
  if (child.exitCode !== null || child.signalCode !== null) return false;

  const pid = child.pid;
  if (!Number.isInteger(pid) || pid <= 0) {
    try {
      child.kill();
    } catch {
      // ignore
    }
    return false;
  }

  if (process.platform === "win32") {
    // 用 taskkill /T /F 结束整棵树（cmd.exe → dsh → 插件子进程）；
    // 失败（spawn 失败或 Access denied）时兜底 child.kill()。
    // 注意：DSH 的工具沙箱会拒绝 taskkill/TerminateProcess，但 dsh-safe 运行在
    // 沙箱之外的父进程里，真实环境不受此限制。
    const fallback = () => {
      try {
        child.kill();
      } catch {
        // ignore
      }
    };
    const killer = spawn("taskkill", ["/pid", String(pid), "/t", "/f"], { stdio: "ignore" });
    killer.on("error", fallback);
    killer.on("close", (status) => {
      if (status !== 0) fallback();
    });
    return true;
  }

  try {
    child.kill("SIGTERM");
  } catch {
    // ignore
  }
  const timer = setTimeout(() => {
    try {
      child.kill("SIGKILL");
    } catch {
      // ignore
    }
  }, Math.max(0, Number(graceMs) || 0));
  timer.unref?.();
  return true;
}

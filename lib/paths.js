import { homedir } from "node:os";
import { join, resolve } from "node:path";

/**
 * 解析 DSH 的 home 目录，与 DSH 自身的规则一致：
 * 优先 $DSH_HOME，否则 ~/.dsh。
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {string} 绝对路径
 */
export function resolveDshHome(env = process.env) {
  const fromEnv = env.DSH_HOME;
  return resolve(
    fromEnv !== undefined && fromEnv.trim().length > 0
      ? fromEnv
      : join(homedir(), ".dsh"),
  );
}

/** profile 目录：$DSH_HOME/profiles/<name> */
export function profileDir(home, name) {
  return join(home, "profiles", name);
}

/** profile 的用户禁用配置文件：$DSH_HOME/profiles/<name>/cordis.patch.yml */
export function patchFile(home, name) {
  return join(profileDir(home, name), "cordis.patch.yml");
}

/** 启动器自己的数据目录：$DSH_HOME/dsh-safe */
export function launcherDir(home) {
  return join(home, "dsh-safe");
}

/** 启动器配置文件 */
export function configFile(home) {
  return join(launcherDir(home), "config.json");
}

/** 启动 hooks 目录：$DSH_HOME/dsh-safe/hooks */
export function hooksDir(home) {
  return join(launcherDir(home), "hooks");
}

/** 启动器日志文件 */
export function logFile(home) {
  return join(launcherDir(home), "logs", "dsh-safe.log");
}

/** 启动器状态文件（记录自动禁用的插件） */
export function stateFile(home) {
  return join(launcherDir(home), "state.json");
}

/** 安全模式临时 patch 文件 */
export function safePatchFile(home) {
  return join(launcherDir(home), "safe-mode.patch.yml");
}

/** 运行实例目录：$DSH_HOME/dsh-safe/runs */
export function runsDir(home) {
  return join(launcherDir(home), "runs");
}

/** 单个运行实例目录：$DSH_HOME/dsh-safe/runs/<runId> */
export function runDir(home, runId) {
  return join(runsDir(home), runId);
}

/** 运行实例记录文件（pid / profile / args） */
export function runRecordFile(home, runId) {
  return join(runDir(home, runId), "run.json");
}

/** 文件通道的重启请求文件（外部终端用） */
export function restartRequestFile(home, runId) {
  return join(runDir(home, runId), "restart.request.json");
}

/** 全局 skill 目录：$DSH_HOME/skills（DSH 的 skill-filesystem 从这里加载） */
export function skillsDir(home) {
  return join(home, "skills");
}

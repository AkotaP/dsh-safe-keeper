import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { loadConfig } from "./config.js";
import { findFailedPlugins, getPluginMap, spawnDsh } from "./dsh.js";
import { log } from "./logger.js";
import { disablePlugin } from "./patch.js";
import { patchFile, resolveDshHome, safePatchFile } from "./paths.js";
import { listAutoDisabled, recordAutoDisabled } from "./state.js";

/**
 * DSH 自带的 bundle（安全模式保留，不禁用）。
 * 第三方插件通过 `dsh plugin add` 安装，来源 bundle 不在这个集合里。
 */
const BUILTIN_BUNDLES = new Set([
  "@deepseek-ai/dsh-base",
  "@deepseek-ai/dsh-web-app",
  "@deepseek-ai/dsh-headless",
]);

/**
 * 从插件清单里选出第三方插件的 entry id（来源 bundle 不在 BUILTIN_BUNDLES 里）。
 * @param {{id: string, name: string, source: string|null}[]} entries
 * @returns {string[]} 去重后的第三方插件 id
 */
export function selectThirdPartyIds(entries) {
  return [
    ...new Set(
      entries.filter((e) => !BUILTIN_BUNDLES.has(e.source)).map((e) => e.id),
    ),
  ];
}

/**
 * 启动 dsh，带自动禁用 + 重启。
 * @param {string} profile profile 名
 * @param {string[]} args 传给 dsh 的额外参数
 * @param {{safe?: boolean}} [options]
 * @returns {Promise<number>} 退出码
 */
export async function launch(profile, args, options = {}) {
  const home = resolveDshHome();
  const config = loadConfig(home);

  if (options.safe) {
    return launchSafe(home, profile, args);
  }

  // 用户主动 Ctrl+C / kill 时，不再自动重启
  let interrupted = false;
  const onInterrupt = () => {
    interrupted = true;
  };
  process.on("SIGINT", onInterrupt);
  process.on("SIGTERM", onInterrupt);

  const patch = patchFile(home, profile);
  let attempt = 0;

  try {
    while (true) {
      attempt += 1;
      log(home, "info", `启动 dsh --profile ${profile}（第 ${attempt} 次）`);

      const result = await spawnDsh(["--profile", profile, ...args]);

      if (result.error) {
        const msg = `找不到 dsh 命令：${result.error.message}`;
        log(home, "error", msg);
        process.stderr.write(`dsh-safe: ${msg}（请确认 dsh 已安装且在 PATH 中）\n`);
        return 1;
      }

      if (interrupted) {
        log(home, "info", "收到中断信号，停止自动重启");
        return result.code ?? 0;
      }

      if (result.code === 0) {
        log(home, "info", "dsh 正常退出（退出码 0）");
        reportAutoDisabled(home);
        return 0;
      }

      log(home, "error", `dsh 启动失败（退出码 ${result.code}）`);

      if (attempt > config.retryLimit) {
        const msg = `重试 ${config.retryLimit} 次后仍失败，放弃自动重启`;
        log(home, "error", msg);
        process.stderr.write(`dsh-safe: ${msg}，请手动处理\n`);
        return result.code ?? 1;
      }

      // 定位失败插件
      let pluginMap;
      let failedNames;
      try {
        pluginMap = await getPluginMap(profile);
        failedNames = findFailedPlugins(result.stderr, pluginMap.byName);
      } catch (error) {
        const msg = `无法获取插件清单：${error.message}`;
        log(home, "error", msg);
        process.stderr.write(`dsh-safe: ${msg}，请手动处理\n`);
        return result.code ?? 1;
      }

      if (failedNames.length === 0) {
        const msg = "无法从错误信息定位失败插件";
        log(home, "error", msg);
        process.stderr.write(`dsh-safe: ${msg}，请查看上方错误信息手动处理\n`);
        return result.code ?? 1;
      }

      // 禁用失败插件（一个模块名可能对应多个 entry id，全部禁用）
      let disabledAny = false;
      for (const name of failedNames) {
        const ids = pluginMap.byName.get(name) ?? [];
        for (const id of ids) {
          const changed = disablePlugin(patch, id, name);
          if (changed) {
            recordAutoDisabled(home, id, name);
            log(home, "warn", `已自动禁用插件 ${name}（id: ${id}）`);
            process.stderr.write(`dsh-safe: 已自动禁用 ${name}，重启中...\n`);
            disabledAny = true;
          }
        }
      }

      if (!disabledAny) {
        const msg = "失败插件已在禁用状态，但启动仍失败";
        log(home, "error", msg);
        process.stderr.write(`dsh-safe: ${msg}，请手动处理\n`);
        return result.code ?? 1;
      }
    }
  } finally {
    process.off("SIGINT", onInterrupt);
    process.off("SIGTERM", onInterrupt);
  }
}

/**
 * 安全模式：只禁用第三方插件的插件，保留 DSH 自带的 bundle，然后启动。
 * @param {string} home
 * @param {string} profile
 * @param {string[]} args
 * @returns {Promise<number>}
 */
async function launchSafe(home, profile, args) {
  let pluginMap;
  try {
    pluginMap = await getPluginMap(profile);
  } catch (error) {
    const msg = `安全模式无法获取插件清单：${error.message}`;
    log(home, "error", msg);
    process.stderr.write(`dsh-safe: ${msg}\n`);
    return 1;
  }

  // 只禁用来源是第三方 bundle 的 entry，保留 DSH 自带的
  const ids = selectThirdPartyIds(pluginMap.entries);

  if (ids.length === 0) {
    log(home, "info", "安全模式：没有第三方插件，直接启动");
    process.stderr.write("dsh-safe: 安全模式，没有第三方插件，直接启动\n");
    const result = await spawnDsh(["--profile", profile, ...args]);
    return result.code ?? 1;
  }

  const patch = safePatchFile(home);
  mkdirSync(dirname(patch), { recursive: true });
  writeFileSync(
    patch,
    ids.map((id) => `- id: ${id}\n  disabled: true\n`).join(""),
  );

  log(home, "warn", `安全模式启动：禁用 ${ids.length} 个第三方插件`);
  process.stderr.write(`dsh-safe: 安全模式，已禁用 ${ids.length} 个第三方插件\n`);

  const result = await spawnDsh(["--profile", profile, "--patch", patch, ...args]);
  return result.code ?? 1;
}

/**
 * 启动成功后，告知用户有哪些插件被自动禁用了。
 * @param {string} home
 */
function reportAutoDisabled(home) {
  const list = listAutoDisabled(home);
  if (list.length === 0) return;
  process.stderr.write(`\ndsh-safe: 以下插件因启动失败已被自动禁用：\n`);
  for (const item of list) {
    process.stderr.write(`  - ${item.name}（id: ${item.id}，${item.disabledAt}）\n`);
  }
  process.stderr.write(
    `  如需恢复，请编辑 cordis.patch.yml 删除对应条目，或运行 dsh-safe open-config\n\n`,
  );
}

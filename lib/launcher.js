import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { loadConfig } from "./config.js";
import { CONTROL_PORT_ENV, CONTROL_TOKEN_ENV, startControlServer } from "./control.js";
import { findFailedPlugins, getPluginMap, readProfileBundles, spawnDsh } from "./dsh.js";
import { emitHooks } from "./hooks.js";
import { createWebUrlScanner, deliverWake, readWake } from "./wake.js";
import { log } from "./logger.js";
import { disablePlugin } from "./patch.js";
import { patchFile, profileDir, resolveDshHome, safePatchFile } from "./paths.js";
import {
  BIN_ENV,
  RUN_ID_ENV,
  beginRun,
  dshSafeBin,
  endRun,
  newRunId,
  sleep,
  terminateChild,
  updateRunControl,
  watchRestartRequest,
} from "./restart.js";
import { listAutoDisabled, recordAutoDisabled } from "./state.js";

/**
 * DSH 官方组织 scope：profile bundles 里 @deepseek-ai/* 视为 DSH 自带（安全模式保留）。
 */
const BUILTIN_SCOPE = "@deepseek-ai/";

/**
 * 回退白名单：读不到 profile 的 dsh.profile.bundles 时使用（DSH 自带 bundle 的硬编码）。
 */
const BUILTIN_BUNDLES = new Set([
  "@deepseek-ai/dsh-base",
  "@deepseek-ai/dsh-web-app",
  "@deepseek-ai/dsh-headless",
]);

/**
 * 从插件清单里选出第三方插件的 entry id。
 * @param {{id: string, name: string, source: string|null}[]} entries
 * @param {Set<string>|null} thirdPartyBundles 第三方 bundle 集合；
 *   null 表示读不到 profile bundles，回退到硬编码白名单判定
 * @returns {string[]} 去重后的第三方插件 id
 */
export function selectThirdPartyIds(entries, thirdPartyBundles) {
  return [
    ...new Set(
      entries
        .filter((e) => {
          if (e.source === null) return true; // 无来源注释，保守视为第三方
          if (thirdPartyBundles == null) return !BUILTIN_BUNDLES.has(e.source);
          return thirdPartyBundles.has(e.source);
        })
        .map((e) => e.id),
    ),
  ];
}

/**
 * 判断插件模块名是否为 DSH 自带（框架内置 cordis:* 或官方 @deepseek-ai/* scope）。
 * 自带插件启动失败不自动禁用（禁了可能连锁破坏），提示手动处理。
 * @param {string} name 插件模块名
 * @returns {boolean}
 */
export function isBuiltinModule(name) {
  return name.startsWith("cordis:") || name.startsWith("@deepseek-ai/");
}

/** 官方 web bundle 名（--no-open 由它的 web-startup 插件注册） */
export const WEB_BUNDLE = "@deepseek-ai/dsh-web-app";

/**
 * 判断 profile 是不是 web（读 profile 的 dsh.profile.bundles）。
 * 只有 web profile 认识 `--no-open`；给 headless 传它会变成未知参数直接报错，
 * 所以重启时是否补参数必须先判断。
 * @param {string} home
 * @param {string} profile
 * @returns {boolean}
 */
export function isWebProfile(home, profile) {
  const bundles = readProfileBundles(profileDir(home, profile));
  return bundles !== null && bundles.includes(WEB_BUNDLE);
}

/**
 * 计算某一次启动实际用的参数。
 *
 * 重启（用户主动或 dsh-safe 自动）时给 web profile 补 `--no-open`：
 * GUI 页面已经在浏览器里开着，重启再弹一个新窗口只会添乱。首次启动不受影响，
 * 非 web profile 也不补（`--no-open` 只由 web-app bundle 注册）。
 *
 * @param {string[]} args 用户传给 dsh 的参数（不含 --profile）
 * @param {{isRestart?: boolean, noOpen?: boolean, webProfile?: boolean}} options
 * @returns {string[]}
 */
export function buildRestartArgs(args, options = {}) {
  const { isRestart = false, noOpen = true, webProfile = false } = options;
  if (!isRestart || !noOpen || !webProfile) return [...args];
  if (args.includes("--no-open")) return [...args];
  return [...args, "--no-open"];
}

/** 重启前等待旧进程退出的毫秒数（配置容错） */
function settleMsOf(config) {
  const value = Number(config?.restart?.settleMs);
  return Number.isFinite(value) && value >= 0 ? value : 500;
}

/** POSIX 上 SIGTERM 后的宽限期（配置容错） */
function graceMsOf(config) {
  const value = Number(config?.restart?.graceMs);
  return Number.isFinite(value) && value > 0 ? value : 5000;
}

/** 取出待处理的重启请求并清空槽位 */
function takePending(state) {
  const request = state.pending;
  state.pending = null;
  return request;
}

/** 终止当前 DSH 子进程（若在跑） */
function killCurrent(state, config) {
  terminateChild(state.child, { graceMs: graceMsOf(config) });
}

/**
 * 武装一次唤醒投递：从新 DSH 的 stdout 扫出带 token 的 web URL，再用它换 cookie、
 * 调 `session/prompt` 把唤醒消息投回会话。
 *
 * 只在重启请求带了 `--wake` 时才武装；**任何失败都只记日志降级**，不影响启动。
 * @param {string} home
 * @param {{sessionId: string, text: string}} wake
 * @returns {{forwardStdout: boolean, onStdout: (chunk: unknown) => void}}
 */
function armWakeDelivery(home, wake) {
  const scan = createWebUrlScanner();
  let fired = false;
  return {
    forwardStdout: true,
    onStdout: (chunk) => {
      if (fired) return;
      const found = scan(chunk);
      if (found === null) return;
      fired = true;
      deliverWake({ url: found.url, sessionId: wake.sessionId, text: wake.text })
        .then((result) => {
          if (result.ok === true) {
            log(home, "info", `已投递唤醒消息（会话 ${wake.sessionId}）`);
            process.stderr.write(`dsh-safe: 已把唤醒消息投递回会话 ${wake.sessionId}\n`);
          } else {
            log(home, "warn", `唤醒消息投递失败（已降级）：${result.error}`);
            process.stderr.write(`dsh-safe: 唤醒消息投递失败（已降级，不影响启动）：${result.error}\n`);
          }
        })
        .catch((error) => {
          log(home, "warn", `唤醒消息投递异常（已降级）：${error.message}`);
        });
    },
  };
}

/**
 * 处理一个已经消费掉的重启请求：计数 / 上限 / 日志 / hook / 等待旧进程退出。
 *
 * 关键：重启**不算启动失败**，不触发插件自动禁用，也不消耗 retryLimit。
 * @param {string} home
 * @param {object} config
 * @param {object} ctx
 * @param {object} request
 * @param {{restarts: number}} state
 * @returns {Promise<"restart"|"stop">}
 */
async function consumeRestart(home, config, ctx, request, state) {
  state.restarts += 1;

  const reason = typeof request?.reason === "string" && request.reason.length > 0
    ? request.reason
    : "（未填写原因）";
  const via = request?.via ?? "unknown";
  const max = Number(config?.restart?.maxPerSession) || 0;

  log(home, "info", `收到重启请求（via ${via}，原因：${reason}），重启 DSH`);

  if (max > 0 && state.restarts > max) {
    const msg = `重启次数超过上限 restart.maxPerSession=${max}，停止重启`;
    log(home, "error", msg);
    process.stderr.write(`dsh-safe: ${msg}，请检查插件是否在启动时反复请求重启\n`);
    return "stop";
  }

  process.stderr.write(`dsh-safe: 收到重启请求，正在重启 DSH...（原因：${reason}）\n`);

  await emitHooks(home, "restartRequested", {
    ...ctx,
    reason: request?.reason ?? null,
    requestedAt: request?.requestedAt ?? null,
    requester: request?.requester ?? null,
    via,
  });

  // 等旧进程彻底退出、释放监听端口，避免重启后 EADDRINUSE 被误判为插件故障
  await sleep(settleMsOf(config));
  return "restart";
}

/**
 * 启动 dsh，带自动禁用 + 重启。
 * @param {string} profile profile 名
 * @param {string[]} args 传给 dsh 的额外参数
 * @param {{safe?: boolean, runId?: string}} [options]
 * @returns {Promise<number>} 退出码
 */
export async function launch(profile, args, options = {}) {
  const home = resolveDshHome();
  const config = loadConfig(home);
  const safe = options.safe === true;
  const restartConfig = config.restart ?? {};
  const runId = options.runId ?? newRunId();

  beginRun(home, runId, { profile, args, safe });

  // 用户主动 Ctrl+C / kill 时，不再自动重启
  let interrupted = false;
  const onInterrupt = () => {
    interrupted = true;
  };
  process.on("SIGINT", onInterrupt);
  process.on("SIGTERM", onInterrupt);

  // 重启请求的汇合点：控制端口（socket）和请求文件（file）都往这里投递
  const restartState = { pending: null, child: null };
  const takeRestart = (request) => {
    if (restartState.pending !== null) return; // 已有待处理请求，忽略重复投递
    restartState.pending = request;
    killCurrent(restartState, config);
  };

  let control = null;
  let stopFileWatch = () => {};
  if (restartConfig.enabled !== false) {
    // 请求文件通道始终监听：外部终端、以及会话内提权后的写入都靠它
    stopFileWatch = watchRestartRequest(home, runId, {
      intervalMs: restartConfig.pollIntervalMs,
      onRequest: (request) => takeRestart({ ...request, via: "file" }),
    });

    if (restartConfig.requireEscalation !== false) {
      // 默认：会话内触发必须提权（写 $DSH_HOME 会被沙箱拒绝 → 需要 danger-full-access 批准）。
      // 因此不开控制端口、也不把 token 落盘，避免留一条不需要批准的旁路。
      log(
        home,
        "info",
        "重启需要提权：不启动控制端口，会话内触发走请求文件（需 danger-full-access 批准）",
      );
    } else {
      try {
        control = await startControlServer({
          onRequest: (message) => {
            takeRestart({
              requestedAt: message.requestedAt ?? new Date().toISOString(),
              reason: typeof message.reason === "string" ? message.reason : null,
              requester: { pid: message.pid ?? null },
              wake: message.wake ?? null,
              via: "socket",
            });
          },
        });
        // 落盘：会话内的 CLI 读不到 DSH_SAFE_CONTROL_* 环境变量，靠这份记录找到控制端口
        updateRunControl(home, runId, control);
      } catch (error) {
        control = null;
        const msg = `控制端口启动失败（${error.message}），会话内触发将退回请求文件通道`;
        log(home, "warn", msg);
        process.stderr.write(`dsh-safe: ${msg}\n`);
      }
    }
  }


  const childEnv = {
    [RUN_ID_ENV]: runId,
    [BIN_ENV]: dshSafeBin(),
    ...(control === null
      ? {}
      : { [CONTROL_PORT_ENV]: String(control.port), [CONTROL_TOKEN_ENV]: control.token }),
  };

  // 重启时是否补 --no-open 取决于 profile（只读一次）
  const webProfile = isWebProfile(home, profile);

  try {
    if (safe) {
      return await launchSafe(home, config, profile, args, {
        childEnv,
        restartState,
        webProfile,
        isInterrupted: () => interrupted,
      });
    }
    return await launchNormal(home, config, profile, args, {
      childEnv,
      restartState,
      webProfile,
      isInterrupted: () => interrupted,
    });
  } finally {
    stopFileWatch();
    control?.close();
    endRun(home, runId);
    process.off("SIGINT", onInterrupt);
    process.off("SIGTERM", onInterrupt);
  }
}

/**
 * 正常模式：失败 → 定位并禁用插件 → 重试；重启请求 → 原样重启。
 * @param {string} home
 * @param {object} config
 * @param {string} profile
 * @param {string[]} args
 * @param {{childEnv: object, restartState: object, webProfile: boolean, isInterrupted: () => boolean}} context
 * @returns {Promise<number>}
 */
async function launchNormal(home, config, profile, args, context) {
  const { childEnv, restartState, webProfile, isInterrupted } = context;
  const patch = patchFile(home, profile);
  const restartStats = { restarts: 0 };
  let attempt = 0;
  let failures = 0;
  let lastCode = 0;
  /** 刚消费掉的重启请求里的唤醒消息，下一次 spawn 时投递 */
  let pendingWake = null;

  while (true) {
    attempt += 1;
    const wake = pendingWake;
    pendingWake = null;
    const ctx = {
      home,
      profile,
      profileDir: profileDir(home, profile),
      args,
      safe: false,
      attempt,
      config,
    };

    // 请求可能在两次尝试之间到达：先消化，避免刚拉起就被杀掉
    const early = takePending(restartState);
    if (early !== null) {
      if ((await consumeRestart(home, config, ctx, early, restartStats)) === "stop") {
        return lastCode;
      }
      pendingWake = readWake(early);
      continue;
    }

    const dshArgs = [
      "--profile",
      profile,
      ...buildRestartArgs(args, {
        isRestart: restartStats.restarts > 0,
        noOpen: config.restart?.noOpen !== false,
        webProfile,
      }),
    ];

    const { aborted, result } = await spawnWithHooks(home, ctx, dshArgs, {
      env: childEnv,
      onChild: (child) => {
        restartState.child = child;
        if (restartState.pending !== null) killCurrent(restartState, config);
      },
      ...(wake === null ? {} : armWakeDelivery(home, wake)),
    });
    restartState.child = null;
    if (aborted) return 1;

    if (result.error) {
      const msg = `找不到 dsh 命令：${result.error.message}`;
      log(home, "error", msg);
      process.stderr.write(`dsh-safe: ${msg}（请确认 dsh 已安装且在 PATH 中）\n`);
      return 1;
    }

    if (isInterrupted()) {
      log(home, "info", "收到中断信号，停止自动重启");
      return result.code ?? 0;
    }

    // 重启优先于退出码判定：被我们终止的进程退出码必然非 0，不能当失败处理
    const restart = takePending(restartState);
    if (restart !== null) {
      lastCode = result.code ?? 0;
      if ((await consumeRestart(home, config, ctx, restart, restartStats)) === "stop") {
        return lastCode;
      }
      pendingWake = readWake(restart);
      continue;
    }

    if (result.code === 0) {
      log(home, "info", "dsh 正常退出（退出码 0）");
      reportAutoDisabled(home);
      return 0;
    }

    lastCode = result.code ?? 1;
    failures += 1;
    log(home, "error", `dsh 启动失败（退出码 ${result.code}）`);

    if (failures > config.retryLimit) {
      const msg = `重试 ${config.retryLimit} 次后仍失败，放弃自动重启`;
      log(home, "error", msg);
      process.stderr.write(`dsh-safe: ${msg}，请手动处理\n`);
      return lastCode;
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
      return lastCode;
    }

    if (failedNames.length === 0) {
      const msg = "无法从错误信息定位失败插件";
      log(home, "error", msg);
      process.stderr.write(`dsh-safe: ${msg}，请查看上方错误信息手动处理\n`);
      return lastCode;
    }

    // 禁用失败插件（一个模块名可能对应多个 entry id，全部禁用）
    // 自带插件（cordis:* / @deepseek-ai/*）不自动禁用，提示手动处理
    let disabledAny = false;
    const skipped = [];
    for (const name of failedNames) {
      if (isBuiltinModule(name)) {
        skipped.push(name);
        continue;
      }
      const ids = pluginMap.byName.get(name) ?? [];
      for (const id of ids) {
        const changed = disablePlugin(patch, id, name);
        if (changed) {
          recordAutoDisabled(home, id, name);
          log(home, "warn", `已自动禁用插件 ${name}（id: ${id}）`);
          process.stderr.write(`dsh-safe: 已自动禁用 ${name}，重启中...\n`);
          disabledAny = true;
          await emitHooks(home, "pluginDisabled", {
            ...ctx,
            pluginId: id,
            pluginName: name,
          });
        }
      }
    }

    if (skipped.length > 0) {
      const msg = `以下 DSH 自带插件启动失败，未自动禁用（请升级 DSH 或检查配置后手动处理）：${skipped.join(", ")}`;
      log(home, "error", msg);
      process.stderr.write(`dsh-safe: ${msg}\n`);
    }

    if (!disabledAny) {
      const msg =
        skipped.length > 0
          ? "失败插件均为 DSH 自带，未自动禁用，请手动处理"
          : "失败插件已在禁用状态，但启动仍失败";
      log(home, "error", msg);
      process.stderr.write(`dsh-safe: ${msg}\n`);
      return lastCode;
    }
  }
}

/**
 * 安全模式：只禁用第三方插件的插件，保留 DSH 自带的 bundle，然后启动。
 * 安全模式不自动禁用重试（一次性恢复手段），但同样支持重启请求。
 * @param {string} home
 * @param {object} config
 * @param {string} profile
 * @param {string[]} args
 * @param {{childEnv: object, restartState: object, webProfile: boolean, isInterrupted: () => boolean}} context
 * @returns {Promise<number>}
 */
async function launchSafe(home, config, profile, args, context) {
  const { childEnv, restartState, webProfile, isInterrupted } = context;

  let pluginMap;
  try {
    pluginMap = await getPluginMap(profile);
  } catch (error) {
    const msg = `安全模式无法获取插件清单：${error.message}`;
    log(home, "error", msg);
    process.stderr.write(`dsh-safe: ${msg}\n`);
    return 1;
  }

  // 动态判定第三方 bundle：读 profile 的 dsh.profile.bundles，
  // 非 @deepseek-ai/* scope 的视为第三方；读不到时回退硬编码白名单
  const bundles = readProfileBundles(profileDir(home, profile));
  let thirdPartyBundles = null;
  if (bundles !== null) {
    thirdPartyBundles = new Set(
      bundles.filter((b) => !b.startsWith(BUILTIN_SCOPE)),
    );
  }

  // 只禁用来源是第三方 bundle 的 entry，保留 DSH 自带的
  const ids = selectThirdPartyIds(pluginMap.entries, thirdPartyBundles);

  let baseArgs;
  if (ids.length === 0) {
    log(home, "info", "安全模式：没有第三方插件，直接启动");
    process.stderr.write("dsh-safe: 安全模式，没有第三方插件，直接启动\n");
    baseArgs = ["--profile", profile, ...args];
  } else {
    const patch = safePatchFile(home);
    mkdirSync(dirname(patch), { recursive: true });
    writeFileSync(
      patch,
      ids.map((id) => `- id: ${id}\n  disabled: true\n`).join(""),
    );
    log(home, "warn", `安全模式启动：禁用 ${ids.length} 个第三方插件`);
    process.stderr.write(`dsh-safe: 安全模式，已禁用 ${ids.length} 个第三方插件\n`);
    baseArgs = ["--profile", profile, "--patch", patch, ...args];
  }

  const restartStats = { restarts: 0 };
  let attempt = 0;
  let lastCode = 1;
  /** 刚消费掉的重启请求里的唤醒消息，下一次 spawn 时投递 */
  let pendingWake = null;

  while (true) {
    attempt += 1;
    const wake = pendingWake;
    pendingWake = null;
    const ctx = {
      home,
      profile,
      profileDir: profileDir(home, profile),
      args,
      safe: true,
      attempt,
      config,
    };

    const early = takePending(restartState);
    if (early !== null) {
      if ((await consumeRestart(home, config, ctx, early, restartStats)) === "stop") {
        return lastCode;
      }
      pendingWake = readWake(early);
      continue;
    }

    const dshArgs = buildRestartArgs(baseArgs, {
      isRestart: restartStats.restarts > 0,
      noOpen: config.restart?.noOpen !== false,
      webProfile,
    });

    const { aborted, result } = await spawnWithHooks(home, ctx, dshArgs, {
      env: childEnv,
      onChild: (child) => {
        restartState.child = child;
        if (restartState.pending !== null) killCurrent(restartState, config);
      },
      ...(wake === null ? {} : armWakeDelivery(home, wake)),
    });
    restartState.child = null;
    if (aborted) return 1;

    if (result.error) {
      const msg = `找不到 dsh 命令：${result.error.message}`;
      log(home, "error", msg);
      process.stderr.write(`dsh-safe: ${msg}（请确认 dsh 已安装且在 PATH 中）\n`);
      return 1;
    }

    if (isInterrupted()) {
      log(home, "info", "收到中断信号，停止自动重启");
      return result.code ?? 0;
    }

    const restart = takePending(restartState);
    if (restart !== null) {
      lastCode = result.code ?? 1;
      if ((await consumeRestart(home, config, ctx, restart, restartStats)) === "stop") {
        return lastCode;
      }
      pendingWake = readWake(restart);
      continue;
    }

    return result.code ?? 1;
  }
}

/**
 * emit beforeLaunch；hooks.failure=abort 且失败时返回 false，由调用方中止启动。
 * @param {string} home
 * @param {object} ctx
 * @returns {Promise<boolean>} 是否可以继续启动
 */
async function emitBeforeLaunch(home, ctx) {
  try {
    await emitHooks(home, "beforeLaunch", ctx);
    return true;
  } catch (error) {
    const msg = `beforeLaunch hook 失败并中止启动：${error.message}`;
    log(home, "error", msg);
    process.stderr.write(`dsh-safe: ${msg}\n`);
    return false;
  }
}

/**
 * spawn DSH 并发出 beforeLaunch / afterExit，所有启动路径（正常 + 安全模式）共用，
 * 避免漏点。afterExit 一律只警告，不影响退出码。
 *
 * 注意：绝不能把 emit 放进 lib/dsh.js 的 spawnDsh——getPluginMap() 复用它跑
 * `dsh --dump-config`，会导致「启动失败 → 取清单」递归触发 hook，最坏死循环。
 * @param {string} home
 * @param {object} ctx
 * @param {string[]} dshArgs
 * @param {{env?: object, onChild?: (child: object) => void}} [spawnOptions]
 * @returns {Promise<{aborted: boolean, result?: object}>}
 */
async function spawnWithHooks(home, ctx, dshArgs, spawnOptions = {}) {
  if (!(await emitBeforeLaunch(home, ctx))) return { aborted: true };

  log(home, "info", `启动 dsh --profile ${ctx.profile}（第 ${ctx.attempt} 次）`);
  const result = await spawnDsh(dshArgs, spawnOptions);

  try {
    await emitHooks(home, "afterExit", {
      ...ctx,
      code: result.code,
      stderr: result.stderr,
    });
  } catch (error) {
    log(home, "warn", `afterExit hook 失败：${error.message}`);
  }
  return { aborted: false, result };
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

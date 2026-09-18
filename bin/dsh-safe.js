#!/usr/bin/env node
import { spawn } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { coerceConfigValue, loadConfig, saveConfig } from "../lib/config.js";
import { CONTROL_PORT_ENV, CONTROL_TOKEN_ENV, sendControlRequest } from "../lib/control.js";
import { emitHooks, HOOK_EVENTS, inspectHook, scanHooks } from "../lib/hooks.js";
import { launch } from "../lib/launcher.js";
import { readLogs } from "../lib/logger.js";
import { hooksDir, patchFile, resolveDshHome, skillsDir } from "../lib/paths.js";
import {
  BIN_ENV,
  RUN_ID_ENV,
  findTargetRuns,
  hasRestartRequest,
  SESSION_ID_ENV,
  isProcessAlive,
  listRuns,
  readRunControl,
  writeRestartRequest,
} from "../lib/restart.js";

/** bin/ 目录，用于定位随包分发的 skills/ */
const BIN_DIR = dirname(fileURLToPath(import.meta.url));
/** 随 dsh-safe 分发的 skill 目录 */
const BUNDLED_SKILLS_DIR = resolve(join(BIN_DIR, "..", "skills"));

const HELP = `dsh-safe — DSH 启动器：自动禁用启动失败的插件并重启

用法：
  dsh-safe <profile> [args...]            正常启动（自动禁用 + 重启）
  dsh-safe --safe <profile> [args...]     安全模式（禁用所有插件）
  dsh-safe config                         查看配置
  dsh-safe config set <key> <value>       修改配置
  dsh-safe logs [N]                       查看最近 N 条日志（默认 50）
  dsh-safe open-config <profile>          在文件管理器中打开禁用配置文件
  dsh-safe restart [选项]                 请父进程安全重启当前 DSH
  dsh-safe status                         查看运行实例、控制通道与待处理重启请求
  dsh-safe skill [list]                   列出随包分发的 skill 及安装状态
  dsh-safe skill install [name...]        把 skill 安装到 $DSH_HOME/skills
  dsh-safe hooks                          列出 hooks 目录里的脚本与事件
  dsh-safe hooks run <event>              手动触发一个事件（调试）
  dsh-safe hooks dir                      在文件管理器中打开 hooks 目录
  dsh-safe --help                         显示帮助

重启：
  dsh-safe restart 由正在运行的 dsh-safe 父进程执行重启，DSH 自己不需要也没有
  权力 kill 自己。默认配置（restart.requireEscalation=true）下，会话内触发只走
  请求文件：workspace-write 沙箱会拒绝写 $DSH_HOME，agent 需用 danger-full-access
  申请一次批准；若当前策略已放开写入（danger-full-access），则一步到位、无需批准。
  外部终端不受沙箱限制，可直接走请求文件通道。两种方式都会让 DSH 按原
  profile / 参数重新启动。
    --reason <文本>   记录重启原因
    --wake <文本>     重启成功后把这句话作为用户消息投回同一会话（让 agent 接着干）；
                      留空则不投递；投递失败只记日志降级，不影响启动
    --dry-run         只显示目标实例、重启通道与唤醒消息，不发请求
    --profile <name>  多个实例时按 profile 选择
    --run <runId>     多个实例时按 runId 选择

  配置项 restart（对象）：enabled / requireEscalation / pollIntervalMs /
  graceMs / settleMs / maxPerSession / noOpen，直接编辑 config.json。
  requireEscalation=false 时改用 loopback 控制端口，会话内重启无需提权。
  重启 web profile 会自动补 --no-open，不会又弹一个浏览器窗口。

配置项：
  retryLimit    自动禁用后最多重启次数（默认 3）
  logRetention  日志保留条数上限（默认 1000）
  logLevel      日志级别 error|warn|info|debug（默认 info）

启动 hooks：
  往 $DSH_HOME/dsh-safe/hooks/ 丢 *.mjs 文件即生效，事件见 dsh-safe hooks。
  hooks 的配置（enabled / timeoutMs / failure / disabled）直接编辑 config.json，
  或运行 dsh-safe config 查看当前值。

事件：
  beforeLaunch      每次真正启动 DSH 之前（failure=abort 时可阻止启动）
  afterExit         DSH 进程退出之后（附加 code / stderr）
  pluginDisabled    自动禁用某个插件成功之后（附加 pluginId / pluginName）
  restartRequested  收到重启请求、旧 DSH 已终止之后（附加 reason / via 等）
`;

function printHelp() {
  process.stdout.write(HELP);
}

function handleConfig(args) {
  const home = resolveDshHome();
  if (args.length === 0) {
    process.stdout.write(JSON.stringify(loadConfig(home), null, 2) + "\n");
    return;
  }
  if (args[0] === "set" && args.length === 3) {
    const key = args[1];
    const raw = args[2];
    const result = coerceConfigValue(key, raw);
    if (!result.ok) {
      process.stderr.write(`dsh-safe: ${result.error}\n`);
      process.exit(1);
    }
    const config = loadConfig(home);
    config[key] = result.value;
    saveConfig(home, config);
    process.stdout.write(`dsh-safe: 已设置 ${key} = ${JSON.stringify(result.value)}\n`);
    return;
  }
  process.stderr.write("dsh-safe: 用法 config [set <key> <value>]\n");
  process.exit(1);
}

function handleLogs(args) {
  const home = resolveDshHome();
  const count = args[0] !== undefined ? Number(args[0]) : 50;
  if (!Number.isInteger(count) || count <= 0) {
    process.stderr.write("dsh-safe: logs 的参数必须是正整数\n");
    process.exit(1);
  }
  const lines = readLogs(home, count);
  if (lines.length === 0) {
    process.stdout.write("（暂无日志）\n");
    return;
  }
  for (const line of lines) process.stdout.write(line + "\n");
}

function openInFileManager(file) {
  const abs = resolve(file);
  if (process.platform === "win32") {
    spawn("explorer.exe", [`/select,${abs}`], { detached: true, stdio: "ignore" }).unref();
  } else if (process.platform === "darwin") {
    spawn("open", ["-R", abs], { detached: true, stdio: "ignore" }).unref();
  } else {
    spawn("xdg-open", [dirname(abs)], { detached: true, stdio: "ignore" }).unref();
  }
}

function openDirectory(dir) {
  const abs = resolve(dir);
  if (process.platform === "win32") {
    spawn("explorer.exe", [abs], { detached: true, stdio: "ignore" }).unref();
  } else if (process.platform === "darwin") {
    spawn("open", [abs], { detached: true, stdio: "ignore" }).unref();
  } else {
    spawn("xdg-open", [abs], { detached: true, stdio: "ignore" }).unref();
  }
}

function handleOpenConfig(args) {
  const home = resolveDshHome();
  const profile = args[0];
  if (profile === undefined) {
    const dir = join(home, "profiles");
    const profiles = existsSync(dir)
      ? readdirSync(dir, { withFileTypes: true })
          .filter((d) => d.isDirectory())
          .map((d) => d.name)
      : [];
    if (profiles.length === 0) {
      process.stderr.write("dsh-safe: 没有找到任何 profile\n");
      process.exit(1);
    }
    process.stderr.write(`dsh-safe: 请指定 profile：${profiles.join(", ")}\n`);
    process.exit(1);
  }
  const file = patchFile(home, profile);
  if (!existsSync(file)) {
    process.stderr.write(`dsh-safe: 配置文件不存在：${file}\n`);
    process.exit(1);
  }
  openInFileManager(file);
  process.stdout.write(`dsh-safe: 已在文件管理器中打开 ${file}\n`);
}


const RESTART_USAGE =
  "用法：dsh-safe restart [--reason <文本>] [--wake <文本>] [--dry-run] [--profile <name>] [--run <runId>]";

/**
 * 选一个重启目标实例。给定 --run 时精确匹配；否则在存活实例里按 profile 过滤。
 * @returns {{ok: true, run: object} | {ok: false, error: string}}
 */
function locateRestartTarget(home, options) {
  const { runId, profile } = options;
  const runs = findTargetRuns(home, { runId, profile });

  if (runs.length === 0) {
    const error =
      runId !== null
        ? `没有找到 run ${runId}（对应的 dsh-safe 可能已退出）`
        : profile !== null
          ? `没有找到 profile=${profile} 的运行中实例`
          : "没有找到由 dsh-safe 启动并仍在运行的 DSH 实例";
    return { ok: false, error };
  }
  if (runs.length > 1) {
    const list = runs
      .map((run) => `  run ${run.runId}  profile ${run.profile}  pid ${run.pid}`)
      .join("\n");
    return {
      ok: false,
      error: `检测到多个运行中实例，请用 --run 或 --profile 指定：\n${list}`,
    };
  }
  const run = runs[0];
  if (!isProcessAlive(run.pid)) {
    return { ok: false, error: `实例 run ${run.runId}（pid ${run.pid}）已退出，无法重启` };
  }
  return { ok: true, run };
}

function reportRestartSent(options) {
  const { runId, profile, via, reason } = options;
  process.stdout.write(
    `dsh-safe: 已发送重启请求（${via}）→ profile=${profile}` +
      `${runId === null ? "" : ` run=${runId}`}` +
      `${reason === null ? "" : `，原因：${reason}`}\n`,
  );
  process.stdout.write(
    "dsh-safe: 当前 DSH 即将退出并按原参数重启；若你在 DSH 会话里，这一轮对话/工具调用会中断，重连后继续。\n",
  );
}

/**
 * 请求父进程重启当前 DSH。
 *
 * 两条通道：
 *  1. 控制端口（127.0.0.1 + token）——DSH 工具沙箱里唯一可用的通道，
 *     因为沙箱只允许写工作区和会话临时目录，写 $DSH_HOME 会被拒绝；
 *  2. 运行目录里的请求文件——外部终端（不受沙箱限制）使用。
 */
async function handleRestart(args) {
  const home = resolveDshHome();
  let reason = null;
  let runId = process.env[RUN_ID_ENV] ?? null;
  let profile = null;
  let dryRun = false;
  let wakeText = null;

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "--reason" && i + 1 < args.length) reason = args[++i];
    else if (arg === "--wake" && i + 1 < args.length) wakeText = args[++i];
    else if (arg === "--run" && i + 1 < args.length) runId = args[++i];
    else if (arg === "--profile" && i + 1 < args.length) profile = args[++i];
    else if (arg === "--dry-run") dryRun = true;
    else {
      process.stderr.write(`dsh-safe: ${RESTART_USAGE}\n`);
      process.exit(1);
    }
  }

  const config = loadConfig(home);
  // --wake 留空 → wake === null，完全不走投递流程
  const { wake, warning } = buildWake(wakeText);
  if (warning !== null) process.stderr.write(`dsh-safe: ${warning}\n`);
  if (wake !== null && !dryRun) {
    process.stdout.write(
      `dsh-safe: 重启请求成功后，会把唤醒消息投回会话 ${wake.sessionId}（失败会降级，不影响启动）。\n`,
    );
  }
  // 默认 true：会话内触发必须提权——不用控制端口，逼出一次 danger-full-access 批准
  const requireEscalation = config.restart?.requireEscalation !== false;

  // 控制端口来源：环境变量（DSH 若能透传）优先，其次运行记录里的 control 块；
  // DSH 沙箱不透传父进程 env，所以只有 requireEscalation=false 时才可能用到。
  const envPort = Number(process.env[CONTROL_PORT_ENV]);
  const envToken = process.env[CONTROL_TOKEN_ENV];
  const envControl =
    Number.isInteger(envPort) && envPort > 0 && typeof envToken === "string" && envToken.length > 0
      ? { port: envPort, token: envToken }
      : null;

  let socketError = null;

  if (!requireEscalation && envControl !== null) {
    if (dryRun) {
      process.stdout.write(
        `dsh-safe: [dry-run] 会通过环境里的控制端口 127.0.0.1:${envControl.port} 请求重启` +
          `${runId === null ? "" : `（run ${runId}）`}\n`,
      );
      return;
    }
    const response = await sendControlRequest({
      port: envControl.port,
      token: envControl.token,
      action: "restart",
      reason,
      wake,
    });
    if (response.ok === true) {
      reportRestartSent({
        runId,
        profile: profile ?? "(由父进程决定)",
        via: "控制端口（env）",
        reason,
      });
      return;
    }
    socketError = response.error ?? "未知错误";
    process.stderr.write(`dsh-safe: 环境里的控制端口请求失败（${socketError}），继续尝试运行记录\n`);
  }

  const located = locateRestartTarget(home, { runId, profile });
  if (!located.ok) {
    process.stderr.write(`dsh-safe: ${located.error}\n`);
    if (socketError !== null) {
      process.stderr.write(`dsh-safe: 之前的控制端口也失败：${socketError}\n`);
    }
    if (runId === null) {
      process.stderr.write(
        `dsh-safe: 当前 DSH 不是由 dsh-safe 启动的（环境里没有 ${RUN_ID_ENV}，运行目录里也没有存活实例），无法在会话内安全重启。\n` +
          "  请先退出当前 DSH，在外部终端用 dsh-safe <profile> 重新启动一次；之后本会话就能直接重启了。\n",
      );
    }
    process.exit(1);
  }
  const target = located.run;
  const control = requireEscalation ? null : readRunControl(home, target.runId);

  if (dryRun) {
    const via = requireEscalation
      ? "请求文件（requireEscalation=true；写 $DSH_HOME 是否被拦取决于 DSH 文件策略）"
      : control === null
        ? "请求文件（没有控制端口）"
        : `控制端口 127.0.0.1:${control.port}`;
    process.stdout.write(
      `dsh-safe: [dry-run] 目标 run ${target.runId}  profile ${target.profile}  pid ${target.pid}  重启通道 ${via}` +
        `  唤醒消息 ${wake === null ? "无" : `→ ${wake.sessionId}`}\n`,
    );
    return;
  }

  if (control !== null) {
    const response = await sendControlRequest({
      port: control.port,
      token: control.token,
      action: "restart",
      reason,
      wake,
    });
    if (response.ok === true) {
      reportRestartSent({ runId: target.runId, profile: target.profile, via: "控制端口", reason });
      return;
    }
    socketError = response.error ?? "未知错误";
    process.stderr.write(`dsh-safe: 控制端口请求失败（${socketError}），尝试请求文件\n`);
  }

  try {
    writeRestartRequest(home, target.runId, {
      reason,
      requester: { pid: process.pid, cwd: process.cwd() },
      wake,
    });
  } catch (error) {
    process.stderr.write(`dsh-safe: 写入重启请求失败：${error.message}\n`);
    if (requireEscalation) {
      process.stderr.write(
        "dsh-safe: 这是预期结果——restart.requireEscalation=true 时会话内重启必须提权。\n" +
          '  请用完全相同的命令重试一次，并带上 sandbox_permissions: "danger-full-access" 与一句 justification，\n' +
          "  由用户批准后即可写入请求文件并重启。\n",
      );
    }
    if (socketError !== null) {
      process.stderr.write(`dsh-safe: 控制端口也失败：${socketError}\n`);
    }
    process.exit(1);
  }
  reportRestartSent({ runId: target.runId, profile: target.profile, via: "请求文件", reason });
}

/**
 * 组装 `--wake` 载荷。留空 → `null`（不走投递流程）；带内容但环境里没有会话 id
 * → 也返回 `null` 并给出告警（降级：照常重启，只是不投递）。
 * @param {string|null} text
 * @returns {{wake: {sessionId: string, text: string}|null, warning: string|null}}
 */
function buildWake(text) {
  if (typeof text !== "string" || text.trim().length === 0) return { wake: null, warning: null };
  const sessionId = (process.env[SESSION_ID_ENV] ?? "").trim();
  if (sessionId === "") {
    return {
      wake: null,
      warning: `带 --wake 但环境里没有 ${SESSION_ID_ENV}，无法定位会话，本次不投递唤醒消息`,
    };
  }
  return { wake: { sessionId, text: text.trim() }, warning: null };
}

/** 探测一个运行实例的控制通道（ping 不会触发重启） */
async function probeControl(control) {
  if (control === null) return "未启用（没有控制端口）";
  const response = await sendControlRequest({
    port: control.port,
    token: control.token,
    action: "ping",
    timeoutMs: 1000,
  });
  return response.ok === true
    ? `可用（127.0.0.1:${control.port}）`
    : `不可用（${response.error ?? "未知错误"}）`;
}

/** 列出运行中的实例、控制通道与待处理的重启请求 */
async function handleStatus() {
  const home = resolveDshHome();
  const config = loadConfig(home);
  const restartConfig = config.restart ?? {};
  const runs = listRuns(home);
  const envRunId = process.env[RUN_ID_ENV] ?? null;

  if (runs.length === 0) {
    process.stdout.write("dsh-safe: 没有运行中的实例。\n");
    if (envRunId !== null) {
      process.stdout.write(
        `dsh-safe: 当前环境带 ${RUN_ID_ENV}=${envRunId}，但没有对应运行目录。\n`,
      );
    }
    return;
  }

  process.stdout.write(`dsh-safe: ${runs.length} 个运行实例：\n`);
  for (const run of runs) {
    const alive = isProcessAlive(run.pid);
    const pending = hasRestartRequest(home, run.runId);
    const mark = run.runId === envRunId ? " ← 当前会话" : "";
    let channel;
    if (restartConfig.enabled === false) {
      channel = "重启已禁用（restart.enabled=false）";
    } else if (!alive) {
      channel = "—（已退出）";
    } else if (restartConfig.requireEscalation !== false) {
      channel = "请求文件（requireEscalation=true；写 $DSH_HOME 是否真被拦取决于 DSH 文件策略）";
    } else {
      channel = await probeControl(readRunControl(home, run.runId));
    }
    process.stdout.write(
      `  run ${run.runId}${mark}\n` +
        `    profile ${run.profile}   pid ${run.pid}   ${alive ? "存活" : "已退出"}\n` +
        `    args ${JSON.stringify(run.args ?? [])}   safe ${run.safe === true}\n` +
        `    启动于 ${run.startedAt}   待处理重启请求 ${pending ? "有" : "无"}\n` +
        `    重启通道 ${channel}\n`,
    );
  }
}

/** 读 SKILL.md 的 description（frontmatter），失败返回空串 */
function readSkillDescription(file) {
  try {
    const text = readFileSync(file, "utf8");
    const match = /^description:\s*"?(.+?)"?\s*$/m.exec(text);
    return match === null ? "" : match[1];
  } catch {
    return "";
  }
}

/** 随包分发的 skill 列表 */
function listBundledSkills() {
  let entries;
  try {
    entries = readdirSync(BUNDLED_SKILLS_DIR, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => ({ name: entry.name, dir: join(BUNDLED_SKILLS_DIR, entry.name) }))
    .filter((skill) => existsSync(join(skill.dir, "SKILL.md")))
    .map((skill) => ({
      ...skill,
      description: readSkillDescription(join(skill.dir, "SKILL.md")),
    }));
}

/** dsh-safe skill：列出 / 安装随包分发的 skill */
function handleSkill(args) {
  const home = resolveDshHome();
  const sub = args[0] ?? "list";
  if (sub !== "list" && sub !== "install" && sub !== "path") {
    process.stderr.write(`dsh-safe: ${SKILL_USAGE}\n`);
    process.exit(1);
  }

  let force = false;
  let project = null;
  const names = [];
  const flags = args.slice(1);
  for (let i = 0; i < flags.length; i += 1) {
    const arg = flags[i];
    if (arg === "--force") force = true;
    else if (arg === "--project") project = i + 1 < flags.length ? flags[++i] : ".";
    else if (arg.startsWith("--")) {
      process.stderr.write(`dsh-safe: ${SKILL_USAGE}\n`);
      process.exit(1);
    } else names.push(arg);
  }

  const targetRoot = project === null ? skillsDir(home) : resolve(project, ".dsh", "skills");

  if (sub === "path") {
    process.stdout.write(`dsh-safe: skill 目标目录：${targetRoot}\n`);
    return;
  }

  const bundled = listBundledSkills();
  if (bundled.length === 0) {
    process.stderr.write(
      `dsh-safe: 没有找到随包分发的 skill（期望目录：${BUNDLED_SKILLS_DIR}）\n`,
    );
    process.exit(1);
  }

  if (sub === "list") {
    process.stdout.write(`dsh-safe: 随包 skill（目标目录：${targetRoot}）：\n`);
    for (const skill of bundled) {
      const installed = existsSync(join(targetRoot, skill.name, "SKILL.md"));
      process.stdout.write(`  [${installed ? "已安装" : "未安装"}] ${skill.name}\n`);
      if (skill.description.length > 0) process.stdout.write(`      ${skill.description}\n`);
    }
    process.stdout.write("安装：dsh-safe skill install [name...]\n");
    return;
  }

  const selected =
    names.length === 0
      ? bundled
      : names.map((name) => {
          const found = bundled.find((skill) => skill.name === name);
          if (found === undefined) {
            process.stderr.write(`dsh-safe: 没有随包分发名为 ${name} 的 skill\n`);
            process.exit(1);
          }
          return found;
        });

  mkdirSync(targetRoot, { recursive: true });
  for (const skill of selected) {
    const dest = join(targetRoot, skill.name);
    if (existsSync(dest) && !force) {
      process.stdout.write(`dsh-safe: 已存在，跳过 ${skill.name}（加 --force 覆盖）\n`);
      continue;
    }
    try {
      cpSync(skill.dir, dest, { recursive: true, force: true });
    } catch (error) {
      process.stderr.write(`dsh-safe: 安装 ${skill.name} 失败：${error.message}\n`);
      process.stderr.write(
        `  目标目录 ${dest} 需要写权限；DSH 工具沙箱下会被拒绝，请在外部终端执行本命令。\n`,
      );
      process.exitCode = 1;
      continue;
    }
    process.stdout.write(`dsh-safe: 已安装 ${skill.name} → ${dest}\n`);
  }
  process.stdout.write(
    "dsh-safe: DSH 的 skill 目录会被实时监听，通常无需重启；若列表里没出现，重新载入会话即可。\n",
  );
}

async function handleHooks(args) {
  const home = resolveDshHome();
  const config = loadConfig(home);
  const dir = hooksDir(home);
  const sub = args[0];

  if (sub === "dir") {
    mkdirSync(dir, { recursive: true }); // 目录不存在时先建，方便直接丢脚本
    openDirectory(dir);
    process.stdout.write(`dsh-safe: 已在文件管理器中打开 ${dir}\n`);
    return;
  }

  if (sub === "run") {
    const event = args[1];
    if (event === undefined || !HOOK_EVENTS.includes(event)) {
      process.stderr.write(
        `dsh-safe: 用法 hooks run <event>，event 取 ${HOOK_EVENTS.join(" | ")}\n`,
      );
      process.exit(1);
    }
    // 调试用的假 ctx：attempt=1，其余字段按事件补齐
    const ctx = {
      home,
      profile: "(manual)",
      profileDir: null,
      args: [],
      safe: false,
      attempt: 1,
      config,
    };
    if (event === "afterExit") {
      ctx.code = 0;
      ctx.stderr = "";
    }
    if (event === "pluginDisabled") {
      ctx.pluginId = "(manual)";
      ctx.pluginName = "(manual)";
    }
    if (event === "restartRequested") {
      ctx.reason = "(manual)";
      ctx.requestedAt = new Date().toISOString();
      ctx.requester = { pid: process.pid };
      ctx.via = "manual";
    }
    const { ran, failed } = await emitHooks(home, event, ctx);
    process.stdout.write(`dsh-safe: ${event} 触发完成：${ran} 个成功，${failed} 个失败\n`);
    return;
  }

  if (sub !== undefined) {
    process.stderr.write("dsh-safe: 用法 hooks [run <event> | dir]\n");
    process.exit(1);
  }

  const hooks = scanHooks(home, config);
  if (hooks.length === 0) {
    process.stdout.write(`（没有发现 hook）\n目录：${dir}\n`);
    return;
  }
  process.stdout.write(`hooks 目录：${dir}\n`);
  for (const hook of hooks) {
    let events = "加载失败";
    try {
      const info = await inspectHook(hook.file);
      events = info.events.length > 0 ? info.events.join(", ") : "（未注册任何事件）";
    } catch (error) {
      events = `加载失败：${error.message}`;
    }
    process.stdout.write(`  [${hook.enabled ? "启用" : "禁用"}] ${hook.name}  →  ${events}\n`);
  }
}

const args = process.argv.slice(2);

if (args.length === 0 || args[0] === "--help" || args[0] === "-h") {
  printHelp();
  process.exit(0);
}

const cmd = args[0];

if (cmd === "config") {
  handleConfig(args.slice(1));
} else if (cmd === "logs") {
  handleLogs(args.slice(1));
} else if (cmd === "open-config") {
  handleOpenConfig(args.slice(1));
} else if (cmd === "restart") {
  await handleRestart(args.slice(1));
} else if (cmd === "status") {
  await handleStatus();
} else if (cmd === "skill") {
  handleSkill(args.slice(1));
} else if (cmd === "hooks") {
  await handleHooks(args.slice(1));
} else {
  let safe = false;
  let rest = args;
  if (rest[0] === "--safe") {
    safe = true;
    rest = rest.slice(1);
  }
  const profile = rest[0];
  if (profile === undefined) {
    printHelp();
    process.exit(1);
  }
  const code = await launch(profile, rest.slice(1), { safe });
  process.exit(code);
}

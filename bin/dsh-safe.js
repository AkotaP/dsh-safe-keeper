#!/usr/bin/env node
import { spawn } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { coerceConfigValue, loadConfig, saveConfig } from "../lib/config.js";
import { launch } from "../lib/launcher.js";
import { readLogs } from "../lib/logger.js";
import { patchFile, resolveDshHome } from "../lib/paths.js";

const HELP = `dsh-safe — DSH 启动器：自动禁用启动失败的插件并重启

用法：
  dsh-safe <profile> [args...]            正常启动（自动禁用 + 重启）
  dsh-safe --safe <profile> [args...]     安全模式（禁用所有插件）
  dsh-safe config                         查看配置
  dsh-safe config set <key> <value>       修改配置
  dsh-safe logs [N]                       查看最近 N 条日志（默认 50）
  dsh-safe open-config <profile>          在文件管理器中打开禁用配置文件
  dsh-safe --help                         显示帮助

配置项：
  retryLimit    自动禁用后最多重启次数（默认 3）
  logRetention  日志保留条数上限（默认 1000）
  logLevel      日志级别 error|warn|info|debug（默认 info）
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

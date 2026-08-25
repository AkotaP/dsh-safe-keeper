import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * 运行一次 dsh 命令。
 *
 * @param {string[]} args dsh 的参数（不含 "dsh" 本身）
 * @param {object} [options]
 * @param {boolean} [options.captureStdout] 是否捕获 stdout（默认透传）
 * @param {boolean} [options.forwardStderr] 是否把 stderr 实时转发到父进程（默认 true）
 * @returns {Promise<{code: number|null, stdout: string, stderr: string, error?: Error}>}
 */
export function spawnDsh(args, options = {}) {
  const { captureStdout = false, forwardStderr = true } = options;
  return new Promise((resolve) => {
    // Windows 上 npm 的 bin 是 .cmd shim，需要 shell 解释（与 dsh 自身 spawn pnpm 的方式一致）
    const child = spawn("dsh", args, {
      shell: process.platform === "win32",
      stdio: ["inherit", captureStdout ? "pipe" : "inherit", "pipe"],
    });

    let stdout = "";
    let stderr = "";

    if (captureStdout) {
      child.stdout.on("data", (chunk) => {
        stdout += chunk;
      });
    }
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
      if (forwardStderr) process.stderr.write(chunk);
    });

    child.on("error", (error) => {
      resolve({ code: null, stdout, stderr, error });
    });
    child.on("close", (code) => {
      resolve({ code, stdout, stderr });
    });
  });
}

/**
 * 运行 `dsh --profile <name> --dump-config` 并解析出插件清单。
 * @param {string} profile
 * @returns {Promise<{entries: {id: string, name: string}[], byName: Map<string, string[]>}>}
 */
export async function getPluginMap(profile) {
  const result = await spawnDsh(
    ["--profile", profile, "--dump-config"],
    { captureStdout: true, forwardStderr: false },
  );
  if (result.code !== 0) {
    const err = new Error(
      `dsh --dump-config 失败（退出码 ${result.code}）：${result.stderr.trim()}`,
    );
    err.code = "DUMP_CONFIG_FAILED";
    throw err;
  }
  return parseDumpConfig(result.stdout);
}

/**
 * 从 `--dump-config` 的 YAML 输出里提取插件清单。
 * 只依赖 DSH 自己生成的稳定格式：每个 entry 以 `- id: xxx` 开头，紧跟 `name: 'yyy'`，
 * 其来源 bundle 由前面的 `# == <bundle名>` 注释标明。
 * 注意：同一个模块名可能对应多个 entry（例如 tool-subagent 有 spawn/fork 两个 id），
 * 所以返回 entries 列表 + name → id[] 映射，而不是 name → id 单值映射。
 * @param {string} output
 * @returns {{entries: {id: string, name: string, source: string|null}[], byName: Map<string, string[]>}}
 */
export function parseDumpConfig(output) {
  const entries = [];
  const byName = new Map();
  const lines = output.split(/\r?\n/);
  let currentId = null;
  let currentSource = null;
  for (const line of lines) {
    // 来源注释：# == <bundle名> 或 # == <bundle名>, patched by <bundle名>
    const sourceMatch = /^# == (.+)$/.exec(line);
    if (sourceMatch) {
      currentSource = sourceMatch[1].split(",")[0].trim();
      continue;
    }
    const idMatch = /^- id: (.+)$/.exec(line);
    if (idMatch) {
      currentId = idMatch[1].trim();
      continue;
    }
    const nameMatch = /^\s+name: (.+)$/.exec(line);
    if (nameMatch && currentId !== null) {
      let name = nameMatch[1].trim();
      if (
        (name.startsWith("'") && name.endsWith("'")) ||
        (name.startsWith('"') && name.endsWith('"'))
      ) {
        name = name.slice(1, -1);
      }
      entries.push({ id: currentId, name, source: currentSource });
      const ids = byName.get(name) ?? [];
      ids.push(currentId);
      byName.set(name, ids);
      currentId = null;
    }
  }
  return { entries, byName };
}

/**
 * 从 dsh 启动失败的 stderr 里提取失败插件的模块名。
 * 覆盖 DSH 的三种稳定错误格式：
 *   1. `failed to import/apply loader entry <id> (<name>): ...`
 *   2. `plugin(s) failed to load: <name1>, <name2>`
 *   3. `<name>: <error>` 行
 * @param {string} stderr
 * @param {Map<string, string[]>} byName 已知插件名 → id[] 映射（用于过滤误匹配）
 * @returns {string[]} 失败插件的模块名（去重）
 */
export function findFailedPlugins(stderr, byName) {
  const found = new Set();

  // 格式 1：failed to import/apply loader entry <id> (<name>)
  const entryRe = /loader entry [^\s(]+ \(([^)]+)\)/g;
  let m;
  while ((m = entryRe.exec(stderr)) !== null) {
    if (byName.has(m[1])) found.add(m[1]);
  }

  // 格式 2：plugin(s) failed to load: <name1>, <name2>
  const loadMatch = /plugin\(s\) failed to load:\s*([^\n;]+)/.exec(stderr);
  if (loadMatch) {
    for (const raw of loadMatch[1].split(",")) {
      const name = raw.trim();
      if (byName.has(name)) found.add(name);
    }
  }

  // 格式 3：<name>: <error> 行
  for (const line of stderr.split(/\r?\n/)) {
    const lm = /^\s*(@[\w-]+\/[\w-]+|[\w-]+):\s/.exec(line);
    if (lm && byName.has(lm[1])) found.add(lm[1]);
  }

  return [...found];
}

/**
 * 读 profile 的 package.json 里的 dsh.profile.bundles（该 profile 的 bundle 层清单）。
 * 官方模板自带 @deepseek-ai/* bundle，其余是用户通过 `dsh plugin add` 添加的。
 * @param {string} profileDir profile 目录
 * @returns {string[]|null} bundle 名数组；文件缺失或格式不符时返回 null
 */
export function readProfileBundles(profileDir) {
  try {
    const manifest = JSON.parse(
      readFileSync(join(profileDir, "package.json"), "utf8"),
    );
    const bundles = manifest.dsh?.profile?.bundles;
    return Array.isArray(bundles) ? bundles : null;
  } catch {
    return null;
  }
}

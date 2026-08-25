import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getPluginMap } from "../lib/dsh.js";
import { launch } from "../lib/launcher.js";
import { patchFile } from "../lib/paths.js";

const home = mkdtempSync(join(tmpdir(), "dsh-safe-launch-"));
process.env.DSH_HOME = home;
console.log("临时 DSH_HOME:", home);

try {
  // 1. 初始化 headless profile（dump-config 会自动初始化）
  console.log("\n[1] 初始化 headless profile");
  await getPluginMap("headless");

  // 2. 注入一个指向不存在模块的 broken-plugin（用 insert 新增，触发 import 失败）
  const patch = patchFile(home, "headless");
  const before = readFileSync(patch, "utf8");
  const injected = before.replace(
    /\[\]\s*$/,
    "- insert:\n    - id: broken-plugin\n      name: '@deepseek-ai/this-plugin-does-not-exist'\n",
  );
  writeFileSync(patch, injected);
  console.log("[2] 已注入 broken-plugin");

  // 3. 设置 retryLimit=1（第一次失败→禁用→重启一次）
  const cfgDir = join(home, "dsh-safe");
  mkdirSync(cfgDir, { recursive: true });
  writeFileSync(join(cfgDir, "config.json"), JSON.stringify({ retryLimit: 1 }));

  // 4. 跑 launch
  console.log("\n[3] 开始 launch（headless，任务 hello）");
  const code = await launch("headless", ["hello"]);
  console.log(`\n[4] launch 返回退出码: ${code}`);

  // 5. 验证 cordis.patch.yml 被写入了禁用条目
  const after = readFileSync(patch, "utf8");
  const disabled = after.includes("broken-plugin") && /disabled:\s*true/.test(after);
  console.log("\n[5] cordis.patch.yml 最终内容：");
  console.log(after);
  console.log(`\n[6] 验证：broken-plugin 已被自动禁用 = ${disabled}`);
  if (!disabled) process.exitCode = 1;
} finally {
  rmSync(home, { recursive: true, force: true });
}

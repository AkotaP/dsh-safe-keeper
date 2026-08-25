import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getPluginMap, spawnDsh } from "../lib/dsh.js";

const home = mkdtempSync(join(tmpdir(), "dsh-safe-it-"));
process.env.DSH_HOME = home;
console.log("临时 DSH_HOME:", home);

try {
  console.log("\n[1] 测试 spawnDsh 跑 --dump-config（捕获 stdout）");
  const dump = await spawnDsh(["--profile", "web", "--dump-config"], {
    captureStdout: true,
    forwardStderr: false,
  });
  console.log("  退出码:", dump.code);
  console.log("  stdout 长度:", dump.stdout.length);
  console.log("  stderr 前 200 字:", dump.stderr.slice(0, 200).replace(/\n/g, "\\n"));

  console.log("\n[2] 测试 getPluginMap 解析");
  const map = await getPluginMap("web");
  console.log("  插件数量:", map.size);
  console.log("  样例:", [...map.entries()].slice(0, 5));
  console.log("  含 timer:", map.get("@deepseek-ai/cordis-plugin-timer"));
} catch (error) {
  console.error("集成测试失败:", error);
  process.exitCode = 1;
} finally {
  rmSync(home, { recursive: true, force: true });
}

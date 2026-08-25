import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getPluginMap } from "../lib/dsh.js";
import { launch } from "../lib/launcher.js";

const home = mkdtempSync(join(tmpdir(), "dsh-safe-safe-"));
process.env.DSH_HOME = home;

try {
  const { entries } = await getPluginMap("headless");
  console.log("headless 插件总数:", entries.length);
  const sources = new Map();
  for (const e of entries) {
    sources.set(e.source, (sources.get(e.source) ?? 0) + 1);
  }
  console.log("来源 bundle 分布:", [...sources.entries()]);

  console.log("\n=== 跑安全模式（headless 无第三方插件，应直接启动）===");
  const code = await launch("headless", ["hello"], { safe: true });
  console.log("安全模式退出码:", code);
} finally {
  rmSync(home, { recursive: true, force: true });
}

import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discoverHooks, emitHooks, inspectHook, scanHooks, selectHandler } from "../lib/hooks.js";
import { hooksDir } from "../lib/paths.js";

/** 本文件创建的临时 home，跑完统一清理 */
const createdHomes = [];

function makeHome() {
  const home = mkdtempSync(join(tmpdir(), "dsh-safe-hooks-"));
  createdHomes.push(home);
  return home;
}

function writeHook(home, name, source) {
  mkdirSync(hooksDir(home), { recursive: true });
  writeFileSync(join(hooksDir(home), name), source);
}

/** 只构造 hooks 段：路径与日志都由 home 自行解析 */
function cfg(overrides = {}) {
  return {
    hooks: {
      enabled: true,
      timeoutMs: 2000,
      failure: "warn",
      disabled: [],
      ...overrides,
    },
  };
}

const tests = [];
function test(name, fn) {
  tests.push([name, fn]);
}

console.log("scanHooks / discoverHooks");

test("目录缺失时返回空列表", () => {
  const home = makeHome();
  assert.deepEqual(scanHooks(home, cfg()), []);
  assert.deepEqual(discoverHooks(home, cfg()), []);
});

test("只收 .mjs，且按自然排序（2- 在 10- 之前）", () => {
  const home = makeHome();
  writeHook(home, "10-late.mjs", "export default () => {};\n");
  writeHook(home, "2-early.mjs", "export default () => {};\n");
  writeHook(home, "skip.js", "module.exports = {};\n");
  writeHook(home, "note.txt", "hi\n");
  assert.deepEqual(
    scanHooks(home, cfg()).map((hook) => hook.name),
    ["2-early.mjs", "10-late.mjs"],
  );
});

test("config.hooks.disabled 只过滤指定文件", () => {
  const home = makeHome();
  writeHook(home, "a.mjs", "export default () => {};\n");
  writeHook(home, "b.mjs", "export default () => {};\n");
  const config = cfg({ disabled: ["a.mjs"] });
  assert.deepEqual(
    scanHooks(home, config).map((hook) => `${hook.name}:${hook.enabled}`),
    ["a.mjs:false", "b.mjs:true"],
  );
  assert.deepEqual(
    discoverHooks(home, config).map((hook) => hook.name),
    ["b.mjs"],
  );
});

console.log("selectHandler");

test("hooks[event] 优先，default 只服务 beforeLaunch", () => {
  const hooksObj = { beforeLaunch() {}, afterExit() {} };
  const multi = { hooks: hooksObj, default() {} };
  assert.equal(selectHandler(multi, "beforeLaunch"), hooksObj.beforeLaunch);
  assert.equal(selectHandler(multi, "afterExit"), hooksObj.afterExit);
  assert.equal(selectHandler(multi, "pluginDisabled"), undefined);

  const onlyDefault = { default() {} };
  assert.equal(typeof selectHandler(onlyDefault, "beforeLaunch"), "function");
  assert.equal(selectHandler(onlyDefault, "afterExit"), undefined);
  assert.equal(selectHandler({}, "beforeLaunch"), undefined);
});

console.log("inspectHook / emitHooks");

test("inspectHook 读出注册的事件", async () => {
  const home = makeHome();
  writeHook(
    home,
    "multi.mjs",
    "export const hooks = { beforeLaunch() {}, pluginDisabled() {} };\n",
  );
  const info = await inspectHook(join(hooksDir(home), "multi.mjs"));
  assert.deepEqual(info.events, ["beforeLaunch", "pluginDisabled"]);
});

test("串行执行（顺序 = 文件名顺序），ctx 字段齐全", async () => {
  const home = makeHome();
  writeHook(
    home,
    "1-a.mjs",
    `import { appendFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
export default async (ctx) => {
  appendFileSync(join(ctx.home, "order.log"), "1-a\\n");
  writeFileSync(join(ctx.home, "ctx.json"), JSON.stringify({
    event: ctx.event,
    home: ctx.home,
    profile: ctx.profile,
    profileDir: ctx.profileDir,
    args: ctx.args,
    safe: ctx.safe,
    attempt: ctx.attempt,
    hasConfig: typeof ctx.config === "object",
    logger: typeof ctx.logger,
  }));
};
`,
  );
  writeHook(
    home,
    "2-b.mjs",
    `import { appendFileSync } from "node:fs";
import { join } from "node:path";
export default (ctx) => appendFileSync(join(ctx.home, "order.log"), "2-b\\n");
`,
  );

  const { ran, failed } = await emitHooks(home, "beforeLaunch", {
    home,
    profile: "web",
    profileDir: join(home, "profiles", "web"),
    args: ["--no-open"],
    safe: false,
    attempt: 1,
    config: cfg(),
  });

  assert.equal(ran, 2);
  assert.equal(failed, 0);
  assert.equal(readFileSync(join(home, "order.log"), "utf8"), "1-a\n2-b\n");

  const ctx = JSON.parse(readFileSync(join(home, "ctx.json"), "utf8"));
  assert.equal(ctx.event, "beforeLaunch");
  assert.equal(ctx.home, home);
  assert.equal(ctx.profile, "web");
  assert.equal(ctx.profileDir, join(home, "profiles", "web"));
  assert.deepEqual(ctx.args, ["--no-open"]);
  assert.equal(ctx.safe, false);
  assert.equal(ctx.attempt, 1);
  assert.equal(ctx.hasConfig, true);
  assert.equal(ctx.logger, "function");
});

test("handler 抛错：warn 模式不抛，abort 只作用于 beforeLaunch", async () => {
  const home = makeHome();
  writeHook(
    home,
    "boom.mjs",
    `export default () => {
  throw new Error("boom");
};
export const hooks = {
  afterExit: () => {
    throw new Error("after-boom");
  },
};
`,
  );

  const warn = await emitHooks(home, "beforeLaunch", { home, config: cfg() });
  assert.equal(warn.failed, 1);

  await assert.rejects(
    () => emitHooks(home, "beforeLaunch", { home, config: cfg({ failure: "abort" }) }),
    /hooks\.failure=abort/,
  );

  const after = await emitHooks(home, "afterExit", { home, config: cfg({ failure: "abort" }) });
  assert.equal(after.failed, 1);
});

test("超时：放弃等待并计入失败（不抛出）", async () => {
  const home = makeHome();
  writeHook(home, "slow.mjs", "export default () => new Promise((r) => setTimeout(r, 300));\n");
  const { ran, failed } = await emitHooks(home, "beforeLaunch", {
    home,
    config: cfg({ timeoutMs: 20 }),
  });
  assert.equal(ran, 0);
  assert.equal(failed, 1);
});

test("hooks.enabled=false：hook 完全不被加载", async () => {
  const home = makeHome();
  writeHook(
    home,
    "marker.mjs",
    `import { writeFileSync } from "node:fs";
import { join } from "node:path";
export default (ctx) => writeFileSync(join(ctx.home, "ran.txt"), "ran");
`,
  );
  const { ran } = await emitHooks(home, "beforeLaunch", { home, config: cfg({ enabled: false }) });
  assert.equal(ran, 0);
  assert.equal(existsSync(join(home, "ran.txt")), false);
});

test("afterExit 附加 code/stderr，pluginDisabled 附加插件信息", async () => {
  const home = makeHome();
  writeHook(
    home,
    "capture.mjs",
    `import { appendFileSync } from "node:fs";
import { join } from "node:path";
export const hooks = {
  afterExit: (ctx) => appendFileSync(join(ctx.home, "events.log"), \`afterExit:\${ctx.code}:\${ctx.stderr}\\n\`),
  pluginDisabled: (ctx) => appendFileSync(join(ctx.home, "events.log"), \`pluginDisabled:\${ctx.pluginId}:\${ctx.pluginName}\\n\`),
};
`,
  );

  await emitHooks(home, "afterExit", { home, config: cfg(), code: 3, stderr: "oops" });
  await emitHooks(home, "pluginDisabled", {
    home,
    config: cfg(),
    pluginId: "modlens",
    pluginName: "@liustack/modlens",
  });

  const lines = readFileSync(join(home, "events.log"), "utf8").trim().split("\n");
  assert.deepEqual(lines, ["afterExit:3:oops", "pluginDisabled:modlens:@liustack/modlens"]);
});

let passed = 0;
try {
  for (const [name, fn] of tests) {
    await fn();
    passed += 1;
    console.log(`  ✓ ${name}`);
  }
} finally {
  for (const home of createdHomes) rmSync(home, { recursive: true, force: true });
}

console.log(`\n全部通过：${passed} 个测试`);

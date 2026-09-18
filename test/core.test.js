import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findFailedPlugins, parseDumpConfig, readProfileBundles } from "../lib/dsh.js";
import {
  buildRestartArgs,
  isBuiltinModule,
  isWebProfile,
  selectThirdPartyIds,
} from "../lib/launcher.js";
import { loadConfig } from "../lib/config.js";
import { disablePlugin, isDisabled } from "../lib/patch.js";

let passed = 0;
function test(name, fn) {
  fn();
  passed += 1;
  console.log(`  ✓ ${name}`);
}

console.log("parseDumpConfig");
test("解析 id 和带引号的 name", () => {
  const out = `# == @deepseek-ai/dsh-base
- id: timer
  name: '@deepseek-ai/cordis-plugin-timer'
- id: hmr
  name: '@deepseek-ai/cordis-plugin-hmr'
  config:
    root:
      - .
  disabled: true
- id: session-persistence-jsonl
  name: '@deepseek-ai/dsh-session-persistence-jsonl'
  config:
    root: !!js dshHomePath('sessions')
`;
  const { entries, byName } = parseDumpConfig(out);
  assert.equal(byName.get("@deepseek-ai/cordis-plugin-timer")[0], "timer");
  assert.equal(byName.get("@deepseek-ai/cordis-plugin-hmr")[0], "hmr");
  assert.equal(byName.get("@deepseek-ai/dsh-session-persistence-jsonl")[0], "session-persistence-jsonl");
  assert.equal(entries.length, 3);
});

test("解析不带引号的 name", () => {
  const out = `- id: foo
  name: plainname
`;
  const { byName } = parseDumpConfig(out);
  assert.equal(byName.get("plainname")[0], "foo");
});

test("同一 name 对应多个 id", () => {
  const out = `- id: tool-subagent
  name: '@deepseek-ai/dsh-tool-subagent'
- id: tool-subagent-fork
  name: '@deepseek-ai/dsh-tool-subagent'
`;
  const { entries, byName } = parseDumpConfig(out);
  assert.deepEqual(byName.get("@deepseek-ai/dsh-tool-subagent"), ["tool-subagent", "tool-subagent-fork"]);
  assert.equal(entries.length, 2);
});

test("解析来源 bundle 注释", () => {
  const out = `# == @deepseek-ai/dsh-base
- id: timer
  name: '@deepseek-ai/cordis-plugin-timer'
# == @liustack/modlens
- id: modlens
  name: '@liustack/modlens'
# == @deepseek-ai/dsh-base, patched by @deepseek-ai/dsh-web-app
- id: hmr
  name: '@deepseek-ai/cordis-plugin-hmr'
`;
  const { entries } = parseDumpConfig(out);
  assert.equal(entries[0].source, "@deepseek-ai/dsh-base");
  assert.equal(entries[1].source, "@liustack/modlens");
  assert.equal(entries[2].source, "@deepseek-ai/dsh-base");
});

console.log("readProfileBundles");
test("读取 profile 的 dsh.profile.bundles", () => {
  const dir = mkdtempSync(join(tmpdir(), "dsh-safe-test-"));
  writeFileSync(
    join(dir, "package.json"),
    JSON.stringify({
      name: "dsh-profile-web",
      dsh: {
        profile: {
          bundles: ["@deepseek-ai/dsh-base", "@liustack/modlens"],
        },
      },
    }),
  );
  assert.deepEqual(readProfileBundles(dir), [
    "@deepseek-ai/dsh-base",
    "@liustack/modlens",
  ]);
  rmSync(dir, { recursive: true, force: true });
});

test("读不到 bundles 时返回 null", () => {
  const dir = mkdtempSync(join(tmpdir(), "dsh-safe-test-"));
  assert.equal(readProfileBundles(dir), null); // 无 package.json
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "x" }));
  assert.equal(readProfileBundles(dir), null); // 无 dsh.profile.bundles
  rmSync(dir, { recursive: true, force: true });
});

console.log("selectThirdPartyIds");
test("动态模式：只选第三方 bundle 的插件，保留 DSH 自带", () => {
  const entries = [
    { id: "timer", name: "a", source: "@deepseek-ai/dsh-base" },
    { id: "modlens", name: "b", source: "@liustack/modlens" },
    { id: "web-runtime", name: "c", source: "@deepseek-ai/dsh-web-app" },
    { id: "console", name: "d", source: "@noob-stupid/dsh-plugin-console" },
    { id: "unknown", name: "e", source: null },
  ];
  const thirdParty = new Set([
    "@liustack/modlens",
    "@noob-stupid/dsh-plugin-console",
  ]);
  const ids = selectThirdPartyIds(entries, thirdParty);
  assert.deepEqual(ids, ["modlens", "console", "unknown"]);
});

test("回退模式：thirdPartyBundles 为 null 时用硬编码白名单", () => {
  const entries = [
    { id: "timer", name: "a", source: "@deepseek-ai/dsh-base" },
    { id: "modlens", name: "b", source: "@liustack/modlens" },
    { id: "web-runtime", name: "c", source: "@deepseek-ai/dsh-web-app" },
    { id: "console", name: "d", source: "@noob-stupid/dsh-plugin-console" },
    { id: "unknown", name: "e", source: null },
  ];
  const ids = selectThirdPartyIds(entries, null);
  assert.deepEqual(ids, ["modlens", "console", "unknown"]);
});

console.log("isBuiltinModule");
test("识别 DSH 自带插件（cordis:* / @deepseek-ai/*）", () => {
  assert.equal(isBuiltinModule("cordis:include"), true);
  assert.equal(isBuiltinModule("@deepseek-ai/cordis-plugin-timer"), true);
  assert.equal(isBuiltinModule("@deepseek-ai/dsh-tool-bash"), true);
  assert.equal(isBuiltinModule("@liustack/modlens"), false);
  assert.equal(isBuiltinModule("dsh-message-edit"), false);
  assert.equal(isBuiltinModule("@noob-stupid/dsh-plugin-console"), false);
});

console.log("findFailedPlugins");
const byName = new Map([
  ["@deepseek-ai/this-does-not-exist", ["broken"]],
  ["@deepseek-ai/this-plugin-does-not-exist", ["broken2"]],
  ["@deepseek-ai/some-plugin", ["some"]],
  ["@deepseek-ai/ok-plugin", ["ok"]],
]);

test("识别 failed to load 格式", () => {
  const stderr = `dsh: plugin tree failed to load: dsh: plugin(s) failed to load: @deepseek-ai/this-does-not-exist; Cordis startup failed`;
  const found = findFailedPlugins(stderr, byName);
  assert.deepEqual(found, ["@deepseek-ai/this-does-not-exist"]);
});

test("识别 import 失败格式（loader entry <id> (<name>)）", () => {
  const stderr = `dsh: plugin tree failed to load: failed to apply loader entry include (cordis:include): failed to import loader entry broken-plugin (@deepseek-ai/this-plugin-does-not-exist): Cannot find package`;
  const found = findFailedPlugins(stderr, byName);
  assert.deepEqual(found, ["@deepseek-ai/this-plugin-does-not-exist"]);
});

test("识别 did not activate 格式", () => {
  const stderr = `dsh: plugin tree failed to load: dsh: 1 entry did not activate
@deepseek-ai/some-plugin: Error: boom
`;
  const found = findFailedPlugins(stderr, byName);
  assert.deepEqual(found, ["@deepseek-ai/some-plugin"]);
});

test("不误报正常插件", () => {
  const stderr = `dsh: fatal load failure: Error: something
    at @deepseek-ai/ok-plugin (file.js:1:1)
`;
  const found = findFailedPlugins(stderr, byName);
  assert.deepEqual(found, []);
});

console.log("disablePlugin / isDisabled");
test("追加禁用条目并识别已禁用", () => {
  const dir = mkdtempSync(join(tmpdir(), "dsh-safe-test-"));
  const file = join(dir, "cordis.patch.yml");
  writeFileSync(file, "# 用户手动禁用\n- id: manual\n  disabled: true\n");

  assert.equal(isDisabled(readFileSync(file, "utf8"), "manual"), true);
  assert.equal(isDisabled(readFileSync(file, "utf8"), "broken"), false);

  assert.equal(disablePlugin(file, "broken", "@scope/broken"), true);
  assert.equal(disablePlugin(file, "broken", "@scope/broken"), false); // 不重复写

  const content = readFileSync(file, "utf8");
  assert.equal(isDisabled(content, "broken"), true);
  assert.ok(content.includes("# auto-disabled by dsh-safe: @scope/broken"));
  assert.ok(content.includes("- id: manual\n  disabled: true")); // 用户条目保留

  rmSync(dir, { recursive: true, force: true });
});

test("处理空数组 [] 的 cordis.patch.yml", () => {
  const dir = mkdtempSync(join(tmpdir(), "dsh-safe-test-"));
  const file = join(dir, "cordis.patch.yml");
  writeFileSync(file, "# 注释\n[]\n");

  assert.equal(disablePlugin(file, "broken", "@scope/broken"), true);
  const content = readFileSync(file, "utf8");
  assert.ok(!content.includes("[]")); // 空数组被替换
  assert.equal(isDisabled(content, "broken"), true);
  assert.ok(content.includes("- id: broken\n  disabled: true"));

  rmSync(dir, { recursive: true, force: true });
});

console.log("loadConfig restart 默认值");
test("会话内重启默认需要提权，重启也不打开浏览器窗口", () => {
  const dir = mkdtempSync(join(tmpdir(), "dsh-safe-cfg-"));
  const config = loadConfig(dir);
  assert.equal(config.restart.requireEscalation, true);
  assert.equal(config.restart.noOpen, true);
  assert.equal(config.restart.enabled, true);
  rmSync(dir, { recursive: true, force: true });
});

console.log("buildRestartArgs");
test("首次启动不追加参数", () => {
  assert.deepEqual(buildRestartArgs([], { isRestart: false, webProfile: true }), []);
  assert.deepEqual(buildRestartArgs(["--port", "3080"], { isRestart: false, webProfile: true }), [
    "--port",
    "3080",
  ]);
});

test("重启 + web profile 追加 --no-open", () => {
  assert.deepEqual(
    buildRestartArgs(["--port", "3080"], { isRestart: true, webProfile: true }),
    ["--port", "3080", "--no-open"],
  );
});

test("非 web profile 不追加（--no-open 会变成未知参数）", () => {
  assert.deepEqual(buildRestartArgs([], { isRestart: true, webProfile: false }), []);
});

test("已有 --no-open 不重复追加；noOpen=false 可关闭", () => {
  assert.deepEqual(buildRestartArgs(["--no-open"], { isRestart: true, webProfile: true }), [
    "--no-open",
  ]);
  assert.deepEqual(
    buildRestartArgs([], { isRestart: true, webProfile: true, noOpen: false }),
    [],
  );
});

console.log("isWebProfile");
test("按 profile bundles 判断是否 web", () => {
  const dir = mkdtempSync(join(tmpdir(), "dsh-safe-web-"));
  mkdirSync(join(dir, "profiles", "web"), { recursive: true });
  writeFileSync(
    join(dir, "profiles", "web", "package.json"),
    JSON.stringify({
      dsh: { profile: { bundles: ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app"] } },
    }),
  );
  mkdirSync(join(dir, "profiles", "headless"), { recursive: true });
  writeFileSync(
    join(dir, "profiles", "headless", "package.json"),
    JSON.stringify({
      dsh: { profile: { bundles: ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-headless"] } },
    }),
  );

  assert.equal(isWebProfile(dir, "web"), true);
  assert.equal(isWebProfile(dir, "headless"), false);
  assert.equal(isWebProfile(dir, "missing"), false);
  rmSync(dir, { recursive: true, force: true });
});

console.log(`\n全部通过：${passed} 个测试`);

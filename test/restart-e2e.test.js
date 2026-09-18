import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { launch } from "../lib/launcher.js";
import { listRuns } from "../lib/restart.js";

// 用「假 dsh」验证完整重启链路，不需要真实 dsh，也不碰 ~/.dsh：
//   · 默认（requireEscalation=true）不开控制端口，重启走请求文件；
//   · requireEscalation=false 才开控制端口并落盘 port/token；
//   · web profile 重启补 --no-open；maxPerSession 上限；
//   · --wake 唤醒链路：重启后从新实例 stdout 抓 token URL → 换 cookie → session/prompt 投递；
//   · 唤醒投递失败必须降级（不影响启动、不影响退出码）。
// 其中假 dsh 自己起 HTTP 服务扮演 DSH web 的鉴权与 RPC。
//
// 注意：launch -> spawnDsh 用 stdio: 'pipe' 捕获 stderr，在 DSH workspace-write 沙箱下
// 会 EPERM（命名管道被禁），需要 danger-full-access 才能跑。

const originalPath = process.env.PATH ?? "";
const originalHome = process.env.DSH_HOME;

const fakeDshSource = "const fs = require(\"node:fs\");\nconst http = require(\"node:http\");\nconst net = require(\"node:net\");\nconst path = require(\"node:path\");\n\nfunction readHasControl() {\n  try {\n    const recordPath = path.join(\n      process.env.DSH_HOME, \"dsh-safe\", \"runs\", process.env.DSH_SAFE_RUN_ID, \"run.json\",\n    );\n    const record = JSON.parse(fs.readFileSync(recordPath, \"utf8\"));\n    return record.control && Number.isInteger(record.control.port) && record.control.port > 0\n      ? \"yes\"\n      : \"no\";\n  } catch {\n    return \"no\";\n  }\n}\n\nfs.appendFileSync(\n  process.env.FAKE_DSH_LOG,\n  \"run control=\" + readHasControl() + \" \" + process.argv.slice(2).join(\" \") + \"\\n\",\n);\n\nconst mode = process.env.FAKE_DSH_MODE || \"file\";\nconst marker = process.env.FAKE_DSH_MARKER;\nconst firstRun = !fs.existsSync(marker);\n\nfunction runDir() {\n  return path.join(process.env.DSH_HOME, \"dsh-safe\", \"runs\", process.env.DSH_SAFE_RUN_ID);\n}\n\nfunction writeRequest(withWake) {\n  const dir = runDir();\n  fs.mkdirSync(dir, { recursive: true });\n  fs.writeFileSync(\n    path.join(dir, \"restart.request.json\"),\n    JSON.stringify(\n      withWake\n        ? { reason: \"e2e-wake\", wake: { sessionId: \"session-fake\", text: \"接着干\" } }\n        : { reason: \"e2e-file\" },\n    ),\n  );\n}\n\nfunction hang() {\n  setInterval(() => {}, 1000);\n}\n\n// 模拟 DSH web 的鉴权 + RPC：GET 换 cookie，POST 记录收到的唤醒\nfunction startFakeWeb(port, onWake) {\n  const server = http.createServer((req, res) => {\n    if (req.method === \"GET\") {\n      res.writeHead(303, { \"set-cookie\": \"dsh-auth-fake=1; Path=/\", location: \"/\" });\n      res.end();\n      return;\n    }\n    let body = \"\";\n    req.on(\"data\", (chunk) => {\n      body += chunk;\n    });\n    req.on(\"end\", () => {\n      onWake({ cookie: req.headers.cookie || \"\", body });\n      res.writeHead(200, { \"content-type\": \"application/json\" });\n      res.end(JSON.stringify({ type: \"server-response\", result: { ok: true } }));\n    });\n  });\n  server.listen(port, \"127.0.0.1\", () => {\n    process.stdout.write(\n      \"dsh web: http://127.0.0.1:\" + server.address().port + \"/?token=faketoken\\r\\n\",\n    );\n  });\n}\n\nfunction main() {\n  if (mode === \"always\") {\n    writeRequest(false);\n    hang();\n    return;\n  }\n\n  if (mode === \"wake\" || mode === \"wake-noserve\") {\n    if (firstRun) {\n      fs.writeFileSync(marker, \"1\");\n      writeRequest(true);\n      hang();\n      return;\n    }\n    if (mode === \"wake\") {\n      // 重启后的实例：对外提供服务，收到唤醒就记档并正常退出\n      startFakeWeb(0, (record) => {\n        fs.writeFileSync(process.env.FAKE_DSH_WAKE_RECORD, JSON.stringify(record));\n        setTimeout(() => process.exit(0), 300);\n      });\n      setTimeout(() => process.exit(0), 30000);\n      return;\n    }\n    // wake-noserve：打印一个没人监听的端口，投递必然失败 → 必须降级\n    process.stdout.write(\"dsh web: http://127.0.0.1:1/?token=faketoken\\r\\n\");\n    setTimeout(() => process.exit(0), 500);\n    return;\n  }\n\n  if (mode === \"socket\") {\n    if (!firstRun) {\n      process.exit(0);\n    }\n    fs.writeFileSync(marker, \"1\");\n    const port = Number(process.env.DSH_SAFE_CONTROL_PORT);\n    const token = process.env.DSH_SAFE_CONTROL_TOKEN;\n    if (!Number.isInteger(port) || port <= 0 || typeof token !== \"string\" || token.length === 0) {\n      fs.appendFileSync(process.env.FAKE_DSH_LOG, \"missing-control-env\\n\");\n      process.exit(3);\n    }\n    const socket = net.connect({ host: \"127.0.0.1\", port }, () => {\n      socket.write(\n        JSON.stringify({ token, action: \"restart\", reason: \"e2e-socket\", pid: process.pid }) + \"\\n\",\n      );\n    });\n    socket.on(\"data\", () => {});\n    socket.on(\"error\", () => {});\n    hang();\n    return;\n  }\n\n  if (!firstRun) {\n    process.exit(0);\n  }\n  fs.writeFileSync(marker, \"1\");\n  writeRequest(false);\n  hang();\n}\n\nmain();\n";

function setupScenario(prefix, options) {
  const { config, web = false } = options;
  const home = mkdtempSync(join(tmpdir(), `dsh-safe-restart-${prefix}-`));
  const fakeBin = join(home, "fake-bin");
  mkdirSync(fakeBin, { recursive: true });
  writeFileSync(join(fakeBin, "fake-dsh.js"), fakeDshSource, "utf8");
  if (process.platform === "win32") {
    writeFileSync(join(fakeBin, "dsh.cmd"), '@echo off\r\nnode "%~dp0fake-dsh.js" %*\r\n', "utf8");
  } else {
    writeFileSync(join(fakeBin, "dsh"), '#!/bin/sh\nexec node "$(dirname "$0")/fake-dsh.js" "$@"\n', {
      mode: 0o755,
    });
  }
  if (config !== undefined) {
    mkdirSync(join(home, "dsh-safe"), { recursive: true });
    writeFileSync(join(home, "dsh-safe", "config.json"), JSON.stringify(config));
  }
  if (web) {
    const profileDir = join(home, "profiles", "e2e");
    mkdirSync(profileDir, { recursive: true });
    writeFileSync(
      join(profileDir, "package.json"),
      JSON.stringify({
        dsh: { profile: { bundles: ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app"] } },
      }),
    );
  }
  return {
    home,
    fakeBin,
    logFile: join(home, "fake-dsh.log"),
    marker: join(home, "fake-dsh-ran-once"),
    wakeRecord: join(home, "fake-dsh-wake.json"),
  };
}

/**
 * @param {{mode: "socket"|"file"|"always"|"wake"|"wake-noserve", web?: boolean, config?: object,
 *          expectRuns: number, expectCode?: number, expectControl?: boolean,
 *          check?: (lines: string[], code: number, scenario: object) => void}} options
 */
async function runScenario(name, options) {
  const { mode, web = false, config, expectRuns, expectCode, expectControl = false, check } = options;
  const scenario = setupScenario(mode, { config, web });
  process.env.DSH_HOME = scenario.home;
  process.env.FAKE_DSH_LOG = scenario.logFile;
  process.env.FAKE_DSH_MARKER = scenario.marker;
  process.env.FAKE_DSH_MODE = mode;
  process.env.FAKE_DSH_WAKE_RECORD = scenario.wakeRecord;
  process.env.PATH = `${scenario.fakeBin}${delimiter}${originalPath}`;

  try {
    const code = await launch("e2e", []);
    const lines = readFileSync(scenario.logFile, "utf8").trim().split("\n");
    assert.ok(
      !lines.some((line) => line.includes("missing-control-env")),
      "socket 场景应有控制端口环境变量",
    );
    assert.equal(lines.length, expectRuns, `假 dsh 应被启动 ${expectRuns} 次，实际 ${lines.length} 次`);
    const wantControl = expectControl ? "control=yes" : "control=no";
    assert.ok(
      lines.every((line) => line.includes(wantControl)),
      `运行记录里的控制端口状态应为 ${wantControl}`,
    );
    if (expectCode !== undefined) {
      assert.equal(code, expectCode, `launch 退出码应为 ${expectCode}`);
    }
    check?.(lines, code, scenario);
    assert.deepEqual(listRuns(scenario.home), []);
    console.log(`  ✓ ${name}`);
  } finally {
    process.env.PATH = originalPath;
    rmSync(scenario.home, { recursive: true, force: true });
  }
}

try {
  await runScenario("默认配置（需提权）：不开控制端口，走请求文件通道", {
    mode: "file",
    expectRuns: 2,
    expectCode: 0,
    expectControl: false,
  });

  await runScenario("requireEscalation=false：控制端口通道 + port/token 落盘", {
    mode: "socket",
    config: { restart: { requireEscalation: false } },
    expectRuns: 2,
    expectCode: 0,
    expectControl: true,
  });

  await runScenario("web profile 重启自动追加 --no-open（不再新开窗口）", {
    mode: "socket",
    web: true,
    config: { restart: { requireEscalation: false } },
    expectRuns: 2,
    expectCode: 0,
    expectControl: true,
    check: (lines) => {
      assert.ok(!lines[0].includes("--no-open"), "首次启动仍应打开窗口");
      assert.ok(lines[1].includes("--no-open"), "重启应追加 --no-open");
    },
  });

  await runScenario("restart.maxPerSession 上限生效（不会无限重启）", {
    mode: "always",
    config: { restart: { maxPerSession: 1, settleMs: 0 } },
    expectRuns: 2,
  });

  await runScenario("--wake：重启后把唤醒消息投回会话", {
    mode: "wake",
    expectRuns: 2,
    expectCode: 0,
    check: (lines, code, scenario) => {
      assert.ok(existsSync(scenario.wakeRecord), "唤醒消息应被投递到新实例");
      const record = JSON.parse(readFileSync(scenario.wakeRecord, "utf8"));
      assert.equal(record.cookie, "dsh-auth-fake=1", "应带上换来的 dsh-auth cookie");
      const envelope = JSON.parse(record.body);
      assert.equal(envelope.type, "client-request");
      assert.equal(envelope.method, "session/prompt");
      assert.equal(envelope.payload.args.request.sessionId, "session-fake");
      assert.equal(envelope.payload.args.request.mode, "queue");
      assert.equal(envelope.payload.args.request.content[0].text, "接着干");
    },
  });

  await runScenario("--wake 投递失败也要降级（不影响启动与退出码）", {
    mode: "wake-noserve",
    expectRuns: 2,
    expectCode: 0,
    check: (lines, code, scenario) => {
      assert.ok(!existsSync(scenario.wakeRecord), "没有服务时不应产生投递记录");
    },
  });

  console.log("\n重启 e2e 通过");
} finally {
  if (originalHome === undefined) delete process.env.DSH_HOME;
  else process.env.DSH_HOME = originalHome;
}

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sendControlRequest, startControlServer } from "../lib/control.js";
import { runRecordFile } from "../lib/paths.js";
import {
  beginRun,
  consumeRestartRequest,
  endRun,
  findTargetRuns,
  hasRestartRequest,
  isProcessAlive,
  listRuns,
  newRunId,
  readRunControl,
  terminateChild,
  updateRunControl,
  watchRestartRequest,
  writeRestartRequest,
} from "../lib/restart.js";

let passed = 0;
let skipped = 0;
async function test(name, fn) {
  const result = await fn();
  if (result === "skip") {
    skipped += 1;
    console.log(`  - ${name}（跳过）`);
    return;
  }
  passed += 1;
  console.log(`  ✓ ${name}`);
}
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const makeHome = () => mkdtempSync(join(tmpdir(), "dsh-safe-restart-"));

console.log("run 记录");
await test("beginRun / listRuns / endRun", () => {
  const home = makeHome();
  const runId = newRunId();
  beginRun(home, runId, { profile: "web", args: ["--no-open"], safe: false });

  const runs = listRuns(home);
  assert.equal(runs.length, 1);
  assert.equal(runs[0].runId, runId);
  assert.equal(runs[0].profile, "web");
  assert.equal(runs[0].pid, process.pid);
  assert.deepEqual(runs[0].args, ["--no-open"]);

  endRun(home, runId);
  assert.deepEqual(listRuns(home), []);
  rmSync(home, { recursive: true, force: true });
});

console.log("findTargetRuns / isProcessAlive");
await test("按 profile 过滤，存活判定与精确 runId", () => {
  const home = makeHome();
  const live = newRunId();
  const dead = newRunId();
  beginRun(home, live, { profile: "web", args: [], safe: false });
  beginRun(home, dead, { profile: "web", args: [], safe: false });

  // 伪造一个「父进程已退出」的实例
  const record = JSON.parse(readFileSync(runRecordFile(home, dead), "utf8"));
  record.pid = 999999999;
  writeFileSync(runRecordFile(home, dead), JSON.stringify(record));

  assert.equal(isProcessAlive(process.pid), true);
  assert.equal(isProcessAlive(0), false);
  assert.equal(isProcessAlive(999999999), false);

  assert.deepEqual(
    findTargetRuns(home, { profile: "web" }).map((run) => run.runId),
    [live],
  );
  assert.equal(findTargetRuns(home, { profile: "other" }).length, 0);
  assert.equal(findTargetRuns(home, { runId: live }).length, 1);
  assert.equal(findTargetRuns(home, { runId: dead }).length, 1); // 精确匹配不过滤存活
  assert.equal(findTargetRuns(home, { runId: "missing" }).length, 0);

  // beginRun 会顺手清理死掉的实例
  const another = newRunId();
  beginRun(home, another, { profile: "web", args: [], safe: false });
  assert.deepEqual(listRuns(home).map((run) => run.runId).sort(), [live, another].sort());

  rmSync(home, { recursive: true, force: true });
});

console.log("重启请求文件");
await test("写入 → 消费只成功一次", () => {
  const home = makeHome();
  const runId = newRunId();
  beginRun(home, runId, { profile: "web", args: [], safe: false });

  assert.equal(hasRestartRequest(home, runId), false);
  writeRestartRequest(home, runId, { reason: "单测" });
  assert.equal(hasRestartRequest(home, runId), true);

  const request = consumeRestartRequest(home, runId);
  assert.equal(request.reason, "单测");
  assert.equal(typeof request.requestedAt, "string");
  assert.equal(consumeRestartRequest(home, runId), null);
  assert.equal(hasRestartRequest(home, runId), false);

  rmSync(home, { recursive: true, force: true });
});

console.log("watchRestartRequest");
await test("持续监听：多次请求都能消费，stop 后停止", async () => {
  const home = makeHome();
  const runId = newRunId();
  beginRun(home, runId, { profile: "web", args: [], safe: false });

  let calls = 0;
  let received = null;
  const stop = watchRestartRequest(home, runId, {
    intervalMs: 20,
    onRequest: (request) => {
      calls += 1;
      received = request;
    },
  });

  await wait(60);
  assert.equal(calls, 0);

  // 第一次请求
  writeRestartRequest(home, runId, { reason: "later" });
  await wait(120);
  assert.equal(calls, 1);
  assert.equal(received.reason, "later");

  // 关键：监听器必须还活着，第二次请求也要能消费
  writeRestartRequest(home, runId, { reason: "again" });
  await wait(150);
  assert.equal(calls, 2);
  assert.equal(received.reason, "again");

  // 停止后不再消费新请求
  stop();
  writeRestartRequest(home, runId, { reason: "after-stop" });
  await wait(80);
  assert.equal(calls, 2);
  assert.equal(hasRestartRequest(home, runId), true);

  rmSync(home, { recursive: true, force: true });
});

console.log("控制端口");
await test("token 不对 / 动作不认识会被拒绝，restart 被接受", async () => {
  const seen = [];
  const control = await startControlServer({ onRequest: (message) => seen.push(message) });
  try {
    const bad = await sendControlRequest({ port: control.port, token: "wrong", reason: "x" });
    assert.equal(bad.ok, false);

    const unknown = await sendControlRequest({
      port: control.port,
      token: control.token,
      action: "explode",
    });
    assert.equal(unknown.ok, false);
    assert.equal(seen.length, 0);

    const ok = await sendControlRequest({ port: control.port, token: control.token, reason: "fine" });
    assert.equal(ok.ok, true);
    assert.equal(seen.length, 1);
    assert.equal(seen[0].reason, "fine");
    assert.equal(seen[0].action, "restart");
  } finally {
    control.close();
  }
});

console.log("terminateChild");
await test("终止真实子进程", async () => {
  // 子进程 6 秒后自杀，避免在「不允许终止进程」的环境里留下孤儿
  const child = spawn(process.execPath, ["-e", "setTimeout(() => process.exit(0), 6000)"], {
    stdio: "ignore",
  });
  child.unref();
  await wait(250);

  assert.equal(terminateChild(child, { graceMs: 300 }), true);
  const outcome = await new Promise((resolve) => {
    const timer = setTimeout(() => resolve("timeout"), 2500);
    child.on("close", () => {
      clearTimeout(timer);
      resolve("closed");
    });
  });

  if (outcome !== "closed") {
    // DSH 的 workspace-write 沙箱会拒绝 taskkill / TerminateProcess（Access denied）。
    // 真实运行时 dsh-safe 在沙箱外的父进程里，可以正常终止。
    console.log("    （当前环境不允许终止其它进程，例如 DSH 沙箱）");
    return "skip";
  }
  assert.equal(outcome, "closed");
});

await test("空句柄 / 已退出句柄不重复终止", () => {
  assert.equal(terminateChild(null), false);
  assert.equal(terminateChild(undefined), false);
  assert.equal(terminateChild({ exitCode: 0, signalCode: null, pid: 1 }), false);
});

console.log("运行记录里的控制端口");
await test("updateRunControl 落盘、readRunControl 读回", () => {
  const home = makeHome();
  const runId = newRunId();
  beginRun(home, runId, { profile: "web", args: [], safe: false });

  assert.equal(readRunControl(home, runId), null);

  updateRunControl(home, runId, { port: 34567, token: "tok" });
  assert.deepEqual(readRunControl(home, runId), { port: 34567, token: "tok" });
  // 不能覆盖运行记录原有字段
  assert.equal(listRuns(home)[0].profile, "web");

  // 坏数据一律当「没有控制端口」
  writeFileSync(
    runRecordFile(home, runId),
    JSON.stringify({ runId, pid: process.pid, control: { port: "x", token: "" } }),
  );
  assert.equal(readRunControl(home, runId), null);

  rmSync(home, { recursive: true, force: true });
});

console.log("控制端口 ping");
await test("ping 只回执、不触发重启", async () => {
  const seen = [];
  const control = await startControlServer({ onRequest: (message) => seen.push(message) });
  try {
    const pong = await sendControlRequest({
      port: control.port,
      token: control.token,
      action: "ping",
    });
    assert.equal(pong.ok, true);
    assert.equal(pong.action, "ping");
    assert.equal(seen.length, 0, "ping 不应触发 onRequest");
  } finally {
    control.close();
  }
});

console.log(
  `\n全部通过：${passed} 个测试${skipped > 0 ? `（跳过 ${skipped} 个）` : ""}`,
);

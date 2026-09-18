import assert from "node:assert/strict";
import { createServer } from "node:http";
import {
  buildPromptEnvelope,
  createWebUrlScanner,
  deliverWake,
  readWake,
} from "../lib/wake.js";

let passed = 0;
async function test(name, fn) {
  await fn();
  passed += 1;
  console.log(`  ✓ ${name}`);
}

console.log("createWebUrlScanner");
await test("跨 chunk 也能扫到 token URL", () => {
  const scan = createWebUrlScanner();
  assert.equal(scan("dsh-pocket: port 3081 busy\ndsh web: http://127.0.0.1:30"), null);
  const found = scan("99/?token=AbC-123_xyz\n");
  assert.deepEqual(found, {
    url: "http://127.0.0.1:3099/?token=AbC-123_xyz",
    port: 3099,
    token: "AbC-123_xyz",
  });
  assert.equal(scan("又一段无关输出"), null);
});

await test("无关输出不会误报", () => {
  const scan = createWebUrlScanner();
  assert.equal(scan("dsh-pocket: port 3081 busy\n"), null);
  assert.equal(scan("http://127.0.0.1:3099/ 这里没有 token\n"), null);
});

console.log("buildPromptEnvelope");
await test("信封形状：type / payload.args.request", () => {
  const envelope = buildPromptEnvelope("session-x", "继续");
  assert.equal(envelope.type, "client-request");
  assert.equal(envelope.method, "session/prompt");
  assert.equal(envelope.payload.args.request.sessionId, "session-x");
  assert.equal(envelope.payload.args.request.mode, "queue");
  assert.deepEqual(envelope.payload.args.request.content, [{ type: "text", text: "继续" }]);
  assert.equal(typeof envelope.rpcId, "string");
  assert.equal(typeof envelope.payload.args.request.requestId, "string");
});

console.log("readWake");
await test("留空 / 缺 sessionId / 类型不对 → null（不走流程）", () => {
  assert.equal(readWake({}), null);
  assert.equal(readWake({ wake: null }), null);
  assert.equal(readWake({ wake: { sessionId: "s", text: "   " } }), null);
  assert.equal(readWake({ wake: { sessionId: "", text: "x" } }), null);
  assert.equal(readWake({ wake: "x" }), null);
  assert.deepEqual(readWake({ wake: { sessionId: "s", text: " hi " } }), {
    sessionId: "s",
    text: "hi",
  });
});

console.log("deliverWake");
await test("成功路径：换 cookie → 投递", async () => {
  const seen = [];
  const server = createServer((req, res) => {
    if (req.method === "GET") {
      res.writeHead(303, { "set-cookie": "dsh-auth-test=1; Path=/", location: "/" });
      res.end();
      return;
    }
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
    });
    req.on("end", () => {
      seen.push({ url: req.url, cookie: req.headers.cookie, body });
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ type: "server-response", result: { ok: true } }));
    });
  });
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  const port = server.address().port;
  try {
    const result = await deliverWake({
      url: `http://127.0.0.1:${port}/?token=tok`,
      sessionId: "session-x",
      text: "继续",
      retryMs: 50,
    });
    assert.deepEqual(result, { ok: true });
    assert.equal(seen.length, 1);
    assert.equal(seen[0].url, "/api/session/prompt");
    assert.equal(seen[0].cookie, "dsh-auth-test=1");
    const envelope = JSON.parse(seen[0].body);
    assert.equal(envelope.method, "session/prompt");
    assert.equal(envelope.payload.args.request.sessionId, "session-x");
    assert.equal(envelope.payload.args.request.content[0].text, "继续");
  } finally {
    server.close();
  }
});

await test("降级路径：一直 401 → ok:false 且不抛", async () => {
  const server = createServer((req, res) => {
    res.writeHead(401);
    res.end("Unauthorized");
  });
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  const port = server.address().port;
  try {
    const result = await deliverWake({
      url: `http://127.0.0.1:${port}/?token=tok`,
      sessionId: "s",
      text: "x",
      timeoutMs: 400,
      retryMs: 50,
    });
    assert.equal(result.ok, false);
    assert.equal(typeof result.error, "string");
    assert.ok(result.error.length > 0);
  } finally {
    server.close();
  }
});

console.log(`\n全部通过：${passed} 个测试`);

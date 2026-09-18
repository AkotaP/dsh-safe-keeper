import { randomUUID } from "node:crypto";

/**
 * 重启"唤醒消息"的投递实现。
 *
 * 重启会掐断当前回合，所以 agent 可以在请求重启时附一句话（`--wake`），
 * dsh-safe 在 DSH 起来之后把它作为一条用户消息投回同一个会话，让 agent 自动
 * 接着干。留空就不走这条流程；**任何失败都只记日志降级**，绝不影响启动。
 *
 * 链路（全部对着 DSH 的 web app，实测于 0.4.x）：
 *   1. `dsh web` 启动时会往 stdout 打印 `dsh web: http://127.0.0.1:<port>/?token=<t>`
 *      （web-app 的 printUrl 默认 true）。token 是**进程级**的，只存在于这行输出里，
 *      所以父进程必须捕获 stdout 才能拿到。
 *   2. GET 该 URL → 303 + `Set-Cookie: dsh-auth-...`（浏览器会话 cookie）。
 *   3. POST /api/session/prompt，信封 `{type:"client-request", rpcId, method, payload:{args:{request}}}`。
 *      没带 cookie 会是 401；信封缺 type 或少了 args 会被 gateway/bad-request 退回。
 */

/** DSH web 启动横幅里的带 token URL（token 是 base64url） */
const WEB_URL_PATTERN = /https?:\/\/127\.0\.0\.1:(\d+)\/\?token=([A-Za-z0-9_-]+)/;

/** 只保留扫描缓冲的尾部，避免无限增长（URL 一定出现在很近的窗口内） */
const SCAN_BUFFER_LIMIT = 4096;

/** 不 unref 的话，重试定时器会把父进程钉住；这里显式 unref */
function sleep(ms) {
  return new Promise((done) => {
    const timer = setTimeout(done, ms);
    timer.unref?.();
  });
}

/**
 * 造一个 stdout 扫描器：把每次拿到的 chunk 喂进去，扫到带 token 的 URL 就返回它。
 * 用闭包缓冲，避免 URL 跨 chunk 被截断。
 * @returns {(chunk: unknown) => {url: string, port: number, token: string}|null}
 */
export function createWebUrlScanner() {
  let buffer = "";
  return (chunk) => {
    buffer += String(chunk);
    const match = WEB_URL_PATTERN.exec(buffer);
    if (match !== null) {
      buffer = "";
      return { url: match[0], port: Number(match[1]), token: match[2] };
    }
    if (buffer.length > SCAN_BUFFER_LIMIT) buffer = buffer.slice(-SCAN_BUFFER_LIMIT / 2);
    return null;
  };
}

/**
 * 组装 session/prompt 的 HTTP 信封。
 * 形状是实测出来的：`type` / `payload.args.request` 一个都不能少。
 * @param {string} sessionId
 * @param {string} text
 * @returns {object}
 */
export function buildPromptEnvelope(sessionId, text) {
  return {
    type: "client-request",
    rpcId: randomUUID(),
    method: "session/prompt",
    payload: {
      args: {
        request: {
          requestId: randomUUID(),
          sessionId,
          mode: "queue",
          content: [{ type: "text", text }],
        },
      },
    },
  };
}

/**
 * 用带 token 的 URL 换浏览器会话 cookie。失败抛错，由调用方降级。
 * @param {string} url
 * @param {number} timeoutMs
 * @returns {Promise<string>}
 */
async function exchangeCookie(url, timeoutMs) {
  const response = await fetch(url, {
    redirect: "manual",
    signal: AbortSignal.timeout(timeoutMs),
  });
  const raw =
    typeof response.headers.getSetCookie === "function"
      ? response.headers.getSetCookie()
      : [response.headers.get("set-cookie")];
  return (raw ?? [])
    .filter(Boolean)
    .map((value) => value.split(";")[0])
    .join("; ");
}

/**
 * 投递一条唤醒消息。内部按 `retryMs` 重试到 `timeoutMs`；
 * **永不抛错**，失败返回 `{ok:false, error}` 交给调用方降级。
 * @param {{url: string, sessionId: string, text: string, timeoutMs?: number, retryMs?: number}} options
 * @returns {Promise<{ok: true} | {ok: false, error: string}>}
 */
export async function deliverWake(options) {
  const { url, sessionId, text, timeoutMs = 60000, retryMs = 1000 } = options;
  const origin = new URL(url).origin;
  const deadline = Date.now() + timeoutMs;
  let lastError = "未执行";

  while (Date.now() < deadline) {
    try {
      const cookie = await exchangeCookie(url, 5000);
      if (cookie === "") throw new Error("没有拿到 dsh-auth cookie");
      const response = await fetch(`${origin}/api/session/prompt`, {
        method: "POST",
        headers: { "content-type": "application/json", cookie },
        body: JSON.stringify(buildPromptEnvelope(sessionId, text)),
        signal: AbortSignal.timeout(10000),
      });
      const body = await response.text();
      if (response.status === 200 && body.includes('"ok":true')) return { ok: true };
      lastError = `HTTP ${response.status}：${body.slice(0, 200)}`;
    } catch (error) {
      lastError = error.message;
    }
    await sleep(retryMs);
  }

  return { ok: false, error: lastError };
}

/**
 * 从重启请求里取出合法的唤醒载荷。
 * 文本为空 / 没有 sessionId / 类型不对，一律当"没有"（留空即不走流程）。
 * @param {object} request
 * @returns {{sessionId: string, text: string}|null}
 */
export function readWake(request) {
  const wake = request?.wake;
  if (wake === null || wake === undefined || typeof wake !== "object") return null;
  const sessionId = typeof wake.sessionId === "string" ? wake.sessionId.trim() : "";
  const text = typeof wake.text === "string" ? wake.text.trim() : "";
  if (sessionId === "" || text === "") return null;
  return { sessionId, text };
}

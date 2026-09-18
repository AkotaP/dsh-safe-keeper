import { randomBytes } from "node:crypto";
import { connect, createServer } from "node:net";

/** 传给 DSH 的环境变量：控制端口 */
export const CONTROL_PORT_ENV = "DSH_SAFE_CONTROL_PORT";
/** 传给 DSH 的环境变量：控制端口 token */
export const CONTROL_TOKEN_ENV = "DSH_SAFE_CONTROL_TOKEN";

/** 单条控制消息的长度上限，防止恶意/异常客户端撑爆内存 */
const MAX_MESSAGE_BYTES = 64 * 1024;

/**
 * 在 127.0.0.1 上开一个一次性控制端口，供 DSH 内部（沙箱里）的
 * `dsh-safe restart` 发重启请求。
 *
 * 为什么是 socket 而不是文件：DSH 的工具沙箱（workspace-write）只允许写工作区和
 * 本会话临时目录，写 `$DSH_HOME/dsh-safe/...` 会被拒绝；loopback 连接不受影响。
 * 安全约束：只监听 loopback；端口由系统分配；每条消息必须带随机 token；
 * 唯一支持的动作是 restart。
 *
 * @param {{onRequest: (message: object) => void}} options
 * @returns {Promise<{port: number, token: string, close: () => void}>}
 */
export function startControlServer(options) {
  const { onRequest } = options;
  const token = randomBytes(16).toString("hex");
  const sockets = new Set();

  return new Promise((resolve, reject) => {
    const server = createServer((socket) => {
      sockets.add(socket);
      socket.on("close", () => sockets.delete(socket));
      socket.on("error", () => {});
      socket.setEncoding("utf8");

      let buffer = "";
      socket.on("data", (chunk) => {
        buffer += chunk;
        if (buffer.length > MAX_MESSAGE_BYTES) {
          socket.destroy();
          return;
        }
        const newline = buffer.indexOf("\n");
        if (newline === -1) return;
        const line = buffer.slice(0, newline);

        let message;
        try {
          message = JSON.parse(line);
        } catch {
          socket.end(JSON.stringify({ ok: false, error: "invalid json" }) + "\n");
          return;
        }
        if (message === null || typeof message !== "object" || message.token !== token) {
          socket.end(JSON.stringify({ ok: false, error: "bad token" }) + "\n");
          return;
        }
        if (message.action === "ping") {
          // 只证明「端口 + token 可用」，绝不触发重启
          socket.end(JSON.stringify({ ok: true, action: "ping" }) + "\n");
          return;
        }
        if (message.action !== "restart") {
          socket.end(JSON.stringify({ ok: false, error: "unknown action" }) + "\n");
          return;
        }

        // 先回执再触发重启：确保 CLI 能拿到确认
        socket.end(JSON.stringify({ ok: true }) + "\n");
        onRequest(message);
      });
    });

    server.on("error", reject);
    server.listen({ host: "127.0.0.1", port: 0 }, () => {
      const address = server.address();
      resolve({
        port: address.port,
        token,
        close: () => {
          for (const socket of sockets) socket.destroy();
          try {
            server.close();
          } catch {
            // ignore
          }
        },
      });
    });
  });
}

/**
 * 向控制端口发送一条请求，返回 `{ok: true}` 或 `{ok: false, error}`。
 * @param {{port: number, token: string, action?: string, reason?: string|null,
 *   wake?: object|null, timeoutMs?: number}} options
 * @returns {Promise<{ok: boolean, error?: string}>}
 */
export function sendControlRequest(options) {
  const { port, token, action = "restart", reason = null, wake = null, timeoutMs = 3000 } = options;
  return new Promise((resolve) => {
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      resolve(result);
    };

    const socket = connect({ host: "127.0.0.1", port });
    socket.setEncoding("utf8");
    const timer = setTimeout(() => finish({ ok: false, error: "timeout" }), timeoutMs);
    timer.unref?.();

    let buffer = "";
    socket.on("connect", () => {
      socket.write(
        JSON.stringify({ token, action, reason, wake, pid: process.pid }) + "\n",
      );
    });
    socket.on("data", (chunk) => {
      buffer += chunk;
      const newline = buffer.indexOf("\n");
      if (newline === -1) return;
      try {
        finish(JSON.parse(buffer.slice(0, newline)));
      } catch {
        finish({ ok: false, error: "invalid response" });
      }
    });
    socket.on("error", (error) => finish({ ok: false, error: error.message }));
    socket.on("close", () => finish({ ok: false, error: "连接被关闭" }));
  });
}

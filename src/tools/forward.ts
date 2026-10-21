/**
 * port_forward — 调试端口转发（spec §3.4）
 * 经 `ssh -S $SOCK -O forward -L` 挂到控制连接上；local_port 被占用显式报错，绝不静默换端口。
 * 会话结束统一回收（closeAllForwards）。
 */
import { Type } from "typebox";
import { execFile } from "node:child_process";
import net from "node:net";
import type { SshConnection } from "../connection.js";

export interface Forward {
  localPort: number;
  remotePort: number;
}

/** 探测本地端口是否可绑定（占用=false） */
export function portFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.once("error", () => resolve(false));
    srv.once("listening", () => srv.close(() => resolve(true)));
    srv.listen(port, "127.0.0.1");
  });
}

export const portForwardParams = Type.Object({
  remote_port: Type.Number({ description: "Remote port to forward (e.g. gdbserver 2345)" }),
  local_port: Type.Optional(
    Type.Number({ description: "Local bind port; defaults to remote_port. Occupied => explicit error, never silently switched." }),
  ),
});

export function makePortForwardTool(conn: SshConnection, forwards: Forward[]) {
  return {
    name: "port_forward",
    label: "Port Forward",
    description:
      "Forward a remote port (gdbserver/debugpy) to localhost over the persistent SSH control connection. " +
      "Lives until pi session ends. Occupied local port => explicit error.",
    parameters: portForwardParams,
    async execute(_id: string, params: { remote_port: number; local_port?: number }) {
      const localPort = params.local_port ?? params.remote_port;
      if (localPort < 1024) {
        throw new Error(`local_port ${localPort} < 1024 需要特权，请选高端口（如 2345）`);
      }
      if (forwards.some((f) => f.localPort === localPort)) {
        throw new Error(`local_port ${localPort} 已被本扩展的既有转发占用（remote ${forwards.find(f => f.localPort === localPort)!.remotePort}）`);
      }
      if (!(await portFree(localPort))) {
        // spec §4：显式报错，不自动换端口
        throw new Error(`local_port ${localPort} 被占用；请显式指定其他端口后重试`);
      }

      await conn.ensureWithReconnectFlag();
      const args = [
        "-S", conn.socketPath(), "-O", "forward",
        "-L", `127.0.0.1:${localPort}:127.0.0.1:${params.remote_port}`,
        conn.hostLabel(),
      ];
      const r = await new Promise<{ code: number; stderr: string }>((resolve) => {
        execFile("ssh", args, { timeout: 15000 }, (err, _stdout, stderr) => {
          const code = err && typeof err.code === "number" ? err.code : err ? 1 : 0;
          resolve({ code, stderr: stderr ?? "" });
        });
      });
      if (r.code !== 0) {
        throw new Error(`端口转发建立失败（exit ${r.code}）：${r.stderr.trim()}`);
      }

      forwards.push({ localPort, remotePort: params.remote_port });
      return {
        content: [{ type: "text" as const, text: `forwarded: 127.0.0.1:${localPort} -> remote:${params.remote_port}` }],
        details: {
          local_port: localPort,
          remote_port: params.remote_port,
          reconnected: conn.lastReconnected,
          connection_age_ms: conn.connectionAgeMs,
        },
      };
    },
  };
}

/** 会话清理：取消全部转发（控制连接 close 时转发随之消失，双保险） */
export async function closeAllForwards(conn: SshConnection, forwards: Forward[]): Promise<void> {
  for (const f of forwards) {
    try {
      await new Promise<void>((resolve) => {
        execFile("ssh", [
          "-S", conn.socketPath(), "-O", "cancel",
          "-L", `127.0.0.1:${f.localPort}:127.0.0.1:${f.remotePort}`,
          conn.hostLabel(),
        ], { timeout: 8000 }, () => resolve());
      });
    } catch { /* 清理路径不抛错 */ }
  }
  forwards.length = 0;
}

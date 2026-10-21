/**
 * pi-ssh-remote-run 入口（spec §7）
 * M1 ssh_exec · M2 sync_push/pull · M3 port_forward · M5 ssh_session（v0.2 特性已并入）
 */
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { SshConnection } from "./connection.js";
import { makeSshExecTool } from "./tools/ssh-exec.js";
import { makeSyncPushTool, makeSyncPullTool, type SyncContext } from "./tools/sync.js";
import { makePortForwardTool, closeAllForwards, type Forward } from "./tools/forward.js";
import { makeSshSessionTool, cleanupSessions, type SessionManager } from "./tools/session.js";
import { createHash } from "node:crypto";

export default function (pi: ExtensionAPI) {
  const host = process.env.PI_SSH_HOST;
  if (!host) {
    // 防静默失效：未配置不装死，注册"调用即报错"占位工具
    const stub = (name: string) => pi.registerTool({
      name,
      label: `${name} (unconfigured)`,
      description: "NOT CONFIGURED: set PI_SSH_HOST to a Host alias from ~/.ssh/config.",
      parameters: { type: "object", properties: {}, additionalProperties: false } as never,
      async execute() {
        throw new Error("pi-ssh-remote-run 未配置：请设置 PI_SSH_HOST=<ssh_config 的 Host 别名> 后重启会话。");
      },
    });
    for (const n of ["ssh_exec", "sync_push", "sync_pull", "port_forward", "ssh_session"]) stub(n);
    return;
  }

  const workspaceName = process.cwd().split("/").filter(Boolean).pop() ?? "root";
  const hash = createHash("sha256").update(process.cwd()).digest("hex").slice(0, 8);
  const remoteRoot = `~/pi-remote/${workspaceName}-${hash}`;

  const conn = new SshConnection(host);
  pi.registerTool(makeSshExecTool(conn, remoteRoot));

  const syncCtx: SyncContext = { conn, workspaceRoot: process.cwd(), remoteRoot };
  pi.registerTool(makeSyncPushTool(syncCtx));
  pi.registerTool(makeSyncPullTool(syncCtx));

  const forwards: Forward[] = [];
  pi.registerTool(makePortForwardTool(conn, forwards));

  const sessionMgr: SessionManager = { ephemeral: new Set() };
  pi.registerTool(makeSshSessionTool(conn, sessionMgr, remoteRoot));

  // spec §2.1/§3.4/§3.6：会话结束统一回收转发、临时 tmux 会话、控制连接
  pi.on("session_shutdown", async () => {
    await cleanupSessions(conn, sessionMgr);
    await closeAllForwards(conn, forwards);
    await conn.close();
  });
}

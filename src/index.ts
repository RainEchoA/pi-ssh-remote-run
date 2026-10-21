/**
 * pi-ssh-remote-run 入口（spec §7）
 * M1：connection + ssh_exec。M2：sync_push / sync_pull。forward/session 见 M3/M5。
 */
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { SshConnection } from "./connection.js";
import { makeSshExecTool } from "./tools/ssh-exec.js";
import { makeSyncPushTool, makeSyncPullTool, type SyncContext } from "./tools/sync.js";
import { createHash } from "node:crypto";

export default function (pi: ExtensionAPI) {
  const host = process.env.PI_SSH_HOST;
  if (!host) {
    // 防静默失效：未配置不装死，注册一个"调用即报错"的占位工具让模型看到原因
    pi.registerTool({
      name: "ssh_exec",
      label: "SSH Exec (unconfigured)",
      description: "NOT CONFIGURED: set PI_SSH_HOST to a Host alias from ~/.ssh/config to enable remote execution.",
      parameters: { type: "object", properties: {}, additionalProperties: false } as never,
      async execute() {
        throw new Error(
          "pi-ssh-remote-run 未配置：请设置环境变量 PI_SSH_HOST=<ssh_config 中的 Host 别名> 后重启会话。",
        );
      },
    });
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

  pi.on("session_shutdown", async () => {
    await conn.close();
  });
}

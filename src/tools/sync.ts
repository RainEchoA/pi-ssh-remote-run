/**
 * sync_push / sync_pull — rsync 增量同步（spec §3.2 / §3.3）
 * 复用 ControlMaster 控制连接；.env 特例：突破 .gitignore 总是推送 + 远端 600 强制。
 */
import { Type } from "@sinclair/typebox";
import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type { SshConnection } from "../connection.js";
import { sq } from "../util.js";

export interface SyncStats {
  filesTransferred: number;
  bytesTransferred: number;
  durationMs: number;
  at: string; // ISO
}

/** 解析 rsync --info=stats2 输出 */
export function parseRsyncStats(text: string): Pick<SyncStats, "filesTransferred" | "bytesTransferred"> {
  const files = /Number of (?:regular )?files transferred:\s*([\d,]+)/i.exec(text);
  const bytes = /Total transferred file size:\s*([\d,]+)/i.exec(text);
  return {
    filesTransferred: files ? parseInt(files[1].replace(/,/g, ""), 10) : 0,
    bytesTransferred: bytes ? parseInt(bytes[1].replace(/,/g, ""), 10) : 0,
  };
}

function runRsync(args: string[], timeoutMs = 300_000): Promise<{ stdout: string; stderr: string; code: number }> {
  return new Promise((resolve, reject) => {
    execFile("rsync", args, { timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err && (err as NodeJS.ErrnoException).code === "ENOENT") {
        reject(new Error("本地未找到 rsync。请先安装（macOS: brew install rsync；Debian: apt install rsync）。"));
        return;
      }
      const code = err && typeof err.code === "number" ? err.code : err ? 1 : 0;
      resolve({ stdout: stdout ?? "", stderr: stderr ?? "", code });
    });
  });
}

export interface SyncContext {
  conn: SshConnection;
  workspaceRoot: string;  // 本地工作区绝对路径
  remoteRoot: string;     // 远端同步根
  lastSync?: SyncStats;   // 最近一次 push 的统计（自检字段用）
}

/** 确保远端根存在并收紧权限（700；.env 600 在 push 后单独处理） */
async function ensureRemoteRoot(ctx: SyncContext): Promise<void> {
  await ctx.conn.ensureWithReconnectFlag();
  const r = await runRsync([
    "-e", `ssh -S ${ctx.conn.socketPath()}`,
    "--rsync-path", `mkdir -p ${sq(ctx.remoteRoot)} && chmod 700 ${sq(ctx.remoteRoot)} && rsync`,
    "-a", `${ctx.workspaceRoot}/.`, `${ctx.conn.hostLabel()}:${ctx.remoteRoot}/`,
    "--dry-run", "--out-format=%n", "--exclude=*",
  ]);
  // dry-run + exclude=* 不传输任何文件，仅借 rsync-path 钩子完成 mkdir/chmod
  if (r.code !== 0) {
    throw new Error(`远端根目录准备失败：${r.stderr.trim()}`);
  }
}

export const syncPushParams = Type.Object({
  paths: Type.Optional(Type.Array(Type.String(), {
    description: "Workspace-relative paths to push; default: whole workspace",
  })),
  delete: Type.Optional(Type.Boolean({
    description: "rsync --delete; DANGEROUS, default false",
  })),
});

export function makeSyncPushTool(ctx: SyncContext) {
  return {
    name: "sync_push",
    label: "Sync Push",
    description:
      "Incrementally push local workspace to the remote sync root via rsync over the persistent SSH connection. " +
      "Root .env is ALWAYS pushed even if gitignored, then chmod 600 remotely. " +
      "Non-zero rsync exit = this call FAILS (no silent partial sync). " +
      "Small-storage targets (routers): pass explicit `paths` whitelist instead of pushing the whole tree.",
    parameters: syncPushParams,
    async execute(_id: string, params: { paths?: string[]; delete?: boolean }) {
      await ensureRemoteRoot(ctx);

      const args: string[] = [
        "-az",
        "--info=stats2",
        "-e", `ssh -S ${ctx.conn.socketPath()}`,
        // .env 特例：include 先于 exclude-from 匹配（first-match wins）
        "--include=/.env",
        "--exclude=.git/",
      ];
      if (fs.existsSync(path.join(ctx.workspaceRoot, ".gitignore"))) {
        args.push("--exclude-from=.gitignore");
      }
      if (params.delete) args.push("--delete");

      // /./ 锚点：--relative 只保留锚点之后的相对路径，避免在远端重建本地绝对路径树
      const sources =
        params.paths && params.paths.length > 0
          ? params.paths.map((p) => `${ctx.workspaceRoot}/./${p}`)
          : [`${ctx.workspaceRoot}/`];
      // 指定 paths 时不再套用 gitignore/exclude（白名单语义，spec §3.2 与场景文档 §2）
      const effectiveArgs =
        params.paths && params.paths.length > 0
          ? ["-az", "--info=stats2", "-e", `ssh -S ${ctx.conn.socketPath()}`, "--relative", ...sources, `${ctx.conn.hostLabel()}:${ctx.remoteRoot}/`]
          : [...args, ...sources, `${ctx.conn.hostLabel()}:${ctx.remoteRoot}/`];

      const started = Date.now();
      const r = await runRsync(effectiveArgs);
      if (r.code !== 0) {
        throw new Error(`sync_push 失败（rsync exit ${r.code}）：\n${r.stderr.trim()}`);
      }

      // 远端 .env 权限强制 600（无论本次是否传输了它）
      await ctx.conn.runChecked(`[ ! -f ${sq(ctx.remoteRoot)}/.env ] || chmod 600 ${sq(ctx.remoteRoot)}/.env`);

      const stats = parseRsyncStats(r.stdout + r.stderr);
      ctx.lastSync = {
        ...stats,
        durationMs: Date.now() - started,
        at: new Date().toISOString(),
      };

      return {
        content: [{
          type: "text" as const,
          text: `pushed: ${stats.filesTransferred} files, ${stats.bytesTransferred} bytes in ${ctx.lastSync.durationMs}ms` +
            (params.delete ? " [--delete]" : ""),
        }],
        details: {
          ...ctx.lastSync,
          reconnected: ctx.conn.lastReconnected,
          connection_age_ms: ctx.conn.connectionAgeMs,
          env_file_chmod_enforced: true,
        },
      };
    },
  };
}

export const syncPullParams = Type.Object({
  paths: Type.Array(Type.String(), {
    description: "Remote-root-relative artifact paths (logs, core dumps, build outputs)",
  }),
});

export function makeSyncPullTool(ctx: SyncContext) {
  return {
    name: "sync_pull",
    label: "Sync Pull",
    description:
      "Pull remote artifacts (logs/core/build outputs) into local .remote-artifacts/. " +
      "Returns the pulled file list and sizes.",
    parameters: syncPullParams,
    async execute(_id: string, params: { paths: string[] }) {
      await ctx.conn.ensureWithReconnectFlag();
      const localDir = path.join(ctx.workspaceRoot, ".remote-artifacts");
      fs.mkdirSync(localDir, { recursive: true });

      const sources = params.paths.map((p) => `${ctx.conn.hostLabel()}:${ctx.remoteRoot}/${p}`);
      const args = ["-az", "--info=stats2", "-e", `ssh -S ${ctx.conn.socketPath()}`, ...sources, `${localDir}/`];

      const r = await runRsync(args);
      if (r.code !== 0) {
        throw new Error(`sync_pull 失败（rsync exit ${r.code}）：\n${r.stderr.trim()}`);
      }
      const stats = parseRsyncStats(r.stdout + r.stderr);

      return {
        content: [{
          type: "text" as const,
          text: `pulled ${stats.filesTransferred} files (${stats.bytesTransferred} bytes) into .remote-artifacts/`,
        }],
        details: {
          ...stats,
          reconnected: ctx.conn.lastReconnected,
          connection_age_ms: ctx.conn.connectionAgeMs,
        },
      };
    },
  };
}

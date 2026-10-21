/**
 * ssh_exec — 远端执行（spec §3.1 / §3.1a）
 * 无状态 shell：每次调用独立、显式 cwd、显式 env_file，无任何隐式残留。
 */
import { Type } from "typebox";
import { execFile } from "node:child_process";
import type { SshConnection } from "../connection.js";
import { truncateMiddle, sq } from "../util.js";

const DEFAULT_TIMEOUT_MS = 120_000;

export interface ExecOutcome {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  durationMs: number;
  timedOut: boolean;
}

/** 组装远端包裹命令（env_file → env 覆盖 → cwd → 进程组超时） */
export function buildRemoteCommand(opts: {
  command: string;
  cwd?: string;
  env?: Record<string, string>;
  envFile?: string | false;
  remoteRoot: string;
  timeoutMs: number;
}): string {
  const envFilePath =
    opts.envFile === false
      ? null
      : opts.envFile ?? `${opts.remoteRoot}/.env`;

  const parts: string[] = [];

  // 1) env 文件加载（语法错误必须让整体失败：set -e 生效期内 source）
  //    存在性经 stderr 标记位回探（spec §3.1a：env_file_loaded 必须如实 true/false）
  if (envFilePath) {
    parts.push(
      `if [ -f ${sq(envFilePath)} ]; then echo "__PI_ENVFILE_LOADED__" >&2; ` +
        `set -e; set -a; . ${sq(envFilePath)}; set +a; set +e; fi`,
    );
  }
  // 2) 显式 env 键值，优先级高于 env 文件（后 export 覆盖）
  for (const [k, v] of Object.entries(opts.env ?? {})) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(k)) {
      throw new Error(`非法环境变量名: ${k}`);
    }
    parts.push(`export ${k}=${sq(v)}`);
  }
  // 3) cwd 显式化
  parts.push(`cd ${sq(opts.cwd ?? opts.remoteRoot)}`);
  // 4) 进程组 + 看门狗超时：setsid 独立进程组，watchdog 到期 TERM 全组
  const tSec = Math.ceil(opts.timeoutMs / 1000);
  // 看门狗：到期杀进程组并写标记文件；包装尾段读标记经 stderr 上报 __PI_TIMEOUT__
  // （标记走文件而非直接 echo >&2：后台子shell 若持有 channel 的 stderr 管道，
  //   其被 kill 后残留的 sleep 孤儿会继续持有 fd，导致 ssh 通道挂起——已实测踩过）
  parts.push(
    `__tf=$(mktemp); setsid bash -c ${sq(opts.command)} & __pid=$!; ` +
      `( sleep ${tSec}; kill -TERM -$__pid 2>/dev/null; echo 1 > $__tf ) >/dev/null 2>&1 & __wd=$!; ` +
      `wait $__pid; __rc=$?; kill $__wd 2>/dev/null; ` +
      `[ -s $__tf ] && echo "__PI_TIMEOUT__" >&2; rm -f $__tf; exit $__rc`,
  );
  return `bash -lc ${sq(parts.join("; "))}`;
}

/** 本地执行 ssh，带本地兜底超时（远端 watchdog 之外的双保险） */
export function runRemote(conn: SshConnection, remoteCmd: string, timeoutMs: number): Promise<ExecOutcome> {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const child = execFile("ssh", conn.execArgs(remoteCmd), { timeout: timeoutMs + 10_000, maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) => {
      const durationMs = Date.now() - started;
      const timedOut = !!err && (err as unknown as { killed?: boolean }).killed === true;
      const code = err && typeof err.code === "number" ? err.code : timedOut ? null : err ? 1 : 0;
      resolve({
        stdout: stdout ?? "",
        stderr: stderr ?? "",
        exitCode: code,
        durationMs,
        timedOut,
      });
    });
    child.on("error", reject);
  });
}

export const sshExecParams = Type.Object({
  command: Type.String({ description: "Shell command to run on the remote host (bash -lc semantics)" }),
  cwd: Type.Optional(Type.String({ description: "Remote working directory; defaults to the sync root" })),
  timeout_ms: Type.Optional(Type.Number({ description: `Timeout; default ${DEFAULT_TIMEOUT_MS}ms. On timeout the remote process GROUP is killed.` })),
  env: Type.Optional(
    Type.Record(Type.String(), Type.String(), {
      description: "Explicit env vars; take precedence over env_file",
    }),
  ),
  env_file: Type.Optional(
    Type.Union([Type.String(), Type.Literal(false)], {
      description:
        "Remote .env file to source (auto-export). Default: <sync-root>/.env if present. Pass false to disable for this call.",
    }),
  ),
});

export function makeSshExecTool(conn: SshConnection, remoteRoot: string) {
  return {
    name: "ssh_exec",
    label: "SSH Exec",
    description:
      "Execute a shell command on the remote host over a persistent SSH connection (reused across calls; reconnects are reported). " +
      "Stateless per call: pass cwd explicitly; .env is re-sourced each call when present. " +
      "IMPORTANT: never cat .env or run `env` to dump secrets into context — probe with `[ -n \"$KEY\" ] && echo set || echo unset`. " +
      "Run sync_push first if you edited local files, otherwise the remote runs stale code.",
    parameters: sshExecParams,
    async execute(_id: string, params: {
      command: string;
      cwd?: string;
      timeout_ms?: number;
      env?: Record<string, string>;
      env_file?: string | false;
    }) {
      const timeoutMs = params.timeout_ms ?? DEFAULT_TIMEOUT_MS;
      await conn.ensureWithReconnectFlag();

      const remoteCmd = buildRemoteCommand({
        command: params.command,
        cwd: params.cwd,
        env: params.env,
        envFile: params.env_file,
        remoteRoot,
        timeoutMs,
      });

      const out = await runRemote(conn, remoteCmd, timeoutMs);
      // 超时判定：本地兜底 kill 或远端看门狗标记（剥离标记行）
      const timeoutMarker = "__PI_TIMEOUT__";
      const remoteTimedOut = out.stderr.includes(timeoutMarker);
      // 剥离 env 标记位，得到真实 env_file_loaded
      const envLoadedMarker = "__PI_ENVFILE_LOADED__";
      const envFileLoaded =
        params.env_file === false ? false : out.stderr.includes(envLoadedMarker);
      const cleanStderr = out.stderr
        .split("\n")
        .filter((l) => !l.includes(envLoadedMarker) && !l.includes(timeoutMarker))
        .join("\n");
      const stdout = truncateMiddle(out.stdout);
      const stderr = truncateMiddle(cleanStderr);

      const text = [
        stdout.text,
        stderr.text ? `\n--- stderr ---\n${stderr.text}` : "",
        out.timedOut || remoteTimedOut ? "\n[timeout: remote process group killed]" : "",
      ].join("");

      return {
        content: [{ type: "text" as const, text: text || "(no output)" }],
        details: {
          exit_code: out.exitCode,
          duration_ms: out.durationMs,
          timeout: out.timedOut || remoteTimedOut,
          reconnected: conn.lastReconnected,
          connection_age_ms: conn.connectionAgeMs,
          env_file_loaded: envFileLoaded,
          truncated: stdout.truncated || stderr.truncated || undefined,
          original_bytes: stdout.truncated || stderr.truncated
            ? stdout.originalBytes + stderr.originalBytes
            : undefined,
        },
      };
    },
  };
}

/**
 * ssh_session — tmux 有状态远端会话（spec §3.6，v0.2）
 * 状态载体 = 远端 tmux（可枚举/可重连/可杀）；完成检测 = uuid 哨兵 + $? 回显。
 * 绝不允许 "capture 到输出就当成功"。
 */
import { Type } from "typebox";
import { randomUUID } from "node:crypto";
import type { SshConnection } from "../connection.js";
import type { TargetResolver, ResolvedTarget } from "../targets.js";
import { truncateMiddle, sq } from "../util.js";

const NAME_RE = /^[a-zA-Z0-9_-]+$/;
const DONE_RE = (id: string) => new RegExp(`__PI_DONE_${id}__(\\d+)`);

export interface SessionManager {
  /** persist=false 的会话（"目标名:tmux会话名"），session_shutdown 时清理 */
  ephemeral: Set<string>;
}

async function tmux(conn: SshConnection, args: string, timeoutMs = 20000): Promise<{ code: number; stdout: string; stderr: string }> {
  const r = await conn.runRaw(`tmux ${args}`, timeoutMs);
  return r;
}

export const sshSessionParams = Type.Object({
  action: Type.Union(
    ["open", "send", "wait", "capture", "list", "close"].map((v) => Type.Literal(v)),
    { description: "open/send/wait/capture/list/close" },
  ),
  target: Type.Optional(
    Type.String({ description: "Target name from pi-ssh-remote.json whitelist; default: config default. Unknown name => explicit error." }),
  ),
  name: Type.Optional(Type.String({ description: 'Session name [a-zA-Z0-9_-], default "default"; tmux name = pi-<name>' })),
  cwd: Type.Optional(Type.String({ description: "open: remote working directory" })),
  env_file: Type.Optional(
    Type.Union([Type.String(), Type.Literal(false)], {
      description: "open: env file sourced once into the session (semantics per §3.1a)",
    }),
  ),
  input: Type.Optional(Type.String({ description: "send: command line to send (auto-wrapped with done-sentinel)" })),
  pattern: Type.Optional(Type.String({ description: "wait: regex to match in captured output; default = done-sentinel of the last send" })),
  timeout_ms: Type.Optional(Type.Number({ description: "wait: default 60000" })),
  lines: Type.Optional(Type.Number({ description: "capture: scrollback lines, default 200" })),
  persist: Type.Optional(Type.Boolean({ description: "open: survive pi session exit; default false" })),
});

export function makeSshSessionTool(resolve: TargetResolver, mgr: SessionManager) {
  /** 每个会话最近一次 send 的哨兵 id（key = "目标:tmux会话名"，wait 缺省 pattern 用） */
  const lastSentinel = new Map<string, string>();

  const tname = (name?: string) => {
    const n = name ?? "default";
    if (!NAME_RE.test(n)) throw new Error(`非法会话名 "${n}"：仅允许 [a-zA-Z0-9_-]`);
    return `pi-${n}`;
  };

  return {
    name: "ssh_session",
    label: "SSH Session",
    description:
      "Stateful remote shell session backed by remote tmux (survives reconnects; enumerable/killable). " +
      "Use `target` to pick a host from the pi-ssh-remote.json whitelist; unknown targets fail explicitly. " +
      "Use for interactive REPL/gdb/multi-step stateful work; use ssh_exec for one-shot commands. " +
      "send auto-wraps a done-sentinel; completion is judged by wait() matching the sentinel and parsing exit_code — " +
      "NEVER treat captured output as completion.",
    parameters: sshSessionParams,
    async execute(_id: string, params: {
      action: "open" | "send" | "wait" | "capture" | "list" | "close";
      target?: string;
      name?: string; cwd?: string; env_file?: string | false;
      input?: string; pattern?: string; timeout_ms?: number; lines?: number; persist?: boolean;
    }): Promise<any> {
      const resolved: ResolvedTarget = resolve(params.target);
      const { name: targetName, conn, remoteRoot } = resolved;
      await conn.ensureWithReconnectFlag();
      const base = { target: targetName, reconnected: conn.lastReconnected, connection_age_ms: conn.connectionAgeMs };
      const key = (t: string) => `${targetName}:${t}`;

      switch (params.action) {
        case "open": {
          const t = tname(params.name);
          const exists = await tmux(conn, `has-session -t ${sq(t)} 2>/dev/null`);
          if (exists.code === 0) {
            return { content: [{ type: "text" as const, text: `session ${t}: already existed` }], details: { ...base, name: t, opened: false, already_existed: true } };
          }
          // tmux 缺失检测：显式报错，不降级
          const chk = await conn.runRaw("command -v tmux", 10000);
          if (chk.code !== 0) {
            throw new Error("远端未安装 tmux（ssh_session 的完成检测与回卷依赖它，不降级）。安装：apt/apk/opkg install tmux");
          }
          const mk = await tmux(conn, `new-session -d -s ${sq(t)} -x 220 -y 50`);
          if (mk.code !== 0) throw new Error(`tmux new-session 失败：${mk.stderr.trim()}`);
          // 初始环境：cwd + env_file（open 时加载一次，驻留会话）
          const init: string[] = [];
          const envPath = params.env_file === false ? null : params.env_file ?? `${remoteRoot}/.env`;
          if (envPath) init.push(`[ -f ${sq(envPath)} ] && set -a && . ${sq(envPath)} && set +a`);
          init.push(`cd ${sq(params.cwd ?? remoteRoot)}`);
          await tmux(conn, `send-keys -t ${sq(t)} -l ${sq(init.join("; "))}`);
          await tmux(conn, `send-keys -t ${sq(t)} Enter`);
          if (!params.persist) mgr.ephemeral.add(key(t));
          return { content: [{ type: "text" as const, text: `session ${t}: opened` }], details: { ...base, name: t, opened: true, persist: !!params.persist } };
        }

        case "send": {
          if (!params.input) throw new Error("send 需要 input");
          const t = tname(params.name);
          const id = randomUUID().replace(/-/g, "").slice(0, 12);
          const wrapped = `${params.input}; __rc=$?; echo "__PI_DONE_${id}__$__rc"`;
          // send-keys -l 字面模式，Enter 单独发送（spec §3.6）
          await tmux(conn, `send-keys -t ${sq(t)} -l ${sq(wrapped)}`);
          await tmux(conn, `send-keys -t ${sq(t)} Enter`);
          lastSentinel.set(key(t), id);
          return { content: [{ type: "text" as const, text: `sent to ${t} (sentinel ${id}); use wait to detect completion` }], details: { ...base, name: t, sent: true, sentinel: id } };
        }

        case "wait": {
          const t = tname(params.name);
          const timeoutMs = params.timeout_ms ?? 60_000;
          const sentinel = params.pattern ? null : lastSentinel.get(key(t));
          if (!params.pattern && !sentinel) throw new Error(`会话 ${t} 尚无 send 记录，wait 需显式 pattern`);
          const re = params.pattern ? new RegExp(params.pattern) : DONE_RE(sentinel!);
          const deadline = Date.now() + timeoutMs;
          let last = "";
          while (Date.now() < deadline) {
            const cap = await tmux(conn, `capture-pane -p -t ${sq(t)} -S -500`);
            last = cap.stdout;
            const m = re.exec(last);
            if (m) {
              const out = truncateMiddle(last);
              return {
                content: [{ type: "text" as const, text: out.text }],
                details: { ...base, name: t, matched: true, exit_code: m[1] !== undefined ? parseInt(m[1], 10) : undefined, truncated: out.truncated || undefined },
              };
            }
            await new Promise((r) => setTimeout(r, 500));
          }
          const tail = truncateMiddle(last.split("\n").slice(-40).join("\n"));
          return {
            content: [{ type: "text" as const, text: `[timeout ${timeoutMs}ms, not matched]\n${tail.text}` }],
            details: { ...base, name: t, matched: false, timeout: true },
          };
        }

        case "capture": {
          const t = tname(params.name);
          const cap = await tmux(conn, `capture-pane -p -t ${sq(t)} -S -${params.lines ?? 200}`);
          if (cap.code !== 0) throw new Error(`capture 失败：${cap.stderr.trim()}`);
          const out = truncateMiddle(cap.stdout);
          return { content: [{ type: "text" as const, text: out.text || "(empty)" }], details: { ...base, name: t, truncated: out.truncated || undefined } };
        }

        case "list": {
          const r = await tmux(conn, `ls -F "#{session_name}" 2>/dev/null`);
          const sessions = r.stdout.split("\n").map((s) => s.trim()).filter((s) => s.startsWith("pi-"));
          return { content: [{ type: "text" as const, text: sessions.length ? sessions.join("\n") : "(no pi- sessions)" }], details: { ...base, sessions } };
        }

        case "close": {
          const t = tname(params.name);
          const r = await tmux(conn, `kill-session -t ${sq(t)} 2>&1`);
          if (r.code !== 0) throw new Error(`close 失败（会话 ${t} 不存在？）：${r.stderr.trim() || r.stdout.trim()}`);
          mgr.ephemeral.delete(key(t));
          lastSentinel.delete(key(t));
          return { content: [{ type: "text" as const, text: `session ${t}: closed` }], details: { ...base, name: t, closed: true } };
        }
      }
    },
  };
}

/** session_shutdown：kill 全部 persist=false 会话（按目标找到各自连接） */
export async function cleanupSessions(
  mgr: SessionManager,
  resolvedTargets: readonly { name: string; conn: SshConnection }[],
): Promise<void> {
  for (const k of mgr.ephemeral) {
    const sep = k.indexOf(":");
    const targetName = k.slice(0, sep);
    const t = k.slice(sep + 1);
    const conn = resolvedTargets.find((x) => x.name === targetName)?.conn;
    if (!conn) continue;
    try { await conn.runRaw(`tmux kill-session -t '${t}' 2>/dev/null`, 8000); } catch { /* 清理不抛错 */ }
  }
  mgr.ephemeral.clear();
}

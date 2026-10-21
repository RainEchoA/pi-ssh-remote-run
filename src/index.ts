/**
 * pi-ssh-remote-run 入口（spec §7）
 * M1 ssh_exec · M2 sync_push/pull · M3 port_forward · M5 ssh_session · 多目标白名单（pi-ssh-remote.json）
 *
 * 目标解析优先级：
 *   1. 工作区 pi-ssh-remote.json（白名单，target 参数可选；非法配置 → 工具调用即报错，不静默回退）
 *   2. PI_SSH_HOST 环境变量（单目标，名为 "default"）
 *   都没有 → 注册"调用即报错"占位工具（防静默失效）
 */
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { TargetPool, loadTargetsConfig, CONFIG_FILENAME } from "./targets.js";
import { makeSshExecTool } from "./tools/ssh-exec.js";
import { makeSyncPushTool, makeSyncPullTool, type SyncContext } from "./tools/sync.js";
import { makePortForwardTool, closeAllForwards, type ForwardRegistry } from "./tools/forward.js";
import { makeSshSessionTool, cleanupSessions, type SessionManager } from "./tools/session.js";
import { createHash } from "node:crypto";

export default function (pi: ExtensionAPI) {
  const workspaceRoot = process.cwd();
  const workspaceName = workspaceRoot.split("/").filter(Boolean).pop() ?? "root";
  const hash = createHash("sha256").update(workspaceRoot).digest("hex").slice(0, 8);
  const derivedRoot = `~/pi-remote/${workspaceName}-${hash}`;

  // 配置解析在工具调用时进行：配置文件非法 → 每次调用都显式报错（而不是启动时静默吞掉）
  let pool: TargetPool | null = null;
  let configError: Error | null = null;
  try {
    const cfg = loadTargetsConfig(workspaceRoot);
    if (cfg) {
      const targets: Record<string, { host: string; remoteRoot: string }> = {};
      for (const [name, t] of Object.entries(cfg.targets)) {
        targets[name] = { host: t.host, remoteRoot: t.remote_root ?? derivedRoot };
      }
      pool = new TargetPool({ targets, defaultName: cfg.default ?? Object.keys(targets)[0] });
    }
  } catch (e) {
    configError = e as Error;
  }

  if (!pool && !configError) {
    const host = process.env.PI_SSH_HOST;
    if (host) {
      pool = new TargetPool({ targets: { default: { host, remoteRoot: derivedRoot } }, defaultName: "default" });
    }
  }

  if (!pool) {
    // 防静默失效：未配置不装死，注册"调用即报错"占位工具
    const reason = configError
      ? `${CONFIG_FILENAME} 配置非法：${configError.message}`
      : `未配置目标：在工作区创建 ${CONFIG_FILENAME}（{"targets": {"gpu": {"host": "<ssh_config Host 别名>"}}}），或设置 PI_SSH_HOST 后重启会话。`;
    const stub = (name: string) => pi.registerTool({
      name,
      label: `${name} (unconfigured)`,
      description: `NOT CONFIGURED: ${reason}`,
      parameters: { type: "object", properties: {}, additionalProperties: false } as never,
      async execute() {
        throw new Error(`pi-ssh-remote-run 不可用：${reason}`);
      },
    });
    for (const n of ["ssh_exec", "sync_push", "sync_pull", "port_forward", "ssh_session"]) stub(n);
    return;
  }

  const thePool = pool;
  pi.registerTool(makeSshExecTool(thePool.resolve));

  const syncCtx: SyncContext = { resolve: thePool.resolve, workspaceRoot };
  pi.registerTool(makeSyncPushTool(syncCtx));
  pi.registerTool(makeSyncPullTool(syncCtx));

  const forwards: ForwardRegistry = new Map();
  pi.registerTool(makePortForwardTool(thePool.resolve, forwards));

  const sessionMgr: SessionManager = { ephemeral: new Set() };
  pi.registerTool(makeSshSessionTool(thePool.resolve, sessionMgr));

  // spec §2.1/§3.4/§3.6：会话结束统一回收各目标上的转发、临时 tmux 会话、控制连接
  pi.on("session_shutdown", async () => {
    const resolved = thePool.resolved();
    await cleanupSessions(sessionMgr, resolved);
    await closeAllForwards(forwards, resolved);
    await thePool.closeAll();
  });
}

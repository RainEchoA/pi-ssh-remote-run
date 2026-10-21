/**
 * ControlMaster 生命周期管理（spec §2.1）
 * 传输层 = 系统 OpenSSH 子进程 + 单一控制连接，所有 exec/rsync/forward 复用。
 * 配置单一事实源在 ~/.ssh/config，本模块不解析、不覆盖。
 */
import { execFile, type ExecFileException } from "node:child_process";
import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";

const CONTROL_PERSIST = "600"; // seconds
const CONNECT_TIMEOUT = "10";

export class SshError extends Error {
  constructor(
    message: string,
    readonly category: "auth" | "dns" | "timeout" | "hostkey" | "unknown",
    readonly stderr: string,
  ) {
    super(message);
    this.name = "SshError";
  }
}

export function classifySshError(stderr: string): SshError["category"] {
  const s = stderr.toLowerCase();
  if (/permission denied|authentication/.test(s)) return "auth";
  if (/could not resolve hostname|name or service not known/.test(s)) return "dns";
  if (/timed out|operation timed out/.test(s)) return "timeout";
  if (/host key verification failed|remote host identification/.test(s)) return "hostkey";
  return "unknown";
}

export class SshConnection {
  private socket: string;
  private host: string;
  private masterStartedAt = 0;
  /** 上次调用前是否发生了连接重建（spec §4：必须如实上报） */
  lastReconnected = false;

  constructor(host: string) {
    this.host = host;
    const hash = createHash("sha256").update(host).digest("hex").slice(0, 12);
    const dir = process.env.XDG_RUNTIME_DIR ?? os.tmpdir();
    this.socket = path.join(dir, `pi-ssh-${hash}.sock`);
  }

  get connectionAgeMs(): number {
    return this.masterStartedAt ? Date.now() - this.masterStartedAt : 0;
  }

  private run(args: string[], timeoutMs = 15000): Promise<{ stdout: string; stderr: string; code: number }> {
    return new Promise((resolve) => {
      execFile("ssh", args, { timeout: timeoutMs }, (err: ExecFileException | null, stdout: string, stderr: string) => {
        // execFile 对非零退出也给 err；统一按 code 处理
        const code = err && typeof err.code === "number" ? err.code : err ? 1 : 0;
        resolve({ stdout: stdout ?? "", stderr: stderr ?? "", code });
      });
    });
  }

  /** 探活：控制连接是否可用 */
  private async check(): Promise<boolean> {
    const r = await this.run(["-S", this.socket, "-O", "check", this.host], 8000);
    return r.code === 0;
  }

  /** 建立主连接（-MNf 后台驻留） */
  private async startMaster(): Promise<void> {
    const r = await this.run([
      "-MNf",
      "-S", this.socket,
      "-o", `ControlPersist=${CONTROL_PERSIST}`,
      "-o", `ConnectTimeout=${CONNECT_TIMEOUT}`,
      "-o", "ServerAliveInterval=15",
      "-o", "ServerAliveCountMax=3",
      this.host,
    ], 20000);
    if (r.code !== 0) {
      const cat = classifySshError(r.stderr);
      const hint: Record<SshError["category"], string> = {
        auth: "认证失败：检查 ~/.ssh/config 中该 Host 的 IdentityFile/用户，或 ssh-agent 是否加载密钥",
        dns: "DNS 解析失败：确认 PI_SSH_HOST 与 ssh_config 里的 Host 别名拼写",
        timeout: "连接超时：检查网络/ProxyJump 链路",
        hostkey: "host key 校验失败：先手动 ssh 一次确认指纹写入 known_hosts",
        unknown: "SSH 连接失败，原因见 stderr",
      };
      throw new SshError(`${hint[cat]}\nstderr: ${r.stderr.trim()}`, cat, r.stderr);
    }
    this.masterStartedAt = Date.now();
  }

  /**
   * 确保控制连接可用。每次工具调用前调用。
   * 断链时自动重建并置 lastReconnected = true（由调用方上报）。
   */
  async ensureWithReconnectFlag(): Promise<void> {
    const hadMaster = this.masterStartedAt > 0;
    const wasAlive = await this.check();
    if (!wasAlive) {
      await this.startMaster();
      if (!(await this.check())) {
        throw new SshError("控制连接建立后探活仍失败", "unknown", "");
      }
    }
    // 已有过主连接且刚刚（5s 内）重建 → 上报 reconnected
    this.lastReconnected = hadMaster && !wasAlive && Date.now() - this.masterStartedAt < 5000;
  }

  /** 通过控制连接执行远端命令的参数（调用方负责超时/截断） */
  execArgs(remoteCommand: string): string[] {
    return ["-S", this.socket, this.host, remoteCommand];
  }

  /** 显式关闭控制连接（session_shutdown 时调用） */
  async close(): Promise<void> {
    try {
      await this.run(["-S", this.socket, "-O", "exit", this.host], 5000);
    } catch {
      /* 清理路径不抛错 */
    }
    this.masterStartedAt = 0;
  }
}

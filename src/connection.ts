/**
 * ControlMaster 生命周期管理（spec §2.1）
 * 传输层 = 系统 OpenSSH 子进程 + 单一控制连接，所有 exec/rsync/forward 复用。
 * 配置单一事实源在 ~/.ssh/config，本模块不解析、不覆盖。
 */
import { execFile, spawn, type ExecFileException } from "node:child_process";
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
  private everConnected = false; // 本会话进程内是否建立过主连接（reconnected 语义基准）
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

  /** rsync -e 复用控制连接所需 */
  socketPath(): string {
    return this.socket;
  }

  hostLabel(): string {
    return this.host;
  }

  /** 执行远端命令，非零退出即抛错（供 sync 的远端权限修正等使用） */
  async runChecked(remoteCommand: string, timeoutMs = 15000): Promise<string> {
    await this.ensureWithReconnectFlag();
    return new Promise((resolve, reject) => {
      execFile("ssh", this.execArgs(remoteCommand), { timeout: timeoutMs }, (err, stdout, stderr) => {
        const code = err && typeof err.code === "number" ? err.code : err ? 1 : 0;
        if (code !== 0) {
          reject(new Error(`远端命令失败(exit ${code})：${(stderr ?? "").trim()}`));
        } else {
          resolve(stdout ?? "");
        }
      });
    });
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

  /**
   * 建立主连接（-MNf 后台驻留）。
   * 注意：-f 派生的 daemon 继承父进程 stdout/stderr 管道，若用 execFile 收集输出，
   * 回调要等管道关闭（即到 master 退出）——会挂死整次调用。
   * 因此 spawn + stdio:"ignore"（stderr 暂存文件用于失败归因），轮询 check 判定就绪。
   */
  private async startMaster(): Promise<void> {
    const fs = await import("node:fs");
    const errLog = `${this.socket}.err`;
    const errFd = fs.openSync(errLog, "w");
    const child = spawn("ssh", [
      "-MNf",
      "-S", this.socket,
      "-o", `ControlPersist=${CONTROL_PERSIST}`,
      "-o", `ConnectTimeout=${CONNECT_TIMEOUT}`,
      "-o", "ServerAliveInterval=15",
      "-o", "ServerAliveCountMax=3",
      this.host,
    ], { stdio: ["ignore", "ignore", errFd], detached: true });
    child.unref();

    // 轮询就绪（最多 ~15s），失败则读 stderr 归因
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 300));
      if (await this.check()) {
        fs.closeSync(errFd);
        this.masterStartedAt = Date.now();
        this.everConnected = true;
        return;
      }
      if (child.exitCode !== null) break; // 客户端已退出且未就绪 → 失败
    }
    fs.closeSync(errFd);
    let stderr = "";
    try { stderr = fs.readFileSync(errLog, "utf8"); } catch { /* ignore */ }
    const cat = classifySshError(stderr);
    const hint: Record<SshError["category"], string> = {
      auth: "认证失败：检查 ~/.ssh/config 中该 Host 的 IdentityFile/用户，或 ssh-agent 是否加载密钥",
      dns: "DNS 解析失败：确认 PI_SSH_HOST 与 ssh_config 里的 Host 别名拼写",
      timeout: "连接超时：检查网络/ProxyJump 链路",
      hostkey: "host key 校验失败：先手动 ssh 一次确认指纹写入 known_hosts",
      unknown: "SSH 连接失败，原因见 stderr",
    };
    throw new SshError(`${hint[cat]}\nstderr: ${stderr.trim()}`, cat, stderr);
  }

  /**
   * 确保控制连接可用（每次工具调用前调用）。
   * 断链时自动重建并置 lastReconnected = true（spec §4：如实上报）。
   */
  async ensureWithReconnectFlag(): Promise<void> {
    const hadMaster = this.everConnected;
    const wasAlive = await this.check();
    if (wasAlive && !hadMaster) {
      // 接管了既有主连接（同 socket 路径，如崩溃残留/上一次会话）：以接管时刻为年龄起点
      this.masterStartedAt = Date.now();
      this.everConnected = true; // 接管也算"建立过"，否则后续重建不报 reconnected（实测踩过）
    }
    if (!wasAlive) {
      await this.startMaster();
      if (!(await this.check())) {
        throw new SshError("控制连接建立后探活仍失败", "unknown", "");
      }
    }
    // 已有过主连接且刚刚重建 → 上报 reconnected
    this.lastReconnected = hadMaster && !wasAlive;
  }

  /** 执行远端命令，非零不抛错（供 tmux 探测等"失败即信息"场景） */
  async runRaw(remoteCommand: string, timeoutMs = 20000): Promise<{ code: number; stdout: string; stderr: string }> {
    await this.ensureWithReconnectFlag();
    return new Promise((resolve) => {
      execFile("ssh", this.execArgs(remoteCommand), { timeout: timeoutMs }, (err, stdout, stderr) => {
        const code = err && typeof err.code === "number" ? err.code : err ? 1 : 0;
        resolve({ code, stdout: stdout ?? "", stderr: stderr ?? "" });
      });
    });
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

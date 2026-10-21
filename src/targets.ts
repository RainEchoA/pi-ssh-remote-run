/**
 * 多目标管理：pi-ssh-remote.json 白名单 + 每目标一条 ControlMaster 连接（spec §3.0）
 *
 * 防静默失效：
 * - 配置文件存在但非法 → 抛错（绝不静默忽略配置、退回默认主机）
 * - target 参数不在白名单 → 显式报错并列出可用目标（绝不静默落到别的主机）
 */
import fs from "node:fs";
import path from "node:path";
import { SshConnection } from "./connection.js";

export const CONFIG_FILENAME = "pi-ssh-remote.json";

/** 目标名：白名单 key，给人看也进错误信息，收紧字符集 */
const TARGET_NAME_RE = /^[a-z0-9][a-z0-9_-]{0,31}$/;
/** ssh_config Host 别名：作为 ssh 的单一 argv 传递，禁空白/元字符/通配 */
const HOST_ALIAS_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export interface TargetSpec {
  /** ~/.ssh/config 里的 Host 别名 */
  host: string;
  /** 远端同步根；缺省由入口处按工作区派生 */
  remote_root?: string;
}

export interface TargetsConfig {
  targets: Record<string, TargetSpec>;
  default?: string;
}

/** 加载并校验 pi-ssh-remote.json；文件不存在返回 null（合法，走 PI_SSH_HOST 兜底） */
export function loadTargetsConfig(workspaceRoot: string): TargetsConfig | null {
  const p = path.join(workspaceRoot, CONFIG_FILENAME);
  if (!fs.existsSync(p)) return null;

  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(p, "utf8"));
  } catch (e) {
    throw new Error(`${CONFIG_FILENAME} 不是合法 JSON：${(e as Error).message}。修复或删除该文件，不会静默忽略。`);
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new Error(`${CONFIG_FILENAME} 必须是 JSON 对象（{"targets": {...}}）。`);
  }
  const cfg = raw as { targets?: unknown; default?: unknown };
  if (typeof cfg.targets !== "object" || cfg.targets === null || Array.isArray(cfg.targets)) {
    throw new Error(`${CONFIG_FILENAME} 缺少 "targets" 对象。`);
  }
  const targets = cfg.targets as Record<string, unknown>;
  const names = Object.keys(targets);
  if (names.length === 0) {
    throw new Error(`${CONFIG_FILENAME} 的 "targets" 为空：白名单至少要有一个目标。`);
  }

  const out: Record<string, TargetSpec> = {};
  for (const name of names) {
    if (!TARGET_NAME_RE.test(name)) {
      throw new Error(`${CONFIG_FILENAME}: 非法目标名 "${name}"（允许 ${TARGET_NAME_RE}）。`);
    }
    const t = targets[name];
    if (typeof t !== "object" || t === null) {
      throw new Error(`${CONFIG_FILENAME}: 目标 "${name}" 必须是对象（{"host": "..."}）。`);
    }
    const spec = t as { host?: unknown; remote_root?: unknown };
    if (typeof spec.host !== "string" || !HOST_ALIAS_RE.test(spec.host)) {
      throw new Error(
        `${CONFIG_FILENAME}: 目标 "${name}" 的 host 非法：必须是 ~/.ssh/config 里的 Host 别名（${HOST_ALIAS_RE}），收到 ${JSON.stringify(spec.host)}。`,
      );
    }
    if (spec.remote_root !== undefined && (typeof spec.remote_root !== "string" || spec.remote_root.length === 0)) {
      throw new Error(`${CONFIG_FILENAME}: 目标 "${name}" 的 remote_root 必须是非空字符串。`);
    }
    out[name] = { host: spec.host, remote_root: spec.remote_root as string | undefined };
  }

  if (cfg.default !== undefined) {
    if (typeof cfg.default !== "string" || !(cfg.default in out)) {
      throw new Error(`${CONFIG_FILENAME}: "default" 必须是 targets 里的一个名字，收到 ${JSON.stringify(cfg.default)}。`);
    }
  }
  return { targets: out, default: cfg.default as string | undefined };
}

export interface ResolvedTarget {
  name: string;
  conn: SshConnection;
  remoteRoot: string;
}

/** 工具侧统一入口：按 target 参数解析出连接与同步根；未知目标即抛错 */
export type TargetResolver = (target?: string) => ResolvedTarget;

export class TargetPool {
  private cache = new Map<string, ResolvedTarget>();

  constructor(
    private readonly opts: {
      targets: Record<string, { host: string; remoteRoot: string }>;
      defaultName: string;
    },
  ) {}

  names(): string[] {
    return Object.keys(this.opts.targets);
  }

  defaultName(): string {
    return this.opts.defaultName;
  }

  resolve: TargetResolver = (target?: string): ResolvedTarget => {
    const name = target ?? this.opts.defaultName;
    const spec = this.opts.targets[name];
    if (!spec) {
      throw new Error(
        target
          ? `目标 "${name}" 不在白名单。可用目标: ${this.names().join(", ")}（在 ${CONFIG_FILENAME} 中登记后才能使用）`
          : `默认目标 "${name}" 不在白名单。可用目标: ${this.names().join(", ")}`,
      );
    }
    let r = this.cache.get(name);
    if (!r) {
      r = { name, conn: new SshConnection(spec.host), remoteRoot: spec.remoteRoot };
      this.cache.set(name, r);
    }
    return r;
  };

  /** 已建立连接的目标（session_shutdown 清理用，不为未用过的目标建连） */
  resolved(): ResolvedTarget[] {
    return [...this.cache.values()];
  }

  async closeAll(): Promise<void> {
    for (const r of this.cache.values()) {
      await r.conn.close();
    }
  }
}

/** 单目标适配器：测试与旧调用路径用；白名单语义保持一致 */
export function singleTargetResolver(conn: SshConnection, remoteRoot: string, name = "default"): TargetResolver {
  return (target?: string) => {
    if (target !== undefined && target !== name) {
      throw new Error(`目标 "${target}" 不在白名单。可用目标: ${name}`);
    }
    return { name, conn, remoteRoot };
  };
}

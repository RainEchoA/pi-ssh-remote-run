# 场景：macOS 开发 OpenWrt 插件，推送到测试路由器

> 对应规格：§3 工具契约、§9 remote-runbook skill
> 角色：本地 = macOS（pi agent + 编辑器）；远端 = OpenWrt 测试路由器（mips/arm， ash/busybox 环境）

## 0. 环境准备（一次性）

`~/.ssh/config`（配置单一事实源，扩展不重复实现）：

```
Host wrt-test
    HostName 192.168.1.1
    User root
    # OpenWrt 默认 dropbear；如用 openssh-server 无区别
    # 老设备可能需加：HostkeyAlgorithms +ssh-rsa / PubkeyAcceptedAlgorithms +ssh-rsa

Host wrt-build            # 可选：x86 构建机（跑 OpenWrt SDK 交叉编译）
    HostName 10.0.0.20
    User builder
    ProxyJump bastion     # 跳板机也在这里声明
```

```bash
pi install git:github.com/RainEchoA/pi-ssh-remote-run
export PI_SSH_HOST=wrt-test
```

**注意**：本场景有两个远端——构建机（编译 ipk）和路由器（运行调试）。v0.1 单主机，
推荐组合：**构建在本地 macOS（OpenWrt SDK 容器）完成，`PI_SSH_HOST=wrt-test` 只面向路由器**；
需要构建机时另开一个 pi 会话指向 `wrt-build`（多工作区/多会话天然隔离，spec §5 远端根带 hash）。

## 1. 典型循环（agent 视角）

### 1.1 改代码 → 同步 → 路由器上验证

```
本地编辑 src/plugin.c（内置 edit 工具）
  │
  ├─ sync_push                       # rsync 增量；.env（如测试用 token）突破 .gitignore 一起推
  │                                  # details 返回传输文件数/字节数——可计数
  │
  ├─ ssh_exec: cd 远端根 && 本地交叉编译产物已含？（见 §2 两种构建模式）
  │
  └─ ssh_exec: "opkg remove myplugin; opkg install ./myplugin_*.ipk && /etc/init.d/myplugin restart"
       # 返回 exit_code / duration_ms；失败即失败，无假成功
```

### 1.2 看日志、定位问题

```
ssh_exec: "logread | tail -50"                      # 一次性命令，走 ssh_exec
ssh_exec: "logread -f"  ← 错误用法！长驻滚动日志应走 ssh_session（v0.2）：
    open("logs") → send("logread -f") → capture(lines=100) → 排查完 close
```

### 1.3 崩溃调试

```
# 路由器上开启 core dump 后复现
ssh_exec: "ulimit -c unlimited && /etc/init.d/myplugin restart && logread | tail -5"
# 拉回 core（sync_pull → 本地 .remote-artifacts/），本地用 SDK 里的交叉 gdb 分析
sync_pull: ["core", "tmp/myplugin.log"]
本地: gdb-multiarch -batch -ex bt ./myplugin .remote-artifacts/core   # 本地工具，不经扩展

# 或在路由器上直接 gdbserver（mips 大端资源紧张时首选）
ssh_exec: "gdbserver :2345 /usr/bin/myplugin --debug &"
port_forward: remote_port=2345
本地 IDE / agent 驱动交叉 gdb target remote localhost:2345
```

### 1.4 性能采样（py-spy 不适用 C 插件，用 perf 或 strace）

```
ssh_exec: "opkg install strace && strace -c -p $(pgrep myplugin)"   # 调用统计
ssh_exec: "perf top -p $(pgrep myplugin)"   → 长驻输出 → 改用 ssh_session
```

## 2. 两种构建模式的分工

| 模式 | 流程 | 适用 |
|---|---|---|
| **A. 本地容器交叉编译**（推荐） | 本地 docker 跑 OpenWrt SDK → 产出 ipk → `sync_push` 只推 ipk + 配置 | 日常迭代，路由器存储小（/tmp 通常几十 MB），不应把源码树推上去 |
| **B. 构建机编译** | `sync_push` 源码到 wrt-build（另一 pi 会话）→ ssh_exec make package/compile → `sync_pull` 拉回 ipk → 本会话 push 到路由器 | 无本地 docker 环境；多主机编排待 v0.2+ |

模式 A 下建议工作区加 `.sync-include` 约定：把 `bin/*.ipk`、`files/` 配置列入推送，`src/`、`build_dir/` 排除——
具体通过 sync_push 的 `paths` 参数显式选择（spec §3.2）。

## 3. 本场景命中的规格条款（验收牵引）

| 规格条款 | 本场景对应 |
|---|---|
| §8.1 冷启动复用 | 第一次 `opkg install` 慢（建链），后续命令 ~10ms 级 |
| §8.2 断链重建 | 路由器 reboot 后第一次 ssh_exec 报 `reconnected: true` |
| §8.5 超时杀进程组 | `ssh_exec("/etc/init.d/myplugin restart", timeout_ms=30000)` 卡住时不留孤儿 |
| §8.10 env 闭环 | 测试 token 放 .env 推送到路由器，init 脚本 `procd` 环境加载验证用存在性探针 |
| §9 ③ playbook | core 调试 / 日志闭环模板 |

## 4. 已知边界（诚实声明）

- OpenWrt 默认 **dropbear** 不支持 ControlMaster 的部分特性？——实测点：dropbear 服务端兼容
  ControlMaster（它只是 SSH 通道复用，服务端无感）；但路由器**本地**没有 rsync 时 sync_push 会失败，
  需 `opkg install rsync`（spec §5 远端要求已在报错中提示安装命令）。
- 路由器闪存小：`sync_push` 默认推整个工作区可能超限，必须用 `paths` 白名单（§2 模式 A）。
- `port_forward` 绑定的本地端口在 macOS 上 <1024 需权限——playbook 统一用 2345 这类高端口。

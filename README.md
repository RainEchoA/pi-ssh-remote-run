# pi-ssh-remote-run

Pi coding agent 扩展：**本地开发，远程运行调试**。内置 read/write/edit 留在本地，
远端执行面通过复用的 SSH 长连接（OpenSSH ControlMaster，每目标一条）提供。

## 工具

| 工具 | 状态 | 说明 |
|---|---|---|
| `ssh_exec` | M1 ✅ | 远端执行，无状态 shell，env_file 自动加载，超时杀远端进程组 |
| `sync_push` / `sync_pull` | M2 ✅ | rsync 增量同步（.env 特例：突破 gitignore 总是推送，远端强制 600） |
| `port_forward` | M3 ✅ | 调试端口转发（-O forward 动态挂到控制连接；端口占用显式报错，不自动换端口） |
| `ssh_session` | M5 ✅ | tmux 有状态会话（REPL/gdb/多步操作；哨兵完成检测 + exit_code 如实上报） |
| `remote-runbook` skill | M4 ✅ | 工具路由规则 + 多目标白名单引导 + 远程调试 playbook + 失败处理纪律 |

设计规格：[docs/spec.zh-CN.md](docs/spec.zh-CN.md)（含 17 条实测验收标准）。
场景示例：[docs/scenarios/macos-openwrt-plugin.md](docs/scenarios/macos-openwrt-plugin.md)（macOS 开发 OpenWrt 插件推送到测试路由器）。

## 测试

- 单元：`test/unit.test.ts`，16 例（buildRemoteCommand / rsync 统计解析 / 截断 / 错误归因 / 白名单配置与连接池），无网络。
- 端到端：`test/e2e.test.ts`，15 例，需 `CI_E2E=1` + ssh_config 里的 `ci-remote` 主机
  （覆盖 spec §8.1/8.2/8.3/8.5/8.6/8.7/8.9/8.10/8.11/8.12/8.13/8.14/8.15/8.17 + sync_pull + 转发通路）。
  未设 CI_E2E 时跳过而非假绿。
- CI：GitHub Actions（ubuntu+macOS 构建矩阵；e2e job 在 runner 上起真实 sshd:2222 跑全量验收）。

## 安装与配置

```bash
pi install git:github.com/RainEchoA/pi-ssh-remote-run
export PI_SSH_HOST=gpu-box   # ~/.ssh/config 里的 Host 别名（单目标模式）
```

多目标模式：在工作区根放 `pi-ssh-remote.json` 白名单，所有工具用 `target` 参数选机器：

```json
{
  "default": "gpu",
  "targets": {
    "gpu":    { "host": "gpu-box" },
    "router": { "host": "openwrt-test", "remote_root": "/tmp/pi-remote" }
  }
}
```

白名单外的 `target` 显式报错（列出可用目标），绝不静默路由；配置非法时所有工具调用即报错，不静默回退。
每个目标独立一条控制连接；主机、端口、密钥、ProxyJump 全部走 `~/.ssh/config`，扩展不重复实现。

## 安全声明

pi 扩展以你的完整用户权限运行。本扩展所有远端操作走你本人的 ssh_config 凭证；
`.env` 文件内容不会进入任何工具返回。详见规格 §6。

## License

MIT

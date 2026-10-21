# pi-ssh-remote-run

Pi coding agent 扩展：**本地开发，远程运行调试**。内置 read/write/edit 留在本地，
远端执行面通过一条复用的 SSH 长连接（OpenSSH ControlMaster）提供。

## 工具

| 工具 | 状态 | 说明 |
|---|---|---|
| `ssh_exec` | M1 ✅ | 远端执行，无状态 shell，env_file 自动加载，超时杀远端进程组 |
| `sync_push` / `sync_pull` | M2 | rsync 增量同步（.env 特例：突破 gitignore 总是推送） |
| `port_forward` | M3 | 调试端口转发 |
| `ssh_session` | M5 (v0.2) | tmux 有状态会话（REPL/gdb/多步操作） |
| `remote-runbook` skill | M4 | 工具路由规则 + 远程调试 playbook |

设计规格：[docs/spec.zh-CN.md](docs/spec.zh-CN.md)（含 16 条实测验收标准）。

## 安装与配置

```bash
pi install git:github.com/RainEchoA/pi-ssh-remote-run
export PI_SSH_HOST=gpu-box   # ~/.ssh/config 里的 Host 别名
```

主机、端口、密钥、ProxyJump 全部走 `~/.ssh/config`，扩展不重复实现。

## 安全声明

pi 扩展以你的完整用户权限运行。本扩展所有远端操作走你本人的 ssh_config 凭证；
`.env` 文件内容不会进入任何工具返回。详见规格 §6。

## License

MIT

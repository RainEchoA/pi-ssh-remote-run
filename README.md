# pi-ssh-remote-run

Pi coding agent 扩展：**本地开发，远程运行调试**。内置 read/write/edit 留在本地，
远端执行面通过一条复用的 SSH 长连接（OpenSSH ControlMaster）提供。

## 工具

| 工具 | 状态 | 说明 |
|---|---|---|
| `ssh_exec` | M1 ✅ | 远端执行，无状态 shell，env_file 自动加载+存在性回探，超时杀远端进程组 |
| `sync_push` / `sync_pull` | M2 ✅ | rsync 增量同步（.env 特例：突破 gitignore 总是推送 + 远端 600 强制；paths 白名单模式） |
| `port_forward` | M3 | 调试端口转发 |
| `ssh_session` | M5 (v0.2) | tmux 有状态会话（REPL/gdb/多步操作） |
| `remote-runbook` skill | M4 | 工具路由规则 + 远程调试 playbook |

设计规格：[docs/spec.zh-CN.md](docs/spec.zh-CN.md)（含 16 条实测验收标准）。

## 场景文档

- [macOS 开发 OpenWrt 插件 → 测试路由器](docs/scenarios/macos-openwrt-plugin.md)

## 安装与配置

```bash
pi install git:github.com/RainEchoA/pi-ssh-remote-run
export PI_SSH_HOST=gpu-box   # ~/.ssh/config 里的 Host 别名
```

主机、端口、密钥、ProxyJump 全部走 `~/.ssh/config`，扩展不重复实现。

## 测试状态（诚实声明）

已通过：transpile 语法校验、纯函数级冒烟（buildRemoteCommand 包裹顺序/引用安全/看门狗、
parseRsyncStats 解析）。**未通过真实 sshd/rsync 端到端验收**（spec §8 需双 sshd 环境），
请在目标环境逐条跑 §8 后再视为完成。

## 安全声明

pi 扩展以你的完整用户权限运行。本扩展所有远端操作走你本人的 ssh_config 凭证；
`.env` 文件内容不会进入任何工具返回。详见规格 §6。

## License

MIT

---
name: remote-runbook
description: 在远程主机上运行、调试本地开发的代码。当需要 sync_push 同步代码、ssh_exec 远端执行、ssh_session 交互调试、port_forward 调试端口、或排查远端构建/运行/崩溃问题时使用。
---

# Remote Runbook

本地编辑（内置 read/write/edit），远端运行调试（本包工具）。

## ① 工具路由

| 任务形态 | 工具 |
|---|---|
| 改了代码要在远端跑 | `sync_push` → `ssh_exec`（**顺序纪律：先同步再执行**） |
| 一次性命令：构建、测试、查日志 | `ssh_exec`（显式传 cwd，无状态 shell） |
| 交互式 REPL / gdb / 多步有状态操作 / 滚动日志 | `ssh_session`：open → send → wait → close |
| 远端调试端口给本地用（gdbserver/debugpy） | `port_forward` |
| 取回日志/core/构建产物 | `sync_pull` → 本地 `.remote-artifacts/` |

存储受限目标（路由器/嵌入式）：`sync_push` 必须传 `paths` 白名单（如 `["bin/myplugin.ipk","files/"]`），不推整个工作区。

## ② 环境自检与 env 纪律

- 会话首次远端操作前：`ssh_exec("hostname && pwd")` 确认落点；看 details 的 `connection_age_ms` / `reconnected`。
- 验证 env 加载用存在性探针：`ssh_exec('[ -n "$API_KEY" ] && echo set || echo unset')`。
  **永不** `cat .env`、`env | grep`、`printenv`——机密不得进上下文。
- `.env` 改完必须 `sync_push` 才在远端生效；`env_file: false` 可做对比验证。

## ③ 调试 playbook

- **崩溃**：`ssh_exec("gdb -batch -ex bt -ex 'info locals' ./bin ./core")`（模板：references/gdb.md）
- **Python 长进程**：`py-spy dump --pid <pid>` 非侵入采样（模板：references/py-spy.md）
- **gdbserver 远程调试**：`ssh_exec("gdbserver :2345 ./bin &")` → `port_forward(2345)` → 本地 `target remote 127.0.0.1:2345`
- **测试失败闭环**：ssh_exec 跑测试 → sync_pull 拉日志 → 本地改 → sync_push → 重跑。每步可计数（details 里有字节数/耗时/exit_code）。
- **交互式排查**：`ssh_session` 标准序列（模板：references/tmux.md）。**完成以 wait 哨兵 + exit_code 为准，capture 到输出 ≠ 跑完。**

## ④ 失败处理纪律

| 信号 | 正确反应 |
|---|---|
| `reconnected: true` | ssh_exec 无状态不受影响；ssh_session 由 tmux 持有不受影响；但需重新确认远端长进程是否还在 |
| `timeout: true` | 远端进程组已被杀，**不要假设它还在跑** |
| sync_push 失败 | 代码未同步，**禁止**直接 ssh_exec 跑测试（跑的是旧代码，结果无效） |
| `env_file_loaded: false` 且预期为 true | .env 未推送到远端，先 sync_push |
| port_forward 报端口占用 | 显式换一个 local_port 重试，扩展不会自动换 |

## 参考模板（命中场景再读）

- references/gdb.md — 批处理 gdb / core 分析命令
- references/py-spy.md — 采样与火焰图
- references/tmux.md — ssh_session 完整序列与 REPL 提示符等待

# pi-ssh-remote-run 设计规格

> pi coding agent 扩展：本地开发、远程运行调试
> 版本：v0.2 · 2026-10-22（M1–M5 全部落地 + 多目标白名单 §3.0）

## 1. 目标与定位

让 pi agent 在**本地编辑代码**（内置 read/write/edit 工具保持不变），通过一条 **SSH 长连接**在远端主机上**同步、执行、调试**。

典型场景：本地笔记本/容器里跑 pi，代码实时推送到远端 GPU 服务器/测试机，agent 在远端编译、跑测试、采集崩溃栈、做非侵入式性能采样。

### 1.1 非目标

- 不做整个内置工具面的远程委托（即不做官方 `ssh.ts` 示例那种 read/write/edit/bash 全委托形态）。
- 不做交互式断点调试（DAP）。agent 侧调试以"复现脚本 + 批处理 gdb + py-spy 采样"为主；交互式断点留给人类。
- 不做多主机编排（一次操作只打一台机器）。多目标经 §3.0 白名单逐台指定，不做 fleet 广播。

## 2. 架构

```
┌─ pi agent ────────────────────────────────┐
│ 内置 read/write/edit/bash      （本地，零改动）│
│                                            │
│ 本扩展注册 5 个工具：                        │
│   ssh_exec ─┐                              │
│   sync_push ├─→ SSH 控制通道（ControlMaster）│
│   sync_pull ┤    └─→ 远端主机               │
│   port_forward ┤   （执行 / rsync / 调试端口）│
│   ssh_session ─┘    （tmux 有状态会话）       │
└────────────────────────────────────────────┘
```

**传输层选型：系统 OpenSSH 子进程 + ControlMaster/ControlPersist**，不用 Node ssh2 库。

| 维度 | 系统 ssh + ControlMaster | ssh2 库 |
|---|---|---|
| 长连接复用 | `ControlPersist=600` 免费获得，多子进程共享一条 TCP | 模块级 Client 对象复用 |
| `~/.ssh/config` | 原生支持（ProxyJump / 端口 / 密钥 / Match） | 支持弱，需自行解析 |
| 凭证体系 | 交给 OpenSSH，扩展不碰密钥 | 需在扩展里读私钥 |
| rsync | 天然复用同一控制连接 | 需额外桥接 |
| 风险 | 依赖系统 ssh 存在（Linux/macOS 必有） | 纯 JS 可移植，但重复造配置体系 |

选择系统 ssh 的理由：**配置单一事实源在 ssh_config**，扩展不重复实现 ProxyJump/端口/密钥逻辑，杜绝"扩展以为连上了、实际走了另一条配置"的静默分叉。

### 2.1 连接生命周期

- 首次任一工具调用时惰性建立控制连接：`ssh -M -S $SOCK -o ControlPersist=600`。
- 每次调用前 `ssh -O check` 探活；失败则显式重建并向 agent 报告 `reconnected: true`。
- pi 会话结束（`session_shutdown` 事件）时 `ssh -O exit` 显式关闭，不依赖 ControlPersist 超时兜底。
- pi `/reload` 热重载 → 模块重建 → 旧控制连接由新模块显式接管或重建（同一 socket 路径可复用）。

## 3.0 多目标与白名单（pi-ssh-remote.json）

工作区根可放 `pi-ssh-remote.json` 登记允许登录的目标机器白名单：

```json
{
  "default": "gpu",
  "targets": {
    "gpu":    { "host": "gpu-box", "remote_root": "~/pi-remote/proj" },
    "router": { "host": "openwrt-test", "remote_root": "/tmp/pi-remote" }
  }
}
```

- `host` 必须指向 `~/.ssh/config` 的 Host 别名（本扩展不解析凭证，见 §6）；`remote_root` 可省，缺省按工作区派生。
- 目标名 `[a-z0-9][a-z0-9_-]{0,31}`；host 别名 `[A-Za-z0-9._-]`，禁空白/元字符。
- 全部五个工具带可选 `target` 参数；缺省 = 配置 `default`（未写 default 取第一个目标）。
- 白名单语义：
  - `target` 不在名单 → **显式报错并列出可用目标**，绝不静默路由到其他机器；
  - 配置文件存在但非法（JSON 错误/host 含特殊字符/default 不在名单）→ 所有工具调用即报错，**不静默回退**到 PI_SSH_HOST；
  - 文件不存在 → 合法，回退 PI_SSH_HOST 单目标（名为 `default`）。
- 每个目标独立一条 ControlMaster 控制连接（懒建连）；转发、tmux 会话、哨兵记录均按目标隔离；session_shutdown 只清理已建连的目标。
- skill 负责在会话开始时引导读取该配置（见 §9）。

## 3. 工具契约

### 3.1 `ssh_exec` — 远端执行

```typescript
parameters: {
  target?: string;            // §3.0 白名单目标名，缺省 = 配置 default；不在名单显式报错
  command: string;            // 远端 shell 命令（bash -lc 语义）
  cwd?: string;               // 远端工作目录，缺省为 sync 目标根
  timeout_ms?: number;        // 缺省 120_000，超时即杀远端进程组
  env?: Record<string,string>;// 追加环境变量（白名单透传，见 §6）
  env_file?: string | false;  // 远端 .env 文件，见 §3.1a
                              //   缺省：远端同步根 .env（存在即加载）
                              //   string：相对同步根的自定义路径
                              //   false：本次调用显式禁用加载
}
```

返回：`{ stdout, stderr, exit_code, duration_ms, reconnected?, env_file_loaded?: boolean }`。

**语义约束**：

- **无状态 shell**：每次调用独立 exec channel，cwd 必须显式传入；不存在"记住上次 cd"的隐式状态。env_file 同理——每次调用重新 source，不存在"上次加载过还在"的隐式状态。
- 超时杀死的是远端**进程组**（`setsid` 包裹），避免远端孤儿进程。
- 输出经 `truncateHead/tail` 截断（单方向上限 100KB），截断时显式标注 `truncated: true + 原始字节数`。

### 3.1a env 文件加载语义

加载命令形态（每次 exec 的最外层包裹）：

```bash
bash -lc '[ -f "$ENV_FILE" ] && set -a && . "$ENV_FILE" && set +a; exec <command>'
```

- 用 `set -a` 包裹 source，文件内 `KEY=VALUE` 行**自动导出**为环境变量，兼容标准 .env 语法；注释/空行按 shell source 语义处理。
- 加载失败（语法错误）：env 文件报错进 stderr 且 exit_code ≠ 0，**不允许**"文件坏了但命令裸跑成功"的假成功。
- `env` 参数（显式键值）优先级**高于** env_file：注入顺序为先 source 文件、再 export 显式键。
- `env_file_loaded` 字段如实报告本次是否实际加载了文件（文件不存在时为 `false`，不视为错误）。

### 3.2 `sync_push` — 本地 → 远端

```typescript
parameters: {
  target?: string;    // §3.0 白名单目标名
  paths?: string[];   // 缺省整个工作区
  delete?: boolean;   // 缺省 false；true 时 rsync --delete（危险，需 agent 显式开）
}
```

实现：`rsync -az --info=stats2 --exclude-from=.gitignore --exclude=.git/ -e "ssh -S $SOCK"`，**复用控制连接**。

**.env 特例**：`.gitignore` 通常排除 `.env`，但这恰是最常需要到远端的文件。处理规则：

- 工作区根 `.env` **不受 .gitignore 排除影响，总是随 sync_push 推送**（rsync 显式 include 优先于 exclude）。
- 远端落盘后立即 `chmod 600`，目录 `chmod 700`。
- 自定义 env 文件（如 `.env.prod`）不自动推送，由 agent 显式 `sync_push(paths=[".env.prod"])`。

返回：rsync stats（传输文件数、字节数、耗时），写入 tool result 的 `details`。**同步失败必须让本次调用失败**，不得返回"成功但部分文件没传"。

### 3.3 `sync_pull` — 远端 → 本地

```typescript
parameters: {
  target?: string;    // §3.0 白名单目标名
  paths: string[];    // 相对远端工作根的产物路径（日志/core/构建产物）
}
```

拉回到本地工作区 `.remote-artifacts/` 目录，返回拉回文件清单与大小。

### 3.4 `port_forward` — 调试端口转发

```typescript
parameters: {
  target?: string;     // §3.0 白名单目标名
  remote_port: number;
  local_port?: number;   // 缺省与 remote_port 相同；占用时显式报错，不静默换端口
}
```

实现：`ssh -S $SOCK -O forward -L ...` 控制命令，随控制连接存活。返回实际绑定的 local_port。配套 `session_shutdown` 自动回收。

### 3.5 自检字段

每个工具的 result `details` 固定携带：

```
target, remote_host, connection_age_ms, last_sync?: { files, bytes, at }
```

让 agent 每次都能自检执行环境，不依赖会话记忆。

### 3.6 `ssh_session` — 有状态远端会话（v0.2）

`ssh_exec` 保持无状态；需要交互式长驻（远端 REPL、gdb 会话、需多步 `cd`/`export` 的探索性操作）时，用 `ssh_session`。状态载体是**远端 tmux**，不是 SSH 通道本身——可枚举、可重连、可杀，连接重建后会话仍在。

```typescript
parameters: {
  target?: string;      // §3.0 白名单目标名
  action: "open" | "send" | "wait" | "capture" | "list" | "close";
  name?: string;          // 会话名，缺省 "default"；tmux session 名 = pi-<name>
  cwd?: string;           // open 时生效；env_file 语义同 §3.1a，open 时加载并驻留
  env_file?: string | false;
  input?: string;         // send：发送到会话的按键/命令行（send-keys 语义）
  pattern?: string;       // wait：等待捕获输出匹配此正则
  timeout_ms?: number;    // wait 缺省 60_000
  lines?: number;         // capture：回卷行数，缺省 200
  persist?: boolean;      // open：pi 会话结束后是否保留远端会话，缺省 false
}
```

**action 语义**：

| action | 实现 | 返回 |
|---|---|---|
| open | `tmux new-session -d -s pi-<name> -x 220 -y 50`，随后 source env_file | `{ name, opened: true \| already_existed }` |
| send | `tmux send-keys -t pi-<name> "$input" Enter`，**自动包哨兵**：命令结束后 echo 唯一标记 + `$?` | `{ sent: true }` |
| wait | 轮询 `capture-pane` 直到 `pattern` 匹配或超时 | `{ matched: true, exit_code?, output }` 或 `{ matched: false, timeout: true, tail }` |
| capture | `tmux capture-pane -p -S -<lines>`，走统一截断 | `{ output, truncated? }` |
| list | `tmux ls`（过滤 `pi-` 前缀） | `{ sessions: [{ name, age_ms }] }` |
| close | `tmux kill-session`；不存在则显式报错 | `{ closed: true }` |

**完成检测（关键设计，防"捕获到输出 ≠ 命令跑完"）**：

`send` 不裸发用户命令，实际发送：

```bash
<user_cmd>; __rc=$?; echo "__PI_DONE_<uuid>__$__rc"
```

`wait` 缺省 `pattern` 即该 uuid 哨兵，匹配后从标记解析 `exit_code` 如实上报。`pattern` 显式传入时则为纯输出匹配（用于 REPL 提示符等待等），此时 `exit_code` 缺省不解析。**绝不允许**"capture 到东西就当成功"。

**语义约束**：

- 会话内状态（cwd、export、venv）只在会话内驻留，`ssh_exec` 完全不可见；反之亦然。两个世界的边界显式化。
- `persist: false`（默认）的会话在 pi `session_shutdown` 时全部 kill；`persist: true` 的存活，下次 pi 会话 `list` 可见、可重连（`send/capture` 直接可用）。
- tmux 缺失：`open` 报错并提示安装命令，不降级到无 tmux 的原始通道（无 tmux 就没有可靠的完成检测与回卷，降级即引入静默失效面）。
- 会话命名强制 `pi-` 前缀 + 名称白名单字符（`[a-zA-Z0-9_-]`），防注入、防误杀用户自己的 tmux 会话。
- 窗口尺寸固定 220×50：保证 `capture` 回卷内容稳定，不受本地终端 resize 影响。
- `input` 经 `send-keys -l`（字面模式）发送，防 `;`、Enter 等被 tmux 解释为控制序列；Enter 单独发送。

**与 ssh_exec 的分工**：一次性命令、构建、测试 → `ssh_exec`；交互式 REPL/gdb、需状态驻留的多步操作、需观察滚动输出的长任务 → `ssh_session`。工具 description 里写明这个分工，让模型自行路由。

## 4. 防静默失效设计（硬约束）

| 场景 | 行为 |
|---|---|
| ssh 不存在 / 版本过老 | 扩展加载即检测，缺失时工具注册为"加载即报错"形态，说明原因 |
| 首次连接失败 | 抛错并区分原因：DNS / 认证 / 超时 / host key 未知（附 `ssh -v` 关键行） |
| 运行中断链 | 下次调用自动重建，result 带 `reconnected: true`；重建失败显式抛错 |
| rsync 部分失败 | exit code ≠ 0 → 工具调用整体失败，附 stderr |
| local_port 被占用 | 显式报错，**不**自动换端口 |
| 命令超时 | 杀远端进程组，返回 `timeout: true` + 已捕获的部分输出 |
| 输出超限 | 截断 + `truncated: true` + 原始字节数 |
| env 文件语法错误 | source 失败进 stderr、exit_code ≠ 0，不裸跑 |
| env 文件权限异常 | 远端 .env 非 600 → sync_push 时强制修正并在 details 记录 |
| target 不在白名单 | 显式报错并列出可用目标，**没有任何远端命令被执行** |
| pi-ssh-remote.json 非法 | 所有工具调用即报错，不静默回退 PI_SSH_HOST |

禁止行为清单：无输出挂死、静默降级到本地执行、吞掉 stderr、自动换端口不报告、**env 文件内容回显进 tool result**（见 §6 防泄漏）、**白名单外主机静默路由**。

## 5. 远端环境约定

- 远端同步根：`~/pi-remote/<工作区basename 的 hash>/`，避免多工作区互相覆盖；多目标可在 `pi-ssh-remote.json` 里逐目标覆盖 `remote_root`。
- 远端要求：`bash`、`rsync`；调试能力可选依赖 `gdb` / `py-spy`（缺失时相关用法报错提示安装，不影响 ssh_exec/sync）。
- 远端命令统一 `bash -lc` 包裹，保证 login 环境（PATH 里的 conda/cargo 等可用）。

## 6. 配置与安全

- 主机选择两个入口：工作区 `pi-ssh-remote.json` 白名单（§3.0，多目标），或环境变量 `PI_SSH_HOST=<ssh_config 里的 Host 别名>`（单目标）。ProxyJump、端口、密钥、用户名全部在 `~/.ssh/config`，扩展不解析、不覆盖。
- `ssh_exec` 的 `env` 参数走白名单（默认只允许 `PATH` 追加与 `*` 以外的显式键），防止 agent 误传本地敏感变量到远端。
- **.env 防泄漏**（.env 通常含 API key 等机密）：
  - 任何工具 result 不得包含 env 文件内容；`sync_push` 的 stats 只报文件名与字节数。
  - 工具 description 中显式告诫模型：不要 `cat .env` / `env | grep` 打印机密到上下文；需要确认加载效果时用 `ssh_exec("[ -n \"$KEY\" ] && echo set || echo unset")` 这类存在性探针。
  - 远端 .env 权限 600 由扩展强制保证（§3.2）。
- socket 路径：`$XDG_RUNTIME_DIR/pi-ssh-%C.sock`，会话结束清理。
- 扩展以用户完整权限运行（pi 扩展模型的固有限制），在 README 显著位置声明。

## 7. 包结构

```
pi-ssh-remote-run/
├── package.json          # pi 包 manifest，keyword: pi-package
│                         #   "pi": { "extensions": ["./src"], "skills": ["./skills"] }
├── README.md             # 定位、安装、配置、限制声明
├── src/
│   ├── index.ts          # export default (pi: ExtensionAPI) => {...}
│   ├── connection.ts     # ControlMaster 生命周期：ensure/check/rebuild/close
│   ├── targets.ts        # pi-ssh-remote.json 白名单加载 + TargetPool（§3.0）
│   ├── tools/
│   │   ├── ssh-exec.ts
│   │   ├── sync.ts        # push + pull
│   │   ├── forward.ts
│   │   └── session.ts     # ssh_session（v0.2）
│   └── util.ts           # 截断、超时杀进程组、错误分类
├── skills/
│   └── remote-runbook/
│       ├── SKILL.md       # 工具路由规则 + 远程调试 playbook，见 §9
│       └── references/    # gdb/py-spy/tmux 命令模板（渐进披露，命中才读）
└── test/                  # 见 §8
```

安装：`pi install npm:pi-ssh-remote-run`（发布后）或 `pi install git:github.com/<user>/pi-ssh-remote-run`。

## 8. 验收标准（逐条实测，不接受纸面推断）

测试环境：本机起两个 sshd（不同端口，容器或 localhost alias），模拟正常/弱网/断链。

1. **冷启动**：无控制连接时 `ssh_exec("hostname")` 成功，第二次调用 `connection_age_ms > 0` 且复用同一连接（远端 `last` 只多一条登录）。
2. **断链重建**：`ssh -O exit` 强杀控制连接后，`ssh_exec` 自动重建且 result 带 `reconnected: true`。
3. **认证失败**：错误密钥 → 报错文案含 "authentication"，不挂死（<10s 返回）。
4. **同步一致性**：本地改 3 文件 → `sync_push` → 远端 sha256 逐文件一致；rsync 中途 kill → `sync_push` 返回失败。
5. **超时语义**：`ssh_exec("sleep 60", timeout_ms=2000)` → 2s 左右返回 `timeout: true`，远端无残留 `sleep` 进程（`pgrep` 验证）。
6. **截断**：`ssh_exec` 输出 1MB → result ≤ 上限且 `truncated: true`。
7. **端口冲突**：`port_forward` 到已占用端口 → 显式报错，未换端口。
8. **会话清理**：pi 退出后控制 socket 消失、远端无遗留转发端口。
9. **多工作区隔离**：两个不同本地目录分别 push，远端根不同、互不覆盖。
10. **env 文件闭环**：本地 .env 含 `FOO=bar`（且已被 .gitignore 排除）→ `sync_push` 后远端存在、权限 600 → `ssh_exec("echo $FOO")` 输出 `bar`、result 带 `env_file_loaded: true`；`env_file: false` 时同一命令输出为空且 `env_file_loaded: false`；显式 `env: {FOO: "baz"}` 覆盖文件值输出 `baz`。
11. **env 失败显式化**：远端 .env 写入一行语法错误（如 `===`）→ `ssh_exec` 返回非零 exit_code 且 stderr 含 source 报错，不出现"命令裸跑成功"。
12. **env 防泄漏**：`sync_push` 的 result 全文不含 .env 文件内容；远端权限被手动改为 644 后再次 push，自动回正为 600。
13. **会话闭环**：`open` → `send("export X=1")` → `send("echo $X")` + `wait` → 匹配哨兵、`exit_code: 0`、输出含 `1`；`close` 后 `list` 为空；对不存在的会话 `close` 显式报错。
14. **完成检测**：`send("sleep 5 && echo ok")` 后立即 `capture`（无哨兵）不算完成；`wait` 在 ~5s 后匹配并解析出 `exit_code`；`send("exit 3")` 经 `wait` 如实上报 `exit_code: 3`。
15. **会话存续**：`persist: true` 的会话在 pi 进程重启后 `list` 可见、`capture` 能取回重启前的输出；`persist: false` 的在 pi 退出时被 kill（远端 `tmux ls` 验证）。断链重建（§8.2）后已有会话不受影响。
16. **skill 随包可用**：`pi install` 后新会话 `/skills` 列表含 `remote-runbook`；settings 中 `"skills": []` 关掉后五个工具仍注册可用（解耦验证）。
17. **多目标白名单**：配置两个目标 a/b（可指向同一 sshd 的不同 remote_root）。`ssh_exec` 不带 target → 落默认目标且 details.target 如实标注；带 `target: "b"` → 在 b 上执行（用各自落点写文件验证路由隔离）；带 `target: "evil"` → 显式报错且错误信息列出白名单，**没有任何远端命令被执行**；把配置改成非法 JSON 后任意工具调用即报错（不静默回退）。

## 9. Skill 设计：`remote-runbook`

**定位**：工具给能力，skill 给使用知识。五个工具的 description 只写"是什么"；**何时用、怎么组合、踩坑纪律**全部放 skill。随包分发（§7 manifest），用户 `pi install` 后自动可用；pi 渐进披露——平时只占系统提示一行 name+description，任务命中才加载全文。

### 9.1 SKILL.md 结构

```yaml
---
name: remote-runbook
description: 在远程主机上运行、调试本地开发的代码。当需要 sync_push 同步代码、
  ssh_exec 远端执行、ssh_session 交互调试、或排查远端构建/运行/崩溃问题时使用。
---
```

正文五个部分：

**⓪ 目标与白名单**（多机时先读）

- 会话开始先读工作区 `pi-ssh-remote.json`：有 → 记住 targets 白名单与 default，之后用 `target` 参数；没有 → 单目标模式，不虚构多机能力。
- 新机器只能在 `pi-ssh-remote.json` 登记后使用；白名单外被工具显式拒绝，不绕过。
- **sync_push 与 ssh_exec 必须同一个 target**（推 A 跑 B = 跑旧代码）。

**① 工具路由规则**

| 任务形态 | 工具 |
|---|---|
| 改了代码要在远端跑 | `sync_push` → `ssh_exec`（**顺序纪律**：先同步再执行） |
| 一次性命令：构建、测试、查日志 | `ssh_exec` |
| 交互式 REPL / gdb / 多步有状态操作 | `ssh_session`（open → send → wait → close） |
| 远端调试端口给本地用 | `port_forward` |
| 取回日志/core/产物 | `sync_pull` |

**② 环境自检与 env 纪律**

- 每次会话首次远端操作前：`ssh_exec("hostname && pwd")` 确认落点，看 details 里 `connection_age_ms` / `reconnected`。
- 验证 env 加载用存在性探针：`ssh_exec('[ -n "$API_KEY" ] && echo set || echo unset')`——**永不** `cat .env`、`env | grep` 打印机密进上下文。
- `.env` 改完必须 `sync_push` 才生效；`env_file: false` 可对比验证加载差异。

**③ 远程调试 playbook**

- 崩溃：`ssh_exec("gdb -batch -ex bt -ex 'info locals' <bin> <core>")`（模板在 `references/gdb.md`）
- Python 长进程：`port_forward` + `py-spy dump --pid` 非侵入采样（模板在 `references/py-spy.md`）
- 测试失败：`ssh_exec` 跑测试 → 失败 → `sync_pull` 拉回日志 → 本地改 → `sync_push` → 重跑，闭环每一步都可计数。
- 交互式排查：`ssh_session` 标准序列（模板在 `references/tmux.md`），**完成以 wait 哨兵 + exit_code 为准，不以 capture 到输出为准**。

**④ 失败处理纪律**

- `reconnected: true` → 注意远端有状态操作（ssh_exec 的 cwd/env 无状态不受影响；ssh_session 由 tmux 持有不受影响），但需重新确认远端进程是否还在。
- `timeout: true` → 远端进程组已被杀，不要假设它还在跑。
- rsync 失败 → 代码未同步，禁止直接 ssh_exec 跑测试（跑的是旧代码，结果无效）。
- 报 `不在白名单` → 在 `pi-ssh-remote.json` 登记目标后用 `target` 重试，不绕过。

### 9.2 设计约束

- **与 extension 解耦**：用户可在 settings 里关掉包的 skills（`"skills": []`），此时工具必须仍可用、description 自足；skill 只是增效不是依赖。
- **references 渐进披露**：gdb/py-spy/tmux 模板放 `references/`，SKILL.md 里只写一行指引，模型命中具体场景才读对应文件，控制上下文开销。
- **不写版本敏感内容**：playbook 不绑定远端发行版/内核版本，环境差异由 agent 运行时自检。
- SKILL.md 正文控制在 ~150 行内；超出内容一律下沉 references。

## 10. 里程碑

| 阶段 | 内容 | 验收 |
|---|---|---|
| M1 | connection.ts + ssh_exec | §8 第 1/2/3/5/6 条 |
| M2 | sync_push / sync_pull（含 .env 特例） | §8 第 4/9/10/11/12 条 |
| M3 | port_forward + 会话清理 | §8 第 7/8 条 |
| M4 | README、manifest、remote-runbook skill、发布 npm | `pi install` 全新环境一遍通过 + §8 第 16 条 |
| M5（v0.2） | ssh_session（tmux 有状态会话） | §8 第 13/14/15 条 |
| M6（v0.2） | 多目标白名单 pi-ssh-remote.json + target 参数 | §8 第 17 条 |

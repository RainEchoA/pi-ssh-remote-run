# py-spy 非侵入采样模板

## 当前栈快照（对生产进程安全）
ssh_exec: py-spy dump --pid <pid>

## 采样火焰图（30s）
ssh_exec: py-spy record -o /tmp/flame.svg -d 30 --pid <pid>   # timeout_ms 给 45000
sync_pull: ["../.."]  → 拉回 /tmp/flame.svg 用 paths 指定

注意：py-spy 需要 ptrace 权限（容器内可能需 SYS_PTRACE capability）。

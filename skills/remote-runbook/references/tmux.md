# ssh_session 标准序列

open("dbg")                       # 创建 pi-dbg，加载远端 .env，cd 到同步根
send("python3 -i script.py")      # 自动包哨兵，返回 sentinel id
wait()                            # 缺省等最近一次 send 的哨兵，解析 exit_code
wait({pattern: ">>>"})            # REPL：等提示符（此时无 exit_code）
capture({lines: 100})             # 随时回看回卷（220x50 固定窗口）
close("dbg")                      # 排查完关闭；persist=true 可跨 pi 会话保留

纪律：
- send 后必须 wait，capture 到输出不代表命令结束。
- 会话内 cd/export/venv 只在会话内驻留；ssh_exec 看不见。
- list 可随时枚举存活会话；pi 退出时非 persist 会话自动清理。

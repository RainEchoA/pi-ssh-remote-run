# gdb 批处理模板

## core 分析（一次调用拿栈帧+局部变量）
ssh_exec: gdb -batch -ex bt -ex "info locals" -ex "info registers" ./bin ./core

## 附加到活进程取栈
ssh_exec: gdb -batch -p $(pgrep myplugin) -ex "thread apply all bt"

## gdbserver 远程调试
1. ssh_exec: gdbserver :2345 /usr/bin/myplugin --debug &
2. port_forward: remote_port=2345
3. 本地交叉 gdb: target remote 127.0.0.1:2345

注意：远端无 gdb 时报错会带 "command not found"，先 opkg/apt install gdb gdbserver。

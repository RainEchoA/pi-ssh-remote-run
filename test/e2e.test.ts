/**
 * 端到端验收（spec §8 第 1/2/5/6/10/11/12 条的可 CI 化部分）
 * 前提：CI_E2E=1 且 ssh_config 存在 Host `ci-remote`（CI workflow 负责起 sshd + 配 key）。
 * 本地跳过而非假绿。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { SshConnection } from "../src/connection.js";
import { singleTargetResolver } from "../src/targets.js";
import { makeSshExecTool } from "../src/tools/ssh-exec.js";
import { makeSyncPushTool, makeSyncPullTool, type SyncContext } from "../src/tools/sync.js";

const SKIP = process.env.CI_E2E !== "1";
const HOST = "ci-remote";

function cleanupRemoteSessions() {
  try {
    const names = remote("tmux ls -F '#{session_name}' 2>/dev/null || true")
      .split("\n").map((x) => x.trim()).filter((x) => x.startsWith("pi-"));
    for (const n of names) remote(`tmux kill-session -t '${n}' 2>/dev/null || true`);
  } catch { /* tmux 未装等情况忽略 */ }
}

function setup() {
  cleanupRemoteSessions();
  const conn = new SshConnection(HOST);
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "pi-e2e-ws-"));
  const remoteRoot = `/tmp/pi-e2e-remote-${process.pid}`;
  fs.writeFileSync(path.join(workspace, "hello.txt"), "hello\n");
  fs.writeFileSync(path.join(workspace, ".env"), "FOO=bar\n");
  fs.writeFileSync(path.join(workspace, ".gitignore"), ".env\nignored.tmp\n");
  fs.writeFileSync(path.join(workspace, "ignored.tmp"), "should-not-sync\n");
  return { conn, workspace, remoteRoot };
}

function remote(cmd: string): string {
  return execFileSync("ssh", ["-F", process.env.SSH_CONFIG_FILE ?? `${os.homedir()}/.ssh/config`, HOST, cmd], { encoding: "utf8" });
}

test("§8.1 冷启动 + 连接复用", { skip: SKIP }, async () => {
  const { conn, remoteRoot } = setup();
  const exec = makeSshExecTool(singleTargetResolver(conn, remoteRoot));
  const r1 = await exec.execute("1", { command: "hostname", env_file: false });
  assert.equal(r1.details.exit_code, 0);
  const r2 = await exec.execute("2", { command: "echo ok", env_file: false });
  assert.ok((r2.details.connection_age_ms as number) > 0, "第二次调用应复用连接");
  await conn.close();
});

test("§8.2 断链重建上报 reconnected", { skip: SKIP }, async () => {
  const { conn, remoteRoot } = setup();
  const exec = makeSshExecTool(singleTargetResolver(conn, remoteRoot));
  await exec.execute("1", { command: "true", env_file: false });
  await conn.close(); // 强杀控制连接
  const r = await exec.execute("2", { command: "true", env_file: false });
  assert.equal(r.details.reconnected, true, "重建后必须上报 reconnected");
  await conn.close();
});

test("§8.5 超时杀远端进程组", { skip: SKIP }, async () => {
  const { conn, remoteRoot } = setup();
  const exec = makeSshExecTool(singleTargetResolver(conn, remoteRoot));
  const t0 = Date.now();
  const r = await exec.execute("1", { command: "sleep 60", timeout_ms: 2000, env_file: false });
  assert.ok(Date.now() - t0 < 15000, "超时应在秒级返回");
  assert.equal(r.details.timeout, true);
  // 远端无残留 sleep 60
  const left = remote("pgrep -f '[s]leep 60' || true").trim();
  assert.equal(left, "", `远端残留进程: ${left}`);
  await conn.close();
});

test("§8.6 输出截断标注", { skip: SKIP }, async () => {
  const { conn, remoteRoot } = setup();
  const exec = makeSshExecTool(singleTargetResolver(conn, remoteRoot));
  const r = await exec.execute("1", { command: "head -c 1048576 /dev/zero | tr '\\0' 'x'", env_file: false, timeout_ms: 60000 });
  assert.equal(r.details.truncated, true);
  assert.ok((r.details.original_bytes as number) >= 1048576);
  await conn.close();
});

test("§8.10/11/12 env 文件闭环 + 防泄漏 + 权限强制", { skip: SKIP }, async () => {
  const { conn, workspace, remoteRoot } = setup();
  const ctx: SyncContext = { resolve: singleTargetResolver(conn, remoteRoot), workspaceRoot: workspace };
  const push = makeSyncPushTool(ctx);
  const exec = makeSshExecTool(singleTargetResolver(conn, remoteRoot));

  // push：.env 突破 gitignore；ignored.tmp 不同步
  const pr = await push.execute("1", {});
  assert.equal(pr.details.filesTransferred !== undefined, true);
  const remoteList = remote(`ls -a ${remoteRoot}`);
  assert.match(remoteList, /\.env/, ".env 必须被推送");
  assert.doesNotMatch(remoteList, /ignored\.tmp/, "gitignore 项不得推送");
  const perm = remote(`stat -c %a ${remoteRoot}/.env`).trim();
  assert.equal(perm, "600", ".env 远端权限必须 600");
  // §8.12：result 全文不含 .env 内容
  assert.ok(!JSON.stringify(pr).includes("FOO=bar"), "result 泄漏了 .env 内容");

  // exec：默认加载 env
  const r1 = await exec.execute("2", { command: "echo $FOO" });
  assert.equal(r1.details.env_file_loaded, true);
  assert.match((r1.content[0] as { text: string }).text, /bar/);
  // env_file: false
  const r2 = await exec.execute("3", { command: "echo [$FOO]", env_file: false });
  assert.equal(r2.details.env_file_loaded, false);
  assert.match((r2.content[0] as { text: string }).text, /\[\]/);
  // 显式 env 覆盖
  const r3 = await exec.execute("4", { command: "echo $FOO", env: { FOO: "baz" } });
  assert.match((r3.content[0] as { text: string }).text, /baz/);

  // §8.11：语法错误显式失败
  remote(`echo '===' >> ${remoteRoot}/.env`);
  const r4 = await exec.execute("5", { command: "echo should-not-run" });
  assert.notEqual(r4.details.exit_code, 0, "env 语法错误必须非零退出");

  await conn.close();
});

test("sync_pull 拉回产物", { skip: SKIP }, async () => {
  const { conn, workspace, remoteRoot } = setup();
  const ctx: SyncContext = { resolve: singleTargetResolver(conn, remoteRoot), workspaceRoot: workspace };
  const push = makeSyncPushTool(ctx);
  await push.execute("1", {});
  remote(`echo crashlog > ${remoteRoot}/run.log`);
  const pull = makeSyncPullTool(ctx);
  const r = await pull.execute("2", { paths: ["run.log"] });
  assert.equal(r.details.filesTransferred, 1);
  assert.equal(fs.readFileSync(path.join(workspace, ".remote-artifacts", "run.log"), "utf8"), "crashlog\n");
  await conn.close();
});

// ===== M3: port_forward =====
test("§8.7 port_forward 端口冲突显式报错", { skip: SKIP }, async () => {
  const { conn } = setup();
  const { makePortForwardTool } = await import("../src/tools/forward.js");
  const forwards: import("../src/tools/forward.js").ForwardRegistry = new Map();
  const fwd = makePortForwardTool(singleTargetResolver(conn, "/tmp/unused"), forwards);
  const r = await fwd.execute("1", { remote_port: 29876, local_port: 29876 });
  assert.equal(r.details.local_port, 29876);
  // 本地占用该端口后再请求 → 显式报错且不换端口
  const net = await import("node:net");
  const blocker = net.createServer().listen(29877, "127.0.0.1");
  await new Promise((res) => blocker.on("listening", res));
  await assert.rejects(() => fwd.execute("2", { remote_port: 2345, local_port: 29877 }), /被占用/);
  assert.ok(![...forwards.values()].flat().some((f) => f.localPort === 29877), "失败不得登记转发");
  blocker.close();
  const { closeAllForwards } = await import("../src/tools/forward.js");
  await closeAllForwards(forwards, [{ name: "default", conn }]);
  await conn.close();
});

test("port_forward 转发通路可用（远端起 http 服务验证）", { skip: SKIP }, async () => {
  const { conn } = setup();
  const { makePortForwardTool, closeAllForwards } = await import("../src/tools/forward.js");
  const forwards: import("../src/tools/forward.js").ForwardRegistry = new Map();
  const fwd = makePortForwardTool(singleTargetResolver(conn, "/tmp/unused"), forwards);
  // e2e 环境 remote==localhost，共享端口命名空间：远端服务端口与本地转发端口必须错开
  const port = 29000 + Math.floor(Math.random() * 500);
  const localPort = port + 1000;
  remote(`nohup python3 -m http.server ${port} --bind 127.0.0.1 >/dev/null 2>&1 & sleep 1; echo up`);
  await fwd.execute("1", { remote_port: port, local_port: localPort });
  const body = execFileSync("curl", ["-s", "--max-time", "5", `http://127.0.0.1:${localPort}/`], { encoding: "utf8" });
  assert.match(body, /Directory listing|html/i, "转发通路应拿到远端 http 响应");
  remote(`pkill -f "[h]ttp.server ${port}" || true`);
  await closeAllForwards(forwards, [{ name: "default", conn }]);
  await conn.close();
});

// ===== M5: ssh_session =====
test("§8.13/14 会话闭环 + 哨兵完成检测 + exit_code 如实上报", { skip: SKIP }, async () => {
  const { conn, remoteRoot } = setup();
  const { makeSshSessionTool, cleanupSessions } = await import("../src/tools/session.js");
  const mgr = { ephemeral: new Set<string>() };
  const sess = makeSshSessionTool(singleTargetResolver(conn, remoteRoot), mgr);

  const o = await sess.execute("1", { action: "open", name: "t1" });
  assert.equal(o.details.opened, true);
  // 状态驻留：export 后下一次 send 可见
  await sess.execute("2", { action: "send", name: "t1", input: "export X=1" });
  await sess.execute("3", { action: "wait", name: "t1" });
  await sess.execute("4", { action: "send", name: "t1", input: "echo val=$X" });
  const w = await sess.execute("5", { action: "wait", name: "t1", timeout_ms: 15000 });
  assert.equal(w.details.matched, true);
  assert.equal(w.details.exit_code, 0);
  assert.match((w.content[0] as { text: string }).text, /val=1/);
  // exit 3 如实上报
  await sess.execute("6", { action: "send", name: "t1", input: "(exit 3)" });
  const w2 = await sess.execute("7", { action: "wait", name: "t1", timeout_ms: 15000 });
  assert.equal(w2.details.exit_code, 3);
  // 注意：exit 3 会杀掉会话 shell（tmux pane 关闭），重建后继续
  await sess.execute("8", { action: "close", name: "t1" }).catch(() => {});
  const l = await sess.execute("9", { action: "list" });
  assert.ok(!(l.details.sessions as string[]).includes("pi-t1"));
  await assert.rejects(() => sess.execute("10", { action: "close", name: "t1" }), /close 失败/);
  await cleanupSessions(mgr, [{ name: "default", conn }]);
  await conn.close();
});

test("§8.14 capture 无哨兵不算完成", { skip: SKIP }, async () => {
  const { conn, remoteRoot } = setup();
  const { makeSshSessionTool, cleanupSessions } = await import("../src/tools/session.js");
  const mgr = { ephemeral: new Set<string>() };
  const sess = makeSshSessionTool(singleTargetResolver(conn, remoteRoot), mgr);
  await sess.execute("1", { action: "open", name: "t2" });
  await sess.execute("2", { action: "send", name: "t2", input: "sleep 4 && echo done-marker" });
  const cap = await sess.execute("3", { action: "capture", name: "t2" });
  assert.doesNotMatch((cap.content[0] as { text: string }).text, /__PI_DONE_[0-9a-f]{12}__\d+/, "未完成时 capture 不得出现已展开哨兵");
  const w = await sess.execute("4", { action: "wait", name: "t2", timeout_ms: 10000 });
  assert.equal(w.details.matched, true);
  assert.equal(w.details.exit_code, 0);
  await sess.execute("5", { action: "close", name: "t2" });
  await cleanupSessions(mgr, [{ name: "default", conn }]);
  await conn.close();
});

test("§8.15 断链重建后 tmux 会话无损；持久/临时会话语义", { skip: SKIP }, async () => {
  const { conn, remoteRoot } = setup();
  const { makeSshSessionTool, cleanupSessions } = await import("../src/tools/session.js");
  const mgr = { ephemeral: new Set<string>() };
  const sess = makeSshSessionTool(singleTargetResolver(conn, remoteRoot), mgr);
  await sess.execute("1", { action: "open", name: "keep", persist: true });
  await sess.execute("2", { action: "send", name: "keep", input: "echo survive-$RANDOM > /tmp/pi-keep-marker; cat /tmp/pi-keep-marker" });
  const w = await sess.execute("3", { action: "wait", name: "keep", timeout_ms: 15000 });
  const marker = /survive-\d+/.exec((w.content[0] as { text: string }).text)![0];
  await conn.close(); // 强杀控制连接
  const cap = await sess.execute("4", { action: "capture", name: "keep" }); // 自动重建
  assert.equal(cap.details.reconnected, true);
  assert.match((cap.content[0] as { text: string }).text, new RegExp(marker), "断链重建后会话输出仍在");
  const l = await sess.execute("5", { action: "list" });
  assert.ok((l.details.sessions as string[]).includes("pi-keep"));
  await sess.execute("6", { action: "close", name: "keep" });
  await cleanupSessions(mgr, [{ name: "default", conn }]);
  await conn.close();
});

test("ssh_session 非法会话名拒绝", { skip: SKIP }, async () => {
  const { conn, remoteRoot } = setup();
  const { makeSshSessionTool } = await import("../src/tools/session.js");
  const sess = makeSshSessionTool(singleTargetResolver(conn, remoteRoot), { ephemeral: new Set() });
  await assert.rejects(() => sess.execute("1", { action: "open", name: "bad;rm -rf" }), /非法会话名/);
});

test("§8.3 认证失败显式报错（不挂死）", { skip: SKIP }, async () => {
  const bad = new SshConnection("ci-remote-badkey"); // CI 配置：指向同 sshd 但用错误密钥
  const exec = makeSshExecTool(singleTargetResolver(bad, "/tmp/pi-e2e-remote-bad", "bad"));
  const t0 = Date.now();
  await assert.rejects(() => exec.execute("1", { command: "true" }), /认证失败|authentication/i);
  assert.ok(Date.now() - t0 < 30000, "认证失败必须快速返回");
});

test("§8.9 多工作区隔离", { skip: SKIP }, async () => {
  const { conn, workspace, remoteRoot } = setup();
  const ws2 = fs.mkdtempSync(path.join(os.tmpdir(), "pi-e2e-ws2-"));
  fs.writeFileSync(path.join(ws2, "only-ws2.txt"), "2\n");
  const root2 = `${remoteRoot}-ws2`;
  const ctx1: SyncContext = { resolve: singleTargetResolver(conn, remoteRoot), workspaceRoot: workspace };
  const ctx2: SyncContext = { resolve: singleTargetResolver(conn, root2, "ws2"), workspaceRoot: ws2 };
  await makeSyncPushTool(ctx1).execute("1", {});
  await makeSyncPushTool(ctx2).execute("2", {});
  assert.notEqual(remoteRoot, root2);
  const l2 = remote(`ls ${root2}`);
  assert.match(l2, /only-ws2\.txt/);
  assert.doesNotMatch(l2, /hello\.txt/, "ws2 不得包含 ws1 的文件");
  await conn.close();
});

// ===== 多目标白名单（pi-ssh-remote.json / TargetPool） =====
test("target 参数路由到指定目标；未知目标显式拒绝", { skip: SKIP }, async () => {
  const { TargetPool } = await import("../src/targets.js");
  const pool = new TargetPool({
    targets: {
      a: { host: "ci-remote", remoteRoot: `/tmp/pi-e2e-mt-a-${process.pid}` },
      b: { host: "ci-remote", remoteRoot: `/tmp/pi-e2e-mt-b-${process.pid}` },
    },
    defaultName: "a",
  });
  const exec = makeSshExecTool(pool.resolve);
  // 默认目标
  const r0 = await exec.execute("1", { command: "echo default-ok", env_file: false });
  assert.equal(r0.details.target, "a");
  // 显式目标：写不同文件证明路由隔离
  await exec.execute("2", { command: "mkdir -p /tmp/pi-e2e-mt-a-" + process.pid + " && echo A > /tmp/pi-e2e-mt-a-" + process.pid + "/mark", env_file: false });
  await exec.execute("3", { target: "b", command: "mkdir -p /tmp/pi-e2e-mt-b-" + process.pid + " && echo B > /tmp/pi-e2e-mt-b-" + process.pid + "/mark", env_file: false });
  const ra = await exec.execute("4", { target: "a", command: "cat /tmp/pi-e2e-mt-a-" + process.pid + "/mark", env_file: false });
  assert.match((ra.content[0] as { text: string }).text, /A/);
  assert.equal(ra.details.target, "a");
  const rb = await exec.execute("5", { target: "b", command: "cat /tmp/pi-e2e-mt-b-" + process.pid + "/mark", env_file: false });
  assert.match((rb.content[0] as { text: string }).text, /B/);
  assert.equal(rb.details.target, "b");
  // 未知目标：显式报错，列出白名单，绝不静默路由
  await assert.rejects(() => exec.execute("6", { target: "evil", command: "hostname" }), /不在白名单.*a, b/s);
  await pool.closeAll();
});

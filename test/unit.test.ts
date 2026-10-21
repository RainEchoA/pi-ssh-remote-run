/** 纯函数级单元测试（无网络）：buildRemoteCommand / parseRsyncStats / truncateMiddle / classifySshError */
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildRemoteCommand } from "../src/tools/ssh-exec.js";
import { parseRsyncStats } from "../src/tools/sync.js";
import { truncateMiddle, sq } from "../src/util.js";
import { classifySshError } from "../src/connection.js";

const ROOT = "~/pi-remote/x-1";

test("buildRemoteCommand: 默认加载 env 文件且带回探标记", () => {
  const c = buildRemoteCommand({ command: "echo hi", remoteRoot: ROOT, timeoutMs: 5000 });
  assert.match(c, /__PI_ENVFILE_LOADED__/);
  assert.match(c, /set -a/);
});

test("buildRemoteCommand: envFile=false 时不 source", () => {
  const c = buildRemoteCommand({ command: "echo hi", envFile: false, remoteRoot: ROOT, timeoutMs: 5000 });
  assert.doesNotMatch(c, /set -a/);
  assert.doesNotMatch(c, /__PI_ENVFILE_LOADED__/);
});

test("buildRemoteCommand: 显式 env 在 source 之后（优先级更高）", () => {
  const c = buildRemoteCommand({ command: "echo hi", env: { FOO: "baz" }, remoteRoot: ROOT, timeoutMs: 5000 });
  assert.ok(c.indexOf("set -a") < c.indexOf("export FOO"));
});

test("buildRemoteCommand: 单引号注入安全", () => {
  const c = buildRemoteCommand({ command: "echo 'a'", remoteRoot: ROOT, timeoutMs: 5000 });
  assert.ok(c.includes("'\\''a'\\''"), c);
});

test("buildRemoteCommand: 非法环境变量名拒绝", () => {
  assert.throws(() =>
    buildRemoteCommand({ command: "x", env: { "1BAD;rm": "v" }, remoteRoot: ROOT, timeoutMs: 1000 }),
  /非法环境变量名/);
});

test("buildRemoteCommand: 看门狗杀进程组", () => {
  const c = buildRemoteCommand({ command: "sleep 60", remoteRoot: ROOT, timeoutMs: 2000 });
  assert.match(c, /setsid bash -c/);
  assert.match(c, /kill -TERM -\$__pid/);
});

test("parseRsyncStats", () => {
  const st = parseRsyncStats("Number of regular files transferred: 12\nTotal transferred file size: 34,567 bytes");
  assert.equal(st.filesTransferred, 12);
  assert.equal(st.bytesTransferred, 34567);
});

test("truncateMiddle: 超长头尾截断并标注", () => {
  const big = "x".repeat(300 * 1024);
  const r = truncateMiddle(big);
  assert.equal(r.truncated, true);
  assert.equal(r.originalBytes, 300 * 1024);
  assert.ok(r.text.length < big.length);
  assert.match(r.text, /TRUNCATED 307200 bytes/);
});

test("truncateMiddle: 未超限原样返回", () => {
  const r = truncateMiddle("hello");
  assert.equal(r.truncated, false);
  assert.equal(r.text, "hello");
});

test("classifySshError 四类归因", () => {
  assert.equal(classifySshError("Permission denied (publickey)."), "auth");
  assert.equal(classifySshError("ssh: Could not resolve hostname foo"), "dns");
  assert.equal(classifySshError("Operation timed out"), "timeout");
  assert.equal(classifySshError("Host key verification failed."), "hostkey");
  assert.equal(classifySshError("something weird"), "unknown");
});

test("sq 单引号包裹", () => {
  assert.equal(sq("a'b"), "'a'\\''b'");
});

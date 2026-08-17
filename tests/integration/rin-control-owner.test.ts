import "../support/require-test-sandbox.ts";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const registerFixture = path.resolve(
  "tests/support/register-control-owner-fixture.ts",
);

const childScript = String.raw`
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const socketPath = path.join(process.env.XDG_RUNTIME_DIR, "rin-daemon", "daemon.sock");
await fs.mkdir(path.dirname(socketPath), { recursive: true });
let server;
const sockets = new Set();
async function startSocket() {
  if (server) return;
  server = net.createServer((socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, resolve);
  });
}
async function stopSocket() {
  if (!server) return;
  for (const socket of sockets) socket.destroy();
  const current = server;
  server = undefined;
  await new Promise((resolve) => current.close(resolve));
}
const actions = [];
globalThis.__rinControlOwnerAction = async (action, context) => {
  actions.push({ action, socketPath: context.socketPath, targetUser: context.targetUser });
  if (action === "start") {
    setTimeout(() => void startSocket(), 10);
  } else if (action === "stop") {
    setTimeout(() => void stopSocket(), 10);
  } else {
    await startSocket();
  }
};
const control = await import(pathToFileURL(path.resolve("dist/core/rin/control.js")).href);
const fenceExec = [];
await control.__rinOwnerAssertLifecycleUpdateFence({
  isTargetUser: false,
  installDir: "/owner/install",
  repoRoot: process.env.RIN_TEST_CONTROL_ROOT,
  agentDir: process.env.RIN_DIR,
  targetUser: "owner-target",
  exec(argv) {
    fenceExec.push(argv);
  },
});
assert.equal(fenceExec.length, 1);
assert.match(fenceExec[0][0], /node$/);
assert.match(fenceExec[0][1], /update-fence-check\.js$/);
assert.deepEqual(fenceExec[0].slice(-2), [process.env.RIN_DIR, "owner-target"]);
const parsed = {
  command: "start",
  targetUser: os.userInfo().username,
  targetName: "",
  installDir: path.join(process.env.RIN_TEST_CONTROL_ROOT, "install"),
  passthrough: [],
  explicitUser: false,
  explicitTarget: false,
  hasSavedInstall: false,
  releaseChannel: "stable",
  releaseBranch: "",
  releaseVersion: "",
  explicitReleaseChannel: false,
  updateAssumeYes: false,
};
const logs = [];
const originalLog = console.log;
console.log = (message) => logs.push(String(message));
try {
  await control.runStart(parsed);
  await control.runRestart({ ...parsed, command: "restart" });
  await control.runStop({ ...parsed, command: "stop" });

  globalThis.__rinControlOwnerAction = async (action, context) => {
    actions.push({ action: "failed-" + action, socketPath: context.socketPath, targetUser: context.targetUser });
  };
  const originalNow = Date.now;
  let tick = 0;
  Date.now = () => (tick += 10_000);
  try {
    await startSocket();
    await assert.rejects(
      () => control.runStop({ ...parsed, command: "stop" }),
      /rin_stop_incomplete/,
    );
    await stopSocket();
    await assert.rejects(
      () => control.runRestart({ ...parsed, command: "restart" }),
      /rin_daemon_restart_not_ready/,
    );
  } finally {
    Date.now = originalNow;
  }
} finally {
  console.log = originalLog;
  await stopSocket();
}
assert.deepEqual(actions.map((entry) => entry.action), [
  "start",
  "restart",
  "stop",
  "failed-stop",
  "failed-restart",
]);
assert.equal(actions.every((entry) => entry.socketPath === socketPath), true);
assert.deepEqual(logs, [
  "rin start complete: rin-daemon.service",
  "rin restart complete: rin-daemon.service",
  "rin stop complete: rin-daemon.service",
]);
console.log(JSON.stringify({ actions: actions.map((entry) => entry.action), logs }));
`;

test("lifecycle commands act once and prove the isolated socket state", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "rin-control-owner-"));
  try {
    const runtimeDir = path.join(root, "runtime");
    await fs.mkdir(runtimeDir, { recursive: true });
    const result = await execFileAsync(
      process.execPath,
      [
        "--import",
        "tsx",
        "--import",
        registerFixture,
        "--input-type=module",
        "-e",
        childScript,
      ],
      {
        env: {
          ...process.env,
          XDG_RUNTIME_DIR: runtimeDir,
          RIN_TEST_CONTROL_ROOT: root,
        },
      },
    );
    assert.deepEqual(JSON.parse(result.stdout).actions, [
      "start",
      "restart",
      "stop",
      "failed-stop",
      "failed-restart",
    ]);
    assert.equal(result.stderr, "");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

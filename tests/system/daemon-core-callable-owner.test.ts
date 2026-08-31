import "../support/require-test-sandbox.ts";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

import { createTestSandbox } from "../support/test-sandbox.js";

const daemonEntry = path.resolve("dist/core/rin-daemon/daemon.js");
const daemonUrl = pathToFileURL(daemonEntry).href;
const registerFixture = path.resolve(
  "tests/support/register-daemon-core-owner-fixture.ts",
);

type RunningDaemon = {
  child: ChildProcess;
  socketPath: string;
  legacyBridgePath: string;
  memoryWriterMarkerDir: string;
  stdout: () => string;
  stderr: () => string;
};

async function waitForSocket(socketPath: string, child: ChildProcess) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < 5_000) {
    if (child.exitCode !== null)
      throw new Error(`daemon_exited_before_ready:${child.exitCode}`);
    const connected = await new Promise<boolean>((resolve) => {
      const socket = net.createConnection(socketPath);
      const finish = (value: boolean) => {
        socket.destroy();
        resolve(value);
      };
      socket.once("connect", () => finish(true));
      socket.once("error", () => finish(false));
    });
    if (connected) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`daemon_socket_timeout:${socketPath}`);
}

async function startOwnerDaemon(
  root: string,
  options: { recoveryDelayMs?: number; recoveryFailure?: boolean } = {},
): Promise<RunningDaemon> {
  const sandbox = await createTestSandbox(root);
  const socketPath = path.join(
    os.tmpdir(),
    `rin-do-${process.pid}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}.sock`,
  );
  const legacyBridgePath = path.join(
    sandbox.env.RIN_DIR,
    "data/core/daemon/bridge.sock",
  );
  await fs.mkdir(path.dirname(legacyBridgePath), { recursive: true });
  await fs.writeFile(legacyBridgePath, "legacy");
  const transcripts = await import(
    pathToFileURL(path.resolve("dist/core/memory/transcripts.js")).href
  );
  await transcripts.repairTranscriptSearchIndex(sandbox.env.RIN_DIR);
  const memoryWriterMarkerDir = path.join(
    sandbox.env.RIN_DIR,
    "memory/search-writers",
  );
  await fs.mkdir(memoryWriterMarkerDir, { recursive: true });
  await fs.writeFile(
    path.join(memoryWriterMarkerDir, "999999-owner-stale.dirty"),
    `${JSON.stringify({
      pid: 999999,
      processStartIdentity: "dead-owner-writer",
      createdAt: Date.now(),
      failed: true,
    })}\n`,
  );
  const executable = path.join(
    root,
    `launcher-${Date.now()}-${Math.random()}.mjs`,
  );
  await fs.writeFile(
    executable,
    `import { startDaemon } from ${JSON.stringify(daemonUrl)};\n` +
      `const daemon = await startDaemon({\n` +
      `  socketPath: ${JSON.stringify(socketPath)},\n` +
      `  workerPath: ${JSON.stringify(path.join(root, "owner-worker"))},\n` +
      `  selfImproveWorkerPath: ${JSON.stringify(path.join(root, "owner-self-improve-worker"))},\n` +
      `  additionalExtensionPaths: ["/owner/extensions"],\n` +
      `  workerGcIdleMs: 17, workerSweepIntervalMs: 19, shutdownGraceMs: 40,\n` +
      `  chat: { send: async (payload) => payload },\n` +
      `  getExtraStatus: async () => ({ extraOwner: true, startup: { phase: "fake" } }),\n` +
      `  additionalCommandRouter: async (command) => command.type === "owner_local" ? { data: { local: true } } : command.type === "owner_local_error" ? { success: false, error: "owner-local-error" } : undefined,\n` +
      `  onShutdown: async () => {},\n` +
      `  registerLocalFrontendConnector: (connect) => { const socket = connect(); socket.on("data", () => socket.destroy()); socket.write(JSON.stringify({ id: "local-status", type: "daemon_status" }) + "\\n"); },\n` +
      `});\n` +
      `let stopping = false;\n` +
      `const shutdown = async () => { if (stopping) return; stopping = true; await daemon.shutdown(); process.exit(0); };\n` +
      `process.on("SIGINT", () => void shutdown());\n` +
      `process.on("SIGTERM", () => void shutdown());\n`,
  );
  const args = ["--import", "tsx", "--import", registerFixture, executable];
  const child = spawn(process.execPath, args, {
    env: {
      ...sandbox.env,
      RIN_TEST_DAEMON_CWD: root,
      RIN_TEST_DAEMON_RECOVERY_DELAY_MS: String(options.recoveryDelayMs || 0),
      RIN_TEST_DAEMON_RECOVERY_FAIL: options.recoveryFailure ? "1" : "0",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout!.on("data", (chunk) => (stdout += String(chunk)));
  child.stderr!.on("data", (chunk) => (stderr += String(chunk)));
  const running = {
    child,
    socketPath,
    legacyBridgePath,
    memoryWriterMarkerDir,
    stdout: () => stdout,
    stderr: () => stderr,
  };
  try {
    await waitForSocket(socketPath, child);
  } catch (error: any) {
    if (options.recoveryFailure) return running;
    throw new Error(`${error.message}\nstdout=${stdout}\nstderr=${stderr}`);
  }
  return running;
}

async function stopOwnerDaemon(daemon: RunningDaemon) {
  if (daemon.child.exitCode === null) daemon.child.kill("SIGTERM");
  const result = await Promise.race([
    new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
      (resolve, reject) => {
        daemon.child.once("error", reject);
        daemon.child.once("exit", (code, signal) => resolve({ code, signal }));
      },
    ),
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error("daemon_stop_timeout")), 2_000),
    ),
  ]);
  assert.deepEqual(result, { code: 0, signal: null }, daemon.stderr());
}

function connectRpc(socketPath: string) {
  const socket = net.createConnection(socketPath);
  let buffer = "";
  const queued: any[] = [];
  const waiters: Array<(value: any) => void> = [];
  socket.on("data", (chunk) => {
    buffer += String(chunk);
    while (buffer.includes("\n")) {
      const index = buffer.indexOf("\n");
      const line = buffer.slice(0, index).replace(/\r$/, "");
      buffer = buffer.slice(index + 1);
      if (!line.trim()) continue;
      const value = JSON.parse(line);
      const waiter = waiters.shift();
      if (waiter) waiter(value);
      else queued.push(value);
    }
  });
  const next = () =>
    queued.length
      ? Promise.resolve(queued.shift())
      : new Promise<any>((resolve, reject) => {
          const timer = setTimeout(
            () => reject(new Error("daemon_response_timeout")),
            2_000,
          );
          waiters.push((value) => {
            clearTimeout(timer);
            resolve(value);
          });
        });
  return { socket, next };
}

test("core socket is callable while durable turn recovery is still running", async () => {
  const root = await fs.mkdtemp(
    path.join(os.tmpdir(), "rin-daemon-core-recovering-"),
  );
  let daemon: RunningDaemon | undefined;
  try {
    daemon = await startOwnerDaemon(root, { recoveryDelayMs: 1_200 });

    const rpc = connectRpc(daemon.socketPath);
    await new Promise<void>((resolve, reject) => {
      rpc.socket.once("connect", resolve);
      rpc.socket.once("error", reject);
    });
    rpc.socket.write(
      `${JSON.stringify({ id: "recovering-status", type: "daemon_status" })}\n`,
    );
    const recovering = await rpc.next();
    assert.equal(recovering.success, true);
    assert.match(recovering.data.startup.phase, /^recovering_/);

    rpc.socket.write(
      `${JSON.stringify({ id: "blocked-command", type: "get_commands" })}\n`,
    );
    const blocked = await rpc.next();
    assert.equal(blocked.success, false);
    assert.equal(blocked.error, "rin_daemon_recovering");

    await new Promise((resolve) => setTimeout(resolve, 1_250));
    rpc.socket.write(
      `${JSON.stringify({ id: "ready-status", type: "daemon_status" })}\n`,
    );
    const ready = await rpc.next();
    assert.equal(ready.success, true);
    assert.equal(ready.data.startup.phase, "ready");
    rpc.socket.destroy();
  } finally {
    if (daemon) await stopOwnerDaemon(daemon);
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("startup recovery failure closes the early core socket", async () => {
  const root = await fs.mkdtemp(
    path.join(os.tmpdir(), "rin-daemon-core-recovery-failure-"),
  );
  let daemon: RunningDaemon | undefined;
  try {
    daemon = await startOwnerDaemon(root, { recoveryFailure: true });
    const result =
      daemon.child.exitCode !== null
        ? { code: daemon.child.exitCode, signal: daemon.child.signalCode }
        : await Promise.race([
            new Promise<{
              code: number | null;
              signal: NodeJS.Signals | null;
            }>((resolve, reject) => {
              daemon!.child.once("error", reject);
              daemon!.child.once("exit", (code, signal) =>
                resolve({ code, signal }),
              );
            }),
            new Promise<never>((_, reject) =>
              setTimeout(
                () => reject(new Error("daemon_failure_exit_timeout")),
                2_000,
              ),
            ),
          ]);
    assert.equal(result.code, 1);
    assert.equal(result.signal, null);
    await assert.rejects(fs.stat(daemon.socketPath), /ENOENT/);
    assert.match(daemon.stderr(), /owner_recovery_failed/);
  } finally {
    if (daemon?.child.exitCode === null) daemon.child.kill("SIGKILL");
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("callable core daemon routes the complete system-owned RPC while its host owns shutdown", async () => {
  const root = await fs.mkdtemp(
    path.join(os.tmpdir(), "rin-daemon-core-owner-"),
  );
  let daemon: RunningDaemon | undefined;
  try {
    daemon = await startOwnerDaemon(root);
    const socketStat = await fs.stat(daemon.socketPath);
    assert.equal(socketStat.mode & 0o777, 0o600);
    await assert.rejects(fs.access(daemon.legacyBridgePath), {
      code: "ENOENT",
    });
    assert.deepEqual(await fs.readdir(daemon.memoryWriterMarkerDir), []);
    const rpc = connectRpc(daemon.socketPath);
    await new Promise<void>((resolve, reject) => {
      rpc.socket.once("connect", resolve);
      rpc.socket.once("error", reject);
    });

    let serial = 0;
    const request = async (command: Record<string, unknown>) => {
      const id = String(++serial);
      rpc.socket.write(`${JSON.stringify({ id, ...command })}\r\n`);
      for (;;) {
        const value = await rpc.next();
        if (value.id === id) return value;
      }
    };

    rpc.socket.write("\n{not-json}\n");
    assert.equal((await rpc.next()).error, "invalid_json");

    const initialStateResponse = await request({ type: "get_state" });
    assert.equal(
      initialStateResponse.success,
      true,
      JSON.stringify(initialStateResponse),
    );
    for (const type of [
      "get_messages",
      "get_session_snapshot",
      "get_commands",
      "get_all_models",
      "get_available_models",
      "get_oauth_state",
    ]) {
      assert.equal(
        (
          await request({
            type,
            payload: { owner: type },
            resourceOptions: { owner: true },
          })
        ).success,
        true,
        type,
      );
    }
    assert.equal((await request({ type: "get_commands" })).success, true);

    assert.equal(
      (await request({ type: "prompt", noWorker: true })).error,
      "rin_no_attached_session",
    );
    assert.equal(
      (await request({ type: "new_session", noWorker: true })).error,
      "rin_no_attached_session",
    );
    assert.equal(
      (await request({ type: "new_session", createWorker: true })).success,
      true,
    );
    assert.equal(
      (
        await request({
          type: "new_session",
          createWorker: true,
          requireAbort: true,
        })
      ).success,
      true,
      "daemon new_session must settle interruption on the previous worker before replacement",
    );
    assert.equal(
      (
        await request({
          type: "new_session",
          createWorker: true,
          requireAbort: true,
          failAbort: true,
        })
      ).error,
      "owner abort failed",
      "a failed interruption must keep new_session from establishing a replacement",
    );
    assert.equal(
      (
        await request({
          type: "new_session",
          createWorker: true,
          failState: true,
        })
      ).error,
      "owner worker state failed",
    );
    assert.equal(
      (
        await request({
          type: "new_session",
          createWorker: true,
          stateEmpty: true,
        })
      ).data.sessionId,
      "owner",
    );

    for (const type of ["switch_session", "select_session", "attach_session"]) {
      assert.equal((await request({ type })).success, false);
      assert.equal(
        (await request({ type, sessionId: "missing" })).success,
        false,
      );
      assert.equal(
        (await request({ type, sessionId: `${type}-owner` })).success,
        true,
      );
    }

    assert.equal(
      (
        await request({
          type: "list_sessions",
          limit: 2,
          offset: 1,
        })
      ).data.limit,
      2,
    );
    assert.deepEqual((await request({ type: "list_sessions" })).data.sessions, [
      { all: true },
    ]);
    assert.equal(
      (await request({ type: "list_sessions", limit: 99 })).error,
      "owner list page failure",
    );
    assert.equal(
      (await request({ type: "list_sessions", limit: 98 })).error,
      "owner list error",
    );
    assert.equal(
      (await request({ type: "await_turn_terminal" })).success,
      true,
    );
    assert.equal(
      (
        await request({
          type: "await_turn_terminal",
          sessionFile: "/owner.jsonl",
          requestTag: "owner-await",
        })
      ).data.requestTag,
      "owner-await",
    );
    assert.equal(
      (
        await request({
          type: "ack_turn_terminal",
          requestTag: "missing-request",
          terminalId: "missing-terminal",
        })
      ).success,
      false,
    );
    assert.deepEqual(
      (
        await request({
          type: "list_unacknowledged_chat_terminals",
          chatKey: " ",
        })
      ).data.terminals,
      [],
    );
    assert.equal(
      (await request({ type: "rename_session", name: "owner" })).success,
      true,
    );
    assert.equal(
      (await request({ type: "rename_session", name: "" })).error,
      "owner rename rejected",
    );

    assert.equal(
      (
        await request({
          type: "get_state",
          frontendIdentity: { kind: "tui" },
        })
      ).success,
      true,
    );
    const daemonStatus = await request({ type: "daemon_status" });
    assert.equal(daemonStatus.data.extraOwner, true);
    assert.equal(daemonStatus.data.frontendKind, "tui");
    assert.equal(
      (await request({ type: "daemon_activity" })).data.extraOwner,
      undefined,
    );

    for (const command of [
      { type: "cron_list_tasks" },
      { type: "cron_reload_tasks" },
      { type: "cron_get_task", taskId: "owner-task" },
      { type: "cron_get_task", taskId: "missing" },
      { type: "cron_upsert_task", task: { id: "new-task" }, defaults: {} },
      { type: "cron_upsert_task" },
      { type: "cron_delete_task", taskId: "new-task" },
      { type: "cron_delete_task", taskId: "missing" },
      { type: "cron_complete_task", taskId: "owner-task", reason: "done" },
      { type: "cron_complete_task", taskId: "owner-task" },
      { type: "cron_pause_task", taskId: "owner-task" },
      { type: "cron_pause_task" },
      { type: "cron_resume_task", taskId: "owner-task" },
      { type: "cron_reschedule_once_task", taskId: "owner-task", runAt: "now" },
      { type: "cron_reschedule_once_task", taskId: "owner-task" },
      { type: "cron_run_task", taskId: "owner-task" },
      { type: "cron_wake_task", taskId: "owner-task" },
    ]) {
      assert.equal((await request(command)).type, "response");
    }

    assert.equal((await request({})).success, true);
    assert.equal((await request({ type: "owner_local" })).success, true);
    assert.equal(
      (await request({ type: "owner_local_error" })).error,
      "owner-local-error",
    );
    assert.equal(
      (await request({ type: "owner_forward", createWorker: true })).data
        .forwarded,
      true,
    );
    assert.equal((await request({ type: "detach_session" })).success, true);
    assert.deepEqual((await request({ type: "terminate_session" })).data, {
      terminated: false,
    });
    await request({ type: "select_session", sessionId: "terminate-owner" });
    assert.equal(
      (await request({ type: "terminate_session" })).data.terminated,
      true,
    );
    assert.equal(
      (
        await request({
          type: "prompt",
          sessionId: "ensure-missing",
          noWorker: true,
        })
      ).error,
      "rin_no_attached_session",
    );
    assert.equal(
      (
        await request({
          type: "prompt",
          sessionId: "ensured-owner",
          noWorker: true,
        })
      ).data.forwarded,
      true,
    );

    rpc.socket.destroy();
    await stopOwnerDaemon(daemon);
    assert.match(daemon.stdout(), /rin daemon listening on/);
    daemon = undefined;
  } finally {
    if (daemon?.child.exitCode === null) daemon.child.kill("SIGKILL");
    await fs.rm(root, { recursive: true, force: true });
  }
});

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
  options: {
    custom?: boolean;
    cliStyle?: "equals" | "separate" | "positional";
    env?: NodeJS.ProcessEnv;
  } = {},
): Promise<RunningDaemon> {
  const sandbox = await createTestSandbox(root);
  const socketPath = path.join(
    os.tmpdir(),
    `rin-do-${process.pid}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}.sock`,
  );
  let executable = daemonEntry;
  let args: string[];
  if (options.custom) {
    executable = path.join(root, `launcher-${Date.now()}-${Math.random()}.mjs`);
    await fs.writeFile(
      executable,
      `import { startDaemon } from ${JSON.stringify(daemonUrl)};\n` +
        `await startDaemon({\n` +
        `  socketPath: ${JSON.stringify(socketPath)},\n` +
        `  workerPath: ${JSON.stringify(path.join(root, "owner-worker"))},\n` +
        `  additionalExtensionPaths: ["/owner/extensions"],\n` +
        `  workerGcIdleMs: 17, workerSweepIntervalMs: 19, shutdownGraceMs: 40,\n` +
        `  chat: { send: async (payload) => payload },\n` +
        `  getExtraStatus: async () => ({ extraOwner: true }),\n` +
        `  handleLocalCommand: async (command) => command.type === "owner_local" ? { data: { local: true } } : command.type === "owner_local_error" ? { success: false, error: "owner-local-error" } : undefined,\n` +
        `  onShutdown: async () => {},\n` +
        `  registerLocalFrontendConnector: (connect) => { const socket = connect(); socket.on("data", () => socket.destroy()); socket.write(JSON.stringify({ id: "local-status", type: "daemon_status" }) + "\\n"); },\n` +
        `});\n`,
    );
    args = ["--import", "tsx", "--import", registerFixture, executable];
  } else {
    const style = options.cliStyle || "separate";
    const daemonArgs =
      style === "equals"
        ? [
            `--socket=${socketPath}`,
            `--worker=${path.join(root, "owner-worker")}`,
            "--shutdown-grace-ms=30",
          ]
        : style === "positional"
          ? [socketPath, "--shutdown-grace-ms", "not-a-number"]
          : [
              "--socket",
              socketPath,
              "--worker",
              path.join(root, "owner-worker"),
              "--shutdown-grace-ms",
              "30",
            ];
    args = [
      "--import",
      "tsx",
      "--import",
      registerFixture,
      executable,
      ...daemonArgs,
    ];
  }
  const child = spawn(process.execPath, args, {
    env: {
      ...sandbox.env,
      ...options.env,
      RIN_TEST_DAEMON_CWD: root,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout!.on("data", (chunk) => (stdout += String(chunk)));
  child.stderr!.on("data", (chunk) => (stderr += String(chunk)));
  await waitForSocket(socketPath, child).catch((error) => {
    throw new Error(`${error.message}\nstdout=${stdout}\nstderr=${stderr}`);
  });
  return { child, socketPath, stdout: () => stdout, stderr: () => stderr };
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

test("core daemon routes the complete system-owned RPC and lifecycle contract", async () => {
  const root = await fs.mkdtemp(
    path.join(os.tmpdir(), "rin-daemon-core-owner-"),
  );
  let daemon: RunningDaemon | undefined;
  try {
    daemon = await startOwnerDaemon(root, { custom: true });
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

    assert.equal((await request({ type: "get_state" })).success, true);
    for (const type of [
      "get_messages",
      "get_session_snapshot",
      "get_commands",
      "get_all_models",
      "get_available_models",
      "get_oauth_state",
      "memory_search_external",
      "memory_write_external",
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
      (await request({ type: "memory_search_external" })).success,
      true,
    );
    assert.equal(
      (await request({ type: "memory_write_external" })).success,
      true,
    );

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
      (await request({ type: "daemon_status" })).data.extraOwner,
      true,
    );
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

    for (const cliStyle of ["equals", "separate", "positional"] as const) {
      const direct = await startOwnerDaemon(root, { cliStyle });
      await stopOwnerDaemon(direct);
    }
  } finally {
    if (daemon?.child.exitCode === null) daemon.child.kill("SIGKILL");
    await fs.rm(root, { recursive: true, force: true });
  }
});

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import net from "node:net";
import { spawn } from "node:child_process";

const rootDir = path.resolve(
  path.dirname(new URL(import.meta.url).pathname),
  "..",
  "..",
);
const { RinDaemonFrontendClient } =
  await import("../../dist/core/rin-frontend-sdk/daemon-client.js");
const { RinFrontendTurnDriver } =
  await import("../../dist/core/rin-frontend-sdk/turn-driver.js");
const { readDaemonTurn } =
  await import("../../dist/core/rin-daemon/turn-ledger.js");

async function waitForSocket(socketPath, timeoutMs = 5000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const ok = await new Promise((resolve) => {
      const socket = net.createConnection(socketPath);
      let settled = false;
      const finish = (value) => {
        if (settled) return;
        settled = true;
        try {
          socket.destroy();
        } catch {
          // ignore
        }
        resolve(value);
      };
      socket.once("connect", () => finish(true));
      socket.once("error", () => finish(false));
      setTimeout(() => finish(false), 100);
    });
    if (ok) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`socket_not_ready:${socketPath}`);
}

async function openRpcConnection(socketPath) {
  const socket = net.createConnection(socketPath);
  await new Promise((resolve, reject) => {
    socket.once("connect", resolve);
    socket.once("error", reject);
  });
  let buffer = "";
  return {
    socket,
    request(command, timeoutMs = 5000) {
      return new Promise((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error(`payload_timeout:${command.id}`)),
          timeoutMs,
        );
        const onData = (chunk) => {
          buffer += String(chunk);
          while (true) {
            const idx = buffer.indexOf("\n");
            if (idx < 0) break;
            let line = buffer.slice(0, idx);
            buffer = buffer.slice(idx + 1);
            if (line.endsWith("\r")) line = line.slice(0, -1);
            if (!line.trim()) continue;
            const payload = JSON.parse(line);
            if (payload?.type === "response" && payload?.id === command.id) {
              clearTimeout(timer);
              socket.off("data", onData);
              socket.off("error", onError);
              resolve(payload);
              return;
            }
          }
        };
        const onError = (error) => {
          clearTimeout(timer);
          socket.off("data", onData);
          reject(error);
        };
        socket.on("data", onData);
        socket.once("error", onError);
        socket.write(`${JSON.stringify(command)}\n`);
      });
    },
    close() {
      socket.destroy();
    },
  };
}

async function withRpcConnection(socketPath, callback) {
  const client = await openRpcConnection(socketPath);
  try {
    return await callback(client);
  } finally {
    client.close();
  }
}

async function rpc(socketPath, command, timeoutMs = 5000) {
  return await withRpcConnection(socketPath, (client) =>
    client.request(command, timeoutMs),
  );
}

async function readLogLines(logPath) {
  try {
    return (await fs.readFile(logPath, "utf8"))
      .trim()
      .split("\n")
      .filter(Boolean);
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }
}

function spawnDaemon(agentDir, socketPath, workerPath) {
  return spawn(
    process.execPath,
    [
      path.join(rootDir, "dist", "core", "rin-daemon", "daemon.js"),
      socketPath,
      "--worker",
      workerPath,
      "--shutdown-grace-ms",
      "200",
    ],
    {
      cwd: rootDir,
      env: {
        ...process.env,
        RIN_DIR: agentDir,
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
}

async function makeTempDir(prefix) {
  const root = process.env.RIN_TEST_TMPDIR || "/home/rin/tmp";
  await fs.mkdir(root, { recursive: true });
  return await fs.mkdtemp(path.join(root, prefix));
}

test("daemon serves sessionless catalog commands locally without spawning a worker", async () => {
  const agentDir = await makeTempDir("rin-daemon-local-");
  const socketPath = path.join(agentDir, "daemon.sock");
  const workerPath = path.join(agentDir, "fake-worker.js");
  const logPath = path.join(agentDir, "commands.log");
  await fs.writeFile(
    workerPath,
    `
const fs = require("node:fs");
const process = require("node:process");
const logPath = ${JSON.stringify(logPath)};
let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  while (true) {
    const idx = buffer.indexOf("\\n");
    if (idx < 0) break;
    const line = buffer.slice(0, idx);
    buffer = buffer.slice(idx + 1);
    if (!line.trim()) continue;
    const command = JSON.parse(line);
    fs.appendFileSync(logPath, command.type + "\\n");
    process.stdout.write(JSON.stringify({ type: "response", id: command.id, command: command.type, success: true, data: {} }) + "\\n");
  }
});
`,
  );

  const daemon = spawnDaemon(agentDir, socketPath, workerPath);
  try {
    await waitForSocket(socketPath);

    const messages = await rpc(socketPath, { id: "1", type: "get_messages" });
    const snapshot = await rpc(socketPath, {
      id: "2",
      type: "get_session_snapshot",
    });
    const commands = await rpc(socketPath, { id: "3", type: "get_commands" });
    const models = await rpc(socketPath, {
      id: "4",
      type: "get_available_models",
    });
    const oauth = await rpc(socketPath, { id: "5", type: "get_oauth_state" });
    assert.equal(messages.success, true);
    assert.deepEqual(messages.data, { messages: [] });
    assert.equal(snapshot.success, true);
    assert.deepEqual(snapshot.data, { entries: [], leafId: null });
    assert.equal(commands.success, true);
    assert.equal(Array.isArray(commands.data?.commands), true);
    assert.equal(models.success, true);
    assert.equal(Array.isArray(models.data?.models), true);
    assert.equal(oauth.success, true);
    assert.equal(typeof oauth.data, "object");
    assert.notEqual(oauth.data, null);

    let workerLog = "";
    try {
      workerLog = await fs.readFile(logPath, "utf8");
    } catch {
      // ignore
    }
    assert.equal(workerLog.trim(), "");
  } finally {
    try {
      daemon.kill("SIGKILL");
    } catch {
      // ignore
    }
    await fs.rm(agentDir, { recursive: true, force: true });
  }
});

test("daemon serves initial state and session listing locally without spawning a worker", async () => {
  const agentDir = await makeTempDir("rin-daemon-list-sessions-");
  const socketPath = path.join(agentDir, "daemon.sock");
  const workerPath = path.join(agentDir, "fake-worker.js");
  const logPath = path.join(agentDir, "commands.log");
  await fs.writeFile(
    workerPath,
    `
const fs = require("node:fs");
const process = require("node:process");
const logPath = ${JSON.stringify(logPath)};
let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  while (true) {
    const idx = buffer.indexOf("\\n");
    if (idx < 0) break;
    const line = buffer.slice(0, idx);
    buffer = buffer.slice(idx + 1);
    if (!line.trim()) continue;
    const command = JSON.parse(line);
    fs.appendFileSync(logPath, command.type + "\\n");
    process.stdout.write(JSON.stringify({ type: "response", id: command.id, command: command.type, success: true, data: {} }) + "\\n");
  }
});
`,
  );

  const daemon = spawnDaemon(agentDir, socketPath, workerPath);
  try {
    await waitForSocket(socketPath);

    await withRpcConnection(socketPath, async (client) => {
      const state = await client.request({ id: "1", type: "get_state" });
      const listed = await client.request({ id: "2", type: "list_sessions" });

      assert.equal(state.success, true);
      assert.equal(state.data?.sessionId, "");
      assert.equal(state.data?.turnActive, false);
      assert.equal(listed.success, true);
      assert.equal(Array.isArray(listed.data?.sessions), true);

      let workerLog = "";
      try {
        workerLog = await fs.readFile(logPath, "utf8");
      } catch {
        // ignore
      }
      assert.equal(workerLog.trim(), "");
    });
  } finally {
    try {
      daemon.kill("SIGKILL");
    } catch {
      // ignore
    }
    await fs.rm(agentDir, { recursive: true, force: true });
  }
});

test("daemon routes cron lifecycle commands locally through the scheduler", async () => {
  const agentDir = await makeTempDir("rin-daemon-cron-");
  const socketPath = path.join(agentDir, "daemon.sock");
  const workerPath = path.join(agentDir, "fake-worker.js");
  const logPath = path.join(agentDir, "commands.log");
  await fs.writeFile(
    workerPath,
    `
const fs = require("node:fs");
const process = require("node:process");
const logPath = ${JSON.stringify(logPath)};
let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  while (true) {
    const idx = buffer.indexOf("\\n");
    if (idx < 0) break;
    const line = buffer.slice(0, idx);
    buffer = buffer.slice(idx + 1);
    if (!line.trim()) continue;
    const command = JSON.parse(line);
    fs.appendFileSync(logPath, command.type + "\\n");
    process.stdout.write(JSON.stringify({ type: "response", id: command.id, command: command.type, success: true, data: {} }) + "\\n");
  }
});
`,
  );

  const daemon = spawnDaemon(agentDir, socketPath, workerPath);
  try {
    await waitForSocket(socketPath);

    const listed = await rpc(socketPath, { id: "1", type: "cron_list_tasks" });
    assert.equal(listed.success, true);
    assert.deepEqual(listed.data?.tasks, []);

    const saved = await rpc(socketPath, {
      id: "2",
      type: "cron_upsert_task",
      task: {
        name: "Demo Task",
        enabled: true,
        trigger: { kind: "once", runAt: "2099-01-01T00:00:00.000Z" },
        session: { mode: "dedicated" },
        target: { kind: "agent_prompt", prompt: "hello" },
      },
    });
    assert.equal(saved.success, true);
    const taskId = saved.data?.task?.id;
    assert.equal(typeof taskId, "string");
    assert.equal(saved.data?.task?.name, "Demo Task");

    const fetched = await rpc(socketPath, {
      id: "3",
      type: "cron_get_task",
      taskId,
    });
    assert.equal(fetched.success, true);
    assert.equal(fetched.data?.task?.id, taskId);

    const tasksFile = path.join(agentDir, "data", "scheduler", "tasks.json");
    const rows = JSON.parse(await fs.readFile(tasksFile, "utf8"));
    rows.find((row: any) => row.id === taskId).name = "Reloaded Task";
    await fs.writeFile(tasksFile, `${JSON.stringify(rows, null, 2)}\n`, "utf8");
    const stillCached = await rpc(socketPath, {
      id: "3a",
      type: "cron_get_task",
      taskId,
    });
    assert.equal(stillCached.data?.task?.name, "Demo Task");
    const reloaded = await rpc(socketPath, {
      id: "3b",
      type: "cron_reload_tasks",
    });
    assert.equal(reloaded.success, true);
    assert.equal(reloaded.data?.cron?.taskCount, 1);
    const fetchedAfterReload = await rpc(socketPath, {
      id: "3c",
      type: "cron_get_task",
      taskId,
    });
    assert.equal(fetchedAfterReload.data?.task?.name, "Reloaded Task");

    const paused = await rpc(socketPath, {
      id: "4",
      type: "cron_pause_task",
      taskId,
    });
    assert.equal(paused.success, true);
    assert.equal(paused.data?.task?.enabled, false);

    const resumed = await rpc(socketPath, {
      id: "5",
      type: "cron_resume_task",
      taskId,
    });
    assert.equal(resumed.success, true);
    assert.equal(resumed.data?.task?.enabled, true);

    const completed = await rpc(socketPath, {
      id: "6",
      type: "cron_complete_task",
      taskId,
    });
    assert.equal(completed.success, true);
    assert.equal(completed.data?.task?.enabled, false);
    assert.equal(completed.data?.task?.completionReason, "completed_by_tool");

    const deleted = await rpc(socketPath, {
      id: "7",
      type: "cron_delete_task",
      taskId,
    });
    assert.equal(deleted.success, true);
    assert.deepEqual(deleted.data, { deleted: true });

    const missing = await rpc(socketPath, {
      id: "8",
      type: "cron_get_task",
      taskId,
    });
    assert.equal(missing.success, false);
    assert.equal(missing.error, "cron_task_not_found");

    let workerLog = "";
    try {
      workerLog = await fs.readFile(logPath, "utf8");
    } catch {
      // ignore
    }
    assert.equal(workerLog.trim(), "");
  } finally {
    try {
      daemon.kill("SIGKILL");
    } catch {
      // ignore
    }
    await fs.rm(agentDir, { recursive: true, force: true });
  }
});

test("daemon shuts down the previous selected session when starting a new session before state sync", async () => {
  const agentDir = await makeTempDir("rin-daemon-new-abort-");
  const socketPath = path.join(agentDir, "daemon.sock");
  const workerPath = path.join(agentDir, "fake-worker.js");
  const logPath = path.join(agentDir, "commands.log");
  await fs.writeFile(
    workerPath,
    `
const fs = require("node:fs");
const process = require("node:process");
const logPath = ${JSON.stringify(logPath)};
function send(payload) { process.stdout.write(JSON.stringify(payload) + "\\n"); }
function log(type) { fs.appendFileSync(logPath, process.pid + ":" + type + "\\n"); }
let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  while (true) {
    const idx = buffer.indexOf("\\n");
    if (idx < 0) break;
    const line = buffer.slice(0, idx);
    buffer = buffer.slice(idx + 1);
    if (!line.trim()) continue;
    const command = JSON.parse(line);
    log(command.type);
    if (command.type === "get_state") {
      send({ type: "response", id: command.id, command: command.type, success: true, data: { sessionFile: "/tmp/session-" + process.pid + ".jsonl", sessionId: "session-" + process.pid, isStreaming: false, isCompacting: false } });
      continue;
    }
    if (command.type === "new_session" || command.type === "switch_session") {
      send({ type: "response", id: command.id, command: command.type, success: false, error: "unsupported_session_lifecycle_command" });
      continue;
    }
    if (command.type === "prompt") {
      send({ type: "response", id: command.id, command: command.type, success: true, data: {} });
      continue;
    }
    if (command.type === "shutdown_session") {
      send({ type: "response", id: command.id, command: command.type, success: true, data: { shutdown: true } });
      process.exit(0);
    }
    send({ type: "response", id: command.id, command: command.type, success: true, data: {} });
  }
});
`,
  );

  const daemon = spawnDaemon(agentDir, socketPath, workerPath);
  try {
    await waitForSocket(socketPath);
    await withRpcConnection(socketPath, async (client) => {
      const first = await client.request({ id: "1", type: "new_session" });
      const prompt = await client.request({
        id: "2",
        type: "prompt",
        message: "old turn",
        requestTag: "old-turn",
      });
      const second = await client.request({ id: "3", type: "new_session" });

      assert.equal(first.success, true);
      assert.equal(prompt.success, true);
      assert.equal(second.success, true);
      assert.notEqual(second.data?.sessionFile, first.data?.sessionFile);

      let lines = [];
      for (let i = 0; i < 20; i += 1) {
        lines = (await fs.readFile(logPath, "utf8"))
          .trim()
          .split("\n")
          .filter(Boolean);
        if (lines.some((line) => line.endsWith(":shutdown_session"))) break;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }

      const byPid = new Map();
      for (const line of lines) {
        const [pid, type] = line.split(":");
        const list = byPid.get(pid) || [];
        list.push(type);
        byPid.set(pid, list);
      }
      const commandGroups = Array.from(byPid.values());
      assert.equal(commandGroups.length, 2);
      assert.equal(
        commandGroups.some((commands) =>
          ["get_state", "prompt", "shutdown_session"].every((type) =>
            commands.includes(type),
          ),
        ),
        true,
      );
      assert.equal(
        commandGroups.some(
          (commands) =>
            commands.includes("get_state") &&
            !commands.includes("prompt") &&
            !commands.includes("shutdown_session") &&
            !commands.includes("new_session") &&
            !commands.includes("switch_session"),
        ),
        true,
      );
    });
  } finally {
    try {
      daemon.kill("SIGKILL");
    } catch {
      // ignore
    }
    await fs.rm(agentDir, { recursive: true, force: true });
  }
});

test("daemon terminate_session is idempotent after the session is detached", async () => {
  const agentDir = await makeTempDir("rin-daemon-terminate-idempotent-");
  const socketPath = path.join(agentDir, "daemon.sock");
  const workerPath = path.join(agentDir, "fake-worker.js");
  await fs.writeFile(
    workerPath,
    `
const process = require("node:process");
function send(payload) { process.stdout.write(JSON.stringify(payload) + "\\n"); }
let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  while (true) {
    const idx = buffer.indexOf("\\n");
    if (idx < 0) break;
    const line = buffer.slice(0, idx);
    buffer = buffer.slice(idx + 1);
    if (!line.trim()) continue;
    const command = JSON.parse(line);
    if (command.type === "get_state") {
      send({ type: "response", id: command.id, command: command.type, success: true, data: { sessionFile: "/tmp/terminate-idempotent.jsonl", sessionId: "terminate-idempotent", isStreaming: false, isCompacting: false } });
      continue;
    }
    if (command.type === "shutdown_session") process.exit(0);
    send({ type: "response", id: command.id, command: command.type, success: true, data: {} });
  }
});
`,
  );

  const daemon = spawnDaemon(agentDir, socketPath, workerPath);
  try {
    await waitForSocket(socketPath);
    await withRpcConnection(socketPath, async (client) => {
      const created = await client.request({ id: "1", type: "new_session" });
      const terminated = await client.request({
        id: "2",
        type: "terminate_session",
      });
      const alreadyTerminated = await client.request({
        id: "3",
        type: "terminate_session",
      });

      assert.equal(created.success, true);
      assert.deepEqual(terminated, {
        id: "2",
        type: "response",
        command: "terminate_session",
        success: true,
        data: { terminated: true },
      });
      assert.deepEqual(alreadyTerminated, {
        id: "3",
        type: "response",
        command: "terminate_session",
        success: true,
        data: { terminated: false },
      });
    });
  } finally {
    try {
      daemon.kill("SIGKILL");
    } catch {
      // ignore
    }
    await fs.rm(agentDir, { recursive: true, force: true });
  }
});

test("daemon attaches a selected session without a frontend switch_session round-trip", async () => {
  const agentDir = await makeTempDir("rin-daemon-select-");
  const socketPath = path.join(agentDir, "daemon.sock");
  const workerPath = path.join(agentDir, "fake-worker.js");
  const logPath = path.join(agentDir, "commands.log");
  const sessionFile = "/tmp/selected-session.jsonl";
  await fs.writeFile(
    workerPath,
    `
const fs = require("node:fs");
const process = require("node:process");
const logPath = ${JSON.stringify(logPath)};
const sessionFile = ${JSON.stringify(sessionFile)};
function send(payload) { process.stdout.write(JSON.stringify(payload) + "\\n"); }
function log(type) { fs.appendFileSync(logPath, type + "\\n"); }
let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  while (true) {
    const idx = buffer.indexOf("\\n");
    if (idx < 0) break;
    const line = buffer.slice(0, idx);
    buffer = buffer.slice(idx + 1);
    if (!line.trim()) continue;
    const command = JSON.parse(line);
    log(command.type);
    if (command.type === "switch_session") {
      send({ type: "response", id: command.id, command: command.type, success: true, data: { cancelled: false, sessionFile, sessionId: "selected-session" } });
      continue;
    }
    if (command.type === "get_state") {
      send({ type: "response", id: command.id, command: command.type, success: true, data: { sessionFile, sessionId: "selected-session", isStreaming: false, isCompacting: false } });
      continue;
    }
    send({ type: "response", id: command.id, command: command.type, success: true, data: {} });
  }
});
`,
  );

  const daemon = spawnDaemon(agentDir, socketPath, workerPath);
  try {
    await waitForSocket(socketPath);
    await withRpcConnection(socketPath, async (client) => {
      const selected = await client.request({
        id: "1",
        type: "select_session",
        sessionPath: sessionFile,
      });
      const state = await client.request({ id: "2", type: "get_state" });

      assert.equal(selected.success, true);
      assert.equal(state.success, true);
      assert.equal(state.data?.sessionFile, sessionFile);
      assert.deepEqual(await readLogLines(logPath), ["get_state"]);
    });
  } finally {
    try {
      daemon.kill("SIGKILL");
    } catch {
      // ignore
    }
    await fs.rm(agentDir, { recursive: true, force: true });
  }
});

test("daemon switch_session reuses an already-open session worker", async () => {
  const agentDir = await makeTempDir("rin-daemon-switch-reuse-");
  const socketPath = path.join(agentDir, "daemon.sock");
  const workerPath = path.join(agentDir, "fake-worker.js");
  const logPath = path.join(agentDir, "commands.jsonl");
  const firstSession = "/tmp/shared-session.jsonl";
  const secondSession = "/tmp/other-session.jsonl";
  await fs.writeFile(
    workerPath,
    `
const fs = require("node:fs");
const path = require("node:path");
const process = require("node:process");
const logPath = ${JSON.stringify(logPath)};
function send(payload) { process.stdout.write(JSON.stringify(payload) + "\\n"); }
function log(command) { fs.appendFileSync(logPath, JSON.stringify({ pid: process.pid, type: command.type, sessionPath: command.sessionPath }) + "\\n"); }
let sessionFile = "";
let sessionId = "";
let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  while (true) {
    const idx = buffer.indexOf("\\n");
    if (idx < 0) break;
    const line = buffer.slice(0, idx);
    buffer = buffer.slice(idx + 1);
    if (!line.trim()) continue;
    const command = JSON.parse(line);
    log(command);
    if (command.type === "switch_session") {
      sessionFile = command.sessionPath;
      sessionId = path.basename(sessionFile, ".jsonl");
      send({ type: "response", id: command.id, command: command.type, success: true, data: { cancelled: false, sessionFile, sessionId } });
      continue;
    }
    if (command.type === "get_state") {
      send({ type: "response", id: command.id, command: command.type, success: true, data: { sessionFile, sessionId, isStreaming: false, isCompacting: false } });
      continue;
    }
    send({ type: "response", id: command.id, command: command.type, success: true, data: { sessionFile, sessionId } });
  }
});
`,
  );

  const daemon = spawnDaemon(agentDir, socketPath, workerPath);
  let firstClient;
  let secondClient;
  try {
    await waitForSocket(socketPath);
    firstClient = await openRpcConnection(socketPath);
    secondClient = await openRpcConnection(socketPath);

    assert.equal(
      (
        await firstClient.request({
          id: "first-switch",
          type: "switch_session",
          sessionPath: firstSession,
        })
      ).success,
      true,
    );
    assert.equal(
      (
        await secondClient.request({
          id: "second-switch",
          type: "switch_session",
          sessionPath: secondSession,
        })
      ).success,
      true,
    );

    const switchedToOpen = await secondClient.request({
      id: "second-switch-open",
      type: "switch_session",
      sessionPath: firstSession,
    });
    const status = await rpc(socketPath, {
      id: "status-after-switch",
      type: "daemon_status",
    });
    const commandLog = (await readLogLines(logPath)).map((line) =>
      JSON.parse(line),
    );
    const switchCommands = commandLog.filter(
      (entry) => entry.type === "switch_session",
    );
    const firstSessionWorkers = status.data?.workers.filter(
      (worker) => worker.sessionFile === firstSession,
    );

    assert.equal(switchedToOpen.success, true);
    assert.equal(firstSessionWorkers.length, 1);
    assert.equal(firstSessionWorkers[0].attachedConnections, 2);
    assert.equal(
      switchCommands.filter((entry) => entry.sessionPath === firstSession)
        .length,
      0,
    );
  } finally {
    firstClient?.close();
    secondClient?.close();
    try {
      daemon.kill("SIGKILL");
    } catch {
      // ignore
    }
    await fs.rm(agentDir, { recursive: true, force: true });
  }
});

test("frontend accepts distinct durable terminals when replacement workers reuse generation one", async () => {
  const agentDir = await makeTempDir("rin-daemon-terminal-identity-");
  const socketPath = path.join(agentDir, "daemon.sock");
  const workerPath = path.join(agentDir, "fake-worker.js");
  const sessionFile = path.join(agentDir, "sessions", "shared.jsonl");
  await fs.mkdir(path.dirname(sessionFile), { recursive: true });
  await fs.writeFile(sessionFile, "");
  await fs.writeFile(
    workerPath,
    `
const process = require("node:process");
const sessionFile = ${JSON.stringify(sessionFile)};
const sessionId = "shared-session";
function send(payload) { process.stdout.write(JSON.stringify(payload) + "\\n"); }
let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  while (true) {
    const idx = buffer.indexOf("\\n");
    if (idx < 0) break;
    const line = buffer.slice(0, idx);
    buffer = buffer.slice(idx + 1);
    if (!line.trim()) continue;
    const command = JSON.parse(line);
    if (command.type === "get_state") {
      send({ type: "response", id: command.id, command: command.type, success: true, data: { sessionFile, sessionId, isStreaming: false, isCompacting: false } });
      continue;
    }
    if (command.type === "prompt") {
      send({ type: "response", id: command.id, command: command.type, success: true, data: { requestTag: command.requestTag, sessionFile, sessionId } });
      setTimeout(() => {
        send({ type: "rpc_turn_event", event: "complete", requestTag: command.requestTag, sessionFile, sessionId, turnGeneration: 1, finalText: "final:" + command.requestTag });
        setTimeout(() => process.exit(0), 25);
      }, 5);
      continue;
    }
    send({ type: "response", id: command.id, command: command.type, success: true, data: { sessionFile, sessionId } });
  }
});
`,
  );

  const daemon = spawnDaemon(agentDir, socketPath, workerPath);
  const client = new RinDaemonFrontendClient({
    socketPath,
    frontendIdentity: {
      clientType: "chat-bridge",
      clientInstanceId: "terminal-identity-test",
    },
  });
  const driver = new RinFrontendTurnDriver({
    clientFactory: () => client,
    promptSource: "chat-bridge",
  });
  const runWithTimeout = async (requestTag) => {
    let timeout;
    try {
      return await Promise.race([
        driver.runTurn({
          text: requestTag,
          requestTag,
          assumeConnected: true,
          assumeSessionReady: true,
        }),
        new Promise((_, reject) => {
          timeout = setTimeout(
            () => reject(new Error(`turn_timeout:${requestTag}`)),
            3000,
          );
        }),
      ]);
    } finally {
      clearTimeout(timeout);
    }
  };

  try {
    await waitForSocket(socketPath);
    await driver.connect({ restoreSessionFile: sessionFile });
    const first = await runWithTimeout("chat-inbox-recovered");
    assert.equal(first.finalText, "final:chat-inbox-recovered");

    let workerExited = false;
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const status = await rpc(socketPath, {
        id: `wait-worker-exit-${attempt}`,
        type: "daemon_status",
      });
      if ((status.data?.workers || []).length === 0) {
        workerExited = true;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(workerExited, true);

    const second = await runWithTimeout("chat-inbox-current");
    assert.equal(second.finalText, "final:chat-inbox-current");
  } finally {
    driver.dispose();
    try {
      daemon.kill("SIGKILL");
    } catch {
      // ignore
    }
    await fs.rm(agentDir, { recursive: true, force: true });
  }
});

test("hard daemon and worker death resumes the accepted ledger turn without prompt replay", async () => {
  const agentDir = await makeTempDir("rin-daemon-hard-crash-");
  const socketPath = path.join(agentDir, "daemon.sock");
  const workerPath = path.join(agentDir, "crash-worker.mjs");
  const logPath = path.join(agentDir, "worker.log");
  const sessionFile = path.join(agentDir, "session.jsonl");
  const requestTag = "hard-crash-turn";
  await fs.writeFile(
    workerPath,
    `
import fs from "node:fs";
import readline from "node:readline";
const logPath = ${JSON.stringify(logPath)};
const sessionFile = ${JSON.stringify(sessionFile)};
const log = (type) => fs.appendFileSync(logPath, process.pid + ":" + type + "\\n");
const send = (payload) => process.stdout.write(JSON.stringify(payload) + "\\n");
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  const command = JSON.parse(line);
  if (command.type === "get_state") {
    send({ type: "response", id: command.id, command: command.type, success: true, data: { sessionFile, sessionId: "crash-session", isStreaming: false, isCompacting: false } });
    return;
  }
  if (command.type === "prompt") {
    log("prompt");
    send({ type: "response", id: command.id, command: command.type, success: true, data: {} });
    send({ type: "rpc_turn_event", event: "start", requestTag: command.requestTag, turnGeneration: 1, sessionFile, sessionId: "crash-session" });
    return;
  }
  if (command.type === "resume_interrupted_turn") {
    log("resume");
    send({ type: "response", id: command.id, command: command.type, success: true, data: { resumed: true } });
    send({ type: "rpc_turn_event", event: "start", requestTag: command.requestTag, turnGeneration: 1, sessionFile, sessionId: "crash-session" });
    setTimeout(() => send({ type: "rpc_turn_event", event: "complete", requestTag: command.requestTag, turnGeneration: 1, sessionFile, sessionId: "crash-session", finalText: "hard crash recovered final" }), 25);
    return;
  }
  send({ type: "response", id: command.id, command: command.type, success: true, data: {} });
});
setInterval(() => {}, 1000);
`,
  );

  let firstDaemon = spawnDaemon(agentDir, socketPath, workerPath);
  let secondDaemon;
  try {
    await waitForSocket(socketPath);
    const prompt = await withRpcConnection(socketPath, async (client) => {
      const selected = await client.request({
        id: "hard-crash-select",
        type: "switch_session",
        sessionFile,
        sessionId: "crash-session",
      });
      assert.equal(selected.success, true);
      return await client.request({
        id: "hard-crash-prompt",
        type: "prompt",
        message: "execute once",
        requestTag,
      });
    });
    assert.equal(prompt.success, true);
    assert.equal(readDaemonTurn(agentDir, requestTag)?.state, "active");

    firstDaemon.kill("SIGKILL");
    await new Promise((resolve) => firstDaemon.once("exit", resolve));
    firstDaemon = undefined;
    for (const line of await readLogLines(logPath)) {
      const pid = Number(line.split(":", 1)[0]);
      if (Number.isFinite(pid)) {
        try {
          process.kill(pid, "SIGKILL");
        } catch {}
      }
    }

    secondDaemon = spawnDaemon(agentDir, socketPath, workerPath);
    await waitForSocket(socketPath, 10_000);
    const deadline = Date.now() + 10_000;
    let terminal;
    while (Date.now() < deadline) {
      terminal = readDaemonTurn(agentDir, requestTag);
      if (terminal?.state === "complete") break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.equal(terminal?.state, "complete");
    assert.equal(
      terminal?.terminalEvent?.finalText,
      "hard crash recovered final",
    );
    const commands = (await readLogLines(logPath)).map((line) =>
      line.slice(line.indexOf(":") + 1),
    );
    assert.equal(commands.filter((type) => type === "prompt").length, 1);
    assert.equal(commands.filter((type) => type === "resume").length, 1);
  } finally {
    firstDaemon?.kill("SIGKILL");
    secondDaemon?.kill("SIGTERM");
    await fs.rm(agentDir, { recursive: true, force: true });
  }
});

test("daemon does not revive sessions recorded as running before restart", async () => {
  const agentDir = await makeTempDir("rin-daemon-no-revival-");
  const socketPath = path.join(agentDir, "daemon.sock");
  const workerPath = path.join(agentDir, "fake-worker.js");
  const logPath = path.join(agentDir, "commands.log");
  const sessionFile = path.join(agentDir, "sessions", "interrupted.jsonl");
  await fs.mkdir(path.dirname(sessionFile), { recursive: true });
  await fs.mkdir(path.join(agentDir, "data", "core", "workers"), {
    recursive: true,
  });
  await fs.writeFile(sessionFile, "");
  await fs.writeFile(
    path.join(agentDir, "data", "core", "workers", "running-workers.json"),
    `${JSON.stringify({
      schemaVersion: 1,
      sessionFiles: [sessionFile],
      requestTags: { [sessionFile]: "chat-inbox-interrupted" },
    })}\n`,
  );
  await fs.writeFile(
    workerPath,
    `const fs = require("node:fs");
fs.appendFileSync(${JSON.stringify(logPath)}, "spawned\\n");
process.stdin.resume();\n`,
  );

  const daemon = spawnDaemon(agentDir, socketPath, workerPath);
  try {
    await waitForSocket(socketPath);
    await new Promise((resolve) => setTimeout(resolve, 300));
    const status = await rpc(socketPath, {
      id: "no-revival-status",
      type: "daemon_status",
    });
    assert.equal(status.success, true);
    assert.deepEqual(status.data?.workers || [], []);
    assert.deepEqual(await readLogLines(logPath), []);
  } finally {
    try {
      daemon.kill("SIGKILL");
    } catch {
      // ignore
    }
    await fs.rm(agentDir, { recursive: true, force: true });
  }
});

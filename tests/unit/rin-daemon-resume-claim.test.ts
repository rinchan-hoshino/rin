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

async function rpc(socketPath, command, timeoutMs = 5000) {
  const socket = net.createConnection(socketPath);
  await new Promise((resolve, reject) => {
    socket.once("connect", resolve);
    socket.once("error", reject);
  });
  return await new Promise((resolve, reject) => {
    let buffer = "";
    const timer = setTimeout(() => {
      try {
        socket.destroy();
      } catch {
        // ignore
      }
      reject(new Error("rpc_timeout"));
    }, timeoutMs);
    socket.on("data", (chunk) => {
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
          try {
            socket.destroy();
          } catch {
            // ignore
          }
          resolve(payload);
          return;
        }
      }
    });
    socket.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    socket.write(`${JSON.stringify(command)}\n`);
  });
}

function spawnDaemon(agentDir, socketPath, workerPath) {
  return spawn(
    process.execPath,
    [path.join(rootDir, "dist", "core", "rin-daemon", "daemon.js"), socketPath],
    {
      cwd: rootDir,
      env: {
        ...process.env,
        RIN_DIR: agentDir,
        RIN_WORKER_PATH: workerPath,
        RIN_DAEMON_SHUTDOWN_GRACE_MS: "200",
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
  const workerPath = path.join(agentDir, "fake-worker.mjs");
  const logPath = path.join(agentDir, "commands.log");
  await fs.writeFile(
    workerPath,
    `
import fs from "node:fs";
import process from "node:process";
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
    assert.deepEqual(snapshot.data, { entries: [], tree: [], leafId: null });
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

test("daemon routes session listing through the warm empty worker", async () => {
  const agentDir = await makeTempDir("rin-daemon-list-sessions-");
  const socketPath = path.join(agentDir, "daemon.sock");
  const workerPath = path.join(agentDir, "fake-worker.mjs");
  const logPath = path.join(agentDir, "commands.log");
  await fs.writeFile(
    workerPath,
    `
import fs from "node:fs";
import process from "node:process";
const logPath = ${JSON.stringify(logPath)};
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
    fs.appendFileSync(logPath, command.type + "\\n");
    if (command.type === "get_state") {
      send({ type: "response", id: command.id, command: command.type, success: true, data: { sessionId: "", isStreaming: false, isCompacting: false } });
      continue;
    }
    if (command.type === "list_sessions") {
      send({ type: "response", id: command.id, command: command.type, success: true, data: { sessions: [{ id: "session-1", path: "/tmp/session-1.jsonl", firstMessage: "hello", modified: "2026-04-18T00:00:00.000Z", messageCount: 1, allMessagesText: "hello" }] } });
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

    const socket = net.createConnection(socketPath);
    await new Promise((resolve, reject) => {
      socket.once("connect", resolve);
      socket.once("error", reject);
    });

    let buffer = "";
    const waitForResponse = (wantedId) =>
      new Promise((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error(`payload_timeout:${wantedId}`)),
          5000,
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
            if (payload?.type === "response" && payload?.id === wantedId) {
              clearTimeout(timer);
              socket.off("data", onData);
              resolve(payload);
              return;
            }
          }
        };
        socket.on("data", onData);
        socket.once("error", (error) => {
          clearTimeout(timer);
          socket.off("data", onData);
          reject(error);
        });
      });

    socket.write(`${JSON.stringify({ id: "1", type: "get_state" })}\n`);
    const state = await waitForResponse("1");
    socket.write(`${JSON.stringify({ id: "2", type: "list_sessions" })}\n`);
    const listed = await waitForResponse("2");

    assert.equal(state.success, true);
    assert.equal(listed.success, true);
    assert.equal(listed.data?.sessions?.[0]?.id, "session-1");
    assert.equal(listed.data?.sessions?.[0]?.cwd, undefined);
    assert.deepEqual((await fs.readFile(logPath, "utf8")).trim().split("\n"), [
      "get_state",
      "list_sessions",
    ]);
    socket.destroy();
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
  const workerPath = path.join(agentDir, "fake-worker.mjs");
  const logPath = path.join(agentDir, "commands.log");
  await fs.writeFile(
    workerPath,
    `
import fs from "node:fs";
import process from "node:process";
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

test("daemon attaches a selected session without a frontend switch_session round-trip", async () => {
  const agentDir = await makeTempDir("rin-daemon-select-");
  const socketPath = path.join(agentDir, "daemon.sock");
  const workerPath = path.join(agentDir, "fake-worker.mjs");
  const logPath = path.join(agentDir, "commands.log");
  const sessionFile = "/tmp/selected-session.jsonl";
  await fs.writeFile(
    workerPath,
    `
import fs from "node:fs";
import process from "node:process";
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
    const socket = net.createConnection(socketPath);
    await new Promise((resolve, reject) => {
      socket.once("connect", resolve);
      socket.once("error", reject);
    });

    let buffer = "";
    const waitForResponse = (wantedId) =>
      new Promise((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error(`payload_timeout:${wantedId}`)),
          5000,
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
            if (payload?.type === "response" && payload?.id === wantedId) {
              clearTimeout(timer);
              socket.off("data", onData);
              resolve(payload);
              return;
            }
          }
        };
        socket.on("data", onData);
        socket.once("error", (error) => {
          clearTimeout(timer);
          socket.off("data", onData);
          reject(error);
        });
      });

    socket.write(
      `${JSON.stringify({ id: "1", type: "select_session", sessionPath: sessionFile })}\n`,
    );
    const selected = await waitForResponse("1");
    socket.write(`${JSON.stringify({ id: "2", type: "get_state" })}\n`);
    const state = await waitForResponse("2");

    assert.equal(selected.success, true);
    assert.equal(state.success, true);
    assert.equal(state.data?.sessionFile, sessionFile);
    assert.deepEqual(
      (await fs.readFile(logPath, "utf8")).trim().split("\n").filter(Boolean),
      ["switch_session", "get_state"],
    );

    socket.destroy();
  } finally {
    try {
      daemon.kill("SIGKILL");
    } catch {
      // ignore
    }
    await fs.rm(agentDir, { recursive: true, force: true });
  }
});

test("daemon auto-resumes active session logs on startup without frontend help", async () => {
  const agentDir = await makeTempDir("rin-daemon-resume-");
  const socketPath = path.join(agentDir, "daemon.sock");
  const workerPath = path.join(agentDir, "fake-worker.mjs");
  const sessionFile = path.join(agentDir, "sessions", "active-session.jsonl");
  await fs.mkdir(path.dirname(sessionFile), { recursive: true });
  await fs.writeFile(
    sessionFile,
    `${JSON.stringify({
      type: "custom",
      customType: "rin-turn-state",
      data: { status: "active", timestamp: "2026-04-24T00:00:00.000Z" },
    })}\n`,
  );
  await fs.writeFile(
    workerPath,
    `
import process from "node:process";
function send(payload) { process.stdout.write(JSON.stringify(payload) + "\\n"); }
let buffer = "";
let switched = false;
async function handle(command) {
  if (command.type === "switch_session") {
    await new Promise((resolve) => setTimeout(resolve, 100));
    switched = true;
    send({ type: "response", id: command.id, command: command.type, success: true, data: { cancelled: false } });
    return;
  }
  if (command.type === "resume_interrupted_turn") {
    if (switched) send({ type: "agent_start" });
    send({ type: "response", id: command.id, command: command.type, success: true, data: {} });
    return;
  }
  send({ type: "response", id: command.id, command: command.type, success: true, data: {} });
}
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  while (true) {
    const idx = buffer.indexOf("\\n");
    if (idx < 0) break;
    const line = buffer.slice(0, idx);
    buffer = buffer.slice(idx + 1);
    if (!line.trim()) continue;
    handle(JSON.parse(line));
  }
});
`,
  );

  const daemon = spawnDaemon(agentDir, socketPath, workerPath);
  try {
    await waitForSocket(socketPath);
    let status;
    for (let i = 0; i < 20; i += 1) {
      status = await rpc(socketPath, { id: `3-${i}`, type: "daemon_status" });
      const workers = status.data?.workers || [];
      if (workers.length === 1 && workers[0].isStreaming === true) break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    const workers = status.data?.workers || [];

    assert.equal(status.success, true);
    assert.equal(workers.length, 1);
    assert.equal(workers[0].sessionFile, sessionFile);
    assert.equal(workers[0].attachedConnections, 0);
    assert.equal(workers[0].isStreaming, true);
  } finally {
    try {
      daemon.kill("SIGKILL");
    } catch {
      // ignore
    }
    await fs.rm(agentDir, { recursive: true, force: true });
  }
});

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const rootDir = path.resolve(
  path.dirname(new URL(import.meta.url).pathname),
  "..",
  "..",
);
const taskIndex = await import(
  pathToFileURL(path.join(rootDir, "dist", "core", "task", "index.js")).href
);

function getTaskTools() {
  return taskIndex.default().tools || [];
}

function getTaskTool(name) {
  const tool = getTaskTools().find((entry) => entry.name === name);
  assert.ok(tool);
  return tool;
}

function restoreEnvValue(name, value) {
  if (value === undefined) {
    delete process.env[name];
    return;
  }
  process.env[name] = value;
}

async function listen(server, socketPath) {
  await new Promise((resolve, reject) => {
    const onError = (error) => reject(error);
    server.once("error", onError);
    server.listen(socketPath, () => {
      server.off("error", onError);
      resolve();
    });
  });
}

async function closeServer(server) {
  if (!server.listening) return;
  await new Promise((resolve) => server.close(() => resolve()));
}

async function withTaskDaemon(dataForPayload, run) {
  const runtimeDir = await fs.mkdtemp(
    path.join(os.tmpdir(), "rin-task-runtime-"),
  );
  const socketDir = path.join(runtimeDir, "rin-daemon");
  const socketPath = path.join(socketDir, "daemon.sock");
  await fs.mkdir(socketDir, { recursive: true });

  const requests = [];
  const server = net.createServer((socket) => {
    let buffer = "";
    socket.on("data", (chunk) => {
      buffer += String(chunk);
      while (true) {
        const idx = buffer.indexOf("\n");
        if (idx < 0) break;
        const line = buffer.slice(0, idx).trim();
        buffer = buffer.slice(idx + 1);
        if (!line) continue;
        const payload = JSON.parse(line);
        requests.push(payload);
        socket.write(
          `${JSON.stringify({
            type: "response",
            id: payload.id,
            command: payload.type,
            success: true,
            data: dataForPayload(payload, requests),
          })}\n`,
        );
      }
    });
  });

  const previousSocketPath = process.env.RIN_DAEMON_SOCKET_PATH;

  try {
    await listen(server, socketPath);
    restoreEnvValue("RIN_DAEMON_SOCKET_PATH", socketPath);
    await run({ requests, runtimeDir, socketPath });
  } finally {
    restoreEnvValue("RIN_DAEMON_SOCKET_PATH", previousSocketPath);
    await closeServer(server);
    await fs.rm(runtimeDir, { recursive: true, force: true });
  }
}

test("task capability exposes only task_control", () => {
  assert.deepEqual(
    getTaskTools().map((tool) => tool.name),
    ["task_control"],
  );
  const tool = getTaskTool("task_control");
  assert.equal(tool.parameters.properties.taskId.type, "string");
  assert.deepEqual(
    tool.parameters.properties.action.anyOf.map((item) => item.const),
    ["pause", "resume"],
  );
});

test("task_control maps pause and resume to daemon task commands", async () => {
  await withTaskDaemon(
    (payload) => ({
      task: {
        id: payload.taskId,
        name: "Demo Task",
        enabled: payload.type === "cron_resume_task",
      },
    }),
    async ({ requests }) => {
      const tool = getTaskTool("task_control");
      const paused = await tool.execute(
        "tool-pause",
        { action: "pause", taskId: "cron_demo" },
        undefined,
        undefined,
        {},
      );
      const resumed = await tool.execute(
        "tool-resume",
        { action: "resume", taskId: "cron_demo" },
        undefined,
        undefined,
        {},
      );

      assert.deepEqual(
        requests.map((request) => request.type),
        ["cron_pause_task", "cron_resume_task"],
      );
      assert.match(
        String(paused.content?.[0]?.text || ""),
        /Paused task: cron_demo \(Demo Task\)/,
      );
      assert.match(
        String(resumed.content?.[0]?.text || ""),
        /Resumed task: cron_demo \(Demo Task\)/,
      );
    },
  );
});
